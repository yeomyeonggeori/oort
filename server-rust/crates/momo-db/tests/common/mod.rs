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
        "physical plugin catalog shared by every workspace, no secrets (013); RLS is off and momo_app can write it today (KNOWN_UNPROTECTED_NON_TENANT)",
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
        "the migration runner's own tracking table (momo_db::migrate), no tenant data; RLS is off and momo_app can write it today (KNOWN_UNPROTECTED_NON_TENANT)",
    ),
    (
        "public.work_cloud_host_transition",
        "static lifecycle transition lookup (053), no per-tenant rows; RLS is off and momo_app can write it today (KNOWN_UNPROTECTED_NON_TENANT)",
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
    "public.mem_accept_proposal(uuid)",
    "public.mem_digest_evidence_ok(uuid)",
    "public.mem_edit_item(uuid, text, text)",
    "public.mem_forget_item(uuid)",
    "public.mem_item_evidence_ok(uuid)",
    "public.mem_proposal_evidence_ok(uuid)",
    "public.mem_reject_proposal(uuid)",
    "public.mem_revert_consolidation(uuid)",
    "public.mem_search_items(text, integer, uuid, text)",
    "public.mem_topic_summary_ok(uuid)",
];

/// Non-tenant tables (see [`NON_TENANT_TABLES`]) on which RLS is off while
/// `momo_app` can still write. Baseline 2026-10-24, found by the SEC-04
/// review: these three are shared catalogs the API role should only read.
/// The list pins today's gap so a *new* unprotected, writable table fails;
/// revoking the writes (follow-up issue) empties it.
pub const KNOWN_UNPROTECTED_NON_TENANT: &[&str] = &[
    "public.plugin_registry",
    "public.schema_migrations",
    "public.work_cloud_host_transition",
];

/// Permissive policies on a `workspace_id` table that apply to `momo_app` yet
/// are deliberately not keyed on `app.workspace_id`: instance-level GitHub
/// ingress / link flows that run before a workspace is known, each gated by
/// its own GUC. Entry = `schema.table.policy`.
pub const GUC_GATED_POLICIES: &[(&str, &str)] = &[
    (
        "public.github_app_installation.github_app_installation_insert",
        "webhook ingress inserts the installation before it is bound to a workspace; gated on app.github_ingress (140/142)",
    ),
    (
        "public.github_app_installation.github_app_installation_update",
        "ingress/admin updates; gated on app.github_ingress or app.github_app_admin (140/142)",
    ),
    (
        "public.github_link_claim.github_link_claim_link_select",
        "install-link callback reads a purpose='install' claim before the workspace is known; gated on app.github_link (140/142)",
    ),
    (
        "public.github_link_claim.github_link_claim_link_update",
        "install-link callback consumes the claim; gated on app.github_link and purpose='install' (140/142)",
    ),
];

/// `current_setting('app.workspace_id'` as `pg_get_expr` renders it. A bare
/// substring `app.workspace_id` is not enough (a string literal would pass).
const WS_GUC: &str = "current_setting(''app.workspace_id''";

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

/// (1a) Every table with a `workspace_id` column: RLS enabled, FORCEd, at
/// least one permissive policy that applies to SELECT and names
/// `current_setting('app.workspace_id'` in USING, **and** every permissive
/// policy that applies to `role` ties its rows to that GUC for each command it
/// covers (USING for SELECT/UPDATE/DELETE, WITH CHECK for INSERT/UPDATE).
/// Permissive policies are OR-ed, so one open policy beside a good one opens
/// the table. Policies in [`GUC_GATED_POLICIES`] are the reviewed exceptions;
/// restrictive policies only narrow access and are not judged.
pub async fn tenant_rls_violations(
    pool: &PgPool,
    schemas: Option<&[&str]>,
    role: &str,
) -> Vec<String> {
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
                   AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%{WS_GUC}%')) \
         ORDER BY 1"
    );
    let mut out: Vec<String> = sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .fetch_all(pool)
        .await
        .expect("tenant rls query");

    let allow: Vec<String> = if schemas.is_none() {
        GUC_GATED_POLICIES
            .iter()
            .map(|(n, _)| (*n).to_string())
            .collect()
    } else {
        Vec::new()
    };
    let qual = "coalesce(pg_get_expr(p.polqual, p.polrelid), '')";
    let check =
        "coalesce(pg_get_expr(p.polwithcheck, p.polrelid), pg_get_expr(p.polqual, p.polrelid), '')";
    let with_check = "coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')";
    let sql = format!(
        "SELECT n.nspname || '.' || c.relname || ': permissive policy ' || p.polname || ' (' || \
                CASE p.polcmd WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' \
                              WHEN 'w' THEN 'UPDATE' ELSE 'DELETE' END || \
                ') does not tie its rows to app.workspace_id' \
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid \
                JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r','p') AND {SCOPE} AND {HAS_WORKSPACE_ID} AND p.polpermissive \
            AND (p.polroles = '{{0}}'::oid[] OR EXISTS ( \
                   SELECT 1 FROM unnest(p.polroles) AS o CROSS JOIN pg_roles m \
                    WHERE m.rolname = $3 AND o <> 0 AND pg_has_role(m.oid, o, 'USAGE'))) \
            AND (n.nspname || '.' || c.relname || '.' || p.polname) <> ALL($2::text[]) \
            AND ((p.polcmd IN ('*','r','w','d') AND {qual} NOT LIKE '%{WS_GUC}%') \
              OR (p.polcmd = 'a' AND {with_check} NOT LIKE '%{WS_GUC}%') \
              OR (p.polcmd IN ('*','w') AND {check} NOT LIKE '%{WS_GUC}%')) \
          ORDER BY 1"
    );
    out.extend(
        sqlx::query_scalar::<_, String>(&sql)
            .bind(owned(schemas))
            .bind(&allow)
            .bind(role)
            .fetch_all(pool)
            .await
            .expect("tenant policy query"),
    );
    if schemas.is_none() {
        let stale: Vec<String> = sqlx::query_scalar(
            "SELECT a.name || ': GUC_GATED_POLICIES entry is stale (policy gone or not permissive)' \
               FROM unnest($1::text[]) AS a(name) \
              WHERE NOT EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid \
                                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                                WHERE p.polpermissive \
                                  AND (n.nspname || '.' || c.relname || '.' || p.polname) = a.name) \
              ORDER BY 1",
        )
        .bind(&allow)
        .fetch_all(pool)
        .await
        .expect("stale policy allowlist query");
        out.extend(stale);
    }
    out
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

/// SECURITY DEFINER functions whose `search_path` is exactly `pg_catalog`
/// (no `pg_temp`). Baseline 2026-10-24: the five private lookup functions of
/// migrations 113/115-style join and schedule paths. Their bodies qualify every
/// relation (`public.x`), so a session's temp schema cannot shadow anything;
/// follow-up is appending `pg_temp` so this list can go. Entry = exact
/// signature, and the config must still be exactly `pg_catalog`.
pub const PG_CATALOG_ONLY_DEFINERS: &[(&str, &str)] = &[
    (
        "momo_join_private.device_link_workspace_id(text)",
        "body only reads schema-qualified public.* relations and public.digest",
    ),
    (
        "momo_join_private.invite_workspace_id(text)",
        "body only reads schema-qualified public.* relations and public.digest",
    ),
    (
        "momo_join_private.owner_claim_workspace_id(text)",
        "body only reads schema-qualified public.* relations and public.digest",
    ),
    (
        "momo_schedule_private.due_scheduled_messages(integer)",
        "body only reads schema-qualified public.scheduled_message",
    ),
    (
        "momo_schedule_private.expired_scheduled_messages(integer)",
        "body only reads schema-qualified public.scheduled_message",
    ),
];

/// (2) Every SECURITY DEFINER function pins `search_path` and names `pg_temp`
/// last. Left unnamed, the session's temp schema is searched first for
/// relations and types; named but earlier, it shadows the listed schemas.
/// [`PG_CATALOG_ONLY_DEFINERS`] are the reviewed exceptions.
pub async fn definer_search_path_violations(
    pool: &PgPool,
    schemas: Option<&[&str]>,
) -> Vec<String> {
    let allow: &[(&str, &str)] = if schemas.is_none() {
        PG_CATALOG_ONLY_DEFINERS
    } else {
        &[]
    };
    definer_search_path_violations_against(pool, schemas, allow).await
}

/// [`definer_search_path_violations`] with the exception list passed in.
pub async fn definer_search_path_violations_against(
    pool: &PgPool,
    schemas: Option<&[&str]>,
    allow: &[(&str, &str)],
) -> Vec<String> {
    let allow_owned: Vec<String> = allow.iter().map(|(n, _)| (*n).to_string()).collect();
    let sql = format!(
        "SELECT {FN_SIG} || ': ' || \
                CASE WHEN sp.cfg IS NULL THEN 'SECURITY DEFINER without a pinned search_path' \
                     ELSE 'search_path must name pg_temp explicitly and last: ' || sp.cfg END \
         {from} \
           AND ((sp.cfg IS NULL) OR (sp.cfg !~ 'pg_temp\\s*$')) \
           AND NOT (sp.cfg = 'pg_catalog' AND ({FN_SIG}) = ANY($2::text[])) \
         ORDER BY 1",
        from = definer_from().replace(
            "WHERE p.prosecdef",
            "LEFT JOIN LATERAL (SELECT substr(c, 13) AS cfg FROM unnest(p.proconfig) c \
                                WHERE c LIKE 'search_path=%' LIMIT 1) sp ON true \
             WHERE p.prosecdef"
        )
    );
    let mut out: Vec<String> = sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .bind(&allow_owned)
        .fetch_all(pool)
        .await
        .expect("definer search_path query");
    if schemas.is_none() {
        let stale: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT a.name || ': PG_CATALOG_ONLY_DEFINERS entry is stale (gone, or search_path is no longer exactly pg_catalog)' \
               FROM unnest($1::text[]) AS a(name) \
              WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                                 WHERE p.prosecdef AND ({FN_SIG}) = a.name \
                                   AND 'search_path=pg_catalog' = ANY(p.proconfig)) \
              ORDER BY 1"
        ))
        .bind(&allow_owned)
        .fetch_all(pool)
        .await
        .expect("stale search_path allowlist query");
        out.extend(stale);
    }
    out
}

/// `schema.name(arg types)`, argument *names* excluded so a renamed parameter
/// does not break the allowlist while a new overload cannot hide behind it.
const FN_SIG: &str = "n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')'";

/// (3) SECURITY DEFINER functions executable by PUBLIC must equal
/// [`PUBLIC_DEFINER_FUNCTIONS`] by exact signature: a new one, a new overload
/// and a vanished one all fail (`schemas = None` only for the vanished
/// direction, as above).
pub async fn public_definer_violations(pool: &PgPool, schemas: Option<&[&str]>) -> Vec<String> {
    let allow: &[&str] = if schemas.is_none() {
        PUBLIC_DEFINER_FUNCTIONS
    } else {
        &[]
    };
    public_definer_violations_against(pool, schemas, allow).await
}

/// [`public_definer_violations`] with the allowlist passed in (controls).
pub async fn public_definer_violations_against(
    pool: &PgPool,
    schemas: Option<&[&str]>,
    allow: &[&str],
) -> Vec<String> {
    let allow_owned: Vec<String> = allow.iter().map(|n| (*n).to_string()).collect();
    let sql = format!(
        "SELECT DISTINCT {FN_SIG} || ': SECURITY DEFINER executable by PUBLIC and not in PUBLIC_DEFINER_FUNCTIONS' \
         {from} AND has_function_privilege('public', p.oid, 'EXECUTE') \
            AND ({FN_SIG}) <> ALL($2::text[]) \
         ORDER BY 1",
        from = definer_from()
    );
    let mut out: Vec<String> = sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .bind(&allow_owned)
        .fetch_all(pool)
        .await
        .expect("public definer query");
    if schemas.is_none() {
        let stale: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT a.name || ': PUBLIC_DEFINER_FUNCTIONS entry is stale (no PUBLIC-executable definer with that signature)' \
               FROM unnest($1::text[]) AS a(name) \
              WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                                 WHERE p.prosecdef AND ({FN_SIG}) = a.name \
                                   AND has_function_privilege('public', p.oid, 'EXECUTE')) \
              ORDER BY 1"
        ))
        .bind(&allow_owned)
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

async fn assert_role_exists(pool: &PgPool, role: &str) {
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
}

/// (4b) The premise of every RLS check: `role` is not a superuser, does not
/// have BYPASSRLS, owns no tenant table (an owner can DISABLE RLS or drop the
/// policy), and cannot TRUNCATE one (TRUNCATE ignores RLS, FORCE or not).
pub async fn role_boundary_violations(
    pool: &PgPool,
    role: &str,
    schemas: Option<&[&str]>,
) -> Vec<String> {
    assert_role_exists(pool, role).await;
    let mut out: Vec<String> = sqlx::query_scalar(
        "SELECT $1::text || ': ' || CASE WHEN rolsuper THEN 'is a superuser' ELSE 'has BYPASSRLS' END \
           FROM pg_roles WHERE rolname = $1 AND (rolsuper OR rolbypassrls)",
    )
    .bind(role)
    .fetch_all(pool)
    .await
    .expect("role attribute query");
    let sql = format!(
        "SELECT n.nspname || '.' || c.relname || ': ' || $2::text || ' ' || \
                CASE WHEN c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $2) \
                     THEN 'owns a tenant table (can disable RLS)' \
                     ELSE 'can TRUNCATE a tenant table (TRUNCATE ignores RLS)' END \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r','p') AND {SCOPE} AND {HAS_WORKSPACE_ID} \
            AND (c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $2) \
                 OR has_table_privilege($2::text, c.oid, 'TRUNCATE')) \
          ORDER BY 1"
    );
    out.extend(
        sqlx::query_scalar::<_, String>(&sql)
            .bind(owned(schemas))
            .bind(role)
            .fetch_all(pool)
            .await
            .expect("role tenant table query"),
    );
    out
}

/// (4c) Views, materialized views and foreign tables `role` can reach. RLS
/// cannot be set on a materialized view or foreign table, and a plain view
/// runs as its owner (the migration role bypasses RLS) unless it is
/// `security_invoker`. The real database has none today; a new one must be
/// argued about, not slip in.
pub async fn exposed_relation_violations(
    pool: &PgPool,
    role: &str,
    schemas: Option<&[&str]>,
) -> Vec<String> {
    assert_role_exists(pool, role).await;
    let sql = format!(
        "SELECT n.nspname || '.' || c.relname || ': ' || CASE c.relkind \
                  WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' \
                  ELSE 'view without security_invoker' END || ' is reachable by ' || $2::text \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('v','m','f') AND {SCOPE} \
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass \
                              AND d.objid = c.oid AND d.deptype = 'e') \
            AND (c.relkind <> 'v' OR NOT EXISTS ( \
                   SELECT 1 FROM unnest(coalesce(c.reloptions, '{{}}'::text[])) o \
                    WHERE o ~ '^security_invoker=(true|on|1|yes)$')) \
            AND (has_table_privilege($2::text, c.oid, 'SELECT') OR has_table_privilege($2::text, c.oid, 'INSERT') \
              OR has_table_privilege($2::text, c.oid, 'UPDATE') OR has_table_privilege($2::text, c.oid, 'DELETE')) \
          ORDER BY 1"
    );
    sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .bind(role)
        .fetch_all(pool)
        .await
        .expect("exposed relation query")
}

/// (4d) A table without `workspace_id` and without RLS that `role` can write.
/// Today exactly [`KNOWN_UNPROTECTED_NON_TENANT`]; anything else is new, and
/// an entry that stopped being true is stale (`schemas = None` only).
pub async fn unprotected_write_violations(
    pool: &PgPool,
    role: &str,
    schemas: Option<&[&str]>,
) -> Vec<String> {
    assert_role_exists(pool, role).await;
    let allow: Vec<String> = if schemas.is_none() {
        KNOWN_UNPROTECTED_NON_TENANT
            .iter()
            .map(|n| (*n).to_string())
            .collect()
    } else {
        Vec::new()
    };
    let writes = "(has_table_privilege($2::text, c.oid, 'INSERT') \
                   OR has_table_privilege($2::text, c.oid, 'UPDATE') \
                   OR has_table_privilege($2::text, c.oid, 'DELETE'))";
    let sql = format!(
        "SELECT n.nspname || '.' || c.relname || ': ' || $2::text || ' can write a table that has no workspace_id and no RLS' \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r','p') AND {SCOPE} AND NOT {HAS_WORKSPACE_ID} AND NOT c.relispartition \
            AND NOT c.relrowsecurity AND {writes} \
            AND (n.nspname || '.' || c.relname) <> ALL($3::text[]) \
          ORDER BY 1"
    );
    let mut out: Vec<String> = sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .bind(role)
        .bind(&allow)
        .fetch_all(pool)
        .await
        .expect("unprotected write query");
    if schemas.is_none() {
        let sql = format!(
            "SELECT a.name || ': KNOWN_UNPROTECTED_NON_TENANT entry is stale (now protected, read-only for ' || $2::text || ' or gone)' \
               FROM unnest($1::text[]) AS a(name) \
              WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                                 WHERE c.relkind IN ('r','p') AND (n.nspname || '.' || c.relname) = a.name \
                                   AND NOT c.relrowsecurity AND {writes}) \
              ORDER BY 1"
        );
        let stale: Vec<String> = sqlx::query_scalar(&sql)
            .bind(&allow)
            .bind(role)
            .fetch_all(pool)
            .await
            .expect("stale unprotected write query");
        out.extend(stale);
    }
    out
}
