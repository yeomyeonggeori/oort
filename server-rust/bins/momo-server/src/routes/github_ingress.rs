//! GitHub App receive, link and subscribe — the workspace side of ADR-0205 (#3954 E-GH2).
//!
//! ```text
//! POST   /v1/integrations/github/webhook                      public, X-Hub-Signature-256
//! GET    /v1/integrations/github/setup                        public, GitHub's setup-URL redirect
//! POST   /v1/workspaces/{ws}/github/link                      owner/admin: mint the install state
//! GET    /v1/workspaces/{ws}/github                           owner/admin: installations + subscriptions
//! POST   /v1/workspaces/{ws}/github/subscriptions             owner/admin: subscribe a channel
//! DELETE /v1/workspaces/{ws}/github/subscriptions/{id}        owner/admin
//! GET    /v1/integrations/github/installations                instance operator: unlinked installations
//! POST   /v1/integrations/github/installations/{id}/link      instance operator: attach to a workspace
//! ```
//!
//! ## The receiver's order (ADR-0205 D4, ADR-0115's skeleton)
//!
//! **signature → body size → (parse) → rate budget → replay → render → write.**
//!
//! * The body is read under the 5 MiB GitHub-mode ceiling (413) before it is authenticated,
//!   exactly as ADR-0115's native mode does: the HMAC needs the bytes.
//! * To verify, the receiver must read the sealed secret, and `github_app` is readable only under
//!   `app.github_ingress`. So a **read-only** transaction with that GUC runs first, and the
//!   invariant the ADR needs is not "no transaction before the signature" but "**no write before
//!   `github_signature_matches` returned true**". A refusal returns 401 from that read-only
//!   transaction: no receipt, no installation row, no message.
//! * The rate budget is per installation (`github:{installation_id}`), so it needs the payload's
//!   installation id and therefore runs after the (signed) JSON parse. ADR-0205 listed rate before
//!   parse; the payload is authenticated by then, so the difference is a parse of a signed body.
//! * Replay is `X-GitHub-Delivery` idempotence in `github_receipt`, with **no time window**
//!   (the signature carries no timestamp; ADR-0115 D1 deviation recorded in ADR-0205 D4). For a
//!   linked installation the receipt is claimed **before** any lifecycle write, so a stale
//!   redelivered `suspend` cannot undo a later `unsuspend`.
//!
//! Messages go through `momo_messaging::send_message_in_tx` only, with a deterministic
//! `client_msg_id` of `(delivery, channel)`, under the workspace's dedicated non-login 「GitHub」
//! author. Nothing here inserts into `message` or `outbox` directly.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_github_app_admin_tx, with_github_tx, GithubGuc, GithubScope};
use momo_messaging::{MessageType, NewMessage};
use momo_settings::github_app::open_github_webhook_secret;
use momo_settings::github_ingress::{
    add_repositories, channel_kind, complete_link, delete_subscription, discard_claim,
    ensure_author_in_channel, ensure_workspace_author, find_installation, find_link_candidate,
    find_repository, find_workspace_author, insert_install_claim, insert_receipt,
    learn_subscription_repo_id, list_repositories, list_subscriptions, list_unlinked_installations,
    list_workspace_installations, lock_installation_link, mark_installation,
    matching_subscriptions, operator_link_installation, peek_install_claim, read_app_slug,
    read_webhook_secrets, record_claim_installation, refresh_repository_facts, remove_repositories,
    replace_repositories, set_installation_subscriptions_active,
    set_repository_subscriptions_active, try_link_installation, upsert_installation,
    upsert_subscription, InstallationFacts, InstallationMark, InstallationRecord, LinkCandidate,
    LinkOutcome, NewSubscription, RepositoryFacts, SubscriptionRecord, INSTALL_STATE_TTL_SECONDS,
};
use momo_settings::{new_state_token, state_hash, state_workspace_hint};
use momo_webhook::{
    deterministic_client_message_id, github_signature_matches,
    installation_id as payload_installation_id, installation_info, is_known_feature,
    render_notification, repositories as payload_repositories, valid_github_delivery_id,
    GITHUB_AUTHOR_PROP, GITHUB_DEFAULT_FEATURES, GITHUB_MAXIMUM_BODY_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::github_app::master_key;
use crate::routes::shared::{
    audit_via_token_id, require_human, require_instance_operator, require_instance_operator_write,
    settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

const AUDIT_SCHEMA: &str = "oort.github_ingress.audit.v1";
pub const AUDIT_LINK_STARTED: &str = "github.link_started";
pub const AUDIT_INSTALLATION_LINKED: &str = "github.installation_linked";
pub const AUDIT_SUBSCRIBED: &str = "github.subscribed";
pub const AUDIT_UNSUBSCRIBED: &str = "github.unsubscribed";
/// Same action string as the other ingress modes (ADR-0004 증보 4 D3).
pub const WEBHOOK_RATE_LIMITED_ACTION: &str = "webhook.rate_limited";

const INVALID_SIGNATURE: &str = "invalid webhook signature";
const BODY_TOO_LARGE: &str = "webhook body exceeds the GitHub limit";

fn installation_audit_target(installation_id: i64) -> Uuid {
    deterministic_client_message_id(&["github-installation", &installation_id.to_string()])
}

fn header_str<'a>(request: &'a Request<Body>, name: &str) -> Option<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

// ---------------------------------------------------------------------------
// POST /v1/integrations/github/webhook
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReceiveResponse {
    ok: bool,
    event: String,
    duplicate: bool,
    /// Messages written for this delivery.
    delivered: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    ignored: Option<&'static str>,
}

impl ReceiveResponse {
    fn new(event: &str) -> ReceiveResponse {
        ReceiveResponse {
            ok: true,
            event: event.to_string(),
            duplicate: false,
            delivered: 0,
            ignored: None,
        }
    }

    fn ignored(event: &str, reason: &'static str) -> ReceiveResponse {
        ReceiveResponse {
            ignored: Some(reason),
            ..ReceiveResponse::new(event)
        }
    }
}

enum ReceiveOutcome {
    Ok(ReceiveResponse),
    RateLimited { retry_after_seconds: u64 },
}

impl ReceiveOutcome {
    fn into_response(self) -> Response {
        match self {
            ReceiveOutcome::Ok(body) => (StatusCode::OK, Json(body)).into_response(),
            ReceiveOutcome::RateLimited {
                retry_after_seconds,
            } => {
                let mut response =
                    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded")
                        .into_response();
                if let Ok(value) = retry_after_seconds.to_string().parse() {
                    response.headers_mut().insert("retry-after", value);
                }
                response
            }
        }
    }
}

fn body_too_large() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, BODY_TOO_LARGE)
}

async fn collect_body(request: Request<Body>) -> Result<axum::body::Bytes, ApiError> {
    if let Some(length) = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if length > GITHUB_MAXIMUM_BODY_BYTES {
            return Err(body_too_large());
        }
    }
    to_bytes(request.into_body(), GITHUB_MAXIMUM_BODY_BYTES)
        .await
        .map_err(|_| body_too_large())
}

fn rate_key(installation_id: i64) -> String {
    format!("github:{installation_id}")
}

struct RateDenial {
    retry_after_seconds: u64,
    log_reservation: Option<u64>,
}

type RateReservation = Arc<Mutex<Option<(String, u64)>>>;

/// What the two closures of the receiving transaction share.
#[derive(Default)]
struct Shared {
    /// The installation lifecycle writes already ran in the resolve step (unlinked path).
    applied: bool,
    /// A single live claim names this installation: `(claim, minter)`. Linked in the tenant
    /// body, after the minter is confirmed to still be an owner/admin.
    pending_link: Option<(Uuid, Uuid)>,
}

/// The facts a signed, parsed delivery carries into the transaction.
#[derive(Clone)]
struct Delivery {
    event: String,
    action: String,
    delivery_id: String,
    installation_id: i64,
    payload: Arc<Value>,
}

fn is_installation_event(event: &str) -> bool {
    matches!(event, "installation" | "installation_repositories")
}

fn facts_of(payload: &Value) -> Option<InstallationFacts> {
    installation_info(payload).map(|info| InstallationFacts {
        id: info.id,
        account_login: info.account_login,
        account_type: info.account_type,
        repository_selection: info.repository_selection,
    })
}

fn repo_facts(payload: &Value, key: &str) -> Vec<RepositoryFacts> {
    payload_repositories(payload, key)
        .into_iter()
        .map(|repo| RepositoryFacts {
            id: repo.id,
            full_name: repo.full_name,
            private: repo.private,
        })
        .collect()
}

/// The installation lifecycle writes of one signed event. Needs `app.github_ingress`.
/// Returns the subscription effect to apply once a workspace is known.
enum SubscriptionEffect {
    None,
    InstallationOff,
    RepositoriesOff(Vec<RepositoryFacts>),
    RepositoriesOn(Vec<RepositoryFacts>),
}

async fn apply_installation_event(
    conn: &mut momo_db::PgConnection,
    delivery: &Delivery,
) -> Result<SubscriptionEffect, momo_db::DbError> {
    let payload = &delivery.payload;
    let Some(facts) = facts_of(payload) else {
        return Ok(SubscriptionEffect::None);
    };
    match (delivery.event.as_str(), delivery.action.as_str()) {
        ("installation", "created") => {
            upsert_installation(conn, &facts, true).await?;
            replace_repositories(conn, facts.id, &repo_facts(payload, "repositories")).await?;
            Ok(SubscriptionEffect::None)
        }
        ("installation", "deleted") => {
            upsert_installation(conn, &facts, false).await?;
            mark_installation(conn, facts.id, InstallationMark::Removed).await?;
            Ok(SubscriptionEffect::InstallationOff)
        }
        ("installation", "suspend") => {
            upsert_installation(conn, &facts, false).await?;
            mark_installation(conn, facts.id, InstallationMark::Suspended).await?;
            Ok(SubscriptionEffect::None)
        }
        ("installation", "unsuspend") => {
            upsert_installation(conn, &facts, false).await?;
            mark_installation(conn, facts.id, InstallationMark::Unsuspended).await?;
            Ok(SubscriptionEffect::None)
        }
        ("installation_repositories", "added") => {
            upsert_installation(conn, &facts, false).await?;
            let added = repo_facts(payload, "repositories_added");
            add_repositories(conn, facts.id, &added).await?;
            Ok(SubscriptionEffect::RepositoriesOn(added))
        }
        ("installation_repositories", "removed") => {
            upsert_installation(conn, &facts, false).await?;
            let removed = repo_facts(payload, "repositories_removed");
            let ids: Vec<i64> = removed.iter().map(|repo| repo.id).collect();
            remove_repositories(conn, facts.id, &ids).await?;
            Ok(SubscriptionEffect::RepositoriesOff(removed))
        }
        // `new_permissions_accepted` and anything GitHub adds later: refresh the account facts only.
        _ => {
            upsert_installation(conn, &facts, false).await?;
            Ok(SubscriptionEffect::None)
        }
    }
}

async fn apply_subscription_effect(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    installation_id: i64,
    effect: SubscriptionEffect,
) -> Result<(), momo_db::DbError> {
    match effect {
        SubscriptionEffect::None => {}
        SubscriptionEffect::InstallationOff => {
            set_installation_subscriptions_active(conn, workspace_id, installation_id, false)
                .await?;
        }
        SubscriptionEffect::RepositoriesOff(repositories) => {
            set_repository_subscriptions_active(
                conn,
                workspace_id,
                installation_id,
                &repositories,
                false,
            )
            .await?;
        }
        SubscriptionEffect::RepositoriesOn(repositories) => {
            set_repository_subscriptions_active(
                conn,
                workspace_id,
                installation_id,
                &repositories,
                true,
            )
            .await?;
        }
    }
    Ok(())
}

async fn write_link_audit(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Option<Uuid>,
    installation_id: i64,
    via: &str,
) -> Result<(), momo_db::DbError> {
    let mut entry = AuditEntry::new(workspace_id, AUDIT_INSTALLATION_LINKED)
        .target(
            "github_installation",
            installation_audit_target(installation_id),
        )
        .with_schema(
            AUDIT_SCHEMA,
            json!({ "installation_id": installation_id, "via": via }),
        );
    if let Some(member_id) = member_id {
        entry = entry.by(member_id);
    }
    write_audit(conn, &entry).await?;
    Ok(())
}

pub async fn receive(
    State(state): State<AppState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let key = master_key(&state)?.to_string();

    // 1. Headers. A missing signature is a 401 before anything is read.
    let signature = header_str(&request, "x-hub-signature-256")
        .ok_or_else(|| ApiError::unauthorized(INVALID_SIGNATURE))?
        .to_string();
    let event = header_str(&request, "x-github-event")
        .filter(|event| (1..=64).contains(&event.len()))
        .ok_or_else(|| ApiError::bad_request("missing X-GitHub-Event"))?
        .to_string();
    let delivery_id = header_str(&request, "x-github-delivery")
        .filter(|id| valid_github_delivery_id(id))
        .ok_or_else(|| ApiError::bad_request("missing or invalid X-GitHub-Delivery"))?
        .to_string();

    // 2. Body, under the GitHub-mode ceiling.
    let raw_body = collect_body(request).await?;

    // 3. Signature — a read-only transaction. Nothing is written before this passes.
    let sealed = with_github_tx(
        &state.pool,
        &[GithubGuc::Ingress],
        |conn| {
            Box::pin(async move {
                Ok::<_, momo_db::DbError>(GithubScope::Done(read_webhook_secrets(conn).await?))
            })
        },
        |_, _| Box::pin(async move { Ok(None) }),
    )
    .await
    .map_err(|error| ApiError::internal("github.receive.secrets", error))?;
    let Some(sealed) = sealed else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "GitHub 앱이 아직 등록되지 않았어요.",
        ));
    };
    let mut candidates = vec![sealed.current];
    candidates.extend(sealed.previous);
    let verified = candidates
        .iter()
        .any(|boxed| match open_github_webhook_secret(boxed, &key) {
            Ok(secret) => github_signature_matches(&secret, &raw_body, &signature),
            Err(_) => {
                // A wrong GITHUB_APP_MASTER_KEY or a corrupt box refuses every delivery: say so.
                tracing::error!(
                    "github webhook secret could not be opened with GITHUB_APP_MASTER_KEY"
                );
                false
            }
        });
    if !verified {
        return Err(ApiError::unauthorized(INVALID_SIGNATURE));
    }

    // 4. Parse (authenticated now).
    let payload: Value = serde_json::from_slice(&raw_body)
        .map_err(|_| ApiError::bad_request("webhook body is not JSON"))?;
    drop(raw_body);

    if event == "ping" {
        return Ok(ReceiveOutcome::Ok(ReceiveResponse::new("ping")).into_response());
    }
    let Some(installation_id) = payload_installation_id(&payload) else {
        return Ok(
            ReceiveOutcome::Ok(ReceiveResponse::ignored(&event, "no_installation")).into_response(),
        );
    };
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let delivery = Delivery {
        event: event.clone(),
        action,
        delivery_id,
        installation_id,
        payload: Arc::new(payload),
    };

    // 5. Rate budget, per installation (0 disables, as for the other ingress modes).
    let per_install = state.webhook.per_installation_limit;
    let window_secs = state.rate_limit.config.window_seconds.max(1);
    let denial = if per_install == 0 {
        None
    } else {
        let verdict = state.rate_limit.limiter.check(
            &rate_key(installation_id),
            per_install,
            Duration::from_secs(window_secs),
        );
        (!verdict.allowed).then_some(RateDenial {
            retry_after_seconds: verdict.retry_after_seconds,
            log_reservation: verdict
                .should_log
                .then_some(verdict.log_reservation)
                .flatten(),
        })
    };
    let reserved: RateReservation = Arc::new(Mutex::new(
        denial
            .as_ref()
            .and_then(|denial| denial.log_reservation)
            .map(|reservation| (rate_key(installation_id), reservation)),
    ));
    let denial = Arc::new(denial);

    // 6. The transaction: resolve the workspace, then receipt → lifecycle → fan-out.
    let shared = Arc::new(Mutex::new(Shared::default()));
    let resolve_shared = Arc::clone(&shared);
    let body_shared = Arc::clone(&shared);
    let resolve_delivery = delivery.clone();
    let body_delivery = delivery;
    let resolve_denial = Arc::clone(&denial);
    let body_denial = Arc::clone(&denial);

    let outcome: DbRejectable<ReceiveOutcome> = with_github_tx(
        &state.pool,
        &[GithubGuc::Ingress, GithubGuc::Link],
        move |conn| {
            Box::pin(async move {
                let delivery = resolve_delivery;
                if is_installation_event(&delivery.event) {
                    lock_installation_link(conn, delivery.installation_id).await?;
                }
                let known = find_installation(conn, delivery.installation_id).await?;
                if let Some(record) = &known {
                    if let Some(workspace_id) = record.workspace_id {
                        // Linked. A suspended or removed installation announces nothing; its
                        // lifecycle events still go through (an `unsuspend` must land).
                        if !is_installation_event(&delivery.event)
                            && (record.suspended || record.removed)
                        {
                            return Ok(GithubScope::Done(Ok(ReceiveOutcome::Ok(
                                ReceiveResponse::ignored(&delivery.event, "installation_inactive"),
                            ))));
                        }
                        return Ok(GithubScope::Tenant(workspace_id));
                    }
                }
                // Not linked (or not known yet). Repository events have nowhere to go.
                if !is_installation_event(&delivery.event) {
                    return Ok(GithubScope::Done(Ok(ReceiveOutcome::Ok(
                        ReceiveResponse::ignored(&delivery.event, "installation_not_linked"),
                    ))));
                }
                if resolve_denial.is_some() {
                    return Ok(GithubScope::Done(Ok(ReceiveOutcome::RateLimited {
                        retry_after_seconds: (*resolve_denial)
                            .as_ref()
                            .map_or(1, |denial| denial.retry_after_seconds),
                    })));
                }
                // An unlinked installation has no subscriptions, so the effect has nowhere to go.
                let _effect = apply_installation_event(conn, &delivery).await?;
                match resolve_shared.lock() {
                    Ok(mut shared) => shared.applied = true,
                    Err(poisoned) => poisoned.into_inner().applied = true,
                }
                // `installation.created`: the second signal. Meet any pending claim — the link
                // itself is completed in the body, under the claim's workspace scope, once its
                // minter is confirmed to still be an owner/admin.
                if delivery.event == "installation" && delivery.action == "created" {
                    match find_link_candidate(conn, delivery.installation_id).await? {
                        LinkCandidate::Candidate {
                            claim_id,
                            workspace_id,
                            member_id,
                        } => {
                            match resolve_shared.lock() {
                                Ok(mut shared) => shared.pending_link = Some((claim_id, member_id)),
                                Err(poisoned) => {
                                    poisoned.into_inner().pending_link = Some((claim_id, member_id))
                                }
                            }
                            return Ok(GithubScope::Tenant(workspace_id));
                        }
                        LinkCandidate::AlreadyLinked { workspace_id } => {
                            return Ok(GithubScope::Tenant(workspace_id));
                        }
                        _ => {}
                    }
                }
                Ok(GithubScope::Done(Ok(ReceiveOutcome::Ok({
                    let mut response = ReceiveResponse::new(&delivery.event);
                    response.ignored = Some("installation_recorded");
                    response
                }))))
            })
        },
        move |conn, workspace| {
            Box::pin(async move {
                let delivery = body_delivery;
                let Some(workspace_id) = workspace else {
                    return Ok(Ok(ReceiveOutcome::Ok(ReceiveResponse::ignored(
                        &delivery.event,
                        "installation_not_linked",
                    ))));
                };
                // Rate budget: the burst's one audit row rides this tenant transaction.
                if let Some(denial) = (*body_denial).as_ref() {
                    if denial.log_reservation.is_some() {
                        tracing::warn!("github webhook ingress rate limit exceeded");
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, WEBHOOK_RATE_LIMITED_ACTION)
                                .target(
                                    "github_installation",
                                    installation_audit_target(delivery.installation_id),
                                )
                                .with_schema(
                                    "oort.webhook.rate_limited.v1",
                                    json!({
                                        "mode": "github",
                                        "installation_id": delivery.installation_id,
                                    }),
                                ),
                        )
                        .await?;
                    }
                    return Ok(Ok(ReceiveOutcome::RateLimited {
                        retry_after_seconds: denial.retry_after_seconds,
                    }));
                }

                // Replay: the delivery id, no time window.
                let fresh = insert_receipt(
                    conn,
                    workspace_id,
                    &delivery.delivery_id,
                    delivery.installation_id,
                    &delivery.event,
                )
                .await?;
                if !fresh {
                    let mut response = ReceiveResponse::new(&delivery.event);
                    response.duplicate = true;
                    return Ok(Ok(ReceiveOutcome::Ok(response)));
                }

                let (applied, pending_link) = match body_shared.lock() {
                    Ok(shared) => (shared.applied, shared.pending_link),
                    Err(poisoned) => {
                        let shared = poisoned.into_inner();
                        (shared.applied, shared.pending_link)
                    }
                };
                let mut linked_by = None;
                if let Some((claim_id, member_id)) = pending_link {
                    // The claim's minter must STILL be an owner/admin: a demoted or removed
                    // admin's pending claim is dead, however it got its installation id.
                    let role = active_workspace_role(conn, workspace_id, member_id).await?;
                    if role.is_some_and(|role| role.is_admin()) {
                        if complete_link(conn, delivery.installation_id, claim_id, workspace_id)
                            .await?
                        {
                            linked_by = Some(member_id);
                        }
                    } else {
                        discard_claim(conn, claim_id).await?;
                    }
                }

                if !is_installation_event(&delivery.event) {
                    // The signed payload's current privacy / name beats the install-time list
                    // (a repository can turn private after the install; ADR-0205 H-1).
                    if let Some(repository) = delivery.payload.get("repository") {
                        let id = repository.get("id").and_then(Value::as_i64);
                        let name = repository.get("full_name").and_then(Value::as_str);
                        let private = repository.get("private").and_then(Value::as_bool);
                        if let (Some(id), Some(name), Some(private)) = (id, name, private) {
                            refresh_repository_facts(
                                conn,
                                delivery.installation_id,
                                id,
                                name.trim(),
                                private,
                            )
                            .await?;
                        }
                    }
                }

                if is_installation_event(&delivery.event) {
                    let effect = if applied {
                        SubscriptionEffect::None
                    } else {
                        apply_installation_event(conn, &delivery).await?
                    };
                    apply_subscription_effect(conn, workspace_id, delivery.installation_id, effect)
                        .await?;
                    if linked_by.is_some() {
                        write_link_audit(
                            conn,
                            workspace_id,
                            linked_by,
                            delivery.installation_id,
                            "signed_event",
                        )
                        .await?;
                    }
                    return Ok(Ok(ReceiveOutcome::Ok(ReceiveResponse::new(
                        &delivery.event,
                    ))));
                }

                // A repository event: render, then fan out to the channels that asked for it.
                let Some(notification) = render_notification(&delivery.event, &delivery.payload)
                else {
                    return Ok(Ok(ReceiveOutcome::Ok(ReceiveResponse::ignored(
                        &delivery.event,
                        "event_not_announced",
                    ))));
                };
                let subscriptions = matching_subscriptions(
                    conn,
                    workspace_id,
                    delivery.installation_id,
                    notification.repo_id,
                    &notification.repo_full_name,
                )
                .await?;
                let mut response = ReceiveResponse::new(&delivery.event);
                if subscriptions.is_empty() {
                    response.ignored = Some("no_subscription");
                    return Ok(Ok(ReceiveOutcome::Ok(response)));
                }
                let author = match find_workspace_author(conn, workspace_id).await? {
                    Some(author) => author,
                    None => ensure_workspace_author(conn, workspace_id).await?,
                };
                for subscription in subscriptions {
                    if !subscription
                        .features
                        .iter()
                        .any(|feature| feature == notification.feature)
                    {
                        continue;
                    }
                    if let (None, Some(repo_id)) = (subscription.repo_id, notification.repo_id) {
                        learn_subscription_repo_id(conn, subscription.id, repo_id).await?;
                    }
                    let client_msg_id = deterministic_client_message_id(&[
                        &delivery.delivery_id,
                        &subscription.channel_id.to_string(),
                    ]);
                    let mut props = notification.props.clone();
                    props["github_installation_id"] = json!(delivery.installation_id);
                    // ADR-0205 H-1: the system member that wrote the line, so a client can check
                    // the author against it instead of trusting a display name.
                    props[GITHUB_AUTHOR_PROP] = json!(author.to_string());
                    let sent = momo_messaging::send_message_in_tx(
                        conn,
                        workspace_id,
                        NewMessage {
                            channel_id: subscription.channel_id,
                            author_member_id: author,
                            message_type: MessageType::Text,
                            body: Some(notification.body.clone()),
                            props,
                            root_id: None,
                            reply_to_id: None,
                            client_msg_id: Some(client_msg_id),
                            run_id: None,
                            hlc_ts: None,
                            hlc_count: None,
                        },
                    )
                    .await;
                    match sent {
                        Ok(_) => response.delivered += 1,
                        // The channel was removed under the subscription: skip it.
                        Err(momo_db::DbError::Sqlx(momo_db::sqlx::Error::RowNotFound)) => {}
                        Err(error) => return Err(error),
                    }
                }
                if response.delivered == 0 {
                    response.ignored = Some("feature_not_enabled");
                }
                Ok(Ok(ReceiveOutcome::Ok(response)))
            })
        },
    )
    .await;

    // A denial's first-reservation marker is only earned by a transaction that committed.
    if outcome.is_err() {
        let held = match reserved.lock() {
            Ok(mut held) => held.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some((key, reservation)) = held {
            state
                .rate_limit
                .limiter
                .release_log_reservation(&key, reservation);
        }
    }
    Ok(settle_db("github.receive", outcome)?.into_response())
}

// ---------------------------------------------------------------------------
// GET /v1/integrations/github/setup  (GitHub's setup-URL redirect)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SetupQuery {
    installation_id: Option<String>,
    setup_action: Option<String>,
    state: Option<String>,
}

fn back_to_client(base: &str, outcome: &str) -> Response {
    let location = format!("{}/?githubInstall={outcome}", base.trim_end_matches('/'));
    let mut response = StatusCode::SEE_OTHER.into_response();
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

enum SetupOutcome {
    Word(&'static str),
}

/// GitHub redirects the installing browser here. The `installation_id` is **not trusted**
/// (anyone can open this URL with any id): it is recorded as the pending half of a link and only
/// becomes a link when the signed `installation.created` for the same id exists.
///
/// Answers: 303 back to the client with a verdict word for **every** outcome. An installation
/// already linked to **another** workspace answers `linked_elsewhere` (#4084: it used to be a 409
/// JSON body, which left the browser on a raw error page; the screen reads the word).
pub async fn setup(State(state): State<AppState>, Query(query): Query<SetupQuery>) -> Response {
    if let Err(error) = master_key(&state) {
        return error.into_response();
    }
    let Some(base) = state.t3.ready_public_base_url() else {
        return ApiError::coded(
            StatusCode::CONFLICT,
            "public_address_required",
            "공개 주소가 없어 GitHub 연결을 마칠 수 없어요.",
        )
        .into_response();
    };
    if query.setup_action.as_deref() == Some("request") {
        // A non-owner asked an organization owner to install: nothing to link yet. The signed
        // event will show up under 「연결 안 된 설치」 for the instance operator.
        return back_to_client(&base, "requested");
    }
    let installation_id = query
        .installation_id
        .as_deref()
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|id| *id > 0);
    let Some(installation_id) = installation_id else {
        return back_to_client(&base, "invalid_request");
    };
    let Some(token) = query.state.as_deref() else {
        // GitHub did not echo our state (ADR-0205 D3 fallback): the operator attaches it.
        return back_to_client(&base, "state_missing");
    };
    let Some(workspace_id) = state_workspace_hint(token) else {
        return back_to_client(&base, "state_invalid");
    };
    let hash = state_hash(token);

    let outcome: DbRejectable<SetupOutcome> = with_github_tx(
        &state.pool,
        &[GithubGuc::Link],
        move |_| Box::pin(async move { Ok(GithubScope::Tenant(workspace_id)) }),
        move |conn, _| {
            Box::pin(async move {
                lock_installation_link(conn, installation_id).await?;
                let Some(minter) = peek_install_claim(conn, &hash).await? else {
                    return Ok(Ok(SetupOutcome::Word("state_invalid")));
                };
                // The minter must still be an owner/admin of that workspace — checked BEFORE the
                // installation id is written, so a demoted admin's state records nothing.
                let role = active_workspace_role(conn, workspace_id, minter.member_id).await?;
                if !role.is_some_and(|role| role.is_admin()) {
                    return Ok(Ok(SetupOutcome::Word("not_admin")));
                }
                let Some(claim) = record_claim_installation(conn, &hash, installation_id).await?
                else {
                    return Ok(Ok(SetupOutcome::Word("state_invalid")));
                };
                Ok(Ok(
                    match try_link_installation(conn, installation_id, Some(claim.claim_id)).await?
                    {
                        LinkOutcome::Linked { member_id, .. } => {
                            write_link_audit(
                                conn,
                                workspace_id,
                                Some(member_id),
                                installation_id,
                                "setup_url",
                            )
                            .await?;
                            SetupOutcome::Word("linked")
                        }
                        LinkOutcome::AlreadyLinked { .. } => SetupOutcome::Word("linked"),
                        LinkOutcome::LinkedElsewhere => SetupOutcome::Word("linked_elsewhere"),
                        LinkOutcome::NoInstallation
                        | LinkOutcome::NoClaim
                        | LinkOutcome::Ambiguous => SetupOutcome::Word("pending"),
                    },
                ))
            })
        },
    )
    .await;
    match settle_db("github.setup", outcome) {
        Ok(SetupOutcome::Word(word)) => back_to_client(&base, word),
        Err(error) => error.into_response(),
    }
}

// ---------------------------------------------------------------------------
// workspace owner/admin surface
// ---------------------------------------------------------------------------

async fn authorize_admin(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    let role = active_workspace_role(conn, workspace_id, member_id).await?;
    Ok(match role {
        Some(role) if role.is_admin() => Ok(()),
        _ => Err(ApiError::forbidden("human workspace admin required")),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStartResponse {
    install_url: String,
    expires_in_seconds: i64,
}

/// `POST /v1/workspaces/{ws}/github/link` — mint the one-time install state (D3 step 1–2).
pub async fn link_start(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<LinkStartResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    master_key(&state)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let token = new_state_token(workspace_id)
        .map_err(|error| ApiError::internal("github.link.state", error))?;
    let hash = state_hash(&token);

    let outcome: DbRejectable<Option<String>> =
        momo_db::with_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize_admin(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(slug) = read_app_slug(conn).await? else {
                    return Ok(Ok(None));
                };
                insert_install_claim(conn, workspace_id, member_id, &hash).await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_LINK_STARTED)
                        .by(member_id)
                        .via_token(via_token)
                        .with_schema(AUDIT_SCHEMA, json!({})),
                )
                .await?;
                Ok(Ok(Some(slug)))
            })
        })
        .await;
    let Some(slug) = settle_db("github.link_start", outcome)? else {
        return Err(ApiError::coded(
            StatusCode::CONFLICT,
            "github_app_not_registered",
            "이 서버에는 아직 GitHub 앱이 등록되지 않았어요. 인스턴스 운영자에게 알려 주세요.",
        ));
    };
    Ok(Json(LinkStartResponse {
        install_url: format!("https://github.com/apps/{slug}/installations/new?state={token}"),
        expires_in_seconds: INSTALL_STATE_TTL_SECONDS,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDto {
    repo_id: i64,
    full_name: String,
    private: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationDto {
    installation_id: i64,
    account_login: String,
    account_type: String,
    repository_selection: String,
    suspended: bool,
    repositories: Vec<RepositoryDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionDto {
    id: String,
    channel_id: String,
    installation_id: i64,
    repository: String,
    repo_id: Option<i64>,
    features: Vec<String>,
    active: bool,
    private_confirmed: bool,
    /// The channel is public now and the repository may be private: no event is sent until an
    /// owner/admin subscribes again with `confirmPrivate` (ADR-0205 H-1).
    needs_reconfirm: bool,
}

fn subscription_dto(record: SubscriptionRecord) -> SubscriptionDto {
    SubscriptionDto {
        id: record.id.to_string(),
        channel_id: record.channel_id.to_string(),
        installation_id: record.installation_id,
        repository: record.repo_full_name,
        repo_id: record.repo_id,
        features: record.features,
        active: record.active,
        private_confirmed: record.private_confirmed,
        needs_reconfirm: record.needs_reconfirm,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGithubResponse {
    app_registered: bool,
    installations: Vec<InstallationDto>,
    subscriptions: Vec<SubscriptionDto>,
    /// Every feature a subscription can switch on, and which are on by default.
    features: &'static [&'static str],
    default_features: &'static [&'static str],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGithubQuery {
    channel_id: Option<String>,
}

/// `GET /v1/workspaces/{ws}/github` — this workspace's installations (with their repositories)
/// and channel subscriptions. Only rows linked to this workspace are visible (RLS).
pub async fn workspace_overview(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<WorkspaceGithubQuery>,
) -> Result<Json<WorkspaceGithubResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    master_key(&state)?;
    let member_id = principal.member_id;
    let channel_filter = match query.channel_id.as_deref() {
        Some(raw) => {
            Some(Uuid::parse_str(raw).map_err(|_| ApiError::bad_request("invalid channelId"))?)
        }
        None => None,
    };

    type Overview = (
        bool,
        Vec<(
            InstallationRecord,
            Vec<momo_settings::github_ingress::RepositoryRecord>,
        )>,
        Vec<SubscriptionRecord>,
    );
    let outcome: DbRejectable<Overview> =
        momo_db::with_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize_admin(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let registered = read_app_slug(conn).await?.is_some();
                let mut installations = Vec::new();
                for record in list_workspace_installations(conn, workspace_id).await? {
                    let repositories = list_repositories(conn, record.installation_id).await?;
                    installations.push((record, repositories));
                }
                let subscriptions = list_subscriptions(conn, workspace_id, channel_filter).await?;
                Ok(Ok((registered, installations, subscriptions)))
            })
        })
        .await;
    let (registered, installations, subscriptions) = settle_db("github.overview", outcome)?;
    Ok(Json(WorkspaceGithubResponse {
        app_registered: registered,
        installations: installations
            .into_iter()
            .map(|(record, repositories)| InstallationDto {
                installation_id: record.installation_id,
                account_login: record.account_login,
                account_type: record.account_type,
                repository_selection: record.repository_selection,
                suspended: record.suspended,
                repositories: repositories
                    .into_iter()
                    .map(|repo| RepositoryDto {
                        repo_id: repo.repo_id,
                        full_name: repo.full_name,
                        private: repo.private,
                    })
                    .collect(),
            })
            .collect(),
        subscriptions: subscriptions.into_iter().map(subscription_dto).collect(),
        features: &momo_webhook::GITHUB_FEATURES,
        default_features: &GITHUB_DEFAULT_FEATURES,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    channel_id: String,
    installation_id: i64,
    /// `owner/name`.
    repository: String,
    features: Option<Vec<String>>,
    /// The owner/admin explicitly accepted putting a private (or not-known-public) repository
    /// into a public channel.
    #[serde(default)]
    confirm_private: bool,
}

/// `owner/name`: GitHub login characters, a slash, repository-name characters.
fn is_repository_name(value: &str) -> bool {
    let Some((owner, name)) = value.split_once('/') else {
        return false;
    };
    let owner_ok = (1..=39).contains(&owner.len())
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    let name_ok = (1..=100).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && name != "."
        && name != "..";
    owner_ok && name_ok
}

/// `POST /v1/workspaces/{ws}/github/subscriptions` — subscribe a channel to a repository.
///
/// The private-repository verdict is the **server's** (ADR-0205 acceptance 11): when the channel
/// is public and the repository is private — or the server cannot tell it is public, which is the
/// case for a repository outside the list GitHub sent — nothing is written unless
/// `confirmPrivate` is true.
pub async fn subscribe(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<SubscribeRequest>,
) -> Result<Json<SubscriptionDto>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    master_key(&state)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let channel_id = Uuid::parse_str(request.channel_id.trim())
        .map_err(|_| ApiError::bad_request("invalid channelId"))?;
    if request.installation_id <= 0 {
        return Err(ApiError::bad_request("installationId must be positive"));
    }
    let repository = request.repository.trim().to_string();
    if !is_repository_name(&repository) {
        return Err(ApiError::bad_request(
            "repository must look like owner/name",
        ));
    }
    let features: Vec<String> = match request.features {
        Some(list) => {
            let mut seen = Vec::new();
            for feature in list {
                if !is_known_feature(&feature) {
                    return Err(ApiError::bad_request(format!("unknown feature: {feature}")));
                }
                if !seen.contains(&feature) {
                    seen.push(feature);
                }
            }
            seen
        }
        None => GITHUB_DEFAULT_FEATURES
            .iter()
            .map(|feature| feature.to_string())
            .collect(),
    };
    let installation_id = request.installation_id;
    let confirm_private = request.confirm_private;

    let outcome: DbRejectable<SubscriptionRecord> =
        momo_db::with_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize_admin(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                // Tenant SELECT sees only an installation linked to this workspace.
                let Some(installation) = find_installation(conn, installation_id).await? else {
                    return Ok(Err(ApiError::not_found("GitHub installation not found")));
                };
                if installation.workspace_id != Some(workspace_id) || installation.removed {
                    return Ok(Err(ApiError::not_found("GitHub installation not found")));
                }
                let Some(kind) = channel_kind(conn, workspace_id, channel_id).await? else {
                    return Ok(Err(ApiError::not_found("channel not found")));
                };
                if kind == "dm" {
                    return Ok(Err(ApiError::bad_request(
                        "GitHub notifications cannot be sent to a direct message",
                    )));
                }
                let known = find_repository(conn, installation_id, &repository).await?;
                if known.is_none() && installation.repository_selection == "selected" {
                    // A "selected" installation lists everything it can see; a name outside the
                    // list is not reachable by this App.
                    let listed = list_repositories(conn, installation_id).await?;
                    if !listed.is_empty() {
                        return Ok(Err(ApiError::coded(
                            StatusCode::NOT_FOUND,
                            "repository_not_in_installation",
                            "이 설치에서 볼 수 있는 저장소가 아니에요.",
                        )));
                    }
                }
                // Unknown privacy is treated as private: the server cannot tell it is public.
                let maybe_private = known.as_ref().is_none_or(|repo| repo.private);
                let needs_confirmation = kind == "public" && maybe_private;
                if needs_confirmation && !confirm_private {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "private_repository_requires_confirmation",
                        "비공개일 수 있는 저장소를 공개 채널에 연결하면 채널의 모든 사람이 이벤트를 볼 수 있어요. 확인 후 다시 요청해 주세요.",
                    )));
                }
                let (repo_id, name) = match &known {
                    Some(repo) => (Some(repo.repo_id), repo.full_name.clone()),
                    None => (None, repository.clone()),
                };
                let author = ensure_workspace_author(conn, workspace_id).await?;
                ensure_author_in_channel(conn, workspace_id, channel_id, author).await?;
                let record = upsert_subscription(
                    conn,
                    &NewSubscription {
                        workspace_id,
                        channel_id,
                        installation_id,
                        repo_id,
                        repo_full_name: &name,
                        features: &features,
                        private_confirmed: needs_confirmation,
                        created_by: member_id,
                    },
                )
                .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_SUBSCRIBED)
                        .by(member_id)
                        .via_token(via_token)
                        .target("github_subscription", record.id)
                        .with_schema(
                            AUDIT_SCHEMA,
                            json!({
                                "channel_id": channel_id.to_string(),
                                "repository": name,
                                "features": record.features,
                                "private_confirmed": needs_confirmation,
                            }),
                        ),
                )
                .await?;
                Ok(Ok(record))
            })
        })
        .await;
    Ok(Json(subscription_dto(settle_db(
        "github.subscribe",
        outcome,
    )?)))
}

/// `DELETE /v1/workspaces/{ws}/github/subscriptions/{id}`.
pub async fn unsubscribe(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, subscription)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    master_key(&state)?;
    let subscription_id = Uuid::parse_str(&subscription)
        .map_err(|_| ApiError::bad_request("invalid subscription id"))?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<()> =
        momo_db::with_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize_admin(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(removed) =
                    delete_subscription(conn, workspace_id, subscription_id).await?
                else {
                    return Ok(Err(ApiError::not_found("subscription not found")));
                };
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_UNSUBSCRIBED)
                        .by(member_id)
                        .via_token(via_token)
                        .target("github_subscription", removed.id)
                        .with_schema(
                            AUDIT_SCHEMA,
                            json!({
                                "channel_id": removed.channel_id.to_string(),
                                "repository": removed.repo_full_name,
                            }),
                        ),
                )
                .await?;
                Ok(Ok(()))
            })
        })
        .await;
    settle_db("github.unsubscribe", outcome)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// instance operator: installations nobody linked yet
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkedInstallationDto {
    installation_id: i64,
    account_login: String,
    account_type: String,
    repository_selection: String,
    suspended: bool,
    repository_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkedInstallationsResponse {
    installations: Vec<UnlinkedInstallationDto>,
}

/// `GET /v1/integrations/github/installations` — 「연결 안 된 설치」. Instance operators only:
/// a workspace admin never sees another account's installation (ADR-0205 D3).
pub async fn unlinked_installations(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<UnlinkedInstallationsResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    master_key(&state)?;
    let rows = with_github_app_admin_tx(&state.pool, principal.workspace_id, |conn| {
        Box::pin(async move { list_unlinked_installations(conn).await })
    })
    .await
    .map_err(|error| ApiError::internal("github.unlinked", error))?;
    Ok(Json(UnlinkedInstallationsResponse {
        installations: rows
            .into_iter()
            .map(|(record, count)| UnlinkedInstallationDto {
                installation_id: record.installation_id,
                account_login: record.account_login,
                account_type: record.account_type,
                repository_selection: record.repository_selection,
                suspended: record.suspended,
                repository_count: count,
            })
            .collect(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorLinkRequest {
    workspace_id: String,
}

/// `POST /v1/integrations/github/installations/{id}/link` — the operator attaches an installation
/// to a workspace. `409` when it already belongs to a different one.
pub async fn operator_link(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(installation): Path<String>,
    Json(request): Json<OperatorLinkRequest>,
) -> Result<StatusCode, ApiError> {
    require_instance_operator_write(&state, &principal).await?;
    master_key(&state)?;
    let installation_id = installation
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| ApiError::bad_request("invalid installation id"))?;
    let target = Uuid::parse_str(request.workspace_id.trim())
        .map_err(|_| ApiError::bad_request("invalid workspaceId"))?;
    let operator_workspace = principal.workspace_id;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    // A workspace is visible only under its own RLS scope, so existence is asked there.
    let exists: DbRejectable<bool> = momo_db::with_tenant_tx(&state.pool, target, move |conn| {
        Box::pin(async move { Ok(Ok(sqlx_exists_workspace(conn, target).await?)) })
    })
    .await;
    if !settle_db("github.operator_link.workspace", exists)? {
        return Err(ApiError::not_found("workspace not found"));
    }

    let outcome: DbRejectable<LinkOutcome> = with_github_tx(
        &state.pool,
        &[GithubGuc::Link],
        move |_| Box::pin(async move { Ok(GithubScope::Tenant(operator_workspace)) }),
        move |conn, _| {
            Box::pin(async move {
                let outcome = operator_link_installation(conn, installation_id, target).await?;
                if matches!(outcome, LinkOutcome::Linked { .. }) {
                    write_audit(
                        conn,
                        &AuditEntry::new(operator_workspace, AUDIT_INSTALLATION_LINKED)
                            .by(member_id)
                            .via_token(via_token)
                            .target(
                                "github_installation",
                                installation_audit_target(installation_id),
                            )
                            .with_schema(
                                AUDIT_SCHEMA,
                                json!({
                                    "installation_id": installation_id,
                                    "via": "operator",
                                    "workspace_id": target.to_string(),
                                }),
                            ),
                    )
                    .await?;
                }
                Ok(Ok(outcome))
            })
        },
    )
    .await;
    match settle_db("github.operator_link", outcome)? {
        LinkOutcome::Linked { .. } | LinkOutcome::AlreadyLinked { .. } => {
            Ok(StatusCode::NO_CONTENT)
        }
        LinkOutcome::LinkedElsewhere => Err(ApiError::coded(
            StatusCode::CONFLICT,
            "github_installation_linked_elsewhere",
            "이 GitHub 계정의 설치는 이미 다른 워크스페이스에 연결되어 있어요.",
        )),
        _ => Err(ApiError::not_found("GitHub installation not found")),
    }
}

async fn sqlx_exists_workspace(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
) -> Result<bool, momo_db::DbError> {
    Ok(
        momo_db::sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM workspace WHERE id = $1)")
            .bind(workspace_id)
            .fetch_one(&mut *conn)
            .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_names_are_policed() {
        for good in ["acme/widgets", "a/b", "Acme-Inc/my_repo.rs"] {
            assert!(is_repository_name(good), "{good}");
        }
        for bad in [
            "",
            "acme",
            "acme/",
            "/x",
            "a/b/c",
            "a b/c",
            "-/..",
            "acme/..",
            "acme/.",
            "ac;me/x",
            "acme/x y",
            &format!("{}/x", "a".repeat(40)),
        ] {
            assert!(!is_repository_name(bad), "{bad}");
        }
    }

    #[test]
    fn the_rate_key_is_per_installation_and_never_a_uuid() {
        assert_eq!(rate_key(42), "github:42");
        assert_ne!(rate_key(1), rate_key(2));
    }
}
