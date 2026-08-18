//! `momo-auth` — authentication foundation.
//!
//! Ports the two credential surfaces the server authenticates:
//!   * App JWT (HS256, `sub=member_id`, `ws`, `scopes`, `typ`) → [`jwt`]
//!     (Swift `Auth/JWT.swift`, `Auth/AuthMiddleware.swift`).
//!   * WorkHost Ed25519 request signature → [`workhost`], which verifies via the
//!     shared `momo-wire` format (no duplicated format string).
//!
//! B0 scope: JWT verify skeleton + [`Principal`] + WorkHost verify wrapper.
//! B1.5 adds the other half of the App-JWT story: issuance ([`issue`]) and the
//! MOMO-300 **revocation check** ([`token_store`]) — the `token` table row that
//! turns "this was signed once" into "this session is still alive". Signature
//! and row are checked together by the server's middleware, exactly as Swift
//! `AuthMiddleware` does (verify → `requireActive`).
//! B1.6 adds what *writes* that row's `revoked_at`
//! ([`token_store::revoke_token`], [`token_store::revoke_privileged_session_tokens`])
//! plus refresh-token verification ([`jwt::verify_app_refresh`]), so the
//! logout/refresh routes can end a session instead of only observing one.
//!
//! This crate owns `token` SQL and nothing else DB-shaped: [`token_store`] takes
//! a caller-supplied `&mut PgConnection`, so the RLS GUC seam stays solely in
//! `momo_db::with_tenant_tx` (invariant #6).

//! B2.2 adds the two DB-backed halves the T3 REST surface needs and that no
//! other crate may own: the **WorkHost credential registry**
//! ([`work_host_store`] — a `work_host` row is a credential exactly like a
//! `token` row) and the **workspace-role authority**
//! ([`workspace_authorization`], the single `workspace_membership` predicate),
//! plus heartbeat-signature verification in [`workhost`].

//! B2.4 adds the third credential path this server authenticates: the **signed
//! work-host request** ([`work_host_request`] — v2 payload + one-time request
//! id, migration 048). B2.2 stopped at the heartbeat signature, which is a
//! liveness ping; a request *acts*, so it binds method/path/body digest and is
//! replay-protected by consuming its id. Only the DB halves live here — the
//! cryptographic verdict is [`workhost::verify_work_host_request`] and header
//! parsing is the route's, the same split the heartbeat already uses.

//! B2.6 adds the fourth credential surface and the one that finally makes an
//! agent a first-class caller: the **agent bearer** ([`agent_bearer`] — a
//! `token` row with `kind = 'agent_bearer'`, presented as the opaque
//! `momo_agent_v1.<ws>.<secret>` envelope). It is here, next to
//! [`token_store`], because both read the same table under the same revocation
//! contract; and its route→scope allow-list ([`agent_scope`]) is here rather
//! than in the route layer because "which routes an agent credential may reach"
//! is a property of the credential, not of any one handler.

//! B4 adds the **realtime** half of the credential story ([`realtime`]): the
//! short-lived Centrifugo *connection* token, plus the `token`-row predicate the
//! subscribe proxy re-checks on every subscribe
//! ([`token_store::has_active_realtime_credential`]). Both live here for the
//! same reason the rest does — one is a signing key this crate already owns a
//! sibling of, and the other is `token` SQL, which no other crate may write.

//! goal SRV-T2 (ADR-0149) adds the fifth credential, and the first one whose
//! purpose is to make an authorization check **cheap enough to repeat**: the
//! [`ephemeral_grant`] — a 60-second, member-and-channel-bound proof that
//! `is_channel_member` already said yes. It lives here rather than in
//! `momo-ephemeral` because credentials live in this crate, and because
//! `momo-ephemeral` holds neither crypto nor a database — which is exactly what
//! makes the 휘발 publish path provably Postgres-free (ADR-0149 guard 3).

pub mod agent_bearer;
pub mod agent_credential;
pub mod agent_scope;
pub mod ephemeral_grant;
pub mod hosted_connection;
pub mod hosted_disconnect;
pub mod hosted_oauth;
pub mod issue;
pub mod jwt;
pub mod realtime;
pub mod token_store;
pub mod work_host_request;
pub mod work_host_store;
pub mod workhost;
pub mod workspace_authorization;

pub use agent_bearer::{
    agent_bearer_workspace_id, classify_agent_bearer_in_tx, finalize_agent_bearer_use_in_tx,
    resolve_agent_bearer_in_tx, AgentBearerClass, AgentBearerIdentity, AgentBearerRejection,
    AgentBearerResolution, AGENT_BEARER_PREFIX, AUDIT_ACTION_SCOPE_DENIED, AUDIT_ACTION_USED,
    AUDIT_DETAIL_SCHEMA,
};
pub use agent_credential::{
    active_agent_for_credential_list, agent_credential_mutation_policy_in_tx,
    agent_credential_requires_instance_operator, issue_agent_credential_in_tx,
    list_agent_credentials_in_tx, mint_agent_bearer, normalized_agent_credential_label,
    normalized_agent_credential_reason, normalized_agent_credential_scopes,
    revoke_agent_credential_in_tx, validated_agent_credential_expiry,
    validated_rotation_grace_seconds, AgentCredentialInputError, AgentCredentialIssuance,
    AgentCredentialIssueError, AgentCredentialMutation, AgentCredentialMutationPolicy,
    AgentCredentialRecord, AgentCredentialRevocation, AgentCredentialStatus, AUDIT_ACTION_ISSUED,
    AUDIT_ACTION_REVOKED, AUDIT_SCHEMA_ISSUED, AUDIT_SCHEMA_REVOKED,
    DEFAULT_AGENT_CREDENTIAL_LABEL, DEFAULT_AGENT_CREDENTIAL_SCOPES,
    DEFAULT_ROTATION_GRACE_SECONDS, HOSTED_CONNECTION_MANAGED_CODE, MAXIMUM_ROTATION_GRACE_SECONDS,
};
pub use agent_scope::{
    is_gateway_callback_route, required_agent_scope, SCOPE_AGENT_INBOX_READ, SCOPE_AGENT_JOBS_READ,
    SCOPE_AGENT_PORT_CONNECT, SCOPE_AGENT_RUNS_CALLBACK, SCOPE_MESSAGES_READ, SCOPE_MESSAGES_WRITE,
};
pub use ephemeral_grant::{
    ephemeral_grant_key, sign_ephemeral_grant, verify_ephemeral_grant, EphemeralGrantClaims,
    EphemeralGrantRejection, EphemeralGrantScope, IssuedEphemeralGrant,
    EPHEMERAL_GRANT_TTL_SECONDS, EPHEMERAL_GRANT_TYP,
};
pub use hosted_connection::{
    active_hosted_connection_in_tx, confirm_hosted_connection_in_tx,
    create_hosted_connection_in_tx, detect_pairing_in_tx, get_hosted_connection_in_tx,
    is_hosted_agent_activated_in_tx, is_hosted_agent_in_tx, list_hosted_connections_in_tx,
    pairing_workspace_id, prove_hosted_binding_in_tx, regenerate_pairing_in_tx,
    resolve_hosted_tool_identity_in_tx, resolve_pairing_in_tx, validate_channel_ids,
    validate_hosted_scopes, HostedActivationIssuance, HostedConnection, HostedConnectionApproval,
    HostedInputError, HostedMutation, HostedPairingIssuance, HostedProof, HostedToolIdentity,
    HOSTED_AGENT_INERT_BASE_URL, HOSTED_AGENT_MODEL, HOSTED_AGENT_PORT_AUDIENCE,
    HOSTED_AGENT_SCOPES, HOSTED_PAIRING_PREFIX, HOSTED_PAIRING_TTL_SECONDS,
};
pub use hosted_disconnect::{
    acknowledge_hosted_artifact_in_tx, artifact_audit_detail, complete_hosted_disconnect_in_tx,
    count_unresolved_required_artifacts_in_tx, expected_action_for_kind,
    list_hosted_artifacts_in_tx, reconcile_dead_hosted_credential_in_tx,
    reconcile_hosted_connection_in_tx, start_hosted_disconnect_in_tx, stored_disposition,
    validate_artifact_evidence, validate_artifact_seeds, validate_artifact_status, HostedArtifact,
    HostedArtifactAck, HostedArtifactAcknowledged, HostedArtifactAcknowledgement,
    HostedArtifactInputError, HostedArtifactSeed, HostedDisconnectCompletion,
    HostedDisconnectStart, HostedDisconnectStarted, HOSTED_ARTIFACT_KINDS,
    HOSTED_DISCONNECTABLE_STATES, MAX_ARTIFACT_EVIDENCE_BYTES, MAX_ARTIFACT_ITEMS,
    MAX_ARTIFACT_REF_BYTES,
};
pub use hosted_oauth::{
    approve_hosted_oauth_request_in_tx, consume_hosted_oauth_code_in_tx,
    deny_hosted_oauth_request_in_tx, hosted_oauth_access_workspace_id,
    hosted_oauth_code_workspace_id, hosted_oauth_refresh_workspace_id, hosted_oauth_request_key,
    list_oauth_candidates_in_tx, lock_hosted_oauth_code_in_tx, resolve_hosted_oauth_access_in_tx,
    resolve_hosted_oauth_revocation_target_in_tx, revoke_hosted_oauth_family_in_tx,
    rotate_hosted_oauth_refresh_in_tx, sign_authorization_request, verify_authorization_request,
    AuthorizationRequestSeed, HostedOauthApproval, HostedOauthCandidate, HostedOauthCodeLock,
    HostedOauthIssuance, HostedOauthRefresh, HostedOauthRefusal, HostedOauthRequestClaims,
    HOSTED_OAUTH_ACCESS_PREFIX, HOSTED_OAUTH_ACCESS_TTL_SECONDS, HOSTED_OAUTH_CODE_PREFIX,
    HOSTED_OAUTH_CODE_TTL_SECONDS, HOSTED_OAUTH_REFRESH_PREFIX, HOSTED_OAUTH_REFRESH_TTL_SECONDS,
    HOSTED_OAUTH_REQUEST_TTL_SECONDS, HOSTED_OAUTH_REQUEST_TYP,
};
pub use issue::{
    sign_access, sign_app_token, sign_refresh, IssuedToken, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS,
};
pub use jwt::{
    verify_app_access, verify_app_refresh, AppClaims, AuthError, Principal, PrincipalKind,
};
pub use realtime::{
    realtime_info_string, sign_centrifugo_connection, CentrifugoConnectionClaims,
    IssuedRealtimeToken, RealtimeTokenMeta, CONNECTION_TOKEN_TTL_SECONDS, REALTIME_INFO_SCHEMA,
    REALTIME_META_SCHEMA,
};
pub use token_store::{
    carries_privileged_scope, has_active_realtime_credential, record_session_token,
    revoke_privileged_session_tokens, revoke_token, token_state, without_privileged_scopes,
    RevokeOutcome, TokenRejection, TokenState, PRIVILEGED_SCOPES, SCOPE_REALTIME_SUBSCRIBE,
    SESSION_LABEL_ACCESS, SESSION_LABEL_REFRESH,
};
pub use work_host_request::{
    consume_work_host_request_id, load_work_host_signing_credential, WorkHostSigningCredential,
    REQUEST_REPLAY_RETENTION_MINUTES,
};
pub use work_host_store::{
    insert_work_host, list_work_hosts, load_work_host, lock_work_host_credential,
    lock_work_host_ownership, mark_work_host_revoked, touch_work_host_last_seen, NewWorkHost,
    WorkHostCredential, WorkHostOwnership, WorkHostRecord, ONLINE_WINDOW_SECONDS,
};
pub use workhost::{
    heartbeat_timestamp_is_fresh, normalize_public_key_b64, verify_work_host_heartbeat,
    verify_work_host_request, HEARTBEAT_CLOCK_SKEW_MS,
};
pub use workspace_authorization::{active_workspace_role, verified_operator_email, WorkspaceRole};
