//! Managed cloud-host acquisition — the half of ADR-0136 D1 that BYOC does not
//! have: momo asks a substrate to *boot* an instance (ADR-0156 D4-④).
//!
//! [`crate::cloud_host`] built the acquisition path for a machine the owner
//! already runs. This module builds the one for a machine momo pays a provider
//! to create, and the difference is one HTTP call plus everything that call
//! makes possible to get wrong. The flow is ADR-0136 D1-A, unchanged by the
//! substrate swap of ADR-0156:
//!
//! ```text
//! cloud session request → enroll (durable row, provisioning)
//!                       → adapter.create (outside any transaction)
//!                       → record the instance handle
//!                       → workd boots, spends its bootstrap token
//!                       → the EXISTING register route binds the host (ready)
//!                       → the EXISTING session routing opens the session
//! ```
//!
//! Only the first three steps are new. The last three are
//! `cloud_hosts::register_cloud_host` and `work_sessions::create` as they
//! already stand — "세션 라우팅은 기존 D6 로직" — and this module deliberately
//! adds no second copy of either.
//!
//! ## The bootstrap token is derived, never stored, never re-minted
//!
//! ADR-0136 D2: *"bootstrap token은 process-only key와 provision UUID에서
//! 결정적으로 유도하므로 응답 유실 뒤에도 raw token을 저장하지 않고 같은
//! sandbox로 수렴한다."* That sentence is load bearing and this module is what
//! makes it true.
//!
//! momo keeps only the SHA-256 **digest** of a bootstrap token (045:87-88), so a
//! retry has no way to recover the raw credential it handed the last attempt —
//! and the instance's environment was baked at create time and cannot be
//! rewritten. A token minted freshly per attempt therefore has exactly two
//! outcomes, both of which cost money:
//!
//! * the retry reuses the ledger row and bakes a *different* token into the
//!   instance ⇒ `claim_bootstrap_in_tx` never matches, the paid sandbox can
//!   never register, and it bills until the idle safety net reaps it; or
//! * the retry cannot reuse the row (there is no raw token to re-inject), mints
//!   a **new provision**, and the workspace ends up with one registered host per
//!   attempt — the double registration ADR-0136 named.
//!
//! [`CloudProvisioner::bootstrap_token`] closes both by being a pure function of
//! (process-only secret, provision id): the same provision always yields the
//! same credential, so a retry re-derives what the row already trusts.
//!
//! ## ADR-0004 — the operator credential is not the derivation secret
//!
//! The provider API key is an operator secret that must not travel anywhere the
//! bootstrap material travels. So the secret this module derives tokens from is
//! a **one-way function of it** ([`BootstrapDerivationSecret`]): holding it (or
//! any token derived from it) yields nothing about the key. Both are redacted in
//! `Debug`, because `tracing` renders `Debug`.
//!
//! ## What this module does NOT own
//!
//! Admission ([`crate::billing::reserve_provisioning_slot_in_tx`]), the advisory
//! ladder ([`crate::lifecycle::with_t3_lifecycle_tx`]) and the transition table
//! are the route's and the database's, exactly as for BYOC. The credit and slot
//! decisions are ADR-0136's existing ones and are re-used, not restated.

use std::fmt;
use std::sync::Arc;

use momo_db::PgConnection;
use momo_provider::{
    CloudInstanceRef, CloudInstanceSpec, CloudProviderAdapter, CloudProviderCapabilities,
    CloudProviderError, CloudProviderOperation,
};
use sqlx::Row;
use uuid::Uuid;

use crate::cloud_host::{BootstrapToken, BOOTSTRAP_TTL_SECONDS};
use crate::error::T3Error;

/// Domain separator for the operator-credential → derivation-secret step.
const SECRET_DOMAIN: &str = "momo.t3.bootstrap.secret.v1";
/// Domain separator for the (secret, provision) → token step. Distinct from
/// [`SECRET_DOMAIN`] so the two hash chains can never collide.
const TOKEN_DOMAIN: &str = "momo.t3.bootstrap.token.v1";

/// The process-only material bootstrap tokens are derived from.
///
/// A one-way function of the provider's operator credential
/// ([`BootstrapDerivationSecret::from_operator_credential`]): the adapter that
/// owns the key computes this once at boot, and nothing downstream can walk back
/// to the key. That indirection is the ADR-0004 boundary — a bootstrap token is
/// handed to a sandbox, and a sandbox may never be able to reconstruct the
/// operator's credential from what it was given.
#[derive(Clone, PartialEq, Eq)]
pub struct BootstrapDerivationSecret(String);

impl BootstrapDerivationSecret {
    /// Derive from the provider's operator credential.
    pub fn from_operator_credential(api_key: &str) -> BootstrapDerivationSecret {
        BootstrapDerivationSecret(momo_wire::sha256_hex(
            format!("{SECRET_DOMAIN}\u{1f}{api_key}").as_bytes(),
        ))
    }
}

/// Redacted: `tracing` renders `Debug`, and this value mints credentials.
impl fmt::Debug for BootstrapDerivationSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("BootstrapDerivationSecret")
            .field(&"<redacted>")
            .finish()
    }
}

/// One configured managed substrate, in the shape the provisioning route needs.
///
/// It is the adapter plus the one thing an adapter cannot supply — the
/// deterministic bootstrap credential — and nothing else. In particular it
/// exposes no endpoint, no key and no provider-specific field, so a route layer
/// holding one still reads capabilities and cannot learn which substrate it is
/// talking to (ADR-0142 D2).
pub struct CloudProvisioner {
    provider_id: String,
    adapter: Arc<dyn CloudProviderAdapter>,
    bootstrap_secret: BootstrapDerivationSecret,
}

impl fmt::Debug for CloudProvisioner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudProvisioner")
            .field("provider_id", &self.provider_id)
            .field("bootstrap_secret", &self.bootstrap_secret)
            .finish()
    }
}

impl CloudProvisioner {
    pub fn new(
        provider_id: impl Into<String>,
        adapter: Arc<dyn CloudProviderAdapter>,
        bootstrap_secret: BootstrapDerivationSecret,
    ) -> CloudProvisioner {
        CloudProvisioner {
            provider_id: provider_id.into(),
            adapter,
            bootstrap_secret,
        }
    }

    /// The registry id this provisioner writes into `work_cloud_host.provider`.
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    /// The substrate's declared capabilities — the only channel through which a
    /// caller may learn anything provider-specific.
    pub fn capabilities(&self) -> &CloudProviderCapabilities {
        self.adapter.capabilities()
    }

    /// The one-shot workd credential for a provision — **a pure function of the
    /// provision id**.
    ///
    /// This determinism is the whole of ADR-0136 D2's convergence clause; see the
    /// module header for what re-minting costs. It is asserted directly
    /// ([`tests::the_same_provision_always_derives_the_same_credential`]) and
    /// again end to end by the provisioner conformance suite, because the failure
    /// it prevents is invisible on the happy path.
    pub fn bootstrap_token(&self, provision_id: Uuid) -> BootstrapToken {
        BootstrapToken::from_raw(momo_wire::sha256_hex(
            format!(
                "{TOKEN_DOMAIN}\u{1f}{}\u{1f}{provision_id}",
                self.bootstrap_secret.0
            )
            .as_bytes(),
        ))
    }

    /// Can this substrate boot an instance at all? Asked through the capability
    /// descriptor, never by comparing a provider id (ADR-0142 D2).
    pub fn can_create(&self) -> bool {
        self.capabilities().supports(CloudProviderOperation::Create)
    }

    /// Ask the substrate for one instance.
    ///
    /// **The caller never handles the bootstrap credential.** The spec is
    /// assembled here, so the token exists only between
    /// [`CloudProvisioner::bootstrap_token`] and the adapter that injects it —
    /// a route layer holds the provisioner, asks for a host, and has no value in
    /// hand it could log, echo, or store. (The digest it *does* need reaches it
    /// through `bootstrap_token(..).digest()`, which is the half that is
    /// storable by construction.)
    ///
    /// The idempotency key is the **provision id**, which is also what the
    /// adapter stamps into the instance so a replay can find it again
    /// (ADR-0142 D2). Keying on the durable row rather than on the client's
    /// `idempotencyRef` is deliberate: the row is what survives a lost response,
    /// and the ledger, the token and the instance stamp then all agree on one
    /// identifier.
    ///
    /// A substrate that does not declare `Create` is refused here rather than
    /// called: the degenerate BYOC adapter would otherwise be asked to boot a
    /// machine momo never gained the right to boot (ADR-0142 D1).
    pub async fn provision_instance(
        &self,
        request: &ProvisionRequest<'_>,
    ) -> Result<CloudInstanceRef, CloudProviderError> {
        if !self.can_create() {
            return Err(CloudProviderError::Unsupported {
                operation: CloudProviderOperation::Create,
                provider_id: self.provider_id.clone(),
            });
        }
        let spec = CloudInstanceSpec {
            provision_id: request.provision_id,
            workspace_id: request.workspace_id,
            display_name: request.display_name.to_string(),
            registration_token: self.bootstrap_token(request.provision_id).raw().to_string(),
            server_url: request.server_url.to_string(),
        };
        self.adapter
            .create(&spec, &request.provision_id.to_string())
            .await
    }
}

/// What a route states to acquire one instance. A struct rather than four
/// positional arguments because two of them are `Uuid`s, and a transposed pair
/// would stamp a workspace id where an instance-identifying provision id belongs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProvisionRequest<'a> {
    pub provision_id: Uuid,
    pub workspace_id: Uuid,
    pub display_name: &'a str,
    /// The public momo URL the workd inside the instance registers back against.
    pub server_url: &'a str,
}

/// What a managed enrollment states. Mirrors
/// [`crate::cloud_host::NewByocEnrollment`] with one field removed and that
/// removal is the difference between the two paths: BYOC derives
/// `provider_sandbox_id` from the provision id at insert time because the
/// enrollment *is* the instance, while a managed provision does not know its
/// instance until the substrate answers.
#[derive(Debug, Clone)]
pub struct NewManagedProvision {
    pub provision_id: Uuid,
    pub requester_member_id: Uuid,
    /// A registry id (054), never a vendor name a policy may test.
    pub provider: String,
    pub bootstrap_token_digest: String,
    pub unit_rate_micro_usd_second: i64,
    pub idempotency_key: Uuid,
    pub requested_display_name: String,
}

/// A managed provision as the REST surface reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedProvision {
    pub provision_id: Uuid,
    pub state: String,
    pub provider: String,
    pub bootstrap_expires_at_ms: i64,
    /// The substrate has named an instance for this row. Until it is `true` the
    /// workd's registration cannot lift the host past `provisioning`
    /// (`bind_cloud_host_in_tx`'s `CASE WHEN provider_sandbox_id IS NOT NULL`).
    pub instance_known: bool,
    /// This `idempotencyRef` had already produced a provision.
    pub replayed: bool,
}

/// The provision this `idempotencyRef` already made, under `FOR UPDATE`.
///
/// Not [`crate::cloud_host::find_enrollment_by_idempotency_key_in_tx`] because
/// the managed path needs one more fact — whether the substrate has already
/// named an instance — and that fact is what decides whether the retry calls the
/// provider again or simply reports what is already true. Folding it into the
/// BYOC read would give that path a column it has no branch for.
pub async fn find_managed_provision_by_idempotency_key_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    idempotency_key: Uuid,
) -> Result<Option<ManagedProvision>, T3Error> {
    let row = sqlx::query(
        "SELECT id, provider, state, provider_sandbox_id IS NOT NULL AS instance_known, \
                floor(extract(epoch from bootstrap_expires_at) * 1000)::bigint AS expires_ms \
           FROM work_cloud_host \
          WHERE workspace_id = $1 AND create_idempotency_key = $2 \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(idempotency_key)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(ManagedProvision {
        provision_id: row.try_get("id")?,
        state: row.try_get("state")?,
        provider: row.try_get("provider")?,
        bootstrap_expires_at_ms: row.try_get("expires_ms")?,
        instance_known: row.try_get("instance_known")?,
        replayed: true,
    }))
}

/// Create the durable provisioning row — **before** the provider is called.
///
/// The ordering is ADR-0136 D2's ("durable intent를 provider 호출보다 먼저
/// 커밋"): an instance that exists with no row is money nobody can name, while a
/// row that exists with no instance is a retry. Only one of those two is
/// recoverable, so the row goes first.
///
/// `provider_sandbox_id` stays NULL, which `work_cloud_host_sandbox_ck` (045:110)
/// permits precisely while the state is `provisioning` — the schema already
/// modelled this half-built state and no new column is needed for it.
///
/// The caller must already hold [`crate::cloud_host::lock_enrollment_key_in_tx`],
/// must have found no prior provision, and must have passed admission
/// ([`crate::billing::reserve_provisioning_slot_in_tx`]) — the same three
/// obligations the BYOC enrollment carries, for the same reasons.
pub async fn enroll_managed_cloud_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    new: &NewManagedProvision,
) -> Result<ManagedProvision, T3Error> {
    let row = sqlx::query(
        "INSERT INTO work_cloud_host \
           (id, workspace_id, requester_member_id, provider, \
            bootstrap_token_digest, bootstrap_expires_at, unit_rate_micro_usd_second, \
            create_idempotency_key, requested_display_name) \
         VALUES ($1, $2, $3, $4, $5, \
                 clock_timestamp() + make_interval(secs => $6), $7, $8, $9) \
         RETURNING state, \
                   floor(extract(epoch from bootstrap_expires_at) * 1000)::bigint AS expires_ms",
    )
    .bind(new.provision_id)
    .bind(workspace_id)
    .bind(new.requester_member_id)
    .bind(&new.provider)
    .bind(&new.bootstrap_token_digest)
    .bind(BOOTSTRAP_TTL_SECONDS as f64)
    .bind(new.unit_rate_micro_usd_second)
    .bind(new.idempotency_key)
    .bind(&new.requested_display_name)
    .fetch_one(&mut *conn)
    .await?;

    Ok(ManagedProvision {
        provision_id: new.provision_id,
        state: row.try_get("state")?,
        provider: new.provider.clone(),
        bootstrap_expires_at_ms: row.try_get("expires_ms")?,
        instance_known: false,
        replayed: false,
    })
}

/// Bind the instance the substrate named to its ledger row — **first writer
/// wins**.
///
/// `COALESCE` rather than an overwrite, and the reason is the ledger-side twin of
/// the adapter's "converge on the lowest id" rule. Two creates that interleave
/// past the metadata reconstruction produce two instances for one provision
/// (the managed adapter's module header names the same window). When that
/// happens the row must keep the handle it already published — the one a probe,
/// a pause or a destroy has possibly already been issued against — and the
/// newcomer must be reported rather than silently substituted, because a client
/// that reads a handle must keep reading the same one. The loser is bounded by the idle
/// safety net (ADR-0156 D6②); an overwrite here would instead leak the *first*
/// instance forever, because nothing would remember its id.
///
/// No state change: the row stays `provisioning` until the workd registers, so
/// `work_cloud_host_transition_guard` is never consulted. That is the whole
/// reason `bind_cloud_host_in_tx` reads `provider_sandbox_id IS NOT NULL` when
/// it decides between `ready` and `provisioning` — this write is what makes that
/// branch true.
pub async fn record_provider_instance_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    provision_id: Uuid,
    instance_id: &str,
) -> Result<String, T3Error> {
    let stored: Option<String> = sqlx::query_scalar(
        "UPDATE work_cloud_host \
            SET provider_sandbox_id = COALESCE(provider_sandbox_id, $3), \
                updated_at = clock_timestamp() \
          WHERE workspace_id = $1 AND id = $2 \
          RETURNING provider_sandbox_id",
    )
    .bind(workspace_id)
    .bind(provision_id)
    .bind(instance_id)
    .fetch_optional(&mut *conn)
    .await?;

    let stored = stored.ok_or(T3Error::CloudHostNotFound)?;
    if stored != instance_id {
        tracing::error!(
            cloud_host_id = %provision_id,
            "a second provider instance answered for a provision that already has one — the \
             create-path exclusion did not hold. Keeping the published handle and leaving the \
             newcomer to the substrate's idle safety net"
        );
    }
    Ok(stored)
}

/// Read one managed provision for display, after the provider call.
pub async fn load_managed_provision_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    provision_id: Uuid,
) -> Result<Option<ManagedProvision>, T3Error> {
    let row = sqlx::query(
        "SELECT id, provider, state, provider_sandbox_id IS NOT NULL AS instance_known, \
                floor(extract(epoch from bootstrap_expires_at) * 1000)::bigint AS expires_ms \
           FROM work_cloud_host \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(provision_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(ManagedProvision {
        provision_id: row.try_get("id")?,
        state: row.try_get("state")?,
        provider: row.try_get("provider")?,
        bootstrap_expires_at_ms: row.try_get("expires_ms")?,
        instance_known: row.try_get("instance_known")?,
        replayed: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_host::bootstrap_token_digest;
    use crate::provider::{ByocProviderAdapter, MockProviderAdapter};
    use crate::provider::{BYOC_PROVIDER_ID, MOCK_A_PROVIDER_ID};

    fn provisioner_for(secret: &str, provider_id: &str) -> CloudProvisioner {
        let adapter: Arc<dyn CloudProviderAdapter> = if provider_id == BYOC_PROVIDER_ID {
            Arc::new(ByocProviderAdapter::new())
        } else {
            Arc::new(MockProviderAdapter::mock_a())
        };
        CloudProvisioner::new(
            provider_id,
            adapter,
            BootstrapDerivationSecret::from_operator_credential(secret),
        )
    }

    /// ADR-0136 D2's convergence clause, stated as an equality.
    #[test]
    fn the_same_provision_always_derives_the_same_credential() {
        let provisioner = provisioner_for("operator-issued-key", MOCK_A_PROVIDER_ID);
        let provision = Uuid::from_u128(41);

        let first = provisioner.bootstrap_token(provision);
        let second = provisioner.bootstrap_token(provision);
        assert_eq!(
            first.raw(),
            second.raw(),
            "named regression: momo stores only the DIGEST, so a retry that mints a fresh token \
             can never hand the instance a credential the ledger row will honour — the paid \
             sandbox registers never, or a second provision registers twice (ADR-0136 D2)"
        );
        assert_eq!(first.digest(), bootstrap_token_digest(second.raw()));

        // …and it is still a credential: a different provision, or a different
        // operator secret, is a different token.
        assert_ne!(
            first.raw(),
            provisioner.bootstrap_token(Uuid::from_u128(42)).raw()
        );
        assert_ne!(
            first.raw(),
            provisioner_for("a-different-key", MOCK_A_PROVIDER_ID)
                .bootstrap_token(provision)
                .raw()
        );
    }

    /// The shape `work_cloud_host_digest_ck` and the `MomoBootstrap` header
    /// bounds both demand (40…128 characters, `^[0-9a-f]{64}$` for the digest).
    #[test]
    fn a_derived_token_has_the_shape_the_register_route_accepts() {
        let token = provisioner_for("operator-issued-key", MOCK_A_PROVIDER_ID)
            .bootstrap_token(Uuid::from_u128(7));
        assert_eq!(token.raw().len(), 64);
        assert!((40..=128).contains(&token.raw().len()));
        assert_eq!(token.digest().len(), 64);
        assert!(token
            .digest()
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    /// ADR-0004 — neither the operator credential nor the derivation secret may
    /// reach a log line, and a bootstrap token must not be a way back to the key.
    #[test]
    fn nothing_here_renders_or_reveals_the_operator_credential() {
        const KEY: &str = "super-secret-operator-key";
        let provisioner = provisioner_for(KEY, MOCK_A_PROVIDER_ID);
        let rendered = format!("{provisioner:?}");
        assert!(
            !rendered.contains(KEY) && rendered.contains("<redacted>"),
            "provider credential must never reach a Debug rendering: {rendered}"
        );

        let token = provisioner.bootstrap_token(Uuid::from_u128(3));
        assert!(
            !token.raw().contains(KEY) && !token.digest().contains(KEY),
            "the credential a sandbox receives must not carry the operator's key"
        );
        // The secret is one-way: it is not the key, and not a reversible
        // encoding of it.
        let secret = BootstrapDerivationSecret::from_operator_credential(KEY);
        assert_ne!(secret.0, KEY);
        assert_eq!(secret.0.len(), 64);
    }

    fn provision_request(provision_id: Uuid) -> ProvisionRequest<'static> {
        ProvisionRequest {
            provision_id,
            workspace_id: Uuid::from_u128(6),
            display_name: "managed box",
            server_url: "https://momo.invalid",
        }
    }

    /// ADR-0142 D1 — the degenerate adapter is refused *before* the call, not
    /// after it fails. momo never gained the right to boot the owner's machine.
    #[tokio::test]
    async fn a_degenerate_provider_is_refused_rather_than_asked_to_boot() {
        let provisioner = provisioner_for("unused", BYOC_PROVIDER_ID);
        assert!(!provisioner.capabilities().manages_instance_lifetime);
        assert!(!provisioner.can_create());
        assert!(matches!(
            provisioner
                .provision_instance(&provision_request(Uuid::from_u128(5)))
                .await,
            Err(CloudProviderError::Unsupported {
                operation: CloudProviderOperation::Create,
                ..
            })
        ));
    }

    /// The provider idempotency key is the durable row's id, not the client's
    /// ref — the row is what survives a lost response.
    #[tokio::test]
    async fn the_provider_idempotency_key_is_the_provision_id() {
        let provisioner = provisioner_for("unused", MOCK_A_PROVIDER_ID);
        let request = provision_request(Uuid::from_u128(77));
        let first = provisioner
            .provision_instance(&request)
            .await
            .expect("create");
        let replay = provisioner
            .provision_instance(&request)
            .await
            .expect("replay");
        assert_eq!(
            first, replay,
            "a replayed create keyed by the same provision must converge on one instance"
        );
        assert_ne!(
            first,
            provisioner
                .provision_instance(&provision_request(Uuid::from_u128(78)))
                .await
                .expect("a different provision"),
            "a different provision is a different instance"
        );
    }
}
