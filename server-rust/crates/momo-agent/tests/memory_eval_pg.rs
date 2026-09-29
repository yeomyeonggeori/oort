//! MEM-M0 evaluation set — PG half (#3160). Seeds the permission-leak scenario
//! through the real message spine and checks the seed itself is faithful, so the
//! M1 RLS tests can trust it.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-agent --test memory_eval_pg -- --ignored --test-threads=1
//! ```
//! The final test (`red_*`) is expected to FAIL until the M1 read policy exists.

mod eval_kit;

use std::path::PathBuf;
use std::process::Command;

use eval_kit::corpus::*;
use eval_kit::harness::Mutation;
use eval_kit::pg;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

fn url() -> String {
    std::env::var("DATABASE_URL").expect("DATABASE_URL must point at a throwaway DB")
}

async fn pools() -> (PgPool, PgPool) {
    let su = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url())
        .await
        .expect("superuser");
    let opts: PgConnectOptions = url().parse().unwrap();
    let pw = std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into());
    let app = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(opts.username("momo_app").password(&pw))
        .await
        .expect("connect as momo_app (bootstrap_roles.sql first)");
    (su, app)
}

fn prepare() {
    run_migrations(&url(), &default_migrations_dir(), SeedMode::None).expect("migrations");
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    root.pop();
    root.pop();
    root.pop();
    let psql = std::env::var("PSQL_BIN").unwrap_or_else(|_| "psql".into());
    let ok = Command::new(psql)
        .arg(url())
        .args(["-v", "ON_ERROR_STOP=1", "-f"])
        .arg(root.join("infra/rust/sql/bootstrap_roles.sql"))
        .status()
        .expect("psql")
        .success();
    assert!(ok, "bootstrap_roles.sql");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (isolated PG)"]
async fn leak_scenario_seeds_faithfully() {
    prepare();
    let (su, app) = pools().await;
    let corpus = generate(SEED);
    let s = pg::seed(&su, &app, &corpus).await;

    for ch in Channel::ALL {
        let want = corpus.messages.iter().filter(|m| m.channel == ch).count() as i64;
        let (n, last): (i64, i64) = sqlx::query_as(
            "SELECT count(*), (SELECT last_seq FROM channel_seq WHERE channel_id = $1) \
             FROM message WHERE channel_id = $1",
        )
        .bind(s.channel[&ch])
        .fetch_one(&su)
        .await
        .unwrap();
        assert_eq!(
            (n, last),
            (want, want),
            "{}: rows and gapless channel_seq",
            ch.label()
        );
        let (members,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM membership WHERE channel_id = $1 AND left_at IS NULL",
        )
        .bind(s.channel[&ch])
        .fetch_one(&su)
        .await
        .unwrap();
        assert_eq!(members as usize, ch.members().len());
    }
    // Z is in #general and NOT in #hr / the DM; the thread reply carries its root.
    let (z_hr,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM membership WHERE member_id = $1 AND channel_id <> $2")
            .bind(s.member[&Who::Z])
            .bind(s.channel[&Channel::General])
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(z_hr, 0);
    let threaded = corpus
        .messages
        .iter()
        .find(|m| m.root.is_some())
        .expect("thread reply");
    let (root,): (Option<uuid::Uuid>,) =
        sqlx::query_as("SELECT root_id FROM message WHERE id = $1")
            .bind(s.message[&threaded.key])
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(root, Some(s.message[threaded.root.as_ref().unwrap()]));

    // Mutations used by the leak cases land in the rows the M1 policy will read.
    let canary = &corpus.canaries[0];
    pg::apply_mutation(&su, &s, &Mutation::Leave(Who::X, Channel::Hr)).await;
    pg::apply_mutation(&su, &s, &Mutation::Delete(canary.message_key.clone())).await;
    let (left,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM membership WHERE channel_id = $1 AND member_id = $2 AND left_at IS NOT NULL",
    )
    .bind(s.channel[&Channel::Hr])
    .bind(s.member[&Who::X])
    .fetch_one(&su)
    .await
    .unwrap();
    let (state,): (String,) = sqlx::query_as("SELECT state::text FROM message WHERE id = $1")
        .bind(s.message[&canary.message_key])
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!((left, state.as_str()), (1, "deleted"));
}

#[tokio::test]
#[ignore = "RED until MEM-M1: no memory read policy / serving path exists"]
async fn red_no_memory_read_policy_exists_yet() {
    prepare();
    let (su, _app) = pools().await;
    let (n,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'mem\\_%'",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(
        n > 0,
        "no mem_* tables: the M1 schema and its RLS read policy are absent"
    );
}
