//! ADR-0218 G3.6 (#4820 C1b): the held assemblies. Real PG18, two tenants, the actual
//! NOBYPASSRLS runtime role, a real assembler output (no hand-made GIFs).
//! DATABASE_URL=<dedicated DB> cargo test -p momo-expressions --test assembly_pg -- --ignored
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_kept_assembly_is_three_renditions_per_candidate_and_reads_back_for_its_own_agent` | what is stored is what the assembler built, with the one-hour TTL and the failed hole | a rendition is dropped, bytes change, the hour changes, the hole is lost |
//! | `rls_hides_a_held_assembly_from_another_workspace_and_from_another_agent` | the `ws_isolation` and `expression_assembly_agent` policies, with no predicate in the query | either policy goes |
//! | `get_in_tx_refuses_by_its_own_predicates_when_no_policy_helps` | the agent and the person are arguments the SQL itself checks, on a request that binds no `app.agent_member_id` (the hosted door's) | `AND agent_member_id` or `AND requester_member_id` is dropped from `get_in_tx` |
//! | `an_agent_holds_twelve_candidates_and_the_twelve_are_proved_under_the_agents_lock` | the cap, refusing writes nothing, holes do not count, the lock | the cap, the count or the lock goes |
//! | `an_hour_the_sweep_and_the_reclaim_delete_the_bytes_and_keep_the_record` | TTL on read, the sweep (notifier-shaped), explicit reclaim | any of the three stops deleting bytes |
//! | `pixels_and_the_header_are_immutable_to_the_runtime_role` | the backstop triggers | a trigger goes |
//! | `the_audit_row_carries_facts_and_never_the_prompt_the_picture_or_the_attachment` | D6's closed list | the row starts to carry them |
use futures::future::BoxFuture;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx::{
    self,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use momo_db::tenant::REQUEST_AGENT_MEMBER;
use momo_db::{PgConnection, PgPool};
use momo_expressions::assemble::{
    assemble_in_process, AssembleError, AssembleRequest, Motion, Outcome, Preset, SourceFrom,
};
use momo_expressions::assembly::{self, Keep, HELD_MAX};
use momo_expressions::{self as e, Actor, Error};
use std::sync::{Once, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

struct World {
    su: PgPool,
    api: PgPool,
    human: Actor,
    agent: Uuid,
    other_agent: Uuid,
    requester: Uuid,
    foreign: Actor,
    foreign_agent: Uuid,
}

async fn world() -> World {
    let url = std::env::var("DATABASE_URL").expect("dedicated DATABASE_URL");
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        run_migrations(&url, &default_migrations_dir(), SeedMode::None).unwrap();
        let psql = if std::path::Path::new("/opt/homebrew/opt/libpq/bin/psql").is_file() {
            "/opt/homebrew/opt/libpq/bin/psql"
        } else {
            "psql"
        };
        let output = std::process::Command::new(psql)
            .arg(&url)
            .args([
                "--no-psqlrc",
                "--quiet",
                "-v",
                "ON_ERROR_STOP=1",
                "--single-transaction",
                "-f",
            ])
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../infra/rust/sql/bootstrap_roles.sql"
            ))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "bootstrap roles: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    });
    let su = PgPoolOptions::new()
        .max_connections(12)
        .connect(&url)
        .await
        .unwrap();
    let options: PgConnectOptions = url.parse().unwrap();
    let api = PgPoolOptions::new()
        .max_connections(12)
        .connect_with(options.username("momo_app").password("momo_app_dev_pw"))
        .await
        .unwrap();
    let role: (bool, bool) =
        sqlx::query_as("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
            .fetch_one(&api)
            .await
            .unwrap();
    assert_eq!(role, (false, false), "the tenant role must not bypass RLS");
    let ws = workspace(&su).await;
    let other = workspace(&su).await;
    let human = member(&su, ws, "human", true).await;
    let requester = member(&su, ws, "human", true).await;
    let agent = member(&su, ws, "agent", false).await;
    let other_agent = member(&su, ws, "agent", false).await;
    let foreign = member(&su, other, "human", true).await;
    let foreign_agent = member(&su, other, "agent", false).await;
    World {
        su,
        api,
        human: Actor {
            workspace: ws,
            member: human,
        },
        agent,
        other_agent,
        requester,
        foreign: Actor {
            workspace: other,
            member: foreign,
        },
        foreign_agent,
    }
}

async fn workspace(su: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(id)
        .bind(id.to_string())
        .execute(su)
        .await
        .unwrap();
    id
}

async fn member(su: &PgPool, ws: Uuid, kind: &str, with_role: bool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,display_name,handle) VALUES($1,$2,$3::member_kind,$4,$4)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(id.to_string())
    .execute(su)
    .await
    .unwrap();
    if with_role {
        sqlx::query("INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,'member'::membership_role)")
            .bind(ws)
            .bind(id)
            .execute(su)
            .await
            .unwrap();
    }
    id
}

/// A picture with edges, colour and a clear middle, so every preset has something to move.
fn picture() -> Vec<u8> {
    let image = image::RgbaImage::from_fn(96, 80, |x, y| {
        let inside = (24..72).contains(&x) && (16..64).contains(&y);
        if inside {
            image::Rgba([220, (x * 2) as u8, (y * 3) as u8, 255])
        } else {
            image::Rgba([250, 245, 235, 255])
        }
    });
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

/// The four presets, assembled once by the real assembler (in this process: the isolation
/// child is C1a's concern) and cloned by every test.
fn built() -> Vec<Outcome> {
    static BUILT: OnceLock<Vec<Outcome>> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            let mut request = AssembleRequest::new(Motion::Preset {
                presets: Preset::ALL.to_vec(),
            });
            request.size = 240;
            assemble_in_process(
                &request,
                &picture(),
                SourceFrom::Request,
                Instant::now() + Duration::from_secs(60),
            )
            .expect("the four presets assemble")
        })
        .clone()
}

fn slot_motions() -> Vec<e::assemble::MotionKind> {
    let mut request = AssembleRequest::new(Motion::Preset {
        presets: Preset::ALL.to_vec(),
    });
    request.size = 240;
    request.slot_kinds()
}

async fn in_tx<T: Send + 'static>(
    pool: &PgPool,
    who: Actor,
    agent: Option<Uuid>,
    body: impl for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, Error>> + Send,
) -> Result<T, Error> {
    match agent {
        Some(agent) => {
            REQUEST_AGENT_MEMBER
                .scope(agent, e::transaction(pool, who, body))
                .await
        }
        None => e::transaction(pool, who, body).await,
    }
}

/// Keep `outcomes` for `agent` as the agent's own request would.
async fn keep(
    w: &World,
    agent: Uuid,
    outcomes: Vec<Outcome>,
) -> Result<Result<assembly::Kept, assembly::Full>, Error> {
    let ws = w.human.workspace;
    let requester = w.requester;
    let motions = slot_motions();
    in_tx(&w.api, w.human, Some(agent), move |conn| {
        Box::pin(async move {
            assembly::keep_in_tx(
                conn,
                &Keep {
                    workspace: ws,
                    agent,
                    requester,
                    prompt: "빨간 네모 스티커",
                    source_attachment_id: None,
                    motions: &motions[..outcomes.len()],
                    outcomes: &outcomes,
                },
            )
            .await
        })
    })
    .await
}

/// `SELECT count(*)` with no predicate: what the runtime role may see, and nothing else.
fn count_rows(
    table: &'static str,
) -> impl for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<i64, Error>> + Send {
    move |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                    .fetch_one(conn)
                    .await?,
            )
        })
    }
}

async fn images_of(su: &PgPool, assembly_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM expression_assembly_image WHERE assembly_id=$1")
        .bind(assembly_id)
        .fetch_one(su)
        .await
        .unwrap()
}

/// The clock fixture of the draft tests: expiry is immutable to runtime SQL, so only the
/// superuser fixture disables ITS OWN identity trigger, moves the hour, and restores it.
async fn expire(su: &PgPool, assembly_id: Uuid) {
    let mut tx = su.begin().await.unwrap();
    sqlx::query("ALTER TABLE expression_assembly DISABLE TRIGGER expression_assembly_identity")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE expression_assembly SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(assembly_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE expression_assembly ENABLE TRIGGER expression_assembly_identity")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn a_kept_assembly_is_three_renditions_per_candidate_and_reads_back_for_its_own_agent() {
    let w = world().await;
    let ws = w.human.workspace;
    let mut outcomes = built();
    // Slot 2 was "built too large": a hole with its measured size, no bytes.
    outcomes[2] = Err(AssembleError::OutputTooLarge { bytes: 1_234_567 });
    let before = chrono::Utc::now();
    let kept = keep(&w, w.agent, outcomes.clone()).await.unwrap().unwrap();
    assert_eq!(
        kept.candidates.iter().map(|c| c.index).collect::<Vec<_>>(),
        vec![0, 1, 3],
        "a hole keeps its own index"
    );
    assert_eq!(kept.failed, vec![(2, 1_234_567)]);
    // One hour, from the database clock (not the process's).
    let hour = (kept.expires_at - before).num_seconds();
    assert!(
        (3590..=3610).contains(&hour),
        "TTL is one hour, got {hour}s"
    );
    assert_eq!(
        images_of(&w.su, kept.assembly_id).await,
        9,
        "3 candidates x 3 renditions"
    );

    let held = in_tx(&w.api, w.human, Some(w.agent), move |conn| {
        Box::pin(async move {
            assembly::get_in_tx(conn, ws, w.agent, w.requester, kept.assembly_id).await
        })
    })
    .await
    .unwrap()
    .expect("its own agent reads it back");
    assert_eq!(held.agent, w.agent);
    assert_eq!(held.requester, w.requester);
    assert_eq!(held.prompt, "빨간 네모 스티커");
    assert_eq!(held.source_attachment_id, None);
    assert_eq!(held.failed.len(), 1);
    assert_eq!(
        (
            held.failed[0].index,
            held.failed[0].code.as_str(),
            held.failed[0].bytes
        ),
        (2, "assembly_output_too_large", 1_234_567)
    );
    assert_eq!(
        held.failed[0].motion, "pulse",
        "a hole remembers which motion it was"
    );
    for candidate in &held.candidates {
        let Ok(built) = &outcomes[candidate.index as usize] else {
            panic!("slot {} was not built", candidate.index)
        };
        // Exactly what the assembler built, all three renditions, byte for byte.
        assert_eq!(candidate.motion, built.motion.id());
        for ((_, stored), (_, original)) in candidate
            .media
            .variants()
            .iter()
            .zip(built.media.variants())
        {
            assert_eq!(stored.data, original.data);
            assert_eq!(stored.info, original.info);
        }
    }
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn rls_hides_a_held_assembly_from_another_workspace_and_from_another_agent() {
    let w = world().await;
    let ws = w.human.workspace;
    let kept = keep(&w, w.agent, built()[..2].to_vec())
        .await
        .unwrap()
        .unwrap();

    // The queries below carry NO predicate on purpose: only the real runtime RLS may hide rows.
    for table in ["expression_assembly", "expression_assembly_image"] {
        // The owning agent sees its own rows (so a zero below is RLS, not an empty table).
        let own = in_tx(&w.api, w.human, Some(w.agent), count_rows(table))
            .await
            .unwrap();
        assert!(
            own >= 1,
            "{table}: the owning agent sees its rows, got {own}"
        );
        // Another tenant, the very same agent id bound or not: nothing.
        let foreign = in_tx(&w.api, w.foreign, None, count_rows(table))
            .await
            .unwrap();
        assert_eq!(foreign, 0, "{table}: a foreign workspace read leaked rows");
        let foreign = in_tx(&w.api, w.foreign, Some(w.agent), count_rows(table))
            .await
            .unwrap();
        assert_eq!(
            foreign, 0,
            "{table}: a foreign workspace read as that agent leaked rows"
        );
        // Same tenant, another agent: the restrictive policy hides it from every read.
        let other = in_tx(&w.api, w.human, Some(w.other_agent), move |conn| {
            Box::pin(async move {
                Ok(sqlx::query_scalar::<_, i64>(&format!(
                    "SELECT count(*) FROM {table} WHERE workspace_id = $1"
                ))
                .bind(ws)
                .fetch_one(conn)
                .await?)
            })
        })
        .await
        .unwrap();
        // The other agent has kept nothing of its own, so every visible row would be a leak.
        assert_eq!(
            other, 0,
            "{table}: another agent of the workspace read rows"
        );
    }
    // Through the API too: another agent, a foreign workspace and an unknown id are one `None`.
    for (who, agent) in [
        (w.human, w.other_agent),
        (w.foreign, w.foreign_agent),
        (w.foreign, w.agent),
    ] {
        let seen = in_tx(&w.api, who, Some(agent), move |conn| {
            Box::pin(async move {
                assembly::get_in_tx(conn, who.workspace, agent, w.requester, kept.assembly_id).await
            })
        })
        .await
        .unwrap();
        assert!(
            seen.is_none(),
            "{agent} read an assembly that is not its own"
        );
    }
    let unknown = in_tx(&w.api, w.human, Some(w.agent), move |conn| {
        Box::pin(async move {
            assembly::get_in_tx(conn, ws, w.agent, w.requester, Uuid::new_v4()).await
        })
    })
    .await
    .unwrap();
    assert!(unknown.is_none());

    // And a write cannot be planted for somebody else: another agent's request may not insert
    // a header that names the first agent (the policy's WITH CHECK is its USING).
    let planted = in_tx(&w.api, w.human, Some(w.other_agent), move |conn| {
        Box::pin(async move {
            sqlx::query("INSERT INTO expression_assembly(workspace_id,agent_member_id,requester_member_id,prompt) VALUES($1,$2,$3,'x')")
                .bind(ws)
                .bind(w.agent)
                .bind(w.requester)
                .execute(conn)
                .await?;
            Ok(())
        })
    })
    .await;
    assert!(planted.is_err(), "another agent planted a held assembly");
    // A header cannot be planted in another tenant either.
    let across = in_tx(&w.api, w.foreign, None, move |conn| {
        Box::pin(async move {
            sqlx::query("INSERT INTO expression_assembly(workspace_id,agent_member_id,requester_member_id,prompt) VALUES($1,$2,$3,'x')")
                .bind(ws)
                .bind(w.agent)
                .bind(w.requester)
                .execute(conn)
                .await?;
            Ok(())
        })
    })
    .await;
    assert!(across.is_err(), "a tenant planted a row in another tenant");
}

/// **The read's own predicates, with no policy to hide behind** (C1b review, Low-4). The
/// `expression_assembly_agent` policy only restricts a request that binds `app.agent_member_id`;
/// the hosted door binds none, so there the SQL of `get_in_tx` is the whole defence. This test
/// runs without the binding (and proves it did) and asks for one real assembly with each
/// argument wrong in turn: another agent of the same workspace, another person, another
/// workspace — every one is `None`, and the right triple reads it.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn get_in_tx_refuses_by_its_own_predicates_when_no_policy_helps() {
    let w = world().await;
    let ws = w.human.workspace;
    let kept = keep(&w, w.agent, built())
        .await
        .unwrap()
        .expect("room to keep");
    let id = kept.assembly_id;
    let (agent, other_agent, requester, other_person) =
        (w.agent, w.other_agent, w.requester, w.human.member);
    assert_ne!(
        requester, other_person,
        "the two people must differ for the test to mean anything"
    );

    // Same workspace, no agent binding: the policy is silent, so these are the predicates.
    let (unbound, own, wrong_agent, wrong_person, unknown) =
        in_tx(&w.api, w.human, None, move |conn| {
            Box::pin(async move {
                let bound: Option<String> = sqlx::query_scalar(
                    "SELECT nullif(current_setting('app.agent_member_id', true), '')",
                )
                .fetch_one(&mut *conn)
                .await?;
                Ok((
                    bound,
                    assembly::get_in_tx(conn, ws, agent, requester, id).await?,
                    assembly::get_in_tx(conn, ws, other_agent, requester, id).await?,
                    assembly::get_in_tx(conn, ws, agent, other_person, id).await?,
                    assembly::get_in_tx(conn, ws, agent, requester, Uuid::new_v4()).await?,
                ))
            })
        })
        .await
        .unwrap();
    assert_eq!(
        unbound, None,
        "no agent was bound: the policy had nothing to restrict"
    );
    assert!(
        own.is_some(),
        "the right workspace, agent and person read it"
    );
    assert!(
        wrong_agent.is_none(),
        "another agent of the workspace read an assembly that is not its own"
    );
    assert!(
        wrong_person.is_none(),
        "an assembly made for somebody else was read for another person"
    );
    assert!(unknown.is_none());

    // Another workspace's request (its own tenant binding, still no agent binding).
    let foreign_ws = w.foreign.workspace;
    let (foreign_agent, foreign_requester) = (w.foreign_agent, w.foreign.member);
    let from_foreign = in_tx(&w.api, w.foreign, None, move |conn| {
        Box::pin(async move {
            Ok((
                assembly::get_in_tx(conn, foreign_ws, foreign_agent, foreign_requester, id).await?,
                // Even naming the first workspace, the tenant policy answers for the second.
                assembly::get_in_tx(conn, ws, agent, requester, id).await?,
            ))
        })
    })
    .await
    .unwrap();
    assert!(
        from_foreign.0.is_none() && from_foreign.1.is_none(),
        "another workspace read it"
    );
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn an_agent_holds_twelve_candidates_and_the_twelve_are_proved_under_the_agents_lock() {
    let w = world().await;
    let ws = w.human.workspace;
    let held = |agent: Uuid| {
        let api = w.api.clone();
        let who = w.human;
        async move {
            in_tx(&api, who, Some(agent), move |conn| {
                Box::pin(async move { assembly::held_in_tx(conn, ws, agent).await })
            })
            .await
            .unwrap()
        }
    };
    assert_eq!(HELD_MAX, 12);
    // Three full assemblies of four: twelve.
    let mut first = None;
    for round in 0..3 {
        let kept = keep(&w, w.agent, built()).await.unwrap().unwrap();
        assert_eq!(kept.candidates.len(), 4);
        if round == 0 {
            first = Some(kept.assembly_id);
        }
    }
    assert_eq!(held(w.agent).await, 12);
    // The thirteenth is refused, says how many are held, and writes nothing.
    let rows_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM expression_assembly WHERE agent_member_id=$1")
            .bind(w.agent)
            .fetch_one(&w.su)
            .await
            .unwrap();
    let audits_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='expression.assembled'",
    )
    .bind(ws)
    .fetch_one(&w.su)
    .await
    .unwrap();
    let refused = keep(&w, w.agent, built()[..1].to_vec()).await.unwrap();
    assert_eq!(refused.unwrap_err(), assembly::Full { held: 12 });
    let rows_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM expression_assembly WHERE agent_member_id=$1")
            .bind(w.agent)
            .fetch_one(&w.su)
            .await
            .unwrap();
    let audits_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='expression.assembled'",
    )
    .bind(ws)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(
        (rows_before, audits_before),
        (rows_after, audits_after),
        "a refusal writes nothing"
    );
    // The cap is per agent: another agent of the same workspace is not touched by it.
    assert!(keep(&w, w.other_agent, built()).await.unwrap().is_ok());
    // Reclaiming one assembly (four candidates) frees exactly those four.
    in_tx(&w.api, w.human, Some(w.agent), move |conn| {
        Box::pin(async move { assembly::reclaim_in_tx(conn, ws, first.unwrap()).await })
    })
    .await
    .unwrap();
    assert_eq!(held(w.agent).await, 8);
    // A hole holds no bytes, so it does not count: 8 + 3 ready (one slot too large) = 11, and
    // 11 + 1 = 12 still fits while one more does not.
    let mut with_hole = built();
    with_hole[3] = Err(AssembleError::OutputTooLarge { bytes: 1_500_000 });
    keep(&w, w.agent, with_hole).await.unwrap().unwrap();
    assert_eq!(held(w.agent).await, 11);
    keep(&w, w.agent, built()[..1].to_vec())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(held(w.agent).await, 12);
    assert!(keep(&w, w.agent, built()[..1].to_vec())
        .await
        .unwrap()
        .is_err());
    // Nothing to keep is a caller's mistake, never a quiet empty row.
    for nothing in [
        vec![],
        vec![Err(AssembleError::OutputTooLarge { bytes: 2_000_000 })],
        vec![Err(AssembleError::Timeout)],
    ] {
        assert!(matches!(
            keep(&w, w.other_agent, nothing).await,
            Err(Error::Invalid)
        ));
    }
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn the_twelve_cannot_be_outrun_by_simultaneous_calls() {
    let w = world().await;
    let ws = w.human.workspace;
    // Four slots held; capacity for two more assemblies of four. Six calls race for them.
    keep(&w, w.agent, built()).await.unwrap().unwrap();
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let (api, human, agent, requester) = (w.api.clone(), w.human, w.agent, w.requester);
        let outcomes = built();
        let motions = slot_motions();
        tasks.push(tokio::spawn(async move {
            in_tx(&api, human, Some(agent), move |conn| {
                Box::pin(async move {
                    assembly::keep_in_tx(
                        conn,
                        &Keep {
                            workspace: ws,
                            agent,
                            requester,
                            prompt: "race",
                            source_attachment_id: None,
                            motions: &motions,
                            outcomes: &outcomes,
                        },
                    )
                    .await
                })
            })
            .await
            .unwrap()
        }));
    }
    let mut stored = 0;
    for task in tasks {
        if task.await.unwrap().is_ok() {
            stored += 1;
        }
    }
    assert_eq!(stored, 2, "exactly the two that fit");
    let held: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM expression_assembly_image i JOIN expression_assembly a ON (a.workspace_id,a.id)=(i.workspace_id,i.assembly_id) WHERE a.agent_member_id=$1 AND a.state='ready' AND i.variant='large'",
    )
    .bind(w.agent)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(
        held, 12,
        "never more than twelve, however the calls interleave"
    );

    // The lock is the one `lock_key` names: holding it from outside stops a keeper, releasing
    // it lets the keeper through (so the proof above is the lock's, not luck).
    let mut outside = w.su.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(assembly::lock_key(ws, w.other_agent))
        .execute(&mut *outside)
        .await
        .unwrap();
    let (api, human, agent) = (w.api.clone(), w.human, w.other_agent);
    let requester = w.requester;
    let waiting = tokio::spawn(async move {
        let outcomes = built();
        let motions = slot_motions();
        in_tx(&api, human, Some(agent), move |conn| {
            Box::pin(async move {
                assembly::keep_in_tx(
                    conn,
                    &Keep {
                        workspace: ws,
                        agent,
                        requester,
                        prompt: "waits",
                        source_attachment_id: None,
                        motions: &motions[..1],
                        outcomes: &outcomes[..1],
                    },
                )
                .await
            })
        })
        .await
    });
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(
        !waiting.is_finished(),
        "a keeper must wait for the agent's lock"
    );
    outside.rollback().await.unwrap();
    assert!(waiting.await.unwrap().unwrap().is_ok());
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn an_hour_the_sweep_and_the_reclaim_delete_the_bytes_and_keep_the_record() {
    let w = world().await;
    let ws = w.human.workspace;
    // One assembly the hour ends on, one an explicit reclaim ends, one still within its hour.
    let aged = keep(&w, w.agent, built()[..2].to_vec())
        .await
        .unwrap()
        .unwrap();
    let closed = keep(&w, w.agent, built()[..2].to_vec())
        .await
        .unwrap()
        .unwrap();
    let live = keep(&w, w.agent, built()[..2].to_vec())
        .await
        .unwrap()
        .unwrap();
    for id in [aged.assembly_id, closed.assembly_id, live.assembly_id] {
        assert_eq!(images_of(&w.su, id).await, 6);
    }
    expire(&w.su, aged.assembly_id).await;
    // An expired assembly is gone for its agent on the very next read, swept or not.
    let read = |id: Uuid| {
        let (api, who, agent, requester) = (w.api.clone(), w.human, w.agent, w.requester);
        async move {
            in_tx(&api, who, Some(agent), move |conn| {
                Box::pin(async move { assembly::get_in_tx(conn, ws, agent, requester, id).await })
            })
            .await
            .unwrap()
        }
    };
    assert!(
        read(aged.assembly_id).await.is_none(),
        "the hour is enforced on read"
    );
    assert!(read(live.assembly_id).await.is_some());
    // And it no longer counts against the twelve before any sweep ran.
    let counted = in_tx(&w.api, w.human, Some(w.agent), move |conn| {
        Box::pin(async move { assembly::held_in_tx(conn, ws, w.agent).await })
    })
    .await
    .unwrap();
    assert_eq!(
        counted, 4,
        "closed + live = 4 held; the aged one holds nothing"
    );

    // The sweep: discovery through the notifier-shaped read pool, reclamation on the tenant role.
    assert_eq!(
        images_of(&w.su, aged.assembly_id).await,
        6,
        "bytes wait for the sweep"
    );
    let freed = e::sweep_expired(&w.su, &w.api).await.unwrap();
    assert!(
        freed >= 6,
        "the sweep reports the rendition rows it deleted, got {freed}"
    );
    assert_eq!(
        images_of(&w.su, aged.assembly_id).await,
        0,
        "TTL sweep deletes the bytes"
    );
    let state: String = sqlx::query_scalar("SELECT state FROM expression_assembly WHERE id=$1")
        .bind(aged.assembly_id)
        .fetch_one(&w.su)
        .await
        .unwrap();
    assert_eq!(state, "expired", "the row stays as a record");
    assert_eq!(
        images_of(&w.su, live.assembly_id).await,
        6,
        "a live assembly is not touched"
    );

    // Explicit reclaim.
    let freed = in_tx(&w.api, w.human, Some(w.agent), move |conn| {
        Box::pin(async move { assembly::reclaim_in_tx(conn, ws, closed.assembly_id).await })
    })
    .await
    .unwrap();
    assert_eq!(freed, 6);
    assert_eq!(
        images_of(&w.su, closed.assembly_id).await,
        0,
        "reclaim deletes the bytes"
    );
    assert!(read(closed.assembly_id).await.is_none());
    // Idempotent.
    let again = in_tx(&w.api, w.human, Some(w.agent), move |conn| {
        Box::pin(async move { assembly::reclaim_in_tx(conn, ws, closed.assembly_id).await })
    })
    .await
    .unwrap();
    assert_eq!(again, 0);
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn pixels_and_the_header_are_immutable_to_the_runtime_role() {
    let w = world().await;
    let ws = w.human.workspace;
    let kept = keep(&w, w.agent, built()[..1].to_vec())
        .await
        .unwrap()
        .unwrap();
    let id = kept.assembly_id;
    for (what, sql) in [
        (
            "rendition width",
            "UPDATE expression_assembly_image SET width=width+1 WHERE assembly_id=$1",
        ),
        (
            "rendition bytes' motion",
            "UPDATE expression_assembly_image SET motion='pulse' WHERE assembly_id=$1",
        ),
        (
            "the prompt",
            "UPDATE expression_assembly SET prompt='other' WHERE id=$1",
        ),
        (
            "the agent",
            "UPDATE expression_assembly SET agent_member_id=requester_member_id WHERE id=$1",
        ),
        (
            "the hour",
            "UPDATE expression_assembly SET expires_at=expires_at+interval '1 day' WHERE id=$1",
        ),
        (
            "the holes",
            "UPDATE expression_assembly SET failed='[{\"index\":0}]'::jsonb WHERE id=$1",
        ),
    ] {
        let attempt = in_tx(&w.api, w.human, Some(w.agent), move |conn| {
            Box::pin(async move {
                sqlx::query(sql).bind(id).execute(conn).await?;
                Ok(())
            })
        })
        .await;
        assert!(attempt.is_err(), "{what} changed through the runtime role");
    }
    // The header may retire, and never come back.
    in_tx(&w.api, w.human, Some(w.agent), move |conn| {
        Box::pin(async move {
            sqlx::query("UPDATE expression_assembly SET state='expired' WHERE id=$1")
                .bind(id)
                .execute(conn)
                .await?;
            Ok(())
        })
    })
    .await
    .unwrap();
    let revive = in_tx(&w.api, w.human, Some(w.agent), move |conn| {
        Box::pin(async move {
            sqlx::query("UPDATE expression_assembly SET state='ready' WHERE id=$1")
                .bind(id)
                .execute(conn)
                .await?;
            Ok(())
        })
    })
    .await;
    assert!(revive.is_err(), "an expired assembly came back");
    // The renditions keep the byte rules of 158 (no oversize large rendition, no wrong hash).
    let oversize = in_tx(&w.api, w.human, Some(w.agent), move |conn| {
        Box::pin(async move {
            sqlx::query("INSERT INTO expression_assembly(workspace_id,id,agent_member_id,requester_member_id,prompt) VALUES($1,$2,$3,$4,'p')")
                .bind(ws)
                .bind(Uuid::new_v4())
                .bind(w.agent)
                .bind(w.requester)
                .execute(&mut *conn)
                .await?;
            sqlx::query("INSERT INTO expression_assembly_image(workspace_id,assembly_id,candidate_index,motion,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) SELECT workspace_id,id,0,'bounce','large','image/gif',decode(repeat('00',1048577),'hex'),repeat('0',64),240,240,2,100 FROM expression_assembly WHERE prompt='p' AND agent_member_id=$1 LIMIT 1")
                .bind(w.agent)
                .execute(&mut *conn)
                .await?;
            Ok(())
        })
    })
    .await;
    assert!(oversize.is_err(), "a large rendition over 1 MiB was stored");
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn the_audit_row_carries_facts_and_never_the_prompt_the_picture_or_the_attachment() {
    let w = world().await;
    let ws = w.human.workspace;
    let attachment = Uuid::new_v4();
    let prompt = "비밀스러운 프롬프트-7f3a";
    let outcomes = built()[..2].to_vec();
    let motions = slot_motions();
    let kept = in_tx(&w.api, w.human, Some(w.agent), {
        let (agent, requester) = (w.agent, w.requester);
        move |conn| {
            Box::pin(async move {
                assembly::keep_in_tx(
                    conn,
                    &Keep {
                        workspace: ws,
                        agent,
                        requester,
                        prompt,
                        source_attachment_id: Some(attachment),
                        motions: &motions[..2],
                        outcomes: &outcomes,
                    },
                )
                .await
            })
        }
    })
    .await
    .unwrap()
    .unwrap();
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT detail::text, coalesce(target_type,'') FROM audit_log WHERE workspace_id=$1 AND action='expression.assembled' AND target_id=$2",
    )
    .bind(ws)
    .bind(kept.assembly_id)
    .fetch_all(&w.su)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "one audit row per kept assembly");
    let (detail, target) = &rows[0];
    assert_eq!(target, "expression_assembly");
    for secret in [prompt, &attachment.to_string(), "base64", "data:image"] {
        assert!(
            !detail.contains(secret),
            "the audit row carries {secret:?}: {detail}"
        );
    }
    // What it does carry: the assembly id, the motions and hash prefixes, nothing longer.
    assert!(detail.contains(&kept.assembly_id.to_string()));
    for candidate in &kept.candidates {
        assert!(detail.contains(&candidate.sha256[..12]));
        assert!(
            !detail.contains(&candidate.sha256),
            "the whole hash is not an audit field"
        );
    }
    // The kept pointer itself is stored, and only in the assembly's own row.
    let pointer: Option<Uuid> =
        sqlx::query_scalar("SELECT source_attachment_id FROM expression_assembly WHERE id=$1")
            .bind(kept.assembly_id)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!(pointer, Some(attachment));
    // The outbox is not written by keeping at all.
    let outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND payload::text LIKE '%' || $2 || '%'",
    )
    .bind(ws)
    .bind(kept.assembly_id.to_string())
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(outbox, 0);
}
