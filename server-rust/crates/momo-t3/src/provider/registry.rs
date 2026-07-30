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

/// Default when the operator names no provider: BYOC needs no credential at all.
pub const FALLBACK_PROVIDER_ID: &str = BYOC_PROVIDER_ID;

/// Every registered adapter id, ascending.
pub fn registered_provider_ids() -> Vec<&'static str> {
    let mut ids = vec![BYOC_PROVIDER_ID, MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID];
    ids.sort_unstable();
    ids
}

pub fn is_registered(provider_id: &str) -> bool {
    registered_provider_ids().contains(&provider_id)
}

/// Capability descriptor for a registry id, or [`T3Error::UnknownProvider`] —
/// an unknown provider fails closed (054 header comment) rather than defaulting
/// to something that can create billable instances.
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
        },
        MOCK_A_PROVIDER_ID => CloudProviderCapabilities {
            provider_id: MOCK_A_PROVIDER_ID.to_string(),
            manages_instance_lifetime: true,
            supports_pause: true,
            resume_semantics: CloudResumeSemantics::Memory,
            continuous_runtime_limit_seconds: Some(3_600),
            pause_seconds_per_gib: Some(4.0),
            max_concurrent_instances: Some(20),
        },
        MOCK_B_PROVIDER_ID => CloudProviderCapabilities {
            provider_id: MOCK_B_PROVIDER_ID.to_string(),
            manages_instance_lifetime: true,
            supports_pause: false,
            resume_semantics: CloudResumeSemantics::ColdBoot,
            continuous_runtime_limit_seconds: Some(900),
            pause_seconds_per_gib: None,
            max_concurrent_instances: Some(5),
        },
        other => return Err(T3Error::UnknownProvider(other.to_string())),
    })
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
