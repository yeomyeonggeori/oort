//! Team AI image preparation, outside the proposal transaction (ADR-0186 v7).
//! No arbitrary URL is fetched. Attachments belong to the requesting human in this
//! conversation; retrieved images arrive as bounded base64, like Agent Port images.

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

pub async fn prepare(
    pool: &PgPool,
    drive: &dyn DriveArchive,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_id: Uuid,
    args: &ActionArgs,
) -> Result<Option<PreparedAvatar>, &'static str> {
    let result = prepare_inner(pool, drive, workspace_id, run_id, agent_id, args).await;
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
    drive: &dyn DriveArchive,
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
        (AvatarIntent::Attachment(_), Some(source)) => {
            let max = momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_ATTACHMENT;
            let content = drive
                .file_content(&source.drive_file_id, source.size_bytes)
                .await
                .map_err(|_| "drive_unavailable")?;
            (
                content
                    .read_prefix(max + 1)
                    .await
                    .map_err(|_| "drive_unavailable")?,
                max,
                "attachment",
            )
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
