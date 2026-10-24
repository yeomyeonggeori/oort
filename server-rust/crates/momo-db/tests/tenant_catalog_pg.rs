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
    app_definer_violations, app_definer_violations_against, definer_search_path_violations,
    definer_search_path_violations_against, exposed_relation_violations,
    non_tenant_policy_violations, non_tenant_policy_violations_against, policy_fingerprint,
    public_definer_violations, public_definer_violations_against, role_boundary_violations,
    table_policy_fingerprint, tenant_rls_violations, tenant_rls_violations_against,
    tenant_table_count, unforced_dml_violations, unprotected_write_violations,
    untracked_table_violations, GUC_GATED_POLICIES, NON_TENANT_POLICY_PINS, NON_TENANT_TABLES,
    PG_CATALOG_ONLY_DEFINERS, PUBLIC_DEFINER_FUNCTIONS,
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
    let violations = tenant_rls_violations(&pool, None, APP_ROLE).await;
    assert!(
        violations.is_empty(),
        "tenant tables must have RLS enabled + FORCEd, a SELECT policy on app.workspace_id, and no permissive policy that ignores it: {violations:#?}"
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
    for (name, _hash, reason) in PG_CATALOG_ONLY_DEFINERS {
        assert!(
            reason.len() > 20,
            "{name}: the allowlist reason must say something"
        );
    }
    for (name, _hash, reason) in GUC_GATED_POLICIES {
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

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_keeps_momo_app_inside_the_rls_boundary() {
    let _guard = lock().await;
    let pool = pool().await;
    let violations = role_boundary_violations(&pool, APP_ROLE, None).await;
    assert!(
        violations.is_empty(),
        "{APP_ROLE} must be no superuser/BYPASSRLS, own no tenant table, hold no TRUNCATE on one: {violations:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_exposes_no_view_or_foreign_relation_to_momo_app() {
    let _guard = lock().await;
    let pool = pool().await;
    let violations = exposed_relation_violations(&pool, APP_ROLE, None).await;
    assert!(
        violations.is_empty(),
        "views need security_invoker, materialized/foreign relations cannot be reachable: {violations:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_unprotected_writable_tables_equal_the_known_list() {
    let _guard = lock().await;
    let pool = pool().await;
    let violations = unprotected_write_violations(&pool, APP_ROLE, None).await;
    assert!(
        violations.is_empty(),
        "tables with no workspace_id and no RLS that {APP_ROLE} can write must equal KNOWN_UNPROTECTED_NON_TENANT: {violations:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_non_tenant_policies_are_unchanged_since_review() {
    let _guard = lock().await;
    let pool = pool().await;
    assert!(!NON_TENANT_POLICY_PINS.is_empty());
    let violations = non_tenant_policy_violations(&pool).await;
    assert!(
        violations.is_empty(),
        "non-tenant tables must keep RLS enabled+FORCEd and their reviewed policies: {violations:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn the_real_database_momo_app_executes_only_the_listed_security_definers() {
    let _guard = lock().await;
    let pool = pool().await;
    let violations = app_definer_violations(&pool, APP_ROLE, None).await;
    assert!(
        violations.is_empty(),
        "SECURITY DEFINER functions executable by {APP_ROLE} must equal APP_EXECUTABLE_DEFINERS: {violations:#?}"
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
        let mut all = tenant_rls_violations(&p, Some(s), APP_ROLE).await;
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
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
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
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
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
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
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
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
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
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
    })
    .await;
    assert!(
        found.contains(
            &"sec04_neg.good: no permissive SELECT policy references app.workspace_id".to_string()
        ) && found.iter().all(|l| l.starts_with("sec04_neg.good:")),
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
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
    })
    .await;
    assert!(
        found.contains(
            &"sec04_neg.half: no permissive SELECT policy references app.workspace_id".to_string()
        ) && found.iter().all(|l| l.starts_with("sec04_neg.half:")),
        "got {found:#?}"
    );
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
         REVOKE ALL ON FUNCTION sec04_neg.temp_first() FROM PUBLIC;
         CREATE FUNCTION sec04_neg.no_temp() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog AS 'SELECT 1';
         REVOKE ALL ON FUNCTION sec04_neg.no_temp() FROM PUBLIC;";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        definer_search_path_violations(&p, Some(s)).await
    })
    .await;
    assert_eq!(
        found.len(),
        3,
        "loose, temp_first and no_temp, never tight: {found:#?}"
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
            .any(|l| l.starts_with("sec04_neg.temp_first(): search_path must name pg_temp")),
        "{found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.no_temp(): search_path must name pg_temp")),
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
    assert!(names_only(&found, "sec04_neg.exposed():"), "got {found:#?}");
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

const MD5_SELECT_1: &str = "b1698e52a0f16203489454196a0c6307"; // md5('SELECT 1'), the prosrc of the scratch definers

const GOOD_POLICY_LINE: &str = "CREATE POLICY ws ON sec04_neg.good";

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_open_policy_beside_a_good_one_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    // Permissive policies are OR-ed: the good `ws` policy does not save the
    // table from a second one that says `true`.
    let ddl = format!("{GOOD_TABLE} CREATE POLICY leak ON sec04_neg.good FOR SELECT USING (true);");
    assert!(ddl.contains(GOOD_POLICY_LINE));
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
    })
    .await;
    assert!(
        names_only(
            &found,
            "sec04_neg.good: permissive policy leak (SELECT) does not tie its rows to app.workspace_id"
        ),
        "got {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_write_policies_that_skip_the_workspace_check_are_red() {
    let _guard = lock().await;
    let pool = pool().await;
    // INSERT ... WITH CHECK (true), and UPDATE whose USING is fine but whose
    // WITH CHECK is `true` (a row can be moved into another tenant).
    let ddl = "CREATE TABLE sec04_neg.w (id int PRIMARY KEY, workspace_id uuid NOT NULL);
         ALTER TABLE sec04_neg.w ENABLE ROW LEVEL SECURITY;
         ALTER TABLE sec04_neg.w FORCE ROW LEVEL SECURITY;
         CREATE POLICY r ON sec04_neg.w FOR SELECT
           USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
         CREATE POLICY ins ON sec04_neg.w FOR INSERT WITH CHECK (true);
         CREATE POLICY upd ON sec04_neg.w FOR UPDATE
           USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
           WITH CHECK (true);
         CREATE TABLE sec04_neg.w_ok (id int PRIMARY KEY, workspace_id uuid NOT NULL);
         ALTER TABLE sec04_neg.w_ok ENABLE ROW LEVEL SECURITY;
         ALTER TABLE sec04_neg.w_ok FORCE ROW LEVEL SECURITY;
         CREATE POLICY a ON sec04_neg.w_ok FOR ALL
           USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
           WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
    })
    .await;
    assert_eq!(
        found.len(),
        2,
        "ins and upd of w only, never w_ok: {found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.w: permissive policy ins (INSERT)")),
        "{found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.w: permissive policy upd (UPDATE)")),
        "{found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_policy_that_only_quotes_the_guc_name_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    // `app.workspace_id` appears, but only inside a string literal.
    let ddl = GOOD_TABLE.replace(
        "USING (workspace_id = current_setting('app.workspace_id', true)::uuid)",
        "USING (workspace_id::text <> 'app.workspace_id')",
    );
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
    })
    .await;
    assert!(
        found.contains(
            &"sec04_neg.good: permissive policy ws (ALL) does not tie its rows to app.workspace_id"
                .to_string()
        ) && found.iter().all(|l| l.starts_with("sec04_neg.good:")),
        "got {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_open_policy_for_another_role_is_not_judged() {
    let _guard = lock().await;
    let pool = pool().await;
    // A permissive `true` policy TO a role momo_app is not a member of does
    // not reach momo_app; TO momo_app itself it does.
    let ddl = format!(
        "DROP ROLE IF EXISTS sec04_neg_other;
         CREATE ROLE sec04_neg_other NOLOGIN;
         {GOOD_TABLE}
         CREATE POLICY other ON sec04_neg.good FOR SELECT TO sec04_neg_other USING (true);
         CREATE TABLE sec04_neg.mine (id int PRIMARY KEY, workspace_id uuid NOT NULL);
         ALTER TABLE sec04_neg.mine ENABLE ROW LEVEL SECURITY;
         ALTER TABLE sec04_neg.mine FORCE ROW LEVEL SECURITY;
         CREATE POLICY r ON sec04_neg.mine FOR SELECT
           USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
         CREATE POLICY open ON sec04_neg.mine FOR SELECT TO momo_app USING (true);"
    );
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        tenant_rls_violations(&p, Some(s), APP_ROLE).await
    })
    .await;
    sqlx::raw_sql("DROP ROLE IF EXISTS sec04_neg_other")
        .execute(&pool)
        .await
        .expect("drop scratch role");
    assert!(
        names_only(
            &found,
            "sec04_neg.mine: permissive policy open (SELECT) does not tie"
        ),
        "got {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_views_and_materialized_views_are_red_unless_security_invoker() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = format!(
        "{GOOD_TABLE}
         CREATE VIEW sec04_neg.v_plain AS SELECT * FROM sec04_neg.good;
         CREATE VIEW sec04_neg.v_invoker WITH (security_invoker = true) AS SELECT * FROM sec04_neg.good;
         CREATE MATERIALIZED VIEW sec04_neg.mv AS SELECT * FROM sec04_neg.good;
         CREATE VIEW sec04_neg.v_closed AS SELECT 1 AS x;
         GRANT SELECT ON sec04_neg.v_plain, sec04_neg.v_invoker, sec04_neg.mv TO momo_app;
         REVOKE ALL ON sec04_neg.v_closed FROM momo_app;"
    );
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        exposed_relation_violations(&p, APP_ROLE, Some(s)).await
    })
    .await;
    assert_eq!(
        found.len(),
        2,
        "v_plain and mv, never the invoker/closed view: {found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.v_plain: view without security_invoker")),
        "{found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.mv: materialized view")),
        "{found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_bypass_owner_and_truncate_are_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = format!(
        "DROP ROLE IF EXISTS sec04_neg_byp;
         CREATE ROLE sec04_neg_byp NOLOGIN BYPASSRLS;
         {GOOD_TABLE}
         ALTER TABLE sec04_neg.good OWNER TO sec04_neg_byp;"
    );
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        role_boundary_violations(&p, "sec04_neg_byp", Some(s)).await
    })
    .await;
    // second role: a plain role that can TRUNCATE
    let ddl2 = format!(
        "DROP ROLE IF EXISTS sec04_neg_trunc;
         CREATE ROLE sec04_neg_trunc NOLOGIN;
         {GOOD_TABLE}
         GRANT TRUNCATE ON sec04_neg.good TO sec04_neg_trunc;"
    );
    let found2 = in_scratch(&pool, &ddl2, |p, s| async move {
        role_boundary_violations(&p, "sec04_neg_trunc", Some(s)).await
    })
    .await;
    let clean = in_scratch(
        &pool,
        &format!("{GOOD_TABLE} GRANT ALL ON sec04_neg.good TO momo_app;"),
        |p, s| async move {
            let mut all = role_boundary_violations(&p, APP_ROLE, Some(s)).await;
            all.retain(|l| !l.contains("TRUNCATE"));
            all
        },
    )
    .await;
    sqlx::raw_sql("DROP ROLE IF EXISTS sec04_neg_byp; DROP ROLE IF EXISTS sec04_neg_trunc;")
        .execute(&pool)
        .await
        .expect("drop scratch roles");
    assert!(
        found.iter().any(|l| l == "sec04_neg_byp: has BYPASSRLS"),
        "{found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.good: sec04_neg_byp owns a tenant table")),
        "{found:#?}"
    );
    assert!(
        names_only(&found2, "sec04_neg.good: sec04_neg_trunc can TRUNCATE"),
        "{found2:#?}"
    );
    assert!(
        clean.is_empty(),
        "momo_app with plain DML is fine: {clean:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_a_new_overload_cannot_hide_behind_an_allowlisted_name() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = "CREATE FUNCTION sec04_neg.f(a int) RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS 'SELECT 1';
         CREATE FUNCTION sec04_neg.f(a text) RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS 'SELECT 1';";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        public_definer_violations_against(&p, Some(s), &["sec04_neg.f(integer)"]).await
    })
    .await;
    assert!(names_only(&found, "sec04_neg.f(text):"), "got {found:#?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_writable_table_without_rls_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = "CREATE TABLE sec04_neg.open_cfg (k text PRIMARY KEY);
         GRANT SELECT, INSERT ON sec04_neg.open_cfg TO momo_app;
         CREATE TABLE sec04_neg.read_only_cfg (k text PRIMARY KEY);
         GRANT SELECT ON sec04_neg.read_only_cfg TO momo_app;
         CREATE TABLE sec04_neg.guarded_cfg (k text PRIMARY KEY);
         ALTER TABLE sec04_neg.guarded_cfg ENABLE ROW LEVEL SECURITY;
         GRANT ALL ON sec04_neg.guarded_cfg TO momo_app;";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        unprotected_write_violations(&p, APP_ROLE, Some(s)).await
    })
    .await;
    assert!(names_only(&found, "sec04_neg.open_cfg:"), "got {found:#?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_pg_catalog_only_exception_is_exact() {
    let _guard = lock().await;
    let pool = pool().await;
    // `ok_listed` is the reviewed shape. `listed_but_widened` is on the list
    // yet its search_path grew `public`: the exception must not cover it.
    // `unlisted_catalog_only` has the same config as `ok_listed` but is not
    // on the list.
    let ddl = "CREATE FUNCTION sec04_neg.ok_listed() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog AS 'SELECT 1';
         CREATE FUNCTION sec04_neg.listed_but_widened() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, public AS 'SELECT 1';
         CREATE FUNCTION sec04_neg.unlisted_catalog_only() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog AS 'SELECT 1';
         CREATE FUNCTION sec04_neg.edited_body() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog AS 'SELECT 2';
         REVOKE ALL ON FUNCTION sec04_neg.ok_listed(), sec04_neg.listed_but_widened(),
           sec04_neg.unlisted_catalog_only(), sec04_neg.edited_body() FROM PUBLIC;";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        definer_search_path_violations_against(
            &p,
            Some(s),
            &[
                ("sec04_neg.ok_listed()", MD5_SELECT_1, "reviewed"),
                ("sec04_neg.listed_but_widened()", MD5_SELECT_1, "reviewed"),
                ("sec04_neg.edited_body()", MD5_SELECT_1, "reviewed"),
            ],
        )
        .await
    })
    .await;
    assert_eq!(
        found.len(),
        3,
        "widened, unlisted and edited-body only, never ok_listed: {found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.edited_body():")),
        "{found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.listed_but_widened():")),
        "{found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.unlisted_catalog_only():")),
        "{found:#?}"
    );
}

const WS_EQ: &str = "workspace_id = current_setting('app.workspace_id', true)::uuid";

/// One RLS-enabled tenant table `t` whose only SELECT policy is `using`.
fn table_with_select_policy(using: &str) -> String {
    format!(
        "CREATE TABLE sec04_neg.t (id int PRIMARY KEY, other uuid, workspace_id uuid NOT NULL);
         ALTER TABLE sec04_neg.t ENABLE ROW LEVEL SECURITY;
         ALTER TABLE sec04_neg.t FORCE ROW LEVEL SECURITY;
         CREATE POLICY p ON sec04_neg.t FOR SELECT USING ({using});"
    )
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_policy_shapes_that_look_tied_but_are_open_are_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let open = [
        format!("{WS_EQ} OR true"),
        "current_setting('app.workspace_id', true) IS NOT NULL".to_string(),
        "other = current_setting('app.workspace_id', true)::uuid".to_string(),
        format!("{WS_EQ} OR other IS NOT NULL"),
        format!("({WS_EQ}) OR (id > 0)"),
    ];
    for using in &open {
        let found = in_scratch(&pool, &table_with_select_policy(using), |p, s| async move {
            tenant_rls_violations(&p, Some(s), APP_ROLE).await
        })
        .await;
        assert!(
            found.iter().any(|l| l == "sec04_neg.t: permissive policy p (SELECT) does not tie its rows to app.workspace_id"),
            "{using} must be red: {found:#?}"
        );
    }
    // and the shapes the real schema uses stay green
    let tied = [
        WS_EQ.to_string(),
        "workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid".to_string(),
        format!("{WS_EQ} AND id > 0"),
        format!("{WS_EQ} AND (other IS NULL OR id > 0)"),
        format!("({WS_EQ} AND id > 0) OR ({WS_EQ} AND other IS NULL)"),
    ];
    for using in &tied {
        let found = in_scratch(&pool, &table_with_select_policy(using), |p, s| async move {
            tenant_rls_violations(&p, Some(s), APP_ROLE).await
        })
        .await;
        assert!(found.is_empty(), "{using} must be green: {found:#?}");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_allowlisted_policy_is_exempt_only_while_its_text_is_unchanged() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = table_with_select_policy("true");
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        let fp = policy_fingerprint(&p, "sec04_neg.t", "p").await;
        let key = "sec04_neg.t.p";
        let mut all = tenant_rls_violations_against(
            &p,
            Some(s),
            APP_ROLE,
            &[(key, &fp, "reviewed open policy")],
        )
        .await;
        // pinned and unchanged: only the table-level SELECT rule speaks
        all.retain(|l| !l.contains("no permissive SELECT policy"));
        sqlx::raw_sql("ALTER POLICY p ON sec04_neg.t USING (id >= 0)")
            .execute(&p)
            .await
            .expect("alter policy");
        all.push("---".to_string());
        all.extend(
            tenant_rls_violations_against(
                &p,
                Some(s),
                APP_ROLE,
                &[(key, &fp, "reviewed open policy")],
            )
            .await,
        );
        all
    })
    .await;
    let (before, after) = found.split_at(found.iter().position(|l| l == "---").unwrap());
    assert!(
        before.is_empty(),
        "pinned policy must be exempt: {before:#?}"
    );
    assert!(
        after
            .iter()
            .any(|l| l.starts_with("sec04_neg.t: allowlisted policy p (SELECT) changed")),
        "an edited allowlisted policy must be red: {after:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_non_tenant_policy_pin_catches_an_edited_policy_and_disabled_rls() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = "CREATE TABLE sec04_neg.cfg (k text PRIMARY KEY);
         ALTER TABLE sec04_neg.cfg ENABLE ROW LEVEL SECURITY;
         ALTER TABLE sec04_neg.cfg FORCE ROW LEVEL SECURITY;
         CREATE POLICY op ON sec04_neg.cfg USING (current_setting('app.x', true) = 'on');";
    let found = in_scratch(&pool, ddl, |p, _s| async move {
        let fp = table_policy_fingerprint(&p, "sec04_neg.cfg").await;
        let pins = [("sec04_neg.cfg", fp.as_str())];
        let mut all = non_tenant_policy_violations_against(&p, &pins).await;
        all.push("---1".to_string());
        sqlx::raw_sql("ALTER POLICY op ON sec04_neg.cfg USING (true)").execute(&p).await.expect("alter");
        all.extend(non_tenant_policy_violations_against(&p, &pins).await);
        all.push("---2".to_string());
        sqlx::raw_sql("ALTER POLICY op ON sec04_neg.cfg USING (current_setting('app.x', true) = 'on'); ALTER TABLE sec04_neg.cfg NO FORCE ROW LEVEL SECURITY")
            .execute(&p).await.expect("alter");
        all.extend(non_tenant_policy_violations_against(&p, &pins).await);
        all
    })
    .await;
    let i1 = found.iter().position(|l| l == "---1").unwrap();
    let i2 = found.iter().position(|l| l == "---2").unwrap();
    assert!(found[..i1].is_empty(), "unchanged pin is green: {found:#?}");
    assert!(
        found[i1 + 1..i2]
            .iter()
            .any(|l| l.starts_with("sec04_neg.cfg: policies changed")),
        "{found:#?}"
    );
    assert!(
        found[i2 + 1..]
            .iter()
            .any(|l| l == "sec04_neg.cfg: RLS is not enabled and FORCEd"),
        "{found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_definer_granted_only_to_momo_app_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = "CREATE FUNCTION sec04_neg.grant_app() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS 'SELECT 1';
         REVOKE ALL ON FUNCTION sec04_neg.grant_app() FROM PUBLIC;
         GRANT EXECUTE ON FUNCTION sec04_neg.grant_app() TO momo_app;
         CREATE FUNCTION sec04_neg.nobody() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS 'SELECT 1';
         REVOKE ALL ON FUNCTION sec04_neg.nobody() FROM PUBLIC;";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        app_definer_violations_against(&p, APP_ROLE, Some(s), &[]).await
    })
    .await;
    assert!(
        names_only(&found, "sec04_neg.grant_app():"),
        "got {found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_bypassrls_or_ownership_inherited_through_membership_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = format!(
        "DROP ROLE IF EXISTS sec04_neg_member; DROP ROLE IF EXISTS sec04_neg_grp; DROP ROLE IF EXISTS sec04_neg_own;
         CREATE ROLE sec04_neg_grp NOLOGIN BYPASSRLS;
         CREATE ROLE sec04_neg_own NOLOGIN;
         CREATE ROLE sec04_neg_member NOLOGIN;
         GRANT sec04_neg_grp, sec04_neg_own TO sec04_neg_member;
         {GOOD_TABLE}
         ALTER TABLE sec04_neg.good OWNER TO sec04_neg_own;"
    );
    let found = in_scratch(&pool, &ddl, |p, s| async move {
        role_boundary_violations(&p, "sec04_neg_member", Some(s)).await
    })
    .await;
    sqlx::raw_sql(
        "DROP ROLE IF EXISTS sec04_neg_member; DROP ROLE IF EXISTS sec04_neg_grp; DROP ROLE IF EXISTS sec04_neg_own;",
    )
    .execute(&pool)
    .await
    .expect("drop scratch roles");
    assert!(
        found
            .iter()
            .any(|l| l == "sec04_neg_member (via role sec04_neg_grp): has BYPASSRLS"),
        "{found:#?}"
    );
    assert!(
        found
            .iter()
            .any(|l| l.starts_with("sec04_neg.good: sec04_neg_member owns a tenant table")),
        "{found:#?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_column_level_write_on_an_unprotected_table_is_red() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = "CREATE TABLE sec04_neg.cols (k text PRIMARY KEY, v text);
         GRANT UPDATE (v) ON sec04_neg.cols TO momo_app;";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        unprotected_write_violations(&p, APP_ROLE, Some(s)).await
    })
    .await;
    assert!(names_only(&found, "sec04_neg.cols:"), "got {found:#?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_fingerprint_covers_command_and_target_roles() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = table_with_select_policy("true");
    let found = in_scratch(&pool, &ddl, |p, _s| async move {
        let before = policy_fingerprint(&p, "sec04_neg.t", "p").await;
        let tbl_before = table_policy_fingerprint(&p, "sec04_neg.t").await;
        sqlx::raw_sql("DROP ROLE IF EXISTS sec04_neg_fp; CREATE ROLE sec04_neg_fp NOLOGIN; ALTER POLICY p ON sec04_neg.t TO sec04_neg_fp")
            .execute(&p).await.expect("to role");
        let to_role = policy_fingerprint(&p, "sec04_neg.t", "p").await;
        let tbl_to_role = table_policy_fingerprint(&p, "sec04_neg.t").await;
        sqlx::raw_sql("ALTER POLICY p ON sec04_neg.t TO PUBLIC; DROP POLICY p ON sec04_neg.t; CREATE POLICY p ON sec04_neg.t FOR ALL USING (true)")
            .execute(&p).await.expect("for all");
        let for_all = policy_fingerprint(&p, "sec04_neg.t", "p").await;
        let tbl_for_all = table_policy_fingerprint(&p, "sec04_neg.t").await;
        sqlx::raw_sql("DROP POLICY p ON sec04_neg.t; DROP ROLE sec04_neg_fp")
            .execute(&p).await.expect("cleanup");
        vec![
            (before != to_role).to_string(),
            (before != for_all).to_string(),
            (tbl_before != tbl_to_role).to_string(),
            (tbl_before != tbl_for_all).to_string(),
        ]
    })
    .await;
    assert_eq!(
        found,
        vec!["true"; 4],
        "TO-role and command changes must move both fingerprints"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a migrated pgvector/pg18 DB"]
async fn control_search_path_pg_temp_must_be_a_whole_last_element() {
    let _guard = lock().await;
    let pool = pool().await;
    let ddl = "CREATE FUNCTION sec04_neg.fake_temp() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = public, xpg_temp AS 'SELECT 1';
         CREATE FUNCTION sec04_neg.real_temp() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = public, pg_temp AS 'SELECT 1';
         REVOKE ALL ON FUNCTION sec04_neg.fake_temp(), sec04_neg.real_temp() FROM PUBLIC;";
    let found = in_scratch(&pool, ddl, |p, s| async move {
        definer_search_path_violations(&p, Some(s)).await
    })
    .await;
    assert!(
        names_only(&found, "sec04_neg.fake_temp():"),
        "got {found:#?}"
    );
}
