//! #3168 — Korean keyword search over `mem_item`, measured (ADR-0196 D13 §8.4; the M0 spike #3159
//! asked for a workspace-scoped latency remeasurement).
//!
//! Loads the spike's fixtures (`server-rust/bench/kr-keyword-search/fixtures`: 900 synthetic
//! team-chat lines, 50 query pairs with ground truth) as *real* `mem_item` rows, each resting on
//! its own message, in one workspace; then optionally piles noise items on top — in the same
//! workspace (spread over 30 channels the viewer is a member of, so the read policy has real work)
//! and in other workspaces — and runs every query through `mem_search_items` as `momo_app` with
//! `app.member_id` set, i.e. through RLS, exactly as the API will.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//! MEM_SEARCH_SCALES=0,4000,20000 MEM_SEARCH_OTHER_WORKSPACE=100000 \
//!   cargo test -p momo-server --test mem_item_search_eval_pg -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! `recall@10` is the spike's definition: relevant hits in the top 10 / min(10, |relevant|),
//! averaged over the queries. The ADR bar is 0.8. Latency is wall-clock per query on this
//! machine (no network), p50 / p95 over 50 queries × 3 repeats — a relative number, not an SLO.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use serde_json::Value;
use uuid::Uuid;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None).expect("migrations");
    let psql = [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ]
    .iter()
    .find(|p| PathBuf::from(p).is_file())
    .map_or_else(|| "psql".to_string(), |p| p.to_string());
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../infra/rust/sql/bootstrap_roles.sql");
    let status = Command::new(psql)
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
            "-f",
        ])
        .arg(path)
        .env("MOMO_APP_POSTGRES_PASSWORD", "momo_app_dev_pw")
        .env("RELAY_POSTGRES_PASSWORD", "momo_relay_dev_pw")
        .env("WORKER_POSTGRES_PASSWORD", "momo_worker_dev_pw")
        .env("NOTIFIER_POSTGRES_PASSWORD", "momo_notifier_dev_pw")
        .status()
        .expect("psql");
    assert!(status.success(), "bootstrap_roles.sql");
    *ready = true;
}

async fn pool(user: Option<&str>) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("url");
    let mut builder = PgPoolOptions::new().max_connections(4);
    if let Some(user) = user {
        let pw = std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into());
        builder = builder.acquire_timeout(std::time::Duration::from_secs(30));
        return builder
            .connect_with(options.username(user).password(&pw))
            .await
            .expect("connect as momo_app");
    }
    builder.connect(&database_url()).await.expect("superuser")
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bench/kr-keyword-search/fixtures")
}

struct Doc {
    id: String,
    text: String,
    concept: Option<String>,
}

fn load_docs() -> Vec<Doc> {
    let raw = std::fs::read_to_string(fixtures().join("corpus.jsonl")).expect("corpus.jsonl");
    raw.lines()
        .map(|l| {
            let v: Value = serde_json::from_str(l).expect("json line");
            Doc {
                id: v["id"].as_str().expect("id").to_string(),
                text: v["text"].as_str().expect("text").to_string(),
                concept: v["concept"].as_str().map(str::to_string),
            }
        })
        .collect()
}

struct Query {
    id: String,
    text: String,
    kind: String,
    relevant: Vec<String>,
}

fn load_queries() -> Vec<Query> {
    let raw = std::fs::read_to_string(fixtures().join("queries.json")).expect("queries.json");
    let v: Value = serde_json::from_str(&raw).expect("queries json");
    v.as_array()
        .expect("array")
        .iter()
        .map(|q| Query {
            id: q["id"].as_str().unwrap().to_string(),
            text: q["text"].as_str().unwrap().to_string(),
            kind: q["kind"].as_str().unwrap().to_string(),
            relevant: q["relevant"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| d.as_str().unwrap().to_string())
                .collect(),
        })
        .collect()
}

struct Tenant {
    ws: Uuid,
    viewer: Uuid,
    channels: Vec<Uuid>,
}

async fn tenant(su: &PgPool, channels: usize) -> Tenant {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(format!("eval-{ws}"))
        .execute(su)
        .await
        .expect("workspace");
    let viewer = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) VALUES ($1, $2, 'human', 'v', $3)",
    )
    .bind(viewer)
    .bind(ws)
    .bind(format!("v-{}", &viewer.simple().to_string()[..10]))
    .execute(su)
    .await
    .expect("member");
    let mut ids = Vec::new();
    for i in 0..channels {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) VALUES ($1, $2, 'public', $3, '', $4)",
        )
        .bind(id)
        .bind(ws)
        .bind(format!("c{i}-{}", &id.simple().to_string()[..8]))
        .bind(viewer)
        .execute(su)
        .await
        .expect("channel");
        sqlx::query(
            "INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)",
        )
        .bind(id)
        .bind(ws)
        .execute(su)
        .await
        .expect("seq");
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(ws)
        .bind(id)
        .bind(viewer)
        .execute(su)
        .await
        .expect("membership");
        ids.push(id);
    }
    Tenant {
        ws,
        viewer,
        channels: ids,
    }
}

/// Bulk-insert `bodies` as messages + items + evidence, round-robin over the tenant's channels.
/// Returns the item ids in the order of `bodies`.
async fn load_items(su: &PgPool, t: &Tenant, bodies: &[String]) -> Vec<Uuid> {
    let mut out = Vec::new();
    for chunk in bodies.chunks(5000) {
        let item_ids: Vec<Uuid> = chunk.iter().map(|_| Uuid::new_v4()).collect();
        let channel_idx: Vec<i32> = (0..chunk.len())
            .map(|i| (i % t.channels.len()) as i32)
            .collect();
        // seq base per channel
        let sql = r#"
            WITH docs AS MATERIALIZED (
              SELECT d.iid, d.body, d.ci, gen_random_uuid() AS mid,
                     ($4::uuid[])[d.ci + 1] AS ch
                FROM unnest($1::uuid[], $2::text[], $3::int[]) AS d(iid, body, ci)
            ), numbered AS MATERIALIZED (
              SELECT docs.*, (SELECT last_seq FROM channel_seq WHERE channel_id = docs.ch)
                     + row_number() OVER (PARTITION BY docs.ch ORDER BY docs.iid) AS seq
                FROM docs
            ), msg AS (
              INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body)
              SELECT mid, $5, ch, seq, 0, 0, $6, 'text', body FROM numbered RETURNING id
            ), itm AS (
              INSERT INTO mem_item (id, workspace_id, space_kind, channel_id, kind, body, valid_from,
                                    content_hash, extractor_version, source_count)
              SELECT iid, $5, 'channel', ch, 'fact', body, now(), md5(iid::text), 'eval', 1 FROM numbered RETURNING id
            ), ev AS (
              INSERT INTO mem_evidence (workspace_id, item_id, message_id, channel_id)
              SELECT $5, iid, mid, ch FROM numbered RETURNING id
            ), bump AS (
              UPDATE channel_seq c SET last_seq = c.last_seq + n.cnt
                FROM (SELECT ch, count(*) AS cnt FROM numbered GROUP BY ch) n WHERE c.channel_id = n.ch RETURNING 1
            )
            SELECT (SELECT count(*) FROM msg) + (SELECT count(*) FROM itm) + (SELECT count(*) FROM ev) + (SELECT count(*) FROM bump)
        "#;
        sqlx::query_scalar::<_, i64>(sql)
            .bind(&item_ids)
            .bind(chunk)
            .bind(&channel_idx)
            .bind(&t.channels)
            .bind(t.ws)
            .bind(t.viewer)
            .fetch_one(su)
            .await
            .expect("bulk insert");
        out.extend(item_ids);
    }
    out
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

async fn run_queries(
    app: &PgPool,
    t: &Tenant,
    queries: &[Query],
    body_to_docs: &HashMap<String, Vec<String>>,
    repeats: usize,
) -> (f64, HashMap<String, (f64, usize)>, Vec<f64>) {
    let mut lat = Vec::new();
    let mut per_kind: HashMap<String, (f64, usize)> = HashMap::new();
    let mut total = 0.0;
    for q in queries {
        let mut hits = Vec::new();
        for r in 0..repeats {
            let mut tx = app.begin().await.expect("begin");
            sqlx::query("SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)")
                .bind(t.ws.to_string())
                .bind(t.viewer.to_string())
                .execute(&mut *tx)
                .await
                .expect("gucs");
            let started = Instant::now();
            let bodies: Vec<String> =
                sqlx::query_scalar("SELECT body FROM mem_search_items($1, 10, NULL)")
                    .bind(&q.text)
                    .fetch_all(&mut *tx)
                    .await
                    .expect("search");
            lat.push(started.elapsed().as_secs_f64() * 1000.0);
            tx.rollback().await.expect("rollback");
            if r == 0 {
                hits = bodies;
            }
        }
        let found: Vec<&String> = hits
            .iter()
            .flat_map(|b| body_to_docs.get(b).into_iter().flatten())
            .collect();
        let got = q.relevant.iter().filter(|d| found.contains(d)).count();
        let recall = got as f64 / q.relevant.len().min(10) as f64;
        total += recall;
        if recall < 0.5 && repeats > 1 {
            eprintln!(
                "  low recall {:.2} for {} [{}] {:?}",
                recall, q.id, q.kind, q.text
            );
        }
        let e = per_kind.entry(q.kind.clone()).or_insert((0.0, 0));
        e.0 += recall;
        e.1 += 1;
    }
    lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (total / queries.len() as f64, per_kind, lat)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 superuser DB"]
async fn korean_recall_and_workspace_scoped_latency() {
    ensure_schema_and_roles();
    let su = pool(None).await;
    let app = pool(Some("momo_app")).await;
    let docs = load_docs();
    let queries = load_queries();
    assert_eq!((docs.len(), queries.len()), (900, 50));

    // The fixture as real items, in a tenant with 30 channels.
    let t = tenant(&su, 30).await;
    let bodies: Vec<String> = docs.iter().map(|d| d.text.clone()).collect();
    load_items(&su, &t, &bodies).await;
    let mut body_to_docs: HashMap<String, Vec<String>> = HashMap::new();
    for d in &docs {
        body_to_docs
            .entry(d.text.clone())
            .or_default()
            .push(d.id.clone());
    }
    su_analyze(&su).await;

    // 1. recall with only the fixture in the workspace.
    let (recall, per_kind, lat) = run_queries(&app, &t, &queries, &body_to_docs, 3).await;
    eprintln!("\n=== Korean keyword search over mem_item (900 fixture items, RLS as momo_app) ===");
    eprintln!("recall@10 = {recall:.3}   (ADR-0196 D13 bar: 0.8; spike trgm-alone small/scale: 0.890/0.835)");
    let mut kinds: Vec<_> = per_kind.iter().collect();
    kinds.sort_by_key(|(k, _)| k.to_string());
    for (k, (sum, n)) in kinds {
        eprintln!("  {k:<14} {:.2}", sum / *n as f64);
    }
    eprintln!(
        "latency @ 900 items in the workspace: p50 {:.1} ms  p95 {:.1} ms  max {:.1} ms",
        percentile(&lat, 0.5),
        percentile(&lat, 0.95),
        lat.last().unwrap()
    );
    assert!(recall >= 0.8, "recall@10 {recall:.3} is under the ADR bar");

    // 2. latency as the workspace grows (noise built from the spike's concept-free lines).
    let noise_src: Vec<&Doc> = docs.iter().filter(|d| d.concept.is_none()).collect();
    let scales: Vec<usize> = std::env::var("MEM_SEARCH_SCALES")
        .unwrap_or_else(|_| "0,4000".into())
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let other: usize = std::env::var("MEM_SEARCH_OTHER_WORKSPACE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut have = 0usize;
    for scale in scales {
        if scale > have {
            let extra: Vec<String> = (have..scale)
                .map(|i| format!("{} {}", noise_src[i % noise_src.len()].text, i))
                .collect();
            load_items(&su, &t, &extra).await;
            have = scale;
            su_analyze(&su).await;
        }
        let (recall, _, lat) = run_queries(&app, &t, &queries, &body_to_docs, 3).await;
        eprintln!(
            "workspace = 900 + {have:>6} noise items: recall@10 {recall:.3}  latency p50 {:>7.1} ms  p95 {:>7.1} ms  max {:>7.1} ms",
            percentile(&lat, 0.5),
            percentile(&lat, 0.95),
            lat.last().unwrap()
        );
    }
    if other > 0 {
        let o = tenant(&su, 30).await;
        let extra: Vec<String> = (0..other)
            .map(|i| format!("{} {}", noise_src[i % noise_src.len()].text, i))
            .collect();
        load_items(&su, &o, &extra).await;
        su_analyze(&su).await;
        let (recall, _, lat) = run_queries(&app, &t, &queries, &body_to_docs, 3).await;
        eprintln!(
            "+ {other} items in OTHER workspaces: recall@10 {recall:.3}  latency p50 {:>7.1} ms  p95 {:>7.1} ms  (the tenant predicate keeps them out of the scan)",
            percentile(&lat, 0.5),
            percentile(&lat, 0.95)
        );
    }

    // 3. the GIN(trgm) index the spike recommended: does the RLS path use it?
    let idx = "CREATE INDEX IF NOT EXISTS mem_item_body_trgm_eval ON mem_item USING gin (body gin_trgm_ops)";
    sqlx::query(idx).execute(&su).await.expect("index");
    su_analyze(&su).await;
    let (_, _, lat_gin) = run_queries(&app, &t, &queries, &body_to_docs, 3).await;
    let mut tx = app.begin().await.expect("begin");
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(t.ws.to_string())
    .bind(t.viewer.to_string())
    .execute(&mut *tx)
    .await
    .expect("gucs");
    // A rare token (a noise line's running number), so the planner has every reason to want the GIN index.
    let plan_rls: Vec<String> = sqlx::query_scalar(
        "EXPLAIN (COSTS OFF) SELECT id FROM mem_item WHERE '4321' <% body LIMIT 10",
    )
    .fetch_all(&mut *tx)
    .await
    .expect("plan");
    tx.rollback().await.expect("rollback");
    let plan_su: Vec<String> = sqlx::query_scalar(
        "EXPLAIN (COSTS OFF) SELECT id FROM mem_item WHERE '4321' <% body LIMIT 10",
    )
    .fetch_all(&su)
    .await
    .expect("plan");
    eprintln!(
        "with the GIN index: p50 {:.1} ms p95 {:.1} ms",
        percentile(&lat_gin, 0.5),
        percentile(&lat_gin, 0.95)
    );
    eprintln!("plan as momo_app (RLS):\n  {}", plan_rls.join("\n  "));
    eprintln!("plan as superuser (no RLS):\n  {}", plan_su.join("\n  "));
    let used_rls = plan_rls
        .iter()
        .any(|l| l.contains("mem_item_body_trgm_eval"));
    let used_su = plan_su
        .iter()
        .any(|l| l.contains("mem_item_body_trgm_eval"));
    eprintln!("GIN used under RLS: {used_rls}; without RLS: {used_su}");
    sqlx::query("DROP INDEX mem_item_body_trgm_eval")
        .execute(&su)
        .await
        .expect("drop");
}

async fn su_analyze(su: &PgPool) {
    for table in ["mem_item", "mem_evidence", "message", "membership"] {
        sqlx::query(&format!("ANALYZE {table}"))
            .execute(su)
            .await
            .expect("analyze");
    }
}
