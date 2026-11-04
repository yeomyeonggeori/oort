//! The wire of both providers, driven through the real guarded client against a fake provider on
//! 127.0.0.1. Every refusal mock echoes the key it received, in the body and in a header, so
//! 「the key never leaves」 is tested against a provider that tries to leak it.

use super::*;
use std::sync::Mutex;

use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;

const KEY: &str = "sk-image-model-test-key-0001";
const PHOTO: &[u8] = b"\x89PNG-photo-bytes-that-must-travel-in-the-body";

struct Captured {
    path: String,
    query: Option<String>,
    headers: HeaderMap,
    body: Vec<u8>,
}

type Script = Arc<dyn Fn(&Captured) -> Response + Send + Sync>;
type FakeState = (Arc<Mutex<Vec<Captured>>>, Script, Duration);

struct Fake {
    seen: Arc<Mutex<Vec<Captured>>>,
    authority: String,
    _task: tokio::task::JoinHandle<()>,
}

impl Fake {
    async fn start(script: impl Fn(&Captured) -> Response + Send + Sync + 'static) -> Fake {
        Fake::start_after(Duration::ZERO, script).await
    }

    /// A provider that thinks for `delay` before it answers. The wait is the runtime's own timer, not
    /// a blocked thread: a thread that sleeps can hold up the very clock the client's deadline runs on.
    async fn start_after(
        delay: Duration,
        script: impl Fn(&Captured) -> Response + Send + Sync + 'static,
    ) -> Fake {
        let seen: Arc<Mutex<Vec<Captured>>> = Arc::default();
        let script: Script = Arc::new(script);
        let state = (seen.clone(), script, delay);
        let app = Router::new()
            .fallback(
                |axum::extract::State((seen, script, delay)): axum::extract::State<FakeState>,
                 request: axum::extract::Request| async move {
                    let (parts, body) = request.into_parts();
                    let body = axum::body::to_bytes(body, 64 * 1024 * 1024)
                        .await
                        .unwrap_or_default()
                        .to_vec();
                    let captured = Captured {
                        path: parts.uri.path().to_string(),
                        query: parts.uri.query().map(str::to_string),
                        headers: parts.headers,
                        body,
                    };
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    let response = script(&captured);
                    seen.lock().unwrap().push(captured);
                    response
                },
            )
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Fake {
            seen,
            authority,
            _task: task,
        }
    }
    fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
    fn only(&self) -> Captured {
        let mut seen = self.seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "exactly one request reaches the provider");
        seen.pop().unwrap()
    }
    fn target(&self, provider: ImageProvider, model: &str) -> ImageModelTarget {
        ImageModelTarget {
            provider,
            base_url: match provider {
                ImageProvider::OpenAi => format!("http://{}/v1", self.authority),
                ImageProvider::Gemini => format!("http://{}/v1beta", self.authority),
            },
            api_key: KEY.to_string(),
            model: model.to_string(),
        }
    }
}

fn policy() -> EgressPolicy {
    EgressPolicy {
        allow_local: true,
        local_hosts: Vec::new(),
        operator_hosts: Vec::new(),
    }
}

fn client() -> GuardedImageModel {
    GuardedImageModel::new(policy(), Duration::from_secs(5))
}

fn request<'a>(target: &'a ImageModelTarget, branch: Branch) -> GenerateRequest<'a> {
    GenerateRequest {
        target,
        photo: Photo {
            bytes: PHOTO,
            mime: "image/png",
        },
        branch,
        safety_id: Some("oort-0123456789abcdef"),
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn json_response(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}

fn openai_ok(picture: &[u8]) -> Response {
    json_response(
        200,
        json!({"created": 1, "data": [{"b64_json": b64(picture)}]}),
    )
}

fn gemini_ok(picture: &[u8]) -> Response {
    json_response(
        200,
        json!({
            "id": "i1", "object": "interaction", "status": "completed",
            "steps": [
                {"type": "thought", "content": [{"type": "text", "text": "thinking"}]},
                {"type": "model_output", "content": [
                    {"type": "text", "text": "here it is"},
                    {"type": "image", "mime_type": "image/png", "data": b64(picture)},
                ]},
            ],
        }),
    )
}

fn echo(status: u16, extra: &str) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [("x-echo-key", KEY.to_string())],
        format!(r#"{{"error":{{"message":"bad key {KEY} {extra}"}}}}"#),
    )
        .into_response()
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    super::contains(haystack, needle)
}

fn text(captured: &Captured) -> String {
    String::from_utf8_lossy(&captured.body).into_owned()
}

const PICTURE: &[u8] = b"generated-picture-bytes";

// ---- OpenAI ------------------------------------------------------------------------------------

#[tokio::test]
async fn an_openai_cutout_asks_for_transparency_and_sends_the_photo_as_bytes_in_the_body() {
    let fake = Fake::start(|_| openai_ok(PICTURE)).await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
    let generated = client()
        .generate(request(&target, Branch::Cutout))
        .await
        .expect("a picture");
    assert_eq!(generated.bytes, PICTURE);
    assert!(generated.asked_transparent);

    let seen = fake.only();
    assert_eq!(seen.path, "/v1/images/edits");
    assert_eq!(
        seen.query, None,
        "no query string: nothing rides on the address"
    );
    assert_eq!(
        seen.headers.get(header::AUTHORIZATION).unwrap(),
        &format!("Bearer {KEY}")
    );
    let content_type = seen
        .headers
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(
        content_type.starts_with("multipart/form-data; boundary="),
        "{content_type}"
    );
    let form = text(&seen);
    for expected in [
        "name=\"model\"\r\n\r\ngpt-image-2.5-sunburst",
        "name=\"background\"\r\n\r\ntransparent",
        "name=\"output_format\"\r\n\r\npng",
        "name=\"n\"\r\n\r\n1",
        "name=\"size\"\r\n\r\n1024x1024",
        "name=\"quality\"\r\n\r\nmedium",
        "name=\"safety_identifier\"\r\n\r\noort-0123456789abcdef",
        "name=\"image[]\"; filename=\"photo.png\"\r\nContent-Type: image/png",
        "fully transparent",
    ] {
        assert!(form.contains(expected), "form is missing {expected:?}");
    }
    assert!(
        contains_bytes(&seen.body, PHOTO),
        "the photo's own bytes are in the body, no address stands in for them"
    );
    assert!(
        !form.contains("http://") && !form.contains("https://"),
        "no address of any kind"
    );
    assert!(
        !contains_bytes(&seen.body, KEY.as_bytes()),
        "the key is only in the header"
    );
}

#[tokio::test]
async fn an_openai_caricature_asks_for_an_opaque_picture_and_its_own_instructions() {
    let fake = Fake::start(|_| openai_ok(PICTURE)).await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-flare");
    let generated = client()
        .generate(request(&target, Branch::Caricature))
        .await
        .unwrap();
    assert!(!generated.asked_transparent);
    let form = text(&fake.only());
    assert!(form.contains("name=\"background\"\r\n\r\nopaque"));
    assert!(form.contains("caricature"));
    assert!(!form.contains("fully transparent"));
}

#[tokio::test]
async fn a_model_the_documentation_does_not_name_is_never_asked_for_transparency() {
    // `gpt-image-2` is 「in preview」 for transparency (OpenAI reference, 2026-10-31): not claimed.
    let fake = Fake::start(|_| openai_ok(PICTURE)).await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2");
    assert!(!target.transparent_output());
    let generated = client()
        .generate(request(&target, Branch::Cutout))
        .await
        .unwrap();
    assert!(!generated.asked_transparent);
    let form = text(&fake.only());
    assert!(
        !form.contains("name=\"background\""),
        "no background field at all"
    );
    assert!(
        form.contains("flat bright green"),
        "asks for the solid background instead"
    );
    assert!(!form.contains("fully transparent"));
}

#[tokio::test]
async fn an_unsafe_safety_identifier_is_dropped_not_sent() {
    let fake = Fake::start(|_| openai_ok(PICTURE)).await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
    let mut asked = request(&target, Branch::Cutout);
    asked.safety_id = Some("Jane Doe <jane@example.com>");
    client().generate(asked).await.unwrap();
    assert!(!text(&fake.only()).contains("safety_identifier"));
}

// ---- Gemini ------------------------------------------------------------------------------------

#[tokio::test]
async fn gemini_gets_a_text_block_and_an_image_block_with_the_key_in_one_header_only() {
    let fake = Fake::start(|_| gemini_ok(PICTURE)).await;
    let target = fake.target(ImageProvider::Gemini, "gemini-nano-banana-2.1");
    assert!(
        !target.transparent_output(),
        "Gemini transparency is not documented"
    );
    let generated = client()
        .generate(request(&target, Branch::Cutout))
        .await
        .expect("a picture");
    assert_eq!(generated.bytes, PICTURE);
    assert!(
        !generated.asked_transparent,
        "so a Gemini cut-out takes the solid-background path"
    );

    let seen = fake.only();
    assert_eq!(seen.path, "/v1beta/interactions");
    assert_eq!(seen.query, None, "the key is not in the address");
    assert_eq!(seen.headers.get("x-goog-api-key").unwrap(), KEY);
    assert!(seen.headers.get(header::AUTHORIZATION).is_none());
    assert!(
        !contains_bytes(&seen.body, KEY.as_bytes()),
        "nor in the body"
    );
    let body: Value = serde_json::from_slice(&seen.body).unwrap();
    assert_eq!(body["model"], "gemini-nano-banana-2.1");
    assert_eq!(body["input"][0]["type"], "text");
    assert!(body["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains("flat bright green"));
    assert_eq!(body["input"][1]["type"], "image");
    assert_eq!(body["input"][1]["mime_type"], "image/png");
    assert_eq!(
        body["input"][1]["data"],
        b64(PHOTO),
        "the photo's bytes, base64, in the body"
    );
    assert_eq!(body["response_format"]["type"], "image");
    assert_eq!(body["store"], false, "the interaction is not kept");
}

#[tokio::test]
async fn a_gemini_interaction_that_did_not_complete_or_has_no_picture_is_no_picture() {
    for (answer, want) in [
        (
            json!({"status": "failed", "errors": [{"code": "IMAGE_SAFETY", "message": "x"}], "steps": []}),
            ImageModelError::Refused,
        ),
        (
            json!({"status": "failed", "errors": [{"code": "INTERNAL", "message": "x"}]}),
            ImageModelError::Failed,
        ),
        (
            json!({"status": "completed", "steps": [{"type": "model_output", "content": [{"type": "text", "text": "no picture"}]}]}),
            ImageModelError::Failed,
        ),
        (json!({"status": "completed"}), ImageModelError::Failed),
    ] {
        let fake = Fake::start(move |_| json_response(200, answer.clone())).await;
        let target = fake.target(ImageProvider::Gemini, "gemini-nano-banana-2.1");
        assert_eq!(
            client()
                .generate(request(&target, Branch::Caricature))
                .await
                .unwrap_err(),
            want
        );
    }
}

// ---- failures ----------------------------------------------------------------------------------

#[tokio::test]
async fn every_provider_failure_is_one_closed_kind_and_never_carries_the_key() {
    let table: [(u16, &str, ImageModelError); 11] = [
        (401, "", ImageModelError::Denied),
        (402, "", ImageModelError::Denied),
        (
            403,
            "organization must be verified",
            ImageModelError::Denied,
        ),
        (404, "model_not_found", ImageModelError::Denied),
        (429, "insufficient_quota", ImageModelError::Denied),
        (429, "slow down", ImageModelError::Failed),
        (500, "", ImageModelError::Failed),
        (503, "", ImageModelError::Failed),
        (400, "bad prompt", ImageModelError::Failed),
        (400, "moderation_blocked", ImageModelError::Refused),
        (400, "content_policy_violation", ImageModelError::Refused),
    ];
    for (status, extra, want) in table {
        let fake = Fake::start(move |_| echo(status, extra)).await;
        let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
        let error = client()
            .generate(request(&target, Branch::Cutout))
            .await
            .unwrap_err();
        assert_eq!(error, want, "status {status} {extra:?}");
        let shown = format!("{error} {error:?}");
        assert!(
            !shown.contains(KEY) && !shown.contains("bad key"),
            "{shown}"
        );
    }
}

#[test]
fn a_target_prints_without_its_key() {
    let target = ImageModelTarget {
        provider: ImageProvider::OpenAi,
        base_url: "https://user:pw@api.openai.com/v1?token=abc".into(),
        api_key: KEY.into(),
        model: "gpt-image-2.5-sunburst".into(),
    };
    let shown = format!("{target:?}");
    assert!(shown.contains("<redacted>"), "{shown}");
    assert!(
        !shown.contains(KEY) && !shown.contains("pw@") && !shown.contains("token=abc"),
        "{shown}"
    );
    let request = GenerateRequest {
        target: &target,
        photo: Photo {
            bytes: PHOTO,
            mime: "image/png",
        },
        branch: Branch::Cutout,
        safety_id: None,
    };
    assert!(!format!("{request:?}").contains(KEY));
}

#[tokio::test]
async fn an_answer_over_the_bound_is_too_large_and_a_picture_over_five_mib_is_too() {
    // The whole answer: refused from `Content-Length`, before the body is read.
    let huge = vec![b'a'; RESPONSE_MAX_BYTES + 1];
    let fake = Fake::start(move |_| (StatusCode::OK, huge.clone()).into_response()).await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
    assert_eq!(
        client()
            .generate(request(&target, Branch::Cutout))
            .await
            .unwrap_err(),
        ImageModelError::TooLarge
    );

    // Streamed with no length: cut off when the running total passes the bound.
    let fake = Fake::start(|_| {
        let chunks = (0..14).map(|_| Ok::<_, std::io::Error>(bytes_of(1024 * 1024)));
        Response::new(Body::from_stream(futures::stream::iter(chunks)))
    })
    .await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
    assert_eq!(
        client()
            .generate(request(&target, Branch::Cutout))
            .await
            .unwrap_err(),
        ImageModelError::TooLarge
    );

    // The picture inside a small answer: exactly 5 MiB is accepted, one byte more is not.
    for (len, ok) in [(PICTURE_MAX_BYTES, true), (PICTURE_MAX_BYTES + 1, false)] {
        let picture = vec![7u8; len];
        let fake = Fake::start(move |_| openai_ok(&picture)).await;
        let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
        let result = client().generate(request(&target, Branch::Cutout)).await;
        match (ok, result) {
            (true, Ok(generated)) => assert_eq!(generated.bytes.len(), PICTURE_MAX_BYTES),
            (false, Err(error)) => assert_eq!(error, ImageModelError::TooLarge),
            (ok, other) => panic!("{len} bytes, accepted={ok}: {other:?}"),
        }
    }
}

fn bytes_of(len: usize) -> axum::body::Bytes {
    axum::body::Bytes::from(vec![b'a'; len])
}

#[tokio::test]
async fn a_slow_provider_is_a_timeout_at_the_deadline() {
    let fake = Fake::start_after(Duration::from_millis(1500), |_| openai_ok(PICTURE)).await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
    let quick = GuardedImageModel::new(policy(), Duration::from_millis(300));
    let started = std::time::Instant::now();
    assert_eq!(
        quick
            .generate(request(&target, Branch::Cutout))
            .await
            .unwrap_err(),
        ImageModelError::TimedOut
    );
    assert!(
        started.elapsed() < Duration::from_millis(1400),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_redirect_is_never_followed_and_a_refused_address_is_never_dialled() {
    let elsewhere = Fake::start(|_| openai_ok(PICTURE)).await;
    let location = format!("http://{}/v1/images/edits", elsewhere.authority);
    let fake = Fake::start(move |_| {
        (StatusCode::FOUND, [(header::LOCATION, location.clone())]).into_response()
    })
    .await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
    assert_eq!(
        client()
            .generate(request(&target, Branch::Cutout))
            .await
            .unwrap_err(),
        ImageModelError::Failed
    );
    assert_eq!(
        elsewhere.count(),
        0,
        "the key and the photo were not sent on to the Location"
    );

    // The default policy refuses loopback: nothing is sent at all.
    let fake = Fake::start(|_| openai_ok(PICTURE)).await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
    let strict = GuardedImageModel::new(EgressPolicy::default(), Duration::from_secs(5));
    assert_eq!(
        strict
            .generate(request(&target, Branch::Cutout))
            .await
            .unwrap_err(),
        ImageModelError::Egress
    );
    assert_eq!(fake.count(), 0);
}

#[tokio::test]
async fn what_cannot_be_sent_is_refused_before_anything_is_sent() {
    let fake = Fake::start(|_| openai_ok(PICTURE)).await;
    let target = fake.target(ImageProvider::OpenAi, "gpt-image-2.5-sunburst");
    let big = vec![0u8; PHOTO_MAX_BYTES + 1];
    for photo in [
        Photo {
            bytes: &[],
            mime: "image/png",
        },
        Photo {
            bytes: &big,
            mime: "image/png",
        },
        Photo {
            bytes: PHOTO,
            mime: "image/gif",
        },
    ] {
        let asked = GenerateRequest {
            target: &target,
            photo,
            branch: Branch::Cutout,
            safety_id: None,
        };
        assert_eq!(
            client().generate(asked).await.unwrap_err(),
            ImageModelError::Failed
        );
    }
    let mut keyless = target.clone();
    keyless.api_key = "  ".into();
    assert_eq!(
        client()
            .generate(request(&keyless, Branch::Cutout))
            .await
            .unwrap_err(),
        ImageModelError::Failed
    );
    assert_eq!(fake.count(), 0);
}

#[test]
fn a_photo_can_never_add_a_form_field_of_its_own() {
    let target = ImageModelTarget {
        provider: ImageProvider::OpenAi,
        base_url: OPENAI_BASE.into(),
        api_key: KEY.into(),
        model: "gpt-image-2.5-sunburst".into(),
    };
    // A photo that spells out the next fifty boundaries, each followed by a hostile field.
    let start = BOUNDARY_COUNTER.load(Ordering::Relaxed);
    let mut hostile = Vec::new();
    for counter in start..start + 50 {
        hostile.extend_from_slice(
            format!("--oort-image-model-{counter:016x}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nexpensive\r\n").as_bytes(),
        );
    }
    let asked = GenerateRequest {
        target: &target,
        photo: Photo {
            bytes: &hostile,
            mime: "image/png",
        },
        branch: Branch::Cutout,
        safety_id: None,
    };
    let (content_type, body) = openai_form(&asked, "p", false);
    let boundary = content_type.split("boundary=").nth(1).unwrap();
    assert!(
        !contains_bytes(&hostile, boundary.as_bytes()),
        "the boundary is chosen to be absent from the photo"
    );
    let delimiter = format!("--{boundary}");
    let parts = String::from_utf8_lossy(&body).matches(&delimiter).count();
    // model, prompt, n, size, quality, output_format, background + the file, then the closing
    // delimiter: only our own fields exist.
    assert_eq!(parts, 7 + 1 + 1, "only our own fields exist");
}

// ---- which team keys are image providers --------------------------------------------------------

#[test]
fn only_the_two_documented_hosts_are_image_providers_and_the_typed_path_is_ignored() {
    let config = ImageModelConfig::default();
    assert_eq!(
        config.provider_for("https://api.openai.com/v1"),
        Some((ImageProvider::OpenAi, OPENAI_BASE.to_string()))
    );
    assert_eq!(
        config.provider_for(" https://API.OpenAI.com/v1/ "),
        Some((ImageProvider::OpenAi, OPENAI_BASE.to_string()))
    );
    assert_eq!(
        config.provider_for("https://generativelanguage.googleapis.com/v1beta/openai"),
        Some((ImageProvider::Gemini, GEMINI_BASE.to_string())),
        "the OpenAI-compatible chat path is not the image path: the fixed one is used"
    );
    for refused in [
        "http://api.openai.com/v1",
        "https://api.openai.com:8443/v1",
        "https://user:pw@api.openai.com/v1",
        "https://api.openai.com/v1?x=1",
        "https://api.openai.com.evil.example/v1",
        "https://evil.example/api.openai.com",
        "https://openrouter.ai/api/v1",
        "https://api.x.ai/v1",
        "https://api.anthropic.com/v1",
        "http://127.0.0.1:8088/v1",
        "not a url",
        "",
    ] {
        assert_eq!(config.provider_for(refused), None, "{refused}");
    }
    let tested = ImageModelConfig::default().with_test_host(
        "127.0.0.1:4242",
        ImageProvider::Gemini,
        "http://127.0.0.1:4242/v1beta/",
    );
    assert_eq!(
        tested.provider_for("http://127.0.0.1:4242/anything"),
        Some((
            ImageProvider::Gemini,
            "http://127.0.0.1:4242/v1beta".to_string()
        ))
    );
    assert_eq!(
        config.provider_for("http://127.0.0.1:4242/anything"),
        None,
        "a test alias is not in production"
    );
}

#[test]
fn the_model_ids_come_from_the_documentation_and_an_override_must_look_like_one() {
    let config = ImageModelConfig::default();
    assert_eq!(
        config.model_for(ImageProvider::OpenAi),
        "gpt-image-2.5-sunburst"
    );
    assert_eq!(
        config.model_for(ImageProvider::Gemini),
        "gemini-nano-banana-2.1"
    );
    for id in OPENAI_TRANSPARENT_MODELS {
        let target = ImageModelTarget {
            provider: ImageProvider::OpenAi,
            base_url: OPENAI_BASE.into(),
            api_key: KEY.into(),
            model: id.into(),
        };
        assert!(target.transparent_output(), "{id}");
    }
    for (provider, id) in [
        (ImageProvider::OpenAi, "gpt-image-2"),
        (ImageProvider::OpenAi, "gpt-image-1.5"),
        (ImageProvider::OpenAi, "chatgpt-image-latest"),
        (ImageProvider::Gemini, "gemini-nano-banana-2.1"),
        (ImageProvider::Gemini, "gemini-3-pro-image"),
    ] {
        let target = ImageModelTarget {
            provider,
            base_url: OPENAI_BASE.into(),
            api_key: KEY.into(),
            model: id.into(),
        };
        assert!(
            !target.transparent_output(),
            "{id} is not documented as transparent"
        );
    }
}
