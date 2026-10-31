//! ADR-0186 v8 / ADR-0218 appendix B-C: the drafts that stand behind one approval card.
//!
//! An agent proposes 1-4 candidates for ONE expression. Each becomes an
//! `expression_draft` row owned by the approval (`approval_id`, `candidate_index`), created
//! in the proposal's own transaction. A person looks at the stored pixels and chooses one;
//! the decision transaction proves everything again ([`choose_in_tx`]) and registers exactly
//! that one. Every function here takes the caller's connection: nothing opens a transaction
//! of its own, because the approval, the card and the drafts commit or roll back together.

use chrono::{DateTime, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgRow, Row};
use uuid::Uuid;

use crate::media::{Processed, Rendition};
use crate::store::{
    adder_allows, adder_allows_in_tx, authorize, catalog, changed, draft_json, expression_json,
    metadata, put_images, unexpired,
};
use crate::{
    hash, valid_source_url, version, Actor, Choice, Error, ImageInfo, Metadata, Origin, QUOTA,
    SOURCE_CODES,
};

/// ADR-0218 appendix B: `candidates` is 1-4.
pub const CANDIDATES_MAX: usize = 4;
/// `Origin.prompt`'s ceiling in Unicode scalars (`contracts.schema.json`).
pub const PROMPT_MAX_CHARS: usize = 2000;
/// One deadline for preparing all candidates of one proposal (fetch + decode, in turn).
pub const PREPARE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(40);

/// One candidate as the proposal prepared it, before any row exists.
pub struct Candidate {
    pub meta: Metadata,
    pub origin: Origin,
    /// `Some` = a ready picture; `None` = a manual card, with `code`.
    pub media: Option<Processed>,
    pub code: Option<&'static str>,
}

/// The agent's own plain text that explains a generated picture (`Origin.prompt`): 1 to
/// [`PROMPT_MAX_CHARS`] characters and no control character but a line break. The one rule for a
/// `generated` candidate and for `oort_expression_assemble`'s prompt (ADR-0218 G1/G3.6), which
/// becomes that candidate's origin.
pub fn valid_prompt(prompt: &str) -> bool {
    !prompt.is_empty()
        && prompt.chars().count() <= PROMPT_MAX_CHARS
        && !prompt
            .chars()
            .any(|c| c == '\u{7f}' || (c.is_control() && c != '\n'))
}

/// Which `(origin, picture, reason)` combinations a **candidate** draft may have. Deliberately
/// not [`crate::draft_origin_ok`], which is the direct API's and rejects prompts: a candidate
/// may be `generated` (with the agent's prompt), and only a link may fail with a `source_*`
/// reason. A picture and a reason are mutually exclusive.
pub fn candidate_origin_ok(origin: &Origin, has_media: bool, code: Option<&str>) -> bool {
    let kind_ok = match origin.kind.as_str() {
        "url" => {
            origin.prompt.is_none() && origin.source_url.as_deref().is_some_and(valid_source_url)
        }
        "attachment" => origin.prompt.is_none() && origin.source_url.is_none(),
        "generated" => {
            origin.source_url.is_none() && origin.prompt.as_deref().is_some_and(valid_prompt)
        }
        _ => false,
    };
    kind_ok
        && match (has_media, code) {
            (true, None) => true,
            (false, Some("video_processing_unavailable")) => origin.kind != "generated",
            (false, Some(code)) => origin.kind == "url" && SOURCE_CODES.contains(&code),
            (false, None) | (true, Some(_)) => false,
        }
}

/// What staging one candidate produced.
#[derive(Debug, Clone)]
pub struct Staged {
    pub draft_id: Uuid,
    pub revision: i64,
    /// The large rendition's sha256, for a ready picture.
    pub sha256: Option<String>,
    pub code: Option<String>,
}

fn host_of(link: &str) -> Option<String> {
    let rest = link.strip_prefix("https://")?;
    let authority = rest.split('/').next()?;
    let host = if authority.starts_with('[') {
        authority.split(']').next().map(|h| format!("{h}]"))?
    } else {
        authority.split(':').next()?.to_string()
    };
    (!host.is_empty()).then_some(host)
}

/// The `staged` audit row (ADR-0218 D6): the origin's kind and **domain**, the closed reason
/// code, a hash prefix, the approval id. Never bytes, base64, the prompt or the original link.
/// It is also where a failed link's reason code survives the TTL sweep, which clears the
/// draft row's own `code`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn audit_staged(
    conn: &mut PgConnection,
    workspace: Uuid,
    by: Uuid,
    draft: Uuid,
    origin: &Origin,
    code: Option<&str>,
    sha256: Option<&str>,
    approval: Option<Uuid>,
    extra: Value,
) -> Result<(), Error> {
    let mut detail = json!({
        "draft_id": draft.to_string(),
        "origin_kind": origin.kind,
        "origin_domain": origin.source_url.as_deref().and_then(host_of),
        "code": code,
        "sha256_prefix": sha256.map(|sha| sha.chars().take(12).collect::<String>()),
        "approval_id": approval.map(|id| id.to_string()),
    });
    if let (Some(more), Some(object)) = (extra.as_object(), detail.as_object_mut()) {
        object.extend(more.clone());
    }
    write_audit(
        conn,
        &AuditEntry::new(workspace, "expression.staged")
            .by(by)
            .target("expression_draft", draft)
            .with_schema("momo.expression.staged.v1", detail),
    )
    .await?;
    Ok(())
}

/// Insert the drafts of one proposal. Call it **after** the approval row exists (the FK) and
/// in the same transaction. `ids` are pre-assigned so the approval's stored arguments can name
/// them; `expires_at` is the approval's own expiry (ADR-0218 D2: an action draft follows the
/// approval's TTL, not the direct draft's hour).
pub async fn insert_candidates_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    approval_id: Uuid,
    proposer: Uuid,
    expires_at: DateTime<Utc>,
    ids: &[Uuid],
    items: Vec<Candidate>,
) -> Result<Vec<Staged>, Error> {
    if items.is_empty() || items.len() > CANDIDATES_MAX || ids.len() != items.len() {
        return Err(Error::Invalid);
    }
    // One face for the whole card: the role gate reads a single subject.
    let face = items[0].meta.subject_member_id;
    let mut staged = Vec::with_capacity(items.len());
    for (index, (id, item)) in ids.iter().zip(items).enumerate() {
        item.meta.validate()?;
        if item.meta.subject_member_id != face
            || !candidate_origin_ok(&item.origin, item.media.is_some(), item.code)
        {
            return Err(Error::Invalid);
        }
        let ready = item.media.is_some();
        sqlx::query("INSERT INTO expression_draft(workspace_id,id,name,display_name,tags,subject_member_id,origin,creator,approval_id,candidate_index,state,code,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
            .bind(workspace).bind(id).bind(&item.meta.name).bind(&item.meta.display_name)
            .bind(json!(item.meta.tags)).bind(item.meta.subject_member_id).bind(json!(item.origin))
            .bind(proposer).bind(approval_id).bind(index as i32)
            .bind(if ready { "ready" } else { "manual_upload_required" }).bind(item.code).bind(expires_at)
            .execute(&mut *conn).await?;
        let sha256 = item
            .media
            .as_ref()
            .map(|media| media.large.info.sha256.clone());
        if let Some(media) = &item.media {
            put_images(conn, workspace, *id, Some(1), media).await?;
        }
        audit_staged(
            conn,
            workspace,
            proposer,
            *id,
            &item.origin,
            item.code,
            sha256.as_deref(),
            Some(approval_id),
            json!({"candidate_index": index}),
        )
        .await?;
        staged.push(Staged {
            draft_id: *id,
            revision: 1,
            sha256,
            code: item.code.map(str::to_owned),
        });
    }
    Ok(staged)
}

/// `approval_request.props.action.expression` (ADR-0218 `Approval`): every candidate as the
/// wire `Draft`, in candidate order, read from the rows as they are **now** (so a replaced
/// picture shows its new revision and hash).
pub async fn card_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    approval_id: Uuid,
) -> Result<Value, Error> {
    let rows = sqlx::query("SELECT * FROM expression_draft WHERE workspace_id=$1 AND approval_id=$2 ORDER BY candidate_index")
        .bind(workspace).bind(approval_id).fetch_all(&mut *conn).await?;
    let mut candidates = Vec::with_capacity(rows.len());
    for row in &rows {
        candidates.push(draft_json(conn, row).await?);
    }
    Ok(json!({"v": 1, "candidates": candidates}))
}

/// What the decision registered.
#[derive(Debug, Clone)]
pub struct Chosen {
    /// ADR-0218 `Mutation`: kept as the draft's receipt, like a direct activation.
    pub receipt: Value,
    pub expression_id: Uuid,
    pub name: String,
    pub origin: Origin,
    pub sha256: String,
    pub subject: Option<Uuid>,
}

/// Register the one chosen candidate, inside the **decision's** transaction.
///
/// Every proof is a read, and all of them happen before the first write: the caller turns an
/// `Err` into a refusal that commits, so a half-done registration must be impossible. In
/// order: the add role/policy **now** (catalog locked) and, for a face, the person; the
/// candidate's membership of this approval; its state, revision and TTL; the **stored bytes
/// hashed again** against both the row and the hash the person was shown; the permanent name;
/// the quota. Then: version + audit + outbox, the expression, its three renditions, and the
/// bytes of every other candidate reclaimed.
pub async fn choose_in_tx(
    conn: &mut PgConnection,
    decider: Actor,
    approval_id: Uuid,
    proposer: Uuid,
    drafts: &[Uuid],
    subject_pin: Option<Uuid>,
    choice: &Choice,
) -> Result<Chosen, Error> {
    let revision = version(&choice.revision)?;
    if !hash(&choice.sha256) {
        return Err(Error::Invalid);
    }
    let ws = decider.workspace;
    let (_, policy) = catalog(conn, ws).await?;
    let who = authorize(conn, decider).await?;
    if !adder_allows(&policy, &who, subject_pin, decider.member) {
        return Err(Error::Role);
    }
    if !drafts.contains(&choice.draft_id) {
        return Err(Error::Stale);
    }
    // Every candidate of the card, locked in index order (replace and reclaim take the same
    // order), so a replacement or a sweep cannot slip between the proofs and the writes.
    let rows = sqlx::query("SELECT * FROM expression_draft WHERE workspace_id=$1 AND approval_id=$2 ORDER BY candidate_index FOR UPDATE")
        .bind(ws).bind(approval_id).fetch_all(&mut *conn).await?;
    let row = rows
        .iter()
        .find(|row| row.try_get::<Uuid, _>("id").ok() == Some(choice.draft_id))
        .ok_or(Error::Stale)?;
    if row.try_get::<Uuid, _>("creator")? != proposer
        || row.try_get::<Option<Uuid>, _>("subject_member_id")? != subject_pin
        || row.try_get::<String, _>("state")? != "ready"
        || row.try_get::<i64, _>("revision")? != revision
    {
        return Err(Error::Stale);
    }
    unexpired(row)?;
    let stored = sqlx::query("SELECT variant, bytes, sha256 FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2")
        .bind(ws).bind(choice.draft_id).fetch_all(&mut *conn).await?;
    let mut seen_large = false;
    for image in &stored {
        let bytes: Vec<u8> = image.try_get("bytes")?;
        let recorded: String = image.try_get("sha256")?;
        let actual = hex::encode(Sha256::digest(&bytes));
        if actual != recorded {
            return Err(Error::Stale);
        }
        if image.try_get::<String, _>("variant")? == "large" {
            seen_large = true;
            if actual != choice.sha256 {
                return Err(Error::Stale);
            }
        }
    }
    if stored.len() != 3 || !seen_large {
        return Err(Error::Stale);
    }
    let meta = metadata(row)?;
    meta.validate()?;
    let origin: Origin =
        serde_json::from_value(row.try_get::<Value, _>("origin")?).map_err(|_| Error::Invalid)?;
    let reserved: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM expression WHERE workspace_id=$1 AND name=$2)",
    )
    .bind(ws)
    .bind(&meta.name)
    .fetch_one(&mut *conn)
    .await?;
    if reserved {
        return Err(Error::NameReserved);
    }
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM expression WHERE workspace_id=$1 AND status <> 'deleted'",
    )
    .bind(ws)
    .fetch_one(&mut *conn)
    .await?;
    if live >= QUOTA {
        return Err(Error::Quota);
    }

    // ---- proofs done: writes only from here -----------------------------------------
    let id = choice.draft_id;
    let version_after = changed(
        conn,
        decider,
        id,
        "expression.created",
        Some(json!({
            "approval_id": approval_id.to_string(),
            "proposed_by": proposer.to_string(),
            "origin_kind": origin.kind,
            "origin_domain": origin.source_url.as_deref().and_then(host_of),
            "sha256_prefix": choice.sha256.chars().take(12).collect::<String>(),
        })),
    )
    .await?;
    let created = sqlx::query("INSERT INTO expression(workspace_id,id,name,display_name,tags,subject_member_id,origin,created_by,proposed_by,approval_id,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *")
        .bind(ws).bind(id).bind(&meta.name).bind(&meta.display_name).bind(json!(meta.tags))
        .bind(meta.subject_member_id).bind(json!(origin)).bind(decider.member).bind(proposer)
        .bind(approval_id).bind(version_after).fetch_one(&mut *conn).await?;
    sqlx::query("INSERT INTO expression_image(workspace_id,expression_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) SELECT workspace_id,draft_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2")
        .bind(ws).bind(id).execute(&mut *conn).await?;
    let receipt = json!({"workspaceId": ws, "version": version_after.to_string(),
        "expression": expression_json(conn, &created).await?});
    sqlx::query("DELETE FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2")
        .bind(ws)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE expression_draft SET state='activated',submitted_by=$3,submitted_revision=$4,submitted_sha256=$5,receipt=$6 WHERE workspace_id=$1 AND id=$2")
        .bind(ws).bind(id).bind(decider.member).bind(revision).bind(&choice.sha256).bind(&receipt)
        .execute(&mut *conn).await?;
    // Every other candidate's bytes go in this same transaction.
    reclaim_in_tx(conn, ws, approval_id).await?;
    Ok(Chosen {
        receipt,
        expression_id: id,
        name: meta.name,
        origin,
        sha256: choice.sha256.clone(),
        subject: meta.subject_member_id,
    })
}

/// Reclaim the bytes of every candidate of `approval_id` that is not activated (reject,
/// expiry, cancel, and the siblings of a registration). The draft rows stay as records; their
/// state becomes `expired`. The approval's own row is already locked by the caller.
pub async fn reclaim_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    approval_id: Uuid,
) -> Result<u64, Error> {
    let freed = sqlx::query("DELETE FROM expression_draft_image i USING expression_draft d WHERE (i.workspace_id,i.draft_id)=(d.workspace_id,d.id) AND d.workspace_id=$1 AND d.approval_id=$2 AND d.state IN ('ready','manual_upload_required')")
        .bind(workspace).bind(approval_id).execute(&mut *conn).await?.rows_affected();
    sqlx::query("UPDATE expression_draft SET state='expired',code=NULL WHERE workspace_id=$1 AND approval_id=$2 AND state IN ('ready','manual_upload_required')")
        .bind(workspace).bind(approval_id).execute(&mut *conn).await?;
    Ok(freed)
}

/// A draft that stands behind a still-open approval, if `actor` may see it.
///
/// Open means: the approval is pending and unexpired and the draft is live. May see means
/// either the agent that proposed it, or an active member of the card's channel for whom
/// [`adder_allows`] holds against the card's face **now** (a policy narrowed after the
/// proposal is read again here). A different tenant, a different room, a stranger and an
/// unknown id are one `NotFound`; display names, tags and the prompt are never consulted.
async fn candidate_row(
    conn: &mut PgConnection,
    actor: Actor,
    id: Uuid,
) -> Result<(PgRow, Uuid), Error> {
    let row = sqlx::query("SELECT d.*, a.status::text AS approval_status, a.channel_id AS approval_channel, a.expires_at AS approval_expires FROM expression_draft d JOIN approval a ON (a.workspace_id,a.id)=(d.workspace_id,d.approval_id) WHERE d.workspace_id=$1 AND d.id=$2 AND d.approval_id IS NOT NULL")
        .bind(actor.workspace).bind(id).fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
    let approval_expires: Option<DateTime<Utc>> = row.try_get("approval_expires")?;
    if row.try_get::<String, _>("approval_status")? != "pending"
        || approval_expires.is_some_and(|at| at <= Utc::now())
        || !matches!(
            row.try_get::<String, _>("state")?.as_str(),
            "ready" | "manual_upload_required"
        )
    {
        return Err(Error::NotFound);
    }
    let channel: Uuid = row.try_get("approval_channel")?;
    let allowed = if row.try_get::<Uuid, _>("creator")? == actor.member {
        true
    } else {
        let in_room: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM membership WHERE workspace_id=$1 AND channel_id=$2 AND member_id=$3 AND left_at IS NULL)")
            .bind(actor.workspace).bind(channel).bind(actor.member).fetch_one(&mut *conn).await?;
        in_room
            && adder_allows_in_tx(
                conn,
                actor.workspace,
                actor.member,
                row.try_get("subject_member_id")?,
            )
            .await?
    };
    if !allowed {
        return Err(Error::NotFound);
    }
    Ok((row, channel))
}

/// `GET /expression-drafts/{id}` for a candidate draft.
pub async fn candidate_get_in_tx(
    conn: &mut PgConnection,
    actor: Actor,
    id: Uuid,
) -> Result<Value, Error> {
    let (row, _) = candidate_row(conn, actor, id).await?;
    unexpired(&row)?;
    draft_json(conn, &row).await
}

/// `GET /expression-drafts/{id}/image` for a candidate draft: the pinned stored bytes.
pub async fn candidate_image_in_tx(
    conn: &mut PgConnection,
    actor: Actor,
    id: Uuid,
    variant: &str,
    sha: &str,
) -> Result<Rendition, Error> {
    let (row, _) = candidate_row(conn, actor, id).await?;
    if row.try_get::<String, _>("state")? != "ready" || unexpired(&row).is_err() {
        return Err(Error::NotFound);
    }
    let image = sqlx::query("SELECT * FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2 AND variant=$3 AND sha256=$4")
        .bind(actor.workspace).bind(id).bind(variant).bind(sha)
        .fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
    let data: Vec<u8> = image.try_get("bytes")?;
    Ok(Rendition {
        info: ImageInfo {
            mime: image.try_get("mime")?,
            sha256: image.try_get("sha256")?,
            bytes: data.len(),
            width: image.try_get::<i32, _>("width")? as u32,
            height: image.try_get::<i32, _>("height")? as u32,
            frame_count: image.try_get::<i32, _>("frame_count")? as u32,
            duration_ms: image.try_get::<i32, _>("duration_ms")? as u32,
        },
        data,
    })
}

/// Is `id` a candidate draft of an open approval that `actor` may see? (The route asks this to
/// choose between the direct-draft path and this one.)
pub async fn is_candidate_in_tx(conn: &mut PgConnection, actor: Actor, id: Uuid) -> bool {
    candidate_row(conn, actor, id).await.is_ok()
}

/// A candidate replaced by a direct upload (ADR-0186 X8-4).
#[derive(Debug, Clone)]
pub struct Replaced {
    pub draft: Value,
    /// The card's `action.expression` as it now stands.
    pub card: Value,
    pub approval_id: Uuid,
    pub request_message_id: Option<Uuid>,
}

/// `PUT /expression-drafts/{id}/file` on a candidate draft, inside the caller's transaction:
/// the same draft id, origin, name, face and TTL; revision + 1 and **new immutable pixels**,
/// so an earlier choice (the old revision and hash) fails as stale and the approval is not
/// spent. Who may replace is who may decide, judged now; the replacement changes neither the
/// face nor the policy question. Lock order is the decision's: approval, catalog, drafts.
pub async fn replace_candidate_in_tx(
    conn: &mut PgConnection,
    actor: Actor,
    id: Uuid,
    media: &Processed,
) -> Result<Replaced, Error> {
    let approval_id: Uuid = sqlx::query_scalar("SELECT approval_id FROM expression_draft WHERE workspace_id=$1 AND id=$2 AND approval_id IS NOT NULL")
        .bind(actor.workspace).bind(id).fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
    let approval = sqlx::query("SELECT status::text AS status, channel_id, expires_at, request_message_id FROM approval WHERE workspace_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.workspace).bind(approval_id).fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
    let approval_expires: Option<DateTime<Utc>> = approval.try_get("expires_at")?;
    if approval.try_get::<String, _>("status")? != "pending" {
        return Err(Error::NotFound);
    }
    if approval_expires.is_some_and(|at| at <= Utc::now()) {
        return Err(Error::Expired);
    }
    let (_, policy) = catalog(conn, actor.workspace).await?;
    let rows = sqlx::query("SELECT * FROM expression_draft WHERE workspace_id=$1 AND approval_id=$2 ORDER BY candidate_index FOR UPDATE")
        .bind(actor.workspace).bind(approval_id).fetch_all(&mut *conn).await?;
    let row = rows
        .iter()
        .find(|row| row.try_get::<Uuid, _>("id").ok() == Some(id))
        .ok_or(Error::NotFound)?;
    let in_room: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM membership WHERE workspace_id=$1 AND channel_id=$2 AND member_id=$3 AND left_at IS NULL)")
        .bind(actor.workspace).bind(approval.try_get::<Uuid, _>("channel_id")?).bind(actor.member)
        .fetch_one(&mut *conn).await?;
    if !in_room {
        return Err(Error::NotFound);
    }
    if !matches!(
        row.try_get::<String, _>("state")?.as_str(),
        "ready" | "manual_upload_required"
    ) {
        return Err(Error::NotFound);
    }
    unexpired(row)?;
    // The person must be allowed to decide this card: the add policy now and, for a face, the
    // face. (`authorize` takes the membership lock the decision takes too.)
    let who = authorize(conn, actor).await?;
    if !adder_allows(
        &policy,
        &who,
        row.try_get("subject_member_id")?,
        actor.member,
    ) {
        return Err(Error::Role);
    }
    let origin: Origin =
        serde_json::from_value(row.try_get::<Value, _>("origin")?).map_err(|_| Error::Invalid)?;
    sqlx::query("DELETE FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2")
        .bind(actor.workspace)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    let updated = sqlx::query("UPDATE expression_draft SET revision=revision+1,state='ready',code=NULL WHERE workspace_id=$1 AND id=$2 RETURNING *")
        .bind(actor.workspace).bind(id).fetch_one(&mut *conn).await?;
    put_images(
        conn,
        actor.workspace,
        id,
        Some(updated.try_get("revision")?),
        media,
    )
    .await?;
    audit_staged(
        conn,
        actor.workspace,
        actor.member,
        id,
        &origin,
        None,
        Some(&media.large.info.sha256),
        Some(approval_id),
        json!({"replaced_revision": updated.try_get::<i64, _>("revision")?.to_string()}),
    )
    .await?;
    let draft = draft_json(conn, &updated).await?;
    let card = card_in_tx(conn, actor.workspace, approval_id).await?;
    Ok(Replaced {
        draft,
        card,
        approval_id,
        request_message_id: approval.try_get("request_message_id")?,
    })
}
