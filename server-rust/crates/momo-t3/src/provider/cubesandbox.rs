//! The `cubesandbox` adapter — ADR-0156 D2's implementation of the ADR-0142 D2
//! contract, spoken over CubeSandbox's E2B-dialect REST surface.
//!
//! ## What was already there, and what had to be built
//!
//! The retired `E2BProvisioner.swift` (git `716ea9e3^`) turns out to be a
//! near-drop-in: paths 4/4, status codes 4/4 and the `X-API-Key` header 1/1
//! match what CubeSandbox serves. Four things are genuinely new, and each is a
//! hole the upstream leaves that momo has to fill *structurally*:
//!
//! 1. **`probe`** — ADR-0142 D2 added it after the Swift client was written.
//! 2. **Idempotency by reconstruction** — CubeSandbox has no idempotency key at
//!    all (§멱등, below).
//! 3. **An explicit lifecycle policy** — leaving `timeout`/`lifecycle` unset
//!    hands the reaper to the cluster (§수명주기, below).
//! 4. **409/503/408 handling** — statuses the E2B dialect did not have.
//!
//! ## 멱등 — the create key CubeSandbox does not have
//!
//! `NewSandbox` carries no idempotency field and CubeAPI mints its own
//! `request_id`, so the ADR-0142 D2 obligation ("같은 key 재호출은 같은
//! 인스턴스") cannot be delegated upstream. Without it, a create whose *response*
//! is lost bills a workspace for an orphan nobody can name.
//!
//! So momo reconstructs it: every create stamps the key into `metadata`
//! ([`METADATA_PROVISION_KEY`]) and every create *first* asks
//! `GET /sandboxes?metadata=momo_provision_id=<key>`. A replay finds the earlier
//! sandbox and returns it rather than making a second billable one.
//!
//! **The residual race is closed outside this file, and that coupling is load
//! bearing.** Two creates that interleave between the lookup and the POST would
//! both miss; nothing in an HTTP round trip can prevent that. What prevents it is
//! ADR-0140 D2: every T3 lifecycle transaction takes
//! `pg_advisory_xact_lock('momo.t3', cloud_host_id)` as its first statement, so
//! there is only ever one in-flight operation per host. Delete that lock and this
//! adapter's idempotency degrades to best-effort — the reconstruction is the
//! *recovery* half, the advisory is the *exclusion* half, and neither is
//! sufficient alone.
//!
//! ## probe — why `state` never reaches a presence decision
//!
//! CubeAPI's `sandbox_state_from_status` folds every non-paused internal status
//! into `running` (`CubeAPI/src/services/sandboxes.rs:917-923`, the `_ =>
//! running` arm). A sandbox that is wedged, degraded or in a state this version
//! has no name for reports `running` with a 200. Reading that as "the machine is
//! healthy" is exactly the silent failure ADR-0142 D3.1 bans.
//!
//! The defence is mechanical rather than documentary:
//! [`presence_for_status`] **takes no state argument**. Presence is decided from
//! the HTTP status alone — 200 present, 404 absent, everything else unknown —
//! and the missing parameter is the contract. Liveness is not this adapter's to
//! report at all; the workd heartbeat is its 정본 (ADR-0156 D6②, ADR-0125
//! fabric), and the host-loss sweep reads that heartbeat without consulting any
//! provider.
//!
//! `state` is parsed in exactly one place — [`pause_verdict_from_state`] — where
//! the single question asked is *"is it paused?"*, the one branch CubeAPI
//! reports faithfully.
//!
//! ## 수명주기 — a lease, not an idle clock (#1197 H1)
//!
//! `lifecycle.onTimeout` defaults to `kill` and `timeout` defaults to the
//! cluster's `default_timeout_insec`. Sending neither therefore does not mean
//! "no reaper": it means *a reaper momo did not choose*, deleting paid instances
//! behind the ledger's back. ADR-0156 D6② settles that half — momo always sends
//! both.
//!
//! What D4-② changed is the **meaning** of the number momo sends. `timeout` was
//! documented as an idle clock; it is an **absolute TTL from creation**, and the
//! spike could not move it with a detail GET, a list GET, an SDK exec, a 60 s
//! in-sandbox CPU burn, or outbound HTTPS from the sandbox — five stimuli, zero
//! milliseconds of movement (`research/2026-08-09-cubesandbox-d42-spike.md` §4).
//!
//! That has one good consequence and one bad one, and the bad one is a new
//! obligation:
//!
//! * **good** — a reconciler probe cannot extend a zombie's life, so momo may
//!   poll as often as it likes. #1179's 이탈 1 is answered.
//! * **bad** — a healthy session doing real work is deleted at its TTL anyway,
//!   because activity buys nothing.
//!
//! So the adapter renews: [`CubeSandboxProviderAdapter::renew_lease`] issues
//! `POST /sandboxes/{id}/refreshes`, and the renewal is driven by
//! `momo_t3::lease`, which withholds it from hosts whose workd heartbeat has
//! expired. That withholding is the *point* — momo dying stops renewals, so the
//! substrate reaps behind it and the zombie bill is structurally bounded by one
//! lease.
//!
//! ## What this adapter refuses to touch
//!
//! Snapshots, rollback, volumes and template CRUD exist upstream and are not
//! consumed (ADR-0142 D3.2, ADR-0156 D5): continuity's original is git plus the
//! momo ledger, and a snapshot is an optimisation momo must never depend on.
//! `secure` is parsed and ignored upstream, so sending it would attach meaning to
//! a no-op. `/timeout` sets the same deadline `/refreshes` does and would be a
//! second spelling of one operation. Each absence is asserted by
//! [`tests::the_adapter_consumes_only_the_lifecycle_surface`], not left to
//! review.

use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use momo_provider::{
    validated_cloud_instance_id, CloudInstancePresence, CloudInstanceRef, CloudInstanceSpec,
    CloudProviderAdapter, CloudProviderCapabilities, CloudProviderError,
};
use reqwest::{Method, StatusCode, Url};
use serde_json::{json, Map, Value};

use crate::provider::registry::{
    capabilities_for, cubesandbox_max_concurrent_instances, environment_namespace, load_endpoints,
    T3ProviderEndpoint, CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES, CUBESANDBOX_PROVIDER_ID,
};

/// The metadata key momo stamps the create idempotency key into, and the key the
/// reconstruction lookup filters on. The two must be the same string or the
/// replay finds nothing — hence one constant, used in both places.
pub const METADATA_PROVISION_KEY: &str = "momo_provision_id";

/// Tenant provenance, so an operator reading CubeSandbox's own console can tell
/// whose sandbox is whose. Never filtered on.
pub const METADATA_WORKSPACE_KEY: &str = "momo_workspace_id";

/// The prefix that separates momo's metadata from the substrate's own
/// (#1197 H3). Both keys above start with it, and [`momo_metadata`] is the only
/// way the rest of the adapter sees a metadata map.
pub const METADATA_KEY_PREFIX: &str = "momo_";

/// ADR-0156 D6②'s "×4", re-read on the D4-② measurement (#1197 H1).
///
/// The multiple survives; what it multiplies changed. It used to mean "four
/// ledger sweeps", on the belief that `timeout` was an idle clock momo could not
/// reset. `timeout` is an absolute TTL and momo resets it explicitly, so the
/// unit is now the **renewal period**: a lease is four renewals long, and a live
/// instance therefore survives four consecutive renewal failures before the
/// substrate reaps it.
pub const LEASE_RENEWALS_PER_LEASE: i64 = 4;

/// `lifecycle.onTimeout`. Same word as the upstream default, sent on purpose:
/// what momo is choosing is not the *verb* but the *clock* it runs on.
pub const ON_TIMEOUT_KILL: &str = "kill";

/// How often momo renews a lease, when the operator sets nothing.
///
/// **This is now exactly the 90 s host-offline grace, and it used to be
/// forbidden to be.** The retired constant was 24 h with a comment explaining
/// that deriving the net from the 90 s grace "would kill live sandboxes at six
/// minutes" — true, and the reason was that `timeout` was believed to be an idle
/// clock momo's outbound heartbeat could not reset, so the net had to outlast
/// every legitimate quiet period (ADR-0141's 24 h paused→hibernate window),
/// giving a 96 h zombie ceiling.
///
/// D4-② found `timeout` is an absolute TTL that *nothing* resets except
/// `/refreshes`. Once momo renews explicitly the whole argument inverts: quiet
/// periods stop mattering (a paused host is renewed just like a running one),
/// and the only number left to choose is how long a zombie may outlive momo.
/// Six minutes is a good answer to that question, and it is the same 90 s × 4
/// the old comment named as the danger.
///
/// Tying it to `MOMO_HOST_OFFLINE_GRACE_S` is deliberate: an instance stops
/// being renewed at the moment momo declares its host lost, so the substrate's
/// reclaim lands about a lease after momo's own verdict rather than at some
/// unrelated hour.
///
/// The operator overrides through
/// `MOMO_T3_PROVIDER_CUBESANDBOX_RENEWAL_SECONDS`.
pub const DEFAULT_RENEWAL_SECONDS: i64 = 90;

/// Request timeout for one CubeAPI call.
///
/// `DELETE` is synchronous upstream — a paused sandbox is internally restored
/// (documented at up to ~5 s) before it is destroyed — so a tight timeout would
/// manufacture `RequestFailed` for destroys that were about to succeed, and
/// ADR-0140 D4 would retry them forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Host-dependent settings the registry cannot know (ADR-0156 D6, ADR-0142 D2
/// 증보).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CubeSandboxTuning {
    /// How many paid sandboxes this host can hold at once.
    pub max_concurrent_instances: i64,
    /// How often momo renews a lease. The lease is a multiple of this.
    pub renewal_seconds: i64,
}

impl Default for CubeSandboxTuning {
    fn default() -> Self {
        CubeSandboxTuning {
            max_concurrent_instances: CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES,
            renewal_seconds: DEFAULT_RENEWAL_SECONDS,
        }
    }
}

impl CubeSandboxTuning {
    /// Both knobs from the adapter's own env namespace. Anything absent,
    /// unparseable or non-positive falls back to the conservative default rather
    /// than opening the host up or shortening the lease.
    pub fn from_env(env: &BTreeMap<String, String>) -> Self {
        let namespace = environment_namespace(CUBESANDBOX_PROVIDER_ID);
        let renewal_seconds = env
            .get(&format!("{namespace}_RENEWAL_SECONDS"))
            .and_then(|value| value.trim().parse::<i64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_RENEWAL_SECONDS);
        CubeSandboxTuning {
            max_concurrent_instances: cubesandbox_max_concurrent_instances(env),
            renewal_seconds,
        }
    }

    /// The `timeout` (seconds) every create carries, and the duration every
    /// `/refreshes` renews to — ADR-0156 D6② as #1197 H1 re-reads it.
    pub fn lease_seconds(&self) -> i64 {
        self.renewal_seconds
            .saturating_mul(LEASE_RENEWALS_PER_LEASE)
    }
}

/// What a re-probe after a refused transition says about the sandbox
/// (매핑표 §2.6, widened by #1197 B1).
///
/// Two values because `paused` is the only branch CubeAPI reports faithfully,
/// and both the pause intent and the resume intent are decidable from it: a
/// pause wants [`PauseVerdict::AlreadyPaused`], a resume wants
/// [`PauseVerdict::NotPaused`]. Neither reads `running` as liveness — they read
/// "not paused", which is the honest complement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PauseVerdict {
    /// The sandbox is paused. A pause intent holds, whoever satisfied it.
    AlreadyPaused,
    /// Not paused: running, mid-transition, or in a state this version has no
    /// name for. A resume intent holds; a pause intent does not.
    NotPaused,
}

/// The only place `state` is read, and the only question it is asked.
///
/// `paused` is the single branch CubeAPI does not fold — `Paused` maps to
/// `paused` and everything else collapses into `running`/`pausing`. So this
/// answers "is it paused?" and nothing else. It is never used to decide presence
/// (see [`presence_for_status`]) and never used to decide liveness.
fn pause_verdict_from_state(state: Option<&str>) -> PauseVerdict {
    match state {
        Some("paused") => PauseVerdict::AlreadyPaused,
        _ => PauseVerdict::NotPaused,
    }
}

/// Presence from the HTTP status **alone** (매핑표 §2.3).
///
/// The absent `state` parameter is the point. CubeAPI reports `running` for
/// every internal status that is not `Paused`, so a body that says `running`
/// carries no information about whether the machine works — and a presence
/// answer derived from it would let a wedged sandbox look healthy, or (worse,
/// inverted) let an unreachable control plane look empty.
///
/// * `200` → present. The control plane has a record of this instance.
/// * `404` → absent. The only way CubeSandbox expresses a dead sandbox; there is
///   no `terminated` state.
/// * anything else, including every 5xx → unknown. Never `Absent`: ADR-0142
///   D3.1, and ADR-0140 D4 settles a paid session on `Absent`.
///
/// A transport failure never reaches here at all — it has no status — and is
/// mapped to `Unknown` at the call site.
pub fn presence_for_status(status: u16) -> CloudInstancePresence {
    match status {
        200 => CloudInstancePresence::Present,
        404 => CloudInstancePresence::Absent,
        _ => CloudInstancePresence::Unknown,
    }
}

/// Whether a refused transition must be re-judged by asking the substrate what
/// is actually true, rather than read off its status code (#1197 B1).
///
/// **The answer is: every refusal except a 404.** The mapping table predicted
/// `409` for "the sandbox is already in the state you asked for" and gave that
/// one code a re-probe. D4-② found the substrate does not use 409 at all: a
/// second `pause` answers
///
/// ```text
/// 500 {"code":500,"message":"CubeMaster returned error code 130490: sandbox is already paused"}
/// ```
///
/// and `/resume` on a running sandbox answers the same 500 with
/// `sandbox already running`. Under the old shape ADR-0140 D4's table converged
/// `pause 500 → revert`, so the ledger would put an already-paused host back to
/// `running`, bill it, and pause it again next tick — a **flap**, powered by a
/// success the substrate spelled as a failure.
///
/// The two available fixes were to parse `130490` out of the message, or to stop
/// giving refusal codes any meaning at all. This is the second: the status says
/// only *"the transition did not happen on this call"*, and what is true is a
/// separate question answered by a separate `GET`. It costs one 2–6 ms round trip
/// on a path that was already failing, it cannot rot when upstream renumbers its
/// error codes, and it makes the contract surface no wider than it already was.
///
/// 404 keeps its own arm because absence is the one thing a status *can* settle
/// (there is no `terminated` state upstream; 404 is how a dead sandbox is
/// expressed) and re-probing it would only ask the same question twice.
pub fn refusal_needs_reprobe(status: u16) -> bool {
    !(200..300).contains(&status) && status != 404
}

/// Our metadata keys, and nothing the substrate mixed in (#1197 H3).
///
/// The `metadata` a sandbox comes back with is **not the map momo stamped**.
/// D4-② measured 12 keys on a sandbox created with 2: alongside
/// `momo_provision_id` and `momo_workspace_id` the response carries
/// `cube.master.runtime.snapshot.id`, `cube.master.appsnapshot.template.id`,
/// `cube.master.instance.type`, `cube.numa_node`, `cube.product`,
/// `cube.master.components.envd.version`, three more `cube.*` timestamps, and an
/// entry whose key and value are both the literal string `X-Caller`.
///
/// Two rules follow, and this function is how both are enforced rather than
/// remembered:
///
/// * **momo stores none of it.** Persisting the whole dict would put another
///   system's internal bookkeeping — including whatever it adds next release —
///   into momo's ledger under momo's schema.
/// * **momo reads only what momo wrote.** Which matters far more than it looks:
///   see [`CubeSandboxProviderAdapter::find_stamped_instance`], where trusting
///   the substrate's server-side filter instead of re-checking our own key is
///   the difference between a replay adopting *our* sandbox and a replay
///   adopting *somebody else's*.
pub fn momo_metadata(value: &Value) -> BTreeMap<String, String> {
    value
        .get("metadata")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter(|(key, _)| key.starts_with(METADATA_KEY_PREFIX))
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// The create request body (매핑표 §2.1).
///
/// Three absences are as much a part of the contract as the fields:
/// * no `secure` — upstream parses and never reads it, so sending it would dress
///   a no-op as a security control;
/// * no `autoPause` — an E2B spelling CubeSandbox does not have. `NewSandbox`
///   has no `deny_unknown_fields`, so it would be swallowed silently and momo
///   would believe in a policy that was never applied;
/// * no `Idempotency-Key` header — see the module header.
///
/// `autoResume: false` is not decoration. With it true, CubeProxy resumes a
/// paused sandbox the moment a request arrives, producing a paused→running
/// transition that never passed through momo's durable intent (ADR-0140 D4).
pub fn create_body(
    template_id: &str,
    idle_timeout_seconds: i64,
    provision_key: &str,
    workspace_id: &str,
    env_vars: &BTreeMap<String, String>,
) -> Value {
    let mut metadata = Map::new();
    metadata.insert(
        METADATA_PROVISION_KEY.to_string(),
        Value::String(provision_key.to_string()),
    );
    metadata.insert(
        METADATA_WORKSPACE_KEY.to_string(),
        Value::String(workspace_id.to_string()),
    );
    let envs: Map<String, Value> = env_vars
        .iter()
        .map(|(key, value)| (key.clone(), Value::String(value.clone())))
        .collect();
    json!({
        // Named `imageRef` on momo's side, but upstream this is a *template id*:
        // a pre-built artifact from `POST /templates`, not an OCI reference.
        "templateID": template_id,
        // Seconds. E2B's `timeoutMs` is milliseconds — a unit slip here is a
        // 1000x error in the reaper's favour.
        "timeout": idle_timeout_seconds,
        "lifecycle": { "onTimeout": ON_TIMEOUT_KILL, "autoResume": false },
        "metadata": Value::Object(metadata),
        "envVars": Value::Object(envs),
    })
}

/// The workd bootstrap material one sandbox starts with.
///
/// Names match `infra/workd/bootstrap.sh` exactly — the daemon inside the
/// sandbox is the same binary an operator installs by hand, so a second spelling
/// here would be a second contract. Nothing provider-specific is injected, and
/// no CubeSandbox credential is: ADR-0004 keeps the operator key in this process.
fn workd_env_vars(spec: &CloudInstanceSpec) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("MOMO_WORKD_SERVER_URL".to_string(), spec.server_url.clone()),
        (
            "MOMO_WORKD_WORKSPACE_ID".to_string(),
            spec.workspace_id.to_string(),
        ),
        (
            "MOMO_WORKD_DISPLAY_NAME".to_string(),
            spec.display_name.clone(),
        ),
        (
            "MOMO_WORKD_REGISTRATION_TOKEN".to_string(),
            spec.registration_token.clone(),
        ),
    ])
}

/// A self-hosted CubeSandbox daemon, behind the ADR-0142 D2 contract.
///
/// `Debug` is hand-written for the same reason [`T3ProviderEndpoint`]'s is:
/// `tracing` renders `Debug`, and a derived impl would put the operator
/// credential in the first log line that mentions the adapter.
pub struct CubeSandboxProviderAdapter {
    capabilities: CloudProviderCapabilities,
    base_url: String,
    api_key: String,
    template_id: String,
    lease_seconds: i64,
    http: reqwest::Client,
}

impl std::fmt::Debug for CubeSandboxProviderAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CubeSandboxProviderAdapter")
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .field("template_id", &self.template_id)
            .field("lease_seconds", &self.lease_seconds)
            .finish()
    }
}

impl CubeSandboxProviderAdapter {
    /// Build the adapter from a loaded endpoint plus the host's tuning.
    ///
    /// `tuning.max_concurrent_instances` overrides the registry's conservative
    /// default *in the capability descriptor this adapter reports*, which is the
    /// whole of ADR-0156 D6① — policy code still reads
    /// `capabilities().max_concurrent_instances` and still cannot name the
    /// provider.
    pub fn new(
        endpoint: &T3ProviderEndpoint,
        tuning: CubeSandboxTuning,
    ) -> Result<Self, CloudProviderError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| CloudProviderError::NotConfigured(CUBESANDBOX_PROVIDER_ID.to_string()))?;
        let mut capabilities = capabilities_for(CUBESANDBOX_PROVIDER_ID)
            .map_err(|_| CloudProviderError::NotConfigured(CUBESANDBOX_PROVIDER_ID.to_string()))?;
        capabilities.max_concurrent_instances = Some(tuning.max_concurrent_instances);
        // The declared lease and the `timeout` on the wire are the same number by
        // construction. If they could differ, the renewal loop would be pacing
        // itself against a deadline the substrate does not actually hold.
        capabilities.instance_lease_seconds = Some(tuning.lease_seconds());
        Ok(CubeSandboxProviderAdapter {
            capabilities,
            base_url: endpoint.api_base_url().trim_end_matches('/').to_string(),
            api_key: endpoint.api_key().to_string(),
            template_id: endpoint.image_ref().to_string(),
            lease_seconds: tuning.lease_seconds(),
            http,
        })
    }

    /// The adapter for an environment map, or
    /// [`CloudProviderError::NotConfigured`] when the operator has not supplied
    /// both a base URL and a key.
    ///
    /// Fail-closed on purpose (ADR-0142 D4): a half-configured managed provider
    /// that fell back to *anything* would either create billable instances
    /// against a guessed host or report a fresh, empty substrate's `Absent` for
    /// live sandboxes.
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Self, CloudProviderError> {
        let endpoints = load_endpoints(env);
        let endpoint = endpoints.get(CUBESANDBOX_PROVIDER_ID).ok_or_else(|| {
            CloudProviderError::NotConfigured(CUBESANDBOX_PROVIDER_ID.to_string())
        })?;
        Self::new(endpoint, CubeSandboxTuning::from_env(env))
    }

    /// The `timeout` this adapter sends on every create, and the `duration`
    /// every renewal sends. One number, two places.
    pub fn lease_seconds(&self) -> i64 {
        self.lease_seconds
    }

    fn instance_url(&self, instance_id: &str, suffix: &str) -> Result<Url, CloudProviderError> {
        // The id came from a provider response, so it is validated before it can
        // reach a request line (`validated_cloud_instance_id`, ADR-0142 D2).
        let validated = validated_cloud_instance_id(instance_id)?;
        Url::parse(&format!("{}/sandboxes/{validated}{suffix}", self.base_url))
            .map_err(|_| CloudProviderError::NotConfigured(CUBESANDBOX_PROVIDER_ID.to_string()))
    }

    /// One CubeAPI call. Returns the status and the (possibly empty) body.
    ///
    /// A transport failure is [`CloudProviderError::RequestFailed`] and is the
    /// one outcome that carries no status — the caller must not turn it into a
    /// fact about the instance.
    async fn call(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
    ) -> Result<(StatusCode, Option<String>, String), CloudProviderError> {
        let mut request = self
            .http
            .request(method, url)
            // CubeSandbox accepts `X-API-Key` as a first-class credential
            // alongside the E2B SDK's `Authorization: Bearer`. Deliberately no
            // `Idempotency-Key`: upstream does not read it, and sending it would
            // advertise a guarantee that does not exist (see module header).
            .header("X-API-Key", &self.api_key);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| CloudProviderError::RequestFailed)?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let text = response.text().await.unwrap_or_default();
        Ok((status, retry_after, text))
    }

    /// `GET /sandboxes/{id}`, as (presence, state).
    async fn fetch_detail(
        &self,
        instance_id: &str,
    ) -> Result<(CloudInstancePresence, Option<String>), CloudProviderError> {
        let url = self.instance_url(instance_id, "")?;
        let (status, _, body) = self.call(Method::GET, url, None).await?;
        let presence = presence_for_status(status.as_u16());
        let state = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value.get("state")?.as_str().map(str::to_string));
        Ok((presence, state))
    }

    /// Re-judge a refused transition by asking the substrate what is true
    /// (#1197 B1).
    ///
    /// `wanted` is the state the durable intent is asking for, expressed in the
    /// only vocabulary CubeAPI reports honestly: a pause wants
    /// [`PauseVerdict::AlreadyPaused`], a resume wants
    /// [`PauseVerdict::NotPaused`].
    ///
    /// * gone → [`CloudProviderError::InstanceMissing`], terminal either way;
    /// * present and in the wanted state → `Ok(())`. The *world* matches the
    ///   intent, whoever put it there — which is a different claim from "our
    ///   call worked", and the right one for a convergent lifecycle;
    /// * present and not in it → the original refusal, surfaced verbatim so
    ///   ADR-0140 D4 sees a failure that really is one;
    /// * could not ask → also the original refusal. An unanswered question is
    ///   not an answer (ADR-0142 D3.1), so the intent stays unconfirmed and the
    ///   billable reading holds.
    async fn rejudge_refusal(
        &self,
        instance_id: &str,
        refusal: u16,
        wanted: PauseVerdict,
    ) -> Result<(), CloudProviderError> {
        match self.fetch_detail(instance_id).await? {
            (CloudInstancePresence::Absent, _) => Err(CloudProviderError::InstanceMissing),
            (CloudInstancePresence::Present, state) => {
                if pause_verdict_from_state(state.as_deref()) == wanted {
                    Ok(())
                } else {
                    Err(CloudProviderError::UpstreamStatus(refusal))
                }
            }
            (CloudInstancePresence::Unknown, _) => Err(CloudProviderError::UpstreamStatus(refusal)),
        }
    }

    /// The idempotency reconstruction: the sandbox already stamped with this
    /// key, if any.
    ///
    /// A lookup that *fails* is propagated rather than treated as "none found".
    /// Treating an unreachable control plane as an empty result is precisely how
    /// a lost create response turns into a second billed instance.
    ///
    /// **The server-side filter is asked for, then checked (#1197 H3).** The
    /// `metadata=` query is a real server-side AND on exact values, and D4-②
    /// confirmed it works — but momo re-verifies its own stamp on every returned
    /// row anyway, because the failure mode of trusting it is not "a wasted
    /// create". A filter that silently stopped filtering (an upstream
    /// regression, a proxy that drops the query string, a version that changes
    /// `metadata=` semantics) would hand this function *every* sandbox on the
    /// host, and it would adopt the lexicographically smallest one — another
    /// workspace's live session, addressed forever after by ours. The local
    /// re-check turns a cross-tenant adoption into an ordinary miss.
    ///
    /// It reads the stamp through [`momo_metadata`], so the substrate's own
    /// `cube.*` and `X-Caller` entries are not even in scope.
    ///
    /// More than one match means the advisory lock was bypassed and a real
    /// double-create already happened. Returning the lexicographically smallest
    /// id makes every later replay converge on the *same* survivor instead of
    /// alternating; the loser is bounded by the lease rather than leaking
    /// forever, and the anomaly is named in the log.
    async fn find_stamped_instance(
        &self,
        provision_key: &str,
    ) -> Result<Option<String>, CloudProviderError> {
        let mut url = Url::parse(&format!("{}/sandboxes", self.base_url))
            .map_err(|_| CloudProviderError::NotConfigured(CUBESANDBOX_PROVIDER_ID.to_string()))?;
        url.query_pairs_mut().append_pair(
            "metadata",
            &format!("{METADATA_PROVISION_KEY}={provision_key}"),
        );
        let (status, _, body) = self.call(Method::GET, url, None).await?;
        if !status.is_success() {
            return Err(CloudProviderError::UpstreamStatus(status.as_u16()));
        }
        let parsed: Value =
            serde_json::from_str(&body).map_err(|_| CloudProviderError::InvalidResponse)?;
        let Some(items) = parsed.as_array() else {
            return Err(CloudProviderError::InvalidResponse);
        };
        let mut ids: Vec<String> = items
            .iter()
            .filter(|item| {
                momo_metadata(item)
                    .get(METADATA_PROVISION_KEY)
                    .map(String::as_str)
                    == Some(provision_key)
            })
            .filter_map(|item| item.get("sandboxID")?.as_str().map(str::to_string))
            .collect();
        ids.sort();
        if ids.len() > 1 {
            tracing::error!(
                provider_id = CUBESANDBOX_PROVIDER_ID,
                matches = ids.len(),
                "more than one sandbox carries the same provision stamp — the ADR-0140 D2 \
                 advisory lock did not hold; converging on the lowest id and leaving the rest \
                 to the lease"
            );
        }
        Ok(ids.into_iter().next())
    }

    fn instance(&self, instance_id: String) -> CloudInstanceRef {
        CloudInstanceRef {
            provider_id: CUBESANDBOX_PROVIDER_ID.to_string(),
            instance_id,
        }
    }
}

#[async_trait]
impl CloudProviderAdapter for CubeSandboxProviderAdapter {
    fn capabilities(&self) -> &CloudProviderCapabilities {
        &self.capabilities
    }

    async fn create(
        &self,
        spec: &CloudInstanceSpec,
        idempotency_key: &str,
    ) -> Result<CloudInstanceRef, CloudProviderError> {
        // Step 1 of the reconstruction. Ahead of the POST, always — a create
        // whose response was lost is indistinguishable from one that never
        // happened until this question is asked.
        if let Some(existing) = self.find_stamped_instance(idempotency_key).await? {
            return Ok(self.instance(validated_cloud_instance_id(&existing)?.to_string()));
        }

        let url = Url::parse(&format!("{}/sandboxes", self.base_url))
            .map_err(|_| CloudProviderError::NotConfigured(CUBESANDBOX_PROVIDER_ID.to_string()))?;
        let body = create_body(
            &self.template_id,
            self.lease_seconds,
            idempotency_key,
            &spec.workspace_id.to_string(),
            &workd_env_vars(spec),
        );
        let (status, _, response) = self.call(Method::POST, url, Some(body)).await?;
        if !status.is_success() {
            return Err(CloudProviderError::UpstreamStatus(status.as_u16()));
        }
        let parsed: Value =
            serde_json::from_str(&response).map_err(|_| CloudProviderError::InvalidResponse)?;
        let sandbox_id = parsed
            .get("sandboxID")
            .and_then(Value::as_str)
            .ok_or(CloudProviderError::InvalidResponse)?;
        Ok(self.instance(validated_cloud_instance_id(sandbox_id)?.to_string()))
    }

    /// `POST /sandboxes/{id}/pause` → 204, and every refusal re-judged
    /// (#1197 B1).
    ///
    /// Upstream folds several conditions into one refusal — already paused,
    /// mid-`pausing`, or genuinely unable — and D4-② found it spells that
    /// refusal `500`, not the `409` the mapping table predicted. Collapsing it
    /// either way would be wrong in a different direction: reading it as success
    /// reports a still-running instance as paused and stops billing a machine
    /// that is burning the host; reading it as failure sends the ledger's
    /// already-paused host back to `running`, to be paused again next tick,
    /// forever.
    ///
    /// So the code is not read at all beyond [`refusal_needs_reprobe`]. momo
    /// re-asks, and only the sandbox's own `paused` satisfies the intent.
    async fn pause(
        &self,
        instance: &CloudInstanceRef,
        _idempotency_key: &str,
    ) -> Result<(), CloudProviderError> {
        let url = self.instance_url(&instance.instance_id, "/pause")?;
        let (status, _, _) = self.call(Method::POST, url, None).await?;
        if status.is_success() {
            return Ok(());
        }
        let status = status.as_u16();
        if !refusal_needs_reprobe(status) {
            // 404 — absence is the one fact a status can settle.
            return Err(CloudProviderError::InstanceMissing);
        }
        // Already paused: the durable intent ("this host must be paused") is
        // satisfied, whoever satisfied it. This is not the mock's
        // `InstancePaused` — that substrate is refusing to claim work it did not
        // do, which is a statement about the *call*. Here the statement is about
        // the *world*, and the world matches the intent.
        self.rejudge_refusal(&instance.instance_id, status, PauseVerdict::AlreadyPaused)
            .await
    }

    /// Resume via **`POST /sandboxes/{id}/connect`**, never `/resume`.
    ///
    /// `/resume` is marked `(deprecated)` in the upstream OpenAPI and D4-②
    /// measured it answering `500 …130490: sandbox already running` for an
    /// already-running sandbox — a self-inflicted failure on the exact retry
    /// ADR-0140 D4 is built to perform. `/connect` returns `200` whether the
    /// sandbox was paused or already running (measured both ways, 84 ms and
    /// 3 ms), which is the convergent shape this contract wants. The retired
    /// `E2BProvisioner.resume()` had already picked `/connect`.
    ///
    /// The refusal path gets the same re-judgement as [`Self::pause`], mirrored
    /// (#1197 B1): a resume's intent is "not paused", so that is what the
    /// re-probe must find. `/connect` is convergent enough that this should stay
    /// unreached — which is exactly why it is here rather than assumed.
    async fn resume(
        &self,
        instance: &CloudInstanceRef,
        _idempotency_key: &str,
    ) -> Result<(), CloudProviderError> {
        let url = self.instance_url(&instance.instance_id, "/connect")?;
        // Resuming restarts the lease clock too: `timeout` is absolute from the
        // moment it is set, so a resume that named a stale remainder would hand
        // back a sandbox already most of the way to its own deletion.
        let body = json!({ "timeout": self.lease_seconds });
        let (status, _, _) = self.call(Method::POST, url, Some(body)).await?;
        if status.is_success() {
            return Ok(());
        }
        let status = status.as_u16();
        if !refusal_needs_reprobe(status) {
            return Err(CloudProviderError::InstanceMissing);
        }
        self.rejudge_refusal(&instance.instance_id, status, PauseVerdict::NotPaused)
            .await
    }

    /// `DELETE /sandboxes/{id}` — idempotent, and never abandoned.
    ///
    /// `404`/`410` are success: the durable intent is "this instance must not
    /// exist", and an instance that already does not exist satisfies it. Every
    /// other non-2xx — `408` (synchronous delete timed out), `409` (the node had
    /// no room to restore a paused sandbox for destruction), `503` (mid-pause) —
    /// is surfaced as [`CloudProviderError::UpstreamStatus`], which ADR-0140 D4
    /// converges to `Retry`. There is no failure mode where giving up costs less
    /// than retrying: the instance bills for as long as it exists.
    async fn destroy(
        &self,
        instance: &CloudInstanceRef,
        _idempotency_key: &str,
    ) -> Result<(), CloudProviderError> {
        let url = self.instance_url(&instance.instance_id, "")?;
        let (status, retry_after, _) = self.call(Method::DELETE, url, None).await?;
        if status.is_success() || matches!(status.as_u16(), 404 | 410) {
            return Ok(());
        }
        if let Some(retry_after) = retry_after {
            // Upstream's own backoff hint (2 s or 5 s). The reconciler owns the
            // schedule — adding a `retryAfter` case to `CloudProviderError` would
            // widen the provider-neutral contract for one substrate — so it is
            // recorded rather than obeyed.
            tracing::warn!(
                provider_id = CUBESANDBOX_PROVIDER_ID,
                status = status.as_u16(),
                retry_after = %retry_after,
                "destroy refused with an upstream backoff hint; the intent stays claimable"
            );
        }
        Err(CloudProviderError::UpstreamStatus(status.as_u16()))
    }

    /// `GET /sandboxes/{id}`, mapped through [`presence_for_status`].
    ///
    /// The body is not read. A 200 says the control plane has a record of this
    /// instance and nothing more — in particular `state: "running"` is not
    /// evidence the machine works, because CubeAPI folds every non-paused status
    /// into that word.
    async fn probe(
        &self,
        instance: &CloudInstanceRef,
    ) -> Result<CloudInstancePresence, CloudProviderError> {
        let url = self.instance_url(&instance.instance_id, "")?;
        match self.call(Method::GET, url, None).await {
            Ok((status, _, _)) => Ok(presence_for_status(status.as_u16())),
            // "I could not ask" is the third value, never `Absent`.
            Err(CloudProviderError::RequestFailed) => Ok(CloudInstancePresence::Unknown),
            Err(other) => Err(other),
        }
    }

    /// `POST /sandboxes/{id}/refreshes` → 204 in ~2 ms (#1197 H1).
    ///
    /// **The duration is the whole lease, never a remainder.** Measured
    /// semantics are `endAt = now + duration`, an assignment and not an
    /// extension: the spike sent `duration: 180` to a sandbox with ~226 s left
    /// and watched its `endAt` move *backwards* by 106 s. A renewal that thought
    /// it was topping up a lease would therefore be shortening one, and the
    /// smaller the top-up the closer to death it would push a healthy sandbox.
    /// `self.lease_seconds` is the same number `create` sent, so every renewal
    /// restores the full window from the current instant.
    ///
    /// **This endpoint does not 404 either, and that is B1's disease on a third
    /// path.** `pause` and `connect` answer a clean `404` for a sandbox that
    /// does not exist; `/refreshes` answers
    /// `500 {"code":500,"message":"CubeMaster returned error code 130404:
    /// sandbox id not found"}` — a *different* CubeMaster code wrapped in the
    /// same 500 that means "already paused" on another route. Measured while
    /// building this ticket's live harness, which is the entire argument for
    /// having one.
    ///
    /// So the refusal is re-judged rather than read, exactly as
    /// [`Self::pause`] does: a probe says whether the instance is gone, and only
    /// [`CloudInstancePresence::Absent`] produces
    /// [`CloudProviderError::InstanceMissing`]. Had this kept its 404 arm, the
    /// keepalive would have reported every vanished instance as a generic
    /// upstream failure and gone on "renewing" it forever.
    ///
    /// A missing instance is a fact for the reconciler, not something a
    /// keepalive acts on; every other refusal is surfaced as its status and the
    /// caller does nothing but count it, because the lease is four renewal
    /// periods long and this was one of four chances.
    ///
    /// **Nothing here writes to the ledger.** A renewal is not a lifecycle
    /// transition, invents no state, and takes no advisory (ADR-0140 D4's
    /// vocabulary is untouched by design). It is momo telling the substrate that
    /// momo is still alive.
    async fn renew_lease(&self, instance: &CloudInstanceRef) -> Result<(), CloudProviderError> {
        let url = self.instance_url(&instance.instance_id, "/refreshes")?;
        let body = json!({ "duration": self.lease_seconds });
        let (status, _, _) = self.call(Method::POST, url, Some(body)).await?;
        if status.is_success() {
            return Ok(());
        }
        let status = status.as_u16();
        if !refusal_needs_reprobe(status) {
            return Err(CloudProviderError::InstanceMissing);
        }
        match self.fetch_detail(&instance.instance_id).await? {
            (CloudInstancePresence::Absent, _) => Err(CloudProviderError::InstanceMissing),
            // Present or unanswerable: the lease may or may not have moved, and
            // the next tick will try again. Never `InstanceMissing` on a guess —
            // that is the value the reconciler settles paid sessions on.
            _ => Err(CloudProviderError::UpstreamStatus(status)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn spec() -> CloudInstanceSpec {
        CloudInstanceSpec {
            provision_id: Uuid::from_u128(7),
            workspace_id: Uuid::from_u128(9),
            display_name: "cube conformance".to_string(),
            registration_token: "one-shot-workd-token".to_string(),
            server_url: "https://momo.invalid".to_string(),
        }
    }

    fn configured_env() -> BTreeMap<String, String> {
        BTreeMap::from([
            (
                "MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL".to_string(),
                "http://cube.invalid:3000".to_string(),
            ),
            (
                "MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY".to_string(),
                "operator-issued-key".to_string(),
            ),
            (
                "MOMO_T3_PROVIDER_CUBESANDBOX_IMAGE_REF".to_string(),
                "tpl-oort-workd".to_string(),
            ),
        ])
    }

    /// 매핑표 §2.3 / ADR-0156 D6② — the whole point of the missing parameter.
    #[test]
    fn presence_is_decided_without_ever_reading_state() {
        assert_eq!(presence_for_status(200), CloudInstancePresence::Present);
        assert_eq!(presence_for_status(404), CloudInstancePresence::Absent);
        for status in [400, 401, 403, 408, 409, 429, 500, 502, 503, 504] {
            assert_eq!(
                presence_for_status(status),
                CloudInstancePresence::Unknown,
                "named regression: {status} must never read as `absent` — ADR-0142 D3.1, and \
                 ADR-0140 D4 settles a paid session on `absent`"
            );
        }
    }

    /// Everything before `#[cfg(test)]` — the code that ships.
    ///
    /// The scans below look for string literals, and a scan whose own needle is
    /// a string literal in the same file would match itself and go green for the
    /// wrong reason (or red for it). Cutting the test module off first is what
    /// makes these assertions mean what they say.
    fn production_source() -> &'static str {
        include_str!("cubesandbox.rs")
            .split_once("#[cfg(test)]")
            .expect("this file has a test module")
            .0
    }

    /// The red proof's static half: `state` may not gate presence or liveness.
    ///
    /// CubeAPI folds every non-paused internal status into `running`
    /// (`sandboxes.rs:917-923`). The moment any shipping code branches on that
    /// word outside [`pause_verdict_from_state`], a wedged sandbox reads as a
    /// healthy one. Asserted against the file rather than trusted to review,
    /// because the failure it prevents is invisible in a green test run.
    #[test]
    fn running_is_never_read_as_liveness_evidence() {
        let source = production_source();
        let quoted = "\"running\"";
        for forbidden in [
            format!("== {quoted}"),
            format!("!= {quoted}"),
            format!("Some({quoted})"),
            format!("contains({quoted})"),
            format!("matches!(state, {quoted}"),
        ] {
            assert!(
                !source.contains(&forbidden),
                "named regression: `{forbidden}` makes CubeAPI's lossy `running` a fact about \
                 the machine. Liveness comes from the workd heartbeat (ADR-0156 D6②); this \
                 adapter reports presence, and presence is HTTP status alone"
            );
        }
        // …and the dynamic half: presence cannot even be *given* a state.
        assert_eq!(
            presence_for_status(200),
            CloudInstancePresence::Present,
            "presence takes no state argument at all"
        );
    }

    /// `state` answers exactly one question, and only for the 409 re-judgement.
    #[test]
    fn state_answers_only_whether_it_is_paused() {
        assert_eq!(
            pause_verdict_from_state(Some("paused")),
            PauseVerdict::AlreadyPaused
        );
        for folded in ["running", "pausing", "resuming", "wedged", "", "??"] {
            assert_eq!(
                pause_verdict_from_state(Some(folded)),
                PauseVerdict::NotPaused,
                "everything CubeAPI does not call `paused` is not-paused, including states this \
                 version has no name for ({folded:?})"
            );
        }
        assert_eq!(pause_verdict_from_state(None), PauseVerdict::NotPaused);
    }

    /// ADR-0156 D6② — an explicit reaper on a clock momo chose.
    #[test]
    fn every_create_carries_an_explicit_timeout_and_kill_policy() {
        let tuning = CubeSandboxTuning::default();
        let body = create_body(
            "tpl-oort-workd",
            tuning.lease_seconds(),
            "prov-1",
            &Uuid::from_u128(9).to_string(),
            &workd_env_vars(&spec()),
        );
        assert_eq!(
            body["timeout"].as_i64(),
            Some(DEFAULT_RENEWAL_SECONDS * LEASE_RENEWALS_PER_LEASE),
            "named regression: an absent `timeout` hands the clock to the cluster default, and \
             the ledger never learns when the reaper will run"
        );
        assert_eq!(body["lifecycle"]["onTimeout"].as_str(), Some("kill"));
        assert_eq!(
            body["lifecycle"]["autoResume"].as_bool(),
            Some(false),
            "named regression: autoResume produces a paused->running transition momo's durable \
             intent never authorised (ADR-0140 D4)"
        );
        assert_eq!(body["templateID"].as_str(), Some("tpl-oort-workd"));
    }

    /// 매핑표 §2.1 — three fields whose *absence* is the contract.
    #[test]
    fn the_create_body_omits_the_fields_that_would_lie() {
        let body = create_body(
            "tpl-1",
            600,
            "prov-1",
            &Uuid::from_u128(9).to_string(),
            &workd_env_vars(&spec()),
        );
        assert!(
            body.get("secure").is_none(),
            "`secure` is parsed and never read upstream; sending it would dress a no-op as a \
             security control"
        );
        assert!(
            body.get("autoPause").is_none(),
            "named regression: `autoPause` is an E2B spelling CubeSandbox has no field for, and \
             `NewSandbox` has no deny_unknown_fields — it would be swallowed in silence"
        );
        assert!(body.get("snapshot").is_none() && body.get("volumeMounts").is_none());
    }

    #[test]
    fn the_create_body_stamps_the_key_the_lookup_filters_on() {
        let body = create_body(
            "tpl-1",
            600,
            "prov-42",
            &Uuid::from_u128(9).to_string(),
            &workd_env_vars(&spec()),
        );
        assert_eq!(
            body["metadata"][METADATA_PROVISION_KEY].as_str(),
            Some("prov-42"),
            "the stamp and the reconstruction filter must be the same string, or a replay finds \
             nothing and creates a second billable instance"
        );
        assert_eq!(
            body["metadata"][METADATA_WORKSPACE_KEY].as_str(),
            Some(Uuid::from_u128(9).to_string().as_str())
        );
    }

    #[test]
    fn workd_bootstrap_uses_the_installer_env_names() {
        let vars = workd_env_vars(&spec());
        assert_eq!(
            vars.get("MOMO_WORKD_REGISTRATION_TOKEN")
                .map(String::as_str),
            Some("one-shot-workd-token")
        );
        assert_eq!(
            vars.get("MOMO_WORKD_SERVER_URL").map(String::as_str),
            Some("https://momo.invalid")
        );
        assert!(vars.contains_key("MOMO_WORKD_WORKSPACE_ID"));
        assert!(vars.contains_key("MOMO_WORKD_DISPLAY_NAME"));
        // ADR-0004: no provider credential travels into the sandbox.
        for (name, value) in &vars {
            assert!(
                !name.contains("API_KEY") && !value.contains("operator-issued-key"),
                "the sandbox never receives the operator's provider credential"
            );
        }
    }

    /// ADR-0142 D3.2 / ADR-0156 D5 / ADR-0140 D4 — the surface momo consumes is
    /// the lifecycle surface and nothing else. Grep-able, so a well-meaning
    /// optimisation cannot quietly widen it.
    #[test]
    fn the_adapter_consumes_only_the_lifecycle_surface() {
        let source = production_source();
        let quote = '"';
        for path in [
            "/snapshots",
            "/rollback",
            "/volumes",
            "/templates",
            // Sets the same deadline `/refreshes` does; two spellings of one
            // operation is one more than the contract needs.
            "/timeout",
            // Deprecated upstream, and D4-② measured it answering
            // `500 …130490: sandbox already running` — the exact retry
            // ADR-0140 D4 performs. `/connect` is the convergent path.
            "/resume",
        ] {
            assert!(
                !source.contains(&format!("{quote}{path}")),
                "named regression: `{path}` is outside the ADR-0140 D4 surface — widening it \
                 needs its own ADR, not a call site"
            );
        }
        assert!(
            source.contains(&format!("{quote}/connect{quote}")),
            "resume must go through /connect"
        );
        // #1197 H1 — `/refreshes` moved from the banned list to the required
        // one. It was banned when `timeout` was believed to be an idle clock the
        // ledger sweep sat under; D4-② found it is an absolute TTL that nothing
        // else resets, which makes this the only path that keeps a live session
        // alive.
        assert!(
            source.contains(&format!("{quote}/refreshes{quote}")),
            "named regression: without `/refreshes` the substrate deletes every sandbox at its \
             absolute TTL, working or not (spike §4)"
        );
        assert!(
            !source.contains(&format!("{quote}Idempotency-Key{quote}")),
            "CubeSandbox does not read it; sending it would advertise a guarantee that the \
             metadata reconstruction, not the header, provides"
        );
    }

    /// ADR-0156 D6① — the ceiling reaches policy through the capability
    /// descriptor, which is the only channel ADR-0142 D2 allows.
    #[test]
    fn the_injected_ceiling_reaches_the_capability_descriptor() {
        let mut env = configured_env();
        env.insert(
            "MOMO_T3_PROVIDER_CUBESANDBOX_MAX_INSTANCES".to_string(),
            "24".to_string(),
        );
        let adapter = CubeSandboxProviderAdapter::from_env(&env).expect("configured");
        assert_eq!(
            adapter.capabilities().max_concurrent_instances,
            Some(24),
            "the operator's box, not the source tree, sets the ceiling"
        );
        assert_eq!(adapter.capabilities().provider_id, CUBESANDBOX_PROVIDER_ID);

        let default_adapter =
            CubeSandboxProviderAdapter::from_env(&configured_env()).expect("configured");
        assert_eq!(
            default_adapter.capabilities().max_concurrent_instances,
            Some(crate::provider::registry::CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES)
        );
    }

    /// #1197 H1 — the lease is four renewal periods, and every input that is
    /// not a positive integer lengthens it rather than shortening it.
    #[test]
    fn the_lease_is_four_renewal_periods_and_fails_long() {
        let mut env = configured_env();
        env.insert(
            "MOMO_T3_PROVIDER_CUBESANDBOX_RENEWAL_SECONDS".to_string(),
            "600".to_string(),
        );
        let tuning = CubeSandboxTuning::from_env(&env);
        assert_eq!(tuning.renewal_seconds, 600);
        assert_eq!(tuning.lease_seconds(), 2_400);

        let default_tuning = CubeSandboxTuning::from_env(&configured_env());
        assert_eq!(default_tuning.renewal_seconds, DEFAULT_RENEWAL_SECONDS);
        assert_eq!(
            default_tuning.lease_seconds(),
            360,
            "named regression: the default lease is the 90 s host-offline grace x4. Shortening \
             it below four renewal periods means one flaky renewal window deletes a live paid \
             session; lengthening it is dead zombie billing after momo stops renewing"
        );
        for nonsense in ["0", "-1", "soon"] {
            env.insert(
                "MOMO_T3_PROVIDER_CUBESANDBOX_RENEWAL_SECONDS".to_string(),
                nonsense.to_string(),
            );
            assert_eq!(
                CubeSandboxTuning::from_env(&env).renewal_seconds,
                DEFAULT_RENEWAL_SECONDS,
                "a malformed renewal period must lengthen the lease, never shorten it \
                 ({nonsense:?})"
            );
        }
    }

    /// #1197 B1 — the widening itself, stated as a table.
    ///
    /// Red when reverted: narrow [`refusal_needs_reprobe`] back to `409` only
    /// and the 500 row flips to `false`, which is the flap this ticket exists to
    /// remove.
    #[test]
    fn every_refusal_but_a_404_is_re_judged_by_asking() {
        assert!(
            refusal_needs_reprobe(500),
            "named regression: D4-② measured `already paused` and `already running` arriving as \
             500 (code 130490), not 409. Reading 500 as a plain failure sends ADR-0140 D4's \
             `pause 500 -> revert` row against an instance that IS paused, and the ledger flaps \
             between paused and running forever"
        );
        for refusal in [400, 401, 403, 408, 409, 429, 502, 503, 504] {
            assert!(
                refusal_needs_reprobe(refusal),
                "{refusal} carries no reliable meaning about the world either"
            );
        }
        assert!(
            !refusal_needs_reprobe(404),
            "404 is the one status that settles a fact: there is no `terminated` state upstream, \
             so absence is only ever expressed this way"
        );
        for success in [200, 201, 204] {
            assert!(
                !refusal_needs_reprobe(success),
                "{success} is not a refusal"
            );
        }
    }

    /// #1197 B1 — the two intents read the same honest branch from opposite
    /// sides, and neither reads `running` as liveness.
    #[test]
    fn pause_and_resume_want_opposite_verdicts_from_one_honest_branch() {
        assert_eq!(
            pause_verdict_from_state(Some("paused")),
            PauseVerdict::AlreadyPaused,
            "a pause is satisfied only by the branch CubeAPI reports faithfully"
        );
        assert_eq!(
            pause_verdict_from_state(Some("running")),
            PauseVerdict::NotPaused,
            "a resume is satisfied by `not paused` — which is a claim about the pause state, not \
             a claim that the machine works"
        );
        assert_ne!(PauseVerdict::AlreadyPaused, PauseVerdict::NotPaused);
    }

    /// #1197 H3 — the substrate's own bookkeeping is not momo's to read.
    #[test]
    fn only_momo_keys_survive_the_metadata_filter() {
        // Verbatim from the D4-② round trip: 2 keys sent, 12 returned.
        let measured = json!({
            "metadata": {
                "momo_provision_id": "prov-cubefix1197",
                "momo_workspace_id": "ws-cubefix1197",
                "cube.master.appsnapshot.template.id": "tpl-50622c58811449bbba60cc1e",
                "cube.master.runtime.restore.snapshot.id": "tpl-50622c58811449bbba60cc1e",
                "cube.master.runtime.restore.snapshot.attached_at": "2026-08-08T17:04:50Z",
                "cube.master.runtime.snapshot.id": "tpl-50622c58811449bbba60cc1e",
                "cube.master.runtime.snapshot.attached_at": "2026-08-08T17:04:50Z",
                "cube.master.instance.type": "cubebox",
                "cube.master.components.envd.version": "0.5.11",
                "cube.numa_node": "0",
                "cube.product": "cubebox",
                "X-Caller": "X-Caller"
            }
        });
        let ours = momo_metadata(&measured);
        assert_eq!(
            ours.keys().cloned().collect::<Vec<_>>(),
            vec![
                METADATA_PROVISION_KEY.to_string(),
                METADATA_WORKSPACE_KEY.to_string()
            ],
            "named regression: the response mixes CubeSandbox's internal keys into the same dict \
             momo stamped. Storing it whole would put another system's bookkeeping — including \
             whatever it adds next release — into momo's ledger"
        );
        assert_eq!(
            ours.get(METADATA_PROVISION_KEY).map(String::as_str),
            Some("prov-cubefix1197")
        );
        assert!(momo_metadata(&json!({})).is_empty());
        assert!(momo_metadata(&json!({ "metadata": "not an object" })).is_empty());
    }

    /// ADR-0142 D4 — a half-configured managed provider is refused, not guessed.
    #[test]
    fn an_unconfigured_adapter_refuses_to_exist() {
        let mut env = BTreeMap::new();
        assert!(matches!(
            CubeSandboxProviderAdapter::from_env(&env),
            Err(CloudProviderError::NotConfigured(_))
        ));
        env.insert(
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL".to_string(),
            "http://cube.invalid:3000".to_string(),
        );
        assert!(
            matches!(
                CubeSandboxProviderAdapter::from_env(&env),
                Err(CloudProviderError::NotConfigured(_))
            ),
            "a base URL without a key must not produce an adapter that can create billable \
             instances"
        );
    }

    /// Invariant #7's log half. `tracing` renders `Debug`.
    #[test]
    fn debug_never_renders_the_operator_credential() {
        let adapter = CubeSandboxProviderAdapter::from_env(&configured_env()).expect("configured");
        let rendered = format!("{adapter:?}");
        assert!(
            !rendered.contains("operator-issued-key"),
            "provider credential must never reach a Debug rendering: {rendered}"
        );
        assert!(rendered.contains("<redacted>"));
    }

    /// An instance id from a provider response is interpolated into a request
    /// line, so it is constrained first (ADR-0142 D2).
    #[tokio::test]
    async fn a_malformed_instance_id_never_reaches_a_request_line() {
        let adapter = CubeSandboxProviderAdapter::from_env(&configured_env()).expect("configured");
        let hostile = CloudInstanceRef {
            provider_id: CUBESANDBOX_PROVIDER_ID.to_string(),
            instance_id: "../../admin/shutdown".to_string(),
        };
        assert!(matches!(
            adapter.probe(&hostile).await,
            Err(CloudProviderError::InvalidResponse)
        ));
        assert!(matches!(
            adapter.destroy(&hostile, "op-1").await,
            Err(CloudProviderError::InvalidResponse)
        ));
    }

    /// A control plane that cannot be reached is `Unknown` — the one answer that
    /// neither bills a dead instance nor settles a live one.
    #[tokio::test]
    async fn an_unreachable_control_plane_probes_unknown() {
        let mut env = configured_env();
        // Port 1 with nothing on it: a genuine transport failure, not a status.
        env.insert(
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL".to_string(),
            "http://127.0.0.1:1".to_string(),
        );
        let adapter = CubeSandboxProviderAdapter::from_env(&env).expect("configured");
        let instance = CloudInstanceRef {
            provider_id: CUBESANDBOX_PROVIDER_ID.to_string(),
            instance_id: "iiny0783cype8gmoawzmx-ce30bc46".to_string(),
        };
        assert_eq!(
            adapter.probe(&instance).await.expect("probe answers"),
            CloudInstancePresence::Unknown,
            "named regression: `could not ask` must never collapse to `it is gone`"
        );
        // And a create cannot proceed on a failed reconstruction lookup: doing so
        // is exactly how a lost response becomes a second billed instance.
        assert!(matches!(
            adapter.create(&spec(), "prov-1").await,
            Err(CloudProviderError::RequestFailed)
        ));
    }
}
