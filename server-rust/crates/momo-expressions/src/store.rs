use futures::future::BoxFuture;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx_prelude, PgConnection, PgPool};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Value};
use sqlx::{postgres::PgRow, Row};
use uuid::Uuid;

use crate::media::{Processed, Rendition};
use crate::{hash, version, Choice, Error, Metadata, Origin, Patch, Report, LIVE_DRAFTS, QUOTA};

#[derive(Clone, Copy, Debug)]
pub struct Actor {
    pub workspace: Uuid,
    pub member: Uuid,
}

#[derive(Debug)]
pub struct Member {
    pub human: bool,
    pub role: String,
}
impl Member {
    pub fn admin(&self) -> bool {
        matches!(self.role.as_str(), "owner" | "admin")
    }
}

/// **The one predicate behind `expression_adder`** (ADR-0186 v8 X8-3): a live human, not a
/// guest, satisfying the add policy *as it is now*; and when the picture shows a face
/// (`subject`), also exactly that person. The decision route, the push audience, the
/// preview/replace authorization and the direct API all ask this function and nothing
/// else; a display name, a tag or a prompt is never an input.
pub fn adder_allows(policy: &str, member: &Member, subject: Option<Uuid>, decider: Uuid) -> bool {
    member.human
        && member.role != "guest"
        && (policy != "admins" || member.admin())
        && subject.is_none_or(|face| face == decider)
}

/// [`adder_allows`] for one person, read **without taking the catalog lock** (the push
/// judgment and the preview read; the decision itself re-asks under the lock in
/// [`crate::action::choose_in_tx`]). A person who is not an active member of the
/// workspace is simply not allowed.
pub async fn adder_allows_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    member: Uuid,
    subject: Option<Uuid>,
) -> Result<bool, Error> {
    let row = sqlx::query("SELECT m.kind::text AS kind, wm.role::text AS role FROM member m JOIN workspace_membership wm ON (wm.workspace_id,wm.member_id) = (m.workspace_id,m.id) WHERE m.workspace_id=$1 AND m.id=$2 AND m.status='active' AND m.deleted_at IS NULL")
        .bind(workspace).bind(member).fetch_optional(&mut *conn).await?;
    let Some(row) = row else { return Ok(false) };
    let policy: Option<String> =
        sqlx::query_scalar("SELECT add_policy FROM expression_catalog WHERE workspace_id=$1")
            .bind(workspace)
            .fetch_optional(&mut *conn)
            .await?;
    let who = Member {
        human: row.try_get::<String, _>("kind")? == "human",
        role: row.try_get("role")?,
    };
    Ok(adder_allows(
        policy.as_deref().unwrap_or("members"),
        &who,
        subject,
        member,
    ))
}

pub async fn transaction<T: Send, F>(pool: &PgPool, actor: Actor, body: F) -> Result<T, Error>
where
    F: for<'a> FnOnce(&'a mut PgConnection) -> BoxFuture<'a, Result<T, Error>> + Send,
{
    with_tenant_tx_prelude(pool,actor.workspace,
        |_|Box::pin(async {Ok::<_,Error>(())}),
        move |conn|Box::pin(async move {
            let safe:bool = sqlx::query_scalar("SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname = current_user").fetch_one(&mut *conn).await?;
            if !safe { return Err(Error::Role); }
            sqlx::query("SELECT set_config('app.expression_member_id',$1,true)").bind(actor.member.to_string()).execute(&mut *conn).await?;
            authorize(conn,actor).await?; Ok(())
        }),body).await
}

pub async fn authorize(conn: &mut PgConnection, actor: Actor) -> Result<Member, Error> {
    let row = sqlx::query("SELECT m.kind::text,wm.role::text FROM member m JOIN workspace_membership wm ON (wm.workspace_id,wm.member_id) = (m.workspace_id,m.id) WHERE m.workspace_id=$1 AND m.id=$2 AND m.status='active' AND m.deleted_at IS NULL FOR SHARE OF m,wm")
        .bind(actor.workspace).bind(actor.member).fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
    Ok(Member {
        human: row.try_get::<String, _>("kind")? == "human",
        role: row.try_get("role")?,
    })
}

pub(crate) async fn catalog(conn: &mut PgConnection, ws: Uuid) -> Result<(i64, String), Error> {
    sqlx::query("INSERT INTO expression_catalog(workspace_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(ws)
        .execute(&mut *conn)
        .await?;
    let row = sqlx::query(
        "SELECT version,add_policy FROM expression_catalog WHERE workspace_id=$1 FOR UPDATE",
    )
    .bind(ws)
    .fetch_one(&mut *conn)
    .await?;
    Ok((row.try_get("version")?, row.try_get("add_policy")?))
}

async fn can_add(
    conn: &mut PgConnection,
    actor: Actor,
    policy: &str,
    subject: Option<Uuid>,
) -> Result<(), Error> {
    // authorize already locked the person's active human membership (the subject's too:
    // a face is only ever the deciding person).
    let m = authorize(conn, actor).await?;
    if !adder_allows(policy, &m, subject, actor.member) {
        return Err(Error::Role);
    }
    Ok(())
}

/// How many direct drafts this person holds that are still live (not activated,
/// expired or approval-owned).
async fn live_drafts(conn: &mut PgConnection, actor: Actor) -> Result<i64, Error> {
    Ok(sqlx::query_scalar("SELECT count(*) FROM expression_draft WHERE workspace_id=$1 AND creator=$2 AND approval_id IS NULL AND state IN ('ready','manual_upload_required') AND expires_at>clock_timestamp()")
        .bind(actor.workspace).bind(actor.member).fetch_one(&mut *conn).await?)
}

/// Link-import preflight (#4829): the add role/policy and the person's live-draft
/// quota, proved BEFORE the server makes an outbound request on their behalf. Every
/// import that fetches ends in a draft row (ready, or a manual card), so this is
/// also what bounds how often one person can make the server fetch. `create_draft`
/// re-proves both after the fetch; this only refuses early.
pub async fn preflight_import(pool: &PgPool, actor: Actor) -> Result<(), Error> {
    transaction(pool, actor, move |conn| {
        Box::pin(async move {
            let (_, policy) = catalog(conn, actor.workspace).await?;
            can_add(conn, actor, &policy, None).await?;
            if live_drafts(conn, actor).await? >= LIVE_DRAFTS {
                return Err(Error::Quota);
            }
            Ok(())
        })
    })
    .await
}

pub async fn preflight_add(pool: &PgPool, actor: Actor) -> Result<(), Error> {
    transaction(pool, actor, move |conn| {
        Box::pin(async move {
            let (_, policy) = catalog(conn, actor.workspace).await?;
            can_add(conn, actor, &policy, None).await
        })
    })
    .await
}

/// Existing notifier polling pool discovers tenant IDs only; ALL reclamation
/// uses the existing RLS-bound write pool. Restart-safe, no process-local TTLs.
pub async fn sweep_expired(read_pool: &PgPool, write_pool: &PgPool) -> Result<u64, Error> {
    let safe: bool = sqlx::query_scalar(
        "SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
    .fetch_one(write_pool)
    .await?;
    if !safe {
        return Err(Error::Role);
    }
    // Expired drafts and expired held assemblies (ADR-0218 G3.6) are found together: one sweep. A held
    // assembly is due when its hour is up whether it is still `ready` or a reclaim already retired it
    // (`expired`): either way its header holds the agent's prompt, and the sweep deletes it.
    let workspaces:Vec<Uuid>=sqlx::query_scalar("SELECT workspace_id FROM (SELECT workspace_id FROM expression_draft WHERE state IN ('ready','manual_upload_required') AND expires_at<=clock_timestamp() UNION SELECT workspace_id FROM expression_assembly WHERE state IN ('ready','expired') AND expires_at<=clock_timestamp()) due LIMIT 100")
        .fetch_all(read_pool).await?;
    let mut bytes = 0;
    for ws in workspaces {
        bytes += momo_db::with_tenant_tx_prelude(
            write_pool,
            ws,
            |_| Box::pin(async { Ok::<_, Error>(()) }),
            |_| Box::pin(async { Ok(()) }),
            move |conn| Box::pin(async move { sweep_in_tx(conn, ws).await }),
        )
        .await?;
    }
    Ok(bytes)
}

/// Tenant-scoped sweep: byte reclamation only, never activated receipts/names.
pub async fn sweep_in_tx(conn: &mut PgConnection, ws: Uuid) -> Result<u64, Error> {
    catalog(conn, ws).await?;
    sqlx::query("SELECT id FROM expression_draft WHERE workspace_id=$1 AND state IN ('ready','manual_upload_required') AND expires_at<=clock_timestamp() FOR UPDATE")
        .bind(ws).fetch_all(&mut *conn).await?;
    let n=sqlx::query("DELETE FROM expression_draft_image i USING expression_draft d WHERE (i.workspace_id,i.draft_id)=(d.workspace_id,d.id) AND d.workspace_id=$1 AND d.state <> 'activated' AND d.expires_at <= clock_timestamp()")
        .bind(ws).execute(&mut *conn).await?.rows_affected();
    sqlx::query("UPDATE expression_draft SET state='expired',code=NULL WHERE workspace_id=$1 AND state IN ('ready','manual_upload_required') AND expires_at<=clock_timestamp()")
        .bind(ws).execute(&mut *conn).await?;
    // Held assemblies (G3.6) follow the same hour, but their header goes with the bytes (it holds the
    // agent's prompt; a draft's header is a record). See `assembly::sweep_in_tx`.
    Ok(n + crate::assembly::sweep_in_tx(conn, ws).await?)
}

pub(crate) async fn put_images(
    conn: &mut PgConnection,
    ws: Uuid,
    id: Uuid,
    revision: Option<i64>,
    media: &Processed,
) -> Result<(), Error> {
    for (variant, r) in media.variants() {
        let sql = if revision.is_some() {
            "INSERT INTO expression_draft_image(workspace_id,draft_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)"
        } else {
            "INSERT INTO expression_image(workspace_id,expression_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)"
        };
        let query = sqlx::query(sql)
            .bind(ws)
            .bind(id)
            .bind(variant)
            .bind(&r.info.mime)
            .bind(&r.data)
            .bind(&r.info.sha256)
            .bind(r.info.width as i32)
            .bind(r.info.height as i32)
            .bind(r.info.frame_count as i32)
            .bind(r.info.duration_ms as i32);
        if let Some(rev) = revision {
            query.bind(rev).execute(&mut *conn).await?;
        } else {
            query.execute(&mut *conn).await?;
        }
    }
    Ok(())
}

pub(crate) async fn media_json(
    conn: &mut PgConnection,
    ws: Uuid,
    id: Uuid,
    draft: bool,
) -> Result<Value, Error> {
    let sql = if draft {
        "SELECT variant,mime,sha256,octet_length(bytes) AS size,width,height,frame_count,duration_ms FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2"
    } else {
        "SELECT variant,mime,sha256,octet_length(bytes) AS size,width,height,frame_count,duration_ms FROM expression_image WHERE workspace_id=$1 AND expression_id=$2"
    };
    let rows = sqlx::query(sql)
        .bind(ws)
        .bind(id)
        .fetch_all(&mut *conn)
        .await?;
    let mut media = serde_json::Map::new();
    for row in rows {
        media.insert(row.try_get("variant")?,json!({"mime":row.try_get::<String,_>("mime")?,"sha256":row.try_get::<String,_>("sha256")?,
            "bytes":row.try_get::<i32,_>("size")?,"width":row.try_get::<i32,_>("width")?,"height":row.try_get::<i32,_>("height")?,
            "frameCount":row.try_get::<i32,_>("frame_count")?,"durationMs":row.try_get::<i32,_>("duration_ms")?}));
    }
    if media.len() != 3 {
        return Err(Error::NotFound);
    }
    Ok(Value::Object(media))
}

pub(crate) fn metadata(row: &PgRow) -> Result<Metadata, Error> {
    Ok(Metadata {
        name: row.try_get("name")?,
        display_name: row.try_get("display_name")?,
        tags: serde_json::from_value(row.try_get("tags")?).map_err(|_| Error::Invalid)?,
        subject_member_id: row.try_get("subject_member_id")?,
    })
}
pub(crate) async fn draft_json(conn: &mut PgConnection, row: &PgRow) -> Result<Value, Error> {
    let ws: Uuid = row.try_get("workspace_id")?;
    let id: Uuid = row.try_get("id")?;
    let state: String = row.try_get("state")?;
    let mut v = serde_json::to_value(metadata(row)?).map_err(|_| Error::Invalid)?;
    let expires: chrono::DateTime<chrono::Utc> = row.try_get("expires_at")?;
    v.as_object_mut().ok_or(Error::Invalid)?.extend(json!({"draftId":id,"workspaceId":ws,"revision":row.try_get::<i64,_>("revision")?.to_string(),
        "origin":row.try_get::<Value,_>("origin")?,"expiresAtMs":expires.timestamp_millis(),"state":state,"code":row.try_get::<Option<String>,_>("code")?,
        "media":if state=="ready" {media_json(conn,ws,id,true).await?} else {Value::Null}}).as_object().ok_or(Error::Invalid)?.clone());
    Ok(v)
}
pub(crate) async fn expression_json(conn: &mut PgConnection, row: &PgRow) -> Result<Value, Error> {
    let ws: Uuid = row.try_get("workspace_id")?;
    let id: Uuid = row.try_get("id")?;
    let status: String = row.try_get("status")?;
    let mut v = serde_json::to_value(metadata(row)?).map_err(|_| Error::Invalid)?;
    let created: chrono::DateTime<chrono::Utc> = row.try_get("created_at")?;
    v.as_object_mut().ok_or(Error::Invalid)?.extend(json!({"id":id,"workspaceId":ws,"version":row.try_get::<i64,_>("version")?.to_string(),
        "origin":row.try_get::<Value,_>("origin")?,"createdBy":row.try_get::<Uuid,_>("created_by")?,"createdAtMs":created.timestamp_millis(),"status":status,
        "media":if status=="active" {media_json(conn,ws,id,false).await?} else {Value::Null}}).as_object().ok_or(Error::Invalid)?.clone());
    Ok(v)
}
async fn draft_row(conn: &mut PgConnection, actor: Actor, id: Uuid) -> Result<PgRow, Error> {
    let row=sqlx::query("SELECT * FROM expression_draft WHERE workspace_id=$1 AND id=$2 AND creator=$3 AND approval_id IS NULL FOR UPDATE")
        .bind(actor.workspace).bind(id).bind(actor.member).fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
    Ok(row)
}
pub(crate) fn unexpired(row: &PgRow) -> Result<(), Error> {
    let expired: chrono::DateTime<chrono::Utc> = row.try_get("expires_at")?;
    if expired <= chrono::Utc::now() {
        Err(Error::Expired)
    } else {
        Ok(())
    }
}

pub async fn create_draft(
    pool: &PgPool,
    actor: Actor,
    meta: Metadata,
    origin: Origin,
    media: Option<Processed>,
    code: Option<&str>,
) -> Result<Value, Error> {
    meta.validate()?;
    // This direct API never accepts caller-supplied prompts or cards; a link's origin
    // is accepted only in its storable form (no query, credentials or fragment).
    if !crate::draft_origin_ok(&origin, media.is_some(), code) {
        return Err(Error::Invalid);
    }
    let code = code.map(str::to_owned);
    transaction(pool,actor,move|conn|Box::pin(async move {
        let (_,policy)=catalog(conn,actor.workspace).await?;
        can_add(conn,actor,&policy,meta.subject_member_id).await?;
        sweep_in_tx(conn,actor.workspace).await?;
        if live_drafts(conn,actor).await?>=LIVE_DRAFTS {return Err(Error::Quota);}
        let row=sqlx::query("INSERT INTO expression_draft(workspace_id,name,display_name,tags,subject_member_id,origin,creator,state,code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *")
            .bind(actor.workspace).bind(&meta.name).bind(&meta.display_name).bind(json!(meta.tags)).bind(meta.subject_member_id).bind(json!(origin)).bind(actor.member)
            .bind(if media.is_some(){"ready"}else{"manual_upload_required"}).bind(code.clone()).fetch_one(&mut *conn).await?;
        let id:Uuid=row.try_get("id")?;
        let sha=media.as_ref().map(|m|m.large.info.sha256.clone());
        if let Some(media)=media {put_images(conn,actor.workspace,id,Some(1),&media).await?;}
        // The reason code of a failed receive is recorded here as well: the TTL sweep
        // clears the draft's own `code` (ADR-0218 D6, `staged` carries the reason).
        crate::action::audit_staged(conn,actor.workspace,actor.member,id,&origin,code.as_deref(),sha.as_deref(),None,json!({})).await?;
        draft_json(conn,&row).await
    })).await
}

pub async fn get_draft(pool: &PgPool, actor: Actor, id: Uuid) -> Result<Value, Error> {
    transaction(pool, actor, move |conn| {
        Box::pin(async move {
            // A candidate of an open approval (ADR-0186 v8) is read through its own
            // authorization: the proposing agent, or whoever may decide the card now.
            let row = match draft_row(conn, actor, id).await {
                Ok(row) => row,
                Err(Error::NotFound) => {
                    return crate::action::candidate_get_in_tx(conn, actor, id).await
                }
                Err(error) => return Err(error),
            };
            if row.try_get::<String, _>("state")? == "activated" {
                return Err(Error::NotFound);
            }
            unexpired(&row)?;
            draft_json(conn, &row).await
        })
    })
    .await
}

pub async fn replace_draft(
    pool: &PgPool,
    actor: Actor,
    id: Uuid,
    media: Processed,
) -> Result<Value, Error> {
    transaction(pool,actor,move|conn|Box::pin(async move {
        let (_,policy)=catalog(conn,actor.workspace).await?;
        let row=draft_row(conn,actor,id).await?;
        if row.try_get::<String,_>("state")?=="activated" {return Err(Error::NotFound);}
        unexpired(&row)?;
        can_add(conn,actor,&policy,row.try_get("subject_member_id")?).await?;
        sqlx::query("DELETE FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2").bind(actor.workspace).bind(id).execute(&mut *conn).await?;
        let row=sqlx::query("UPDATE expression_draft SET revision=revision+1,state='ready',code=NULL WHERE workspace_id=$1 AND id=$2 RETURNING *")
            .bind(actor.workspace).bind(id).fetch_one(&mut *conn).await?;
        put_images(conn,actor.workspace,id,Some(row.try_get("revision")?),&media).await?;
        draft_json(conn,&row).await
    })).await
}

pub(crate) async fn changed(
    conn: &mut PgConnection,
    actor: Actor,
    id: Uuid,
    action: &str,
    extra: Option<Value>,
) -> Result<i64, Error> {
    let v: i64 = sqlx::query_scalar(
        "UPDATE expression_catalog SET version=version+1 WHERE workspace_id=$1 RETURNING version",
    )
    .bind(actor.workspace)
    .fetch_one(&mut *conn)
    .await?;
    write_audit(
        conn,
        &AuditEntry::new(actor.workspace, action)
            .by(actor.member)
            .target("expression", id)
            .with_schema("momo.expression.changed.v1", {
                // Ids, a closed origin summary, a hash prefix, the approval: never bytes,
                // a prompt or an original link (ADR-0218 D6).
                let mut detail = json!({"version":v.to_string()});
                if let (Some(Value::Object(more)), Some(object)) = (extra, detail.as_object_mut()) {
                    object.extend(more);
                }
                detail
            }),
    )
    .await?;
    let payload = BroadcastPayload {
        channel: format!(
            "expressions:ws{}",
            actor.workspace.to_string().to_uppercase()
        ),
        data: json!({"type":"expression.changed","workspaceId":actor.workspace,"version":v.to_string()}),
        version: None,
        idempotency_key: Some(format!("expression:{}:{v}", actor.workspace)),
    };
    emit_outbox(
        &mut *conn,
        actor.workspace,
        OutboxKind::Broadcast,
        "publish",
        &json!(payload),
        Some(actor.workspace),
    )
    .await?;
    Ok(v)
}

pub async fn activate(pool: &PgPool, actor: Actor, choice: Choice) -> Result<Value, Error> {
    let revision = version(&choice.revision)?;
    if !hash(&choice.sha256) {
        return Err(Error::Invalid);
    }
    transaction(pool,actor,move|conn|Box::pin(async move {
        let (_,policy)=catalog(conn,actor.workspace).await?;
        let row=draft_row(conn,actor,choice.draft_id).await?;
        let meta=metadata(&row)?;
        can_add(conn,actor,&policy,meta.subject_member_id).await?;
        if row.try_get::<String,_>("state")?=="activated" {
            if row.try_get::<Option<Uuid>,_>("submitted_by")?==Some(actor.member)
                && row.try_get::<Option<i64>,_>("submitted_revision")?==Some(revision)
                && row.try_get::<Option<String>,_>("submitted_sha256")?.as_deref()==Some(&choice.sha256) {
                return Ok(row.try_get("receipt")?);
            } return Err(Error::Stale);
        }
        unexpired(&row)?;
        if row.try_get::<String,_>("state")?!="ready" || row.try_get::<i64,_>("revision")?!=revision {return Err(Error::Stale);}
        let media=media_json(conn,actor.workspace,choice.draft_id,true).await?;
        if media["large"]["sha256"].as_str()!=Some(&choice.sha256) {return Err(Error::Stale);}
        meta.validate()?;
        let reserved:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM expression WHERE workspace_id=$1 AND name=$2)").bind(actor.workspace).bind(&meta.name).fetch_one(&mut *conn).await?;
        if reserved {return Err(Error::NameReserved);}
        let n:i64=sqlx::query_scalar("SELECT count(*) FROM expression WHERE workspace_id=$1 AND status <> 'deleted'").bind(actor.workspace).fetch_one(&mut *conn).await?;
        if n>=QUOTA {return Err(Error::Quota);}
        let id=choice.draft_id;
        let v=changed(conn,actor,id,"expression.created",None).await?;
        let e=sqlx::query("INSERT INTO expression(workspace_id,id,name,display_name,tags,subject_member_id,origin,created_by,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *")
            .bind(actor.workspace).bind(id).bind(meta.name).bind(meta.display_name).bind(json!(meta.tags)).bind(meta.subject_member_id).bind(row.try_get::<Value,_>("origin")?).bind(actor.member).bind(v).fetch_one(&mut *conn).await?;
        sqlx::query("INSERT INTO expression_image(workspace_id,expression_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) SELECT workspace_id,draft_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2")
            .bind(actor.workspace).bind(id).execute(&mut *conn).await?;
        let receipt=json!({"workspaceId":actor.workspace,"version":v.to_string(),"expression":expression_json(conn,&e).await?});
        sqlx::query("DELETE FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2").bind(actor.workspace).bind(id).execute(&mut *conn).await?;
        sqlx::query("UPDATE expression_draft SET state='activated',submitted_by=$3,submitted_revision=$4,submitted_sha256=$5,receipt=$6 WHERE workspace_id=$1 AND id=$2")
            .bind(actor.workspace).bind(id).bind(actor.member).bind(revision).bind(choice.sha256).bind(&receipt).execute(&mut *conn).await?;
        Ok(receipt)
    })).await
}

pub async fn list(pool: &PgPool, actor: Actor, since: Option<String>) -> Result<Value, Error> {
    let since = since.map(|s| version(&s)).transpose()?;
    transaction(pool,actor,move|conn|Box::pin(async move {
        // Every writer holds this same lock: catalog/items/media share a snapshot
        // even under READ COMMITTED and racing hide/delete/policy operations.
        let (v,policy)=catalog(conn,actor.workspace).await?;
        let mut reset=since.is_none() || since.is_some_and(|s|s>v);
        let mut rows=sqlx::query("SELECT * FROM expression WHERE workspace_id=$1 AND version>$2 ORDER BY version,id LIMIT 1001")
            .bind(actor.workspace).bind(since.unwrap_or(-1)).fetch_all(&mut *conn).await?;
        if rows.len()>1000 {reset=true;}
        if reset {rows=sqlx::query("SELECT * FROM expression WHERE workspace_id=$1 AND status='active' ORDER BY name,id LIMIT 1000").bind(actor.workspace).fetch_all(&mut *conn).await?;}
        let mut items=Vec::with_capacity(rows.len());
        for row in rows {items.push(expression_json(conn,&row).await?);}
        Ok(json!({"workspaceId":actor.workspace,"version":v.to_string(),"baseVersion":if reset {None}else{since.map(|s|s.to_string())},"reset":reset,"addPolicy":policy,"items":items}))
    })).await
}

pub async fn mutate(
    pool: &PgPool,
    actor: Actor,
    id: Uuid,
    patch: Option<Patch>,
    report: Option<Report>,
) -> Result<Value, Error> {
    if let Some(p) = &patch {
        p.validate()?;
    }
    if let Some(r) = &report {
        r.validate()?;
    }
    transaction(pool,actor,move|conn|Box::pin(async move {
        let (old_v,_)=catalog(conn,actor.workspace).await?;
        let member=authorize(conn,actor).await?;
        if !member.human {return Err(Error::Role);}
        let row=sqlx::query("SELECT * FROM expression WHERE workspace_id=$1 AND id=$2 FOR UPDATE").bind(actor.workspace).bind(id).fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
        if report.is_none() && row.try_get::<Uuid,_>("created_by")?!=actor.member && !member.admin() {return Err(Error::Role);}
        let status:String=row.try_get("status")?;
        if patch.is_some() && status!="active" {return Err(Error::NotFound);}
        if let Some(r)=&report {
            // No RETURNING or ON CONFLICT: PG applies SELECT RLS to an upsert,
            // which would prevent ordinary members from reporting. A savepoint
            // absorbs only the dedup unique violation, without reading reports.
            sqlx::query("SAVEPOINT expression_report_insert").execute(&mut *conn).await?;
            let inserted=sqlx::query("INSERT INTO expression_report(workspace_id,expression_id,reporter_id,reason,detail) VALUES($1,$2,$3,$4,$5)")
                .bind(actor.workspace).bind(id).bind(actor.member).bind(&r.reason).bind(&r.detail).execute(&mut *conn).await;
            if let Err(error)=inserted {
                if error.as_database_error().is_some_and(|e|e.is_unique_violation()) {
                    sqlx::query("ROLLBACK TO SAVEPOINT expression_report_insert").execute(&mut *conn).await?;
                } else {return Err(error.into());}
            }
            sqlx::query("RELEASE SAVEPOINT expression_report_insert").execute(&mut *conn).await?;
        }
        let changes=patch.is_some() || (report.is_some() && status=="active") || (report.is_none() && patch.is_none() && status!="deleted");
        let (row,v)=if changes {
            let v=changed(conn,actor,id,if report.is_some(){"expression.hidden"}else if patch.is_some(){"expression.edited"}else{"expression.deleted"},None).await?;
            let next=if patch.is_some(){"active"}else if report.is_some(){"hidden"}else{"deleted"};
            let meta=metadata(&row)?;
            let display=patch.as_ref().and_then(|p|p.display_name.clone()).unwrap_or(meta.display_name);
            let tags=patch.and_then(|p|p.tags).unwrap_or(meta.tags);
            let row=sqlx::query("UPDATE expression SET display_name=$3,tags=$4,status=$5,version=$6,hidden_at=CASE WHEN $5='hidden' THEN clock_timestamp() ELSE hidden_at END,deleted_at=CASE WHEN $5='deleted' THEN clock_timestamp() ELSE deleted_at END WHERE workspace_id=$1 AND id=$2 RETURNING *")
                .bind(actor.workspace).bind(id).bind(display).bind(json!(tags)).bind(next).bind(v).fetch_one(&mut *conn).await?;
            if next=="deleted" {sqlx::query("DELETE FROM expression_image WHERE workspace_id=$1 AND expression_id=$2").bind(actor.workspace).bind(id).execute(&mut *conn).await?;}
            (row,v)
        }else{(row,old_v)};
        Ok(json!({"workspaceId":actor.workspace,"version":v.to_string(),"expression":expression_json(conn,&row).await?}))
    })).await
}

pub async fn image(
    pool: &PgPool,
    actor: Actor,
    id: Uuid,
    variant: String,
    sha: String,
    draft: bool,
) -> Result<Rendition, Error> {
    if !["small", "large", "thumb"].contains(&variant.as_str()) || !hash(&sha) {
        return Err(Error::NotFound);
    }
    transaction(pool,actor,move|conn|Box::pin(async move {
        if draft {
            let row=match draft_row(conn,actor,id).await {
                Ok(row)=>row,
                // A candidate of an open approval: its own authorization, same pinned bytes.
                Err(Error::NotFound)=>return crate::action::candidate_image_in_tx(conn,actor,id,&variant,&sha).await,
                Err(error)=>return Err(error),
            };
            if row.try_get::<String,_>("state")?!="ready" || unexpired(&row).is_err() {return Err(Error::NotFound);}
        }else{
            sqlx::query("SELECT id FROM expression WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE").bind(actor.workspace).bind(id).fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
        }
        let sql=if draft {"SELECT * FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2 AND variant=$3 AND sha256=$4"}
            else {"SELECT * FROM expression_image WHERE workspace_id=$1 AND expression_id=$2 AND variant=$3 AND sha256=$4"};
        let row=sqlx::query(sql).bind(actor.workspace).bind(id).bind(variant).bind(sha).fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
        let data:Vec<u8>=row.try_get("bytes")?;
        Ok(Rendition {info:crate::ImageInfo{mime:row.try_get("mime")?,sha256:row.try_get("sha256")?,bytes:data.len(),width:row.try_get::<i32,_>("width")? as u32,height:row.try_get::<i32,_>("height")? as u32,
            frame_count:row.try_get::<i32,_>("frame_count")? as u32,duration_ms:row.try_get::<i32,_>("duration_ms")? as u32},data})
    })).await
}

/// Operator-only setting entry point; no public policy API in v1.
pub async fn set_policy(pool: &PgPool, actor: Actor, policy: String) -> Result<(), Error> {
    if !["members", "admins"].contains(&policy.as_str()) {
        return Err(Error::Invalid);
    }
    transaction(pool, actor, move |conn| {
        Box::pin(async move {
            let (_, old) = catalog(conn, actor.workspace).await?;
            if !authorize(conn, actor).await?.admin() {
                return Err(Error::Role);
            }
            if old != policy {
                sqlx::query("UPDATE expression_catalog SET add_policy=$2 WHERE workspace_id=$1")
                    .bind(actor.workspace)
                    .bind(policy)
                    .execute(&mut *conn)
                    .await?;
                changed(
                    conn,
                    actor,
                    actor.workspace,
                    "expression.policy_changed",
                    None,
                )
                .await?;
            }
            Ok(())
        })
    })
    .await
}

pub async fn attachment_source(
    pool: &PgPool,
    actor: Actor,
    channel: Uuid,
    attachment: Uuid,
) -> Result<String, Error> {
    transaction(pool,actor,move|conn|Box::pin(async move {
        let row=sqlx::query("SELECT a.drive_file_id FROM attachment a JOIN channel c ON (c.workspace_id,c.id)=(a.workspace_id,a.channel_id) JOIN message m ON (m.workspace_id,m.id)=(a.workspace_id,a.message_id) JOIN membership cm ON cm.channel_id=a.channel_id AND cm.member_id=$4 AND cm.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND a.id=$2 AND a.channel_id=$3 AND a.uploader_member_id=$4 AND a.status='complete' AND a.drive_file_id IS NOT NULL AND a.size_bytes BETWEEN 1 AND $5 AND m.author_member_id=$4 AND m.state<>'deleted' AND m.deleted_at IS NULL AND c.archived_at IS NULL AND cm.left_at IS NULL")
            .bind(actor.workspace).bind(attachment).bind(channel).bind(actor.member).bind(crate::INPUT_BYTES as i64).fetch_optional(&mut *conn).await?.ok_or(Error::NotFound)?;
        Ok(row.try_get("drive_file_id")?)
    })).await
}
