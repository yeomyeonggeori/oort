//! MEM-M1 serving against the MEM-M0 evaluation kit's permission-leak checks (#3163, plan §8.1).
//!
//! The kit's `MemoryBackend` seam is wired here to the **real** serving path: digests are written
//! through `mem_apply_digest` (as the summary worker does), `recall` reads them through the API's
//! read functions as `momo_app` with the viewer's `app.member_id` (RLS on), and `agent_context`
//! is what a run would receive from `mem_serve_candidates` — the SQL half of #3163, executed in a
//! memory tx as `momo_memory`. What this cannot reach is the worker binary's text framing
//! (`serving::pack`): `momo-agent` cannot depend on the worker binary. The framing has its own
//! unit tests and the injection test in `memory_serving_conformance_pg.rs`.
//!
//! It is wired through the `MemoryBackend` trait, not through `eval_kit::reference::product_backend()`:
//! that function is the kit's DB-free seam, and `memory_eval.rs` pins it as
//! "unimplemented -> error, never a vacuous pass".
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-agent --test memory_serving_eval_pg -- --ignored --test-threads=1
//! ```
//!
//! Sabotage is built in: the `naive` backend serves every digest in the workspace (what a missing
//! audience rule would do), and the same checkers must flag it.

mod eval_kit;

use std::path::PathBuf;
use std::process::Command;

use eval_kit::corpus::*;
use eval_kit::harness::*;
use eval_kit::pg::{self, Seeded};
use momo_agent::memory as mem;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::memory as api;
use momo_messaging::{send_message_in_tx, NewMessage};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

fn url() -> String {
    std::env::var("DATABASE_URL").expect("DATABASE_URL must point at a throwaway DB")
}

fn prepare() {
    run_migrations(&url(), &default_migrations_dir(), SeedMode::None).expect("migrations");
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    root.pop();
    root.pop();
    root.pop();
    let psql = std::env::var("PSQL_BIN").unwrap_or_else(|_| {
        let brew = "/opt/homebrew/opt/libpq/bin/psql";
        if std::path::Path::new(brew).is_file() {
            brew.into()
        } else {
            "psql".into()
        }
    });
    let ok = Command::new(psql)
        .arg(url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet", "-f"])
        .arg(root.join("infra/rust/sql/bootstrap_roles.sql"))
        .status()
        .expect("psql")
        .success();
    assert!(ok, "bootstrap_roles.sql");
}

async fn pool_as(user: Option<(&str, &str)>) -> PgPool {
    let mut opts: PgConnectOptions = url().parse().unwrap();
    if let Some((name, default_pw)) = user {
        let env = format!("{}_PASSWORD", name.to_uppercase());
        opts = opts
            .username(name)
            .password(&std::env::var(env).unwrap_or_else(|_| default_pw.to_string()));
    }
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await
        .unwrap_or_else(|e| panic!("connect: {e}"))
}

/// One backend = one workspace. Sync trait, async database: a private runtime bridges them
/// (declared last so the pools drop before it).
struct ServingBackend {
    naive: bool,
    su: PgPool,
    app: PgPool,
    worker: PgPool,
    seeded: Option<Seeded>,
    rt: tokio::runtime::Runtime,
}

impl ServingBackend {
    fn new(naive: bool) -> ServingBackend {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let (su, app, worker) = rt.block_on(async {
            (
                pool_as(None).await,
                pool_as(Some(("momo_app", "momo_app_dev_pw"))).await,
                pool_as(Some(("momo_worker", "momo_worker_dev_pw"))).await,
            )
        });
        ServingBackend {
            naive,
            su,
            app,
            worker,
            seeded: None,
            rt,
        }
    }

    fn seeded(&self) -> &Seeded {
        self.seeded.as_ref().expect("ingest first")
    }
}

impl MemoryBackend for ServingBackend {
    fn ingest(&mut self, corpus: &Corpus) -> R<()> {
        let (su, app, worker) = (self.su.clone(), self.app.clone(), self.worker.clone());
        let seeded = self.rt.block_on(async {
            let seeded = pg::seed(&su, &app, corpus).await;
            let ws = seeded.workspace_id;
            // One window digest per channel: an extractive "summary" (the channel's own text,
            // in order). The model is not what is under test; the audience path is.
            for ch in Channel::ALL {
                let channel = seeded.channel[&ch];
                let rows = sqlx::query(
                    "SELECT id, seq, edited_at, COALESCE(body, '') AS body FROM message \
                      WHERE channel_id = $1 AND deleted_at IS NULL ORDER BY seq",
                )
                .bind(channel)
                .fetch_all(&su)
                .await
                .unwrap();
                let body: String = rows
                    .iter()
                    .map(|r| r.get::<String, _>("body"))
                    .collect::<Vec<_>>()
                    .join("\n");
                let evidence: Vec<mem::EvidenceRef> = rows
                    .iter()
                    .map(|r| mem::EvidenceRef {
                        message_id: r.get("id"),
                        seq: r.get("seq"),
                        edited_at: r.get("edited_at"),
                    })
                    .collect();
                let (from, to) = (evidence.first().unwrap().seq, evidence.last().unwrap().seq);
                let read_at = with_tenant_tx(&worker, ws, |conn| {
                    Box::pin(async move { mem::read_clock(conn).await })
                })
                .await
                .unwrap();
                let text = body.clone();
                mem::with_memory_tx(&worker, ws, move |conn| {
                    Box::pin(async move {
                        mem::apply_digest(
                            conn,
                            &mem::NewDigest {
                                channel_id: channel,
                                thread_root_id: None,
                                level: "window",
                                from_seq: from,
                                to_seq: to,
                                body: &text,
                                source_digest_ids: &[],
                                model: "eval-extractive",
                                model_source: "instance_default",
                                evidence: &evidence,
                                read_at,
                            },
                        )
                        .await
                    })
                })
                .await
                .expect("apply the channel digest");
            }
            seeded
        });
        self.seeded = Some(seeded);
        Ok(())
    }

    fn apply(&mut self, mutation: &Mutation) -> R<()> {
        let (su, seeded) = (self.su.clone(), self.seeded());
        self.rt.block_on(pg::apply_mutation(&su, seeded, mutation));
        Ok(())
    }

    fn recall(&self, viewer: Who, surface: &Surface) -> R<Vec<Recalled>> {
        // The browser: the API's read functions as `momo_app`, RLS deciding. Search narrows the
        // same rows by the keyword; a run's receipts are empty here (no run has happened).
        let s = self.seeded();
        let (ws, member) = (s.workspace_id, s.member[&viewer]);
        let channels: Vec<Uuid> = Channel::ALL.iter().map(|c| s.channel[c]).collect();
        let needle = match surface {
            Surface::Receipts => return Ok(vec![]),
            Surface::Search(token) => Some(token.clone()),
            Surface::Browser => None,
        };
        let app = self.app.clone();
        let digests = self.rt.block_on(async move {
            let mut out = Vec::new();
            for channel in channels {
                let found = with_tenant_tx(&app, ws, move |conn| {
                    Box::pin(async move {
                        api::bind_mem_reader_guc(conn, member).await?;
                        api::list_digests_in_tx(
                            conn,
                            &api::DigestListFilter {
                                channel_id: channel,
                                thread_root_id: None,
                                level: None,
                                after_seq: 0,
                                before: None,
                                limit: 50,
                            },
                        )
                        .await
                    })
                })
                .await
                .expect("list digests");
                out.extend(found);
            }
            out
        });
        Ok(digests
            .into_iter()
            .filter(|d| needle.as_ref().is_none_or(|n| d.body.contains(n)))
            .map(|d| Recalled {
                text: d.body,
                evidence: vec![],
            })
            .collect())
    }

    fn agent_context(&self, invoker: Who, channel: Channel) -> R<String> {
        let s = self.seeded();
        let (ws, ch) = (s.workspace_id, s.channel[&channel]);
        let (who, agent) = (s.member[&invoker], s.member[&Who::Agent]);
        let (su, app, worker) = (self.su.clone(), self.app.clone(), self.worker.clone());
        let naive = self.naive;
        Ok(self.rt.block_on(async move {
            if naive {
                // What a missing audience rule would do: every digest of the workspace.
                let rows = sqlx::query("SELECT body FROM mem_digest WHERE workspace_id = $1")
                    .bind(ws)
                    .fetch_all(&su)
                    .await
                    .unwrap();
                return rows
                    .iter()
                    .map(|r| r.get::<String, _>("body"))
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            // The invoker asks in `channel`: the message, then the run the send path would make.
            let trigger = with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    let sent = send_message_in_tx(
                        conn,
                        ws,
                        NewMessage::text(ch, who, "@kim-intern 정리해 줘".to_string()),
                    )
                    .await?;
                    Ok(sent.message.id)
                })
            })
            .await
            .expect("trigger message");
            let run: Uuid = sqlx::query_scalar(
                "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, trigger_message_id) \
                 VALUES ($1, $2, $3, $4) RETURNING id",
            )
            .bind(ws)
            .bind(agent)
            .bind(ch)
            .bind(trigger)
            .fetch_one(&su)
            .await
            .expect("run");
            let candidates = mem::with_memory_tx(&worker, ws, move |conn| {
                Box::pin(async move { mem::serve_candidates(conn, run, None, 50, 20_000).await })
            })
            .await
            .expect("serve candidates");
            candidates
                .map(|c| {
                    c.digests
                        .iter()
                        .map(|d| d.body.clone())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        }))
    }

    fn stored(&self) -> R<Vec<Recalled>> {
        let (su, ws) = (self.su.clone(), self.seeded().workspace_id);
        Ok(self.rt.block_on(async move {
            sqlx::query("SELECT body FROM mem_digest WHERE workspace_id = $1")
                .bind(ws)
                .fetch_all(&su)
                .await
                .unwrap()
                .iter()
                .map(|r| Recalled {
                    text: r.get("body"),
                    evidence: vec![],
                })
                .collect()
        }))
    }

    // Decisions / timelines / commitments are M2/M3. Erroring keeps them RED, never vacuous.
    fn current_value(&self, _: Who, _: &str) -> R<Option<Answer>> {
        Err(EvalError::NotImplemented("current_value (M2)"))
    }
    fn timeline(&self, _: Who, _: &str) -> R<Vec<Period>> {
        Err(EvalError::NotImplemented("timeline (M3)"))
    }
    fn commitments(&self, _: Who) -> R<Vec<Commitment>> {
        Err(EvalError::NotImplemented("commitments (M2)"))
    }
}

#[test]
#[ignore = "needs DATABASE_URL (isolated pgvector/pg18)"]
fn the_real_serving_path_leaks_nothing_across_the_kits_eight_cases() {
    prepare();
    let corpus = generate(SEED);
    let factory = || -> Box<dyn MemoryBackend> { Box::new(ServingBackend::new(false)) };
    let violations = leak_violations(&factory, &corpus).expect("the backend answered every case");
    assert!(
        violations.is_empty(),
        "permission leak count must be 0: {violations:?}"
    );
}

/// The checkers can fail on this wiring: serve every digest and the kit flags it.
#[test]
#[ignore = "needs DATABASE_URL (isolated pgvector/pg18)"]
fn sabotage_serving_every_digest_is_caught_by_the_kit() {
    prepare();
    let corpus = generate(SEED);
    let factory = || -> Box<dyn MemoryBackend> { Box::new(ServingBackend::new(true)) };
    let violations = leak_violations(&factory, &corpus).expect("answered");
    assert!(
        violations
            .iter()
            .any(|v| v.starts_with("general_call_excludes_hr")),
        "RED expected, got {violations:?}"
    );
    assert!(
        violations
            .iter()
            .any(|v| v.starts_with("no_cross_channel_text")),
        "RED expected, got {violations:?}"
    );
}
