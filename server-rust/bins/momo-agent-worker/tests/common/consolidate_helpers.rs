// Shared by the #3172 suites via `include!` (needs chrono, momo_agent::memory_cons as cons, serde_json::json in scope).

// --- helpers -------------------------------------------------------------------------

fn ago(days: i64) -> DateTime<Utc> {
    Utc::now() - ChronoDuration::days(days)
}

fn in_days(days: i64) -> DateTime<Utc> {
    Utc::now() + ChronoDuration::days(days)
}

fn cons_config() -> WorkerConfig {
    let mut config = memory_config();
    // "The slot opened at midnight": every channel is due whenever the test asks for it.
    config.memory.consolidate_hour = 0;
    config.memory.consolidate_minute = 0;
    // Topics have their own suite; the A-stage tests count model calls and rows exactly.
    config.memory.topics_enabled = false;
    config
}

struct Spec<'a> {
    kind: &'a str,
    origin: &'a str,
    body: &'a str,
    valid_from: DateTime<Utc>,
    evidence: Vec<Uuid>,
    forget_after: Option<DateTime<Utc>>,
    subject: Option<&'a str>,
}

fn spec<'a>(
    kind: &'a str,
    origin: &'a str,
    body: &'a str,
    valid_from: DateTime<Utc>,
    evidence: &[Uuid],
) -> Spec<'a> {
    Spec {
        kind,
        origin,
        body,
        valid_from,
        evidence: evidence.to_vec(),
        forget_after: None,
        subject: None,
    }
}

/// An item written the way the database would have it (superuser, so a test can set up states the
/// write path never produces: an old `forget_after`, a chosen `origin`). Evidence is inserted with the
/// row, all of it in `channel`.
async fn put_item(su: &PgPool, ws: Uuid, channel: Uuid, s: Spec<'_>) -> Uuid {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO mem_item \
           (workspace_id, space_kind, channel_id, kind, origin, body, subject_key, valid_from, \
            content_hash, extractor_version, source_count, forget_after) \
         VALUES ($1, 'channel', $2, $3, $4, $5, $6, $7, \
                 encode(sha256(convert_to($3 || ':' || lower(regexp_replace(btrim($5), '[[:space:]]+', ' ', 'g')), 'UTF8')), 'hex'), \
                 'test', $8, $9) RETURNING id",
    )
    .bind(ws)
    .bind(channel)
    .bind(s.kind)
    .bind(s.origin)
    .bind(s.body)
    .bind(s.subject)
    .bind(s.valid_from)
    .bind(s.evidence.len() as i32)
    .bind(s.forget_after)
    .fetch_one(su)
    .await
    .expect("insert item");
    for message in &s.evidence {
        sqlx::query(
            "INSERT INTO mem_evidence (workspace_id, item_id, message_id, channel_id) VALUES ($1, $2, $3, $4)",
        )
        .bind(ws)
        .bind(id)
        .bind(message)
        .bind(channel)
        .execute(su)
        .await
        .expect("insert evidence");
    }
    id
}

struct ItemRow {
    retired_reason: Option<String>,
    retired: bool,
    merged_into: Option<Uuid>,
    valid_to: Option<DateTime<Utc>>,
    closed_by: Option<Uuid>,
    supersedes: Option<Uuid>,
    source_count: i32,
    reinforce_count: i32,
    forget_after: Option<DateTime<Utc>>,
    stale: bool,
}

async fn item(su: &PgPool, id: Uuid) -> Option<ItemRow> {
    sqlx::query(
        "SELECT retired_reason, retired_at IS NOT NULL AS retired, merged_into_id, valid_to, closed_by_id, \
                supersedes_id, source_count, reinforce_count, forget_after, stale \
           FROM mem_item WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(su)
    .await
    .expect("item row")
    .map(|row| ItemRow {
        retired_reason: row.get("retired_reason"),
        retired: row.get("retired"),
        merged_into: row.get("merged_into_id"),
        valid_to: row.get("valid_to"),
        closed_by: row.get("closed_by_id"),
        supersedes: row.get("supersedes_id"),
        source_count: row.get("source_count"),
        reinforce_count: row.get("reinforce_count"),
        forget_after: row.get("forget_after"),
        stale: row.get("stale"),
    })
}

async fn evidence_ids(su: &PgPool, item_id: Uuid) -> Vec<Uuid> {
    sorted(
        sqlx::query_scalar("SELECT message_id FROM mem_evidence WHERE item_id = $1")
            .bind(item_id)
            .fetch_all(su)
            .await
            .expect("evidence"),
    )
}

async fn events(su: &PgPool, target: Uuid, action: &str) -> Vec<(Uuid, serde_json::Value)> {
    sqlx::query("SELECT id, detail FROM mem_event WHERE target_id = $1 AND action = $2 ORDER BY created_at, id")
        .bind(target)
        .bind(action)
        .fetch_all(su)
        .await
        .expect("events")
        .iter()
        .map(|row| (row.get("id"), row.get("detail")))
        .collect()
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> &'a str {
    let start = text.find(open).map_or(0, |i| i + open.len());
    let end = text[start..].find(close).map_or(text.len(), |i| i + start);
    &text[start..end]
}

/// The mock judge: `(needle in A, needle in B, verdict)`; anything else is `distinct`.
fn judge(rules: Vec<(&'static str, &'static str, &'static str)>) -> ReplyFn {
    Arc::new(move |_n, prompt| {
        let a = between(prompt, "<기억 A>", "</기억 A>");
        let b = between(prompt, "<기억 B>", "</기억 B>");
        for (needle_a, needle_b, verdict) in &rules {
            if a.contains(needle_a) && b.contains(needle_b) {
                return (*verdict).to_string();
            }
        }
        "distinct".to_string()
    })
}

async fn sqlstate_of<T>(result: Result<T, momo_db::DbError>) -> String {
    match result {
        Ok(_) => "ok".to_string(),
        Err(error) => mem::sqlstate(&error).unwrap_or_else(|| error.to_string()),
    }
}

/// A human acts through the API role: `app.member_id` is the actor, `mem_forget_item` /
/// `mem_accept_proposal` are the PUBLIC definer functions behind the memory browser.
async fn forget_as(app: &PgPool, ws: Uuid, member: Uuid, item_id: Uuid) -> Result<i32, String> {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("SELECT set_config('app.member_id', $1, true)")
                .bind(member.to_string())
                .execute(&mut *conn)
                .await?;
            Ok(sqlx::query_scalar("SELECT mem_forget_item($1)")
                .bind(item_id)
                .fetch_one(&mut *conn)
                .await?)
        })
    })
    .await
    .map_err(|e| mem::sqlstate(&e).unwrap_or_else(|| e.to_string()))
}

async fn accept_as(app: &PgPool, ws: Uuid, member: Uuid, proposal: Uuid) -> Result<Uuid, String> {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("SELECT set_config('app.member_id', $1, true)")
                .bind(member.to_string())
                .execute(&mut *conn)
                .await?;
            Ok(sqlx::query_scalar("SELECT mem_accept_proposal($1)")
                .bind(proposal)
                .fetch_one(&mut *conn)
                .await?)
        })
    })
    .await
    .map_err(|e| mem::sqlstate(&e).unwrap_or_else(|| e.to_string()))
}

struct World {
    su: PgPool,
    wp: PgPool,
    fx: Fx,
    provider: Arc<Recorder>,
    worker: AgentWorker,
}

/// Definitions to put back if a sabotage run died before restoring them (the next test starts clean).
static PENDING_RESTORE: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Redefine `function` for real (committed) so the whole worker pipeline runs without a guard; returns
/// the original definition for [`restore`].
async fn sabotage_committed(su: &PgPool, function: &str, edits: &[(&str, &str)]) -> String {
    let original: String = sqlx::query_scalar("SELECT pg_get_functiondef($1::regprocedure)")
        .bind(function)
        .fetch_one(su)
        .await
        .expect("functiondef");
    PENDING_RESTORE.lock().unwrap().push(original.clone());
    let mut def = original.clone();
    for (from, to) in edits {
        assert!(
            def.contains(from),
            "sabotage fragment not found in {function}: {from}"
        );
        def = def.replacen(from, to, 1);
    }
    sqlx::query(&def).execute(su).await.expect("sabotage");
    original
}

async fn restore(su: &PgPool, original: String) {
    sqlx::query(&original).execute(su).await.expect("restore");
    PENDING_RESTORE.lock().unwrap().retain(|d| d != &original);
}

async fn world() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let leftovers: Vec<String> = std::mem::take(&mut *PENDING_RESTORE.lock().unwrap());
    for def in leftovers {
        sqlx::query(&def)
            .execute(&su)
            .await
            .expect("restore a dead sabotage");
    }
    reset_instance(&su).await;
    let fx = seed(&su).await;
    configure_summary_row(&su, fx.human).await;
    let wp = momo_worker_pool().await;
    let provider = Recorder::new();
    let worker = worker_with(&provider, cons_config()).await;
    World {
        su,
        wp,
        fx,
        provider,
        worker,
    }
}

impl World {
    async fn say(&self, body: &str) -> Uuid {
        post(&self.wp, &self.fx, self.fx.human, body).await.0
    }

    async fn say_in(&self, channel: Uuid, body: &str) -> Uuid {
        post_in(&self.wp, self.fx.ws, channel, self.fx.human, body)
            .await
            .0
    }

    async fn consolidate(&self) -> ConsolidateStatsAlias {
        self.worker
            .consolidate_channel_now(self.fx.ws, self.fx.channel)
            .await
    }

    async fn mem_call<T: Send + 'static>(
        &self,
        f: impl for<'c> FnOnce(
                &'c mut momo_db::PgConnection,
            )
                -> Pin<Box<dyn Future<Output = Result<T, momo_db::DbError>> + Send + 'c>>
            + Send,
    ) -> Result<T, momo_db::DbError> {
        mem::with_memory_tx(&self.wp, self.fx.ws, f).await
    }
}

type ConsolidateStatsAlias = momo_agent_worker::consolidate::ConsolidateStats;


// --- sabotage helpers -------------------------------------------------------------------

/// Redefine `function` inside `tx` with each `from` replaced by `to`.
async fn redefine(tx: &mut sqlx::PgConnection, function: &str, edits: &[(&str, &str)]) {
    let mut def: String = sqlx::query_scalar("SELECT pg_get_functiondef($1::regprocedure)")
        .bind(function)
        .fetch_one(&mut *tx)
        .await
        .expect("functiondef");
    for (from, to) in edits {
        assert!(
            def.contains(from),
            "sabotage fragment not found in {function}: {from}"
        );
        def = def.replacen(from, to, 1);
    }
    sqlx::query(&def).execute(&mut *tx).await.expect("redefine");
}

/// A rolled-back scratch: the listed functions redefined, then `momo_memory` with the tenant GUC.
async fn red_tx(
    su: &PgPool,
    ws: Uuid,
    edits: &[(&str, &[(&str, &str)])],
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = su.begin().await.expect("begin");
    for (function, list) in edits {
        redefine(&mut tx, function, list).await;
    }
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .expect("guc");
    sqlx::query("SET LOCAL ROLE momo_memory")
        .execute(&mut *tx)
        .await
        .expect("set role");
    tx
}

const APPLY: &str = "public.mem_cons_apply(uuid, uuid, text)";
const MERGE: &str = "public.mem_cons_merge_items(uuid, uuid, uuid, uuid)";
const CLOSE: &str = "public.mem_cons_close_item(uuid, uuid, uuid, uuid)";
const DECAY: &str = "public.mem_cons_decay(uuid, integer)";
const RETIRE: &str = "public.mem_cons_retire_dead(uuid, integer)";
const RETENTION: &str = "public.mem_cons_retention(uuid, integer, integer, integer)";
const PURGE: &str = "public.mem_cons_purge_proposals(uuid)";
const SUPPRESSED: &str = "public.mem_suppressed_messages(uuid, uuid[])";
const FORGET: &str = "public.mem_forget_item(uuid)";
const BEGIN_FN: &str = "public.mem_cons_begin(uuid, uuid, double precision, timestamptz)";

async fn delete_msg(app: &PgPool, ws: Uuid, author: Uuid, message: Uuid) {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            delete_message_in_tx(conn, ws, message, author)
                .await?
                .expect("delete accepted");
            Ok(())
        })
    })
    .await
    .expect("delete tx");
}

async fn edit_msg(app: &PgPool, ws: Uuid, author: Uuid, message: Uuid, body: &str) {
    let body = body.to_string();
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, message, author, &body)
                .await?
                .expect("edit accepted");
            Ok(())
        })
    })
    .await
    .expect("edit tx");
}

async fn scalar_i64(su: &PgPool, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(su)
        .await
        .expect("scalar")
}


fn extraction_answer(summary: &str, items: Vec<serde_json::Value>) -> String {
    json!({ "summary": summary, "items": items }).to_string()
}

async fn exists(su: &PgPool, table: &str, id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(&format!(
        "SELECT EXISTS (SELECT 1 FROM {table} WHERE id = $1)"
    ))
    .bind(id)
    .fetch_one(su)
    .await
    .expect("exists")
}

/// A mock that echoes the transcript into the summary (so a digest body shows what the model saw) and
/// extracts one fact when the transcript mentions `marker`, citing that line.
fn echo_reply(marker: &'static str, fact: &'static str) -> ReplyFn {
    Arc::new(move |_n, prompt| {
        let transcript = between(prompt, "<대화>\n", "\n</대화>");
        let lines: Vec<&str> = transcript.lines().collect();
        let summary = format!("- {}", lines.join(" / "));
        let mut items = Vec::new();
        if let Some(line) = lines.iter().find(|l| l.contains(marker)) {
            let seq: i64 = between(line, "[", "]").trim().parse().unwrap_or(0);
            items.push(json!({"kind": "fact", "text": fact, "evidence": [seq], "confidence": 0.9}));
        }
        extraction_answer(&summary, items)
    })
}

