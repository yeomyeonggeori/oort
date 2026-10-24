//! Tenant catalog invariants (#4242, SEC-04): the checks behind
//! `tests/tenant_catalog_pg.rs`, shared with `conformance_pg.rs` so the old
//! `forced >= 30` floor and the new invariants cannot drift apart.
//!
//! Every check is one catalog query (`pg_class` / `pg_policy` / `pg_proc` /
//! `pg_attribute`) that returns the **violations** as `schema.name: reason`
//! lines. An empty list is the pass condition, so a weakened query cannot
//! hide behind a count: `tenant_catalog_pg.rs` feeds each query a scratch
//! schema with one deliberately broken object and requires exactly that
//! object to come back.
//!
//! `schemas = None` scans every user schema (the real database);
//! `Some(&[..])` limits the scan to those schemas (the negative controls).
#![allow(dead_code)]

use momo_db::sqlx;
use momo_db::PgPool;

/// Tables with **no** `workspace_id` column. Each one is shared state that a
/// tenant must never read through `workspace_id`; the reason says why it needs
/// no tenant RLS (or, where it has RLS keyed on something else, on what).
/// A table that is neither tenant-scoped nor listed here fails the test, so
/// adding one forces a decision in review. Baseline 2026-10-24: 12.
pub const NON_TENANT_TABLES: &[(&str, &str)] = &[
    (
        "public.github_app",
        "instance-wide GitHub App singleton; RLS keyed on app.github_app_admin / app.github_ingress GUCs (140)",
    ),
    (
        "public.github_app_public",
        "the App's non-secret identity, readable by every workspace; write needs app.github_app_admin (142)",
    ),
    (
        "public.github_installation_repository",
        "keyed by installation_id; policy joins github_app_installation.workspace_id to app.workspace_id (142)",
    ),
    (
        "public.plugin_registry",
        "physical plugin catalog shared by every workspace, no secrets (013); momo_app may not write it",
    ),
    (
        "public.provider_default_ai",
        "instance-wide operator default per role; RLS keyed on app.provider_link_admin (093)",
    ),
    (
        "public.provider_key_budget",
        "instance-wide per-company budget; RLS keyed on app.provider_link_admin (137)",
    ),
    (
        "public.provider_link",
        "instance-wide upstream singleton; RLS keyed on app.provider_link_admin (039)",
    ),
    (
        "public.provider_link_chain",
        "instance-wide upstream cascade; RLS keyed on app.provider_link_admin (042)",
    ),
    (
        "public.quota_snapshot",
        "one operator upstream shared by all workspaces; ingest keyed on app.provider_quota_admin (043)",
    ),
    (
        "public.schema_migrations",
        "the migration runner's own tracking table (momo_db::migrate), no tenant data",
    ),
    (
        "public.work_cloud_host_transition",
        "static lifecycle transition lookup (053), no per-tenant rows",
    ),
    (
        "public.workspace",
        "the tenant root: its primary key `id` is the tenant, policy is id = app.workspace_id (schema_v0)",
    ),
];

/// SECURITY DEFINER functions that are executable by PUBLIC today. Baseline
/// 2026-10-21: Postgres' default `EXECUTE` to PUBLIC was never revoked on
/// these `mem_*` entry points (105-107). Shrinking the list is welcome; a new
/// PUBLIC definer must be added here on purpose, with a review.
pub const PUBLIC_DEFINER_FUNCTIONS: &[&str] = &[
    "public.mem_accept_proposal",
    "public.mem_digest_evidence_ok",
    "public.mem_edit_item",
    "public.mem_forget_item",
    "public.mem_item_evidence_ok",
    "public.mem_proposal_evidence_ok",
    "public.mem_reject_proposal",
    "public.mem_revert_consolidation",
    "public.mem_search_items",
    "public.mem_topic_summary_ok",
];

/// `($1 IS NULL AND user schema) OR schema = ANY($1)`: shared scope clause.
const SCOPE: &str =
    "((($1::text[] IS NULL) AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') \
                      OR n.nspname = ANY($1::text[]))";

/// A `workspace_id` column that is live (not dropped, not a system column).
const HAS_WORKSPACE_ID: &str = "EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid \
     AND a.attname = 'workspace_id' AND a.attnum > 0 AND NOT a.attisdropped)";

fn owned(schemas: Option<&[&str]>) -> Option<Vec<String>> {
    schemas.map(|list| list.iter().map(|s| (*s).to_string()).collect())
}

/// Number of tables that carry a `workspace_id` column in scope (a scan that
/// finds none proves nothing, so the real-database test asserts `> 0`).
pub async fn tenant_table_count(pool: &PgPool, schemas: Option<&[&str]>) -> i64 {
    let sql = format!(
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('r','p') AND {SCOPE} AND {HAS_WORKSPACE_ID}"
    );
    sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .fetch_one(pool)
        .await
        .expect("count tenant tables")
}

/// (1a) Every table with a `workspace_id` column: RLS enabled, FORCEd, and at
/// least one permissive policy that applies to SELECT (`FOR ALL` or `FOR
/// SELECT`) and whose USING expression names `app.workspace_id`.
pub async fn tenant_rls_violations(pool: &PgPool, schemas: Option<&[&str]>) -> Vec<String> {
    let sql = format!(
        "SELECT n.nspname || '.' || c.relname || ': ' || CASE \
            WHEN NOT c.relrowsecurity THEN 'RLS is not enabled' \
            WHEN NOT c.relforcerowsecurity THEN 'RLS is not FORCEd' \
            WHEN NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) THEN 'no policy' \
            ELSE 'no permissive SELECT policy references app.workspace_id' END \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('r','p') AND {SCOPE} AND {HAS_WORKSPACE_ID} \
           AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS ( \
                SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive \
                   AND p.polcmd IN ('*','r') \
                   AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%app.workspace_id%')) \
         ORDER BY 1"
    );
    sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .fetch_all(pool)
        .await
        .expect("tenant rls query")
}

/// (1b) Tables without `workspace_id` must be on [`NON_TENANT_TABLES`]. With
/// `schemas = None` the list is also kept tight: an entry that no longer
/// names a table without `workspace_id` is reported as stale.
pub async fn untracked_table_violations(pool: &PgPool, schemas: Option<&[&str]>) -> Vec<String> {
    let allow: Vec<String> = if schemas.is_none() {
        NON_TENANT_TABLES
            .iter()
            .map(|(n, _)| (*n).to_string())
            .collect()
    } else {
        Vec::new()
    };
    let sql = format!(
        "SELECT n.nspname || '.' || c.relname || ': has no workspace_id column and is not in NON_TENANT_TABLES' \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r','p') AND {SCOPE} AND NOT {HAS_WORKSPACE_ID} \
            AND NOT c.relispartition \
            AND (n.nspname || '.' || c.relname) <> ALL($2::text[]) \
         ORDER BY 1"
    );
    let mut out: Vec<String> = sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .bind(&allow)
        .fetch_all(pool)
        .await
        .expect("untracked table query");
    if schemas.is_none() {
        let stale: Vec<String> = sqlx::query_scalar(
            "SELECT a.name || ': NON_TENANT_TABLES entry is stale (table gone or now has workspace_id)' \
               FROM unnest($1::text[]) AS a(name) \
              WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                                 WHERE c.relkind IN ('r','p') AND (n.nspname || '.' || c.relname) = a.name \
                                   AND NOT EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid \
                                        AND x.attname = 'workspace_id' AND x.attnum > 0 AND NOT x.attisdropped)) \
              ORDER BY 1",
        )
        .bind(&allow)
        .fetch_all(pool)
        .await
        .expect("stale allowlist query");
        out.extend(stale);
    }
    out
}

/// SECURITY DEFINER functions outside extensions.
const DEFINER_FROM: &str = "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
     WHERE p.prosecdef AND p.prokind IN ('f','p') AND {SCOPE} \
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass \
                         AND d.objid = p.oid AND d.deptype = 'e')";

fn definer_from() -> String {
    DEFINER_FROM.replace("{SCOPE}", SCOPE)
}

/// (2) Every SECURITY DEFINER function pins `search_path`, and `pg_temp`, when
/// listed, is last (an earlier `pg_temp` lets a session shadow objects).
pub async fn definer_search_path_violations(
    pool: &PgPool,
    schemas: Option<&[&str]>,
) -> Vec<String> {
    let sql = format!(
        "SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '): ' || \
                CASE WHEN sp.cfg IS NULL THEN 'SECURITY DEFINER without a pinned search_path' \
                     ELSE 'search_path puts pg_temp before the other schemas: ' || sp.cfg END \
         {from} \
           AND ((sp.cfg IS NULL) OR (sp.cfg ~ 'pg_temp' AND sp.cfg !~ 'pg_temp\\s*$')) \
         ORDER BY 1",
        from = definer_from().replace(
            "WHERE p.prosecdef",
            "LEFT JOIN LATERAL (SELECT substr(c, 13) AS cfg FROM unnest(p.proconfig) c \
                                WHERE c LIKE 'search_path=%' LIMIT 1) sp ON true \
             WHERE p.prosecdef"
        )
    );
    sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .fetch_all(pool)
        .await
        .expect("definer search_path query")
}

/// (3) SECURITY DEFINER functions executable by PUBLIC must equal
/// [`PUBLIC_DEFINER_FUNCTIONS`]: a new one and a vanished one both fail
/// (`schemas = None` only for the vanished direction, as above).
pub async fn public_definer_violations(pool: &PgPool, schemas: Option<&[&str]>) -> Vec<String> {
    let allow: Vec<String> = if schemas.is_none() {
        PUBLIC_DEFINER_FUNCTIONS
            .iter()
            .map(|n| (*n).to_string())
            .collect()
    } else {
        Vec::new()
    };
    let sql = format!(
        "SELECT DISTINCT n.nspname || '.' || p.proname || ': SECURITY DEFINER executable by PUBLIC and not in PUBLIC_DEFINER_FUNCTIONS' \
         {from} AND has_function_privilege('public', p.oid, 'EXECUTE') \
            AND (n.nspname || '.' || p.proname) <> ALL($2::text[]) \
         ORDER BY 1",
        from = definer_from()
    );
    let mut out: Vec<String> = sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .bind(&allow)
        .fetch_all(pool)
        .await
        .expect("public definer query");
    if schemas.is_none() {
        let stale: Vec<String> = sqlx::query_scalar(
            "SELECT a.name || ': PUBLIC_DEFINER_FUNCTIONS entry is stale (no PUBLIC-executable definer by that name)' \
               FROM unnest($1::text[]) AS a(name) \
              WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                                 WHERE p.prosecdef AND (n.nspname || '.' || p.proname) = a.name \
                                   AND has_function_privilege('public', p.oid, 'EXECUTE')) \
              ORDER BY 1",
        )
        .bind(&allow)
        .fetch_all(pool)
        .await
        .expect("stale public definer query");
        out.extend(stale);
    }
    out
}

/// (4) `role` (the API's `momo_app`) holds no SELECT/INSERT/UPDATE/DELETE on a
/// tenant table whose RLS is off or not FORCEd. Privileges are the effective
/// ones (`has_table_privilege` includes PUBLIC and inherited grants).
pub async fn unforced_dml_violations(
    pool: &PgPool,
    role: &str,
    schemas: Option<&[&str]>,
) -> Vec<String> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)")
            .bind(role)
            .fetch_one(pool)
            .await
            .expect("role lookup");
    assert!(
        exists,
        "role {role} does not exist: apply infra/rust/sql/bootstrap_roles.sql after the migrations"
    );
    let sql = format!(
        "SELECT n.nspname || '.' || c.relname || ': ' || $2::text || ' has ' || \
                array_to_string(ARRAY(SELECT priv FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) priv \
                                      WHERE has_table_privilege($2::text, c.oid, priv)), ',') || \
                ' on a tenant table without enabled+FORCEd RLS' \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r','p') AND {SCOPE} AND {HAS_WORKSPACE_ID} \
            AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity) \
            AND (has_table_privilege($2::text, c.oid, 'SELECT') OR has_table_privilege($2::text, c.oid, 'INSERT') \
              OR has_table_privilege($2::text, c.oid, 'UPDATE') OR has_table_privilege($2::text, c.oid, 'DELETE')) \
         ORDER BY 1"
    );
    sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .bind(role)
        .fetch_all(pool)
        .await
        .expect("unforced dml query")
}
