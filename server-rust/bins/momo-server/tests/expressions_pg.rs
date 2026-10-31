//! Real HTTP/OpenAPI + existing message/reaction rail, ADR-0218 model (a).
use momo_db::sqlx::{
    self,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use momo_db::PgPool;
use momo_expressions::{self as e, Actor};
use momo_server::{build_app, config::RealtimeSettings, AppState};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

const SECRET: &str = "expression-conformance-only";

/// The deployment sampler imports a link that cannot resolve (`.invalid`, #4829). Answer
/// it the way a failed DNS lookup would, without this test touching any network.
struct NoNetwork;
#[async_trait::async_trait]
impl momo_unfurl::UnfurlHttp for NoNetwork {
    async fn fetch(
        &self,
        _url: &str,
        _kind: momo_unfurl::FetchKind,
    ) -> Result<momo_unfurl::Fetched, momo_unfurl::FetchError> {
        Err(momo_unfurl::FetchError::Failed("dns".into()))
    }
}
struct Person {
    actor: Actor,
    token: String,
}
async fn seed(su: &PgPool, ws: Uuid, role: &str, http: &reqwest::Client, base: &str) -> Person {
    let id = Uuid::new_v4();
    let email = format!("{id}@expressions.test");
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,display_name,handle) VALUES($1,$2,'human',$3,$3)",
    )
    .bind(id)
    .bind(ws)
    .bind(id.to_string())
    .execute(su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,$3::membership_role)").bind(ws).bind(id).bind(role).execute(su).await.unwrap();
    sqlx::query("INSERT INTO human(member_id,workspace_id,email,password_hash) VALUES($1,$2,$3,momo_password_hash('expression-test-pass'))").bind(id).bind(ws).bind(&email).execute(su).await.unwrap();
    let r = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({"email":email,"password":"expression-test-pass","workspace":ws}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let body: Value = r.json().await.unwrap();
    Person {
        actor: Actor {
            workspace: ws,
            member: id,
        },
        token: body["accessToken"].as_str().unwrap().into(),
    }
}
async fn workspace(su: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(id)
        .bind(id.to_string())
        .execute(su)
        .await
        .unwrap();
    id
}
fn png() -> Vec<u8> {
    let mut c = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(4, 4)
        .write_to(&mut c, image::ImageFormat::Png)
        .unwrap();
    c.into_inner()
}
fn multipart(meta: Option<Value>, file: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    if let Some(meta) = meta {
        b.extend_from_slice(format!("--oort-expression-test\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{meta}\r\n").as_bytes());
    }
    b.extend_from_slice(b"--oort-expression-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\nContent-Type: application/octet-stream\r\n\r\n");
    b.extend_from_slice(file);
    b.extend_from_slice(b"\r\n--oort-expression-test--\r\n");
    b
}
async fn response(r: reqwest::Response, status: u16) -> Value {
    assert_eq!(r.status(), status);
    r.json().await.unwrap()
}
fn choice(d: &Value) -> Value {
    json!({"draftId":d["draftId"],"revision":d["revision"],"sha256":d["media"]["large"]["sha256"]})
}
fn sample(
    samples: &mut Vec<Value>,
    method: &str,
    path: &str,
    status: u16,
    schema: &str,
    body: Value,
) {
    samples.push(json!({"method":method,"path":path,"status":status,"schema":schema,"body":body}));
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn expression_http_openapi_and_unchanged_send_reaction_spine() {
    let url = std::env::var("DATABASE_URL").expect("dedicated DATABASE_URL");
    momo_db::migrate::run_migrations(
        &url,
        &momo_db::migrate::default_migrations_dir(),
        momo_db::migrate::SeedMode::None,
    )
    .unwrap();
    let psql = if std::path::Path::new("/opt/homebrew/opt/libpq/bin/psql").is_file() {
        "/opt/homebrew/opt/libpq/bin/psql"
    } else {
        "psql"
    };
    assert!(std::process::Command::new(psql)
        .arg(&url)
        .args(["--quiet", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-f"])
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .output()
        .unwrap()
        .status
        .success());
    let su = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    let options: PgConnectOptions = url.parse().unwrap();
    let api = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password("momo_app_dev_pw"))
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let archive = Arc::new(momo_drive::StubDriveArchive::new(&base));
    let state = AppState::new(
        api.clone(),
        SECRET.into(),
        "ws://localhost:8000/connection/websocket".to_string(),
    )
    .with_drive(archive)
    .with_unfurl_http(Arc::new(NoNetwork))
    .with_realtime(RealtimeSettings {
        cent_token_hmac: Some(SECRET.into()),
        cent_proxy_secret: Some(SECRET.into()),
        connection_token_ttl_seconds: 300,
    });
    let task = tokio::spawn(async move {
        axum::serve(listener, build_app(state)).await.unwrap();
    });
    let http = reqwest::Client::new();
    let ws = workspace(&su).await;
    let foreign_ws = workspace(&su).await;
    let owner = seed(&su, ws, "owner", &http, &base).await;
    let member = seed(&su, ws, "member", &http, &base).await;
    let foreign = seed(&su, foreign_ws, "owner", &http, &base).await;
    let prefix = format!("{base}/v1/workspaces/{ws}");
    let mut samples = Vec::new();
    let metadata = json!({"name":"http_party","displayName":"축하 그림","tags":["축하"],"subjectMemberId":null});
    let uploaded = response(
        http.post(format!("{prefix}/expressions/uploads"))
            .bearer_auth(&owner.token)
            .header(
                "content-type",
                "multipart/form-data; boundary=oort-expression-test",
            )
            .body(multipart(Some(metadata.clone()), &png()))
            .send()
            .await
            .unwrap(),
        201,
    )
    .await;
    sample(
        &mut samples,
        "post",
        "/v1/workspaces/{ws}/expressions/uploads",
        201,
        "Draft",
        uploaded.clone(),
    );
    let draft = uploaded["draftId"].as_str().unwrap();
    let d = response(
        http.get(format!("{prefix}/expression-drafts/{draft}"))
            .bearer_auth(&owner.token)
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    sample(
        &mut samples,
        "get",
        "/v1/workspaces/{ws}/expression-drafts/{draftId}",
        200,
        "Draft",
        d.clone(),
    );
    assert_eq!(
        http.get(format!("{prefix}/expression-drafts/{draft}"))
            .bearer_auth(&member.token)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let media_url = format!(
        "{prefix}/expression-drafts/{draft}/image?size=large&v={}",
        d["media"]["large"]["sha256"].as_str().unwrap()
    );
    let image = http
        .get(&media_url)
        .bearer_auth(&owner.token)
        .send()
        .await
        .unwrap();
    assert_eq!(image.status(), 200);
    assert_eq!(image.headers()["cache-control"], "private, no-store");
    assert_eq!(image.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        image.headers()["content-security-policy"],
        "default-src 'none'; sandbox"
    );
    assert!(!image.bytes().await.unwrap().is_empty());
    let replaced = response(
        http.put(format!("{prefix}/expression-drafts/{draft}/file"))
            .bearer_auth(&owner.token)
            .header(
                "content-type",
                "multipart/form-data; boundary=oort-expression-test",
            )
            .body(multipart(None, &png()))
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    sample(
        &mut samples,
        "put",
        "/v1/workspaces/{ws}/expression-drafts/{draftId}/file",
        200,
        "Draft",
        replaced.clone(),
    );
    assert_eq!(
        response(
            http.post(format!("{prefix}/expressions"))
                .bearer_auth(&owner.token)
                .json(&choice(&uploaded))
                .send()
                .await
                .unwrap(),
            409
        )
        .await["error"]["code"],
        "expression_preview_stale"
    );
    let created = response(
        http.post(format!("{prefix}/expressions"))
            .bearer_auth(&owner.token)
            .json(&choice(&replaced))
            .send()
            .await
            .unwrap(),
        201,
    )
    .await;
    sample(
        &mut samples,
        "post",
        "/v1/workspaces/{ws}/expressions",
        201,
        "Mutation",
        created.clone(),
    );
    let id = created["expression"]["id"].as_str().unwrap();
    let sha = created["expression"]["media"]["large"]["sha256"]
        .as_str()
        .unwrap();
    let active_url = format!("{prefix}/expressions/{id}/image?size=large&v={sha}");
    assert_eq!(http.get(&active_url).send().await.unwrap().status(), 401);
    let good = http
        .get(&active_url)
        .bearer_auth(&owner.token)
        .send()
        .await
        .unwrap();
    assert_eq!(good.status(), 200);
    assert_eq!(good.headers()["content-type"], "image/png");
    assert_eq!(
        http.get(&active_url)
            .bearer_auth(&foreign.token)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        http.get(format!(
            "{prefix}/expressions/{id}/image?size=large&v={}",
            "0".repeat(64)
        ))
        .bearer_auth(&owner.token)
        .send()
        .await
        .unwrap()
        .status(),
        404
    );
    let full = response(
        http.get(format!("{prefix}/expressions"))
            .bearer_auth(&owner.token)
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    sample(
        &mut samples,
        "get",
        "/v1/workspaces/{ws}/expressions",
        200,
        "List",
        full,
    );
    let patch = response(
        http.patch(format!("{prefix}/expressions/{id}"))
            .bearer_auth(&owner.token)
            .json(&json!({"displayName":"다시 축하","tags":[]}))
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    sample(
        &mut samples,
        "patch",
        "/v1/workspaces/{ws}/expressions/{id}",
        200,
        "Mutation",
        patch,
    );
    assert_eq!(
        http.patch(format!("{prefix}/expressions/{id}"))
            .bearer_auth(&owner.token)
            .json(&json!({"name":"new_identity"}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(http.post(format!("{prefix}/expressions")).bearer_auth(&owner.token).json(&json!({"draftId":draft,"revision":"2","sha256":sha,"expression":{"status":"active"}})).send().await.unwrap().status(),400);
    let mut video_metadata = metadata.clone();
    video_metadata["name"] = json!("video_fallback");
    let manual = response(
        http.post(format!("{prefix}/expressions/uploads"))
            .bearer_auth(&owner.token)
            .header(
                "content-type",
                "multipart/form-data; boundary=oort-expression-test",
            )
            .body(multipart(
                Some(video_metadata),
                &[0, 0, 0, 12, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'],
            ))
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    sample(
        &mut samples,
        "post",
        "/v1/workspaces/{ws}/expressions/uploads",
        200,
        "Draft",
        manual.clone(),
    );
    assert_eq!(manual["code"], "video_processing_unavailable");
    // Create a real channel/message, then consume the token through the existing
    // seq+message+outbox transaction. No expression-specific props are authored.
    let ch = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel(id,workspace_id,kind,name) VALUES($1,$2,'public','expression test')",
    )
    .bind(ch)
    .bind(ws)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channel_seq(channel_id,workspace_id) VALUES($1,$2)")
        .bind(ch)
        .bind(ws)
        .execute(&su)
        .await
        .unwrap();
    for p in [&owner, &member] {
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
            .bind(ws)
            .bind(ch)
            .bind(p.actor.member)
            .execute(&su)
            .await
            .unwrap();
    }
    let sent = response(
        http.post(format!("{prefix}/channels/{ch}/messages"))
            .bearer_auth(&owner.token)
            .json(&json!({"clientMsgId":Uuid::new_v4(),"body":":http_party:"}))
            .send()
            .await
            .unwrap(),
        201,
    )
    .await;
    assert_eq!(sent["body"], ":http_party:");
    assert!(sent["props"].get("momo.sticker").is_none());
    assert!(sent["props"].get("expression").is_none());
    let forged_id = Uuid::new_v4();
    let forged = http.post(format!("{prefix}/channels/{ch}/messages"))
        .bearer_auth(&owner.token)
        .json(&json!({"clientMsgId":forged_id,"type":"approval_request","body":":http_party:","props":{"action":{"expression":{"v":1,"candidates":[uploaded]}}}}))
        .send().await.unwrap();
    assert!(forged.status().is_client_error());
    let persisted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND client_msg_id=$2",
    )
    .bind(ws)
    .bind(forged_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        persisted, 0,
        "a forged expression card cannot enter the message rail"
    );
    let message = sent["id"].as_str().unwrap();
    let reaction = format!("{prefix}/messages/{message}/reactions/%3Ahttp_party%3A");
    assert_eq!(
        http.put(&reaction)
            .bearer_auth(&member.token)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        http.put(format!(
            "{prefix}/messages/{message}/reactions/%3Aunknown_name%3A"
        ))
        .bearer_auth(&member.token)
        .send()
        .await
        .unwrap()
        .status(),
        404
    );
    // Subscribe proxy uses the credential minted by login; cross-tenant and
    // revoked credentials cannot read the new workspace rail.
    let token_id:Uuid=sqlx::query_scalar("SELECT id FROM token WHERE actor_member_id=$1 AND kind='session' AND label='access' ORDER BY created_at DESC LIMIT 1").bind(owner.actor.member).fetch_one(&su).await.unwrap();
    let subscribe = json!({"channel":format!("expressions:ws{}",ws.to_string().to_uppercase()),"user":owner.actor.member.to_string(),"meta":{"token_id":token_id.to_string()}});
    let allowed = response(
        http.post(format!("{base}/v1/centrifugo/subscribe"))
            .header("x-centrifugo-proxy-secret", SECRET)
            .json(&subscribe)
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    assert!(allowed.get("result").is_some());
    let mut foreign_sub = subscribe.clone();
    foreign_sub["channel"] = json!(format!(
        "expressions:ws{}",
        foreign_ws.to_string().to_uppercase()
    ));
    let denied = response(
        http.post(format!("{base}/v1/centrifugo/subscribe"))
            .header("x-centrifugo-proxy-secret", SECRET)
            .json(&foreign_sub)
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    assert!(denied.get("error").is_some());
    let hidden = response(
        http.post(format!("{prefix}/expressions/{id}/report"))
            .bearer_auth(&member.token)
            .json(&json!({"reason":"copyright","detail":"private"}))
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    sample(
        &mut samples,
        "post",
        "/v1/workspaces/{ws}/expressions/{id}/report",
        200,
        "Mutation",
        hidden,
    );
    assert_eq!(
        http.get(&active_url)
            .bearer_auth(&owner.token)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        http.put(&reaction)
            .bearer_auth(&member.token)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        http.delete(&reaction)
            .bearer_auth(&member.token)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let fallback = response(
        http.post(format!("{prefix}/channels/{ch}/messages"))
            .bearer_auth(&owner.token)
            .json(&json!({"clientMsgId":Uuid::new_v4(),"body":":http_party: :unknown_name:"}))
            .send()
            .await
            .unwrap(),
        201,
    )
    .await;
    assert_eq!(fallback["body"], ":http_party: :unknown_name:");
    assert!(fallback["props"].get("expression").is_none());
    let deleted = response(
        http.delete(format!("{prefix}/expressions/{id}"))
            .bearer_auth(&owner.token)
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    sample(
        &mut samples,
        "delete",
        "/v1/workspaces/{ws}/expressions/{id}",
        200,
        "Mutation",
        deleted,
    );
    // Source visibility is revalidated in PG before Drive I/O (missing channel
    // and someone else's attachment deliberately share the same 404).
    assert_eq!(http.post(format!("{prefix}/expressions/from-attachment")).bearer_auth(&owner.token).json(&json!({"name":"own_file","displayName":"file","tags":[],"subjectMemberId":null,"attachmentId":Uuid::new_v4(),"channelId":ch})).send().await.unwrap().status(),404);
    let file = Uuid::new_v4();
    sqlx::query("INSERT INTO attachment(id,workspace_id,channel_id,uploader_member_id,message_id,drive_file_id,name,mime,size_bytes,status) VALUES($1,$2,$3,$4,$5,'expression-fixture-file','image.png','image/png',1,'complete')").bind(file).bind(ws).bind(ch).bind(owner.actor.member).bind(Uuid::parse_str(message).unwrap()).execute(&su).await.unwrap();
    assert!(e::attachment_source(&api, owner.actor, ch, file)
        .await
        .is_ok());
    assert!(e::attachment_source(&api, member.actor, ch, file)
        .await
        .is_err());
    let out = std::env::var_os("OORT_EXPRESSION_CONTRACT_SAMPLES")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("oort-4676-openapi-samples.json"));
    std::fs::write(&out, serde_json::to_vec_pretty(&samples).unwrap()).unwrap();
    // Run the deployment gate's exact sampler on this live HTTP server, including
    // successful authenticated attachment ingestion and binary image samples.
    let sample_dir = out.with_extension("storage");
    std::fs::create_dir_all(&sample_dir).unwrap();
    let auth = sample_dir.join(format!("{}.auth", Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        use std::io::Write;
        let mut file = options.open(&auth).unwrap();
        writeln!(file, "header = \"Authorization: Bearer {}\"", owner.token).unwrap();
    }
    let result = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../scripts/sample_expression_contract.py"
        ))
        .args([
            "--base-url",
            &base,
            "--workspace",
            &ws.to_string(),
            "--channel",
            &ch.to_string(),
        ])
        .arg("--auth-config")
        .arg(&auth)
        .arg("--out-dir")
        .arg(&sample_dir)
        .arg("--manifest")
        .arg(sample_dir.join("manifest.jsonl"))
        .output()
        .await;
    std::fs::remove_file(auth).unwrap();
    let result = result.unwrap();
    assert!(
        result.status.success(),
        "expression sampler: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    // Credential liveness is rechecked for the new subscription namespace too.
    sqlx::query("UPDATE token SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2")
        .bind(ws)
        .bind(token_id)
        .execute(&su)
        .await
        .unwrap();
    let revoked = response(
        http.post(format!("{base}/v1/centrifugo/subscribe"))
            .header("x-centrifugo-proxy-secret", SECRET)
            .json(&subscribe)
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    assert!(revoked.get("error").is_some());
    task.abort();
}
