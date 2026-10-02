//! `PATCH /v1/workspaces/{ws}/work-sessions/{session}/share` (#2862).
//!
//! ADR-0190 증보 D4-b (S1 payload) and ADR-0194 D4/D7/D8/D9. The owner's desktop
//! reports what it knows about a shared local pane — repository label, branch,
//! harness, derived state, stage markers, diff numbers, PR URL, last activity —
//! and nothing else; `{"shared": false}` deletes it all.
//!
//! ## The boundaries this handler keeps
//!
//! * **Host-signed only.** A human bearer, an agent bearer and a host signature
//!   over some *other* host's session are all refused. The signature itself is
//!   verified in `work_host_auth` (v2 payload: method, path, workspace, host,
//!   time, body SHA-256, one-time request id) before this code runs.
//! * **Same vocabulary as the desktop collector.** Field names and the `state` list
//!   are `momo-core`'s `ShareSummaryS1` / `SessionStatus` (#2861); `lastActivityAt` is
//!   epoch seconds; `null` means unknown.
//! * **Local sessions only.** `origin = 'local_pty'`; migration 114's trigger
//!   says the same for any other writer.
//! * **The signer is the session's own host, and its owner is the session's
//!   member.** Both pins are read from the ledger here, in the transaction.
//! * **Strict payload.** Unknown fields, over-long text, an out-of-list value,
//!   a PR URL outside the grammar are 400s before any row is touched. There is
//!   no field for a commit title or terminal output to arrive in.
//! * **Bounded body.** The signed-request ceiling is 1 MiB; this route refuses
//!   anything over [`MAX_SHARE_BODY_BYTES`] before parsing it.
//! * **Realtime goes through the outbox.** Enabling, disabling and a derived-state
//!   change commit one `work.session.share_changed` outbox row in the same
//!   transaction (relay → Centrifugo). It carries the session id and the kind of
//!   transition only. A diff-only or marker-only update emits nothing.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::{Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::cent_channel;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::work_share::{
    allowed_pr_hosts, delete_share_in_tx, share_changed_payload, upsert_share_in_tx,
    validated_activity_secs, validated_branch, validated_count, validated_harness,
    validated_pr_url, validated_repo_label, validated_stage_markers, validated_state, ShareFields,
    ShareRejection, ShareTransition, MAX_COUNT,
};
use momo_t3::{allocate_uuid_v7, lock_work_session_detail_in_tx, T3Error};
use serde_json::json;
use uuid::Uuid;

use crate::dto::{ShareWorkSessionRequest, WorkSessionShareResponse};
use crate::error::ApiError;
use crate::routes::shared::{path_uuid, settle, tenant_tx, workspace_scope, Rejectable};
use crate::work_host_auth::signed_request_unauthorized;
use crate::AppState;

/// A full S1 payload is well under 4 KiB (12 markers × 80 chars + a few short
/// strings); 8 KiB leaves room for multi-byte text and refuses anything stuffed.
pub const MAX_SHARE_BODY_BYTES: usize = 8 * 1024;

pub const CODE_SHARE_LOCAL_ONLY: &str = "share_local_session_only";
pub const CODE_SHARE_SESSION_ENDED: &str = "share_session_ended";

/// What the request asks for, after validation.
enum Validated {
    Unshare,
    Share(Box<ShareFields>),
}

fn rejection(error: ShareRejection) -> ApiError {
    ApiError::bad_request(error.0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// Parse the raw body. The serde message is replaced, not forwarded: a type
/// error would otherwise echo the rejected value back.
fn parse_body(body: &[u8]) -> Result<ShareWorkSessionRequest, ApiError> {
    serde_json::from_slice(body).map_err(|error| {
        let text = error.to_string();
        if text.starts_with("unknown field") {
            ApiError::bad_request("share body contains a field that is not part of the S1 payload")
        } else {
            ApiError::bad_request("share body must be a JSON object of the S1 payload")
        }
    })
}

fn validate(
    request: ShareWorkSessionRequest,
    allowed_hosts: &[String],
    now_ms: i64,
) -> Result<Validated, ApiError> {
    if !request.shared {
        let extra = request.repo.is_some()
            || request.branch.is_some()
            || request.harness.is_some()
            || request.state.is_some()
            || request.stages.is_some()
            || request.diff.is_some()
            || request.pr_url.is_some()
            || request.last_activity_at.is_some();
        if extra {
            return Err(ApiError::bad_request("shared:false takes no other field"));
        }
        return Ok(Validated::Unshare);
    }
    let harness = request
        .harness
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("harness is required when shared is true"))?;
    let state = request
        .state
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("state is required when shared is true"))?;
    let diff = request.diff.unwrap_or(crate::dto::ShareDiffRequest {
        added: None,
        deleted: None,
        files: None,
        ahead: None,
        behind: None,
        uncommitted: None,
    });
    let fields = ShareFields {
        repo_label: request
            .repo
            .as_deref()
            .map(validated_repo_label)
            .transpose()
            .map_err(rejection)?,
        branch: request
            .branch
            .as_deref()
            .map(validated_branch)
            .transpose()
            .map_err(rejection)?,
        harness: validated_harness(harness).map_err(rejection)?,
        derived_state: validated_state(state).map_err(rejection)?,
        stage_markers: validated_stage_markers(request.stages.as_deref().unwrap_or_default())
            .map_err(rejection)?,
        diff_added: validated_count(diff.added, "diff.added", MAX_COUNT).map_err(rejection)?,
        diff_deleted: validated_count(diff.deleted, "diff.deleted", MAX_COUNT)
            .map_err(rejection)?,
        diff_files: validated_count(diff.files, "diff.files", MAX_COUNT).map_err(rejection)?,
        commits_ahead: validated_count(diff.ahead, "diff.ahead", MAX_COUNT).map_err(rejection)?,
        commits_behind: validated_count(diff.behind, "diff.behind", MAX_COUNT)
            .map_err(rejection)?,
        uncommitted: validated_count(diff.uncommitted, "diff.uncommitted", MAX_COUNT)
            .map_err(rejection)?,
        pr_url: request
            .pr_url
            .as_deref()
            .map(|raw| validated_pr_url(raw, allowed_hosts))
            .transpose()
            .map_err(rejection)?,
        last_activity_secs: request
            .last_activity_at
            .map(|secs| validated_activity_secs(secs, now_ms / 1000))
            .transpose()
            .map_err(rejection)?,
    };
    Ok(Validated::Share(Box::new(fields)))
}

/// `PATCH …/work-sessions/{session}/share` → 200 `{sessionId, shared}`.
pub async fn share(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<WorkSessionShareResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    if principal.kind != PrincipalKind::WorkHost {
        return Err(ApiError::forbidden(
            "sharing a work session requires work host signature",
        ));
    }
    let Some(signing_host_id) = principal.token_id else {
        return Err(signed_request_unauthorized());
    };
    if body.len() > MAX_SHARE_BODY_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "share body is too large",
        ));
    }
    let request = parse_body(&body)?;
    let validated = validate(request, allowed_pr_hosts(), now_ms())?;
    let owner_member_id = principal.member_id;
    let shared = matches!(validated, Validated::Share(_));

    settle(
        "work_session_share",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                share_in_tx(
                    conn,
                    workspace_id,
                    session_id,
                    signing_host_id,
                    owner_member_id,
                    validated,
                )
                .await
            })
        })
        .await,
    )?;
    Ok(Json(WorkSessionShareResponse {
        session_id: session_id.to_string(),
        shared,
    }))
}

async fn share_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    signing_host_id: Uuid,
    owner_member_id: Uuid,
    validated: Validated,
) -> Rejectable<()> {
    // ---- rejections first (nothing is written above this line) -------------
    let Some((existing, _)) =
        lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    if existing.host_id != signing_host_id {
        return Ok(Err(ApiError::forbidden(
            "work host cannot share another host session",
        )));
    }
    // The signer is a host; its principal carries its owner's member id. The
    // session must be that member's own.
    if existing.member_id != owner_member_id {
        return Ok(Err(ApiError::forbidden(
            "work host cannot share another member session",
        )));
    }
    if existing.origin != "local_pty" {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_SHARE_LOCAL_ONLY,
            "only a shared local session carries an S1 payload",
        )));
    }

    // ---- writes ------------------------------------------------------------
    let kind = match validated {
        Validated::Unshare => delete_share_in_tx(conn, workspace_id, session_id)
            .await?
            .then_some("disabled"),
        Validated::Share(fields) => {
            if existing.status == "ended" {
                return Ok(Err(ApiError::coded(
                    StatusCode::CONFLICT,
                    CODE_SHARE_SESSION_ENDED,
                    "an ended session cannot start or update sharing",
                )));
            }
            match upsert_share_in_tx(conn, workspace_id, session_id, &fields).await? {
                ShareTransition::Enabled => Some("enabled"),
                ShareTransition::StateChanged => Some("state_changed"),
                ShareTransition::Unchanged => None,
            }
        }
    };

    if let Some(kind) = kind {
        let discriminator = allocate_uuid_v7(conn).await?;
        emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &share_changed_payload(
                &cent_channel(workspace_id, existing.channel_id),
                existing.channel_id,
                session_id,
                kind,
                now_ms(),
                discriminator,
            ),
            Some(existing.channel_id),
        )
        .await
        .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;
        if kind != "state_changed" {
            // On/off only: a state flip every few seconds is not an audit event.
            // No payload is recorded — the audit row says that sharing changed,
            // never what was shared.
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, "work.session.share")
                    .by(existing.member_id)
                    .target("work_session", session_id)
                    .with_schema(
                        "momo.work.session.share.v1",
                        json!({ "session_id": session_id.to_string(), "kind": kind }),
                    ),
            )
            .await
            .map_err(T3Error::from)?;
        }
    }
    Ok(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> Vec<String> {
        vec!["github.com".into()]
    }

    fn parse(value: serde_json::Value) -> Result<ShareWorkSessionRequest, ApiError> {
        parse_body(value.to_string().as_bytes())
    }

    #[test]
    fn a_commit_title_or_any_unknown_field_is_not_part_of_the_payload() {
        for field in [
            "commitTitle",
            "commits",
            "files",
            "fileNames",
            "output",
            "cwd",
            "remoteUrl",
        ] {
            let mut body =
                json!({"shared": true, "repo": "momo", "harness": "claude", "state": "running"});
            body[field] = json!("x");
            assert!(parse(body).is_err(), "{field} must be refused");
        }
        let nested = json!({"shared": true, "repo": "momo", "harness": "claude", "state": "running",
                            "diff": {"added": 1, "fileNames": ["a.rs"]}});
        assert!(parse(nested).is_err());
    }

    #[test]
    fn unshare_takes_no_payload() {
        let ok = parse(json!({"shared": false})).unwrap();
        assert!(matches!(
            validate(ok, &hosts(), 1_900_000_000_000),
            Ok(Validated::Unshare)
        ));
        let extra = parse(json!({"shared": false, "repo": "momo"})).unwrap();
        assert!(validate(extra, &hosts(), 1_900_000_000_000).is_err());
    }

    #[test]
    fn share_requires_harness_and_state() {
        for missing in ["harness", "state"] {
            let mut body =
                json!({"shared": true, "repo": "momo", "harness": "claude", "state": "running"});
            body.as_object_mut().unwrap().remove(missing);
            let request = parse(body).unwrap();
            assert!(
                validate(request, &hosts(), 1_900_000_000_000).is_err(),
                "{missing}"
            );
        }
    }

    #[test]
    fn a_type_error_does_not_echo_the_value() {
        let error = parse_body(br#"{"shared": "sk-secret-value"}"#).unwrap_err();
        assert!(!format!("{error:?}").contains("sk-secret-value"));
    }
}
