//! Contract conformance for the `cubesandbox` adapter, against a **fake
//! CubeAPI** (ADR-0156 D4-③).
//!
//! ## Why a fake, and what makes it worth trusting
//!
//! ADR-0156 D4-② owns the real host; this suite must not wait for it. But a
//! double that only says yes proves nothing, so this one replicates the three
//! upstream behaviours the adapter exists to survive — and each of them is a
//! behaviour the adapter would *fail* against, not one it enjoys:
//!
//! 1. **No idempotency key.** `POST /sandboxes` mints a fresh sandbox every
//!    single time it is called. If the adapter's metadata reconstruction is
//!    removed, this fake bills twice, and
//!    [`a_replayed_create_makes_exactly_one_billable_instance`] says so by name.
//! 2. **A lossy state fold.** The fake keeps a richer internal status than it
//!    reports and collapses everything non-paused to `running`, exactly as
//!    `CubeAPI/src/services/sandboxes.rs:917-923` does. So a wedged sandbox looks
//!    healthy over the wire, and
//!    [`a_wedged_sandbox_reports_running_and_that_proves_nothing`] pins what momo
//!    is allowed to conclude from it.
//! 3. **A cluster reaper that runs by default.** Omit `timeout`/`lifecycle` and
//!    the fake applies its own — a short one, `onTimeout: kill` — the way a real
//!    cluster with a configured `default_timeout_insec` would.
//!    [`every_create_names_its_own_reaper`] fails the moment momo stops choosing.
//!
//! It is *not* `mock-a`/`mock-b`: those are in-process substrates carrying
//! E2B-derived numbers and a momo-defined REST shape. This one speaks
//! CubeSandbox's dialect over a real loopback socket, so the HTTP layer — status
//! codes, headers, query encoding, body shape — is under test too.
//!
//! ## Isomorphism with the mock suite (매핑표 A13)
//!
//! [`a_full_lifecycle_is_honest_end_to_end`] walks the same path
//! `mock::tests::mock_a_runs_a_full_honest_lifecycle` walks, and the same
//! assertions hold. Where the two substrates legitimately differ — a second
//! pause — the difference is asserted rather than smoothed over; see
//! [`a_second_pause_is_rejudged_not_folded`].

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use momo_provider::{
    CloudInstancePresence, CloudInstanceRef, CloudInstanceSpec, CloudProviderAdapter,
    CloudProviderError,
};
use momo_t3::provider::{
    CubeSandboxProviderAdapter, CubeSandboxTuning, CUBESANDBOX_PROVIDER_ID, METADATA_PROVISION_KEY,
    METADATA_WORKSPACE_KEY,
};
use serde_json::{json, Value};
use uuid::Uuid;

/// The operator credential the fake demands. ADR-0004: it exists only in this
/// process's environment map and in the adapter that owns it.
const OPERATOR_KEY: &str = "cube-operator-key-not-a-real-secret";
const TEMPLATE_ID: &str = "tpl-oort-workd";

/// What a cluster with a configured `default_timeout_insec` would impose on a
/// create that names no `timeout`. Deliberately short and deliberately `kill`:
/// this is the reaper momo did not choose.
const CLUSTER_DEFAULT_TIMEOUT_SECONDS: i64 = 300;

// ---------------------------------------------------------------------------
// the fake CubeAPI
// ---------------------------------------------------------------------------

/// The sandbox's real condition. Richer than what [`Sandbox::reported_state`]
/// admits — which is the whole point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InternalStatus {
    Running,
    Paused,
    Pausing,
    /// Alive to the control plane, useless to its owner: the process tree is
    /// gone, the daemon stopped heartbeating. CubeAPI has no word for this and
    /// folds it into `running`.
    Wedged,
}

/// Which side of the wire picked the reaper for one sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReaperChosenBy {
    Momo,
    ClusterDefault,
}

#[derive(Debug, Clone)]
struct Reaper {
    timeout_seconds: i64,
    on_timeout: String,
    auto_resume: bool,
    chosen_by: ReaperChosenBy,
}

#[derive(Debug, Clone)]
struct Sandbox {
    id: String,
    template_id: String,
    metadata: BTreeMap<String, String>,
    env_vars: BTreeMap<String, String>,
    status: InternalStatus,
    reaper: Reaper,
}

impl Sandbox {
    /// `sandbox_state_from_status`, verbatim in behaviour: `Paused → paused`,
    /// `Pausing → pausing`, and **everything else → running**.
    fn reported_state(&self) -> &'static str {
        match self.status {
            InternalStatus::Paused => "paused",
            InternalStatus::Pausing => "pausing",
            InternalStatus::Running | InternalStatus::Wedged => "running",
        }
    }

    fn detail(&self) -> Value {
        json!({
            "sandboxID": self.id,
            "templateID": self.template_id,
            "state": self.reported_state(),
            "metadata": self.metadata,
        })
    }
}

#[derive(Debug, Default)]
struct FakeState {
    sandboxes: Vec<Sandbox>,
    /// Every `(method, path)` this fake was asked for — so a test can assert a
    /// path was *never* taken.
    requests: Vec<(String, String)>,
    /// Every create body, verbatim.
    create_bodies: Vec<Value>,
    /// Whether the create response is delivered. `false` = the sandbox is made
    /// and the caller never learns its id.
    deliver_create_response: bool,
    /// Force a status on `GET /sandboxes/{id}`.
    detail_status_override: Option<u16>,
    /// Force a status (+ `Retry-After`) on `DELETE`.
    destroy_status_override: Option<u16>,
    /// Force a status on the list query the reconstruction uses.
    list_status_override: Option<u16>,
    next_id: u64,
}

#[derive(Debug, Clone, Default)]
struct FakeCube(Arc<Mutex<FakeState>>);

impl FakeCube {
    fn new() -> Self {
        FakeCube(Arc::new(Mutex::new(FakeState {
            deliver_create_response: true,
            ..FakeState::default()
        })))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn create_count(&self) -> usize {
        self.lock().create_bodies.len()
    }

    fn live_count(&self) -> usize {
        self.lock().sandboxes.len()
    }

    fn last_create_body(&self) -> Value {
        self.lock()
            .create_bodies
            .last()
            .cloned()
            .expect("a create was recorded")
    }

    fn paths(&self) -> Vec<String> {
        self.lock()
            .requests
            .iter()
            .map(|(method, path)| format!("{method} {path}"))
            .collect()
    }

    fn reaper_of(&self, id: &str) -> Reaper {
        self.lock()
            .sandboxes
            .iter()
            .find(|sandbox| sandbox.id == id)
            .expect("sandbox exists")
            .reaper
            .clone()
    }

    fn env_vars_of(&self, id: &str) -> BTreeMap<String, String> {
        self.lock()
            .sandboxes
            .iter()
            .find(|sandbox| sandbox.id == id)
            .expect("sandbox exists")
            .env_vars
            .clone()
    }

    fn set_status(&self, id: &str, status: InternalStatus) {
        let mut state = self.lock();
        let sandbox = state
            .sandboxes
            .iter_mut()
            .find(|sandbox| sandbox.id == id)
            .expect("sandbox exists");
        sandbox.status = status;
    }

    fn only_id(&self) -> String {
        let state = self.lock();
        assert_eq!(state.sandboxes.len(), 1, "expected exactly one sandbox");
        state.sandboxes[0].id.clone()
    }
}

fn unauthorized(headers: &HeaderMap) -> bool {
    headers
        .get("X-API-Key")
        .and_then(|value| value.to_str().ok())
        != Some(OPERATOR_KEY)
}

fn status_only(code: u16) -> Response {
    StatusCode::from_u16(code)
        .expect("valid status")
        .into_response()
}

async fn create_sandbox(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("POST".to_string(), "/sandboxes".to_string()));
    if unauthorized(&headers) {
        return status_only(401);
    }
    state.create_bodies.push(body.clone());

    // No idempotency key exists upstream, so this fake never looks for one: a
    // second identical POST makes a second billable sandbox, every time.
    state.next_id += 1;
    let id = format!("iiny0783cype8gmoawzmx-ce30bc{:02}", state.next_id);

    // The reaper the *cluster* would apply when momo names nothing.
    let timeout_seconds = body.get("timeout").and_then(Value::as_i64);
    let on_timeout = body
        .get("lifecycle")
        .and_then(|lifecycle| lifecycle.get("onTimeout"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let auto_resume = body
        .get("lifecycle")
        .and_then(|lifecycle| lifecycle.get("autoResume"))
        .and_then(Value::as_bool);
    let reaper = match (timeout_seconds, on_timeout) {
        (Some(timeout_seconds), Some(on_timeout)) => Reaper {
            timeout_seconds,
            on_timeout,
            auto_resume: auto_resume.unwrap_or(false),
            chosen_by: ReaperChosenBy::Momo,
        },
        // Either half missing and the cluster fills it in. `onTimeout` defaults
        // to `kill` upstream, so this is not a benign omission.
        _ => Reaper {
            timeout_seconds: timeout_seconds.unwrap_or(CLUSTER_DEFAULT_TIMEOUT_SECONDS),
            on_timeout: "kill".to_string(),
            auto_resume: auto_resume.unwrap_or(false),
            chosen_by: ReaperChosenBy::ClusterDefault,
        },
    };

    let string_map = |value: Option<&Value>| -> BTreeMap<String, String> {
        value
            .and_then(Value::as_object)
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };

    let sandbox = Sandbox {
        id: id.clone(),
        template_id: body
            .get("templateID")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        metadata: string_map(body.get("metadata")),
        env_vars: string_map(body.get("envVars")),
        status: InternalStatus::Running,
        reaper,
    };
    state.sandboxes.push(sandbox);

    if !state.deliver_create_response {
        // The sandbox exists and is billing; the caller will never see its id.
        // This is the failure the metadata reconstruction is built for.
        return status_only(502);
    }
    (
        StatusCode::CREATED,
        Json(json!({
            "sandboxID": id,
            "templateID": TEMPLATE_ID,
            "clientID": "fake-cube",
            "envdVersion": "0.0.0",
        })),
    )
        .into_response()
}

/// `GET /sandboxes?metadata=k=v&metadata=k2=v2` — AND across every pair.
async fn list_sandboxes(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    Query(query): Query<Vec<(String, String)>>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("GET".to_string(), "/sandboxes".to_string()));
    if unauthorized(&headers) {
        return status_only(401);
    }
    if let Some(code) = state.list_status_override {
        return status_only(code);
    }
    let filters: Vec<(String, String)> = query
        .iter()
        .filter(|(key, _)| key == "metadata")
        .filter_map(|(_, value)| {
            let (key, value) = value.split_once('=')?;
            Some((key.to_string(), value.to_string()))
        })
        .collect();
    let matched: Vec<Value> = state
        .sandboxes
        .iter()
        .filter(|sandbox| {
            filters
                .iter()
                .all(|(key, value)| sandbox.metadata.get(key) == Some(value))
        })
        .map(Sandbox::detail)
        .collect();
    Json(Value::Array(matched)).into_response()
}

async fn get_sandbox(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("GET".to_string(), format!("/sandboxes/{id}")));
    if unauthorized(&headers) {
        return status_only(401);
    }
    if let Some(code) = state.detail_status_override {
        return status_only(code);
    }
    match state.sandboxes.iter().find(|sandbox| sandbox.id == id) {
        // 404 is the *only* way a dead sandbox is expressed: `SandboxState` has
        // no `terminated`.
        None => status_only(404),
        Some(sandbox) => Json(sandbox.detail()).into_response(),
    }
}

async fn pause_sandbox(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("POST".to_string(), format!("/sandboxes/{id}/pause")));
    if unauthorized(&headers) {
        return status_only(401);
    }
    let Some(sandbox) = state.sandboxes.iter_mut().find(|sandbox| sandbox.id == id) else {
        return status_only(404);
    };
    match sandbox.status {
        InternalStatus::Running | InternalStatus::Wedged => {
            sandbox.status = InternalStatus::Paused;
            status_only(204)
        }
        // "Sandbox cannot be paused" — one status for several reasons, which is
        // exactly why the adapter re-asks instead of folding it.
        InternalStatus::Paused | InternalStatus::Pausing => status_only(409),
    }
}

async fn connect_sandbox(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("POST".to_string(), format!("/sandboxes/{id}/connect")));
    if unauthorized(&headers) {
        return status_only(401);
    }
    let Some(sandbox) = state.sandboxes.iter_mut().find(|sandbox| sandbox.id == id) else {
        return status_only(404);
    };
    // Convergent by design: already-running is a 200, not a 409.
    sandbox.status = InternalStatus::Running;
    let detail = sandbox.detail();
    (StatusCode::OK, Json(detail)).into_response()
}

/// The deprecated path. Present so a test can prove momo never asks for it.
async fn resume_sandbox(State(fake): State<FakeCube>, Path(id): Path<String>) -> Response {
    fake.lock()
        .requests
        .push(("POST".to_string(), format!("/sandboxes/{id}/resume")));
    status_only(410)
}

async fn delete_sandbox(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("DELETE".to_string(), format!("/sandboxes/{id}")));
    if unauthorized(&headers) {
        return status_only(401);
    }
    if let Some(code) = state.destroy_status_override {
        let mut response = status_only(code);
        response
            .headers_mut()
            .insert("Retry-After", "5".parse().expect("header value"));
        return response;
    }
    let before = state.sandboxes.len();
    state.sandboxes.retain(|sandbox| sandbox.id != id);
    if state.sandboxes.len() == before {
        return status_only(404);
    }
    status_only(204)
}

async fn spawn_fake_cube() -> (String, FakeCube) {
    let fake = FakeCube::new();
    let app = Router::new()
        .route("/sandboxes", post(create_sandbox).get(list_sandboxes))
        .route("/sandboxes/{id}", get(get_sandbox).delete(delete_sandbox))
        .route("/sandboxes/{id}/pause", post(pause_sandbox))
        .route("/sandboxes/{id}/connect", post(connect_sandbox))
        .route("/sandboxes/{id}/resume", post(resume_sandbox))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake cube api");
    let address: SocketAddr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), fake)
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn env_for(base_url: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL".to_string(),
            base_url.to_string(),
        ),
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY".to_string(),
            OPERATOR_KEY.to_string(),
        ),
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_IMAGE_REF".to_string(),
            TEMPLATE_ID.to_string(),
        ),
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_SWEEP_SECONDS".to_string(),
            "3600".to_string(),
        ),
    ])
}

async fn adapter_against_fake() -> (CubeSandboxProviderAdapter, FakeCube) {
    let (base_url, fake) = spawn_fake_cube().await;
    let adapter = CubeSandboxProviderAdapter::from_env(&env_for(&base_url))
        .expect("the adapter is fully configured");
    (adapter, fake)
}

fn spec() -> CloudInstanceSpec {
    CloudInstanceSpec {
        provision_id: Uuid::from_u128(11),
        workspace_id: Uuid::from_u128(13),
        display_name: "cube conformance".to_string(),
        registration_token: "one-shot-workd-token".to_string(),
        server_url: "https://momo.invalid".to_string(),
    }
}

// ---------------------------------------------------------------------------
// create — shape, and the idempotency CubeSandbox does not provide
// ---------------------------------------------------------------------------

/// 매핑표 A1 — the create body upstream actually accepts, field for field.
#[tokio::test]
async fn create_sends_the_documented_shape_and_nothing_it_would_swallow() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    assert_eq!(instance.provider_id, CUBESANDBOX_PROVIDER_ID);

    let body = fake.last_create_body();
    assert_eq!(body["templateID"].as_str(), Some(TEMPLATE_ID));
    assert_eq!(
        body["metadata"][METADATA_PROVISION_KEY].as_str(),
        Some("prov-1")
    );
    assert_eq!(
        body["metadata"][METADATA_WORKSPACE_KEY].as_str(),
        Some(spec().workspace_id.to_string().as_str())
    );
    assert_eq!(
        body["envVars"]["MOMO_WORKD_REGISTRATION_TOKEN"].as_str(),
        Some("one-shot-workd-token")
    );
    assert!(
        body.get("secure").is_none() && body.get("autoPause").is_none(),
        "named regression: `NewSandbox` has no deny_unknown_fields, so a field CubeSandbox does \
         not read is swallowed in silence and momo believes in a policy never applied"
    );
}

/// 매핑표 A2 — **red proof #1's target.**
///
/// The fake mints a new sandbox on every POST, so the only thing standing
/// between a replayed create and a second billed instance is the adapter's
/// metadata lookup. Delete that lookup and this test reports two.
#[tokio::test]
async fn a_replayed_create_makes_exactly_one_billable_instance() {
    let (adapter, fake) = adapter_against_fake().await;
    let first = adapter.create(&spec(), "prov-1").await.expect("create");
    let replay = adapter
        .create(&spec(), "prov-1")
        .await
        .expect("replayed create");
    let other = adapter.create(&spec(), "prov-2").await.expect("other");

    assert_eq!(
        first.instance_id, replay.instance_id,
        "named regression: a replayed create must converge on the same instance, not a second \
         billable one (ADR-0142 D2)"
    );
    assert_ne!(first.instance_id, other.instance_id);
    assert_eq!(
        fake.create_count(),
        2,
        "named regression: exactly two POSTs reached the substrate — one per distinct key. \
         Three means the reconstruction lookup is gone and the workspace is paying twice"
    );
    assert_eq!(fake.live_count(), 2);
}

/// 매핑표 A3 — the sandbox exists, the response did not arrive.
///
/// This is the failure that makes the missing idempotency key expensive: without
/// reconstruction, the retry creates a second instance and the first bills
/// forever under a name momo never learned.
#[tokio::test]
async fn a_lost_create_response_does_not_leave_an_orphan_behind() {
    let (adapter, fake) = adapter_against_fake().await;
    fake.lock().deliver_create_response = false;

    let failure = adapter
        .create(&spec(), "prov-1")
        .await
        .expect_err("the response was lost");
    assert!(matches!(failure, CloudProviderError::UpstreamStatus(502)));
    assert_eq!(fake.live_count(), 1, "the sandbox is real and is billing");

    fake.lock().deliver_create_response = true;
    let recovered = adapter
        .create(&spec(), "prov-1")
        .await
        .expect("the retry finds it");
    assert_eq!(
        recovered.instance_id,
        fake.only_id(),
        "named regression: the retry must adopt the orphan, not make a second one"
    );
    assert_eq!(fake.live_count(), 1);
    assert_eq!(fake.create_count(), 1, "only the first POST ever landed");
}

/// A lookup that cannot be answered is not "nothing found".
///
/// Treating an unreachable control plane as an empty result is precisely the
/// path from one outage to two billed instances.
#[tokio::test]
async fn a_failed_reconstruction_lookup_stops_the_create() {
    let (adapter, fake) = adapter_against_fake().await;
    fake.lock().list_status_override = Some(503);

    let failure = adapter
        .create(&spec(), "prov-1")
        .await
        .expect_err("the lookup could not be answered");
    assert!(matches!(failure, CloudProviderError::UpstreamStatus(503)));
    assert_eq!(
        fake.create_count(),
        0,
        "named regression: no POST may follow a lookup momo could not read — that is how a lost \
         response becomes a second billable instance"
    );
}

// ---------------------------------------------------------------------------
// probe — the lossy fold
// ---------------------------------------------------------------------------

/// 매핑표 A4 / §2.3, cell for cell.
#[tokio::test]
async fn probe_maps_the_table_and_never_invents_a_death() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");

    assert_eq!(
        adapter.probe(&instance).await.expect("probe"),
        CloudInstancePresence::Present
    );

    for status in [500, 503, 429, 403] {
        fake.lock().detail_status_override = Some(status);
        assert_eq!(
            adapter.probe(&instance).await.expect("probe"),
            CloudInstancePresence::Unknown,
            "named regression: {status} must read `unknown`, never `absent` — ADR-0140 D4 \
             settles a live paid session on `absent`"
        );
    }
    fake.lock().detail_status_override = None;

    adapter.destroy(&instance, "op-1").await.expect("destroy");
    assert_eq!(
        adapter.probe(&instance).await.expect("probe"),
        CloudInstancePresence::Absent,
        "404 is the only way CubeSandbox expresses a dead sandbox"
    );
}

/// 매핑표 A5 — **red proof #2's target.**
///
/// The fake's sandbox is wedged: nothing runs inside it any more. CubeAPI folds
/// that into `running` and answers 200, so the wire says "healthy". What momo is
/// allowed to conclude is *presence* and only presence — the same answer a
/// paused sandbox produces — and every billing consequence stays with the
/// heartbeat-driven paths (ADR-0139/0141), which never consult this adapter.
#[tokio::test]
async fn a_wedged_sandbox_reports_running_and_that_proves_nothing() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    let id = instance.instance_id.clone();

    fake.set_status(&id, InternalStatus::Wedged);
    let wedged = adapter.probe(&instance).await.expect("probe");

    fake.set_status(&id, InternalStatus::Running);
    let healthy = adapter.probe(&instance).await.expect("probe");

    fake.set_status(&id, InternalStatus::Paused);
    let paused = adapter.probe(&instance).await.expect("probe");

    assert_eq!(
        (wedged, healthy, paused),
        (
            CloudInstancePresence::Present,
            CloudInstancePresence::Present,
            CloudInstancePresence::Present
        ),
        "named regression: presence is `the control plane has a record`, not `the machine \
         works`. If these three ever differ, some code has started reading CubeAPI's lossy \
         `running` as liveness — and the 정본 for liveness is the workd heartbeat (ADR-0156 D6②)"
    );

    // …and the substrate really was lying: the state it reported for the wedged
    // sandbox is the same word it reports for a healthy one.
    assert!(
        fake.paths()
            .iter()
            .any(|entry| entry.contains(&format!("GET /sandboxes/{id}"))),
        "the probe went to the documented endpoint"
    );
}

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

/// 매핑표 A9 — a `409` is a question, not an answer.
///
/// This is also where this substrate and `mock-a` honestly disagree, and the
/// disagreement is asserted rather than hidden. `mock-a` answers
/// `InstancePaused` for a second pause because it refuses to claim work it did
/// not do — a statement about the *call*. Here the adapter re-asks and finds the
/// sandbox paused, so the durable intent ("this host must be paused") is
/// satisfied — a statement about the *world*. Folding the 409 straight to
/// `InstancePaused` without re-asking would be the real bug: upstream returns
/// the same 409 for a sandbox that is still *running*, and ADR-0140 D4 would
/// then stop billing a machine still burning the host.
#[tokio::test]
async fn a_second_pause_is_rejudged_not_folded() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    let id = instance.instance_id.clone();

    adapter.pause(&instance, "op-1").await.expect("pause");
    adapter
        .pause(&instance, "op-2")
        .await
        .expect("an already-paused sandbox satisfies the intent");

    // Now the same 409 for the other reason: mid-transition, still billable.
    fake.set_status(&id, InternalStatus::Pausing);
    let verdict = adapter
        .pause(&instance, "op-3")
        .await
        .expect_err("a pausing sandbox is not a paused one");
    assert!(
        matches!(verdict, CloudProviderError::UpstreamStatus(409)),
        "named regression: `cannot be paused` covers several conditions. Collapsing it to \
         `InstancePaused` would report a not-yet-paused instance as paused and stop its billing"
    );

    // The re-judgement is a real second look at the substrate.
    let detail_probes = fake
        .paths()
        .iter()
        .filter(|entry| **entry == format!("GET /sandboxes/{id}"))
        .count();
    assert!(
        detail_probes >= 2,
        "each 409 must be followed by a fresh read of the sandbox, not a guess"
    );
}

#[tokio::test]
async fn pause_on_a_vanished_sandbox_is_terminal_not_a_retry() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    fake.lock().sandboxes.clear();

    assert!(
        matches!(
            adapter.pause(&instance, "op-1").await,
            Err(CloudProviderError::InstanceMissing)
        ),
        "a dead sandbox is a fact whichever operation found it — ADR-0140 D4 converges it to \
         `provider_missing`"
    );
    assert!(matches!(
        adapter.resume(&instance, "op-2").await,
        Err(CloudProviderError::InstanceMissing)
    ));
}

/// 매핑표 A8 — the deprecated path is never taken.
#[tokio::test]
async fn resume_goes_through_connect_and_never_the_deprecated_path() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    let id = instance.instance_id.clone();

    adapter.pause(&instance, "op-1").await.expect("pause");
    adapter.resume(&instance, "op-2").await.expect("resume");
    adapter
        .resume(&instance, "op-3")
        .await
        .expect("resuming an already-running sandbox converges rather than 409ing");

    let paths = fake.paths();
    assert!(paths.contains(&format!("POST /sandboxes/{id}/connect")));
    assert!(
        !paths.iter().any(|entry| entry.ends_with("/resume")),
        "named regression: `/resume` is deprecated upstream and answers 409 for an \
         already-running sandbox — the exact retry ADR-0140 D4 performs. Found: {paths:?}"
    );
}

// ---------------------------------------------------------------------------
// destroy — the intent that never gives up
// ---------------------------------------------------------------------------

/// 매핑표 A6 + A7.
#[tokio::test]
async fn destroy_folds_absence_into_success_and_surrenders_to_nothing_else() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");

    // 503 + Retry-After: refused, and the intent stays claimable.
    fake.lock().destroy_status_override = Some(503);
    assert!(
        matches!(
            adapter.destroy(&instance, "op-1").await,
            Err(CloudProviderError::UpstreamStatus(503))
        ),
        "a destroy that did not happen must not report success — the instance is still billing"
    );
    assert_eq!(fake.live_count(), 1);

    // 408 (synchronous delete timed out) and 409 (no room to restore a paused
    // sandbox for destruction) are the same shape: retry, never abandon.
    for code in [408, 409, 500] {
        fake.lock().destroy_status_override = Some(code);
        assert!(matches!(
            adapter.destroy(&instance, "op-1").await,
            Err(CloudProviderError::UpstreamStatus(status)) if status == code
        ));
    }

    fake.lock().destroy_status_override = None;
    adapter.destroy(&instance, "op-1").await.expect("destroy");
    adapter
        .destroy(&instance, "op-1")
        .await
        .expect("404 satisfies the intent `this instance must not exist`");
    assert_eq!(fake.live_count(), 0);
}

// ---------------------------------------------------------------------------
// lifecycle policy — the reaper momo chose
// ---------------------------------------------------------------------------

/// ADR-0156 D6② — **red proof #3's target.**
///
/// The fake plays a cluster with a configured `default_timeout_insec`: name no
/// `timeout`/`lifecycle` and it applies its own short one, with `onTimeout:
/// kill`. So "we sent nothing" does not mean "no reaper" — it means the ledger
/// does not know when its paid instances will disappear.
#[tokio::test]
async fn every_create_names_its_own_reaper() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    let reaper = fake.reaper_of(&instance.instance_id);

    assert_eq!(
        reaper.chosen_by,
        ReaperChosenBy::Momo,
        "named regression: an absent `timeout` or `lifecycle.onTimeout` hands the reaper to the \
         cluster, and paid instances start vanishing behind the ledger's back (ADR-0156 D6②)"
    );
    assert_eq!(reaper.on_timeout, "kill");
    assert!(
        !reaper.auto_resume,
        "named regression: autoResume produces a paused->running transition that never passed \
         through momo's durable intent (ADR-0140 D4)"
    );
    assert_eq!(
        reaper.timeout_seconds,
        3_600 * 4,
        "the net is four ledger sweeps, from the operator's configured period"
    );
    assert!(
        reaper.timeout_seconds > CLUSTER_DEFAULT_TIMEOUT_SECONDS,
        "the safety net must sit *under* the ledger sweep, not race it"
    );
    assert_eq!(adapter.idle_timeout_seconds(), reaper.timeout_seconds);
}

// ---------------------------------------------------------------------------
// isomorphism with the mock suite + ADR-0004
// ---------------------------------------------------------------------------

/// 매핑표 A13 — the same walk `mock::tests::mock_a_runs_a_full_honest_lifecycle`
/// takes, over real HTTP.
#[tokio::test]
async fn a_full_lifecycle_is_honest_end_to_end() {
    let (adapter, _fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    assert_eq!(
        adapter.probe(&instance).await.unwrap(),
        CloudInstancePresence::Present
    );

    adapter.pause(&instance, "op-1").await.expect("pause");
    assert_eq!(
        adapter.probe(&instance).await.unwrap(),
        CloudInstancePresence::Present,
        "a paused sandbox is present — pause is not death"
    );

    adapter.resume(&instance, "op-2").await.expect("resume");
    adapter.destroy(&instance, "op-3").await.expect("destroy");
    adapter
        .destroy(&instance, "op-3")
        .await
        .expect("destroy is idempotent");
    assert_eq!(
        adapter.probe(&instance).await.unwrap(),
        CloudInstancePresence::Absent
    );
}

/// 매핑표 A11 / ADR-0004 — the operator credential authenticates momo to the
/// substrate and goes nowhere else. In particular it is not among the things the
/// sandbox itself is handed.
#[tokio::test]
async fn the_operator_credential_never_travels_into_the_sandbox() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");

    let env_vars = fake.env_vars_of(&instance.instance_id);
    for (name, value) in &env_vars {
        assert!(
            !value.contains(OPERATOR_KEY),
            "named regression: the provider credential reached the sandbox through {name}"
        );
    }
    let body = fake.last_create_body().to_string();
    assert!(
        !body.contains(OPERATOR_KEY),
        "the credential travels in the X-API-Key header only, never in a body"
    );

    // …and a wrong credential is refused rather than silently downgraded.
    let (base_url, _) = spawn_fake_cube().await;
    let mut env = env_for(&base_url);
    env.insert(
        "MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY".to_string(),
        "wrong-key".to_string(),
    );
    let wrong = CubeSandboxProviderAdapter::from_env(&env).expect("configured");
    assert!(matches!(
        wrong.create(&spec(), "prov-1").await,
        Err(CloudProviderError::UpstreamStatus(401))
    ));
}

/// 매핑표 A12 — policy code may not learn this provider's name.
///
/// The registry and the adapter are the two places the literal is allowed. Every
/// other shipping module in the T3 spine, the reconciler worker and the REST
/// layer must reach the same facts through
/// `capabilities_for` / `CloudProviderAdapter`.
#[test]
fn no_policy_module_names_the_provider() {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let roots = [
        manifest.join("src"),
        manifest.join("../../bins/momo-notifier/src"),
        manifest.join("../../bins/momo-server/src"),
    ];
    let mut scanned = 0usize;
    for root in roots {
        for path in rust_sources(&root) {
            // `provider/` is where provider-specific facts are *supposed* to
            // live (ADR-0142 D2) — registry + adapters.
            if path.components().any(|part| part.as_os_str() == "provider")
                || path.file_name().and_then(|name| name.to_str()) == Some("provider.rs")
            {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("read source");
            // Tests may name anything; policy may not.
            let shipping = source
                .split_once("#[cfg(test)]")
                .map_or(source.as_str(), |(head, _)| head)
                .to_string();
            assert!(
                !shipping.contains("cubesandbox"),
                "named regression: {} names the provider. Every provider-specific fact reaches \
                 policy through `capabilities_for`, so a literal here is the ADR-0142 D2 wall \
                 coming down",
                path.display()
            );
            scanned += 1;
        }
    }
    assert!(scanned > 20, "the scan found only {scanned} files to read");
}

fn rust_sources(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(rust_sources(&path));
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            found.push(path);
        }
    }
    found
}

/// The instance ids this substrate hands out really do pass the charset the
/// contract constrains them to (`iiny0783cype8gmoawzmx-ce30bc46` is upstream's
/// documented shape).
#[tokio::test]
async fn substrate_instance_ids_satisfy_the_contract_charset() {
    let (adapter, _fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    assert!(momo_provider::validated_cloud_instance_id(&instance.instance_id).is_ok());

    let handle = CloudInstanceRef {
        provider_id: CUBESANDBOX_PROVIDER_ID.to_string(),
        instance_id: instance.instance_id.clone(),
    };
    assert_eq!(
        adapter.probe(&handle).await.unwrap(),
        CloudInstancePresence::Present
    );
}

/// The tuning defaults, seen from the outside: an operator who configures only
/// the credential still gets a conservative ceiling and a long net.
#[tokio::test]
async fn an_untuned_host_gets_the_conservative_defaults() {
    let (base_url, _fake) = spawn_fake_cube().await;
    let mut env = env_for(&base_url);
    env.remove("MOMO_T3_PROVIDER_CUBESANDBOX_SWEEP_SECONDS");
    let adapter = CubeSandboxProviderAdapter::from_env(&env).expect("configured");
    assert_eq!(
        adapter.capabilities().max_concurrent_instances,
        Some(momo_t3::provider::CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES)
    );
    assert_eq!(
        adapter.idle_timeout_seconds(),
        CubeSandboxTuning::default().idle_timeout_seconds()
    );
}
