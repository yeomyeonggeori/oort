//! #5461 S2 (ADR-0218 증보 6 §12 L5.4·L6·L8-3, A11·A12·A13·A15·A16·A17·A29·A44-c): the decision on
//! a set card and every way a set card ends. Real PG18, **two tenants**, the decider the route really
//! is — the NOBYPASSRLS `momo_app` behind `POST …/approvals/{id}/decision` — and the worker's
//! BYPASSRLS `momo_worker` for the staging and the proposal that make the card.
//! DATABASE_URL=<dedicated DB> cargo test -p momo-server --test expression_set_decision_pg -- --ignored
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a11_a12_a17_one_decision_registers_what_was_kept_item_by_item_in_one_version` | the kept pictures register in slot order whatever the request order, with the decider as `created_by`, the agent as `proposed_by`, the approval, ONE catalogue version and one detail + one plain notice, an `expression.created` audit row each and a `expression.set.decided` row of counts, the unkept draft's bytes and words gone, the head `decided`, the result on the receipt and the card, a replay answers the first receipt | a registration column, the version call, the notice, the reclaim or the head move changes |
//! | `a11_one_stale_pin_refuses_the_whole_decision_and_spends_nothing` | a wrong hash, a wrong revision, a gray slot's made-up id, a draft of another card, an expired draft, a not-ready draft each refuse the WHOLE decision with 409 `expression_preview_stale`, register 0, leave the approval pending and the pictures as they were — and the same card then decides fine | one pin proof leaves `prove_pick`, or the verdict stops refusing as a whole |
//! | `a11_a_taken_name_and_a_full_library_skip_item_by_item_and_nothing_at_all_refuses` | a taken (even a deleted) name and a library past 1,000 skip item by item in slot order whatever the request order; nothing registering is 409 `expression_name_reserved` / `expression_quota` and the approval stays | a skip becomes a refusal or the other way round |
//! | `a13_every_end_without_a_registration_gives_back_the_bytes_the_words_and_the_head` | rejection, a late tap, the run's cancel and the draft sweep each reclaim the drafts' bytes and words, move the head `proposed → expired` with its prompt and scenes blanked, write the audit rows and free the agent's next set | an end path forgets the head or the drafts |
//! | `a29_the_sweep_retires_a_proposed_head_only_when_its_approval_is_overdue` | an open approval's head is left alone however old the staging two hours are; an overdue one is retired with its card's pictures; a decided head is never touched | the sweep's overdue condition or its `proposed` state goes |
//! | `a16_only_the_face_decides_a_set_with_a_face_and_the_policy_is_read_now` | a member who is not the face, a guest and a policy that has narrowed since each answer 403 `role_required` and spend nothing; the face decides | the role proof under the catalogue lock goes |
//! | `i1_the_choice_fields_are_judged_against_the_card_before_anything_is_read` | approving without the list, with the single field, with both, a rejection with the list, an empty list, a repeated draft and a 41st each answer their 400 and spend nothing | the presence matrix or the strict parse changes |
//! | `i2_the_decision_resolver_proves_the_owner_with_its_own_predicates` | the set another approval, a `staging` set, another agent, another requester, another room each alone refuse at the decision's resolver; the card itself resolves | one predicate of `resolve_set_owner_in_tx` goes |
//! | `i2_a_deleted_trigger_or_a_requester_who_left_does_not_stop_a_set_without_a_face` | the documented decision: the decision does not look at the trigger message or the requester's place in the room for a set nobody's face is on; a set with the requester's face is closed by the room's own gates | the decision starts judging them |
use momo_agent::actions;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx::{
    self,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_expressions::media::{Processed, Rendition};
use momo_expressions::set::{self, GrayCode, Owner, Plan, SlotKind, SlotPlan};
use momo_expressions::{self as e, ImageInfo};
use momo_server::{build_app, AppState};
use momo_workspace_actions::action_resolve::{
    resolve_action_with_origin_in_tx, ActionRejection, ArgsOrigin, CardAudience, ResolvedAction,
};
use momo_workspace_actions::team_ai::{ProposalContext, ProposalOk, ProposalRefusal, ViaAi};
use momo_workspace_actions::team_ai_set;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Once;
use uuid::Uuid;

const SECRET: &str = "expression-set-decision-5461";
const PASSWORD: &str = "expression-set-decision-pass";
const PROMPT: &str = "우리 팀 고양이 스티커를 그려 줘 (비밀 프롬프트 문장)";

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
    /// a second room alice and the agent are in
    other_channel: Uuid,
    /// alice asked `agent`
    run: Uuid,
    /// alice asked `agent` again
    run_again: Uuid,
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
            .fetch_one(&api)
            .await
            .unwrap();
    assert_eq!(
        role,
        (false, false),
        "the decider is the NOBYPASSRLS app role, not a superuser"
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

/// A person who can log in.
async fn human(su: &PgPool, ws: Uuid, person: Uuid) {
    sqlx::query(
        "INSERT INTO human(member_id,workspace_id,email,password_hash) VALUES($1,$2,$3,momo_password_hash($4))",
    )
    .bind(person)
    .bind(ws)
    .bind(format!("{person}@set-decision.test"))
    .bind(PASSWORD)
    .execute(su)
    .await
    .unwrap();
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
    .bind(format!("set-decision:{run}"))
    .execute(su)
    .await
    .unwrap();
    run
}

async fn room(su: &PgPool, ws: Uuid, creator: Uuid, who: &[Uuid]) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name, created_by) VALUES ($1, $2, 'public', $3, $4)")
        .bind(channel)
        .bind(ws)
        .bind(channel.simple().to_string())
        .bind(creator)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    for person in who {
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
            .bind(ws)
            .bind(channel)
            .bind(person)
            .execute(su)
            .await
            .unwrap();
    }
    channel
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
    let agent = member(su, ws, "agent", Some("member")).await;
    let agent2 = member(su, ws, "agent", Some("member")).await;
    for person in [alice, bob, carol, gina] {
        human(su, ws, person).await;
    }
    // the helper is a managed agent: a row of `agent` with no hosted connection, which is what the
    // decision's `hosted_action_connection_in_tx` reads as "managed"
    for helper in [agent, agent2] {
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, owner_human_id) \
             VALUES ($1, $2, 'team-ai-test', 'https://gateway.invalid/v1', 4, 50, $3)",
        )
        .bind(helper)
        .bind(ws)
        .bind(alice)
        .execute(su)
        .await
        .unwrap();
    }
    let channel = room(su, ws, alice, &[alice, bob, gina, agent, agent2]).await;
    let other_channel = room(su, ws, alice, &[alice, agent, agent2]).await;
    let run = run_of(su, ws, channel, agent, alice).await;
    let run_again = run_of(su, ws, channel, agent, alice).await;
    Tenant {
        ws,
        alice,
        bob,
        carol,
        gina,
        agent,
        agent2,
        channel,
        other_channel,
        run,
        run_again,
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
fn plan(prefix: &str, subject: Option<Uuid>) -> Plan {
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
        subject,
        prompt: PROMPT.into(),
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
async fn staged(w: &World, owner: Owner, prefix: &str, subject: Option<Uuid>) -> Uuid {
    let plan = plan(prefix, subject);
    in_worker_tx(w, owner.workspace, move |conn| {
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

/// The S5a executor's one UPDATE (the confirmation), written here by the superuser exactly as the
/// trigger allows it.
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

/// A set card a person can decide: staged, confirmed, proposed (the worker's three steps).
struct Card {
    set_id: Uuid,
    approval: Uuid,
    message: Uuid,
}

async fn card(w: &World, t: Tenant, prefix: &str, subject: Option<Uuid>) -> Card {
    let set_id = staged(w, t.owner(), prefix, subject).await;
    confirm(&w.su, set_id).await;
    let raised = propose(w, t, t.run, t.agent, set_id)
        .await
        .expect("no fault")
        .expect("the set card is raised");
    Card {
        set_id,
        approval: raised.approval_id,
        message: raised.card_message_id,
    }
}

async fn props(su: &PgPool, message: Uuid) -> Value {
    sqlx::query_scalar("SELECT props FROM message WHERE id = $1")
        .bind(message)
        .fetch_one(su)
        .await
        .unwrap()
}

/// What the person's client sends for the ready slots `indexes` of the card as the card shows them,
/// in the order named.
fn keep(card_props: &Value, indexes: &[u64]) -> Vec<Value> {
    let slots = card_props["action"]["expressionSet"]["slots"]
        .as_array()
        .expect("the card's slots");
    indexes
        .iter()
        .map(|index| {
            let slot = slots
                .iter()
                .find(|slot| slot["index"].as_u64() == Some(*index))
                .expect("a slot of the card");
            assert_eq!(slot["state"], "ready", "slot {index} is a picture");
            json!({
                "draftId": slot["draftId"],
                "revision": slot["revision"],
                "sha256": slot["media"]["large"]["sha256"],
            })
        })
        .collect()
}

async fn login(w: &World, t: Tenant, person: Uuid) -> String {
    let response = w
        .http
        .post(format!("{}/v1/auth/login", w.base))
        .json(&json!({
            "email": format!("{person}@set-decision.test"),
            "password": PASSWORD,
            "workspace": t.ws,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "login");
    response.json::<Value>().await.unwrap()["accessToken"]
        .as_str()
        .unwrap()
        .to_string()
}

/// One decision request: `choices` is `expressionChoices` as sent (`None` = the key is absent),
/// `extra` more keys of the body.
#[allow(clippy::too_many_arguments)]
async fn decide(
    w: &World,
    t: Tenant,
    token: &str,
    approval: Uuid,
    approve: bool,
    decision_id: Uuid,
    choices: Option<Value>,
    extra: Value,
) -> (u16, Value) {
    let mut body = json!({
        "approvalId": approval,
        "approve": approve,
        "clientDecisionId": decision_id,
    });
    if let Some(choices) = choices {
        body["expressionChoices"] = choices;
    }
    for (key, value) in extra.as_object().into_iter().flatten() {
        body[key] = value.clone();
    }
    let response = w
        .http
        .post(format!(
            "{}/v1/workspaces/{}/approvals/{approval}/decision",
            w.base, t.ws
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("the decision answers");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

// ---------------------------------------------------------------------------
// what the database says
// ---------------------------------------------------------------------------

async fn count(su: &PgPool, sql: &str, bind: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(su)
        .await
        .unwrap()
}

async fn catalog_version(su: &PgPool, ws: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE((SELECT version FROM expression_catalog WHERE workspace_id = $1), 0)",
    )
    .bind(ws)
    .fetch_one(su)
    .await
    .unwrap()
}

/// How many notices of a type (`expression.changed`, `expression.changed.detail`) the workspace has
/// written to the outbox.
async fn notices(su: &PgPool, ws: Uuid, kind: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND payload->'data'->>'type' = $2",
    )
    .bind(ws)
    .bind(kind)
    .fetch_one(su)
    .await
    .unwrap()
}

async fn registered(su: &PgPool, ws: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM expression WHERE workspace_id = $1",
        ws,
    )
    .await
}

async fn approval_status(su: &PgPool, approval: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM approval WHERE id = $1")
        .bind(approval)
        .fetch_one(su)
        .await
        .unwrap()
}

async fn run_status(su: &PgPool, run: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(su)
        .await
        .unwrap()
}

async fn head(su: &PgPool, set_id: Uuid) -> (String, bool, i64) {
    sqlx::query_as(
        "SELECT state, prompt IS NOT NULL, \
                (SELECT count(*) FROM expression_set_slot s WHERE s.set_id = h.id AND s.scene IS NOT NULL) \
           FROM expression_set h WHERE id = $1",
    )
    .bind(set_id)
    .fetch_one(su)
    .await
    .unwrap()
}

/// Draft pictures still held for an approval.
async fn draft_images(su: &PgPool, approval: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM expression_draft_image i JOIN expression_draft d \
           ON (d.workspace_id,d.id) = (i.workspace_id,i.draft_id) WHERE d.approval_id = $1",
        approval,
    )
    .await
}

async fn draft_states(su: &PgPool, approval: Uuid) -> Vec<(i32, String, bool)> {
    sqlx::query_as(
        "SELECT candidate_index, state, origin->>'prompt' IS NULL FROM expression_draft \
          WHERE approval_id = $1 ORDER BY candidate_index",
    )
    .bind(approval)
    .fetch_all(su)
    .await
    .unwrap()
}

async fn forge(su: &PgPool, statements: &[(&str, Vec<Uuid>)]) {
    let mut tx = su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    for (sql, binds) in statements {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
}

/// Nothing a refused decision could have written is there: nothing registered, the approval pending,
/// every picture of the card still held, the head `proposed`, the run parked, the version unmoved.
async fn assert_unspent(w: &World, t: Tenant, c: &Card, version: i64, why: &str) {
    assert_eq!(
        registered(&w.su, t.ws).await,
        0,
        "{why}: something registered"
    );
    assert_eq!(approval_status(&w.su, c.approval).await, "pending", "{why}");
    assert_eq!(
        draft_states(&w.su, c.approval)
            .await
            .iter()
            .map(|d| (d.0, d.1.as_str()))
            .collect::<Vec<_>>(),
        vec![(0, "ready"), (1, "ready"), (3, "ready")],
        "{why}: a picture was touched"
    );
    assert_eq!(
        draft_images(&w.su, c.approval).await,
        9,
        "{why}: bytes were reclaimed"
    );
    assert_eq!(head(&w.su, c.set_id).await.0, "proposed", "{why}");
    assert_eq!(run_status(&w.su, t.run).await, "awaiting_approval", "{why}");
    assert_eq!(
        catalog_version(&w.su, t.ws).await,
        version,
        "{why}: a version was spent"
    );
}

// ---------------------------------------------------------------------------
// A11 · A12 · A15 · A17
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a11_a12_a17_one_decision_registers_what_was_kept_item_by_item_in_one_version() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let c = card(&w, t, "ok", None).await;
    let card_props = props(&w.su, c.message).await;
    let version_before = catalog_version(&w.su, t.ws).await;
    let (detail_before, plain_before) = (
        notices(&w.su, t.ws, "expression.changed.detail").await,
        notices(&w.su, t.ws, "expression.changed").await,
    );
    let token = login(&w, t, t.alice).await;

    // the person keeps the moving slot and the first still — named in THAT order, not slot order —
    // and says the still is an emoji (the recommendation for 512 px would be a sticker); slot 1 is
    // left unkept, slot 2 is gray
    let mut choices = keep(&card_props, &[3, 0]);
    choices[1]["kind"] = json!("emoji");
    let decision_id = Uuid::new_v4();
    let (status, receipt) = decide(
        &w,
        t,
        &token,
        c.approval,
        true,
        decision_id,
        Some(json!(choices)),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], "approved");
    assert_eq!(receipt["result"]["actionId"], "expression.set.create");
    assert_eq!(
        receipt["result"]["ref"],
        json!({"type": "expression_set", "id": c.set_id.to_string()}),
        "the result names the set"
    );
    let set_result = &receipt["result"]["expressionSet"];
    assert_eq!(set_result["setId"], c.set_id.to_string());
    let names: Vec<&str> = set_result["registered"]
        .as_array()
        .expect("registered")
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["ok_hello", "ok_dance"],
        "slot order, whatever the request order"
    );
    assert_eq!(set_result["registered"][0]["token"], ":ok_hello:");
    assert_eq!(set_result["skipped"], json!([]));

    // A12: the registrations — the decider, the agent, the approval, ONE version
    type Row = (
        String,
        Uuid,
        Option<Uuid>,
        Option<Uuid>,
        i64,
        String,
        String,
        Uuid,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT name, created_by, proposed_by, approval_id, version, kind, status, id FROM expression \
          WHERE workspace_id = $1 ORDER BY name",
    )
    .bind(t.ws)
    .fetch_all(&w.su)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2, "two pictures were kept");
    for row in &rows {
        assert_eq!(row.1, t.alice, "created_by is the person who decided");
        assert_eq!(row.2, Some(t.agent), "proposed_by is the helper");
        assert_eq!(row.3, Some(c.approval), "the card's approval");
        assert_eq!(
            row.4,
            version_before + 1,
            "every registration carries the ONE version"
        );
        assert_eq!(row.6, "active");
    }
    assert_eq!(
        catalog_version(&w.su, t.ws).await,
        version_before + 1,
        "one version for the decision"
    );
    let kind_of = |name: &str| rows.iter().find(|row| row.0 == name).unwrap().5.clone();
    assert_eq!(
        kind_of("ok_hello"),
        "emoji",
        "the person's kind beats the recommendation"
    );
    assert_eq!(
        kind_of("ok_dance"),
        "sticker",
        "a moving picture is recommended a sticker"
    );
    // the renditions came along, byte for byte
    for row in &rows {
        let copied: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM expression_image WHERE expression_id = $1 \
                AND sha256 = encode(sha256(bytes),'hex')",
        )
        .bind(row.7)
        .fetch_one(&w.su)
        .await
        .unwrap();
        assert_eq!(copied, 3, "{}: small, large, thumb", row.0);
    }
    // one detail notice naming both ids and one plain notice: the old clients read only the second
    assert_eq!(
        notices(&w.su, t.ws, "expression.changed.detail").await,
        detail_before + 1
    );
    assert_eq!(
        notices(&w.su, t.ws, "expression.changed").await,
        plain_before + 1
    );
    let detail: Value = sqlx::query_scalar(
        "SELECT payload->'data' FROM outbox WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'expression.changed.detail' ORDER BY id DESC LIMIT 1",
    )
    .bind(t.ws)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(detail["action"], "created");
    assert_eq!(detail["version"], (version_before + 1).to_string());
    let mut ids: Vec<String> = detail["expressionIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_string())
        .collect();
    ids.sort();
    let mut expected: Vec<String> = rows.iter().map(|row| row.7.to_string()).collect();
    expected.sort();
    assert_eq!(ids, expected, "the detail names every id of the decision");

    // the drafts: the kept ones activated with their own receipt, the unkept one reclaimed
    assert_eq!(
        draft_states(&w.su, c.approval).await,
        vec![
            (0, "activated".to_string(), false),
            (1, "expired".to_string(), true),
            (3, "activated".to_string(), false)
        ],
        "A13: the unkept picture loses its words; a kept one keeps its origin"
    );
    assert_eq!(
        draft_images(&w.su, c.approval).await,
        0,
        "no bytes of this card are held any more"
    );
    let receipts: Vec<(Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT submitted_by, receipt FROM expression_draft WHERE approval_id = $1 AND state = 'activated' ORDER BY candidate_index",
    )
    .bind(c.approval)
    .fetch_all(&w.su)
    .await
    .unwrap();
    for (by, receipt) in &receipts {
        assert_eq!(*by, Some(t.alice));
        assert_eq!(
            receipt["version"],
            (version_before + 1).to_string(),
            "A17: the item's own receipt"
        );
    }
    // the head is decided and says what the set was
    let (state, keeps_prompt, scenes) = head(&w.su, c.set_id).await;
    assert_eq!(state, "decided");
    assert!(
        keeps_prompt,
        "a decided head does not blank its words (the expressions' origin has them)"
    );
    assert!(scenes > 0, "nor its scenes");
    assert_eq!(approval_status(&w.su, c.approval).await, "approved");
    assert_eq!(run_status(&w.su, t.run).await, "succeeded");

    // the audit: one `expression.created` per picture, one decision of counts, never a word or a byte
    let audits: Vec<(String, Value)> = sqlx::query_as(
        "SELECT action, detail FROM audit_log WHERE workspace_id = $1 \
            AND action IN ('expression.created','expression.set.decided') ORDER BY action, created_at",
    )
    .bind(t.ws)
    .fetch_all(&w.su)
    .await
    .unwrap();
    assert_eq!(
        audits.iter().map(|a| a.0.as_str()).collect::<Vec<_>>(),
        vec![
            "expression.created",
            "expression.created",
            "expression.set.decided"
        ]
    );
    for (action, detail) in &audits {
        let text = detail.to_string();
        for secret in [
            "비밀",
            "고양이",
            "hello",
            "thanks",
            "dance",
            "ok_",
            "base64",
            "prompt",
            "scene",
            "title",
        ] {
            assert!(
                !text.contains(secret),
                "{action} carries `{secret}`: {text}"
            );
        }
        if action == "expression.created" {
            assert_eq!(detail["set_id"], c.set_id.to_string());
            assert_eq!(detail["approval_id"], c.approval.to_string());
            assert_eq!(detail["proposed_by"], t.agent.to_string());
            assert_eq!(detail["version"], (version_before + 1).to_string());
        }
    }
    let decided = &audits[2].1;
    assert_eq!(decided["approved"], true);
    assert_eq!(decided["registered"], 2);
    assert_eq!(decided["skipped"], json!({"name_taken": 0, "quota": 0}));
    assert_eq!(decided["set_id"], c.set_id.to_string());

    // the card is settled in place with the result, and its line is numbers only
    let settled = props(&w.su, c.message).await;
    let result = &settled["result"];
    assert_eq!(result["status"], "executed");
    assert_eq!(
        result["ref"],
        json!({"type": "expression_set", "id": c.set_id.to_string()})
    );
    assert_eq!(
        result["expressionSet"], *set_result,
        "the card and the receipt carry one result"
    );
    assert_eq!(result["line"], "2개를 팀 보관함에 저장했어요");
    assert!(
        result.get("expression").is_none(),
        "a set card has no single `expression`"
    );

    // A17: the same decision id answers the first receipt, spends nothing more; a new id is a 409
    let (replay_status, replay) = decide(
        &w,
        t,
        &token,
        c.approval,
        true,
        decision_id,
        Some(json!(choices)),
        json!({}),
    )
    .await;
    assert_eq!(
        (replay_status, &replay),
        (200, &receipt),
        "A17: the same receipt, the same set of ids"
    );
    let (again_status, again) = decide(
        &w,
        t,
        &token,
        c.approval,
        true,
        Uuid::new_v4(),
        Some(json!(keep(&card_props, &[1]))),
        json!({}),
    )
    .await;
    assert_eq!(again_status, 409, "{again}");
    assert_eq!(
        registered(&w.su, t.ws).await,
        2,
        "a second decision registers nothing"
    );
    assert_eq!(catalog_version(&w.su, t.ws).await, version_before + 1);
    // the agent is free to start its next set
    let next = in_worker_tx(&w, t.ws, {
        let owner = Owner {
            run: t.run_again,
            ..t.owner()
        };
        move |conn| {
            let plan = plan("nx", None);
            Box::pin(async move { expression_error(set::begin_in_tx(conn, owner, &plan).await) })
        }
    })
    .await
    .expect("no fault");
    assert!(
        next.is_ok(),
        "a decided set no longer holds the agent's one undecided place"
    );
}

// ---------------------------------------------------------------------------
// A11: one stale pin refuses everything
// ---------------------------------------------------------------------------

fn with(list: &[Value], at: usize, key: &str, value: Value) -> Vec<Value> {
    let mut changed = list.to_vec();
    changed[at][key] = value;
    changed
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a11_one_stale_pin_refuses_the_whole_decision_and_spends_nothing() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let other = tenant(&w.su).await;
    let c = card(&w, t, "st", None).await;
    let foreign = card(&w, other, "st", None).await;
    let card_props = props(&w.su, c.message).await;
    let foreign_props = props(&w.su, foreign.message).await;
    let version = catalog_version(&w.su, t.ws).await;
    let token = login(&w, t, t.alice).await;
    let good = keep(&card_props, &[0, 1, 3]);
    let foreign_draft = keep(&foreign_props, &[0])[0]["draftId"].clone();
    let sha_of_another_slot = good[0]["sha256"].clone();

    // each forgery is ONE wrong item among two good ones: the whole decision is refused, not the item
    for (why, list) in [
        (
            "a hash that is not the stored picture's",
            with(&good, 1, "sha256", json!("0".repeat(64))),
        ),
        (
            "the hash of another slot's picture (a true hash, the wrong draft)",
            with(&good, 1, "sha256", sha_of_another_slot),
        ),
        (
            "a revision the card did not show",
            with(&good, 1, "revision", json!("2")),
        ),
        (
            "an id no draft of the card has (what a gray slot's made-up id is)",
            with(&good, 1, "draftId", json!(Uuid::new_v4().to_string())),
        ),
        (
            "another tenant's draft",
            with(&good, 1, "draftId", foreign_draft.clone()),
        ),
    ] {
        let (status, receipt) = decide(
            &w,
            t,
            &token,
            c.approval,
            true,
            Uuid::new_v4(),
            Some(json!(list)),
            json!({}),
        )
        .await;
        assert_eq!(status, 409, "{why}: {receipt}");
        assert_eq!(receipt["status"], "expression_preview_stale", "{why}");
        assert_unspent(&w, t, &c, version, why).await;
    }
    // the gray slot itself cannot be named: it has no id; the closest a client can come is a made-up one
    // (above) — and the card says so: no `draftId` on slot 2
    assert!(card_props["action"]["expressionSet"]["slots"][2]
        .get("draftId")
        .is_none());
    // a decision may not name a draft twice, even with everything else right
    let (status, receipt) = decide(
        &w,
        t,
        &token,
        c.approval,
        true,
        Uuid::new_v4(),
        Some(json!([good[0].clone(), good[0].clone()])),
        json!({}),
    )
    .await;
    assert_eq!(
        (status, receipt["status"].as_str()),
        (400, Some("expression_choice_invalid"))
    );
    assert_unspent(&w, t, &c, version, "the same draft twice").await;

    // and the approval was never spent: the same card, asked right, decides
    let (status, receipt) = decide(
        &w,
        t,
        &token,
        c.approval,
        true,
        Uuid::new_v4(),
        Some(json!(good)),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "the control: {receipt}");
    assert_eq!(registered(&w.su, t.ws).await, 3);

    // a picture that is no longer what it was when the card was drawn: an expired draft, a draft that is
    // not ready any more — each on a card of its own, because each forgery stays
    for (why, forged) in [
        (
            "an expired draft",
            "UPDATE expression_draft SET expires_at = clock_timestamp() - interval '1 minute' WHERE approval_id = $1 AND candidate_index = 1",
        ),
        (
            "a draft that is not ready any more",
            "UPDATE expression_draft SET state = 'expired' WHERE approval_id = $1 AND candidate_index = 1",
        ),
    ] {
        let t2 = tenant(&w.su).await;
        let c2 = card(&w, t2, "fg", None).await;
        let list = keep(&props(&w.su, c2.message).await, &[0, 1, 3]);
        let token2 = login(&w, t2, t2.alice).await;
        forge(&w.su, &[(forged, vec![c2.approval])]).await;
        let (status, receipt) = decide(&w, t2, &token2, c2.approval, true, Uuid::new_v4(), Some(json!(list)), json!({})).await;
        assert_eq!(status, 409, "{why}: {receipt}");
        assert_eq!(receipt["status"], "expression_preview_stale", "{why}");
        assert_eq!(registered(&w.su, t2.ws).await, 0, "{why}");
        assert_eq!(approval_status(&w.su, c2.approval).await, "pending", "{why}");
        assert_eq!(head(&w.su, c2.set_id).await.0, "proposed", "{why}");
        // the good pictures of that card were not registered either
        assert_eq!(
            count(&w.su, "SELECT count(*) FROM expression_draft WHERE approval_id = $1 AND state = 'activated'", c2.approval).await,
            0,
            "{why}"
        );
    }
}

// ---------------------------------------------------------------------------
// A11: skips are item by item
// ---------------------------------------------------------------------------

async fn name_it(su: &PgPool, t: Tenant, name: &str, status: &str) {
    sqlx::query(
        "INSERT INTO expression(workspace_id,name,display_name,tags,origin,created_by,version,status) \
         VALUES($1,$2,'taken','[]'::jsonb,'{\"kind\":\"attachment\",\"sourceUrl\":null,\"prompt\":null}'::jsonb,$3,1,$4)",
    )
    .bind(t.ws)
    .bind(name)
    .bind(t.alice)
    .bind(status)
    .execute(su)
    .await
    .unwrap();
}

/// `count` live registrations the team already has, named `fill_<n>`.
async fn fill_library(su: &PgPool, t: Tenant, count: i32) {
    sqlx::query(
        "INSERT INTO expression(workspace_id,name,display_name,tags,origin,created_by,version) \
         SELECT $1, 'fill_' || g, 'fill', '[]'::jsonb, '{\"kind\":\"attachment\",\"sourceUrl\":null,\"prompt\":null}'::jsonb, $2, 1 \
           FROM generate_series(1, $3) g",
    )
    .bind(t.ws)
    .bind(t.alice)
    .bind(count)
    .execute(su)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a11_a_taken_name_and_a_full_library_skip_item_by_item_and_nothing_at_all_refuses() {
    let w = world().await;

    // names: one taken by a live picture, one by a DELETED picture (a deleted name stays taken, D1);
    // the request names the three in reverse slot order
    let t = tenant(&w.su).await;
    let c = card(&w, t, "sk", None).await;
    name_it(&w.su, t, "sk_thanks", "active").await;
    name_it(&w.su, t, "sk_dance", "deleted").await;
    let token = login(&w, t, t.alice).await;
    let list = keep(&props(&w.su, c.message).await, &[3, 1, 0]);
    let before = catalog_version(&w.su, t.ws).await;
    let (status, receipt) = decide(
        &w,
        t,
        &token,
        c.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list)),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let result = &receipt["result"]["expressionSet"];
    assert_eq!(
        result["registered"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["name"].clone())
            .collect::<Vec<_>>(),
        vec![json!("sk_hello")],
        "the free name registers"
    );
    assert_eq!(
        result["skipped"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["name"].clone(), s["reason"].clone()))
            .collect::<Vec<_>>(),
        vec![
            (json!("sk_thanks"), json!("name_taken")),
            (json!("sk_dance"), json!("name_taken"))
        ],
        "the taken ones are skipped, in slot order, each with its reason"
    );
    assert_eq!(
        registered(&w.su, t.ws).await,
        3,
        "two that were there and one new"
    );
    assert_eq!(catalog_version(&w.su, t.ws).await, before + 1);
    assert_eq!(
        draft_states(&w.su, c.approval).await,
        vec![
            (0, "activated".to_string(), false),
            (1, "expired".to_string(), true),
            (3, "expired".to_string(), true)
        ],
        "a skipped picture is reclaimed like an unkept one"
    );
    assert_eq!(draft_images(&w.su, c.approval).await, 0);
    assert_eq!(head(&w.su, c.set_id).await.0, "decided");
    let settled = props(&w.su, c.message).await;
    assert_eq!(
        settled["result"]["line"],
        "1개를 저장하고 2개는 건너뛰었어요"
    );
    let decided: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'expression.set.decided'",
    )
    .bind(t.ws)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(decided["registered"], 1);
    assert_eq!(decided["skipped"], json!({"name_taken": 2, "quota": 0}));

    // the ceiling: 999 live and three kept — the first (slot order) takes the last place, the rest
    // are skipped as a full library, whatever order the request names them in
    let t2 = tenant(&w.su).await;
    let c2 = card(&w, t2, "qu", None).await;
    fill_library(&w.su, t2, 999).await;
    let token2 = login(&w, t2, t2.alice).await;
    let list = keep(&props(&w.su, c2.message).await, &[3, 1, 0]);
    let (status, receipt) = decide(
        &w,
        t2,
        &token2,
        c2.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list)),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let result = &receipt["result"]["expressionSet"];
    assert_eq!(
        result["registered"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["name"].clone())
            .collect::<Vec<_>>(),
        vec![json!("qu_hello")]
    );
    assert_eq!(
        result["skipped"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["name"].clone(), s["reason"].clone()))
            .collect::<Vec<_>>(),
        vec![
            (json!("qu_thanks"), json!("quota")),
            (json!("qu_dance"), json!("quota"))
        ]
    );
    assert_eq!(
        registered(&w.su, t2.ws).await,
        1000,
        "the library holds exactly its ceiling"
    );

    // nothing registers at all: a refusal that spends nothing — all names taken, a full library, both
    let t3 = tenant(&w.su).await;
    let c3 = card(&w, t3, "al", None).await;
    let version3 = catalog_version(&w.su, t3.ws).await;
    let token3 = login(&w, t3, t3.alice).await;
    let list = keep(&props(&w.su, c3.message).await, &[0, 1, 3]);
    for name in ["al_hello", "al_thanks", "al_dance"] {
        name_it(&w.su, t3, name, "active").await;
    }
    let (status, receipt) = decide(
        &w,
        t3,
        &token3,
        c3.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list.clone())),
        json!({}),
    )
    .await;
    assert_eq!(
        (status, receipt["status"].as_str()),
        (409, Some("expression_name_reserved")),
        "{receipt}"
    );
    // (the cards were not touched: the three taken rows are the only registrations)
    assert_eq!(registered(&w.su, t3.ws).await, 3);
    assert_eq!(approval_status(&w.su, c3.approval).await, "pending");
    assert_eq!(head(&w.su, c3.set_id).await.0, "proposed");
    assert_eq!(draft_images(&w.su, c3.approval).await, 9);
    assert_eq!(catalog_version(&w.su, t3.ws).await, version3);
    // a full library and no taken name: expression_quota
    forge(
        &w.su,
        &[(
            "DELETE FROM expression WHERE workspace_id = $1",
            vec![t3.ws],
        )],
    )
    .await;
    fill_library(&w.su, t3, 1000).await;
    let (status, receipt) = decide(
        &w,
        t3,
        &token3,
        c3.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list.clone())),
        json!({}),
    )
    .await;
    assert_eq!(
        (status, receipt["status"].as_str()),
        (409, Some("expression_quota")),
        "{receipt}"
    );
    assert_eq!(registered(&w.su, t3.ws).await, 1000);
    assert_eq!(approval_status(&w.su, c3.approval).await, "pending");
    assert_eq!(draft_images(&w.su, c3.approval).await, 9);
    // a taken name AND a full library: the name is what is said
    name_it(&w.su, t3, "al_hello", "active").await;
    let (status, receipt) = decide(
        &w,
        t3,
        &token3,
        c3.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list.clone())),
        json!({}),
    )
    .await;
    assert_eq!(
        (status, receipt["status"].as_str()),
        (409, Some("expression_name_reserved")),
        "{receipt}"
    );
    // and the card is still decidable when the library has room again
    forge(
        &w.su,
        &[(
            "DELETE FROM expression WHERE workspace_id = $1",
            vec![t3.ws],
        )],
    )
    .await;
    let (status, receipt) = decide(
        &w,
        t3,
        &token3,
        c3.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list)),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "the approval was never spent: {receipt}");
    assert_eq!(registered(&w.su, t3.ws).await, 3);
}

// ---------------------------------------------------------------------------
// A13: every end of a card that registers nothing gives everything back
// ---------------------------------------------------------------------------

/// What ending a set card without a registration leaves, for every path: nothing registered, every
/// picture of the card expired with its bytes and its words gone, the head `expired` with its prompt
/// and every scene blanked, no byte of the set held anywhere, one `reclaimed` audit row naming the
/// way it ended (and a `decided` row of `approved: false` only when a person said no) — and the agent's
/// next set is free to begin.
async fn assert_ended(w: &World, t: Tenant, c: &Card, why: &str, rejected: bool, path: &str) {
    assert_eq!(
        registered(&w.su, t.ws).await,
        0,
        "{path}: something registered"
    );
    assert_eq!(
        draft_states(&w.su, c.approval).await,
        vec![
            (0, "expired".to_string(), true),
            (1, "expired".to_string(), true),
            (3, "expired".to_string(), true)
        ],
        "{path}: every picture of the card is expired with its words gone"
    );
    assert_eq!(
        draft_images(&w.su, c.approval).await,
        0,
        "{path}: the drafts still hold bytes"
    );
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM expression_set_image WHERE set_id = $1",
            c.set_id
        )
        .await,
        0,
        "{path}: the set still holds bytes"
    );
    let (state, keeps_prompt, scenes) = head(&w.su, c.set_id).await;
    assert_eq!(state, "expired", "{path}: the head is left `proposed`");
    assert!(!keeps_prompt, "{path}: the head keeps the agent's prompt");
    assert_eq!(scenes, 0, "{path}: a slot keeps its scene");
    let reclaimed: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'expression.set.reclaimed' AND target_id = $2",
    )
    .bind(t.ws)
    .bind(c.set_id)
    .fetch_all(&w.su)
    .await
    .unwrap();
    assert_eq!(reclaimed.len(), 1, "{path}: one reclaim audit row");
    assert_eq!(reclaimed[0]["why"], why, "{path}");
    assert_eq!(
        reclaimed[0]["slots"], 3,
        "{path}: the three pictures the card held"
    );
    let text = reclaimed[0].to_string();
    for secret in ["비밀", "고양이", "hello", "ok_", "base64"] {
        assert!(
            !text.contains(secret),
            "{path}: the audit carries `{secret}`: {text}"
        );
    }
    let decided: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'expression.set.decided'",
    )
    .bind(t.ws)
    .fetch_all(&w.su)
    .await
    .unwrap();
    if rejected {
        assert_eq!(
            decided.len(),
            1,
            "{path}: a rejection is the set's decision too"
        );
        assert_eq!(decided[0]["approved"], false);
        assert_eq!(decided[0]["registered"], 0);
    } else {
        assert!(decided.is_empty(), "{path}: nobody decided");
    }
    // the agent may begin its next set: the one undecided place is free again
    let next = in_worker_tx(w, t.ws, {
        let owner = Owner {
            run: t.run_again,
            ..t.owner()
        };
        move |conn| {
            let plan = plan("nx", None);
            Box::pin(async move { expression_error(set::begin_in_tx(conn, owner, &plan).await) })
        }
    })
    .await
    .expect("no fault");
    assert!(
        next.is_ok(),
        "{path}: the agent's next set is still blocked: {:?}",
        next.map(|_| ())
    );
}

/// The approval's own end time, and its drafts', pushed into the past (what waiting an hour does).
async fn let_it_run_out(su: &PgPool, c: &Card) {
    forge(
        su,
        &[
            (
                "UPDATE approval SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1",
                vec![c.approval],
            ),
            (
                "UPDATE expression_draft SET expires_at = clock_timestamp() - interval '1 minute' WHERE approval_id = $1",
                vec![c.approval],
            ),
        ],
    )
    .await;
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a13_every_end_without_a_registration_gives_back_the_bytes_the_words_and_the_head() {
    let w = world().await;

    // a person says no
    let t = tenant(&w.su).await;
    let c = card(&w, t, "ok", None).await;
    let token = login(&w, t, t.alice).await;
    let (status, receipt) = decide(
        &w,
        t,
        &token,
        c.approval,
        false,
        Uuid::new_v4(),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], "rejected");
    assert_eq!(approval_status(&w.su, c.approval).await, "rejected");
    assert_ended(&w, t, &c, "rejected", true, "rejection").await;

    // a tap after the approval ran out (the decision settles it as expired)
    let t = tenant(&w.su).await;
    let c = card(&w, t, "ok", None).await;
    let token = login(&w, t, t.alice).await;
    let list = keep(&props(&w.su, c.message).await, &[0, 1, 3]);
    let_it_run_out(&w.su, &c).await;
    let (status, receipt) = decide(
        &w,
        t,
        &token,
        c.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list)),
        json!({}),
    )
    .await;
    assert_eq!(status, 409, "{receipt}");
    assert_eq!(receipt["status"], "expired");
    assert_eq!(approval_status(&w.su, c.approval).await, "expired");
    assert_ended(&w, t, &c, "expired", false, "a late tap").await;

    // the run is stopped by a person
    let t = tenant(&w.su).await;
    let c = card(&w, t, "ok", None).await;
    let token = login(&w, t, t.alice).await;
    let stopped = w
        .http
        .post(format!(
            "{}/v1/workspaces/{}/agent-runs/{}/cancel",
            w.base, t.ws, t.run
        ))
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(stopped.status(), 200, "{:?}", stopped.text().await);
    assert_eq!(approval_status(&w.su, c.approval).await, "cancelled");
    assert_ended(&w, t, &c, "cancelled", false, "the run's cancel").await;

    // nobody comes: the draft sweep finds the card's pictures past their time (the notifier's discovery
    // reads, the RLS-bound app role reclaims)
    let t = tenant(&w.su).await;
    let c = card(&w, t, "ok", None).await;
    let_it_run_out(&w.su, &c).await;
    e::sweep_expired(&w.su, &w.api).await.expect("sweep");
    assert_ended(&w, t, &c, "expired", false, "the draft sweep").await;
    // a second sweep finds nothing more to do and writes no second row
    e::sweep_expired(&w.su, &w.api).await.expect("sweep again");
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'expression.set.reclaimed'",
            t.ws
        )
        .await,
        1,
        "the end of a card is recorded once"
    );
}

// ---------------------------------------------------------------------------
// A29: the sweep's two clocks
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a29_the_sweep_retires_a_proposed_head_only_when_its_approval_is_overdue() {
    let w = world().await;
    let t = tenant(&w.su).await;
    // an open card whose head is far older than its own two hours: not the staging clock's
    let open = card(&w, t, "op", None).await;
    forge(
        &w.su,
        &[(
            "UPDATE expression_set SET created_at = clock_timestamp() - interval '400 minutes', expires_at = clock_timestamp() - interval '300 minutes' WHERE id = $1",
            vec![open.set_id],
        )],
    )
    .await;
    // the tenant must be visited: the other agent's staging set is due (the same control as S1a's A29)
    let visit_run = run_of(&w.su, t.ws, t.channel, t.agent2, t.alice).await;
    let visiting = staged(
        &w,
        Owner {
            agent: t.agent2,
            run: visit_run,
            ..t.owner()
        },
        "vv",
        None,
    )
    .await;
    forge(
        &w.su,
        &[(
            "UPDATE expression_set SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1",
            vec![visiting],
        )],
    )
    .await;
    e::sweep_expired(&w.su, &w.api).await.expect("sweep");
    assert_eq!(
        head(&w.su, visiting).await.0,
        "expired",
        "the tenant was visited: its due staging set is reclaimed"
    );
    assert_eq!(
        head(&w.su, open.set_id).await.0,
        "proposed",
        "an open approval's head is not the staging clock's, however old"
    );
    assert_eq!(
        draft_images(&w.su, open.approval).await,
        9,
        "and its pictures are still there"
    );
    assert_eq!(approval_status(&w.su, open.approval).await, "pending");

    // the approval runs out: the same sweep retires the head with the pictures
    let_it_run_out(&w.su, &open).await;
    e::sweep_expired(&w.su, &w.api).await.expect("sweep");
    assert_eq!(head(&w.su, open.set_id).await.0, "expired");
    assert_eq!(draft_images(&w.su, open.approval).await, 0);

    // a decided head is never touched, even when its approval's time is long gone
    let t2 = tenant(&w.su).await;
    let done = card(&w, t2, "dn", None).await;
    let token = login(&w, t2, t2.alice).await;
    let list = keep(&props(&w.su, done.message).await, &[0]);
    let (status, receipt) = decide(
        &w,
        t2,
        &token,
        done.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list)),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    forge(
        &w.su,
        &[
            (
                "UPDATE approval SET expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1",
                vec![done.approval],
            ),
            (
                "UPDATE expression_draft SET expires_at = clock_timestamp() - interval '1 hour' WHERE approval_id = $1 AND state = 'expired'",
                vec![done.approval],
            ),
        ],
    )
    .await;
    // visit this tenant too: a due staging set of the other agent
    let visit_run = run_of(&w.su, t2.ws, t2.channel, t2.agent2, t2.alice).await;
    let visiting = staged(
        &w,
        Owner {
            agent: t2.agent2,
            run: visit_run,
            ..t2.owner()
        },
        "vw",
        None,
    )
    .await;
    forge(
        &w.su,
        &[(
            "UPDATE expression_set SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1",
            vec![visiting],
        )],
    )
    .await;
    e::sweep_expired(&w.su, &w.api).await.expect("sweep");
    assert_eq!(
        head(&w.su, visiting).await.0,
        "expired",
        "the tenant was visited"
    );
    assert_eq!(
        head(&w.su, done.set_id).await.0,
        "decided",
        "a decided set is not a card any more"
    );
    assert_eq!(
        registered(&w.su, t2.ws).await,
        1,
        "and its registration stands"
    );
}

// ---------------------------------------------------------------------------
// A16: who decides, judged now
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a16_only_the_face_decides_a_set_with_a_face_and_the_policy_is_read_now() {
    let w = world().await;
    // a set that shows the requester's own face: only that person decides it
    let t = tenant(&w.su).await;
    let c = card(&w, t, "fc", Some(t.alice)).await;
    let list = keep(&props(&w.su, c.message).await, &[0, 1, 3]);
    let version = catalog_version(&w.su, t.ws).await;
    for (who, person, expect) in [
        ("a member of the room who is not the face", t.bob, 403),
        ("a guest of the room", t.gina, 403),
        ("a member outside the room", t.carol, 403),
    ] {
        let token = login(&w, t, person).await;
        let (status, receipt) = decide(
            &w,
            t,
            &token,
            c.approval,
            true,
            Uuid::new_v4(),
            Some(json!(list.clone())),
            json!({}),
        )
        .await;
        assert_eq!(status, expect, "{who}: {receipt}");
        assert!(
            ["role_required", "forbidden"].contains(&receipt["status"].as_str().unwrap_or("")),
            "{who}: {receipt}"
        );
        assert_unspent(&w, t, &c, version, who).await;
    }
    let token = login(&w, t, t.alice).await;
    let (status, receipt) = decide(
        &w,
        t,
        &token,
        c.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list)),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "the face decides: {receipt}");
    assert_eq!(registered(&w.su, t.ws).await, 3);
    let subjects: Vec<Option<Uuid>> =
        sqlx::query_scalar("SELECT subject_member_id FROM expression WHERE workspace_id = $1")
            .bind(t.ws)
            .fetch_all(&w.su)
            .await
            .unwrap();
    assert!(
        subjects.iter().all(|face| *face == Some(t.alice)),
        "the face travels with every registration"
    );

    // the policy narrows after the card was drawn: the decision reads it now
    let t2 = tenant(&w.su).await;
    let c2 = card(&w, t2, "po", None).await;
    let list = keep(&props(&w.su, c2.message).await, &[0, 1, 3]);
    let version2 = catalog_version(&w.su, t2.ws).await;
    sqlx::query(
        "INSERT INTO expression_catalog(workspace_id, add_policy) VALUES ($1, 'admins') \
         ON CONFLICT (workspace_id) DO UPDATE SET add_policy = 'admins'",
    )
    .bind(t2.ws)
    .execute(&w.su)
    .await
    .unwrap();
    let bob = login(&w, t2, t2.bob).await;
    let (status, receipt) = decide(
        &w,
        t2,
        &bob,
        c2.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list.clone())),
        json!({}),
    )
    .await;
    assert_eq!(
        (status, receipt["status"].as_str()),
        (403, Some("role_required")),
        "{receipt}"
    );
    assert_unspent(&w, t2, &c2, version2.max(0), "an admins-only policy").await;
    let alice = login(&w, t2, t2.alice).await;
    let (status, receipt) = decide(
        &w,
        t2,
        &alice,
        c2.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list)),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "an admin may: {receipt}");

    // and the function proves it for itself, under the catalogue lock, whoever called it (the route's gate
    // is another door to the same rule): a plain member under an admins-only policy is a `Role` refusal
    // that writes nothing
    let t3 = tenant(&w.su).await;
    let c3 = card(&w, t3, "fn", None).await;
    sqlx::query(
        "INSERT INTO expression_catalog(workspace_id, add_policy) VALUES ($1, 'admins') \
         ON CONFLICT (workspace_id) DO UPDATE SET add_policy = 'admins'",
    )
    .bind(t3.ws)
    .execute(&w.su)
    .await
    .unwrap();
    let choices =
        e::set_decision::parse_choices(&json!(keep(&props(&w.su, c3.message).await, &[0, 1, 3])))
            .expect("a list of the contract's shape");
    let by_bob = e::Actor {
        workspace: t3.ws,
        member: t3.bob,
    };
    let refused = e::transaction(&w.api, by_bob, {
        let choices = choices.clone();
        move |conn| {
            Box::pin(async move {
                e::set_decision::decide_in_tx(
                    conn,
                    by_bob,
                    c3.approval,
                    t3.agent,
                    c3.set_id,
                    None,
                    &choices,
                )
                .await
            })
        }
    })
    .await;
    assert!(
        matches!(refused, Err(e::Error::Role)),
        "{:?}",
        refused.map(|d| d.version)
    );
    assert_eq!(registered(&w.su, t3.ws).await, 0);
    assert_eq!(head(&w.su, c3.set_id).await.0, "proposed");
    assert_eq!(draft_images(&w.su, c3.approval).await, 9);
    let by_alice = e::Actor {
        workspace: t3.ws,
        member: t3.alice,
    };
    let accepted = e::transaction(&w.api, by_alice, move |conn| {
        Box::pin(async move {
            e::set_decision::decide_in_tx(
                conn,
                by_alice,
                c3.approval,
                t3.agent,
                c3.set_id,
                None,
                &choices,
            )
            .await
        })
    })
    .await
    .expect("the owner may add under an admins-only policy");
    assert_eq!(accepted.registered.len(), 3);
}

// ---------------------------------------------------------------------------
// the choice fields against the card
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn i1_the_choice_fields_are_judged_against_the_card_before_anything_is_read() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let c = card(&w, t, "mx", None).await;
    let card_props = props(&w.su, c.message).await;
    let version = catalog_version(&w.su, t.ws).await;
    let token = login(&w, t, t.alice).await;
    let good = keep(&card_props, &[0, 1, 3]);
    let single = good[0].clone();
    let item = |n: u128| json!({"draftId": Uuid::from_u128(n).to_string(), "revision": "1", "sha256": "b".repeat(64)});
    let too_many = Value::Array((1..=41).map(item).collect());
    type Case = (&'static str, bool, Option<Value>, Value, u16, &'static str);
    let cases: Vec<Case> = vec![
        (
            "approving without the list",
            true,
            None,
            json!({}),
            400,
            "expression_choice_required",
        ),
        (
            "approving with the single field instead of the list",
            true,
            None,
            json!({"expressionChoice": single}),
            400,
            "expression_choice_not_allowed",
        ),
        (
            "approving with both fields",
            true,
            Some(json!(good.clone())),
            json!({"expressionChoice": single}),
            400,
            "expression_choice_not_allowed",
        ),
        (
            "rejecting with the list",
            false,
            Some(json!(good.clone())),
            json!({}),
            400,
            "expression_choice_not_allowed",
        ),
        (
            "rejecting with the single field",
            false,
            None,
            json!({"expressionChoice": single}),
            400,
            "expression_choice_not_allowed",
        ),
        (
            "an empty list",
            true,
            Some(json!([])),
            json!({}),
            400,
            "expression_choice_invalid",
        ),
        (
            "a list that is not a list",
            true,
            Some(json!({"draftId": single["draftId"]})),
            json!({}),
            400,
            "expression_choice_invalid",
        ),
        (
            "a draft named twice",
            true,
            Some(json!([good[0].clone(), good[0].clone()])),
            json!({}),
            400,
            "expression_choice_invalid",
        ),
        (
            "a forty-first picture",
            true,
            Some(too_many),
            json!({}),
            400,
            "expression_choice_invalid",
        ),
        (
            "a key the contract does not have",
            true,
            Some(json!([with(&good, 0, "bytes", json!("x"))[0].clone()])),
            json!({}),
            400,
            "expression_choice_invalid",
        ),
        (
            "a kind outside the closed two",
            true,
            Some(json!([with(&good, 0, "kind", json!("gif"))[0].clone()])),
            json!({}),
            400,
            "expression_choice_invalid",
        ),
        (
            "a hash that is not a hash",
            true,
            Some(json!([with(&good, 0, "sha256", json!("abc"))[0].clone()])),
            json!({}),
            400,
            "expression_choice_invalid",
        ),
    ];
    for (why, approve, choices, extra, expect, code) in cases {
        let (status, receipt) = decide(
            &w,
            t,
            &token,
            c.approval,
            approve,
            Uuid::new_v4(),
            choices,
            extra,
        )
        .await;
        assert_eq!(
            (status, receipt["status"].as_str()),
            (expect, Some(code)),
            "{why}: {receipt}"
        );
        assert_unspent(&w, t, &c, version, why).await;
    }
    // a list on a card that is not a set card is `not_allowed` too: the table is read from the card
    let other = tenant(&w.su).await;
    let token_other = login(&w, other, other.alice).await;
    let invite = json!({
        "approvalId": Uuid::new_v4(), "approve": true, "clientDecisionId": Uuid::new_v4(),
        "expressionChoices": [item(1)],
    });
    let missing = w
        .http
        .post(format!(
            "{}/v1/workspaces/{}/approvals/{}/decision",
            w.base,
            other.ws,
            invite["approvalId"].as_str().unwrap()
        ))
        .bearer_auth(&token_other)
        .json(&invite)
        .send()
        .await
        .unwrap();
    assert_eq!(
        missing.status(),
        404,
        "an unknown approval is a 404 whatever it is sent"
    );
}

// ---------------------------------------------------------------------------
// I2 (the S1b review): the decision's resolver proves the owner with its own predicates
// ---------------------------------------------------------------------------

/// The decision route's re-proof of a stored set card, as the person deciding reaches it (the
/// NOBYPASSRLS `momo_app` in the tenant's transaction, the stored `payload.action.args`, **this**
/// approval's id, the run channel's audience). `resolve_set_owner_in_tx` is private to its crate;
/// this is the public door it is reached through, with the managed helper's arguments the route
/// hands over.
async fn resolve_as_decided(
    w: &World,
    t: Tenant,
    approval_id: Uuid,
    args: &Value,
) -> Result<ResolvedAction, ActionRejection> {
    let action = actions::action_by_id(actions::ACTION_EXPRESSION_SET_CREATE).expect("registered");
    let args = args.clone();
    let (agent, run) = (t.agent, t.run);
    with_tenant_tx(&w.api, t.ws, move |conn| {
        Box::pin(async move {
            resolve_action_with_origin_in_tx(
                conn,
                t.ws,
                agent,
                Some(run),
                action,
                &args,
                chrono::Utc::now().timestamp_millis(),
                ArgsOrigin::Stored,
                Some(approval_id),
                CardAudience::RunChannel,
                None,
            )
            .await
        })
    })
    .await
    .expect("no database fault")
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn i2_the_decision_resolver_proves_the_owner_with_its_own_predicates() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let c = card(&w, t, "rs", None).await;
    let payload: Value = sqlx::query_scalar("SELECT payload FROM approval WHERE id = $1")
        .bind(c.approval)
        .fetch_one(&w.su)
        .await
        .unwrap();
    let args = payload["action"]["args"].clone();
    // the control: the card as it stands resolves, to this set and nobody's face
    let control = resolve_as_decided(&w, t, c.approval, &args)
        .await
        .expect("the card resolves for its own approval");
    assert_eq!(control.pins["setId"], c.set_id.to_string());

    // each case changes ONE thing about the head (or what the decision asks of it) and says which
    // predicate of the resolver is the only one left to refuse it. The forgery is written the way a
    // BYPASSRLS writer could write it (triggers off); the head is put back after each case.
    let other_approval = Uuid::new_v4();
    struct Case {
        why: &'static str,
        forged: String,
        binds: Vec<Uuid>,
        restore: String,
        restore_binds: Vec<Uuid>,
    }
    let original = c.approval;
    let cases = vec![
        Case {
            why: "the set of ANOTHER APPROVAL (the head is proposed under a different approval)",
            forged: "UPDATE expression_set SET approval_id = $2 WHERE id = $1".into(),
            binds: vec![c.set_id, other_approval],
            restore: "UPDATE expression_set SET approval_id = $2 WHERE id = $1".into(),
            restore_binds: vec![c.set_id, original],
        },
        Case {
            why: "a set that is `staging` (never proposed: no approval at all)",
            forged: "UPDATE expression_set SET state = 'staging', approval_id = NULL WHERE id = $1"
                .into(),
            binds: vec![c.set_id],
            restore: "UPDATE expression_set SET state = 'proposed', approval_id = $2 WHERE id = $1"
                .into(),
            restore_binds: vec![c.set_id, original],
        },
        Case {
            why: "a set that is already `decided` (its approval is this one)",
            forged: "UPDATE expression_set SET state = 'decided' WHERE id = $1".into(),
            binds: vec![c.set_id],
            restore: "UPDATE expression_set SET state = 'proposed' WHERE id = $1".into(),
            restore_binds: vec![c.set_id],
        },
        Case {
            why: "ANOTHER AGENT's set",
            forged: "UPDATE expression_set SET agent_member_id = $2 WHERE id = $1".into(),
            binds: vec![c.set_id, t.agent2],
            restore: "UPDATE expression_set SET agent_member_id = $2 WHERE id = $1".into(),
            restore_binds: vec![c.set_id, t.agent],
        },
        Case {
            why: "ANOTHER REQUESTER's set (not the person who started this run)",
            forged: "UPDATE expression_set SET requester_member_id = $2 WHERE id = $1".into(),
            binds: vec![c.set_id, t.bob],
            restore: "UPDATE expression_set SET requester_member_id = $2 WHERE id = $1".into(),
            restore_binds: vec![c.set_id, t.alice],
        },
        Case {
            why: "ANOTHER ROOM's set (the head stands in a room this run is not in)",
            forged: "UPDATE expression_set SET channel_id = $2 WHERE id = $1".into(),
            binds: vec![c.set_id, t.other_channel],
            restore: "UPDATE expression_set SET channel_id = $2 WHERE id = $1".into(),
            restore_binds: vec![c.set_id, t.channel],
        },
        Case {
            why: "ANOTHER RUN's set (the same agent and person, a different request)",
            forged: "UPDATE expression_set SET run_id = $2 WHERE id = $1".into(),
            binds: vec![c.set_id, t.run_again],
            restore: "UPDATE expression_set SET run_id = $2 WHERE id = $1".into(),
            restore_binds: vec![c.set_id, t.run],
        },
    ];
    for case in cases {
        let forged: Vec<(&str, Vec<Uuid>)> = vec![(case.forged.as_str(), case.binds.clone())];
        forge(&w.su, &forged).await;
        let refused = resolve_as_decided(&w, t, c.approval, &args).await;
        assert!(
            refused.is_err(),
            "{}: the resolver let it through ({:?})",
            case.why,
            refused.map(|r| r.pins)
        );
        // put the head back; the control resolves again, so it was that one change that refused
        let restore: Vec<(&str, Vec<Uuid>)> =
            vec![(case.restore.as_str(), case.restore_binds.clone())];
        forge(&w.su, &restore).await;
        let again = resolve_as_decided(&w, t, c.approval, &args).await;
        assert!(
            again.is_ok(),
            "{}: the head was not put back: {:?}",
            case.why,
            again.map(|r| r.pins)
        );
    }
    // a set that has `expired` under this very approval (the head's prompt is blanked as an end path
    // leaves it): only the state predicate is left to refuse it
    forge(
        &w.su,
        &[(
            "UPDATE expression_set SET state = 'expired', prompt = NULL WHERE id = $1",
            vec![c.set_id],
        )],
    )
    .await;
    let refused = resolve_as_decided(&w, t, c.approval, &args).await;
    assert!(
        refused.is_err(),
        "a set that has expired under this approval resolved"
    );
}

/// The decision the S1b review asked S2 to make (I2): does the decision look at the run's trigger
/// message being deleted, or at the requester having left the room? **No** — the card is the room's,
/// and the people who may decide it are the room's members the add policy allows, not the person who
/// asked. What the room's own gates already close stays closed: a set with the requester's FACE can
/// only be decided by that person, and a person who has left the room cannot decide anything in it.
/// This test is the record of that decision: if the decision ever starts judging either, it goes red
/// and the change is deliberate.
#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn i2_a_deleted_trigger_or_a_requester_who_left_does_not_stop_a_set_without_a_face() {
    let w = world().await;
    // a set nobody's face is on: the person who asked deleted the message and left the room; another
    // member of the room decides it
    let t = tenant(&w.su).await;
    let c = card(&w, t, "gn", None).await;
    let list = keep(&props(&w.su, c.message).await, &[0, 1, 3]);
    sqlx::query(
        "UPDATE message SET deleted_at = clock_timestamp() \
          WHERE id = (SELECT trigger_message_id FROM agent_run WHERE id = $1)",
    )
    .bind(t.run)
    .execute(&w.su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE membership SET left_at = clock_timestamp() WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(t.channel)
    .bind(t.alice)
    .execute(&w.su)
    .await
    .unwrap();
    let bob = login(&w, t, t.bob).await;
    let (status, receipt) = decide(
        &w,
        t,
        &bob,
        c.approval,
        true,
        Uuid::new_v4(),
        Some(json!(list)),
        json!({}),
    )
    .await;
    assert_eq!(
        status, 200,
        "the room decides, not the one who asked: {receipt}"
    );
    assert_eq!(registered(&w.su, t.ws).await, 3);
    let created_by: Vec<Uuid> =
        sqlx::query_scalar("SELECT created_by FROM expression WHERE workspace_id = $1")
            .bind(t.ws)
            .fetch_all(&w.su)
            .await
            .unwrap();
    assert!(
        created_by.iter().all(|by| *by == t.bob),
        "the decider, not the requester, is created_by"
    );

    // a set with the requester's face: the requester left the room, so nobody can decide it — the
    // face is the one who may and they cannot pass the room's own gate; the card ends with its time
    let t2 = tenant(&w.su).await;
    let c2 = card(&w, t2, "fc", Some(t2.alice)).await;
    let list = keep(&props(&w.su, c2.message).await, &[0, 1, 3]);
    let version = catalog_version(&w.su, t2.ws).await;
    sqlx::query("UPDATE membership SET left_at = clock_timestamp() WHERE channel_id = $1 AND member_id = $2")
        .bind(t2.channel)
        .bind(t2.alice)
        .execute(&w.su)
        .await
        .unwrap();
    for (who, person) in [("the face, who left", t2.alice), ("another member", t2.bob)] {
        let token = login(&w, t2, person).await;
        let (status, receipt) = decide(
            &w,
            t2,
            &token,
            c2.approval,
            true,
            Uuid::new_v4(),
            Some(json!(list.clone())),
            json!({}),
        )
        .await;
        assert!(matches!(status, 403 | 409), "{who}: {status} {receipt}");
        assert_unspent(&w, t2, &c2, version, who).await;
    }
}
