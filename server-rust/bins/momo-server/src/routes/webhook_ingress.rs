//! Public inbound webhook ingress (#1265, ADR-0115).
//!
//! ```text
//! POST /v1/webhooks/{ws}/{installation}   native HMAC
//! POST /hooks/{token}                  Slack-compatible URL secret
//! ```
//!
//! Verification order is load-bearing (the inbound conformance suite sabotages
//! it): **signature/token → body-size → rate limit → replay → parse**. A replay
//! of a known `delivery_id` with a body that would 400 if parsed must still 200
//! because parse never runs. Direct `INSERT INTO message` is forbidden — the
//! send goes through [`momo_messaging::send_message_in_tx`].
//!
//! ## The per-installation budget (ADR-0004 증보 4 D3, #2066)
//!
//! The budget already existed as a sliding window (ADR-0115 D3,
//! `RATE_LIMIT_WEBHOOK_PER_INSTALLATION`); what it lacked was a durable record,
//! so a leaked URL token could be throttled all night and leave nothing behind
//! but a 429 the attacker saw. Each burst now also writes ONE
//! `webhook.rate_limited` audit row — one, not one per request, because the
//! limiter hands out a first-denial reservation and the rest of the burst
//! carries `should_log: false`. The row names the installation, the dialect and
//! the budget. It never names the credential: no URL token, no token hash, no
//! `secret_ref`, no body, not even a fingerprint of them.

use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::{Path, State};
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{MessageType, NewMessage};
use momo_webhook::{
    attach_receipt_message, canonical_signature_base, deterministic_client_message_id,
    ingress_signature, insert_receipt, load_native_ingress, load_native_receipt,
    load_slack_ingress, load_slack_receipt, parse_native, parse_slack_compatible, sha256_hex,
    signatures_equal, slack_dedupe_window_start, token_hash, valid_delivery_id,
    workspace_id_from_slack_token, IngressReceipt, IngressTarget, PayloadError, WebhookMode,
    MAXIMUM_BODY_BYTES, REPLAY_WINDOW_SECONDS,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, path_uuid, settle_db, DbRejectable};
use crate::AppState;

/// Same sentence on both routes for revoked/unknown/typo. Existence leak is
/// the status (404 vs 401), not the copy.
pub(crate) const UNKNOWN_INSTALLATION: &str = "webhook installation not found";
const INVALID_AUTH: &str = "invalid webhook authentication";
const TIMESTAMP_WINDOW: &str = "webhook timestamp is outside the replay window";
const BODY_TOO_LARGE: &str = "webhook body exceeds 262144 bytes";

/// `audit_log.action` for a per-installation budget denial (ADR-0004 증보 4 D3).
/// One row per burst; the conformance suite counts them.
pub const WEBHOOK_RATE_LIMITED_ACTION: &str = "webhook.rate_limited";

const SIGNATURE_VERSION_HEADER: &str = "x-momo-signature-version";
const KEY_ID_HEADER: &str = "x-momo-key-id";
const TIMESTAMP_HEADER: &str = "x-momo-timestamp";
const DELIVERY_ID_HEADER: &str = "x-momo-delivery-id";
const SIGNATURE_HEADER: &str = "x-momo-signature";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookIngressResponse {
    pub receipt_id: String,
    pub message_id: String,
    pub seq: i64,
    pub duplicate: bool,
}

enum IngressOutcome {
    Fresh {
        receipt_id: Uuid,
        message_id: Uuid,
        seq: i64,
    },
    Duplicate(IngressReceipt),
    RateLimited {
        retry_after_seconds: u64,
    },
}

impl IngressOutcome {
    fn into_response(self) -> Response {
        match self {
            IngressOutcome::RateLimited {
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
            IngressOutcome::Fresh {
                receipt_id,
                message_id,
                seq,
            } => {
                let body = WebhookIngressResponse {
                    receipt_id: receipt_id.to_string(),
                    message_id: message_id.to_string(),
                    seq,
                    duplicate: false,
                };
                (StatusCode::CREATED, Json(body)).into_response()
            }
            IngressOutcome::Duplicate(existing) => {
                let body = WebhookIngressResponse {
                    receipt_id: existing.id.to_string(),
                    message_id: existing.message_id.to_string(),
                    seq: existing.seq,
                    duplicate: true,
                };
                (StatusCode::OK, Json(body)).into_response()
            }
        }
    }
}

fn body_too_large() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, BODY_TOO_LARGE)
}

fn payload_error(error: PayloadError) -> ApiError {
    ApiError::bad_request(error.message)
}

fn header<'a>(request: &'a Request<Body>, name: &str) -> Option<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

async fn collect_body(request: Request<Body>) -> Result<axum::body::Bytes, ApiError> {
    if let Some(length) = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if length > MAXIMUM_BODY_BYTES {
            return Err(body_too_large());
        }
    }
    to_bytes(request.into_body(), MAXIMUM_BODY_BYTES)
        .await
        .map_err(|_| body_too_large())
}

fn webhook_props(
    installation_id: Uuid,
    mode: WebhookMode,
    label: &str,
    client_props: &std::collections::BTreeMap<String, String>,
) -> Value {
    let mut props = Map::new();
    props.insert("source".into(), json!("external_webhook"));
    props.insert(
        "webhook_installation_id".into(),
        json!(installation_id.to_string()),
    );
    props.insert("webhook_mode".into(), json!(mode.as_db_label()));
    props.insert("webhook_label".into(), json!(label));
    for (key, value) in client_props {
        props.insert(key.clone(), json!(value));
    }
    Value::Object(props)
}

/// The limiter key one installation's budget lives under. Shared by the check
/// and by the reservation release, so the two can never drift onto different
/// buckets.
fn install_rate_key(installation_id: Uuid) -> String {
    format!("webhook:{installation_id}")
}

/// A denial, with everything the caller needs to both answer and record it.
struct RateDenial {
    retry_after_seconds: u64,
    /// `Some` for the first denial of a burst — the reservation that owns the
    /// single audit row. Released again if the transaction that would have
    /// carried that row never commits.
    log_reservation: Option<u64>,
}

fn check_install_rate(
    limiter: &crate::rate_limit::SlidingWindowRateLimiter,
    installation_id: Uuid,
    limit: u32,
    window_secs: u64,
) -> Option<RateDenial> {
    let verdict = limiter.check(
        &install_rate_key(installation_id),
        limit,
        Duration::from_secs(window_secs),
    );
    if verdict.allowed {
        return None;
    }
    Some(RateDenial {
        retry_after_seconds: verdict.retry_after_seconds,
        log_reservation: verdict
            .should_log
            .then_some(verdict.log_reservation)
            .flatten(),
    })
}

/// Turn a denial into the 429 outcome, writing the burst's one audit row when
/// this request is the one holding the reservation.
///
/// The write rides the request's own tenant transaction, which is what makes
/// the row attributable (RLS GUC already set) and honest (it rolls back with
/// the request instead of recording a refusal that never happened).
async fn deny_with_audit(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    installation_id: Uuid,
    mode: WebhookMode,
    limit: u32,
    window_secs: u64,
    denial: RateDenial,
) -> Result<IngressOutcome, momo_db::DbError> {
    if denial.log_reservation.is_some() {
        tracing::warn!(
            mode = mode.as_db_label(),
            limit,
            window_seconds = window_secs,
            "webhook ingress rate limit exceeded"
        );
        // No credential material: the installation id is a public path segment
        // on the native route and a row id on the Slack-compatible one.
        let entry = AuditEntry::new(workspace_id, WEBHOOK_RATE_LIMITED_ACTION)
            .target("webhook_installation", installation_id)
            .with_schema(
                "oort.webhook.rate_limited.v1",
                json!({
                    "mode": mode.as_db_label(),
                    "limit": limit,
                    "window_seconds": window_secs,
                }),
            );
        write_audit(conn, &entry).await?;
    }
    Ok(IngressOutcome::RateLimited {
        retry_after_seconds: denial.retry_after_seconds,
    })
}

type RateReservation = std::sync::Arc<std::sync::Mutex<Option<(String, u64)>>>;

/// Park the first-denial reservation where the post-transaction path can find
/// it. Recorded BEFORE the audit INSERT so a failure anywhere after this point
/// — the INSERT itself or the COMMIT — is still releasable.
fn remember_rate_reservation(slot: &RateReservation, installation_id: Uuid, denial: &RateDenial) {
    let Some(reservation) = denial.log_reservation else {
        return;
    };
    let entry = Some((install_rate_key(installation_id), reservation));
    match slot.lock() {
        Ok(mut held) => *held = entry,
        Err(poisoned) => *poisoned.into_inner() = entry,
    }
}

/// The first-denial marker is only earned by a transaction that committed.
///
/// If this one rolled back, the audit row it was going to carry does not exist,
/// so releasing the marker lets the NEXT denial write it instead of suppressing
/// the burst's only record forever. The release matches on the exact
/// reservation, so a late failure cannot clear a newer burst's marker.
fn release_rate_reservation_on_failure<T>(
    state: &AppState,
    slot: &RateReservation,
    outcome: &DbRejectable<T>,
) {
    if outcome.is_ok() {
        return;
    }
    let held = match slot.lock() {
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

#[allow(clippy::too_many_arguments)]
async fn commit_ingress(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    target: &IngressTarget,
    mode: WebhookMode,
    delivery_id: Option<&str>,
    body_hash: &str,
    window_start: Option<chrono::DateTime<chrono::Utc>>,
    client_msg_id: Uuid,
    rendered: momo_webhook::RenderedMessage,
) -> Result<Result<IngressOutcome, ApiError>, momo_db::DbError> {
    let receipt_id = match insert_receipt(
        conn,
        workspace_id,
        momo_webhook::NewReceipt {
            installation_id: target.installation_id,
            mode,
            delivery_id,
            body_hash,
            dedupe_window_start: window_start,
            client_msg_id,
        },
    )
    .await?
    {
        Some(id) => id,
        None => {
            let existing = match mode {
                WebhookMode::Native => {
                    load_native_receipt(
                        conn,
                        workspace_id,
                        target.installation_id,
                        delivery_id.unwrap_or(""),
                    )
                    .await?
                }
                WebhookMode::SlackCompatible => {
                    load_slack_receipt(
                        conn,
                        workspace_id,
                        target.installation_id,
                        body_hash,
                        window_start.unwrap_or(chrono::Utc::now()),
                    )
                    .await?
                }
            };
            return Ok(match existing {
                Some(existing) => Ok(IngressOutcome::Duplicate(existing)),
                None => Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "webhook receipt conflict",
                )),
            });
        }
    };

    let sent = match momo_messaging::send_message_in_tx(
        conn,
        workspace_id,
        NewMessage {
            channel_id: target.channel_id,
            author_member_id: target.author_member_id,
            message_type: MessageType::Text,
            body: Some(rendered.body),
            props: webhook_props(
                target.installation_id,
                mode,
                &target.label,
                &rendered.client_props,
            ),
            root_id: None,
            reply_to_id: None,
            client_msg_id: Some(client_msg_id),
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await
    {
        Ok(sent) => sent,
        Err(momo_db::DbError::Sqlx(momo_db::sqlx::Error::RowNotFound)) => {
            return Ok(Err(ApiError::not_found(
                "webhook channel is not provisioned",
            )));
        }
        Err(error) => return Err(error),
    };

    attach_receipt_message(
        conn,
        workspace_id,
        receipt_id,
        sent.message.id,
        sent.message.seq,
    )
    .await?;
    Ok(Ok(IngressOutcome::Fresh {
        receipt_id,
        message_id: sent.message.id,
        seq: sent.message.seq,
    }))
}

pub async fn receive_native(
    State(state): State<AppState>,
    Path((workspace, installation)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let workspace_id = path_uuid(&workspace, "invalid ws id")?;
    let installation_id = path_uuid(&installation, "invalid installation id")?;

    if header(&request, SIGNATURE_VERSION_HEADER) != Some("v1") {
        return Err(ApiError::unauthorized(INVALID_AUTH));
    }
    let key_id = header(&request, KEY_ID_HEADER)
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .ok_or_else(|| ApiError::unauthorized(INVALID_AUTH))?;
    let timestamp_raw = header(&request, TIMESTAMP_HEADER)
        .ok_or_else(|| ApiError::unauthorized(INVALID_AUTH))?
        .to_string();
    let timestamp: i64 = timestamp_raw
        .parse()
        .map_err(|_| ApiError::unauthorized(INVALID_AUTH))?;
    let delivery_id = header(&request, DELIVERY_ID_HEADER)
        .filter(|value| valid_delivery_id(value))
        .ok_or_else(|| ApiError::unauthorized(INVALID_AUTH))?
        .to_string();
    let signature = header(&request, SIGNATURE_HEADER)
        .ok_or_else(|| ApiError::unauthorized(INVALID_AUTH))?
        .to_string();

    let now = chrono::Utc::now().timestamp();
    if (now - timestamp).abs() > REPLAY_WINDOW_SECONDS {
        return Err(ApiError::unauthorized(TIMESTAMP_WINDOW));
    }

    let raw_body = collect_body(request).await?;
    let body_sha256 = sha256_hex(&raw_body);
    let body_hash = format!("sha256:{body_sha256}");
    let base = canonical_signature_base(
        workspace_id,
        installation_id,
        &timestamp_raw,
        &delivery_id,
        &body_sha256,
    );
    // ADR-0004 증보 4 D1: the inbound derivation root is its own key now, not
    // the app JWT secret. `POST /v1/webhooks/…` (the mint) reads the same field.
    let master = state.webhook.ingress_master_key.clone();
    let limiter = state.rate_limit.clone();
    let per_install = state.webhook.per_installation_limit;
    let window_secs = state.rate_limit.config.window_seconds.max(1);
    let reserved_rate_log = std::sync::Arc::new(std::sync::Mutex::new(None::<(String, u64)>));
    let reserved_rate_log_in_tx = std::sync::Arc::clone(&reserved_rate_log);

    let outcome: DbRejectable<IngressOutcome> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let target =
                    match load_native_ingress(conn, workspace_id, installation_id, key_id).await? {
                        Some(target) => target,
                        None => return Ok(Err(ApiError::not_found(UNKNOWN_INSTALLATION))),
                    };
                let secret_ref = target.secret_ref.as_deref().unwrap_or("");
                let expected =
                    ingress_signature(&momo_webhook::native_secret(&master, secret_ref), &base);
                // #1265-order: signature check (must stay above parse)
                if !signatures_equal(&expected, &signature) {
                    return Ok(Err(ApiError::unauthorized(INVALID_AUTH)));
                }
                if let Some(denial) = check_install_rate(
                    &limiter.limiter,
                    target.installation_id,
                    per_install,
                    window_secs,
                ) {
                    remember_rate_reservation(
                        &reserved_rate_log_in_tx,
                        target.installation_id,
                        &denial,
                    );
                    return Ok(Ok(deny_with_audit(
                        conn,
                        workspace_id,
                        target.installation_id,
                        WebhookMode::Native,
                        per_install,
                        window_secs,
                        denial,
                    )
                    .await?));
                }
                // #1265-order: replay short-circuit (must stay above parse)
                if let Some(existing) =
                    load_native_receipt(conn, workspace_id, installation_id, &delivery_id).await?
                {
                    return Ok(Ok(IngressOutcome::Duplicate(existing)));
                }
                // #1265-order: parse
                let rendered = match parse_native(&raw_body) {
                    Ok(rendered) => rendered,
                    Err(error) => return Ok(Err(payload_error(error))),
                };
                let client_msg_id = deterministic_client_message_id(&[
                    &workspace_id.to_string(),
                    &installation_id.to_string(),
                    &delivery_id,
                ]);
                commit_ingress(
                    conn,
                    workspace_id,
                    &target,
                    WebhookMode::Native,
                    Some(&delivery_id),
                    &body_hash,
                    None,
                    client_msg_id,
                    rendered,
                )
                .await
            })
        })
        .await;

    release_rate_reservation_on_failure(&state, &reserved_rate_log, &outcome);
    Ok(settle_db("webhooks.receive_native", outcome)?.into_response())
}

pub async fn receive_slack(
    State(state): State<AppState>,
    Path(token): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_id_from_slack_token(&token)
        .ok_or_else(|| ApiError::not_found(UNKNOWN_INSTALLATION))?;
    let presented_hash = token_hash(&token);
    let raw_body = collect_body(request).await?;
    let body_sha256 = sha256_hex(&raw_body);
    let body_hash = format!("sha256:{body_sha256}");
    let now = chrono::Utc::now().timestamp();
    let window_start = slack_dedupe_window_start(now);
    let limiter = state.rate_limit.clone();
    let per_install = state.webhook.per_installation_limit;
    let window_secs = state.rate_limit.config.window_seconds.max(1);
    let reserved_rate_log = std::sync::Arc::new(std::sync::Mutex::new(None::<(String, u64)>));
    let reserved_rate_log_in_tx = std::sync::Arc::clone(&reserved_rate_log);

    let outcome: DbRejectable<IngressOutcome> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let target = match load_slack_ingress(conn, workspace_id, &presented_hash).await? {
                    Some(target) => target,
                    None => return Ok(Err(ApiError::not_found(UNKNOWN_INSTALLATION))),
                };
                if let Some(denial) = check_install_rate(
                    &limiter.limiter,
                    target.installation_id,
                    per_install,
                    window_secs,
                ) {
                    remember_rate_reservation(
                        &reserved_rate_log_in_tx,
                        target.installation_id,
                        &denial,
                    );
                    return Ok(Ok(deny_with_audit(
                        conn,
                        workspace_id,
                        target.installation_id,
                        WebhookMode::SlackCompatible,
                        per_install,
                        window_secs,
                        denial,
                    )
                    .await?));
                }
                if let Some(existing) = load_slack_receipt(
                    conn,
                    workspace_id,
                    target.installation_id,
                    &body_hash,
                    window_start,
                )
                .await?
                {
                    return Ok(Ok(IngressOutcome::Duplicate(existing)));
                }
                let rendered = match parse_slack_compatible(&raw_body) {
                    Ok(rendered) => rendered,
                    Err(error) => return Ok(Err(payload_error(error))),
                };
                let client_msg_id = deterministic_client_message_id(&[
                    &workspace_id.to_string(),
                    &target.installation_id.to_string(),
                    &body_sha256,
                    &window_start.timestamp().to_string(),
                ]);
                commit_ingress(
                    conn,
                    workspace_id,
                    &target,
                    WebhookMode::SlackCompatible,
                    None,
                    &body_hash,
                    Some(window_start),
                    client_msg_id,
                    rendered,
                )
                .await
            })
        })
        .await;

    release_rate_reservation_on_failure(&state, &reserved_rate_log, &outcome);
    Ok(settle_db("webhooks.receive_slack", outcome)?.into_response())
}
