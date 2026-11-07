//! #5460 S1b (ADR-0218 증보 6 §12 L2·L3.2·L5·L8-1·L10, A5·A6·A8·A10·A14·A15·A22·A23): the proposal
//! transaction of an emoticon set and the doors around it. Real PG18, **two tenants**, the writer
//! the worker really is — BYPASSRLS `momo_worker` — for the proposal, and the NOBYPASSRLS `momo_app`
//! for what a person reads, replaces or registers.
//! DATABASE_URL=<dedicated DB> cargo test -p momo-server --test expression_set_proposal_pg -- --ignored
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a5_a_model_naming_a_set_id_is_refused_and_a_run_with_no_human_requester_raises_nothing` | `propose_with_avatar_in_tx` (the model's door) answers `NotAllowed` for both ids with zero rows; a run whose trigger an agent wrote raises no card | `is_model_proposable_action` loses its server-raised exclusion, or the `suggestion_requester_in_tx` line goes |
//! | `a6_a_set_is_proposed_only_by_its_owner_for_the_bypassrls_writer` | agent, requester, run, tenant, state, confirmation, expiry, a still-planned slot and nothing-ready each alone refuse with the same answer and write nothing | one owner predicate leaves `lock_for_proposal_in_tx`/`hand_over_in_tx`, or the confirmation/slot proofs go |
//! | `the_proposal_moves_the_set_under_its_approval_and_the_card_says_what_is_stored` | A23 + A15 + the 「제안 본문 그림 0」: drafts copied in the database, staging emptied, head `proposed` with its approval, the helper's mark with the trigger's author, `decision_mode` open, draft expiry = the approval's, audit with ids and counts only | a copy, the head move, the mark or the audit changes |
//! | `the_two_proposal_reads_carry_their_own_owner_predicates` | `lock_for_proposal_in_tx` and `hand_over_in_tx`, called **directly** by the BYPASSRLS writer with one wrong owner part, one unconfirmed or planned state each: refused as `None`/`InvalidArguments` with nothing written (each layer proves for itself; the caller's checks cannot stand in for it) | one owner predicate or state proof leaves either function |
//! | `a10_a_card_that_cannot_be_written_leaves_no_approval_no_draft_and_no_state_change` | the whole proposal rolls back when the card write fails; the same call succeeds once the failure is lifted | a refusal is returned after the first write instead of an error |
//! | `a22_the_requester_must_be_able_to_approve_what_they_asked_for` | guest, an admins-only policy, a face that is not the requester each refuse; the owner passes | the `ExpressionAdder` arm goes back to a constant |
//! | `a8_the_set_and_plan_cards_are_not_ordinary_pending_cards` | with a set card and a plan card pending, three ordinary cards still raise and the fourth is the limit | the count's exclusion goes |
//! | `a14_a_set_draft_is_previewed_by_the_card_audience_and_replaced_or_registered_by_nobody` | preview by the channel's members only, 404 for the rest, replace refused by the function and by the route before it reads the upload, direct activation 404, the `expression.create` control still replaces | the replace allow-list goes |
use momo_agent::actions;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx::{
    self,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_expressions::media::{Processed, Rendition};
use momo_expressions::set::{self, GrayCode, Owner, Plan, SlotKind, SlotPlan};
use momo_expressions::{self as e, Actor, ImageInfo};
use momo_server::{build_app, AppState};
use momo_workspace_actions::team_ai::{self, ProposalContext, ProposalOk, ProposalRefusal, ViaAi};
use momo_workspace_actions::team_ai_set;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Once;
use uuid::Uuid;

const SECRET: &str = "expression-set-proposal-5460";
const PASSWORD: &str = "expression-set-proposal-pass";

struct World {
    su: PgPool,
    worker: PgPool,
    api: PgPool,
    base: String,
    http: reqwest::Client,
}

#[derive(Clone, Copy)]
struct Tenant {
    ws: Uuid,
    /// the owner (an admin: passes every policy); the person who asks
    alice: Uuid,
    /// a plain member of the channel
    bob: Uuid,
    /// a plain member of the workspace who is NOT in the channel
    carol: Uuid,
    /// a guest of the channel
    gina: Uuid,
    agent: Uuid,
    agent2: Uuid,
    channel: Uuid,
    /// alice asked `agent`
    run: Uuid,
    /// alice asked `agent` again
    run_again: Uuid,
    /// bob asked `agent`
    run_bob: Uuid,
    /// an agent wrote the trigger
    run_by_agent: Uuid,
}

impl Tenant {
    fn owner(&self) -> Owner {
        Owner {
            workspace: self.ws,
            agent: self.agent,
            requester: self.alice,
            run: self.run,
        }
    }
}

fn dsn(url: &str, user: &str, password: &str) -> PgConnectOptions {
    let options: PgConnectOptions = url.parse().unwrap();
    options.username(user).password(password)
}

async fn pool(url: &str, user: &str, password: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(dsn(url, user, password))
        .await
        .unwrap()
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
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    let worker = pool(&url, "momo_worker", "momo_worker_dev_pw").await;
    let api = pool(&url, "momo_app", "momo_app_dev_pw").await;
    let role: (bool, bool) =
        sqlx::query_as("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
            .fetch_one(&worker)
            .await
            .unwrap();
    assert_eq!(
        role,
        (false, true),
        "the proposer is the BYPASSRLS worker, not a superuser"
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let state = AppState::new(
        api.clone(),
        SECRET.into(),
        "ws://localhost:8000/connection/websocket".to_string(),
    );
    tokio::spawn(async move {
        axum::serve(listener, build_app(state)).await.unwrap();
    });
    World {
        su,
        worker,
        api,
        base,
        http: reqwest::Client::new(),
    }
}

async fn member(su: &PgPool, ws: Uuid, kind: &str, role: Option<&str>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,status,display_name,handle) \
         VALUES($1,$2,$3::member_kind,'active',$4,$4)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(id.to_string())
    .execute(su)
    .await
    .unwrap();
    if let Some(role) = role {
        sqlx::query(
            "INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,$3::membership_role)",
        )
        .bind(ws)
        .bind(id)
        .bind(role)
        .execute(su)
        .await
        .unwrap();
    }
    id
}

async fn message(su: &PgPool, ws: Uuid, channel: Uuid, author: Uuid) -> Uuid {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
    )
    .bind(channel)
    .fetch_one(su)
    .await
    .unwrap();
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body) \
         VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', 'x')",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .execute(su)
    .await
    .unwrap();
    id
}

async fn run_of(su: &PgPool, ws: Uuid, channel: Uuid, agent: Uuid, author: Uuid) -> Uuid {
    let trigger = message(su, ws, channel, author).await;
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status, idempotency_key) \
         VALUES ($1, $2, $3, $4, $5, 'running'::run_status, $6)",
    )
    .bind(run)
    .bind(ws)
    .bind(agent)
    .bind(channel)
    .bind(trigger)
    .bind(format!("set-proposal:{run}"))
    .execute(su)
    .await
    .unwrap();
    run
}

async fn tenant(su: &PgPool) -> Tenant {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .unwrap();
    let alice = member(su, ws, "human", Some("owner")).await;
    let bob = member(su, ws, "human", Some("member")).await;
    let carol = member(su, ws, "human", Some("member")).await;
    let gina = member(su, ws, "human", Some("guest")).await;
    // an agent is a first-class member of the workspace (the resolver's `proposer_is_live_agent_in_tx`
    // reads `workspace_membership`)
    let agent = member(su, ws, "agent", Some("member")).await;
    let agent2 = member(su, ws, "agent", Some("member")).await;
    sqlx::query(
        "INSERT INTO human(member_id,workspace_id,email,password_hash) VALUES($1,$2,$3,momo_password_hash($4))",
    )
    .bind(alice)
    .bind(ws)
    .bind(format!("{alice}@set-proposal.test"))
    .bind(PASSWORD)
    .execute(su)
    .await
    .unwrap();
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name, created_by) VALUES ($1, $2, 'public', 'general', $3)")
        .bind(channel)
        .bind(ws)
        .bind(alice)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    for who in [alice, bob, gina, agent, agent2] {
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
            .bind(ws)
            .bind(channel)
            .bind(who)
            .execute(su)
            .await
            .unwrap();
    }
    let run = run_of(su, ws, channel, agent, alice).await;
    let run_again = run_of(su, ws, channel, agent, alice).await;
    let run_bob = run_of(su, ws, channel, agent, bob).await;
    let run_by_agent = run_of(su, ws, channel, agent, agent2).await;
    Tenant {
        ws,
        alice,
        bob,
        carol,
        gina,
        agent,
        agent2,
        channel,
        run,
        run_again,
        run_bob,
        run_by_agent,
    }
}

// ---------------------------------------------------------------------------
// pictures: renditions the database accepts (its CHECKs read sizes, shapes and a true hash, not
// the picture), distinct per slot so a copy that mixed two slots up would be seen
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn rendition(seed: u8, len: usize, edge: u32, mime: &str, frames: u32) -> Rendition {
    let data: Vec<u8> = (0..len)
        .map(|n| seed.wrapping_add((n % 251) as u8))
        .collect();
    Rendition {
        info: ImageInfo {
            mime: mime.into(),
            sha256: hex(&Sha256::digest(&data)),
            bytes: len,
            width: edge,
            height: edge,
            frame_count: frames,
            duration_ms: if frames > 1 { 400 } else { 0 },
        },
        data,
    }
}

fn still_media(seed: u8) -> Processed {
    Processed {
        large: rendition(seed, 3000, 512, "image/png", 1),
        small: rendition(seed.wrapping_add(7), 900, 128, "image/png", 1),
        thumb: rendition(seed.wrapping_add(13), 700, 64, "image/png", 1),
    }
}

fn gif_media(seed: u8) -> Processed {
    Processed {
        large: rendition(seed, 5000, 480, "image/gif", 4),
        small: rendition(seed.wrapping_add(7), 2000, 128, "image/gif", 4),
        thumb: rendition(seed.wrapping_add(13), 700, 64, "image/png", 1),
    }
}

/// Slots: 0 and 1 drawn stills, 2 a still Hermes refused, 3 a GIF moving slot 0.
fn plan(prefix: &str) -> Plan {
    let slot = |index: u8, name: &str, kind: SlotKind| SlotPlan {
        index,
        name: format!("{prefix}_{name}"),
        display_name: format!("{name} 그림"),
        tags: vec!["축하".into()],
        kind,
    };
    Plan {
        title: "고양이 세트".into(),
        prefix: prefix.into(),
        subject: None,
        prompt: "우리 팀 고양이 스티커를 그려 줘 (비밀 프롬프트 문장)".into(),
        reference_attachment_ids: vec![],
        notice_shown: false,
        slots: vec![
            slot(
                0,
                "hello",
                SlotKind::Still {
                    scene: "손을 흔드는 고양이 (비밀 장면 글)".into(),
                },
            ),
            slot(
                1,
                "thanks",
                SlotKind::Still {
                    scene: "고마워하는 고양이".into(),
                },
            ),
            slot(
                2,
                "angry",
                SlotKind::Still {
                    scene: "화난 고양이".into(),
                },
            ),
            slot(
                3,
                "dance",
                SlotKind::Gif {
                    base: 0,
                    motion: "bounce".into(),
                },
            ),
        ],
    }
}

async fn in_worker_tx<T: Send + 'static>(
    w: &World,
    ws: Uuid,
    body: impl for<'c> FnOnce(
            &'c mut momo_db::PgConnection,
        ) -> futures::future::BoxFuture<'c, Result<T, DbError>>
        + Send,
) -> Result<T, DbError> {
    with_tenant_tx(&w.worker, ws, body).await
}

fn expression_error<T>(result: Result<T, e::Error>) -> Result<T, DbError> {
    result.map_err(|error| match error {
        e::Error::Db(error) => error,
        other => DbError::Sqlx(sqlx::Error::Protocol(other.to_string())),
    })
}

/// Begin and make (slots 0, 1 drawn; 2 refused; 3 moving slot 0) as the writer the worker is, and
/// leave the plan **unconfirmed**. Returns the set id.
async fn staged(w: &World, t: Tenant, owner: Owner, prefix: &str) -> Uuid {
    let plan = plan(prefix);
    in_worker_tx(w, t.ws, move |conn| {
        Box::pin(async move {
            let begun = expression_error(set::begin_in_tx(conn, owner, &plan).await)?
                .expect("begin is taken");
            let id = begun.set_id;
            for (index, media) in [(0u8, still_media(10)), (1, still_media(40))] {
                expression_error(set::put_still_in_tx(conn, owner, id, index, &media).await)?
                    .expect("a drawn still is kept");
            }
            expression_error(set::put_gray_in_tx(conn, owner, id, 2, GrayCode::Refused).await)?
                .expect("a refused slot closes gray");
            expression_error(set::put_gif_in_tx(conn, owner, id, 3, &gif_media(70)).await)?
                .expect("a moving slot is kept");
            Ok(id)
        })
    })
    .await
    .expect("staging")
}

/// [`staged`], then the confirmation: the S5a executor's one UPDATE, written here by the superuser
/// exactly as the trigger allows it.
async fn staged_and_confirmed(w: &World, t: Tenant, owner: Owner, prefix: &str) -> Uuid {
    let set_id = staged(w, t, owner, prefix).await;
    confirm(&w.su, set_id).await;
    set_id
}

async fn confirm(su: &PgPool, set_id: Uuid) {
    sqlx::query(
        "WITH t AS (SELECT clock_timestamp() AS at) \
         UPDATE expression_set h SET plan_confirmed_at = t.at, expires_at = t.at + interval '2 hours' \
           FROM t WHERE h.id = $1",
    )
    .bind(set_id)
    .execute(su)
    .await
    .expect("the confirmation is the one UPDATE the trigger allows");
}

fn context(t: Tenant, run: Uuid, agent: Uuid) -> ProposalContext {
    ProposalContext {
        workspace_id: t.ws,
        run_id: run,
        channel_id: t.channel,
        agent_member_id: agent,
        trigger_message_id: None,
        now_ms: chrono::Utc::now().timestamp_millis(),
        expires_at: chrono::Utc::now() + chrono::Duration::minutes(60),
        via: ViaAi {
            model: "team-ai-test".into(),
            latency_ms: 10,
            prompt_tokens: 1,
            completion_tokens: 1,
            tools: vec![],
            model_calls: 1,
            web_searches: 0,
        },
    }
}

async fn propose(
    w: &World,
    t: Tenant,
    run: Uuid,
    agent: Uuid,
    set_id: Uuid,
) -> Result<Result<ProposalOk, ProposalRefusal>, DbError> {
    let context = context(t, run, agent);
    in_worker_tx(w, t.ws, move |conn| {
        Box::pin(async move { team_ai_set::propose_set_in_tx(conn, &context, set_id).await })
    })
    .await
}

async fn count(su: &PgPool, sql: &str, bind: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(su)
        .await
        .unwrap()
}

async fn approvals_of(su: &PgPool, ws: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM approval WHERE workspace_id = $1",
        ws,
    )
    .await
}

async fn drafts_of(su: &PgPool, ws: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM expression_draft WHERE workspace_id = $1",
        ws,
    )
    .await
}

async fn set_state(su: &PgPool, set_id: Uuid) -> (String, Option<Uuid>, i64) {
    sqlx::query_as(
        "SELECT state, approval_id, (SELECT count(*) FROM expression_set_image i WHERE i.set_id = h.id) \
           FROM expression_set h WHERE id = $1",
    )
    .bind(set_id)
    .fetch_one(su)
    .await
    .unwrap()
}

/// Nothing a refused proposal could have written is there: no approval, no draft, the set still
/// staging with its pictures, the run still running.
async fn assert_untouched(w: &World, t: Tenant, run: Uuid, set_id: Uuid, why: &str) {
    assert_eq!(
        approvals_of(&w.su, t.ws).await,
        0,
        "{why}: an approval was written"
    );
    assert_eq!(
        drafts_of(&w.su, t.ws).await,
        0,
        "{why}: a draft was written"
    );
    let (state, approval, images) = set_state(&w.su, set_id).await;
    assert_eq!(state, "staging", "{why}");
    assert!(approval.is_none(), "{why}");
    assert_eq!(images, 9, "{why}: the staged pictures are all still there");
    let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(&w.su)
        .await
        .unwrap();
    assert_eq!(status, "running", "{why}: the run was parked");
}

// ---------------------------------------------------------------------------
// A5
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a5_a_model_naming_a_set_id_is_refused_and_a_run_with_no_human_requester_raises_nothing() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let set_id = staged_and_confirmed(&w, t, t.owner(), "ma").await;
    // the model's door, with both ids, as a model could name them
    for id in actions::SERVER_RAISED_ACTION_IDS {
        let context = context(t, t.run, t.agent);
        let refusal = in_worker_tx(&w, t.ws, move |conn| {
            Box::pin(async move {
                team_ai::propose_with_avatar_in_tx(
                    conn,
                    &context,
                    id,
                    &json!({"setId": set_id.to_string()}),
                    None,
                    None,
                )
                .await
            })
        })
        .await
        .expect("a refusal is an answer, not a fault");
        assert_eq!(
            refusal.map(|_| ()),
            Err(ProposalRefusal::NotAllowed),
            "{id}"
        );
    }
    assert_untouched(&w, t, t.run, set_id, "the model named the id").await;
    // a run an agent started has no human to ask: nothing is raised, nothing is written
    let by_agent = Tenant {
        run: t.run_by_agent,
        ..t
    };
    let refused = propose(&w, by_agent, t.run_by_agent, t.agent, set_id)
        .await
        .expect("an answer");
    assert_eq!(refused.map(|_| ()), Err(ProposalRefusal::NoHumanRequester));
    assert_untouched(&w, t, t.run, set_id, "a run no person asked").await;
}

// ---------------------------------------------------------------------------
// A6
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a6_a_set_is_proposed_only_by_its_owner_for_the_bypassrls_writer() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let other = tenant(&w.su).await;
    let set_id = staged_and_confirmed(&w, t, t.owner(), "ow").await;
    // each predicate alone: another agent, another requester, another run of the same two, a set of
    // another tenant, and an id nobody has
    let cases: Vec<(&str, Uuid, Uuid, Uuid, Tenant)> = vec![
        ("another agent", t.run, t.agent2, set_id, t),
        ("another requester", t.run_bob, t.agent, set_id, t),
        (
            "another run of the same two",
            t.run_again,
            t.agent,
            set_id,
            t,
        ),
        ("an unknown id", t.run, t.agent, Uuid::new_v4(), t),
    ];
    for (why, run, agent, id, scope) in cases {
        let refused = propose(&w, scope, run, agent, id).await.expect("an answer");
        assert_eq!(
            refused.map(|_| ()),
            Err(ProposalRefusal::InvalidArguments),
            "{why}"
        );
        assert_untouched(&w, t, t.run, set_id, why).await;
    }
    // the same set named from another tenant's transaction: the tenant's rows are not its own
    let foreign = propose(&w, other, other.run, other.agent, set_id)
        .await
        .expect("an answer");
    assert_eq!(foreign.map(|_| ()), Err(ProposalRefusal::InvalidArguments));
    assert_untouched(&w, t, t.run, set_id, "another tenant's context").await;
    assert_eq!(approvals_of(&w.su, other.ws).await, 0);

    // not confirmed, expired, a slot still planned, nothing to choose from
    let unconfirmed = {
        let t2 = tenant(&w.su).await;
        let owner = t2.owner();
        let plan = plan("un");
        let id = in_worker_tx(&w, t2.ws, move |conn| {
            Box::pin(async move {
                let begun =
                    expression_error(set::begin_in_tx(conn, owner, &plan).await)?.expect("begin");
                for (index, media) in [(0u8, still_media(10)), (1, still_media(40))] {
                    expression_error(
                        set::put_still_in_tx(conn, owner, begun.set_id, index, &media).await,
                    )?
                    .expect("kept");
                }
                expression_error(
                    set::put_gray_in_tx(conn, owner, begun.set_id, 2, GrayCode::Refused).await,
                )?
                .expect("gray");
                expression_error(
                    set::put_gif_in_tx(conn, owner, begun.set_id, 3, &gif_media(70)).await,
                )?
                .expect("kept");
                Ok(begun.set_id)
            })
        })
        .await
        .expect("staged");
        (t2, id)
    };
    let (t2, id) = unconfirmed;
    let refused = propose(&w, t2, t2.run, t2.agent, id)
        .await
        .expect("an answer");
    assert_eq!(
        refused.map(|_| ()),
        Err(ProposalRefusal::InvalidArguments),
        "nothing is proposed before 「이대로 만들기」"
    );
    assert_untouched(&w, t2, t2.run, id, "an unconfirmed plan").await;
    confirm(&w.su, id).await;
    // the two hours are over (forged by the superuser with the triggers off)
    let mut tx = w.su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE expression_set SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let refused = propose(&w, t2, t2.run, t2.agent, id)
        .await
        .expect("an answer");
    assert_eq!(
        refused.map(|_| ()),
        Err(ProposalRefusal::InvalidArguments),
        "expired"
    );
    assert_untouched(&w, t2, t2.run, id, "an expired set").await;

    // a slot still planned and a set with nothing ready (staged by hand, then confirmed)
    for (why, ready_slots) in [("a slot still planned", 1usize), ("nothing ready", 0)] {
        let t3 = tenant(&w.su).await;
        let owner = t3.owner();
        let plan = plan("pl");
        let id = in_worker_tx(&w, t3.ws, move |conn| {
            Box::pin(async move {
                let begun =
                    expression_error(set::begin_in_tx(conn, owner, &plan).await)?.expect("begin");
                if ready_slots == 1 {
                    expression_error(
                        set::put_still_in_tx(conn, owner, begun.set_id, 0, &still_media(10)).await,
                    )?
                    .expect("kept");
                } else {
                    // every slot closes gray: nothing a person could choose
                    for (index, code) in [
                        (0u8, GrayCode::Refused),
                        (1, GrayCode::Refused),
                        (2, GrayCode::Failed),
                        (3, GrayCode::BaseMissing),
                    ] {
                        expression_error(
                            set::put_gray_in_tx(conn, owner, begun.set_id, index, code).await,
                        )?
                        .expect("gray");
                    }
                }
                Ok(begun.set_id)
            })
        })
        .await
        .expect("staged");
        confirm(&w.su, id).await;
        let refused = propose(&w, t3, t3.run, t3.agent, id)
            .await
            .expect("an answer");
        assert_eq!(
            refused.map(|_| ()),
            Err(ProposalRefusal::InvalidArguments),
            "{why}"
        );
        assert_eq!(approvals_of(&w.su, t3.ws).await, 0, "{why}");
        assert_eq!(drafts_of(&w.su, t3.ws).await, 0, "{why}");
        let (state, approval, _) = set_state(&w.su, id).await;
        assert_eq!((state.as_str(), approval), ("staging", None), "{why}");
    }
}

/// Each of the two reads the proposal stands on proves the owner **in its own SQL** (T20: the writer
/// is BYPASSRLS, and a caller's earlier proof is not a door this function may lean on). Called
/// directly, with one part of the owner wrong at a time.
#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn the_two_proposal_reads_carry_their_own_owner_predicates() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let other = tenant(&w.su).await;
    let set_id = staged_and_confirmed(&w, t, t.owner(), "dr").await;
    let good = t.owner();
    let variants: Vec<(&str, Owner)> = vec![
        (
            "another agent",
            Owner {
                agent: t.agent2,
                ..good
            },
        ),
        (
            "another requester",
            Owner {
                requester: t.bob,
                ..good
            },
        ),
        (
            "another run",
            Owner {
                run: t.run_again,
                ..good
            },
        ),
        (
            "another tenant",
            Owner {
                workspace: other.ws,
                ..good
            },
        ),
    ];
    // control: the owner reads it
    let held = in_worker_tx(&w, t.ws, move |conn| {
        Box::pin(
            async move { expression_error(set::lock_for_proposal_in_tx(conn, good, set_id).await) },
        )
    })
    .await
    .expect("a read");
    assert_eq!(held.expect("the owner's confirmed set").id, set_id);
    for (why, owner) in variants {
        let scope = owner.workspace;
        // A wrong owner gets nothing back **and takes no lock on the row** (the writer bypasses RLS:
        // a lock on somebody else's set would be a lever on it). Probed from another session while
        // the call's transaction is still open.
        let probe = w.su.clone();
        let locked = in_worker_tx(&w, scope, move |conn| {
            Box::pin(async move {
                let held =
                    expression_error(set::lock_for_proposal_in_tx(conn, owner, set_id).await)?;
                let free =
                    sqlx::query("SELECT 1 FROM expression_set WHERE id = $1 FOR UPDATE NOWAIT")
                        .bind(set_id)
                        .fetch_optional(&probe)
                        .await;
                Ok((held.map(|h| h.id), free.is_ok()))
            })
        })
        .await
        .expect("a read");
        assert_eq!(locked, (None, true), "lock_for_proposal_in_tx: {why}");
        let handed = in_worker_tx(&w, scope, move |conn| {
            Box::pin(async move {
                expression_error(
                    set::hand_over_in_tx(
                        conn,
                        owner,
                        set_id,
                        Uuid::new_v4(),
                        chrono::Utc::now() + chrono::Duration::minutes(60),
                    )
                    .await,
                )
            })
        })
        .await
        .expect("a refusal is an answer");
        assert_eq!(
            handed.map(|_| ()),
            Err(set::Refusal::InvalidArguments),
            "hand_over_in_tx: {why}"
        );
    }
    assert_untouched(
        &w,
        t,
        t.run,
        set_id,
        "a wrong owner called the reads directly",
    )
    .await;
    // an unconfirmed set — every slot closed, so the only thing wrong is the missing confirmation:
    // the same refusal from both, from their own SQL
    let t2 = tenant(&w.su).await;
    let owner = t2.owner();
    let unconfirmed = staged(&w, t2, owner, "dq").await;
    let locked = in_worker_tx(&w, t2.ws, move |conn| {
        Box::pin(async move {
            expression_error(set::lock_for_proposal_in_tx(conn, owner, unconfirmed).await)
        })
    })
    .await
    .expect("a read");
    assert!(locked.is_none(), "lock_for_proposal_in_tx: not confirmed");
    let handed = in_worker_tx(&w, t2.ws, move |conn| {
        Box::pin(async move {
            expression_error(
                set::hand_over_in_tx(
                    conn,
                    owner,
                    unconfirmed,
                    Uuid::new_v4(),
                    chrono::Utc::now() + chrono::Duration::minutes(60),
                )
                .await,
            )
        })
    })
    .await
    .expect("a refusal is an answer");
    assert_eq!(
        handed.map(|_| ()),
        Err(set::Refusal::InvalidArguments),
        "hand_over_in_tx: not confirmed"
    );
    // confirmed, but a slot is still planned: `hand_over_in_tx` refuses on its own
    let t3 = tenant(&w.su).await;
    let owner = t3.owner();
    let plan = plan("dp");
    let half = in_worker_tx(&w, t3.ws, move |conn| {
        Box::pin(async move {
            let begun =
                expression_error(set::begin_in_tx(conn, owner, &plan).await)?.expect("begin");
            expression_error(
                set::put_still_in_tx(conn, owner, begun.set_id, 0, &still_media(10)).await,
            )?
            .expect("kept");
            Ok(begun.set_id)
        })
    })
    .await
    .expect("staged");
    confirm(&w.su, half).await;
    let handed = in_worker_tx(&w, t3.ws, move |conn| {
        Box::pin(async move {
            expression_error(
                set::hand_over_in_tx(
                    conn,
                    owner,
                    half,
                    Uuid::new_v4(),
                    chrono::Utc::now() + chrono::Duration::minutes(60),
                )
                .await,
            )
        })
    })
    .await
    .expect("a refusal is an answer");
    assert_eq!(
        handed.map(|_| ()),
        Err(set::Refusal::InvalidArguments),
        "hand_over_in_tx: a slot still planned"
    );
    assert_eq!(drafts_of(&w.su, t2.ws).await, 0);
    assert_eq!(drafts_of(&w.su, t3.ws).await, 0);
}

// ---------------------------------------------------------------------------
// the happy path: A23, A15, 「제안 본문 그림 0」
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn the_proposal_moves_the_set_under_its_approval_and_the_card_says_what_is_stored() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let set_id = staged_and_confirmed(&w, t, t.owner(), "ok").await;
    let staged: Vec<(i32, String, String)> = sqlx::query_as(
        "SELECT slot_index, variant, sha256 FROM expression_set_image WHERE set_id = $1 ORDER BY slot_index, variant",
    )
    .bind(set_id)
    .fetch_all(&w.su)
    .await
    .unwrap();
    assert_eq!(staged.len(), 9, "three ready slots, three renditions each");
    let stored_bytes: i64 =
        sqlx::query_scalar("SELECT stored_bytes FROM expression_set WHERE id = $1")
            .bind(set_id)
            .fetch_one(&w.su)
            .await
            .unwrap();
    let run_context = context(t, t.run, t.agent);
    let expires_at = run_context.expires_at;

    let raised = propose(&w, t, t.run, t.agent, set_id)
        .await
        .expect("no fault")
        .expect("the owner's confirmed set is proposed");
    assert_eq!(raised.requester_member_id, t.alice);

    // the head moved under the approval in one step; the staging is empty; the bytes are the record
    let (state, approval, images) = set_state(&w.su, set_id).await;
    assert_eq!(
        (state.as_str(), approval),
        ("proposed", Some(raised.approval_id))
    );
    assert_eq!(images, 0, "the staged renditions went into the drafts");
    assert_eq!(
        count(
            &w.su,
            "SELECT stored_bytes FROM expression_set WHERE id = $1",
            set_id
        )
        .await,
        stored_bytes,
        "stored_bytes only ever grows: it is the record of what was made"
    );
    let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(t.run)
        .fetch_one(&w.su)
        .await
        .unwrap();
    assert_eq!(status, "awaiting_approval");

    // the drafts: one per ready slot (0, 1, 3), by slot index, the agent's, under the approval, the
    // approval's own expiry, the set's prompt as the agent's generated origin
    let drafts: Vec<(Uuid, i32, Uuid, String, String, Value, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as(
            "SELECT id, candidate_index, creator, state, name, origin, expires_at FROM expression_draft \
              WHERE approval_id = $1 ORDER BY candidate_index",
        )
        .bind(raised.approval_id)
        .fetch_all(&w.su)
        .await
        .unwrap();
    assert_eq!(
        drafts.iter().map(|d| d.1).collect::<Vec<_>>(),
        vec![0, 1, 3],
        "the gray slot has no draft"
    );
    let approval_expires: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT expires_at FROM approval WHERE id = $1")
            .bind(raised.approval_id)
            .fetch_one(&w.su)
            .await
            .unwrap();
    for draft in &drafts {
        assert_eq!(draft.2, t.agent, "created by the agent");
        assert_eq!(draft.3, "ready");
        assert_eq!(
            draft.6, approval_expires,
            "a draft follows the approval's expiry (A23)"
        );
        assert_eq!(draft.5["kind"], "generated");
        assert_eq!(
            draft.5["prompt"],
            "우리 팀 고양이 스티커를 그려 줘 (비밀 프롬프트 문장)"
        );
    }
    assert!(
        (approval_expires - expires_at).num_milliseconds().abs() < 1000,
        "the approval's expiry is the one the caller gave"
    );
    // the copied renditions are byte-for-byte the staged ones, slot by slot
    for (index, variant, sha) in &staged {
        let draft = drafts
            .iter()
            .find(|d| d.1 == *index)
            .expect("a draft per slot");
        let copied: String = sqlx::query_scalar(
            "SELECT sha256 FROM expression_draft_image WHERE draft_id = $1 AND variant = $2 \
                AND sha256 = encode(sha256(bytes),'hex')",
        )
        .bind(draft.0)
        .bind(variant)
        .fetch_one(&w.su)
        .await
        .unwrap();
        assert_eq!(&copied, sha, "slot {index} {variant}");
    }

    // the approval and the card: the helper's mark with the trigger's author (A23), no picture key
    let payload: Value = sqlx::query_scalar("SELECT payload FROM approval WHERE id = $1")
        .bind(raised.approval_id)
        .fetch_one(&w.su)
        .await
        .unwrap();
    assert_eq!(payload["action"]["id"], "expression.set.create");
    assert_eq!(payload["via_ai"]["source"], "team_ai");
    assert_eq!(payload["via_ai"]["requester_id"], t.alice.to_string());
    assert!(
        momo_agent::actions::raised_by_team_ai(&payload),
        "the decision route reads the helper's mark with this very function"
    );
    let args = payload["action"]["args"].as_object().expect("args");
    for picture in [
        "dataBase64",
        "url",
        "attachmentId",
        "image",
        "bytes",
        "media",
        "mime",
    ] {
        assert!(!args.contains_key(picture), "args carry no `{picture}`");
    }
    assert!(
        payload.to_string().len() < 12_000,
        "the proposal body holds no picture: {} bytes",
        payload.to_string().len()
    );
    let props: Value = sqlx::query_scalar("SELECT props FROM message WHERE id = $1")
        .bind(raised.card_message_id)
        .fetch_one(&w.su)
        .await
        .unwrap();
    assert_eq!(
        props["decision_mode"], "open",
        "the card is decided in the app"
    );
    assert_eq!(props["proposed_via"]["requester_id"], t.alice.to_string());
    let card = &props["action"]["expressionSet"];
    assert_eq!(card["setId"], set_id.to_string());
    assert_eq!(card["title"], "고양이 세트");
    let slots = card["slots"].as_array().expect("slots");
    assert_eq!(slots.len(), 4);
    let states: Vec<(&str, &str)> = slots
        .iter()
        .map(|slot| {
            (
                slot["kind"].as_str().unwrap(),
                slot["state"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        states,
        vec![
            ("still", "ready"),
            ("still", "ready"),
            ("still", "gray"),
            ("gif", "ready")
        ]
    );
    assert_eq!(slots[2]["code"], "refused");
    for gray_only in ["draftId", "media", "revision"] {
        assert!(
            slots[2].get(gray_only).is_none(),
            "a gray slot has no `{gray_only}`"
        );
    }
    assert_eq!(slots[3]["media"]["large"]["mime"], "image/gif");
    assert_eq!(slots[0]["draftId"], drafts[0].0.to_string());
    // and the audit row: ids and counts, never a word of the plan or a byte
    let audit: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'expression.set.proposed'",
    )
    .bind(t.ws)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(audit["ready"], 3);
    assert_eq!(audit["gray"], json!({"refused": 1}));
    let mut keys: Vec<&str> = audit
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "approval_id",
            "gray",
            "ready",
            "references",
            "schema",
            "set_id",
            "slots",
            "stored_bytes"
        ],
        "ids and counts, nothing else (ADR §12 L8-5)"
    );
    let audit_text = audit.to_string();
    for secret in [
        "비밀",
        "고양이",
        "hello_",
        "thanks",
        "base64",
        "prompt",
        "scene",
        "title",
    ] {
        assert!(
            !audit_text.contains(secret),
            "the audit row carries `{secret}`: {audit_text}"
        );
    }
    // a second proposal of the same set finds it proposed: the same answer, nothing more written
    let again = propose(&w, t, t.run, t.agent, set_id)
        .await
        .expect("an answer");
    assert_eq!(again.map(|_| ()), Err(ProposalRefusal::InvalidArguments));
    assert_eq!(approvals_of(&w.su, t.ws).await, 1);
    assert_eq!(drafts_of(&w.su, t.ws).await, 3);
}

// ---------------------------------------------------------------------------
// A10
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a10_a_card_that_cannot_be_written_leaves_no_approval_no_draft_and_no_state_change() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let set_id = staged_and_confirmed(&w, t, t.owner(), "rb").await;
    // The card is the last write of the transaction. Make that one INSERT fail, in this tenant only.
    let trigger = format!("s1b_no_card_{}", t.ws.simple());
    sqlx::query(&format!(
        "CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
           RAISE EXCEPTION 'no approval card' USING ERRCODE = '23514'; END $$"
    ))
    .execute(&w.su)
    .await
    .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER {trigger} BEFORE INSERT ON message FOR EACH ROW \
           WHEN (NEW.workspace_id = '{}' AND NEW.type = 'approval_request') EXECUTE FUNCTION {trigger}()",
        t.ws
    ))
    .execute(&w.su)
    .await
    .unwrap();
    let failed = propose(&w, t, t.run, t.agent, set_id).await;
    assert!(
        failed.is_err(),
        "the card write failed, so the proposal is a fault, not a refusal: {failed:?}"
    );
    assert_untouched(&w, t, t.run, set_id, "the card could not be written").await;
    // the control: lift the failure and the very same call goes through
    sqlx::query(&format!("DROP TRIGGER {trigger} ON message"))
        .execute(&w.su)
        .await
        .unwrap();
    sqlx::query(&format!("DROP FUNCTION {trigger}()"))
        .execute(&w.su)
        .await
        .unwrap();
    let raised = propose(&w, t, t.run, t.agent, set_id)
        .await
        .expect("no fault")
        .expect("with the failure lifted the same set is proposed");
    assert_eq!(approvals_of(&w.su, t.ws).await, 1);
    assert_eq!(drafts_of(&w.su, t.ws).await, 3);
    assert_eq!(
        set_state(&w.su, set_id).await,
        ("proposed".to_string(), Some(raised.approval_id), 0)
    );
}

// ---------------------------------------------------------------------------
// A22
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a22_the_requester_must_be_able_to_approve_what_they_asked_for() {
    let w = world().await;
    // a guest who started the run
    let t = tenant(&w.su).await;
    let guest_run = run_of(&w.su, t.ws, t.channel, t.agent, t.gina).await;
    let guest_owner = Owner {
        requester: t.gina,
        run: guest_run,
        ..t.owner()
    };
    let set_id = staged_and_confirmed(&w, t, guest_owner, "gu").await;
    let refused = propose(&w, t, guest_run, t.agent, set_id)
        .await
        .expect("an answer");
    assert_eq!(
        refused.map(|_| ()),
        Err(ProposalRefusal::RequesterLacksRole),
        "a guest"
    );
    assert_untouched(&w, t, guest_run, set_id, "a guest asked").await;

    // an admins-only add policy and a plain member asking; then the owner asking the same way
    let t = tenant(&w.su).await;
    sqlx::query(
        "INSERT INTO expression_catalog(workspace_id, add_policy) VALUES($1, 'admins') \
         ON CONFLICT (workspace_id) DO UPDATE SET add_policy = 'admins'",
    )
    .bind(t.ws)
    .execute(&w.su)
    .await
    .unwrap();
    let bob_owner = Owner {
        requester: t.bob,
        run: t.run_bob,
        ..t.owner()
    };
    let by_member = staged_and_confirmed(&w, t, bob_owner, "ad").await;
    let refused = propose(&w, t, t.run_bob, t.agent, by_member)
        .await
        .expect("an answer");
    assert_eq!(
        refused.map(|_| ()),
        Err(ProposalRefusal::RequesterLacksRole),
        "policy: admins"
    );
    assert_untouched(
        &w,
        t,
        t.run_bob,
        by_member,
        "a plain member under an admins-only policy",
    )
    .await;
    // the same member once the policy is members again: the policy is read now, not remembered
    sqlx::query("UPDATE expression_catalog SET add_policy = 'members' WHERE workspace_id = $1")
        .bind(t.ws)
        .execute(&w.su)
        .await
        .unwrap();
    propose(&w, t, t.run_bob, t.agent, by_member)
        .await
        .expect("no fault")
        .expect("a member under a members policy");

    // a face that is not the requester (forged: the plan names bob's face while alice asked)
    let t = tenant(&w.su).await;
    let set_id = staged_and_confirmed(&w, t, t.owner(), "fa").await;
    let mut tx = w.su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE expression_set SET subject_member_id = $2 WHERE id = $1")
        .bind(set_id)
        .bind(t.bob)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let refused = propose(&w, t, t.run, t.agent, set_id)
        .await
        .expect("an answer");
    assert_eq!(
        refused.map(|_| ()),
        Err(ProposalRefusal::RequesterLacksRole),
        "another person's face is not raised through this door"
    );
    assert_untouched(&w, t, t.run, set_id, "a face that is not the requester").await;
    // the requester's own face is fine
    sqlx::query("SET session_replication_role = default")
        .execute(&w.su)
        .await
        .unwrap();
    let mut tx = w.su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE expression_set SET subject_member_id = $2 WHERE id = $1")
        .bind(set_id)
        .bind(t.alice)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    propose(&w, t, t.run, t.agent, set_id)
        .await
        .expect("no fault")
        .expect("the requester's own face (and the control: the owner passes)");
}

// ---------------------------------------------------------------------------
// A8
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a8_the_set_and_plan_cards_are_not_ordinary_pending_cards() {
    let w = world().await;
    let t = tenant(&w.su).await;
    // a set card (the real proposal) and a plan card (the shape S5a will raise: the helper's mark,
    // this requester, the plan id) are both pending for alice
    let set_id = staged_and_confirmed(&w, t, t.owner(), "ct").await;
    propose(&w, t, t.run, t.agent, set_id)
        .await
        .expect("no fault")
        .expect("the set card");
    let plan_run = run_of(&w.su, t.ws, t.channel, t.agent, t.alice).await;
    sqlx::query(
        "INSERT INTO approval(workspace_id, run_id, channel_id, requested_by, action_type, payload, status, expires_at) \
         VALUES($1, $2, $3, $4, 'workspace_action', $5, 'pending', clock_timestamp() + interval '1 hour')",
    )
    .bind(t.ws)
    .bind(plan_run)
    .bind(t.channel)
    .bind(t.agent)
    .bind(json!({
        "action": {"id": "expression.set.plan", "args": {"setId": Uuid::new_v4().to_string()}},
        "proposed_by": t.agent.to_string(),
        "via_ai": {"source": "team_ai", "requester_id": t.alice.to_string()},
    }))
    .execute(&w.su)
    .await
    .unwrap();
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM approval WHERE workspace_id = $1 AND status = 'pending' \
            AND payload->'via_ai'->>'source' = 'team_ai'",
    )
    .bind(t.ws)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(
        pending, 2,
        "control: two helper cards are pending, a set and a plan"
    );
    // three ordinary helper cards still raise (the limit is 3 per requester) and the fourth is the limit
    let mut results = Vec::new();
    for _ in 0..4 {
        let run = run_of(&w.su, t.ws, t.channel, t.agent, t.alice).await;
        let context = context(t, run, t.agent);
        let result = in_worker_tx(&w, t.ws, move |conn| {
            Box::pin(async move {
                team_ai::propose_in_tx(
                    conn,
                    &context,
                    "workspace.unfurl.update",
                    &json!({"enabled": false}),
                    None,
                )
                .await
            })
        })
        .await
        .expect("an answer");
        results.push(result.map(|_| ()));
    }
    assert_eq!(
        results,
        vec![Ok(()), Ok(()), Ok(()), Err(ProposalRefusal::TooManyPending)],
        "a set card and a plan card take none of the three ordinary places"
    );
}

// ---------------------------------------------------------------------------
// A14
// ---------------------------------------------------------------------------

async fn as_person<T: Send + 'static>(
    w: &World,
    actor: Actor,
    body: impl for<'c> FnOnce(
            &'c mut momo_db::PgConnection,
        ) -> futures::future::BoxFuture<'c, Result<T, e::Error>>
        + Send,
) -> Result<T, e::Error> {
    e::transaction(&w.api, actor, body).await
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a14_a_set_draft_is_previewed_by_the_card_audience_and_replaced_or_registered_by_nobody() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let other = tenant(&w.su).await;
    let set_id = staged_and_confirmed(&w, t, t.owner(), "pv").await;
    let raised = propose(&w, t, t.run, t.agent, set_id)
        .await
        .expect("no fault")
        .expect("the set card");
    let draft: Uuid = sqlx::query_scalar(
        "SELECT id FROM expression_draft WHERE approval_id = $1 AND candidate_index = 0",
    )
    .bind(raised.approval_id)
    .fetch_one(&w.su)
    .await
    .unwrap();
    let large_sha: String = sqlx::query_scalar(
        "SELECT sha256 FROM expression_draft_image WHERE draft_id = $1 AND variant = 'large'",
    )
    .bind(draft)
    .fetch_one(&w.su)
    .await
    .unwrap();
    let actor = |ws: Uuid, member: Uuid| Actor {
        workspace: ws,
        member,
    };

    // who may see it: the requester and any non-guest member of the card's channel; not a member of
    // the workspace who is outside the channel, not a guest, not another tenant's person
    for (who, person, ws, allowed) in [
        ("the requester", t.alice, t.ws, true),
        ("a member of the channel", t.bob, t.ws, true),
        ("a member outside the channel", t.carol, t.ws, false),
        ("a guest of the channel", t.gina, t.ws, false),
        ("another tenant's person", other.alice, other.ws, false),
    ] {
        let person_actor = actor(ws, person);
        let sha = large_sha.clone();
        let read = as_person(&w, person_actor, move |conn| {
            let sha = sha.clone();
            Box::pin(async move {
                let card = e::action::candidate_get_in_tx(conn, person_actor, draft).await?;
                let image =
                    e::action::candidate_image_in_tx(conn, person_actor, draft, "large", &sha)
                        .await?;
                Ok((card, image.info.sha256))
            })
        })
        .await;
        match (allowed, read) {
            (true, Ok((card, sha))) => {
                assert_eq!(card["draftId"], draft.to_string(), "{who}");
                assert_eq!(sha, large_sha, "{who}: the pinned stored bytes");
            }
            (false, Err(e::Error::NotFound)) => {}
            (allowed, other) => panic!("{who}: allowed={allowed}, got {:?}", other.map(|_| ())),
        }
    }
    // a pin that is not the stored picture's is the same 404
    let alice = actor(t.ws, t.alice);
    let wrong = as_person(&w, alice, move |conn| {
        Box::pin(async move {
            e::action::candidate_image_in_tx(conn, alice, draft, "large", &"0".repeat(64)).await
        })
    })
    .await;
    assert!(matches!(wrong, Err(e::Error::NotFound)));

    // replacement: refused by the function — for the requester, who could decide the card
    let media = still_media(99);
    let replaced = as_person(&w, alice, {
        let media = media.clone();
        move |conn| {
            Box::pin(
                async move { e::action::replace_candidate_in_tx(conn, alice, draft, &media).await },
            )
        }
    })
    .await;
    assert!(
        matches!(replaced, Err(e::Error::NotFound)),
        "a set's pictures are never replaced: {:?}",
        replaced.map(|r| r.approval_id)
    );
    // and by the route, before it reads the upload: garbage bytes are never decoded
    let login = w
        .http
        .post(format!("{}/v1/auth/login", w.base))
        .json(&json!({
            "email": format!("{}@set-proposal.test", t.alice),
            "password": PASSWORD,
            "workspace": t.ws,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 200);
    let token = login.json::<Value>().await.unwrap()["accessToken"]
        .as_str()
        .unwrap()
        .to_string();
    let boundary = "s1bboundary";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.png\"\r\nContent-Type: image/png\r\n\r\nthis is not a picture\r\n--{boundary}--\r\n"
    );
    let put = w
        .http
        .put(format!(
            "{}/v1/workspaces/{}/expression-drafts/{draft}/file",
            w.base, t.ws
        ))
        .bearer_auth(&token)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        put.status().as_u16(),
        404,
        "PUT …/file on a set draft is a 404 from the route's own allow-list"
    );
    // the draft is as it was
    let after: (i64, i64) = sqlx::query_as(
        "SELECT d.revision, (SELECT count(*) FROM expression_draft_image i WHERE i.draft_id = d.id) \
           FROM expression_draft d WHERE d.id = $1",
    )
    .bind(draft)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(after, (1, 3));
    // direct registration: nobody, not even the agent that made it
    for person in [t.alice, t.agent] {
        let person_actor = actor(t.ws, person);
        let choice = e::Choice {
            draft_id: draft,
            revision: "1".into(),
            sha256: large_sha.clone(),
            kind: None,
        };
        let registered = e::activate(&w.api, person_actor, choice).await;
        assert!(
            matches!(registered, Err(e::Error::NotFound)),
            "a set draft is not a direct draft: {:?}",
            registered.map(|_| ())
        );
    }
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM expression WHERE workspace_id = $1",
            t.ws
        )
        .await,
        0,
        "nothing was registered"
    );

    // the control: an `expression.create` card's draft IS replaceable (the allow-list is not a
    // blanket refusal). Seeded as the proposal of that action seeds it.
    let control_run = run_of(&w.su, t.ws, t.channel, t.agent2, t.alice).await;
    let control_media = still_media(120);
    let control_draft = in_worker_tx(&w, t.ws, {
        let (ws, channel, agent2) = (t.ws, t.channel, t.agent2);
        move |conn| {
            let control_media = control_media.clone();
            Box::pin(async move {
                let approval = momo_agent::create_pending_approval_in_tx(
                    conn,
                    ws,
                    momo_agent::NewApproval {
                        run_id: control_run,
                        channel_id: channel,
                        requested_by: agent2,
                        action_type: actions::ACTION_TYPE_WORKSPACE_ACTION.to_string(),
                        payload: actions::workspace_action_payload(
                            actions::ACTION_EXPRESSION_CREATE,
                            &json!({"drafts": []}),
                            None,
                            agent2,
                        ),
                        expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
                    },
                )
                .await?;
                let ids = vec![Uuid::new_v4()];
                expression_error(
                    e::action::insert_candidates_in_tx(
                        conn,
                        ws,
                        approval,
                        agent2,
                        chrono::Utc::now() + chrono::Duration::hours(1),
                        &ids,
                        vec![e::action::Candidate {
                            meta: e::Metadata {
                                name: "control_cat".into(),
                                display_name: "대조군".into(),
                                tags: vec![],
                                subject_member_id: None,
                            },
                            origin: e::Origin {
                                kind: "generated".into(),
                                source_url: None,
                                prompt: Some("대조군".into()),
                            },
                            source_attachment_id: None,
                            media: Some(control_media),
                            code: None,
                        }],
                    )
                    .await,
                )?;
                Ok(ids[0])
            })
        }
    })
    .await
    .expect("the control draft");
    let swapped = as_person(&w, alice, move |conn| {
        let media = media.clone();
        Box::pin(async move {
            e::action::replace_candidate_in_tx(conn, alice, control_draft, &media).await
        })
    })
    .await
    .expect("an `expression.create` card's picture is still replaceable");
    assert_eq!(swapped.draft["revision"], "2");
}
