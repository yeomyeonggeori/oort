//! Contract conformance for the `cubesandbox` adapter, against a **fake
//! CubeAPI** (ADR-0156 D4-③).
//!
//! ## Why a fake, and what makes it worth trusting
//!
//! ADR-0156 D4-② owns the real host; this suite must not wait for it. But a
//! double that only says yes proves nothing, so this one replicates the upstream
//! behaviours the adapter exists to survive — and each of them is a behaviour
//! the adapter would *fail* against, not one it enjoys:
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
//! 4. **"Already in that state" is a 500, not a 409** (#1197 B1).
//! 5. **A crash is invisible**: a killed VMM keeps answering `200 running`
//!    forever (#1197 B2).
//! 6. **`timeout` is an absolute TTL** and `/refreshes` *assigns* the deadline
//!    rather than extending it (#1197 H1).
//! 7. **`metadata` comes back polluted** with the substrate's own keys
//!    (#1197 H3).
//! 8. **`envVars` is a network delivery, not an environment** (#1437).
//!    Cubelet posts it to a listener inside the guest during the create call, so
//!    a template with nothing listening fails the *whole* create — measured on
//!    momo-cube-host 2026-08-16 against momo's own templates, which is how
//!    INFRA-A (#1434) was blocked. The fake reproduces both halves, including
//!    the one that matters most: the failed create leaves **no** sandbox behind.
//!    See [`a_template_that_cannot_receive_the_bootstrap_delivery_fails_the_whole_create`].
//!
//! ## What #1197 changed here, and why the fake was the bug
//!
//! Points 4–7 were all measured on a real CubeSandbox v0.6.0 host on 2026-08-09
//! (`docs/planning/research/2026-08-09-cubesandbox-d42-spike.md`), and in every
//! one of them **this file previously modelled the wrong shape** — so the suite
//! was green against a substrate that does not exist. That is the finding the
//! ticket exists for: a fake that agrees with the mapping table instead of the
//! machine turns conformance into a tautology. Each of the four now carries the
//! measured artefact (status code, body, timing, key list) next to the code that
//! reproduces it, so the next divergence is visible as a diff rather than as a
//! production incident.
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
use serde_json::{json, Map, Value};
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
    /// **The VMM was SIGKILLed** (#1197 B2). Strictly worse than `Wedged`: not
    /// only is the guest gone, the control plane never finds out.
    ///
    /// Measured on the real host — kill the `containerd-shim-cube-rs` for a
    /// sandbox and CubeAPI answers `200 {"state":"running"}` for at least five
    /// minutes (15 probes at 20 s, zero convergence). It never becomes a 404 on
    /// its own, so ADR-0140 D4's `provider_missing` — the verdict that reclaims
    /// a dead instance — is unreachable. The one thing that worked was an
    /// explicitly issued `DELETE`, which this fake honours exactly as the real
    /// host did (204, then 404).
    Crashed,
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
    /// When this sandbox will be deleted, on the fake's virtual clock
    /// (#1197 H1).
    ///
    /// Set to `now + timeout` at creation and **reassigned** — not extended — by
    /// `/refreshes`, which is the measured semantic. Nothing else moves it: the
    /// spike could not shift the real `endAt` with a detail GET, a list GET, an
    /// SDK exec, a 60 s CPU burn inside the sandbox, or outbound HTTPS from it.
    end_at_seconds: i64,
}

impl Sandbox {
    /// `sandbox_state_from_status`, verbatim in behaviour: `Paused → paused`,
    /// `Pausing → pausing`, and **everything else → running**.
    fn reported_state(&self) -> &'static str {
        match self.status {
            InternalStatus::Paused => "paused",
            InternalStatus::Pausing => "pausing",
            InternalStatus::Running | InternalStatus::Wedged | InternalStatus::Crashed => "running",
        }
    }

    /// The response body, **polluted the way the real one is** (#1197 H3).
    ///
    /// Measured: a sandbox created with 2 metadata keys comes back with 12. The
    /// extra ten are CubeSandbox's own bookkeeping and are reproduced here key
    /// for key, including the entry whose key *and value* are both the literal
    /// string `X-Caller`. A fake that echoed only momo's keys would let the
    /// adapter store the whole dict and never notice.
    fn detail(&self) -> Value {
        let mut metadata: Map<String, Value> = self
            .metadata
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect();
        for (key, value) in SUBSTRATE_METADATA {
            metadata.insert(key.to_string(), Value::String(value.to_string()));
        }
        json!({
            "sandboxID": self.id,
            "templateID": self.template_id,
            "state": self.reported_state(),
            "metadata": Value::Object(metadata),
            "cpuCount": 2,
            "memoryMB": 2000,
            // Measured: reported, and always 0. Unusable for cost
            // cross-checking, which is why nothing reads it.
            "diskSizeMB": 0,
            "endAt": self.end_at_seconds,
        })
    }
}

/// The metadata CubeSandbox adds to every sandbox, verbatim from the D4-②
/// round trip (#1197 H3).
const SUBSTRATE_METADATA: [(&str, &str); 10] = [
    (
        "cube.master.appsnapshot.template.id",
        "tpl-50622c58811449bbba60cc1e",
    ),
    (
        "cube.master.runtime.restore.snapshot.id",
        "tpl-50622c58811449bbba60cc1e",
    ),
    (
        "cube.master.runtime.restore.snapshot.attached_at",
        "2026-08-08T17:04:50.078267206Z",
    ),
    (
        "cube.master.runtime.snapshot.id",
        "tpl-50622c58811449bbba60cc1e",
    ),
    (
        "cube.master.runtime.snapshot.attached_at",
        "2026-08-08T17:04:50.078267206Z",
    ),
    ("cube.master.instance.type", "cubebox"),
    ("cube.master.components.envd.version", "0.5.11"),
    ("cube.numa_node", "0"),
    ("cube.product", "cubebox"),
    // Not a typo. The real response carries this, key and value identical.
    ("X-Caller", "X-Caller"),
];

/// The body CubeMaster wraps an "already in that state" refusal in, verbatim
/// (#1197 B1). The `130490` is the code the rejected 문자열-파싱 처방 would have
/// had to match on.
fn already_in_state(detail: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "code": 500,
            "message": format!("CubeMaster returned error code 130490: {detail}"),
        })),
    )
        .into_response()
}

/// The same 500 envelope, a different CubeMaster code, an opposite meaning
/// (#1197 B1). `/refreshes` and `/timeout` express "no such sandbox" this way
/// while every other route answers a plain 404 — which is the sharpest possible
/// argument for deciding refusals by re-probing rather than by reading codes.
fn already_missing(id: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "code": 500,
            "message": format!(
                "CubeMaster returned error code 130404: sandbox id not found: {id:?}"
            ),
        })),
    )
        .into_response()
}

/// The body CubeMaster wraps a failed `envVars` delivery in, verbatim
/// (#1437, momo-cube-host 2026-08-16).
///
/// The code is `130497` and the sentence blames a missing annotation, but the
/// operative half is the tail: Cubelet could not hand the material to anything
/// inside the guest. momo's answer is the receiver in
/// `infra/cubesandbox/bootstrap-init/`, not a code this adapter parses.
fn init_delivery_refused() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "code": 500,
            "message": "CubeMaster returned error code 130497: create_time_env_vars init failed \
                        after bounded retry; template does not carry envd support annotation: \
                        envd init request failed: Post \"http://192.168.0.17:49983/init\": \
                        dial tcp 192.168.0.17:49983: connect: connection refused",
        })),
    )
        .into_response()
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
    /// **The upstream filter stops filtering** (#1197 H3). A regression, a proxy
    /// that eats the query string, a version that changes `metadata=`
    /// semantics — modelled as one switch, because the adapter's defence against
    /// all three is the same one.
    list_ignores_filters: bool,
    /// **Whether the template can receive `envVars` at all** (#1437).
    ///
    /// CubeSandbox does not put `envVars` in the guest's environment; Cubelet
    /// posts them to `http://<sandbox>:49983/init` and needs a 2xx. `false`
    /// reproduces the measured INFRA-A blocker — the whole create fails and, as
    /// on the real host, **no sandbox is left behind**.
    template_carries_init_receiver: bool,
    /// The fake's virtual clock, in seconds. Only [`FakeCube::advance`] moves
    /// it, so a lease test needs no sleeping.
    now_seconds: i64,
    next_id: u64,
}

#[derive(Debug, Clone, Default)]
struct FakeCube(Arc<Mutex<FakeState>>);

impl FakeCube {
    fn new() -> Self {
        FakeCube(Arc::new(Mutex::new(FakeState {
            deliver_create_response: true,
            // momo's own templates carry `infra/cubesandbox/bootstrap-init/`;
            // the interesting case is the one that does not.
            template_carries_init_receiver: true,
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

    fn end_at_of(&self, id: &str) -> i64 {
        self.lock()
            .sandboxes
            .iter()
            .find(|sandbox| sandbox.id == id)
            .expect("sandbox exists")
            .end_at_seconds
    }

    fn exists(&self, id: &str) -> bool {
        self.lock().sandboxes.iter().any(|sandbox| sandbox.id == id)
    }

    /// Move the virtual clock forward and let `lifecycle.onTimeout` fire
    /// (#1197 H1).
    ///
    /// This is the half of the substrate the old fake did not have at all. A
    /// lease that is never renewed has to actually *end* something, or "momo
    /// forgot to renew" is indistinguishable from "momo renewed correctly" and
    /// no test can tell them apart.
    fn advance(&self, seconds: i64) {
        let mut state = self.lock();
        state.now_seconds += seconds;
        let now = state.now_seconds;
        let mut killed = Vec::new();
        for sandbox in &mut state.sandboxes {
            if sandbox.end_at_seconds > now {
                continue;
            }
            match sandbox.reaper.on_timeout.as_str() {
                "pause" => sandbox.status = InternalStatus::Paused,
                // `kill` is the upstream default and what momo always sends.
                _ => killed.push(sandbox.id.clone()),
            }
        }
        state
            .sandboxes
            .retain(|sandbox| !killed.contains(&sandbox.id));
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

    // `envVars` is a *delivery* (#1437). Cubelet posts it to the guest's
    // `:49983/init` inside this call and needs a 2xx, so a template that cannot
    // receive it fails the whole create — and the real host leaves nothing
    // behind when it does, which is why this returns before any sandbox is
    // recorded.
    let carries_env = body
        .get("envVars")
        .and_then(Value::as_object)
        .is_some_and(|envs| !envs.is_empty());
    if carries_env && !state.template_carries_init_receiver {
        return init_delivery_refused();
    }

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

    // `timeout` is an absolute TTL from *now*, not an idle budget (#1197 H1).
    let end_at_seconds = state.now_seconds + reaper.timeout_seconds;
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
        end_at_seconds,
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
    let filters: Vec<(String, String)> = if state.list_ignores_filters {
        // The regression this models is silent: the query is accepted, the
        // response is a 200, and it simply contains everything.
        Vec::new()
    } else {
        query
            .iter()
            .filter(|(key, _)| key == "metadata")
            .filter_map(|(_, value)| {
                let (key, value) = value.split_once('=')?;
                Some((key.to_string(), value.to_string()))
            })
            .collect()
    };
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
        InternalStatus::Running | InternalStatus::Wedged | InternalStatus::Crashed => {
            sandbox.status = InternalStatus::Paused;
            status_only(204)
        }
        // #1197 B1 — **500, not 409.** The mapping table predicted 409 and this
        // fake used to agree with it; the real host answers
        // `500 {"code":500,"message":"CubeMaster returned error code 130490:
        // sandbox is already paused"}`, which under ADR-0140 D4's `pause 500 ->
        // revert` row would flap an already-paused host back to running forever.
        //
        // One status still covers several conditions — already paused *and*
        // mid-`pausing` — which is why re-asking rather than status-reading is
        // the fix.
        InternalStatus::Paused => already_in_state("sandbox is already paused"),
        InternalStatus::Pausing => already_in_state("sandbox is already pausing"),
    }
}

async fn connect_sandbox(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
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
    // Convergent by design: already-running is a 200 (measured both ways —
    // 84 ms from paused, 3 ms when it was already running).
    //
    // A crashed sandbox is *not* revived by this: the control plane happily
    // reports success because it does not know the VMM is gone, which is the
    // same lie it tells `GET`.
    if sandbox.status != InternalStatus::Crashed {
        sandbox.status = InternalStatus::Running;
    }
    // Resume restarts the absolute TTL, as `connect`'s `timeout` field does
    // upstream.
    if let Some(timeout) = body.get("timeout").and_then(Value::as_i64) {
        let now = state.now_seconds;
        let sandbox = state
            .sandboxes
            .iter_mut()
            .find(|sandbox| sandbox.id == id)
            .expect("found above");
        sandbox.end_at_seconds = now + timeout;
    }
    let detail = state
        .sandboxes
        .iter()
        .find(|sandbox| sandbox.id == id)
        .expect("found above")
        .detail();
    (StatusCode::OK, Json(detail)).into_response()
}

/// `POST /sandboxes/{id}/refreshes` — 204, and the deadline is **assigned**
/// (#1197 H1).
///
/// The measured semantic, and the trap: `endAt = now + duration`, so a renewal
/// carrying less than the full lease moves the deadline *closer*. On the real
/// host a `duration: 180` against a sandbox with ~226 s left pulled its `endAt`
/// back by 106 s. A fake that modelled this as `endAt += duration` would let a
/// delta-sending adapter look correct right up until production.
async fn refresh_sandbox(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("POST".to_string(), format!("/sandboxes/{id}/refreshes")));
    if unauthorized(&headers) {
        return status_only(401);
    }
    let Some(duration) = body.get("duration").and_then(Value::as_i64) else {
        return status_only(400);
    };
    let now = state.now_seconds;
    let Some(sandbox) = state.sandboxes.iter_mut().find(|sandbox| sandbox.id == id) else {
        // **Not a 404.** `pause` and `connect` answer a clean 404 for a sandbox
        // that does not exist; this route answers a 500 carrying CubeMaster code
        // `130404` — the same status that means "already paused" elsewhere,
        // with a different code inside it. Measured while building the live
        // harness at the bottom of this file, after the adapter had already been
        // written with a 404 arm that would never have fired.
        return already_missing(&id);
    };
    sandbox.end_at_seconds = now + duration;
    status_only(204)
}

/// The deprecated path. Present so a test can prove momo never asks for it, and
/// it answers what the real one answers: `500 …130490: sandbox already running`
/// for a sandbox that is already up (#1197 B1) — the exact retry ADR-0140 D4
/// performs, turned into a failure.
async fn resume_sandbox(State(fake): State<FakeCube>, Path(id): Path<String>) -> Response {
    fake.lock()
        .requests
        .push(("POST".to_string(), format!("/sandboxes/{id}/resume")));
    already_in_state("sandbox already running")
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
        .route("/sandboxes/{id}/refreshes", post(refresh_sandbox))
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
            "MOMO_T3_PROVIDER_CUBESANDBOX_RENEWAL_SECONDS".to_string(),
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

/// #1437 — **`envVars` is a delivery, and a template that cannot receive it
/// fails the whole create.**
///
/// This is the INFRA-A blocker (#1434) in test form. CubeSandbox posts the
/// bootstrap material to `http://<sandbox>:49983/init` inside the create call;
/// momo's templates answer it with
/// `infra/cubesandbox/bootstrap-init/momo-bootstrap-init`, and a template
/// without a receiver takes the create down with it.
///
/// What the assertion is really protecting is the second half: **nothing is left
/// behind**. Measured on momo-cube-host — after the 500, the provision key
/// matches no sandbox. If that ever changed, the adapter's reconstruction would
/// be adopting a half-provisioned instance whose workd never got an identity,
/// and the ledger would bill it.
#[tokio::test]
async fn a_template_that_cannot_receive_the_bootstrap_delivery_fails_the_whole_create() {
    let (adapter, fake) = adapter_against_fake().await;
    fake.lock().template_carries_init_receiver = false;

    let failed = adapter.create(&spec(), "prov-1").await;
    assert!(
        matches!(failed, Err(CloudProviderError::UpstreamStatus(500))),
        "a refused bootstrap delivery must surface as an honest upstream failure, got {failed:?}"
    );
    assert_eq!(
        fake.live_count(),
        0,
        "named regression: a create that could not hand the guest its bootstrap material must \
         leave no instance behind — an adopted half-provision is a billed host whose workd can \
         never register"
    );

    // And the recovery is a recovery: give the template its receiver and the
    // same provision key converges on one instance rather than a second one.
    fake.lock().template_carries_init_receiver = true;
    let recovered = adapter.create(&spec(), "prov-1").await.expect("create");
    assert_eq!(fake.live_count(), 1);
    assert_eq!(recovered.instance_id, fake.only_id());
}

/// #1437 — **a `201` is a receipt that the material reached the guest.**
///
/// Nothing in the adapter can verify what happened inside the microVM, so the
/// verification has to be structural: upstream refuses the create unless the
/// in-guest receiver acknowledged the delivery, which makes "created" and
/// "bootstrapped" the same event rather than two hopeful ones. This pins that
/// the four names momo depends on are the four that travel.
#[tokio::test]
async fn a_successful_create_is_a_receipt_that_the_bootstrap_material_was_delivered() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");

    let delivered = fake.env_vars_of(&instance.instance_id);
    assert_eq!(
        delivered.keys().cloned().collect::<Vec<_>>(),
        vec![
            "MOMO_WORKD_DISPLAY_NAME".to_string(),
            "MOMO_WORKD_REGISTRATION_TOKEN".to_string(),
            "MOMO_WORKD_SERVER_URL".to_string(),
            "MOMO_WORKD_WORKSPACE_ID".to_string(),
        ],
        "the receiver in infra/cubesandbox/bootstrap-init/ lands exactly these; a fifth name \
         added here without landing it there is a variable workd never sees"
    );
    assert_eq!(
        delivered
            .get("MOMO_WORKD_REGISTRATION_TOKEN")
            .map(String::as_str),
        Some("one-shot-workd-token")
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

/// #1197 B2 — **red proof #2's target.** A crash is invisible, and only an
/// actively issued destroy reclaims it.
///
/// The measured run, on the real host:
///
/// ```text
/// kill -9 <containerd-shim-cube-rs pid>
/// t≈  0s -> 200 running     t≈160s -> 200 running
/// t≈ 20s -> 200 running     ...
/// t≈140s -> 200 running     t≈280s -> 200 running
/// >>> 15 probes over 300 s; 404 (self-convergence) count = 0
/// >>> ledger-issued DELETE -> 204 ; probe after -> 404
/// ```
///
/// Two things follow and both are asserted below.
///
/// 1. **`provider_missing` is unreachable in the crash case.** That verdict is
///    reached from a 404, and the 404 never comes. Any design that waits for the
///    substrate to admit the death waits forever, and the sandbox bills the whole
///    time. This is why the recovery has to be issued from momo's own evidence
///    (the workd heartbeat) rather than negotiated with the provider —
///    `momo_t3::sweep` states that rule and
///    `d2_t3_8_cubesandbox_running_is_not_liveness` runs it against the database.
/// 2. **The destroy works fine.** The instance is reclaimable the whole time;
///    nobody was asking. So the fix is not a new state or a new provider
///    capability, it is issuing the destroy momo already knows how to issue.
///
/// **Red when reverted:** make the fake's crashed sandbox self-convert to 404
/// (or answer `Absent`) and the "never converges" assertion below fails — which
/// is the fake going back to modelling a substrate that does not exist.
#[tokio::test]
async fn a_crashed_sandbox_never_self_converges_and_only_a_destroy_reclaims_it() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    let id = instance.instance_id.clone();

    // The VMM is SIGKILLed. Nothing inside is running any more.
    fake.set_status(&id, InternalStatus::Crashed);

    // Five minutes of polling, at the spike's cadence, on the fake's clock.
    for step in 0..15 {
        fake.advance(20);
        assert_eq!(
            adapter.probe(&instance).await.expect("probe"),
            CloudInstancePresence::Present,
            "named regression: at t≈{}s the substrate still says `running`, and `probe` must \
             keep reporting exactly what it can know — presence. It must never manufacture the \
             `Absent` the control plane is refusing to give, because `Absent` settles a paid \
             session (ADR-0142 D3.1)",
            (step + 1) * 20
        );
    }
    assert!(
        fake.exists(&id),
        "named regression: 300 s after the kill the substrate has not reclaimed it and never \
         will. A design that waits for `provider_missing` waits forever while the workspace pays"
    );

    // …and the whole time, the instance was destroyable. Nobody was asking.
    adapter
        .destroy(&instance, "op-1")
        .await
        .expect("the destroy momo issues on its own evidence");
    assert_eq!(
        adapter.probe(&instance).await.expect("probe"),
        CloudInstancePresence::Absent,
        "the crash never needed a new mechanism — it needed the destroy to be issued"
    );
    assert_eq!(fake.live_count(), 0);
}

// ---------------------------------------------------------------------------
// the lease — #1197 H1
// ---------------------------------------------------------------------------

/// #1197 H1 — **red proof #3's target.** An unrenewed lease kills a live
/// sandbox; a renewed one survives indefinitely.
///
/// `timeout` is an absolute TTL from creation. The spike tried five ways to
/// reset it — detail GET, list GET, SDK exec, a 60 s CPU burn inside the
/// sandbox, outbound HTTPS from the sandbox — and moved `endAt` by 0.0 s every
/// time. So doing real work buys a session nothing, and momo has to say so
/// explicitly.
///
/// **Red when reverted:** delete `renew_lease`'s call (or stop the renewal loop
/// calling it) and the second half of this test finds the sandbox gone.
#[tokio::test]
async fn a_lease_that_is_not_renewed_kills_a_live_sandbox() {
    let (adapter, fake) = adapter_against_fake().await;
    let lease = adapter.lease_seconds();

    // Sandbox A is worked hard and never renewed.
    let abandoned = adapter.create(&spec(), "prov-1").await.expect("create");
    // Sandbox B is renewed on schedule and otherwise ignored.
    let renewed = adapter.create(&spec(), "prov-2").await.expect("create");

    // Three quarters of a lease of "activity" on A, and nothing but renewals
    // on B.
    for _ in 0..3 {
        fake.advance(lease / 4);
        // Everything the spike proved does not reset the clock.
        adapter.probe(&abandoned).await.expect("probe");
        adapter.probe(&renewed).await.expect("probe");
        adapter
            .renew_lease(&renewed)
            .await
            .expect("the renewal the loop issues");
    }
    assert!(fake.exists(&abandoned.instance_id), "not dead yet");

    // The fourth quarter takes A past its TTL.
    fake.advance(lease / 4 + 1);
    assert!(
        !fake.exists(&abandoned.instance_id),
        "named regression: a sandbox that has been probed continuously is still deleted at its \
         absolute TTL. Activity buys nothing — only `/refreshes` does (spike §4)"
    );
    assert_eq!(
        adapter.probe(&abandoned).await.expect("probe"),
        CloudInstancePresence::Absent
    );
    assert!(
        fake.exists(&renewed.instance_id),
        "named regression: the renewed sandbox must outlive its original TTL. If it does not, \
         momo's keepalive is not reaching the substrate and every live session dies on the \
         substrate's clock"
    );
}

/// #1197 H1 — the renewal carries the **whole lease**, never a remainder.
///
/// `/refreshes` assigns `endAt = now + duration`; it does not extend. Measured:
/// a `duration: 180` sent to a sandbox with ~226 s left moved its `endAt`
/// *backwards* by 106 s. So an adapter that thought in deltas — "top up by 60 s"
/// — would be shortening the very lease it meant to protect, and the smaller the
/// top-up the sooner the sandbox dies.
///
/// **Red when reverted:** send anything smaller than `self.lease_seconds` in
/// `renew_lease` and the deadline below moves backwards instead of forwards.
#[tokio::test]
async fn a_renewal_assigns_the_full_lease_and_can_never_shorten_one() {
    let (adapter, fake) = adapter_against_fake().await;
    let lease = adapter.lease_seconds();
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    let id = instance.instance_id.clone();

    assert_eq!(
        fake.end_at_of(&id),
        lease,
        "the create set an absolute deadline one lease from now"
    );

    // Renew immediately, while almost the whole lease is still unspent. A delta
    // would push the deadline out; an assignment of anything short of the full
    // lease would pull it in.
    fake.advance(1);
    adapter.renew_lease(&instance).await.expect("renew");
    assert_eq!(
        fake.end_at_of(&id),
        1 + lease,
        "named regression: `/refreshes` assigns `now + duration`. Renewing with less than the \
         full lease moves the deadline closer — the spike watched a 180 s refresh pull a \
         sandbox's `endAt` back by 106 s — so the renewal must always carry the whole lease"
    );

    // …and it never goes backwards, however often it is called.
    let mut previous = fake.end_at_of(&id);
    for _ in 0..4 {
        fake.advance(10);
        adapter.renew_lease(&instance).await.expect("renew");
        let current = fake.end_at_of(&id);
        assert!(
            current > previous,
            "a renewal moved the deadline backwards: {previous} -> {current}"
        );
        previous = current;
    }

    // A renewal for an instance that is already gone is a fact, not a retry —
    // and reaching that fact needs the re-probe, because this route reports a
    // missing sandbox as `500 …130404` rather than the 404 every other route
    // uses. The live harness caught the adapter believing otherwise.
    adapter.destroy(&instance, "op-1").await.expect("destroy");
    assert!(
        matches!(
            adapter.renew_lease(&instance).await,
            Err(CloudProviderError::InstanceMissing)
        ),
        "named regression: `/refreshes` answers 500 (code 130404) for a sandbox that no longer \
         exists. A 404-only arm never fires, so the keepalive reports a vanished instance as a \
         generic upstream failure and goes on renewing a lease for nothing"
    );
}

/// #1197 H1 — a paused sandbox's lease ticks exactly like a running one's.
///
/// This is the trap the lease shortening created and the reason
/// `momo_t3::lease::RENEWABLE_STATES` includes the parked states. A paused
/// sandbox's workd is frozen inside a memory snapshot, so it emits no heartbeat;
/// a renewal rule keyed only on "the heartbeat is fresh" would therefore stop
/// renewing every pause, and every pause would die at one lease — taking
/// ADR-0141's 24 h paused→hibernate window with it.
#[tokio::test]
async fn a_paused_sandbox_still_needs_its_lease_renewed() {
    let (adapter, fake) = adapter_against_fake().await;
    let lease = adapter.lease_seconds();
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");
    adapter.pause(&instance, "op-1").await.expect("pause");

    for _ in 0..6 {
        fake.advance(lease / 2);
        adapter.renew_lease(&instance).await.expect("renew");
    }
    assert!(
        fake.exists(&instance.instance_id),
        "named regression: a pause held for three leases must survive. Withholding renewal from \
         parked hosts deletes every paused session at one lease"
    );
    adapter.resume(&instance, "op-2").await.expect("resume");
    assert_eq!(
        adapter.probe(&instance).await.expect("probe"),
        CloudInstancePresence::Present
    );
}

// ---------------------------------------------------------------------------
// metadata — #1197 H3
// ---------------------------------------------------------------------------

/// #1197 H3 — momo reads its own keys and no others.
///
/// The substrate returns 12 metadata keys for a sandbox created with 2, and the
/// extra ten are its internal bookkeeping — snapshot ids, NUMA node, envd
/// version, and an entry whose key and value are both `X-Caller`. They are not
/// momo's schema, they change between releases, and none of them means anything
/// to the ledger.
#[tokio::test]
async fn the_adapter_reads_only_the_metadata_it_wrote() {
    let (adapter, fake) = adapter_against_fake().await;
    let instance = adapter.create(&spec(), "prov-1").await.expect("create");

    // What the substrate actually returns.
    let detail = fake
        .lock()
        .sandboxes
        .iter()
        .find(|sandbox| sandbox.id == instance.instance_id)
        .expect("sandbox exists")
        .detail();
    let raw = detail["metadata"].as_object().expect("an object");
    assert!(
        raw.len() >= 12 && raw.contains_key("X-Caller") && raw.contains_key("cube.numa_node"),
        "precondition: the fake must return the polluted dict the real host returns, or this \
         test proves nothing. Saw {} keys",
        raw.len()
    );

    // What momo sees.
    let ours = momo_t3::provider::momo_metadata(&detail);
    assert_eq!(
        ours.len(),
        2,
        "named regression: momo must read only `momo_*`. Storing the whole dict would put \
         another system's bookkeeping — including whatever it adds next release — into momo's \
         ledger under momo's schema. Saw {ours:?}"
    );
    assert_eq!(
        ours.get(METADATA_PROVISION_KEY).map(String::as_str),
        Some("prov-1")
    );
    assert!(ours.contains_key(METADATA_WORKSPACE_KEY));
    assert!(ours.keys().all(|key| key.starts_with("momo_")));
}

/// #1197 H3 — **the reason the filter is re-checked locally.**
///
/// The `metadata=` query is a genuine server-side AND on exact values and it
/// works today. The question this test asks is what happens the day it does not:
/// an upstream regression, a proxy that drops the query string, a version that
/// re-spells the filter. The response is still a 200; it just contains
/// everything on the host.
///
/// Without the local re-check, `find_stamped_instance` would take that list,
/// sort it, and adopt the lexicographically smallest id — **another workspace's
/// live sandbox** — and momo would address it as its own from then on. The
/// failure is not a wasted create; it is one tenant's session handed to another.
///
/// **Red when reverted:** drop the `momo_metadata(...) == provision_key` filter
/// and this test adopts the stranger.
#[tokio::test]
async fn a_broken_upstream_filter_cannot_make_a_replay_adopt_a_strangers_sandbox() {
    let (adapter, fake) = adapter_against_fake().await;

    // Somebody else's sandbox, created first so it sorts first.
    let stranger = adapter
        .create(&spec(), "prov-someone-else")
        .await
        .expect("create");

    // The filter stops filtering. Every query now returns the whole host.
    fake.lock().list_ignores_filters = true;

    let mine = adapter
        .create(&spec(), "prov-mine")
        .await
        .expect("create mine");
    assert_ne!(
        mine.instance_id, stranger.instance_id,
        "named regression: with the server-side filter broken, a lookup that trusted it would \
         return every sandbox on the host and this create would adopt the first one — a live \
         session belonging to another workspace, addressed as ours forever after"
    );
    assert_eq!(
        fake.create_count(),
        2,
        "the broken filter degrades to an ordinary miss, so the create proceeds normally"
    );

    // And the replay of *my* key still converges on my sandbox, not the
    // stranger's, because the stamp is verified locally.
    let replay = adapter
        .create(&spec(), "prov-mine")
        .await
        .expect("replay mine");
    assert_eq!(
        replay.instance_id, mine.instance_id,
        "the local stamp check is what makes the reconstruction correct rather than lucky"
    );
    assert_eq!(fake.create_count(), 2, "no third instance was billed");
}

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

/// 매핑표 A9, as #1197 B1 rewrites it — **red proof #1's target.**
///
/// A refusal is a question, not an answer, and the refusal is a `500`.
///
/// The measured artefact:
/// ```text
/// POST /sandboxes/{id}/pause  (already paused)
///   -> 500 {"code":500,"message":"CubeMaster returned error code 130490: sandbox is already paused"}
/// ```
///
/// Under the shape this file used to model — 409, re-probed; everything else
/// taken at face value — ADR-0140 D4's `pause 500 → revert` row would move an
/// already-paused host back to `running`, bill it, pause it again next tick, and
/// repeat. The flap is powered by a *success* the substrate spells as a failure.
///
/// **Red when reverted:** narrow `refusal_needs_reprobe` back to `409` and the
/// second `pause` below returns `UpstreamStatus(500)` instead of `Ok`.
///
/// This is also where this substrate and `mock-a` honestly disagree, and the
/// disagreement is asserted rather than hidden. `mock-a` answers
/// `InstancePaused` for a second pause because it refuses to claim work it did
/// not do — a statement about the *call*. Here the adapter re-asks and finds the
/// sandbox paused, so the durable intent ("this host must be paused") is
/// satisfied — a statement about the *world*. Folding the refusal straight to
/// success without re-asking would be the opposite bug: upstream returns the
/// same 500 shape for a sandbox that is still *pausing*, and ADR-0140 D4 would
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

    // Now the same 500 for the other reason: mid-transition, still billable.
    fake.set_status(&id, InternalStatus::Pausing);
    let verdict = adapter
        .pause(&instance, "op-3")
        .await
        .expect_err("a pausing sandbox is not a paused one");
    assert!(
        matches!(verdict, CloudProviderError::UpstreamStatus(500)),
        "named regression: one refusal covers several conditions, and the re-probe is what tells \
         them apart. Folding the 500 itself to success would report a not-yet-paused instance as \
         paused and stop billing a machine still burning the host. Saw {verdict:?}"
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
        "named regression: `/resume` is deprecated upstream and answers \
         `500 …130490: sandbox already running` for an already-running sandbox — the exact retry \
         ADR-0140 D4 performs. Found: {paths:?}"
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
    assert_eq!(adapter.lease_seconds(), reaper.timeout_seconds);
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
    env.remove("MOMO_T3_PROVIDER_CUBESANDBOX_RENEWAL_SECONDS");
    let adapter = CubeSandboxProviderAdapter::from_env(&env).expect("configured");
    assert_eq!(
        adapter.capabilities().max_concurrent_instances,
        Some(momo_t3::provider::CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES)
    );
    assert_eq!(
        adapter.lease_seconds(),
        CubeSandboxTuning::default().lease_seconds()
    );
    assert_eq!(
        adapter.capabilities().instance_lease_seconds,
        Some(CubeSandboxTuning::default().lease_seconds()),
        "named regression: the declared lease and the `timeout` on the wire must be one number. \
         If they could drift, the renewal loop would pace itself against a deadline the \
         substrate does not hold"
    );
}

// ---------------------------------------------------------------------------
// the live host — the harness that found all of this (#1197)
// ---------------------------------------------------------------------------

/// Every repair in #1197 and #1437, driven by the shipping adapter against a
/// **real CubeSandbox host**.
///
/// The fake above is written from the measurements this test makes, so running
/// it is how the fake is kept honest. That loop is the entire point of the
/// ticket: the previous fake modelled 409s, a self-healing crash, an idle clock
/// and a clean metadata dict — none of which exist — and the suite was green
/// against a substrate that does not exist.
///
/// Off by default because it needs a host. To run:
///
/// ```text
/// ssh -N -L 13000:127.0.0.1:3000 root@<cube-host> &
/// MOMO_T3_CUBESANDBOX_LIVE_BASE_URL=http://127.0.0.1:13000 \
/// MOMO_T3_CUBESANDBOX_LIVE_TEMPLATE=<tpl-id carrying momo-bootstrap-init> \
/// MOMO_T3_CUBESANDBOX_LIVE_TEMPLATE_WITHOUT_INIT=<tpl-id without it> \
///   cargo test -p momo-t3 --test cubesandbox_conformance -- --ignored live_host
/// ```
///
/// `…_TEMPLATE` must carry `infra/cubesandbox/bootstrap-init/`, because the
/// adapter always sends `envVars` and the substrate refuses a create it cannot
/// deliver them through (#1437). `…_TEMPLATE_WITHOUT_INIT` is optional and turns
/// on the arm that proves the refusal is honest; the run is still meaningful
/// without it.
///
/// The loopback bind is the ADR-0157 D5 hardening, so a tunnel is the intended
/// access path rather than a workaround. Every sandbox it makes is destroyed
/// before it returns, including on the assertion paths that matter.
#[tokio::test]
#[ignore = "needs MOMO_T3_CUBESANDBOX_LIVE_BASE_URL pointed at a real CubeSandbox host"]
async fn live_host_agrees_with_the_fake_on_every_repair() {
    // Skipped rather than failed when no host is configured: `--ignored` is run
    // wholesale by the gate, and a test that needs a machine nobody has stood up
    // must not turn that into a red lane. It says so out loud, because a silent
    // skip is indistinguishable from a pass.
    let (Ok(base_url), Ok(template)) = (
        std::env::var("MOMO_T3_CUBESANDBOX_LIVE_BASE_URL"),
        std::env::var("MOMO_T3_CUBESANDBOX_LIVE_TEMPLATE"),
    ) else {
        println!(
            "SKIP live_host: set MOMO_T3_CUBESANDBOX_LIVE_BASE_URL and \
             MOMO_T3_CUBESANDBOX_LIVE_TEMPLATE to run this against a real host \
             (see the doc comment for the tunnel command)"
        );
        return;
    };

    let env = BTreeMap::from([
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL".to_string(),
            base_url,
        ),
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY".to_string(),
            std::env::var("MOMO_T3_CUBESANDBOX_LIVE_API_KEY")
                .unwrap_or_else(|_| "test-not-a-secret".to_string()),
        ),
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_IMAGE_REF".to_string(),
            template,
        ),
        // 60 s renewal → a 240 s lease, long enough to survive this test and
        // short enough that a leaked sandbox self-destructs in four minutes.
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_RENEWAL_SECONDS".to_string(),
            "60".to_string(),
        ),
    ]);
    let adapter = CubeSandboxProviderAdapter::from_env(&env).expect("configured");
    let key = format!("prov-live-{}", Uuid::new_v4());

    // --- #1437: the bootstrap delivery, on both sides of the contract ------
    //
    // A create carrying `envVars` only succeeds if something inside the guest
    // answered `POST :49983/init`. So this create *is* the assertion that
    // `momo-bootstrap-init` received the material — there is no separate
    // "did it arrive?" question to ask, and no way to be told yes falsely.
    let instance = adapter.create(&spec(), &key).await.expect(
        "named regression: the adapter always sends envVars, and CubeSandbox delivers them to \
         :49983/init inside the create call. A 500 here means the configured template does not \
         carry infra/cubesandbox/bootstrap-init/ — that is #1434's blocker, not a flake",
    );
    println!("live: created {}", instance.instance_id);

    if let Ok(bare_template) = std::env::var("MOMO_T3_CUBESANDBOX_LIVE_TEMPLATE_WITHOUT_INIT") {
        let mut bare_env = env.clone();
        bare_env.insert(
            "MOMO_T3_PROVIDER_CUBESANDBOX_IMAGE_REF".to_string(),
            bare_template,
        );
        let bare = CubeSandboxProviderAdapter::from_env(&bare_env).expect("configured");
        let refused = bare
            .create(&spec(), &format!("prov-live-bare-{}", Uuid::new_v4()))
            .await;
        assert!(
            matches!(refused, Err(CloudProviderError::UpstreamStatus(500))),
            "a template with no /init receiver must fail the whole create rather than boot a \
             workd with no identity, got {refused:?}"
        );
    }

    // --- 멱등: the replay finds the same sandbox on the real filter ---------
    let replay = adapter.create(&spec(), &key).await.expect("live replay");
    assert_eq!(
        replay.instance_id, instance.instance_id,
        "the metadata reconstruction must converge on the real substrate too"
    );

    // --- H1: nothing but /refreshes moves the deadline ---------------------
    adapter
        .renew_lease(&instance)
        .await
        .expect("live /refreshes must answer 2xx");

    // --- B1: a second pause is a 500 that means success --------------------
    adapter.pause(&instance, "op-1").await.expect("live pause");
    adapter.pause(&instance, "op-2").await.expect(
        "named regression: the real host answers 500 (code 130490) for an already-paused \
         sandbox. If this errors, the refusal is being read as a failure and ADR-0140 D4 will \
         flap the ledger between paused and running",
    );

    // --- B1: /connect is convergent both ways ------------------------------
    adapter
        .resume(&instance, "op-3")
        .await
        .expect("live resume");
    adapter
        .resume(&instance, "op-4")
        .await
        .expect("an already-running sandbox resumes convergently");

    // --- probe / destroy ---------------------------------------------------
    assert_eq!(
        adapter.probe(&instance).await.expect("live probe"),
        CloudInstancePresence::Present
    );
    adapter
        .destroy(&instance, "op-5")
        .await
        .expect("live destroy");
    adapter
        .destroy(&instance, "op-6")
        .await
        .expect("destroy is idempotent on the real host (404 -> success)");
    assert_eq!(
        adapter.probe(&instance).await.expect("live probe"),
        CloudInstancePresence::Absent
    );
    assert!(matches!(
        adapter.renew_lease(&instance).await,
        Err(CloudProviderError::InstanceMissing)
    ));
}
