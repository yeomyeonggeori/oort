//! #5459 S1a (ADR-0218 증보 6 §12 L3·L7·L8·L10, A6·A7·A8·A9·A13·A15·A27·A29·A37·A43): the staging of an
//! emoticon set. Real PG18, **two tenants, the actual BYPASSRLS write role `momo_worker`** (RLS hides
//! nothing from it, so every test of ownership is a test of the SQL's own predicates), the actual
//! NOBYPASSRLS `momo_app` for the decision-side verbs and the sweep, `momo_notifier` for discovery.
//! DATABASE_URL=<dedicated DB> cargo test -p momo-expressions --test set_pg -- --ignored
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a6_a_set_is_its_owners_alone_for_the_bypassrls_writer_with_no_policy_to_help` | workspace, agent, requester and run are each, alone, enough to refuse a read and a write; expired, proposed and unknown are the same answer | one predicate leaves `get_in_tx` or `lock_staging` |
//! | `begin_proves_the_run_the_requester_and_the_agent_and_a_bad_plan_writes_nothing` | the run proof, the plan shape, the 40-slot ceiling, the composite foreign key | a proof or a plan rule goes |
//! | `a7_a_slot_is_written_once_by_the_domain_functions_and_by_the_database_alone` | refusals through the functions; the triggers and the UNIQUE alone, with the function checks out of the way | the slot trigger, the image trigger or the UNIQUE goes |
//! | `a8_an_agent_has_one_undecided_set_even_when_two_begins_race` | the partial unique index (raw INSERT), the lock (two simultaneous begins), `proposed` blocks, `expired` frees | the index goes |
//! | `a9_the_cap_is_24_mib_to_the_byte_and_a_refused_write_leaves_nothing` | exact boundary, nothing written on refusal, the slot closes gray after | the cap check goes |
//! | `a27_the_plan_and_the_one_way_columns_cannot_be_changed_by_the_worker` | every plan column, state direction, bytes, approval, confirmation and expiry rules | a trigger rule goes |
//! | `a37_every_runtime_role_holds_exactly_the_verbs_of_the_adr_and_real_connections_agree` | `has_table_privilege`/`has_column_privilege` for six roles x four tables, PUBLIC, and what real connections can and cannot do | a verb is added or dropped in the block |
//! | `a43_a_notice_is_one_row_per_member_and_nothing_updates_or_deletes_it` | ON CONFLICT DO NOTHING keeps the first time; UPDATE/DELETE refused by privilege and by trigger | the notice trigger or the privileges go |
//! | `a13_every_staging_end_path_leaves_no_pixels_no_prompt_and_no_scene` | `abandon` and the sweep: renditions 0, head `expired`, prompt and scenes NULL, audit rows carry no text | a reclaim step goes |
//! | `a29_the_sweep_touches_staging_only_and_the_confirmation_restarts_the_two_hours` | proposed untouched past its time, due staging reclaimed, a late confirmation keeps making alive | the `staging` condition or the expiry rule goes |
//! | `renditions_round_trip_and_the_gif_base_is_the_stored_large_still` | real decoder output stored whole, kinds checked, `base_large_in_tx` | a kind check or the base join goes |
//! | `the_deferred_rule_an_expired_set_keeps_no_scene_holds_at_commit` | the DB refuses a commit that expires a head and leaves a scene | the constraint trigger goes |
use futures::future::BoxFuture;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx::{
    self,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use momo_db::{PgConnection, PgPool};
use momo_expressions::set::{
    self, GrayCode, Owner, Plan, Refusal, SlotKind, SlotPlan, MAX_STORED_BYTES,
};
use momo_expressions::{self as e, Error};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::sync::Once;
use uuid::Uuid;

struct World {
    su: PgPool,
    worker: PgPool,
    api: PgPool,
    notifier: PgPool,
    relay: PgPool,
    a: Tenant,
    b: Tenant,
}

/// One tenant: two people, two agents, a conversation, and the runs people started.
#[derive(Clone, Copy)]
struct Tenant {
    ws: Uuid,
    alice: Uuid,
    bob: Uuid,
    agent: Uuid,
    agent2: Uuid,
    channel: Uuid,
    /// alice asked `agent` (the run a set is begun in)
    run: Uuid,
    /// alice asked `agent` again (a second valid run of the same person and agent)
    run_again: Uuid,
    /// bob asked `agent`
    run_bob: Uuid,
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
    let notifier = pool(&url, "momo_notifier", "momo_notifier_dev_pw").await;
    let relay = pool(&url, "momo_relay", "momo_relay_dev_pw").await;
    let role: (bool, bool) =
        sqlx::query_as("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
            .fetch_one(&worker)
            .await
            .unwrap();
    assert_eq!(
        role,
        (false, true),
        "the writer is the BYPASSRLS worker, not a superuser"
    );
    let a = tenant(&su).await;
    let b = tenant(&su).await;
    World {
        su,
        worker,
        api,
        notifier,
        relay,
        a,
        b,
    }
}

async fn member(su: &PgPool, ws: Uuid, kind: &str) -> Uuid {
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
    .bind(format!("set-pg:{run}"))
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
    let alice = member(su, ws, "human").await;
    let bob = member(su, ws, "human").await;
    let agent = member(su, ws, "agent").await;
    let agent2 = member(su, ws, "agent").await;
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
    for who in [alice, bob, agent, agent2] {
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
    Tenant {
        ws,
        alice,
        bob,
        agent,
        agent2,
        channel,
        run,
        run_again,
        run_bob,
    }
}

/// A tenant transaction on `pool` (the GUC bound as every domain path binds it).
async fn in_tx<T: Send + 'static>(
    pool: &PgPool,
    ws: Uuid,
    body: impl for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, Error>> + Send,
) -> Result<T, Error> {
    momo_db::with_tenant_tx_prelude(
        pool,
        ws,
        |_| Box::pin(async { Ok::<_, Error>(()) }),
        |_| Box::pin(async { Ok(()) }),
        body,
    )
    .await
}

fn db_code(error: &sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(db) => db.code().map(|c| c.to_string()).unwrap_or_default(),
        other => format!("not a database error: {other}"),
    }
}

/// Run `sql` on `pool` and return the SQLSTATE it failed with (the test fails if it succeeded).
async fn fails_with(pool: &PgPool, sql: &str) -> String {
    match sqlx::query(sql).execute(pool).await {
        Ok(done) => panic!(
            "`{sql}` should have been refused, but changed {} rows",
            done.rows_affected()
        ),
        Err(error) => db_code(&error),
    }
}

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
        prompt: "우리 팀 고양이 캐릭터 스티커를 그려 줘 (비밀 프롬프트 문장)".into(),
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
                "bounce",
                SlotKind::Gif {
                    base: 0,
                    motion: "bounce".into(),
                },
            ),
        ],
    }
}

fn stills(n: usize, prefix: &str) -> Plan {
    let mut p = plan(prefix);
    p.slots = (0..n)
        .map(|i| SlotPlan {
            index: i as u8,
            name: format!("{prefix}_s{i}"),
            display_name: format!("s{i}"),
            tags: vec![],
            kind: SlotKind::Still {
                scene: format!("scene {i}"),
            },
        })
        .collect();
    p
}

async fn begin_as(w: &World, owner: Owner, p: Plan) -> Result<Result<set::Begun, Refusal>, Error> {
    in_tx(&w.worker, owner.workspace, move |conn| {
        Box::pin(async move { set::begin_in_tx(conn, owner, &p).await })
    })
    .await
}

async fn begin(w: &World, t: Tenant, p: Plan) -> Result<Result<set::Begun, Refusal>, Error> {
    begin_as(w, t.owner(), p).await
}

async fn begun(w: &World, t: Tenant, p: Plan) -> Uuid {
    begin(w, t, p).await.unwrap().expect("begin").set_id
}

async fn get(w: &World, owner: Owner, id: Uuid) -> Option<set::Held> {
    in_tx(&w.worker, owner.workspace, move |conn| {
        Box::pin(async move { set::get_in_tx(conn, owner, id).await })
    })
    .await
    .unwrap()
}

type Wrote = Result<Result<set::Stored, Refusal>, Error>;

async fn gray(w: &World, owner: Owner, id: Uuid, index: u8, code: GrayCode) -> Wrote {
    in_tx(&w.worker, owner.workspace, move |conn| {
        Box::pin(async move { set::put_gray_in_tx(conn, owner, id, index, code).await })
    })
    .await
}

async fn still(w: &World, owner: Owner, id: Uuid, index: u8, media: e::media::Processed) -> Wrote {
    in_tx(&w.worker, owner.workspace, move |conn| {
        Box::pin(async move { set::put_still_in_tx(conn, owner, id, index, &media).await })
    })
    .await
}

async fn abandon(
    w: &World,
    owner: Owner,
    id: Uuid,
) -> Result<Result<set::Reclaimed, Refusal>, Error> {
    in_tx(&w.worker, owner.workspace, move |conn| {
        Box::pin(async move { set::abandon_in_tx(conn, owner, id).await })
    })
    .await
}

fn decoded_still() -> e::media::Processed {
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(8, 4)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    e::media::decode(
        &png.into_inner(),
        std::time::Instant::now() + std::time::Duration::from_secs(10),
    )
    .unwrap()
}

fn decoded_gif() -> e::media::Processed {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(&mut bytes, 30);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for n in 0..4u8 {
            encoder
                .encode_frame(image::Frame::from_parts(
                    image::RgbaImage::from_pixel(8, 8, image::Rgba([20 + n * 40, 200, 50, 255])),
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(80, 1),
                ))
                .unwrap();
        }
    }
    let processed = e::media::decode(
        &bytes,
        std::time::Instant::now() + std::time::Duration::from_secs(10),
    )
    .unwrap();
    assert!(
        processed.large.info.frame_count > 1,
        "control: this picture moves"
    );
    processed
}

/// A rendition of exactly `len` bytes the database accepts (its hash is true; the bytes are not a
/// real picture, which no CHECK looks into). For the byte-exact cap test only.
fn fabricated(len: usize, edge: u32) -> e::media::Rendition {
    let data = vec![0x5a_u8; len];
    e::media::Rendition {
        info: e::ImageInfo {
            mime: "image/png".into(),
            sha256: hex::encode(Sha256::digest(&data)),
            bytes: len,
            width: edge,
            height: edge,
            frame_count: 1,
            duration_ms: 0,
        },
        data,
    }
}

/// The largest slot the CHECKs allow: 1 MiB + 256 KiB + 256 KiB = 1.5 MiB.
fn fat_slot() -> e::media::Processed {
    e::media::Processed {
        large: fabricated(1_048_576, 512),
        small: fabricated(262_144, 128),
        thumb: fabricated(262_144, 128),
    }
}

async fn count(su: &PgPool, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(su)
        .await
        .unwrap()
}

async fn images_of(su: &PgPool, id: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM expression_set_image WHERE set_id = $1",
        id,
    )
    .await
}

/// Superuser, triggers and foreign keys off for this transaction only (`session_replication_role`):
/// to forge a row the functions would never write, or to put a clock in the past.
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

async fn backdate(su: &PgPool, id: Uuid, minutes: i32) {
    let mut tx = su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE expression_set SET created_at = created_at - make_interval(mins => $2), expires_at = expires_at - make_interval(mins => $2) WHERE id = $1")
        .bind(id)
        .bind(minutes)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

/// A staging head with chosen owner fields, written around every trigger and foreign key, so the
/// owner predicates of the functions are the only thing standing (the run proof is also made to pass
/// for the `Owner` the test then presents).
async fn forged_head(
    su: &PgPool,
    ws: Uuid,
    agent: Uuid,
    requester: Uuid,
    run: Uuid,
    channel: Uuid,
) -> Uuid {
    let id = Uuid::new_v4();
    let mut tx = su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO expression_set(workspace_id,id,agent_member_id,requester_member_id,run_id,channel_id,title,prefix,backend,prompt) \
         VALUES($1,$2,$3,$4,$5,$6,'forged','forge','hermes','forged prompt')",
    )
    .bind(ws)
    .bind(id)
    .bind(agent)
    .bind(requester)
    .bind(run)
    .bind(channel)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO expression_set_slot(workspace_id,set_id,slot_index,kind,name,display_name,tags,scene) \
         VALUES($1,$2,0,'still','forge_one','one','[]','scene')",
    )
    .bind(ws)
    .bind(id)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

/// The SQLSTATE `momo_app` gets for `sql` inside a tenant transaction (the GUC bound, as every real
/// path binds it: without it the policy's cast fails before the privilege is even looked at).
async fn app_fails(w: &World, ws: Uuid, sql: &str) -> String {
    let mut tx = w.api.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    match sqlx::query(sql).execute(&mut *tx).await {
        Ok(done) => panic!(
            "`{sql}` should have been refused for momo_app, but changed {} rows",
            done.rows_affected()
        ),
        Err(error) => db_code(&error),
    }
}

async fn slot_state(su: &PgPool, id: Uuid, index: i32) -> (String, Option<String>) {
    let row = sqlx::query(
        "SELECT state, code FROM expression_set_slot WHERE set_id = $1 AND slot_index = $2",
    )
    .bind(id)
    .bind(index)
    .fetch_one(su)
    .await
    .unwrap();
    (row.get("state"), row.get("code"))
}

// ---------------------------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a6_a_set_is_its_owners_alone_for_the_bypassrls_writer_with_no_policy_to_help() {
    let w = world().await;
    let (a, b) = (w.a, w.b);
    let id = begun(&w, a, plan("six")).await;
    // the owner reads it back: the control
    assert_eq!(
        get(&w, a.owner(), id).await.expect("the owner").slots.len(),
        3
    );

    // Four forged heads, each different from the Owner presented in exactly ONE of workspace, agent,
    // requester and run. The Owner is a fully valid (agent, alice, run) of a tenant, so the run proof
    // passes and only the head's own predicates can refuse. Each case has a tenant of its own (a second
    // staging head of the same agent could not exist beside a real one: that is the partial index).
    // The `workspace` case hosts the forged head in ANOTHER tenant while it carries this tenant's
    // member and run ids (foreign keys are off while forging): only `workspace_id` differs.
    let mut cases: Vec<(&str, Owner, Uuid)> = vec![];
    let host = tenant(&w.su).await;
    let x = tenant(&w.su).await;
    cases.push((
        "workspace",
        x.owner(),
        forged_head(&w.su, host.ws, x.agent, x.alice, x.run, x.channel).await,
    ));
    let x = tenant(&w.su).await;
    cases.push((
        "agent",
        x.owner(),
        forged_head(&w.su, x.ws, x.agent2, x.alice, x.run, x.channel).await,
    ));
    let x = tenant(&w.su).await;
    cases.push((
        "requester",
        x.owner(),
        forged_head(&w.su, x.ws, x.agent, x.bob, x.run, x.channel).await,
    ));
    let x = tenant(&w.su).await;
    cases.push((
        "run",
        x.owner(),
        forged_head(&w.su, x.ws, x.agent, x.alice, x.run_again, x.channel).await,
    ));
    for (which, owner, forged) in &cases {
        let owner = *owner;
        // the head and slot exist and are staging: nothing but the owner predicates refuses
        assert_eq!(
            count(
                &w.su,
                "SELECT count(*) FROM expression_set WHERE id = $1 AND state = 'staging'",
                *forged
            )
            .await,
            1,
            "{which}: control"
        );
        assert!(
            get(&w, owner, *forged).await.is_none(),
            "{which}: a read by the wrong {which} answers None"
        );
        let wrote = gray(&w, owner, *forged, 0, GrayCode::Failed).await.unwrap();
        assert_eq!(
            wrote,
            Err(Refusal::InvalidArguments),
            "{which}: a write by the wrong {which} is refused"
        );
        assert_eq!(
            slot_state(&w.su, *forged, 0).await.0,
            "planned",
            "{which}: the slot was not touched"
        );
        let gone = abandon(&w, owner, *forged).await.unwrap();
        assert_eq!(
            gone,
            Err(Refusal::InvalidArguments),
            "{which}: nor can it be abandoned"
        );
        assert_eq!(
            count(
                &w.su,
                "SELECT count(*) FROM expression_set WHERE id = $1 AND state = 'staging'",
                *forged
            )
            .await,
            1,
            "{which}: and it is still staging"
        );
    }
    let owner = a.owner();

    // Foreign, unknown, expired and proposed are the same answer as each other.
    let unknown = Uuid::new_v4();
    assert!(get(&w, owner, unknown).await.is_none());
    assert_eq!(
        gray(&w, owner, unknown, 0, GrayCode::Failed).await.unwrap(),
        Err(Refusal::InvalidArguments)
    );
    // tenant B's own owner cannot reach tenant A's set (a real tenant's real owner, not a forged one)
    assert!(get(&w, b.owner(), id).await.is_none());
    assert_eq!(
        gray(&w, b.owner(), id, 0, GrayCode::Failed).await.unwrap(),
        Err(Refusal::InvalidArguments)
    );
    assert_eq!(slot_state(&w.su, id, 0).await.0, "planned");

    // expired (its two hours are up but the sweep has not run) and proposed (card up) both refuse writes
    backdate(&w.su, id, 125).await;
    assert_eq!(
        gray(&w, owner, id, 0, GrayCode::Failed).await.unwrap(),
        Err(Refusal::InvalidArguments),
        "expired"
    );
    assert!(
        get(&w, owner, id).await.is_some(),
        "an expired but unswept set is still its owner's to read"
    );
    let proposed = begun(&w, b, plan("prop")).await;
    forge(
        &w.su,
        &[(
            "UPDATE expression_set SET state = 'proposed', approval_id = $2 WHERE id = $1",
            vec![proposed, Uuid::new_v4()],
        )],
    )
    .await;
    assert_eq!(
        gray(&w, b.owner(), proposed, 0, GrayCode::Failed)
            .await
            .unwrap(),
        Err(Refusal::InvalidArguments),
        "proposed"
    );
    assert_eq!(
        abandon(&w, b.owner(), proposed).await.unwrap(),
        Err(Refusal::InvalidArguments),
        "a proposed set is not abandon's"
    );
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn begin_proves_the_run_the_requester_and_the_agent_and_a_bad_plan_writes_nothing() {
    let w = world().await;
    let (a, b) = (w.a, w.b);
    let sets_of = |t: Tenant| {
        let su = w.su.clone();
        async move {
            count(
                &su,
                "SELECT count(*) FROM expression_set WHERE workspace_id = $1",
                t.ws,
            )
            .await
        }
    };
    let refused =
        |r: Result<Result<set::Begun, Refusal>, Error>| r.unwrap().expect_err("should be refused");

    // the run is another agent's / the requester did not ask / the run is another run's person
    let mut owner = a.owner();
    owner.agent = a.agent2;
    assert_eq!(
        refused(
            in_tx(&w.worker, a.ws, move |c| Box::pin(async move {
                set::begin_in_tx(c, owner, &plan("one")).await
            }))
            .await
        ),
        Refusal::InvalidArguments
    );
    let mut owner = a.owner();
    owner.requester = a.bob;
    assert_eq!(
        refused(
            in_tx(&w.worker, a.ws, move |c| Box::pin(async move {
                set::begin_in_tx(c, owner, &plan("two")).await
            }))
            .await
        ),
        Refusal::InvalidArguments
    );
    // a run of another tenant presented under this tenant's workspace
    let mut owner = a.owner();
    owner.run = b.run;
    assert_eq!(
        refused(
            in_tx(&w.worker, a.ws, move |c| Box::pin(async move {
                set::begin_in_tx(c, owner, &plan("thr")).await
            }))
            .await
        ),
        Refusal::InvalidArguments
    );
    assert_eq!(sets_of(a).await, 0, "no refusal left a row behind");

    // the run is over / the trigger was deleted / the person left the conversation / the author is an agent
    for (label, sql) in [
        ("run over", "UPDATE agent_run SET status = 'cancelled'::run_status WHERE id = $1"),
        ("trigger deleted", "UPDATE message SET deleted_at = now() WHERE id = (SELECT trigger_message_id FROM agent_run WHERE id = $1)"),
        ("left the room", "UPDATE membership SET left_at = now() WHERE channel_id = (SELECT channel_id FROM agent_run WHERE id = $1) AND member_id = (SELECT author_member_id FROM message WHERE id = (SELECT trigger_message_id FROM agent_run WHERE id = $1))"),
    ] {
        let t = tenant(&w.su).await;
        sqlx::query(sql).bind(t.run).execute(&w.su).await.unwrap();
        assert_eq!(refused(begin(&w, t, plan("four")).await), Refusal::InvalidArguments, "{label}");
        assert_eq!(sets_of(t).await, 0, "{label}");
    }
    let t = tenant(&w.su).await;
    let by_agent = run_of(&w.su, t.ws, t.channel, t.agent, t.agent2).await; // trigger written by an agent
    let mut owner = t.owner();
    owner.run = by_agent;
    owner.requester = t.agent2;
    assert_eq!(
        refused(
            in_tx(&w.worker, t.ws, move |c| Box::pin(async move {
                set::begin_in_tx(c, owner, &plan("five")).await
            }))
            .await
        ),
        Refusal::InvalidArguments,
        "an agent is never the requester"
    );

    // plans the server does not take, each from a good plan changed in one place
    let t = tenant(&w.su).await;
    let bad: Vec<(&str, Box<dyn Fn(&mut Plan)>)> = vec![
        ("prefix too short", Box::new(|p| p.prefix = "a".into())),
        ("prefix upper case", Box::new(|p| p.prefix = "Cat".into())),
        (
            "name without the prefix",
            Box::new(|p| p.slots[0].name = "other_hello".into()),
        ),
        (
            "name is only the prefix",
            Box::new(|p| p.slots[0].name = format!("{}_", p.prefix)),
        ),
        (
            "duplicate name",
            Box::new(|p| p.slots[1].name = p.slots[0].name.clone()),
        ),
        ("duplicate index", Box::new(|p| p.slots[1].index = 0)),
        ("index past 39", Box::new(|p| p.slots[1].index = 40)),
        (
            "gif without a still base",
            Box::new(|p| {
                p.slots[2].kind = SlotKind::Gif {
                    base: 2,
                    motion: "bounce".into(),
                }
            }),
        ),
        (
            "gif base is a gif",
            Box::new(|p| {
                p.slots.push(SlotPlan {
                    index: 3,
                    name: format!("{}_g2", p.prefix),
                    display_name: "g".into(),
                    tags: vec![],
                    kind: SlotKind::Gif {
                        base: 2,
                        motion: "pulse".into(),
                    },
                })
            }),
        ),
        (
            "sprite is not a planned motion",
            Box::new(|p| {
                p.slots[2].kind = SlotKind::Gif {
                    base: 0,
                    motion: "sprite".into(),
                }
            }),
        ),
        ("empty prompt", Box::new(|p| p.prompt = String::new())),
        (
            "801-character prompt",
            Box::new(|p| p.prompt = "가".repeat(801)),
        ),
        (
            "301-character scene",
            Box::new(|p| {
                p.slots[0].kind = SlotKind::Still {
                    scene: "a".repeat(301),
                }
            }),
        ),
        (
            "title with a link bracket",
            Box::new(|p| p.title = "[x](y)".into()),
        ),
        (
            "six tags",
            Box::new(|p| p.slots[0].tags = (0..6).map(|n| format!("t{n}")).collect()),
        ),
        (
            "a face that is not the requester",
            Box::new(|p| p.subject = Some(Uuid::new_v4())),
        ),
        (
            "five references",
            Box::new(|p| p.reference_attachment_ids = vec![Uuid::new_v4(); 5]),
        ),
        ("no slots", Box::new(|p| p.slots.clear())),
    ];
    for (label, change) in bad {
        let mut p = plan("good");
        change(&mut p);
        assert_eq!(
            refused(begin(&w, t, p).await),
            Refusal::InvalidArguments,
            "{label}"
        );
    }
    assert_eq!(sets_of(t).await, 0, "no bad plan left a row");
    // more than 40 slots is its own refusal, and 40 is fine
    assert_eq!(
        refused(begin(&w, t, stills(41, "big")).await),
        Refusal::SetFull
    );
    assert_eq!(sets_of(t).await, 0);
    let full = begun(&w, t, stills(40, "big")).await;
    assert_eq!(
        get(&w, t.owner(), full).await.unwrap().slots.len(),
        40,
        "forty slots is the ceiling and it is allowed"
    );

    // the composite foreign key, alone (a raw INSERT around the functions): a run of another
    // tenant, a run of another agent, a channel that is not the run's
    let t = tenant(&w.su).await;
    let raw = |agent: Uuid, run: Uuid, channel: Uuid| {
        let sql = format!(
            "INSERT INTO expression_set(workspace_id,agent_member_id,requester_member_id,run_id,channel_id,title,prefix,backend,prompt) \
             VALUES('{}','{agent}','{}','{run}','{channel}','t','pre','hermes','p')",
            t.ws, t.alice
        );
        let worker = w.worker.clone();
        async move { fails_with(&worker, &sql).await }
    };
    assert_eq!(
        raw(t.agent, b.run, t.channel).await,
        "23503",
        "another tenant's run"
    );
    assert_eq!(
        raw(t.agent2, t.run, t.channel).await,
        "23503",
        "the run is another agent's"
    );
    assert_eq!(
        raw(t.agent, t.run, b.channel).await,
        "23503",
        "not the run's conversation"
    );
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a7_a_slot_is_written_once_by_the_domain_functions_and_by_the_database_alone() {
    let w = world().await;
    let a = w.a;
    let owner = a.owner();
    let id = begun(&w, a, plan("seven")).await;

    // through the functions: a gray slot takes no picture, a picture slot takes no gray, nothing twice,
    // and a slot outside the plan is unknown. Every refusal writes nothing.
    gray(&w, owner, id, 0, GrayCode::Refused)
        .await
        .unwrap()
        .expect("gray once");
    assert_eq!(
        still(&w, owner, id, 0, decoded_still()).await.unwrap(),
        Err(Refusal::SlotClosed),
        "picture on gray"
    );
    assert_eq!(
        gray(&w, owner, id, 0, GrayCode::Failed).await.unwrap(),
        Err(Refusal::SlotClosed),
        "gray twice"
    );
    let stored = still(&w, owner, id, 1, decoded_still())
        .await
        .unwrap()
        .expect("picture once");
    assert_eq!(
        gray(&w, owner, id, 1, GrayCode::Failed).await.unwrap(),
        Err(Refusal::SlotClosed),
        "gray on picture"
    );
    assert_eq!(
        still(&w, owner, id, 1, decoded_still()).await.unwrap(),
        Err(Refusal::SlotClosed),
        "picture twice"
    );
    assert_eq!(
        still(&w, owner, id, 7, decoded_still()).await.unwrap(),
        Err(Refusal::SlotUnknown),
        "outside the plan"
    );
    assert_eq!(
        gray(&w, owner, id, 7, GrayCode::Failed).await.unwrap(),
        Err(Refusal::SlotUnknown),
        "outside the plan"
    );
    let held = get(&w, owner, id).await.unwrap();
    assert_eq!(
        held.stored_bytes, stored.stored_bytes,
        "refusals added no bytes"
    );
    assert_eq!(
        images_of(&w.su, id).await,
        3,
        "refusals added no renditions"
    );
    assert_eq!(held.slots[0].state, "gray");
    assert_eq!(held.slots[0].code.as_deref(), Some("refused"));
    assert_eq!(held.slots[1].state, "ready");
    assert_eq!(held.slots[1].renditions, 3);
    // a GIF cannot be refused by the picture model; a still has no missing base
    assert_eq!(
        gray(&w, owner, id, 2, GrayCode::Refused).await.unwrap(),
        Err(Refusal::InvalidArguments)
    );
    assert_eq!(
        gray(&w, owner, id, 2, GrayCode::BaseMissing)
            .await
            .unwrap()
            .is_ok(),
        true
    );

    // the database ALONE, as the worker, with the function checks out of the way
    let t = tenant(&w.su).await;
    let raw = begun(&w, t, plan("raw")).await;
    let ws = t.ws;
    let run_sql = |sql: String| {
        let worker = w.worker.clone();
        async move { fails_with(&worker, &sql).await }
    };
    // a slot that was written cannot change again: planned -> gray, then anything
    sqlx::query("UPDATE expression_set_slot SET state = 'gray', code = 'failed' WHERE set_id = $1 AND slot_index = 0")
        .bind(raw)
        .execute(&w.worker)
        .await
        .unwrap();
    for sql in [
        format!("UPDATE expression_set_slot SET state = 'gray', code = 'refused' WHERE set_id = '{raw}' AND slot_index = 0"),
        format!("UPDATE expression_set_slot SET state = 'planned', code = NULL WHERE set_id = '{raw}' AND slot_index = 0"),
        format!("UPDATE expression_set_slot SET state = 'ready', code = NULL WHERE set_id = '{raw}' AND slot_index = 0"),
    ] {
        assert_eq!(run_sql(sql.clone()).await, "23514", "{sql}");
    }
    assert_eq!(
        slot_state(&w.su, raw, 0).await,
        ("gray".into(), Some("failed".into()))
    );
    // a slot cannot become ready without all three renditions, nor gray with pixels
    assert_eq!(run_sql(format!("UPDATE expression_set_slot SET state = 'ready' WHERE set_id = '{raw}' AND slot_index = 1")).await, "23514", "ready with no pixels");
    let one = fabricated(100, 64);
    let insert = |variant: &'static str, rendition: &e::media::Rendition| {
        let worker = w.worker.clone();
        let (info, data) = (rendition.info.clone(), rendition.data.clone());
        async move {
            sqlx::query("INSERT INTO expression_set_image(workspace_id,set_id,slot_index,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10)")
                .bind(ws).bind(raw).bind(variant).bind(&info.mime).bind(&data).bind(&info.sha256)
                .bind(info.width as i32).bind(info.height as i32).bind(info.frame_count as i32).bind(info.duration_ms as i32)
                .execute(&worker).await
        }
    };
    insert("large", &one).await.unwrap();
    assert_eq!(
        db_code(&insert("large", &one).await.unwrap_err()),
        "23505",
        "one rendition per slot per variant: the UNIQUE"
    );
    assert_eq!(run_sql(format!("UPDATE expression_set_slot SET state = 'gray', code = 'failed' WHERE set_id = '{raw}' AND slot_index = 1")).await, "23514", "gray with pixels");
    // a picture cannot be written to a closed slot (gray slot 0), nor changed
    assert_eq!(
        db_code(&insert_at(&w.worker, ws, raw, 0, &one).await.unwrap_err()),
        "23514",
        "pixels into a gray slot"
    );
    assert_eq!(
        fails_with(
            &w.su,
            &format!("UPDATE expression_set_image SET width = 1 WHERE set_id = '{raw}'")
        )
        .await,
        "23514",
        "pixels are immutable (the trigger, even for an owner)"
    );
    assert_eq!(
        run_sql(format!(
            "UPDATE expression_set_image SET width = 1 WHERE set_id = '{raw}'"
        ))
        .await,
        "42501",
        "and the worker has no UPDATE on pixels at all"
    );
    // a slot outside the plan cannot get a rendition (the image trigger looks for the planned slot first)
    assert_eq!(
        db_code(&insert_at(&w.worker, ws, raw, 9, &one).await.unwrap_err()),
        "23514",
        "no such slot"
    );
}

async fn insert_at(
    worker: &PgPool,
    ws: Uuid,
    set: Uuid,
    slot: i32,
    rendition: &e::media::Rendition,
) -> Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
    sqlx::query("INSERT INTO expression_set_image(workspace_id,set_id,slot_index,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) VALUES($1,$2,$3,'small',$4,$5,$6,$7,$8,$9,$10)")
        .bind(ws).bind(set).bind(slot).bind(&rendition.info.mime).bind(&rendition.data).bind(&rendition.info.sha256)
        .bind(rendition.info.width as i32).bind(rendition.info.height as i32).bind(rendition.info.frame_count as i32).bind(rendition.info.duration_ms as i32)
        .execute(worker).await
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a8_an_agent_has_one_undecided_set_even_when_two_begins_race() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let again = Tenant {
        run: t.run_again,
        ..t
    };
    // sequential
    let first = begun(&w, t, plan("one")).await;
    assert_eq!(
        begin(&w, again, plan("two")).await.unwrap().unwrap_err(),
        Refusal::SetBusy
    );
    // another agent of the same workspace has its own
    let other_run = run_of(&w.su, t.ws, t.channel, t.agent2, t.alice).await;
    begun(
        &w,
        Tenant {
            agent: t.agent2,
            run: other_run,
            ..t
        },
        plan("three"),
    )
    .await;
    // the partial unique index ALONE: a raw second staging head for the same agent
    let raw = format!(
        "INSERT INTO expression_set(workspace_id,agent_member_id,requester_member_id,run_id,channel_id,title,prefix,backend,prompt) \
         VALUES('{}','{}','{}','{}','{}','t','pre','hermes','p')",
        t.ws, t.agent, t.alice, t.run_again, t.channel
    );
    assert_eq!(fails_with(&w.worker, &raw).await, "23505");
    // `proposed` still counts; `decided` frees the slot
    forge(
        &w.su,
        &[(
            "UPDATE expression_set SET state = 'proposed', approval_id = $2 WHERE id = $1",
            vec![first, Uuid::new_v4()],
        )],
    )
    .await;
    assert_eq!(
        begin(&w, again, plan("four")).await.unwrap().unwrap_err(),
        Refusal::SetBusy,
        "proposed is undecided"
    );
    forge(
        &w.su,
        &[(
            "UPDATE expression_set SET state = 'decided' WHERE id = $1",
            vec![first],
        )],
    )
    .await;
    let next = begin(&w, again, plan("five"))
        .await
        .unwrap()
        .expect("decided frees the slot");
    // ... and so does the end of a staging set
    abandon(&w, again.owner(), next.set_id)
        .await
        .unwrap()
        .unwrap();
    let bobs = Owner {
        workspace: t.ws,
        agent: t.agent,
        requester: t.bob,
        run: t.run_bob,
    };
    begin_as(&w, bobs, plan("six"))
        .await
        .unwrap()
        .expect("a second person may use the freed agent");

    // two simultaneous begins for one agent: exactly one wins and the other is told SetBusy, never a
    // database error (the member-row lock serialises them; the index is the last door)
    for round in 0..4 {
        let t = tenant(&w.su).await;
        let again = Tenant {
            run: t.run_again,
            ..t
        };
        let (x, y) = tokio::join!(begin(&w, t, plan("raca")), begin(&w, again, plan("racb")));
        let verdicts: Vec<Result<(), Refusal>> = [x, y]
            .into_iter()
            .map(|r| {
                r.unwrap_or_else(|error| {
                    panic!("round {round}: a race must not be a storage error: {error}")
                })
                .map(|_| ())
            })
            .collect();
        assert_eq!(
            verdicts.iter().filter(|v| v.is_ok()).count(),
            1,
            "round {round}: {verdicts:?}"
        );
        assert!(
            verdicts.contains(&Err(Refusal::SetBusy)),
            "round {round}: {verdicts:?}"
        );
        assert_eq!(
            count(
                &w.su,
                "SELECT count(*) FROM expression_set WHERE workspace_id = $1 AND state = 'staging'",
                t.ws
            )
            .await,
            1
        );
    }
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a9_the_cap_is_24_mib_to_the_byte_and_a_refused_write_leaves_nothing() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let owner = t.owner();
    let id = begun(&w, t, stills(17, "cap")).await;
    let mut total = 0;
    for index in 0..16u8 {
        let stored = still(&w, owner, id, index, fat_slot())
            .await
            .unwrap()
            .expect("sixteen of 1.5 MiB fit");
        total += stored.bytes;
        assert_eq!(stored.stored_bytes, total);
    }
    assert_eq!(
        total, MAX_STORED_BYTES,
        "16 x 1.5 MiB is exactly 24 MiB: the boundary itself is allowed"
    );
    // one more slot's worth, and even three bytes, are over: refused, nothing written, nothing trimmed
    let tiny = e::media::Processed {
        large: fabricated(1, 8),
        small: fabricated(1, 8),
        thumb: fabricated(1, 8),
    };
    let images = images_of(&w.su, id).await;
    assert_eq!(images, 48);
    assert_eq!(
        still(&w, owner, id, 16, fat_slot()).await.unwrap(),
        Err(Refusal::BytesOver),
        "1.5 MiB over"
    );
    assert_eq!(
        still(&w, owner, id, 16, tiny).await.unwrap(),
        Err(Refusal::BytesOver),
        "3 bytes over"
    );
    assert_eq!(
        images_of(&w.su, id).await,
        images,
        "a refusal wrote no rendition"
    );
    let held = get(&w, owner, id).await.unwrap();
    assert_eq!(held.stored_bytes, MAX_STORED_BYTES, "and added no byte");
    assert_eq!(held.slots[16].state, "planned", "the slot is still open");
    assert_eq!(Refusal::BytesOver.code(), "set_bytes_over");
    // the caller closes it gray instead, which holds no bytes and is allowed at the cap
    gray(&w, owner, id, 16, GrayCode::Failed)
        .await
        .unwrap()
        .expect("a gray slot costs nothing");
    // the row CHECK is the database's own last door (it sees only what the function adds up)
    assert_eq!(
        fails_with(
            &w.worker,
            &format!(
                "UPDATE expression_set SET stored_bytes = {} WHERE id = '{id}'",
                MAX_STORED_BYTES + 1
            )
        )
        .await,
        "23514"
    );
    // 41 slots never get as far as a row
    assert_eq!(
        begin(&w, tenant(&w.su).await, stills(41, "toomany"))
            .await
            .unwrap()
            .unwrap_err()
            .code(),
        "set_full"
    );
}

/// Run `statements` as one transaction on `pool` (so a deferred rule is judged at COMMIT).
async fn exec_tx(pool: &PgPool, statements: &[String]) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for sql in statements {
        sqlx::query(sql).execute(&mut *tx).await?;
    }
    tx.commit().await
}

async fn row_json(su: &PgPool, sql: &str, id: Uuid) -> serde_json::Value {
    sqlx::query(sql)
        .bind(id)
        .fetch_one(su)
        .await
        .unwrap()
        .get::<serde_json::Value, _>("row")
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a27_the_plan_and_the_one_way_columns_cannot_be_changed_by_the_worker() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let owner = t.owner();
    let id = begun(&w, t, plan("tw")).await;
    still(&w, owner, id, 0, decoded_still())
        .await
        .unwrap()
        .unwrap();
    let head_sql = "SELECT to_jsonb(h) AS row FROM expression_set h WHERE id = $1";
    let slots_sql = "SELECT jsonb_agg(to_jsonb(s) ORDER BY slot_index) AS row FROM expression_set_slot s WHERE set_id = $1";
    let (head_before, slots_before) = (
        row_json(&w.su, head_sql, id).await,
        row_json(&w.su, slots_sql, id).await,
    );
    let refused = [
        // the plan columns of the head
        "title = 'other'", "prefix = 'other'", "backend = 'team_image_model'", "subject_member_id = v.bob",
        "reference_attachment_ids = ARRAY[gen_random_uuid()]", "notice_shown = true", "prompt = 'other words'", "prompt = NULL",
        // identity
        "id = gen_random_uuid()", "agent_member_id = v.agent2", "requester_member_id = v.bob",
        "run_id = v.run_again", "created_at = created_at - interval '1 day'",
        // direction and the one-time columns
        "state = 'decided'", "state = 'proposed'", "state = 'expired'", "approval_id = gen_random_uuid()",
        "stored_bytes = 0", "expires_at = expires_at + interval '1 day'", "expires_at = expires_at - interval '1 hour'",
        "plan_confirmed_at = clock_timestamp()",
        "plan_confirmed_at = clock_timestamp(), expires_at = clock_timestamp() + interval '3 hours'",
        "plan_confirmed_at = clock_timestamp() + interval '1 hour', expires_at = clock_timestamp() + interval '3 hours'",
    ];
    for assignment in refused {
        let sql = format!(
            "UPDATE expression_set h SET {assignment} FROM (SELECT '{}'::uuid AS bob, '{}'::uuid AS agent2, '{}'::uuid AS run_again) v WHERE h.id = '{id}'",
            t.bob, t.agent2, t.run_again
        );
        assert_eq!(fails_with(&w.worker, &sql).await, "23514", "{assignment}");
    }
    // the slot's plan columns
    for assignment in [
        "name = 'tw_other'",
        "display_name = 'other'",
        "tags = '[\"x\"]'::jsonb",
        "kind = 'gif'",
        "base_index = 1",
        "motion = 'pulse'",
        "scene = 'other scene'",
        "scene = NULL",
        "slot_index = 5",
    ] {
        let sql = format!(
            "UPDATE expression_set_slot SET {assignment} WHERE set_id = '{id}' AND slot_index = 1"
        );
        assert_eq!(fails_with(&w.worker, &sql).await, "23514", "{assignment}");
    }
    assert_eq!(
        head_before,
        row_json(&w.su, head_sql, id).await,
        "every refused UPDATE left the head as it was"
    );
    assert_eq!(
        slots_before,
        row_json(&w.su, slots_sql, id).await,
        "and the slots"
    );

    // the one allowed confirmation: plan_confirmed_at and expires_at = plan_confirmed_at + 2 hours in one UPDATE
    let confirm = format!(
        "WITH t AS (SELECT clock_timestamp() AS at) UPDATE expression_set h SET plan_confirmed_at = t.at, expires_at = t.at + interval '2 hours' FROM t WHERE h.id = '{id}'"
    );
    sqlx::query(&confirm)
        .execute(&w.worker)
        .await
        .expect("the confirmation");
    let (confirmed, expires): (chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT plan_confirmed_at, expires_at FROM expression_set WHERE id = $1")
            .bind(id)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!((expires - confirmed).num_seconds(), 7200);
    assert_eq!(
        fails_with(&w.worker, &confirm).await,
        "23514",
        "a second confirmation"
    );
    // the bytes grow while staging, never shrink
    sqlx::query(&format!(
        "UPDATE expression_set SET stored_bytes = stored_bytes + 1 WHERE id = '{id}'"
    ))
    .execute(&w.worker)
    .await
    .expect("grows");
    assert_eq!(
        fails_with(
            &w.worker,
            &format!("UPDATE expression_set SET stored_bytes = stored_bytes - 1 WHERE id = '{id}'")
        )
        .await,
        "23514"
    );
    // direction: staging -> expired (head first, then the scenes) -> never back
    let (head, scenes) = (
        format!("UPDATE expression_set SET state = 'expired', prompt = NULL WHERE id = '{id}'"),
        format!("UPDATE expression_set_slot SET scene = NULL WHERE set_id = '{id}'"),
    );
    exec_tx(&w.worker, &[head, scenes])
        .await
        .expect("the end path: head first, then the scenes");
    for assignment in [
        "state = 'staging'",
        "state = 'proposed', approval_id = gen_random_uuid()",
        "state = 'decided'",
        "prompt = 'back'",
        "stored_bytes = stored_bytes + 1",
    ] {
        assert_eq!(
            fails_with(
                &w.worker,
                &format!("UPDATE expression_set SET {assignment} WHERE id = '{id}'")
            )
            .await,
            "23514",
            "{assignment}"
        );
    }
    // a `proposed` head cannot change its approval
    let proposed = begun(&w, tenant(&w.su).await, plan("pr")).await;
    forge(
        &w.su,
        &[(
            "UPDATE expression_set SET state = 'proposed', approval_id = $2 WHERE id = $1",
            vec![proposed, Uuid::new_v4()],
        )],
    )
    .await;
    assert_eq!(
        fails_with(
            &w.worker,
            &format!(
                "UPDATE expression_set SET approval_id = gen_random_uuid() WHERE id = '{proposed}'"
            )
        )
        .await,
        "23514"
    );
    // born as `begin` writes it, or not at all (a raw INSERT around the function)
    let t2 = tenant(&w.su).await;
    let base = format!(
        "INSERT INTO expression_set(workspace_id,agent_member_id,requester_member_id,run_id,channel_id,title,prefix,backend,prompt{{cols}}) \
         VALUES('{}','{}','{}','{}','{}','t','pre','hermes','p'{{vals}})",
        t2.ws, t2.agent, t2.alice, t2.run, t2.channel
    );
    for (cols, vals) in [
        (",stored_bytes", ",5"),
        (",plan_confirmed_at", ",clock_timestamp()"),
        (",expires_at", ",clock_timestamp() + interval '1 year'"),
        (",expires_at", ",clock_timestamp() - interval '1 second'"),
        (",state,approval_id", ",'proposed',gen_random_uuid()"),
    ] {
        let sql = base.replace("{cols}", cols).replace("{vals}", vals);
        assert_eq!(fails_with(&w.worker, &sql).await, "23514", "{cols}");
    }
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn the_deferred_rule_an_expired_set_keeps_no_scene_holds_at_commit() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let id = begun(&w, t, plan("df")).await;
    // a scene cannot be blanked while the head is alive
    assert_eq!(fails_with(&w.worker, &format!("UPDATE expression_set_slot SET scene = NULL WHERE set_id = '{id}' AND slot_index = 0")).await, "23514");
    // expiring the head and leaving a scene behind: the COMMIT is refused
    let head =
        format!("UPDATE expression_set SET state = 'expired', prompt = NULL WHERE id = '{id}'");
    let error = exec_tx(&w.worker, &[head.clone()])
        .await
        .expect_err("a scene would survive the expiry");
    assert_eq!(db_code(&error), "23514");
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM expression_set WHERE id = $1 AND state = 'staging'",
            id
        )
        .await,
        1,
        "and the head stayed staging"
    );
    // an expired head with its prompt left in: the row CHECK
    assert_eq!(
        fails_with(
            &w.worker,
            &format!("UPDATE expression_set SET state = 'expired' WHERE id = '{id}'")
        )
        .await,
        "23514"
    );
    // head first, then the scenes: accepted
    exec_tx(
        &w.worker,
        &[
            head,
            format!("UPDATE expression_set_slot SET scene = NULL WHERE set_id = '{id}'"),
        ],
    )
    .await
    .expect("complete end path");
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM expression_set_slot WHERE set_id = $1 AND scene IS NOT NULL",
            id
        )
        .await,
        0
    );
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a37_every_runtime_role_holds_exactly_the_verbs_of_the_adr_and_real_connections_agree() {
    let w = world().await;
    let tables = [
        "expression_set",
        "expression_set_slot",
        "expression_set_image",
        "expression_set_notice",
    ];
    let roles = [
        "momo_app",
        "momo_relay",
        "momo_worker",
        "momo_notifier",
        "momo_platform_admin",
        "momo_helper_read",
    ];
    let allowed = |table: &str, role: &str| -> Vec<&'static str> {
        match (table, role) {
            ("expression_set", "momo_worker") | ("expression_set_slot", "momo_worker") => {
                vec!["SELECT", "INSERT", "UPDATE"]
            }
            ("expression_set", "momo_app") | ("expression_set_slot", "momo_app") => {
                vec!["SELECT", "UPDATE"]
            }
            ("expression_set_image", "momo_worker") => vec!["SELECT", "INSERT", "DELETE"],
            ("expression_set_image", "momo_app") => vec!["SELECT", "DELETE"],
            ("expression_set_notice", "momo_worker") => vec!["SELECT"],
            ("expression_set_notice", "momo_app") => vec!["SELECT", "INSERT"],
            _ => vec![],
        }
    };
    let mut measured_roles = 0;
    let mut drift: Vec<String> = vec![];
    for role in roles {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)")
                .bind(role)
                .fetch_one(&w.su)
                .await
                .unwrap();
        if !exists {
            continue; // momo_platform_admin exists only in the production bootstrap
        }
        measured_roles += 1;
        for table in tables {
            let columns: Vec<String> = sqlx::query_scalar("SELECT attname::text FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped")
                .bind(format!("public.{table}")).fetch_all(&w.su).await.unwrap();
            assert!(
                columns.len() >= 3,
                "{table}: the column scan sees the table"
            );
            for verb in [
                "SELECT",
                "INSERT",
                "UPDATE",
                "DELETE",
                "TRUNCATE",
                "REFERENCES",
                "TRIGGER",
            ] {
                let has: bool = sqlx::query_scalar("SELECT has_table_privilege($1, $2, $3)")
                    .bind(role)
                    .bind(format!("public.{table}"))
                    .bind(verb)
                    .fetch_one(&w.su)
                    .await
                    .unwrap();
                if has != allowed(table, role).contains(&verb) {
                    drift.push(format!("{role} {table} {verb} has={has}"));
                }
            }
            for column in &columns {
                for verb in ["SELECT", "INSERT", "UPDATE"] {
                    let has: bool =
                        sqlx::query_scalar("SELECT has_column_privilege($1, $2, $3, $4)")
                            .bind(role)
                            .bind(format!("public.{table}"))
                            .bind(column)
                            .bind(verb)
                            .fetch_one(&w.su)
                            .await
                            .unwrap();
                    let want = allowed(table, role).contains(&verb)
                        || (role == "momo_notifier"
                            && table == "expression_set"
                            && verb == "SELECT"
                            && ["workspace_id", "state", "expires_at"].contains(&column.as_str()));
                    if has != want {
                        drift.push(format!("{role} {table}.{column} {verb} has={has}"));
                    }
                }
            }
        }
    }
    assert!(
        measured_roles >= 5,
        "the scan must see the runtime roles or it proves nothing (saw {measured_roles})"
    );
    assert!(
        drift.is_empty(),
        "privileges drifted from the ADR's table: {drift:?}"
    );
    // PUBLIC holds nothing on any of the four
    let public: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE c.relname = ANY($1) AND c.relnamespace = 'public'::regnamespace AND a.grantee = 0",
    ).bind(tables.map(String::from).to_vec()).fetch_one(&w.su).await.unwrap();
    assert_eq!(public, 0, "PUBLIC has a privilege on a set table");

    // what real connections can and cannot do (SQLSTATE 42501 = insufficient_privilege)
    let denied = |pool: &PgPool, sql: &'static str| {
        let pool = pool.clone();
        async move { assert_eq!(fails_with(&pool, sql).await, "42501", "{sql}") }
    };
    // the notifier: three columns of the head, nothing else
    sqlx::query("SELECT workspace_id, state, expires_at FROM expression_set LIMIT 1")
        .fetch_all(&w.notifier)
        .await
        .expect("discovery reads three columns");
    for sql in [
        "SELECT prompt FROM expression_set",
        "SELECT * FROM expression_set",
        "SELECT id FROM expression_set",
        "SELECT 1 FROM expression_set_slot",
        "SELECT 1 FROM expression_set_image",
        "SELECT 1 FROM expression_set_notice",
        "UPDATE expression_set SET state = state",
        "DELETE FROM expression_set",
    ] {
        denied(&w.notifier, sql).await;
    }
    // the relay: nothing at all
    for sql in [
        "SELECT 1 FROM expression_set",
        "SELECT 1 FROM expression_set_slot",
        "SELECT 1 FROM expression_set_image",
        "SELECT 1 FROM expression_set_notice",
    ] {
        denied(&w.relay, sql).await;
    }
    // the worker (BYPASSRLS): no DELETE of a head, slot or notice, no pixel change, no notice write
    for sql in [
        "DELETE FROM expression_set", "DELETE FROM expression_set_slot", "DELETE FROM expression_set_notice",
        "UPDATE expression_set_image SET width = width", "INSERT INTO expression_set_notice(workspace_id, member_id) SELECT workspace_id, id FROM member",
        "UPDATE expression_set_notice SET seen_at = now()", "TRUNCATE expression_set",
    ] {
        denied(&w.worker, sql).await;
    }
    // the app: decides and reclaims, but never writes a head or a slot into being, never a pixel
    for sql in [
        "INSERT INTO expression_set(workspace_id) VALUES (gen_random_uuid())",
        "INSERT INTO expression_set_slot(workspace_id) VALUES (gen_random_uuid())",
        "INSERT INTO expression_set_image(workspace_id) VALUES (gen_random_uuid())",
        "DELETE FROM expression_set",
        "DELETE FROM expression_set_slot",
        "UPDATE expression_set_image SET width = width",
        "UPDATE expression_set_notice SET seen_at = now()",
        "DELETE FROM expression_set_notice",
    ] {
        assert_eq!(app_fails(&w, w.a.ws, sql).await, "42501", "{sql}");
    }
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a43_a_notice_is_one_row_per_member_and_nothing_updates_or_deletes_it() {
    let w = world().await;
    let (a, b) = (w.a, w.b);
    let write = |ws: Uuid, member: Uuid| {
        let api = w.api.clone();
        async move {
            in_tx(&api, ws, move |conn| {
                Box::pin(async move {
                    Ok(sqlx::query("INSERT INTO expression_set_notice(workspace_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING")
                        .bind(ws).bind(member).execute(&mut *conn).await?.rows_affected())
                })
            })
            .await
        }
    };
    assert_eq!(
        write(a.ws, a.alice).await.unwrap(),
        1,
        "the first sight is written (by momo_app)"
    );
    let first: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT seen_at FROM expression_set_notice WHERE member_id = $1")
            .bind(a.alice)
            .fetch_one(&w.su)
            .await
            .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(
        write(a.ws, a.alice).await.unwrap(),
        0,
        "the second sight changes nothing"
    );
    let again: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT seen_at FROM expression_set_notice WHERE member_id = $1")
            .bind(a.alice)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!(first, again, "the first time stays");
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM expression_set_notice WHERE member_id = $1",
            a.alice
        )
        .await,
        1
    );
    // no UPDATE, no DELETE for any runtime role; the trigger refuses even an owner's UPDATE
    assert_eq!(
        app_fails(&w, a.ws, "UPDATE expression_set_notice SET seen_at = now()").await,
        "42501"
    );
    assert_eq!(
        app_fails(&w, a.ws, "DELETE FROM expression_set_notice").await,
        "42501"
    );
    assert_eq!(
        fails_with(
            &w.worker,
            "UPDATE expression_set_notice SET seen_at = now()"
        )
        .await,
        "42501"
    );
    assert_eq!(
        fails_with(&w.worker, "DELETE FROM expression_set_notice").await,
        "42501"
    );
    assert_eq!(
        fails_with(&w.su, "UPDATE expression_set_notice SET seen_at = now()").await,
        "23514"
    );
    // the worker reads (the plan card's `noticeDue`), and RLS keeps tenants apart for the app
    let seen: i64 = in_tx(&w.worker, a.ws, move |conn| {
        Box::pin(async move { Ok(sqlx::query_scalar("SELECT count(*) FROM expression_set_notice WHERE workspace_id = $1 AND member_id = $2").bind(a.ws).bind(a.alice).fetch_one(&mut *conn).await?) })
    }).await.unwrap();
    assert_eq!(seen, 1);
    let cross = in_tx(&w.api, b.ws, move |conn| {
        Box::pin(async move {
            Ok(sqlx::query(
                "INSERT INTO expression_set_notice(workspace_id, member_id) VALUES ($1,$2)",
            )
            .bind(a.ws)
            .bind(a.bob)
            .execute(&mut *conn)
            .await?
            .rows_affected())
        })
    })
    .await;
    assert!(
        cross.is_err(),
        "a row for tenant A written under tenant B's GUC is refused by RLS"
    );
    // the composite foreign key: a member of another tenant
    let foreign = format!(
        "INSERT INTO expression_set_notice(workspace_id, member_id) VALUES ('{}','{}')",
        a.ws, b.alice
    );
    assert_eq!(fails_with(&w.su, &foreign).await, "23503");
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a13_every_staging_end_path_leaves_no_pixels_no_prompt_and_no_scene() {
    let w = world().await;
    let secrets = ["비밀 프롬프트 문장", "비밀 장면 글"];

    // --- abandon (the run was cancelled), as the worker ---------------------------------------
    let t = tenant(&w.su).await;
    let owner = t.owner();
    let id = begun(&w, t, plan("ab")).await;
    still(&w, owner, id, 0, decoded_still())
        .await
        .unwrap()
        .unwrap();
    gray(&w, owner, id, 1, GrayCode::Refused)
        .await
        .unwrap()
        .unwrap();
    let held = get(&w, owner, id).await.unwrap();
    assert!(held.prompt.as_deref().unwrap().contains("비밀"));
    assert!(held.stored_bytes > 0 && images_of(&w.su, id).await == 3);
    assert_eq!(
        abandon(
            &w,
            Tenant {
                agent: t.agent2,
                ..t
            }
            .owner(),
            id
        )
        .await
        .unwrap(),
        Err(Refusal::InvalidArguments),
        "only the owner abandons"
    );
    let reclaimed = abandon(&w, owner, id).await.unwrap().expect("abandon");
    assert_eq!(
        reclaimed,
        set::Reclaimed {
            images: 3,
            slots: 1,
            closed_now: true
        }
    );
    let after = get(&w, owner, id).await.unwrap();
    assert_eq!(after.state, "expired");
    assert_eq!(
        after.prompt, None,
        "the agent's words are gone from the head"
    );
    assert!(
        after
            .slots
            .iter()
            .all(|s| s.scene.is_none() && s.renditions == 0),
        "and from every slot, with no pixel left"
    );
    assert_eq!(
        after
            .slots
            .iter()
            .map(|s| s.state.as_str())
            .collect::<Vec<_>>(),
        ["ready", "gray", "planned"],
        "the slots stay as a record of what was made"
    );
    assert_eq!(
        after.stored_bytes, held.stored_bytes,
        "the head keeps what it once held, as a record"
    );
    assert_eq!(images_of(&w.su, id).await, 0);
    assert_eq!(
        abandon(&w, owner, id).await.unwrap().unwrap(),
        set::Reclaimed::default(),
        "idempotent"
    );
    // A15: the audit row says ids and counts, and none of the agent's words, names or bytes
    let audit: Vec<(String, serde_json::Value)> = sqlx::query_as(
        "SELECT action, detail FROM audit_log WHERE workspace_id = $1 AND target_id = $2",
    )
    .bind(t.ws)
    .bind(id)
    .fetch_all(&w.su)
    .await
    .unwrap();
    assert_eq!(
        audit.len(),
        1,
        "one reclaim, one row (the repeat wrote none)"
    );
    assert_eq!(audit[0].0, "expression.set.reclaimed");
    let text = audit[0].1.to_string();
    for forbidden in secrets
        .iter()
        .chain(&["ab_hello", "hello", "bytes", "base64", "고양이"])
    {
        assert!(
            !text.contains(forbidden),
            "the audit row carries `{forbidden}`: {text}"
        );
    }
    assert!(
        text.contains(&id.to_string()) && text.contains("abandon"),
        "{text}"
    );

    // --- the TTL sweep, notifier-shaped: discovery on momo_notifier, reclaim on momo_app ----------
    let b = w.b;
    let due = begun(&w, b, plan("sw")).await;
    still(&w, b.owner(), due, 0, decoded_still())
        .await
        .unwrap()
        .unwrap();
    let live_tenant = tenant(&w.su).await;
    let live = begun(&w, live_tenant, plan("lv")).await;
    still(&w, live_tenant.owner(), live, 0, decoded_still())
        .await
        .unwrap()
        .unwrap();
    backdate(&w.su, due, 121).await;
    let freed = e::sweep_expired(&w.notifier, &w.api).await.expect("sweep");
    assert!(
        freed >= 3,
        "the sweep reports the rendition rows it deleted (at least this set's three), got {freed}"
    );
    let swept = get(&w, b.owner(), due).await.unwrap();
    assert_eq!(
        (swept.state.as_str(), swept.prompt.as_deref()),
        ("expired", None)
    );
    assert!(swept
        .slots
        .iter()
        .all(|s| s.scene.is_none() && s.renditions == 0));
    assert_eq!(images_of(&w.su, due).await, 0);
    let untouched = get(&w, live_tenant.owner(), live).await.unwrap();
    assert_eq!(
        untouched.state, "staging",
        "a set inside its two hours is not touched"
    );
    assert!(untouched.prompt.is_some() && untouched.slots[0].renditions == 3);
    let why: String =
        sqlx::query_scalar("SELECT detail->>'why' FROM audit_log WHERE target_id = $1")
            .bind(due)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!(why, "expired");
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn a29_the_sweep_touches_staging_only_and_the_confirmation_restarts_the_two_hours() {
    let w = world().await;
    // a `proposed` head far past its own expires_at: not the store's to expire
    let tp = tenant(&w.su).await;
    let proposed = begun(&w, tp, plan("pp")).await;
    still(&w, tp.owner(), proposed, 0, decoded_still())
        .await
        .unwrap()
        .unwrap();
    forge(
        &w.su,
        &[(
            "UPDATE expression_set SET state = 'proposed', approval_id = $2 WHERE id = $1",
            vec![proposed, Uuid::new_v4()],
        )],
    )
    .await;
    backdate(&w.su, proposed, 400).await;
    // a staging head 119 minutes in, then confirmed now: it has two hours from the confirmation
    let tc = tenant(&w.su).await;
    let confirmed = begun(&w, tc, plan("cc")).await;
    backdate(&w.su, confirmed, 119).await;
    sqlx::query(&format!(
        "WITH t AS (SELECT clock_timestamp() AS at) UPDATE expression_set h SET plan_confirmed_at = t.at, expires_at = t.at + interval '2 hours' FROM t WHERE h.id = '{confirmed}'"
    )).execute(&w.worker).await.expect("a late confirmation");
    // the control: the same age, never confirmed, is due
    let tu = tenant(&w.su).await;
    let unconfirmed = begun(&w, tu, plan("uu")).await;
    backdate(&w.su, unconfirmed, 121).await;

    e::sweep_expired(&w.notifier, &w.api).await.expect("sweep");
    let state = |id: Uuid| {
        let su = w.su.clone();
        async move {
            sqlx::query_scalar::<_, String>("SELECT state FROM expression_set WHERE id = $1")
                .bind(id)
                .fetch_one(&su)
                .await
                .unwrap()
        }
    };
    assert_eq!(
        state(unconfirmed).await,
        "expired",
        "121 minutes unconfirmed: reclaimed"
    );
    assert_eq!(
        state(confirmed).await,
        "staging",
        "119 minutes in but confirmed just now: making goes on"
    );
    assert_eq!(
        state(proposed).await,
        "proposed",
        "a proposed head is not swept, however old"
    );
    assert_eq!(
        images_of(&w.su, proposed).await,
        3,
        "and its pictures were not reclaimed by the sweep"
    );
    // the confirmed set can still be written to, and the unconfirmed one cannot
    still(&w, tc.owner(), confirmed, 0, decoded_still())
        .await
        .unwrap()
        .expect("still alive");
    assert_eq!(
        still(&w, tu.owner(), unconfirmed, 0, decoded_still())
            .await
            .unwrap(),
        Err(Refusal::InvalidArguments)
    );
    // while the confirmed set lives, a second begin of the same agent is refused
    let again = Tenant {
        run: tc.run_again,
        ..tc
    };
    assert_eq!(
        begin(&w, again, plan("dd")).await.unwrap().unwrap_err(),
        Refusal::SetBusy
    );
}

#[tokio::test]
#[ignore = "needs a dedicated PG18 DATABASE_URL"]
async fn renditions_round_trip_and_the_gif_base_is_the_stored_large_still() {
    let w = world().await;
    let t = tenant(&w.su).await;
    let owner = t.owner();
    let id = begun(&w, t, plan("rt")).await;
    // the GIF slot (2) is based on slot 0, which is not made yet
    let base = |index: u8| {
        let worker = w.worker.clone();
        async move {
            in_tx(&worker, owner.workspace, move |c| {
                Box::pin(async move { set::base_large_in_tx(c, owner, id, index).await })
            })
            .await
            .unwrap()
        }
    };
    assert!(base(2).await.is_none(), "no stored base yet");
    let media = decoded_still();
    let stored = still(&w, owner, id, 0, media.clone())
        .await
        .unwrap()
        .expect("first still");
    assert_eq!(
        stored.bytes,
        media
            .variants()
            .iter()
            .map(|(_, r)| r.data.len() as i64)
            .sum::<i64>()
    );
    let rows = sqlx::query("SELECT variant, mime, sha256, octet_length(bytes) AS len FROM expression_set_image WHERE set_id = $1 AND slot_index = 0 ORDER BY variant")
        .bind(id).fetch_all(&w.su).await.unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r.get::<String, _>("variant"))
            .collect::<Vec<_>>(),
        ["large", "small", "thumb"]
    );
    for row in &rows {
        let variant: String = row.get("variant");
        let want = match variant.as_str() {
            "large" => &media.large,
            "small" => &media.small,
            _ => &media.thumb,
        };
        assert_eq!(row.get::<String, _>("sha256"), want.info.sha256);
        assert_eq!(row.get::<String, _>("mime"), want.info.mime);
        assert_eq!(row.get::<i32, _>("len") as usize, want.data.len());
    }
    let stored_large = base(2).await.expect("the base is the stored large still");
    assert_eq!(stored_large.info.sha256, media.large.info.sha256);
    assert_eq!(
        stored_large.data, media.large.data,
        "bytes round-trip whole"
    );
    assert!(
        base(0).await.is_none() && base(1).await.is_none(),
        "a still slot has no base"
    );
    // kinds: a GIF cannot go in a still slot, a still cannot go in a GIF slot, and nothing is written
    let gif = decoded_gif();
    let before = images_of(&w.su, id).await;
    let put_gif = |index: u8, media: e::media::Processed| {
        let worker = w.worker.clone();
        async move {
            in_tx(&worker, owner.workspace, move |c| {
                Box::pin(async move { set::put_gif_in_tx(c, owner, id, index, &media).await })
            })
            .await
            .unwrap()
        }
    };
    assert_eq!(
        still(&w, owner, id, 1, gif.clone()).await.unwrap(),
        Err(Refusal::InvalidArguments),
        "gif media in a still slot"
    );
    assert_eq!(
        still(&w, owner, id, 2, media.clone()).await.unwrap(),
        Err(Refusal::InvalidArguments),
        "still media in a gif slot"
    );
    assert_eq!(
        put_gif(1, gif.clone()).await,
        Err(Refusal::InvalidArguments),
        "put_gif on a still slot"
    );
    assert_eq!(
        put_gif(2, media.clone()).await,
        Err(Refusal::InvalidArguments),
        "put_gif with a still"
    );
    assert_eq!(images_of(&w.su, id).await, before);
    let made = put_gif(2, gif.clone()).await.expect("the assembled GIF");
    assert!(made.bytes > 0);
    let held = get(&w, owner, id).await.unwrap();
    assert_eq!(
        (held.slots[2].state.as_str(), held.slots[2].renditions),
        ("ready", 3)
    );
    assert_eq!(held.stored_bytes, stored.bytes + made.bytes);
    let large_mime: String = sqlx::query_scalar("SELECT mime FROM expression_set_image WHERE set_id = $1 AND slot_index = 2 AND variant = 'large'").bind(id).fetch_one(&w.su).await.unwrap();
    assert_eq!(large_mime, "image/gif");
    // a gray base leaves the GIF without a base: `base_missing`
    let t2 = tenant(&w.su).await;
    let id2 = begun(&w, t2, plan("rg")).await;
    gray(&w, t2.owner(), id2, 0, GrayCode::Refused)
        .await
        .unwrap()
        .unwrap();
    let o2 = t2.owner();
    let none = in_tx(&w.worker, t2.ws, move |c| {
        Box::pin(async move { set::base_large_in_tx(c, o2, id2, 2).await })
    })
    .await
    .unwrap();
    assert!(none.is_none(), "a gray base gives the assembler nothing");
    gray(&w, t2.owner(), id2, 2, GrayCode::BaseMissing)
        .await
        .unwrap()
        .expect("the GIF closes base_missing");
    assert_eq!(
        slot_state(&w.su, id2, 2).await,
        ("gray".into(), Some("base_missing".into()))
    );
}
