//! The adapter registry — the only table of provider-specific facts, and the
//! only place adapter configuration is read (ADR-0142 D2/D4, invariant #7).
//!
//! Two rules are structural here rather than conventional:
//!
//! * **Policy code never learns a provider's identity.** Callers ask for
//!   [`capabilities_for`] and branch on the answer. `work_cloud_host.provider`
//!   is a key into this map (054), not a vendor name a policy may test against.
//! * **Adapter credentials live in the process, in an env namespace, and go no
//!   further.** `MOMO_T3_PROVIDER_<ID>_*` is loaded into
//!   [`T3ProviderEndpoint`], whose `Debug` redacts the key, and no function in
//!   this crate writes any part of it to PostgreSQL. That is invariant #7's red
//!   test: after a full mock lifecycle, the configured key must appear zero
//!   times in a database dump and zero times in a log line.
//!
//! Ports Swift `CloudProviderKit/CloudProviderRegistry.swift` and
//! `CloudProviderSettings.swift:42-81`.

use std::collections::BTreeMap;
use std::fmt;

use momo_provider::{CloudProviderCapabilities, CloudResumeSemantics};

use crate::error::T3Error;

/// Bring-your-own-cloud. Degenerate by construction (ADR-0142 D1): momo
/// registers, schedules, observes and bills the host but never creates or
/// destroys it.
pub const BYOC_PROVIDER_ID: &str = "byoc";

/// Verification substrates (ADR-0142 D3). They are registered in the product
/// binary on purpose: the continuity contract must be provable against the same
/// code path production uses, not a test-only fork.
///
/// `mock-a` keeps memory across pause; `mock-b` refuses pause outright and cold
/// boots. Cross-provider continuity therefore cannot lean on either provider's
/// convenience.
pub const MOCK_A_PROVIDER_ID: &str = "mock-a";
pub const MOCK_B_PROVIDER_ID: &str = "mock-b";

/// The first **managed** substrate (ADR-0156 D1/D2): a self-hosted CubeSandbox
/// daemon on a dedicated host, spoken to over its E2B-dialect REST surface.
///
/// Passes `054_t3_provider_registry.sql`'s `^[a-z0-9][a-z0-9-]{0,31}$` check, so
/// a `work_cloud_host.provider` row can name it.
pub const CUBESANDBOX_PROVIDER_ID: &str = "cubesandbox";

/// Default when the operator names no provider: BYOC needs no credential at all.
pub const FALLBACK_PROVIDER_ID: &str = BYOC_PROVIDER_ID;

/// Every registered adapter id, ascending.
pub fn registered_provider_ids() -> Vec<&'static str> {
    let mut ids = vec![
        BYOC_PROVIDER_ID,
        CUBESANDBOX_PROVIDER_ID,
        MOCK_A_PROVIDER_ID,
        MOCK_B_PROVIDER_ID,
    ];
    ids.sort_unstable();
    ids
}

pub fn is_registered(provider_id: &str) -> bool {
    registered_provider_ids().contains(&provider_id)
}

/// Wall-clock cost of a CubeSandbox pause, per GiB of instance memory.
///
/// **Measured, not derived (#1197 H2).** The previous `0.2` came from the
/// 1st-party PVM benchmark's 370.8 ms/2 GiB. D4-② put a stopwatch on a real
/// host and got **1,264–1,693 ms for a 1.95 GiB sandbox = 0.65–0.87 s/GiB**
/// (`research/2026-08-09-cubesandbox-d42-spike.md` §2, and re-measured at
/// 0.647/0.667 s/GiB while fixing this ticket) — three to four times the
/// declared figure.
///
/// So `1.0` is a **ceiling declared conservatively**, and the direction of the
/// error is the whole point. This number is what policy budgets a pause against;
/// under-declaring it means the ledger expects a pause to be over long before it
/// is, and bills a still-running host as paused. Over-declaring only wastes a
/// little patience. `0.2` was never observed on any real host, so it is not a
/// number to round toward.
///
/// It stays far from `mock-a`'s `4.0`, which is an E2B-derived figure for a
/// different substrate; the two must not be confused in either direction.
///
/// The 3–4× gap against the 1st-party number is plausibly CPU generation
/// (Xeon Gold 5220 vs EPYC 9K65) rather than a CubeSandbox regression, so
/// ADR-0156 D4-④ re-measures on the production host before this is lowered.
pub const CUBESANDBOX_PAUSE_SECONDS_PER_GIB: f64 = 1.0;

/// Conservative default for `max_concurrent_instances` when the operator injects
/// nothing (ADR-0156 D6①).
///
/// CubeSandbox declares no concurrency ceiling of its own — the ceiling is a
/// property of the *host*, and this is the first provider for which that is
/// true. The 1st-party density measurement gives
/// `(RAM_GiB − 7 baseline) ÷ per-session GiB`, which is ≈10 on the 32 GiB box
/// ADR-0156 D3's 증보 orders. A bigger box raises it — through
/// [`cubesandbox_max_concurrent_instances`], never through an edit here.
pub const CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES: i64 = 10;

/// How long a CubeSandbox instance lives without a renewal (#1197 H1).
///
/// **This is the number D4-② changed the meaning of.** `timeout` was documented
/// — and modelled here — as an *idle* clock. It is not: it is an absolute TTL
/// measured from creation, and the spike could not move it with any of five
/// stimuli (detail GET, list GET, SDK exec, in-sandbox CPU burn, outbound
/// HTTPS). Only `POST /sandboxes/{id}/refreshes` moves it
/// (`research/2026-08-09-cubesandbox-d42-spike.md` §4).
///
/// That inverts the old reasoning. The retired constant was 24 h **because** the
/// clock was believed unresettable by momo's outbound heartbeat, so the only
/// safe net was a very long one — 96 h of zombie billing. With an explicit
/// renewal the calculus flips: the lease is the **zombie ceiling**, and the
/// shorter it is the better, right up to the point where a momentary renewal
/// outage would start killing live sessions.
///
/// 360 s is that point, and it is not a free choice. It is
/// `MOMO_HOST_OFFLINE_GRACE_S` (90 s — the window after which momo itself
/// declares a host lost) × 4, so:
///
/// * a live instance survives **four** consecutive renewal failures;
/// * an instance momo has stopped renewing — because momo is dead, or because
///   its daemon went quiet — is reclaimed by the substrate roughly when momo
///   would have given up on it anyway.
///
/// The second property is what makes this the answer to #1197 B2 as well as H1:
/// a crashed VM reports `running` forever and never self-converges (measured:
/// 15 probes over 300 s, zero convergence), so the *only* automatic reclaim path
/// is the one that stops when momo stops.
pub const CUBESANDBOX_DEFAULT_LEASE_SECONDS: i64 = 360;

/// Capability descriptor for a registry id, or [`T3Error::UnknownProvider`] —
/// an unknown provider fails closed (054 header comment) rather than defaulting
/// to something that can create billable instances.
///
/// Still a pure function of the id. The one host-spec-dependent value
/// (`max_concurrent_instances`) resolves to its conservative default here and is
/// overridden from settings by the adapter that owns the host — see
/// [`cubesandbox_max_concurrent_instances`] and ADR-0142 D2's 증보.
pub fn capabilities_for(provider_id: &str) -> Result<CloudProviderCapabilities, T3Error> {
    Ok(match provider_id {
        BYOC_PROVIDER_ID => CloudProviderCapabilities {
            provider_id: BYOC_PROVIDER_ID.to_string(),
            manages_instance_lifetime: false,
            supports_pause: false,
            resume_semantics: CloudResumeSemantics::ColdBoot,
            continuous_runtime_limit_seconds: None,
            pause_seconds_per_gib: None,
            max_concurrent_instances: None,
            instance_lease_seconds: None,
        },
        MOCK_A_PROVIDER_ID => CloudProviderCapabilities {
            provider_id: MOCK_A_PROVIDER_ID.to_string(),
            manages_instance_lifetime: true,
            supports_pause: true,
            resume_semantics: CloudResumeSemantics::Memory,
            continuous_runtime_limit_seconds: Some(3_600),
            pause_seconds_per_gib: Some(4.0),
            max_concurrent_instances: Some(20),
            // No lease: `mock-a` instances live until momo destroys them, which
            // is what every substrate before CubeSandbox did.
            instance_lease_seconds: None,
        },
        MOCK_B_PROVIDER_ID => CloudProviderCapabilities {
            provider_id: MOCK_B_PROVIDER_ID.to_string(),
            manages_instance_lifetime: true,
            supports_pause: false,
            resume_semantics: CloudResumeSemantics::ColdBoot,
            continuous_runtime_limit_seconds: Some(900),
            pause_seconds_per_gib: None,
            max_concurrent_instances: Some(5),
            instance_lease_seconds: None,
        },
        // ADR-0156 D2 / the 매핑표 §2.7 draft, value for value.
        CUBESANDBOX_PROVIDER_ID => CloudProviderCapabilities {
            provider_id: CUBESANDBOX_PROVIDER_ID.to_string(),
            manages_instance_lifetime: true,
            // Not a simulation: pause writes a memory snapshot to disk and the
            // host physically reclaims CPU and RAM.
            supports_pause: true,
            // "CPU registers, process memory, TCP state and filesystem mutations
            // all survive the snapshot" — the sandbox's own outbound sockets are
            // the documented exception, and they are the reason ADR-0141 D4's
            // periodic WIP commit is not optional.
            resume_semantics: CloudResumeSemantics::Memory,
            // No wall-clock ceiling at all — unlike hosted e2b's 24h/1h tiers,
            // which is where `mock-a`'s 3600 comes from. `None` here is a fact
            // about the substrate, not an omission.
            continuous_runtime_limit_seconds: None,
            pause_seconds_per_gib: Some(CUBESANDBOX_PAUSE_SECONDS_PER_GIB),
            max_concurrent_instances: Some(CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES),
            // The first substrate that expires instances on a clock of its own
            // (#1197 H1). Declared here so the renewal loop can see *that* a
            // deadline exists without learning whose it is; the adapter
            // overrides the value from the operator's tuning, exactly as it does
            // for `max_concurrent_instances`.
            instance_lease_seconds: Some(CUBESANDBOX_DEFAULT_LEASE_SECONDS),
        },
        other => return Err(T3Error::UnknownProvider(other.to_string())),
    })
}

/// The operator's concurrency ceiling for the CubeSandbox host, from an
/// environment map (ADR-0156 D6① / ADR-0142 D2 증보).
///
/// **Why this is a setting and not a constant.** Every other capability in
/// [`capabilities_for`] is a fact about the *substrate*. This one is a fact
/// about the *box the operator bought*: the density measurement is
/// `(RAM_GiB − 7) ÷ per-session GiB`, so pinning it in the registry would mean
/// editing Rust to use a larger machine. ADR-0142 D2's rule survives intact —
/// its subject is policy code, which still cannot name `cubesandbox`; it says
/// nothing about where the registry sources a number.
///
/// A value that is absent, unparseable, or non-positive falls back to
/// [`CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES`]. Failing *open* here would
/// let a typo admit more paid sandboxes than the host can hold.
pub fn cubesandbox_max_concurrent_instances(env: &BTreeMap<String, String>) -> i64 {
    let key = format!(
        "{}_MAX_INSTANCES",
        environment_namespace(CUBESANDBOX_PROVIDER_ID)
    );
    env.get(&key)
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES)
}

/// `mock-a` → `MOMO_T3_PROVIDER_MOCK_A`. Every non-alphanumeric character folds
/// to `_` so a registry id is always a legal env prefix
/// (`CloudProviderSettings.swift:42-47`).
pub fn environment_namespace(provider_id: &str) -> String {
    let folded: String = provider_id
        .to_uppercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    format!("MOMO_T3_PROVIDER_{folded}")
}

/// The full env key set one managed adapter reads. Exposed so the invariant #7
/// scanner can assert that none of these *values* reached PostgreSQL.
///
/// **Tuning knobs are deliberately absent.** The adapter-specific numbers
/// (`_MAX_INSTANCES`, `_RENEWAL_SECONDS`) are small integers, so feeding them to a
/// substring scan of a database dump would report a leak every time a row
/// happened to contain `10`. This list is the *credential-bearing* namespace,
/// and its usefulness comes from every entry being a high-entropy secret.
pub fn environment_keys(provider_id: &str) -> Vec<String> {
    let ns = environment_namespace(provider_id);
    vec![
        format!("{ns}_API_BASE_URL"),
        format!("{ns}_API_KEY"),
        format!("{ns}_IMAGE_REF"),
        format!("{ns}_INSTANCE_TIMEOUT_SECONDS"),
    ]
}

/// Connection material for one managed provider. Process-only: nothing here is
/// ever bound to a SQL statement by this crate.
#[derive(Clone, PartialEq, Eq)]
pub struct T3ProviderEndpoint {
    api_base_url: String,
    api_key: String,
    image_ref: String,
    instance_timeout_seconds: i64,
}

impl T3ProviderEndpoint {
    pub fn new(
        api_base_url: impl Into<String>,
        api_key: impl Into<String>,
        image_ref: impl Into<String>,
        instance_timeout_seconds: i64,
    ) -> Self {
        T3ProviderEndpoint {
            api_base_url: api_base_url.into(),
            api_key: api_key.into(),
            image_ref: image_ref.into(),
            instance_timeout_seconds: instance_timeout_seconds.clamp(60, 86_400),
        }
    }

    pub fn api_base_url(&self) -> &str {
        &self.api_base_url
    }

    /// The operator credential. Reachable only by the adapter that owns it —
    /// never by a domain function, a response DTO, or a SQL bind.
    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    pub fn image_ref(&self) -> &str {
        &self.image_ref
    }

    pub fn instance_timeout_seconds(&self) -> i64 {
        self.instance_timeout_seconds
    }
}

/// Redacted on purpose: `tracing` renders `Debug`, so a derived impl would put
/// the operator credential in a log line the first time anyone logs a config
/// struct — half of invariant #7's red test, and the half no dump scan catches.
impl fmt::Debug for T3ProviderEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("T3ProviderEndpoint")
            .field("api_base_url", &self.api_base_url)
            .field("api_key", &"<redacted>")
            .field("image_ref", &self.image_ref)
            .field("instance_timeout_seconds", &self.instance_timeout_seconds)
            .finish()
    }
}

/// Load every registered managed adapter's endpoint from an environment map.
///
/// A provider missing either the base URL or the key is simply absent from the
/// result (fail-closed at use, ADR-0142 D4), and degenerate providers (BYOC)
/// legitimately have no endpoint at all.
pub fn load_endpoints(env: &BTreeMap<String, String>) -> BTreeMap<String, T3ProviderEndpoint> {
    let nonempty = |key: &str| -> Option<String> {
        let value = env.get(key)?.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    };

    let mut endpoints = BTreeMap::new();
    for provider_id in registered_provider_ids() {
        let ns = environment_namespace(provider_id);
        let (Some(api_base_url), Some(api_key)) = (
            nonempty(&format!("{ns}_API_BASE_URL")),
            nonempty(&format!("{ns}_API_KEY")),
        ) else {
            continue;
        };
        let timeout = nonempty(&format!("{ns}_INSTANCE_TIMEOUT_SECONDS"))
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(3_600);
        endpoints.insert(
            provider_id.to_string(),
            T3ProviderEndpoint::new(
                api_base_url.trim_matches('/').to_string(),
                api_key,
                nonempty(&format!("{ns}_IMAGE_REF")).unwrap_or_else(|| "momo-workd".to_string()),
                timeout,
            ),
        );
    }
    endpoints
}

/// Same as [`load_endpoints`] over the process environment. Reads only
/// `MOMO_T3_PROVIDER_*` variables that are already exported to this process; it
/// opens no file.
pub fn load_endpoints_from_process_env() -> BTreeMap<String, T3ProviderEndpoint> {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    load_endpoints(&env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_provider::CloudProviderOperation;

    #[test]
    fn byoc_is_degenerate_and_mocks_disagree_about_pause() {
        let byoc = capabilities_for(BYOC_PROVIDER_ID).unwrap();
        assert!(!byoc.supports(CloudProviderOperation::Create));
        assert!(!byoc.supports(CloudProviderOperation::Destroy));
        assert!(!byoc.supports(CloudProviderOperation::Pause));
        assert!(byoc.supports(CloudProviderOperation::Probe));

        let a = capabilities_for(MOCK_A_PROVIDER_ID).unwrap();
        let b = capabilities_for(MOCK_B_PROVIDER_ID).unwrap();
        assert!(a.supports(CloudProviderOperation::Pause));
        assert!(
            !b.supports(CloudProviderOperation::Pause),
            "mock-b must refuse pause so continuity cannot lean on it (ADR-0142 D3)"
        );
        assert_eq!(a.resume_semantics, CloudResumeSemantics::Memory);
        assert_eq!(b.resume_semantics, CloudResumeSemantics::ColdBoot);
    }

    #[test]
    fn unknown_provider_fails_closed() {
        let err = capabilities_for("e2b").expect_err("a retired provider id must not resolve");
        assert!(matches!(err, T3Error::UnknownProvider(id) if id == "e2b"));
        assert!(
            !registered_provider_ids().contains(&"e2b"),
            "named regression: adding a managed substrate must not resurrect the retired id"
        );
    }

    /// ADR-0156 D2 + the 매핑표 §2.7 draft, value for value.
    #[test]
    fn cubesandbox_declares_the_measured_substrate_and_not_the_mock_numbers() {
        let caps = capabilities_for(CUBESANDBOX_PROVIDER_ID).expect("registered");
        for op in [
            CloudProviderOperation::Create,
            CloudProviderOperation::Pause,
            CloudProviderOperation::Resume,
            CloudProviderOperation::Destroy,
            CloudProviderOperation::Probe,
        ] {
            assert!(caps.supports(op), "cubesandbox must support {op:?}");
        }
        assert_eq!(caps.resume_semantics, CloudResumeSemantics::Memory);
        assert_eq!(
            caps.continuous_runtime_limit_seconds, None,
            "cubesandbox imposes no wall-clock ceiling; a Some(..) here would be an e2b tier"
        );
        // #1197 H2 — the measured ceiling, not the vendor benchmark.
        assert_eq!(caps.pause_seconds_per_gib, Some(1.0));
        let declared = caps.pause_seconds_per_gib.expect("declared");
        assert!(
            declared >= 0.87,
            "named regression: D4-② measured 0.65–0.87 s/GiB on a real host (re-measured at \
             0.647/0.667 while fixing #1197). A declaration below the slowest observation makes \
             the ledger expect a pause to be finished while the host is still copying memory, \
             and bill a running instance as paused. Saw {declared}"
        );

        // Named regression: `mock-a` carries E2B-derived numbers for a different
        // substrate. The two must not be confused in either direction.
        let mock_a = capabilities_for(MOCK_A_PROVIDER_ID).expect("registered");
        assert_ne!(caps.pause_seconds_per_gib, mock_a.pause_seconds_per_gib);
        assert_ne!(
            caps.continuous_runtime_limit_seconds,
            mock_a.continuous_runtime_limit_seconds
        );
    }

    /// #1197 H1 — the lease is a fact about this substrate and nobody else's.
    #[test]
    fn only_cubesandbox_expires_instances_on_a_clock_of_its_own() {
        let cube = capabilities_for(CUBESANDBOX_PROVIDER_ID).expect("registered");
        assert_eq!(
            cube.instance_lease_seconds,
            Some(CUBESANDBOX_DEFAULT_LEASE_SECONDS)
        );
        assert!(cube.supports(CloudProviderOperation::RenewLease));
        assert_eq!(cube.lease_renewal_period_seconds(), Some(90));

        for other in [BYOC_PROVIDER_ID, MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID] {
            let caps = capabilities_for(other).expect("registered");
            assert_eq!(
                caps.instance_lease_seconds, None,
                "named regression: {other} does not expire instances, and declaring a lease it \
                 does not have would start a renewal loop against an operation it cannot serve"
            );
            assert!(!caps.supports(CloudProviderOperation::RenewLease));
        }
    }

    /// ADR-0156 D6① — the ceiling follows the box, not the source tree.
    #[test]
    fn the_concurrency_ceiling_is_injected_and_fails_closed_on_nonsense() {
        let mut env = BTreeMap::new();
        assert_eq!(
            cubesandbox_max_concurrent_instances(&env),
            CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES,
            "an unconfigured host must get the conservative default"
        );

        env.insert(
            "MOMO_T3_PROVIDER_CUBESANDBOX_MAX_INSTANCES".to_string(),
            " 42 ".to_string(),
        );
        assert_eq!(cubesandbox_max_concurrent_instances(&env), 42);

        for nonsense in ["0", "-3", "ten", ""] {
            env.insert(
                "MOMO_T3_PROVIDER_CUBESANDBOX_MAX_INSTANCES".to_string(),
                nonsense.to_string(),
            );
            assert_eq!(
                cubesandbox_max_concurrent_instances(&env),
                CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES,
                "named regression: a malformed ceiling must fall back, never open up ({nonsense:?})"
            );
        }
    }

    #[test]
    fn env_namespace_folds_to_a_legal_prefix() {
        assert_eq!(
            environment_namespace(MOCK_A_PROVIDER_ID),
            "MOMO_T3_PROVIDER_MOCK_A"
        );
        assert_eq!(
            environment_namespace(BYOC_PROVIDER_ID),
            "MOMO_T3_PROVIDER_BYOC"
        );
        assert!(environment_keys(MOCK_A_PROVIDER_ID)
            .contains(&"MOMO_T3_PROVIDER_MOCK_A_API_KEY".to_string()));
    }

    #[test]
    fn endpoints_need_both_url_and_key() {
        let mut env = BTreeMap::new();
        env.insert(
            "MOMO_T3_PROVIDER_MOCK_A_API_BASE_URL".to_string(),
            "https://substrate.invalid/".to_string(),
        );
        // key missing -> the adapter is not configured, so it is not loaded.
        assert!(load_endpoints(&env).is_empty());

        env.insert(
            "MOMO_T3_PROVIDER_MOCK_A_API_KEY".to_string(),
            "operator-key".to_string(),
        );
        let loaded = load_endpoints(&env);
        let endpoint = loaded
            .get(MOCK_A_PROVIDER_ID)
            .expect("mock-a is configured");
        assert_eq!(endpoint.api_base_url(), "https://substrate.invalid");
        assert_eq!(endpoint.image_ref(), "momo-workd");
        assert_eq!(endpoint.instance_timeout_seconds(), 3_600);
        assert!(
            !loaded.contains_key(BYOC_PROVIDER_ID),
            "a degenerate provider has no endpoint to load"
        );
    }

    #[test]
    fn instance_timeout_is_clamped() {
        assert_eq!(
            T3ProviderEndpoint::new("https://x.invalid", "k", "i", 1).instance_timeout_seconds(),
            60
        );
        assert_eq!(
            T3ProviderEndpoint::new("https://x.invalid", "k", "i", 999_999)
                .instance_timeout_seconds(),
            86_400
        );
    }

    #[test]
    fn debug_never_renders_the_operator_credential() {
        // Invariant #7, the log half: `tracing` renders Debug, so a derived impl
        // would leak the key the first time anyone logs the config.
        let endpoint = T3ProviderEndpoint::new(
            "https://substrate.invalid",
            "super-secret-operator-key",
            "momo-workd",
            600,
        );
        let rendered = format!("{endpoint:?}");
        assert!(
            !rendered.contains("super-secret-operator-key"),
            "provider credential must never reach a Debug rendering: {rendered}"
        );
        assert!(rendered.contains("<redacted>"));
    }
}
