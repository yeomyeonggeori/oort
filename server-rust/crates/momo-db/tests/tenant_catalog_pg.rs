//! SEC-04 (#4242): tenant catalog invariants, replacing the `forced >= 30`
//! floor with the property it stood in for (AGENTS.md: every tenant path is
//! `workspace_id` + RLS FORCE + `SET LOCAL app.workspace_id`).
//!
//! Needs a database that already has every migration plus
//! `infra/rust/sql/bootstrap_roles.sql` applied (what `momo-migrate migrate`
//! leaves behind in dev/CI), and a superuser `DATABASE_URL`:
//!   DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!     cargo test -p momo-db --test tenant_catalog_pg -- --ignored --test-threads=1
//!
//! Two kinds of tests:
//!  * `the_real_database_*` assert zero violations against the live catalog;
//!  * `control_*` build one deliberately broken object in a scratch schema and
//!    require the **same** check function to name exactly that object, so a
//!    check that went blind (or always red) is itself caught.

mod common;

use common::{
    definer_search_path_violations, public_definer_violations, tenant_rls_violations,
    tenant_table_count, unforced_dml_violations, untracked_table_violations, NON_TENANT_TABLES,
    PUBLIC_DEFINER_FUNCTIONS,
};
use momo_db::sqlx;
use momo_db::PgPool;
use std::sync::OnceLock;

const SCRATCH: &str = "sec04_neg";
const APP_ROLE: &str = "momo_app";

/// The real-database scan sees every schema, the controls create one: they
/// must not interleave.
async fn lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .expect("set DATABASE_URL to a migrated superuser pgvector/pg18 DB");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect");
    let migrated: bool = sqlx::query_scalar("SELECT to_regclass('public.workspace') IS NOT NULL")
        .fetch_one(&pool)
        .await
        .expect("probe");
    assert!(
        migrated,
        "apply the migrations (and bootstrap_roles.sql) first"
    );
    pool
}

/// Run `ddl` in a fresh scratch schema, evaluate `check` against only that
/// schema, drop the schema, and return what the check reported. The schema is
/// dropped before any assertion so a red control cannot leave it behind.
async fn in_scratch<F, Fut>(pool: &PgPool, ddl: &str, check: F) -> Vec<String>
where
    F: FnOnce(PgPool, &'static [&'static str]) -> Fut,
    Fut: std::future::Future<Output = Vec<String>>,
{
    static SCHEMAS: [&str; 1] = [SCRATCH];
    sqlx::raw_sql(&format!(
        "DROP SCHEMA IF EXISTS {SCRATCH} CASCADE; CREATE SCHEMA {SCRATCH};"
    ))
    .execute(pool)
    .await
    .expect("create scratch schema");
    let built = sqlx::raw_sql(ddl).execute(pool).await;
    let found = if built.is_ok() {
        check(pool.clone(), &SCHEMAS).await
    } else {
        Vec::new()
    };
    sqlx::raw_sql(&format!("DROP SCHEMA IF EXISTS {SCRATCH} CASCADE"))
        .execute(pool)
        .await
        .expect("drop scratch schema");
    built.expect("scratch DDL must apply");
    found
}

fn names_only(found: &[String], object: &str) -> bool {
    found.len() == 1 && found[0].starts_with(object)
}

// ---------------------------------------------------------------- real DB ---

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_has_rls_force_and_a_workspace_policy_on_every_tenant_table() {
    let _guard = lock().await;
    let pool = pool().await;
    let tenant = tenant_table_count(&pool, None).await;
    assert!(
        tenant > 0,
        "the scan found no workspace_id table at all: the check is blind"
    );
    let violations = tenant_rls_violations(&pool, None).await;
    assert!(
        violations.is_empty(),
        "tenant tables must have RLS enabled + FORCEd + a permissive SELECT policy on app.workspace_id: {violations:#?}"
    );
    println!("tenant catalog: {tenant} workspace_id tables, 0 violations");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_has_no_unclassified_non_tenant_table() {
    let _guard = lock().await;
    let pool = pool().await;
    for (name, reason) in NON_TENANT_TABLES {
        assert!(
            reason.len() > 20,
            "{name}: the allowlist reason must say something"
        );
    }
    let violations = untracked_table_violations(&pool, None).await;
    assert!(
        violations.is_empty(),
        "tables without workspace_id must be classified in NON_TENANT_TABLES: {violations:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_pins_search_path_on_every_security_definer() {
    let _guard = lock().await;
    let pool = pool().await;
    let definers: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_proc WHERE prosecdef")
        .fetch_one(&pool)
        .await
        .expect("count definers");
    assert!(
        definers > 0,
        "no SECURITY DEFINER function found: the check is blind"
    );
    let violations = definer_search_path_violations(&pool, None).await;
    assert!(
        violations.is_empty(),
        "every SECURITY DEFINER function must SET search_path (pg_temp last): {violations:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_public_security_definers_equal_the_allowlist() {
    let _guard = lock().await;
    let pool = pool().await;
    assert!(!PUBLIC_DEFINER_FUNCTIONS.is_empty());
    let violations = public_definer_violations(&pool, None).await;
    assert!(
        violations.is_empty(),
        "PUBLIC-executable SECURITY DEFINER functions must equal PUBLIC_DEFINER_FUNCTIONS: {violations:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_gives_momo_app_no_dml_on_an_unforced_tenant_table() {
    let _guard = lock().await;
    let pool = pool().await;
    let violations = unforced_dml_violations(&pool, APP_ROLE, None).await;
    assert!(
        violations.is_empty(),
        "{APP_ROLE} must have no DML on a tenant table without enabled+FORCEd RLS: {violations:#?}"
    );
}

// ------------------------------------------------------- negative controls ---

const GOOD_TABLE: &str =
    "CREATE TABLE sec04_neg.good (id int PRIMARY KEY, workspace_id uuid NOT NULL);
     ALTER TABLE sec04_neg.good ENABLE ROW LEVEL SECURITY;
     ALTER TABLE sec04_neg.good FORCE ROW LEVEL SECURITY;
     CREATE POLICY ws ON sec04_neg.good
       USING (workspace_id = current_setting('app.workspace_id', true)::uuid);";

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_a_correct_tenant_table_passes_every_check() {
    let _guard = lock().await;
    let pool = pool().await;
    // momo_app holds full DML here, which is fine because RLS is FORCEd.
    let ddl = format!("{GOOD_TABLE} GRANT ALL ON sec04_neg.good TO momo_app;");
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        let mut all = tenant_rls_violations(&p, Some(s)).await;
        all.extend(unforced_dml_violations(&p, APP_ROLE, Some(s)).await);
        all.extend(untracked_table_violations(&p, Some(s)).await);
        all
    })
    .await;
    assert!(
        found.is_empty(),
        "a well-formed tenant table must not be reported: {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_force_missing_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = GOOD_TABLE.replace("ALTER TABLE sec04_neg.good FORCE ROW LEVEL SECURITY;", "");
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s)).await
    })
    .await;
    assert!(
        names_only(&found, "sec04_neg.good: RLS is not FORCEd"),
        "got {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_rls_disabled_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = "CREATE TABLE sec04_neg.bare (id int PRIMARY KEY, workspace_id uuid NOT NULL);";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s)).await
    })
    .await;
    assert!(
        names_only(&found, "sec04_neg.bare: RLS is not enabled"),
        "got {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_force_and_policy_without_enable_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    // FORCE and a good policy, but RLS never ENABLEd: the policy is inert.
    let ddl = GOOD_TABLE.replace("ALTER TABLE sec04_neg.good ENABLE ROW LEVEL SECURITY;", "");
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s)).await
    })
    .await;
    assert!(
        names_only(&found, "sec04_neg.good: RLS is not enabled"),
        "got {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_policy_missing_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = GOOD_TABLE.replace("CREATE POLICY ws ON sec04_neg.good", "-- no policy: ");
    // the USING line is now a dangling comment continuation: drop it too
    let ddl = ddl.replace(
        "USING (workspace_id = current_setting('app.workspace_id', true)::uuid);",
        "",
    );
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s)).await
    })
    .await;
    assert!(
        names_only(&found, "sec04_neg.good: no policy"),
        "got {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_policy_that_ignores_workspace_id_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = GOOD_TABLE.replace(
        "USING (workspace_id = current_setting('app.workspace_id', true)::uuid)",
        "USING (true)",
    );
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s)).await
    })
    .await;
    assert!(
        names_only(
            &found,
            "sec04_neg.good: no permissive SELECT policy references app.workspace_id"
        ),
        "got {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_update_only_workspace_policy_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    // The workspace_id policy exists but covers UPDATE only, and the SELECT
    // side is `true`: reads cross tenants. Must not count as a tenant policy.
    let ddl = "CREATE TABLE sec04_neg.half (id int PRIMARY KEY, workspace_id uuid NOT NULL);
         ALTER TABLE sec04_neg.half ENABLE ROW LEVEL SECURITY;
         ALTER TABLE sec04_neg.half FORCE ROW LEVEL SECURITY;
         CREATE POLICY r ON sec04_neg.half FOR SELECT USING (true);
         CREATE POLICY w ON sec04_neg.half FOR UPDATE
           USING (workspace_id = current_setting('app.workspace_id', true)::uuid);";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s)).await
    })
    .await;
    assert!(names_only(&found, "sec04_neg.half:"), "got {found:#?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_unclassified_table_without_workspace_id_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = "CREATE TABLE sec04_neg.orphan (id int PRIMARY KEY, tenant uuid NOT NULL);";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        untracked_table_violations(&p, Some(s)).await
    })
    .await;
    assert!(names_only(&found, "sec04_neg.orphan:"), "got {found:#?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_definer_without_search_path_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl =
        "CREATE FUNCTION sec04_neg.loose() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
         REVOKE ALL ON FUNCTION sec04_neg.loose() FROM PUBLIC;
         CREATE FUNCTION sec04_neg.tight() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS 'SELECT 1';
         REVOKE ALL ON FUNCTION sec04_neg.tight() FROM PUBLIC;
         CREATE FUNCTION sec04_neg.temp_first() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_temp, pg_catalog AS 'SELECT 1';
         REVOKE ALL ON FUNCTION sec04_neg.temp_first() FROM PUBLIC;";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        definer_search_path_violations(&p, Some(s)).await
    })
    .await;
    assert_eq!(
        found.len(),
        2,
        "loose and temp_first, never tight: {found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.loose(): SECURITY DEFINER without")),
        "{found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.temp_first(): search_path puts pg_temp")),
        "{found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_unlisted_public_definer_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    // `exposed` keeps Postgres' default EXECUTE-to-PUBLIC; `sealed` revokes it.
    let ddl = "CREATE FUNCTION sec04_neg.exposed() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS 'SELECT 1';
         CREATE FUNCTION sec04_neg.sealed() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS 'SELECT 1';
         REVOKE ALL ON FUNCTION sec04_neg.sealed() FROM PUBLIC;
         CREATE FUNCTION sec04_neg.invoker() RETURNS int LANGUAGE sql AS 'SELECT 1';";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        public_definer_violations(&p, Some(s)).await
    })
    .await;
    assert!(names_only(&found, "sec04_neg.exposed:"), "got {found:#?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_momo_app_dml_on_an_unforced_tenant_table_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = "CREATE TABLE sec04_neg.leaky (id int PRIMARY KEY, workspace_id uuid NOT NULL);
         GRANT SELECT, INSERT ON sec04_neg.leaky TO momo_app;
         CREATE TABLE sec04_neg.sealed (id int PRIMARY KEY, workspace_id uuid NOT NULL);
         REVOKE ALL ON sec04_neg.sealed FROM momo_app;";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        unforced_dml_violations(&p, APP_ROLE, Some(s)).await
    })
    .await;
    assert!(
        names_only(&found, "sec04_neg.leaky: momo_app has SELECT,INSERT"),
        "got {found:#?}"
    );
}
