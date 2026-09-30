//! #3168 — the MEM-M0 evaluation kit (#3160) against the real items path.
//!
//! `product_backend()` (the seam in `crates/momo-agent/tests/eval_kit/reference.rs`) is wired here
//! to an adapter over a real Postgres:
//!
//! * **ingest** = the corpus is sent through the message spine (`eval_kit::pg::seed`), then the real
//!   `AgentWorker::summary_sweep` runs against a mock model that answers with an oracle item set
//!   *plus deliberately bad candidates* (a secret-shaped text, an agent's and a bot's statements, an
//!   out-of-window message number). The validator and `mem_add_item` are under test; language-model
//!   quality is not (that is the R5 evaluation, D13 §8.3).
//! * **recall** = `momo_app` with `app.member_id` set: the memory browser is `SELECT` on
//!   `mem_item` / `mem_digest` through RLS, search is `mem_search_items`, receipts are empty until
//!   #3163's serving lands (`mem_serving` holds ids only).
//! * **agent_context** = what the REAL serving path (#3169) hands an agent run: for every canary and
//!   control token a mention run is raised the way the send path raises one (a message by the
//!   invoker in the answer channel, an `agent_run` row triggered by it), and the memory tx reads
//!   `mem_serve_items` (items matching the trigger message, D6-4 audience rule inside) plus
//!   `mem_serve_candidates` (summaries). The invoker's rights, the answer channel and the query are
//!   the run row's, as in production. The worker binary's text framing (`serving::pack`) is not
//!   run here; it has its own tests and `memory_serving_conformance_pg`.
//! * `current_value` / `timeline` / `commitments` stay `NotImplemented` (M3 closes validity periods).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-agent-worker --test memory_eval_items_pg -- --ignored --test-threads=1 --nocapture
//! ```

#![allow(dead_code, unused_imports)]

include!("common/memory_harness.rs");

#[path = "../../../crates/momo-agent/tests/eval_kit/mod.rs"]
mod eval_kit;

use std::collections::HashMap;

use eval_kit::corpus::*;
use eval_kit::harness::*;
use eval_kit::pg as evalpg;
use eval_kit::reference::{product_backend, register_product_backend};
use momo_agent_worker::summary::SweepStats;
use serde_json::{json, Value};

const PLACEHOLDER: &str = "[민감정보로 보여 가려진 메시지]";

#[derive(Clone)]
struct Ctx {
    su: PgPool,
    app: PgPool,
    handle: tokio::runtime::Handle,
    stats: Arc<Mutex<Vec<SweepStats>>>,
    /// #3173: embed the ingested items (mock embedder) and serve through the fused path with the
    /// widest possible vector candidate set (floor 0, no margin) — the leak gate must still hold.
    vectors: bool,
}

struct State {
    seeded: evalpg::Seeded,
    by_message: HashMap<Uuid, String>,
    /// Every canary / control token: the queries the serving path is asked with.
    tokens: Vec<String>,
}

struct ItemsBackend {
    ctx: Ctx,
    state: Option<State>,
}

fn block<F: Future>(ctx: &Ctx, f: F) -> F::Output {
    tokio::task::block_in_place(|| ctx.handle.block_on(f))
}

/// The mock model: reads the `[seq] name(kind): body` transcript out of the prompt, maps each body
/// back to the corpus, and answers with the JSON the extraction prompt asks for.
type Oracle = Arc<dyn Fn(usize, &str) -> String + Send + Sync>;

fn oracle(corpus: &Corpus) -> Oracle {
    let mut by_body: HashMap<String, (Class, Who)> = HashMap::new();
    for m in &corpus.messages {
        by_body
            .entry(m.body.replace('\n', " / "))
            .or_insert((m.class, m.author));
    }
    let secrets: Vec<String> = corpus.secrets.iter().map(|(_, s)| s.clone()).collect();
    Arc::new(move |_n, prompt| {
        let mut good_first: Vec<Value> = Vec::new();
        let mut good_rest: Vec<Value> = Vec::new();
        let mut bad: Vec<Value> = Vec::new();
        let mut summary = Vec::new();
        for line in prompt.lines() {
            let Some(rest) = line.strip_prefix('[') else {
                continue;
            };
            let Some((seq, rest)) = rest.split_once("] ") else {
                continue;
            };
            let Ok(seq) = seq.parse::<i64>() else {
                continue;
            };
            let Some((_, body)) = rest.split_once("): ") else {
                continue;
            };
            summary.push(format!("- {body}"));
            if body == PLACEHOLDER {
                // The model was shown a placeholder, but a hostile/leaky model may still emit a
                // secret-shaped string and cite the message.
                let secret = secrets[seq as usize % secrets.len().max(1)].clone();
                bad.push(json!({"kind": "fact", "text": format!("키는 {secret} 이다"), "evidence": [seq]}));
                continue;
            }
            let Some((class, _)) = by_body.get(body) else {
                continue;
            };
            let candidate = |kind: &str| json!({"kind": kind, "text": body, "evidence": [seq], "confidence": 0.9});
            match class {
                Class::LeakCanary | Class::Control => good_first.push(candidate("fact")),
                Class::Decision | Class::DecisionChange => good_rest.push(candidate("decision")),
                Class::Commitment => good_rest.push(candidate("commitment")),
                // Statements of an agent or a bot are not facts: a careless model cites them anyway.
                Class::Bot | Class::AgentReply => bad.push(candidate("fact")),
                Class::Chatter | Class::Secret => {}
            }
        }
        bad.push(json!({"kind": "fact", "text": "창 밖의 번호를 근거로 든 사실", "evidence": [9_999_999]}));
        // Invalid candidates first: they must be dropped for their own reason, not by the item cap.
        let mut items = bad;
        items.extend(good_first);
        items.extend(good_rest);
        json!({ "summary": summary.join("\n"), "items": items }).to_string()
    })
}

impl ItemsBackend {
    fn ids(&self) -> R<&State> {
        self.state
            .as_ref()
            .ok_or(EvalError::NotImplemented("ingest first"))
    }

    async fn rows(
        pool: &PgPool,
        ws: Uuid,
        viewer: Option<Uuid>,
        sql: &str,
        bind: Option<&str>,
        by_message: &HashMap<Uuid, String>,
    ) -> Vec<Recalled> {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(ws.to_string())
            .execute(&mut *tx)
            .await
            .expect("ws");
        if let Some(v) = viewer {
            sqlx::query("SELECT set_config('app.member_id', $1, true)")
                .bind(v.to_string())
                .execute(&mut *tx)
                .await
                .expect("member");
        }
        let mut q = sqlx::query_as::<_, (String, Vec<Uuid>)>(sql);
        if let Some(b) = bind {
            q = q.bind(b.to_string());
        }
        let rows = q.fetch_all(&mut *tx).await.expect("recall rows");
        tx.rollback().await.expect("rollback");
        rows.into_iter()
            .map(|(text, evidence)| Recalled {
                text,
                evidence: evidence
                    .iter()
                    .filter_map(|id| by_message.get(id).cloned())
                    .collect(),
            })
            .collect()
    }
}

impl MemoryBackend for ItemsBackend {
    fn ingest(&mut self, corpus: &Corpus) -> R<()> {
        let ctx = self.ctx.clone();
        let corpus = corpus.clone();
        let state = block(&ctx, async {
            reset_instance(&ctx.su).await;
            let seeded = evalpg::seed(&ctx.su, &ctx.app, &corpus).await;
            configure_summary_row(&ctx.su, seeded.member[&Who::A]).await;
            let provider = Recorder::new();
            *provider.reply_fn.lock().unwrap() = Some(oracle(&corpus));
            let mut config = memory_config();
            config.memory.window_min_messages = 1;
            config.memory.window_max_messages = 20;
            config.memory.thread_min_replies = 1;
            config.memory.thread_idle_min_replies = 1;
            config.memory.windows_per_channel = 8;
            config.memory.daily_token_cap = 100_000_000;
            let worker = worker_with(&provider, config).await;
            for _ in 0..60 {
                worker.summary_state().forget_channels();
                let stats = worker.summary_sweep().await;
                let idle = stats.windows + stats.threads + stats.regenerated == 0;
                assert_eq!(stats.failures, 0, "{stats:?}");
                ctx.stats.lock().unwrap().push(stats);
                if idle {
                    break;
                }
            }
            if ctx.vectors {
                let svc = momo_agent_worker::embed::EmbedService::with_embedder(
                    Arc::new(momo_embed::testing::MockEmbedder::new(&[])),
                    std::time::Duration::from_secs(2),
                );
                let vw = worker_with(&provider, memory_config())
                    .await
                    .with_embed_service(svc);
                assert!(vw.embed_service().embedder().await.is_some());
                for _ in 0..80 {
                    let s = vw.embed_sweep().await;
                    assert_eq!(s.failures, 0, "{s:?}");
                    if s.embedded == 0 {
                        break;
                    }
                }
            }
            let by_message = seeded
                .message
                .iter()
                .map(|(k, v)| (*v, k.clone()))
                .collect();
            let tokens = corpus
                .canaries
                .iter()
                .chain(corpus.controls.iter())
                .map(|c| c.token.clone())
                .collect();
            State {
                seeded,
                by_message,
                tokens,
            }
        });
        self.state = Some(state);
        Ok(())
    }

    fn apply(&mut self, mutation: &Mutation) -> R<()> {
        let s = &self.ids()?.seeded;
        block(&self.ctx, evalpg::apply_mutation(&self.ctx.su, s, mutation));
        Ok(())
    }

    fn recall(&self, viewer: Who, surface: &Surface) -> R<Vec<Recalled>> {
        let state = self.ids()?;
        let (ws, who) = (state.seeded.workspace_id, state.seeded.member[&viewer]);
        let ctx = &self.ctx;
        let items = "SELECT i.body, ARRAY(SELECT e.message_id FROM mem_evidence e WHERE e.item_id = i.id) FROM mem_item i";
        let digests = "SELECT d.body, ARRAY(SELECT e.message_id FROM mem_evidence e WHERE e.digest_id = d.id) FROM mem_digest d";
        match surface {
            Surface::Browser => Ok(block(ctx, async {
                let mut all =
                    Self::rows(&ctx.app, ws, Some(who), items, None, &state.by_message).await;
                all.extend(
                    Self::rows(&ctx.app, ws, Some(who), digests, None, &state.by_message).await,
                );
                all
            })),
            Surface::Search(q) => Ok(block(ctx, async {
                Self::rows(
                    &ctx.app,
                    ws,
                    Some(who),
                    "SELECT body, evidence_message_ids FROM mem_search_items($1, 50)",
                    Some(q),
                    &state.by_message,
                )
                .await
            })),
            // mem_serving holds ids only (no text); #3163's serving path writes them, not run here.
            Surface::Receipts => Ok(Vec::new()),
        }
    }

    fn agent_context(&self, invoker: Who, channel: Channel) -> R<String> {
        let state = self.ids()?;
        let ws = state.seeded.workspace_id;
        let (requester, answer, agent) = (
            state.seeded.member[&invoker],
            state.seeded.channel[&channel],
            state.seeded.member[&Who::Agent],
        );
        let tokens = state.tokens.clone();
        let su = self.ctx.su.clone();
        let vectors = self.ctx.vectors;
        Ok(block(&self.ctx, async move {
            let wp = momo_worker_pool().await;
            let mut text = String::new();
            // Eight distinct words is a query (the search keeps at most eight): a few runs cover
            // every token, and a wrongly readable canary scores at the top of its run.
            for group in tokens.chunks(8) {
                let seq: i64 = sqlx::query_scalar(
                    "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
                )
                .bind(answer)
                .fetch_one(&su)
                .await
                .expect("seq");
                let trigger = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
                     author_member_id, type, body) VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6)",
                )
                .bind(trigger)
                .bind(ws)
                .bind(answer)
                .bind(seq)
                .bind(requester)
                .bind(format!("@agent {}", group.join(" ")))
                .execute(&su)
                .await
                .expect("trigger message");
                let run = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, trigger_message_id) \
                     VALUES ($1, $2, $3, $4, $5)",
                )
                .bind(run)
                .bind(ws)
                .bind(agent)
                .bind(answer)
                .bind(trigger)
                .execute(&su)
                .await
                .expect("agent_run");
                let literal = vectors.then(|| {
                    use momo_embed::TextEmbedder;
                    momo_embed::vector_literal(
                        &momo_embed::testing::MockEmbedder::new(&[])
                            .embed_query(&group.join(" "))
                            .unwrap(),
                    )
                    .unwrap()
                });
                let served = mem::with_memory_tx(&wp, ws, move |conn| {
                    Box::pin(async move {
                        let items = match &literal {
                            Some(lit) => {
                                mem::serve_items_fused(
                                    conn,
                                    run,
                                    20,
                                    600,
                                    &mem::FusedQuery {
                                        vector: lit,
                                        model: "mock-concepts:v1",
                                        min_similarity: 0.0,
                                        margin: 1.0,
                                    },
                                )
                                .await?
                            }
                            None => mem::serve_items(conn, run, 20, 600).await?,
                        };
                        let digests = mem::serve_candidates(conn, run, None, 50, 3_000).await?;
                        Ok((items, digests))
                    })
                })
                .await
                .expect("serve");
                if let Some(items) = served.0 {
                    for item in items.items {
                        text.push_str(&item.body);
                        text.push('\n');
                    }
                }
                if let Some(candidates) = served.1 {
                    for digest in candidates.digests {
                        text.push_str(&digest.body);
                        text.push('\n');
                    }
                }
            }
            text
        }))
    }

    fn stored(&self) -> R<Vec<Recalled>> {
        let state = self.ids()?;
        let ws = state.seeded.workspace_id;
        let su = self.ctx.su.clone();
        let rows: Vec<(String, Vec<Uuid>)> = block(&self.ctx, async move {
            sqlx::query_as(
                "SELECT i.body, ARRAY(SELECT e.message_id FROM mem_evidence e WHERE e.item_id = i.id) \
                   FROM mem_item i WHERE i.workspace_id = $1",
            )
            .bind(ws)
            .fetch_all(&su)
            .await
            .expect("stored")
        });
        Ok(rows
            .into_iter()
            .map(|(text, evidence)| Recalled {
                text,
                evidence: evidence
                    .iter()
                    .filter_map(|id| state.by_message.get(id).cloned())
                    .collect(),
            })
            .collect())
    }

    fn current_value(&self, _: Who, _: &str) -> R<Option<Answer>> {
        Err(EvalError::NotImplemented(
            "MEM-M3 decision timeline (#3172/#3174)",
        ))
    }
    fn timeline(&self, _: Who, _: &str) -> R<Vec<Period>> {
        Err(EvalError::NotImplemented(
            "MEM-M3 decision timeline (#3172/#3174)",
        ))
    }
    fn commitments(&self, _: Who) -> R<Vec<Commitment>> {
        Err(EvalError::NotImplemented(
            "MEM-M3 (owner/due are not item columns yet)",
        ))
    }
}

fn register(ctx: Ctx) {
    register_product_backend(Box::new(move || {
        Box::new(ItemsBackend {
            ctx: ctx.clone(),
            state: None,
        })
    }));
}

/// Replace `function` with `edits` applied; returns the original definition to restore.
async fn sabotage(su: &PgPool, function: &str, edits: &[(&str, &str)]) -> String {
    let original: String = sqlx::query_scalar("SELECT pg_get_functiondef($1::regprocedure)")
        .bind(function)
        .fetch_one(su)
        .await
        .expect("def");
    let mut def = original.clone();
    for (from, to) in edits {
        assert!(def.contains(from), "fragment missing in {function}: {from}");
        def = def.replacen(from, to, 1);
    }
    sqlx::query(&def).execute(su).await.expect("sabotage");
    original
}

async fn restore(su: &PgPool, original: &str) {
    sqlx::query(original).execute(su).await.expect("restore");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 superuser DB"]
async fn the_items_path_has_zero_leaks_and_stores_nothing_it_must_not() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let ctx = Ctx {
        su: su.clone(),
        app: momo_app_pool().await,
        handle: tokio::runtime::Handle::current(),
        stats: Arc::new(Mutex::new(Vec::new())),
        vectors: false,
    };
    register(ctx.clone());
    let corpus = generate(SEED);
    let factory = || product_backend();

    // ---- 0. one ingest, looked at closely -------------------------------------------------
    let mut b = product_backend();
    b.ingest(&corpus).expect("ingest");
    let stored = b.stored().expect("stored");
    let total = ctx
        .stats
        .lock()
        .unwrap()
        .iter()
        .fold(SweepStats::default(), |mut a, s| {
            a.windows += s.windows;
            a.threads += s.threads;
            a.items_added += s.items_added;
            a.items_dropped += s.items_dropped;
            a.items_duplicate += s.items_duplicate;
            a.items_refused += s.items_refused;
            a.llm_calls += s.llm_calls;
            a
        });
    eprintln!(
        "\n=== MEM eval kit over the real items path (seed {SEED:#x}, {} messages) ===",
        corpus.messages.len()
    );
    eprintln!("sweep totals: {total:?}");
    eprintln!("items stored: {}", stored.len());
    let good_classes = [
        Class::Decision,
        Class::DecisionChange,
        Class::Commitment,
        Class::LeakCanary,
        Class::Control,
    ];
    let expect_ok = corpus
        .messages
        .iter()
        .filter(|m| good_classes.contains(&m.class))
        .count();
    let bad_cited = corpus
        .messages
        .iter()
        .filter(|m| matches!(m.class, Class::Bot | Class::AgentReply | Class::Secret))
        .count();
    eprintln!(
        "oracle offered {expect_ok} grounded candidates and {bad_cited}+ deliberately bad ones"
    );
    assert!(
        total.items_dropped >= bad_cited,
        "the bad candidates were dropped by the validator: {total:?}"
    );
    assert_eq!(
        total.items_refused, 0,
        "nothing bad reached the database: {total:?}"
    );
    // Every canary and control was stored (positive: an empty store must not look clean) ...
    for c in corpus.canaries.iter().chain(corpus.controls.iter()) {
        assert!(
            stored
                .iter()
                .any(|s| s.text.contains(&c.token) && s.evidence == vec![c.message_key.clone()]),
            "{} is stored with its own message as evidence",
            c.token
        );
    }
    // ... and nothing else from the forbidden classes.
    let violations = policy_and_provenance_violations(&*b, &corpus).expect("policy check");
    eprintln!("policy + provenance violations: {violations:?}");
    assert!(violations.is_empty(), "{violations:?}");
    // Digest bodies (built from the transcript the model saw) carry no secret-shaped string either.
    let digests: Vec<String> = sqlx::query_scalar("SELECT body FROM mem_digest")
        .fetch_all(&su)
        .await
        .expect("digests");
    for (_, secret) in &corpus.secrets {
        assert!(digests.iter().all(|d| !d.contains(secret.as_str())));
        assert!(stored.iter().all(|s| !s.text.contains(secret.as_str())));
    }
    drop(b);

    // ---- 1. the leak gate -------------------------------------------------------------------
    let started = std::time::Instant::now();
    let violations =
        tokio::task::block_in_place(|| leak_violations(&factory, &corpus)).expect("leak cases run");
    eprintln!(
        "leak cases: {} violation(s) in {:?}",
        violations.len(),
        started.elapsed()
    );
    assert!(violations.is_empty(), "permission leaks: {violations:?}");
    for (id, what) in LEAK_CASES {
        eprintln!("  PASS {id}: {what}");
    }

    // ---- 2. sabotage: each guard removed makes the gate FAIL, and putting it back makes it pass
    let read_fn = "public.mem_item_readable_by(uuid, uuid)";
    let audience_fn = "public.mem_item_audience_ok(uuid, uuid, uuid)";
    let live_fn = "public.mem_item_live(uuid)";
    type SabotageCase<'a> = (&'a str, &'a str, Vec<(&'a str, &'a str)>, &'a str);
    let cases: Vec<SabotageCase> = vec![
        (
            "RLS evidence condition (channel readable) removed",
            read_fn,
            vec![
                ("AND public.mem_member_can_read(i.channel_id, p_viewer)", "AND true"),
                ("public.mem_member_can_read(ev.channel_id, p_viewer)", "true"),
            ],
            "z_sees_no_hr",
        ),
        (
            "audience predicate removed",
            audience_fn,
            vec![
                ("IF NOT (v_home = p_answer_channel_id", "IF NOT (true OR v_home = p_answer_channel_id"),
                (
                    "     WHERE ev.item_id = p_item_id AND ev.workspace_id = v_ws\n       AND NOT (ev.channel_id = p_answer_channel_id\n                OR (v_dm AND public.mem_member_can_read(ev.channel_id, p_requester_member_id)))",
                    "     WHERE false",
                ),
            ],
            "general_call_excludes_hr",
        ),
        (
            "deleted-source condition removed",
            read_fn,
            vec![("AND m.deleted_at IS NULL", ""), ("AND m.state <> 'deleted'", "")],
            "deleted_source_hidden",
        ),
    ];
    for (label, function, edits, expect) in cases {
        let original = sabotage(&su, function, &edits).await;
        // the audience rule also runs the liveness check; the deleted-source sabotage must reach it too
        let live_original = if label.starts_with("deleted-source") {
            Some(
                sabotage(
                    &su,
                    live_fn,
                    &[
                        ("AND m.deleted_at IS NULL", ""),
                        ("AND m.state <> 'deleted'", ""),
                    ],
                )
                .await,
            )
        } else {
            None
        };
        let red = tokio::task::block_in_place(|| leak_violations(&factory, &corpus))
            .expect("leak cases run");
        restore(&su, &original).await;
        if let Some(o) = live_original {
            restore(&su, &o).await;
        }
        eprintln!(
            "RED {label}: {} violation(s), e.g. {:?}",
            red.len(),
            red.first()
        );
        assert!(
            red.iter().any(|v| v.starts_with(expect)),
            "{label}: the gate must fail with {expect}: {red:?}"
        );
    }
    let after =
        tokio::task::block_in_place(|| leak_violations(&factory, &corpus)).expect("leak cases run");
    assert!(after.is_empty(), "everything restored: {after:?}");
    eprintln!("restored: 0 violations again");
    reset_instance(&su).await;
}

/// #3173 — the same leak gate with the vector path in play: every ingested item is embedded and
/// the agent's context is what `mem_serve_items_fused` returns with the widest candidate set
/// (similarity floor 0, no margin, so every permitted item is a vector candidate). 0 violations
/// with the guards in place; the audience rule removed from the *vector loop* (the keyword side
/// untouched) makes the gate FAIL — so the gate really sees the new path.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 superuser DB"]
async fn the_vector_path_has_zero_leaks_too() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let ctx = Ctx {
        su: su.clone(),
        app: momo_app_pool().await,
        handle: tokio::runtime::Handle::current(),
        stats: Arc::new(Mutex::new(Vec::new())),
        vectors: true,
    };
    // Not `register_product_backend` (first registration wins per process, and the sibling test
    // registered a backend bound to its own runtime): this test builds its backend itself.
    let corpus = generate(SEED);
    let factory = {
        let ctx = ctx.clone();
        move || -> Box<dyn MemoryBackend> {
            Box::new(ItemsBackend {
                ctx: ctx.clone(),
                state: None,
            })
        }
    };

    let started = std::time::Instant::now();
    let violations =
        tokio::task::block_in_place(|| leak_violations(&factory, &corpus)).expect("leak cases run");
    eprintln!(
        "\n=== MEM eval kit, VECTOR path (fused serving, floor 0, {} messages) ===\nleak cases: {} violation(s) in {:?}",
        corpus.messages.len(),
        violations.len(),
        started.elapsed()
    );
    assert!(violations.is_empty(), "permission leaks: {violations:?}");
    // The vector side really carried items: embeddings exist for the stored items.
    let embedded: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_item_embedding")
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(embedded > 0, "the vector path had something to rank");
    for (id, what) in LEAK_CASES {
        eprintln!("  PASS {id}: {what}");
    }

    // Sabotage the vector loop only.
    let fused = "public.mem_search_items_fused(uuid, text, integer, uuid, text, text, real, real)";
    let original = sabotage(
        &su,
        fused,
        &[(
            "IF NOT public.mem_item_audience_ok(r.eid, p_answer_channel_id, p_viewer) THEN\n      CONTINUE;\n    END IF;",
            "",
        )],
    )
    .await;
    let red =
        tokio::task::block_in_place(|| leak_violations(&factory, &corpus)).expect("leak cases run");
    restore(&su, &original).await;
    eprintln!(
        "RED vector loop without the audience rule: {} violation(s), e.g. {:?}",
        red.len(),
        red.first()
    );
    assert!(
        red.iter()
            .any(|v| v.starts_with("general_call_excludes_hr")),
        "the gate must fail through the vector path: {red:?}"
    );
    let after =
        tokio::task::block_in_place(|| leak_violations(&factory, &corpus)).expect("leak cases run");
    assert!(after.is_empty(), "everything restored: {after:?}");
    eprintln!("restored: 0 violations again");
    reset_instance(&su).await;
}
