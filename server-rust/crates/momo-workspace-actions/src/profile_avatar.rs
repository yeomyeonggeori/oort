//! Team AI image preparation, outside the proposal transaction (ADR-0186 v7).
//! No arbitrary URL is fetched. Attachments belong to the requesting human in this
//! conversation; retrieved images arrive as bounded base64, like Agent Port images.
//!
//! ## Where an attachment's bytes come from (#4934, ADR-0151 증보 3)
//!
//! The database decides **whose** picture it is ([`momo_messaging::find_requester_attachment_in_tx`]);
//! [`AttachmentBytes`] only fetches what it was just proved to be. Two readers: the archive itself
//! ([`DriveAttachmentBytes`], what a deployment whose worker mounts or can authenticate to the archive
//! has always used) and, when the archive lives on another service's volume, the api's own route (the
//! agent-worker's `ApiAttachmentBytes`). Neither lets the model name anything but the attachment id.

use async_trait::async_trait;
use base64::Engine as _;
use momo_db::{with_tenant_tx, PgPool};
use momo_drive::DriveArchive;
use momo_messaging::ProcessedAvatar;
use uuid::Uuid;

use crate::action_resolve::{ActionArgs, AvatarIntent};

#[derive(Clone)]
pub struct PreparedAvatar {
    pub image: ProcessedAvatar,
    pub origin: &'static str,
    pub requester: Uuid,
    pub run_id: Uuid,
}

static DECODE_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// The attachment a proposal's picture comes from, **as the database has just proved it**: the run's
/// requester's own complete image, written by them in the run's conversation.
///
/// Deliberately not `Debug`: `drive_file_id` is the archive's own name for the file, and no log line,
/// error or audit row has any business holding it.
pub struct RequesterAttachment<'a> {
    pub workspace_id: Uuid,
    pub run_id: Uuid,
    pub agent_id: Uuid,
    pub attachment_id: Uuid,
    /// The archive's id for the file: the direct reader needs it, the api reader never looks at it.
    pub drive_file_id: &'a str,
    /// The size the attachment row declares (already within `max_bytes`).
    pub size_bytes: i64,
    /// The ceiling a reader must not read past. One byte more than the ceiling is allowed back, so the
    /// decoder — not the reader — is what calls a too-large file too large.
    pub max_bytes: usize,
    /// What the bytes are wanted for (#4970): an avatar proposal's three picture types, or the helper's
    /// `read_attachment` (also text and PDF). It picks the token's rule and the types the answer may be.
    pub usage: momo_messaging::RequesterAttachmentUse,
}

/// Fetch the bytes of an attachment the caller has already proved to be the requester's. The error is a
/// fixed reason code (the audit `reason` of a refused proposal), never a transport message: those carry
/// addresses, and an address of this kind carries a credential.
#[async_trait]
pub trait AttachmentBytes: Send + Sync {
    async fn read(&self, attachment: &RequesterAttachment<'_>) -> Result<Vec<u8>, &'static str>;
}

/// The archive read directly: the deployment's own Drive or local volume, by the row's file id.
pub struct DriveAttachmentBytes<'a>(pub &'a dyn DriveArchive);

#[async_trait]
impl AttachmentBytes for DriveAttachmentBytes<'_> {
    async fn read(&self, attachment: &RequesterAttachment<'_>) -> Result<Vec<u8>, &'static str> {
        let content = self
            .0
            .file_content(attachment.drive_file_id, attachment.size_bytes)
            .await
            .map_err(|_| "drive_unavailable")?;
        content
            .read_prefix(attachment.max_bytes + 1)
            .await
            .map_err(|_| "drive_unavailable")
    }
}

/// Same decoder, limits and blocking-task lifetime as the Agent Port image door.
pub async fn process_image(bytes: Vec<u8>, max: usize) -> Result<ProcessedAvatar, &'static str> {
    let work = async move {
        let permit = DECODE_PERMITS.acquire().await.map_err(|_| "busy")?;
        tokio::task::spawn_blocking(move || {
            let _held = permit;
            momo_messaging::process_avatar_image(&bytes, max).map_err(|error| error.code())
        })
        .await
        .map_err(|_| "busy")?
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), work)
        .await
        .map_err(|_| "timeout")?
}

/// [`prepare_with`] over the archive itself — the deployment whose worker can read it.
pub async fn prepare(
    pool: &PgPool,
    drive: &dyn DriveArchive,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_id: Uuid,
    args: &ActionArgs,
) -> Result<Option<PreparedAvatar>, &'static str> {
    prepare_with(
        pool,
        &DriveAttachmentBytes(drive),
        workspace_id,
        run_id,
        agent_id,
        args,
    )
    .await
}

pub async fn prepare_with(
    pool: &PgPool,
    attachments: &dyn AttachmentBytes,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_id: Uuid,
    args: &ActionArgs,
) -> Result<Option<PreparedAvatar>, &'static str> {
    let result = prepare_inner(pool, attachments, workspace_id, run_id, agent_id, args).await;
    if let Err(reason) = result.as_ref() {
        if matches!(args, ActionArgs::MemberAvatarSet { .. }) {
            let reason = *reason;
            // Reason codes only. Rate-limit refusals do not extend the hourly window.
            let _ = with_tenant_tx(pool, workspace_id, move |conn| {
                Box::pin(async move {
                    let person = momo_messaging::requester_of_run_in_tx(
                        conn,
                        workspace_id,
                        run_id,
                        agent_id,
                    )
                    .await?;
                    let mut entry = momo_db::audit::AuditEntry::new(
                        workspace_id,
                        momo_agent::actions::AUDIT_MEMBER_AVATAR_REFUSED,
                    )
                    .by(agent_id)
                    .run(run_id)
                    .with_schema(
                        momo_agent::actions::AUDIT_MEMBER_AVATAR_REFUSED_SCHEMA,
                        serde_json::json!({"reason":reason}),
                    );
                    if let Some((person, _)) = person {
                        entry = entry.about(person).target("member", person);
                    }
                    momo_db::audit::write_audit(conn, &entry).await
                })
            })
            .await;
        }
    }
    result
}

async fn prepare_inner(
    pool: &PgPool,
    attachments: &dyn AttachmentBytes,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_id: Uuid,
    args: &ActionArgs,
) -> Result<Option<PreparedAvatar>, &'static str> {
    let avatar = match args {
        ActionArgs::MemberAvatarSet { avatar, .. }
        | ActionArgs::AgentProfileUpdate { avatar, .. } => avatar,
        _ => return Ok(None),
    };
    if !matches!(
        avatar,
        AvatarIntent::Attachment(_) | AvatarIntent::Generated(_)
    ) {
        return Ok(None);
    }
    let attachment_id = match avatar {
        AvatarIntent::Attachment(id) => Some(*id),
        _ => None,
    };
    let member_avatar = matches!(args, ActionArgs::MemberAvatarSet { .. });
    let looked_up = with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            // The existing worker exception is unchanged: tenant GUC + explicit workspace
            // and requester predicates, never a subject supplied by the model.
            let Some((requester, channel)) =
                momo_messaging::requester_of_run_in_tx(conn, workspace_id, run_id, agent_id)
                    .await?
            else {
                return Ok(Err("no_requester"));
            };
            if member_avatar {
                let recent: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND subject_member_id=$2 \
                 AND action IN ('member.avatar.staged','member.avatar.refused') \
                 AND detail->>'reason' IS DISTINCT FROM 'rate_limited' \
                 AND created_at > now() - interval '1 hour'",
            ).bind(workspace_id).bind(requester).fetch_one(&mut *conn).await?;
                if recent >= momo_agent::actions::MEMBER_AVATAR_PROPOSALS_PER_HOUR {
                    return Ok(Err(momo_agent::actions::MEMBER_AVATAR_RATE_LIMITED_REASON));
                }
            }
            let source = if let Some(id) = attachment_id {
                let Some(source) = momo_messaging::find_requester_attachment_in_tx(
                    conn,
                    workspace_id,
                    requester,
                    channel,
                    id,
                    momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_ATTACHMENT as i64,
                )
                .await?
                else {
                    return Ok(Err("attachment_not_available"));
                };
                Some(source)
            } else {
                None
            };
            Ok(Ok((requester, source)))
        })
    })
    .await
    .map_err(|_| "unavailable")?;
    let (requester, source) = looked_up?;
    let (bytes, max, origin) = match (avatar, source) {
        (AvatarIntent::Generated(encoded), _) => (
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "invalid_base64")?,
            momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_GENERATED,
            "generated",
        ),
        (AvatarIntent::Attachment(attachment_id), Some(source)) => {
            let max = momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_ATTACHMENT;
            let bytes = attachments
                .read(&RequesterAttachment {
                    workspace_id,
                    run_id,
                    agent_id,
                    attachment_id: *attachment_id,
                    drive_file_id: &source.drive_file_id,
                    size_bytes: source.size_bytes,
                    max_bytes: max,
                    usage: momo_messaging::RequesterAttachmentUse::Avatar,
                })
                .await?;
            (bytes, max, "attachment")
        }
        _ => return Err("image_not_available"),
    };
    let image = process_image(bytes, max).await?;
    Ok(Some(PreparedAvatar {
        image,
        origin,
        requester,
        run_id,
    }))
}

/// Public preview metadata, made only from the server's re-encoded bytes.
pub fn preview(prepared: &PreparedAvatar, image_id: Uuid) -> serde_json::Value {
    serde_json::json!({
        "kind": "avatar_image", "imageId": image_id.to_string(),
        "sha256": hex(&prepared.image.sha256), "mime": prepared.image.mime,
        "width": prepared.image.width, "height": prepared.image.height,
        "sizeBytes": prepared.image.bytes.len(), "origin": prepared.origin,
    })
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// An authenticated, versioned path to the picture being replaced. Never an
/// agent-supplied URL, and never bytes in a message or audit entry.
pub async fn add_previous_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    target: Uuid,
    preview: &mut serde_json::Value,
) -> Result<(), momo_db::DbError> {
    let current: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT COALESCE(avatar_image_id, avatar_media_id) FROM member WHERE workspace_id=$1 AND id=$2",
    ).bind(workspace_id).bind(target).fetch_optional(&mut *conn).await?;
    preview["previousAvatarUrl"] = current
        .flatten()
        .map(|id| format!("/v1/workspaces/{workspace_id}/members/{target}/avatar/content?v={id}"))
        .into();
    Ok(())
}
