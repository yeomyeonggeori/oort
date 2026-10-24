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
        "physical plugin catalog shared by every workspace, no secrets (013); RLS is off, so writes are revoked from every runtime role instead (catalog-readonly-lockdown, #4372)",
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
        "the migration runner's own tracking table (momo_db::migrate), no tenant data; RLS is off, so writes are revoked from every runtime role instead (catalog-readonly-lockdown, #4372)",
    ),
    (
        "public.work_cloud_host_transition",
        "static lifecycle transition lookup (053), no per-tenant rows; RLS is off, so writes are revoked from every runtime role instead (catalog-readonly-lockdown, #4372)",
    ),
    (
        "public.workspace",
        "the tenant root: its primary key `id` is the tenant, policy is id = app.workspace_id (schema_v0)",
    ),
];

/// SECURITY DEFINER functions that are executable by PUBLIC. Baseline 2026-10-21 held ten
/// `mem_*` entry points (105-107) because Postgres' default `EXECUTE` to PUBLIC was never
/// revoked; migration 147 (#4381) moved all ten to `momo_app` only, so the list is empty and
/// any new PUBLIC definer fails the test. A new one must be added here on purpose, with a
/// review. (`control_unlisted_public_definer_is_red` keeps the check from going blind.)
pub const PUBLIC_DEFINER_FUNCTIONS: &[&str] = &[];

/// Non-tenant tables (see [`NON_TENANT_TABLES`]) on which RLS is off while
/// `momo_app` can still write. Baseline 2026-10-24 held three (`plugin_registry`,
/// `schema_migrations`, `work_cloud_host_transition`); #4372 revoked their writes
/// (`catalog-readonly-lockdown` in both bootstrap files), so the list is empty and any
/// new unprotected, writable table fails the test.
pub const KNOWN_UNPROTECTED_NON_TENANT: &[&str] = &[];

/// SQL that renders an expression the way the fingerprints below were taken:
/// `pg_get_expr` with whitespace collapsed, `NULL` for an absent expression.
const NORM_Q: &str =
    "coalesce(regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g'), 'NULL')";
/// The roles a policy is `TO`, sorted, `PUBLIC` for oid 0.
const ROLES_TXT: &str =
    "array_to_string(ARRAY(SELECT CASE WHEN o = 0 THEN 'PUBLIC' ELSE o::regrole::text END \
     FROM unnest(p.polroles) AS o ORDER BY 1), ',')";
const NORM_WC: &str =
    "coalesce(regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '\\s+', ' ', 'g'), 'NULL')";

/// Permissive policies on a `workspace_id` table that apply to `momo_app` yet
/// are deliberately not a plain `workspace_id = app.workspace_id` conjunct.
/// Entry = `schema.table.policy`, `md5(cmd:permissive:TO roles:USING||WITH CHECK)` of the
/// whitespace-collapsed `pg_get_expr` text, reason. The fingerprint pins the
/// *content*: editing an allowlisted policy (say to `true`) turns the test red
/// and forces a re-review, instead of the name alone keeping it exempt.
/// Note the GUC gates (`app.github_*`) are conventions the server sets, not a
/// boundary against a session that can already run arbitrary SQL as `momo_app`.
pub const GUC_GATED_POLICIES: &[(&str, &str, &str)] = &[
    (
        "public.github_app_installation.github_app_installation_insert",
        "36b0d476d6b4bc0c2b20d4cf000b7cb3",
        "webhook ingress inserts the installation before it is bound to a workspace; gated on app.github_ingress (140/142)",
    ),
    (
        "public.github_app_installation.github_app_installation_select",
        "012c7ad4d91477f450740ed4989079f4",
        "ingress/admin/link flows read installations across workspaces; a workspace session sees only its own rows (140/142)",
    ),
    (
        "public.github_app_installation.github_app_installation_update",
        "f47fe2e0cadcfa0c228e490660a79a85",
        "ingress/admin updates and the link flow binding a workspace-less installation; gated on app.github_* (140/142)",
    ),
    (
        "public.github_link_claim.github_link_claim_link_select",
        "ad2e743ee79e9f9ff19c20c1c0565968",
        "install-link callback reads a purpose='install' claim before the workspace is known; gated on app.github_link (140/142)",
    ),
    (
        "public.github_link_claim.github_link_claim_link_update",
        "f984858dc5f36ed95d64cbb46c8e83bd",
        "install-link callback consumes the claim; gated on app.github_link and purpose='install' (140/142)",
    ),
    (
        "public.model_pricing.ws_isolation",
        "4ce0895bd1edbee14b01393345361e2c",
        "workspace_id IS NULL rows are the shared default price list every workspace reads; writes stay workspace-bound via WITH CHECK",
    ),
];

/// Non-tenant tables whose RLS is deliberately keyed on something other than
/// `app.workspace_id`. Entry = table, `md5` over its policies (name, cmd,
/// permissive, USING, WITH CHECK, sorted by name, whitespace collapsed). Each
/// must also have RLS enabled and FORCEd; a changed policy set (say
/// `github_app_operator` turned into `USING (true)`) turns the test red.
pub const NON_TENANT_POLICY_PINS: &[(&str, &str)] = &[
    ("public.github_app", "091f5ebbdb18d05463aaea7f8b7174fb"),
    (
        "public.github_app_public",
        "2f12f6973b4d060568f3b707dc5b9622",
    ),
    (
        "public.github_installation_repository",
        "493d4f3cb9addbbab1bcbcb0cb6f1b52",
    ),
    (
        "public.provider_default_ai",
        "9568566d2083e855dee267dda2ebf2cd",
    ),
    (
        "public.provider_key_budget",
        "687e90fd8ddfd6fe3ab71d9cb066144b",
    ),
    ("public.provider_link", "2fd91a3412c17a40f532b50bbcd2f779"),
    (
        "public.provider_link_chain",
        "e9150e2548eabea4ebb4637c85e6b7da",
    ),
    ("public.quota_snapshot", "20bb5cd78ea0d0c3a24b6240e8731732"),
    ("public.workspace", "e435c9abcb23d0e40611dc8749018dc4"),
];

/// Every SECURITY DEFINER function `momo_app` can execute, exact signature.
/// A definer runs as its owner, who bypasses RLS, so granting `momo_app` a new
/// one is a tenant-boundary decision. Baseline 2026-10-24; the ten `mem_*` ones are
/// `momo_app`-only since migration 147 (#4381).
pub const APP_EXECUTABLE_DEFINERS: &[&str] = &[
    "momo_join_private.device_link_workspace_id(text)",
    "momo_join_private.invite_workspace_id(text)",
    "momo_join_private.owner_claim_workspace_id(text)",
    "momo_schedule_private.due_scheduled_messages(integer)",
    "momo_schedule_private.expired_scheduled_messages(integer)",
    "public.mem_accept_proposal(uuid)",
    "public.mem_digest_evidence_ok(uuid)",
    "public.mem_edit_item(uuid, text, text)",
    "public.mem_forget_item(uuid)",
    "public.mem_item_evidence_ok(uuid)",
    "public.mem_proposal_evidence_ok(uuid)",
    "public.mem_reject_proposal(uuid)",
    "public.mem_reset_workspace(bigint)",
    "public.mem_revert_consolidation(uuid)",
    "public.mem_search_items(text, integer, uuid, text)",
    "public.mem_summary_provider()",
    "public.mem_topic_summary_ok(uuid)",
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

/// `(table, policy, cmd, USING, WITH CHECK, fingerprint)` of one policy.
type PolicyRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
);

/// `md5` of one policy's `USING || '||' || WITH CHECK`, the text
/// [`GUC_GATED_POLICIES`] fingerprints are taken from.
pub async fn policy_fingerprint(pool: &PgPool, qualified_table: &str, polname: &str) -> String {
    let sql = format!(
        "SELECT md5(p.polcmd::text || ':' || p.polpermissive::text || ':' || {ROLES_TXT} || ':' || {NORM_Q} || '||' || {NORM_WC}) FROM pg_policy p \
          WHERE p.polrelid = $1::regclass AND p.polname = $2"
    );
    sqlx::query_scalar(&sql)
        .bind(qualified_table)
        .bind(polname)
        .fetch_one(pool)
        .await
        .expect("policy fingerprint")
}

/// Strip parentheses that wrap the whole expression.
fn strip_outer_parens(mut e: &str) -> &str {
    loop {
        e = e.trim();
        if !(e.starts_with('(') && e.ends_with(')')) {
            return e;
        }
        let mut depth = 0i32;
        let mut quoted = false;
        for (i, ch) in e.char_indices() {
            match ch {
                '\'' => quoted = !quoted,
                '(' if !quoted => depth += 1,
                ')' if !quoted => {
                    depth -= 1;
                    if depth == 0 && i != e.len() - 1 {
                        return e; // the first '(' closes before the end
                    }
                }
                _ => {}
            }
        }
        e = &e[1..e.len() - 1];
    }
}

/// Split at depth 0 (outside parentheses and string literals) on `sep`.
fn split_top<'a>(e: &'a str, sep: &str) -> Vec<&'a str> {
    let mut parts = Vec::new();
    let (mut depth, mut quoted, mut start) = (0i32, false, 0usize);
    let mut i = 0;
    while i < e.len() {
        let ch = e[i..].chars().next().expect("char");
        match ch {
            '\'' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth -= 1,
            _ if !quoted && depth == 0 && e[i..].starts_with(sep) => {
                parts.push(&e[start..i]);
                i += sep.len();
                start = i;
                continue;
            }
            _ => {}
        }
        i += ch.len_utf8();
    }
    parts.push(&e[start..]);
    parts
}

/// `workspace_id = current_setting('app.workspace_id')::uuid` in either shape
/// Postgres renders (with or without `NULLIF(.., '')`), column optionally
/// qualified.
fn is_workspace_equality(term: &str) -> bool {
    let t = strip_outer_parens(term);
    let Some((lhs, rhs)) = t.split_once(" = ") else {
        return false;
    };
    let lhs = strip_outer_parens(lhs);
    let column_ok = lhs == "workspace_id"
        || lhs.strip_suffix(".workspace_id").is_some_and(|q| {
            !q.is_empty()
                && q.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
        });
    let rhs = strip_outer_parens(rhs.trim());
    column_ok
        && (rhs == "(current_setting('app.workspace_id'::text, true))::uuid"
            || rhs == "(NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid")
}

/// Every OR branch of `expr` must contain, as a top-level AND conjunct, the
/// workspace equality. `... OR true`, `current_setting(..) IS NOT NULL`, a
/// comparison on another column, or a bare GUC mention all fail.
fn ties_rows_to_workspace(expr: &str) -> bool {
    // `pg_get_expr` breaks long CASE expressions over lines.
    let expr = expr.split_whitespace().collect::<Vec<_>>().join(" ");
    split_top(strip_outer_parens(&expr), " OR ")
        .into_iter()
        .all(|branch| {
            split_top(strip_outer_parens(branch), " AND ")
                .into_iter()
                .any(is_workspace_equality)
        })
}

/// (1a) Every table with a `workspace_id` column: RLS enabled, FORCEd, at
/// least one permissive SELECT policy keyed on `app.workspace_id`, **and**
/// every permissive policy that applies to `role` ties its rows to
/// `workspace_id = app.workspace_id` for each command it covers (USING for
/// SELECT/UPDATE/DELETE, WITH CHECK for INSERT/UPDATE). Permissive policies
/// are OR-ed, so one open policy beside a good one opens the table; the shape
/// check ([`ties_rows_to_workspace`]) also rejects `.. OR true`. Policies in
/// [`GUC_GATED_POLICIES`] are exempt only while their text matches the pinned
/// fingerprint. Restrictive policies only narrow access and are not judged.
pub async fn tenant_rls_violations(
    pool: &PgPool,
    schemas: Option<&[&str]>,
    role: &str,
) -> Vec<String> {
    let allow: &[(&str, &str, &str)] = if schemas.is_none() {
        GUC_GATED_POLICIES
    } else {
        &[]
    };
    tenant_rls_violations_against(pool, schemas, role, allow).await
}

/// [`tenant_rls_violations`] with the exemption list passed in (controls).
pub async fn tenant_rls_violations_against(
    pool: &PgPool,
    schemas: Option<&[&str]>,
    role: &str,
    allow: &[(&str, &str, &str)],
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

    // Permissive policies that apply to `role` (PUBLIC or via membership).
    let sql = format!(
        "SELECT n.nspname || '.' || c.relname, p.polname, p.polcmd::text, \
                pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid), \
                md5(p.polcmd::text || ':' || p.polpermissive::text || ':' || {ROLES_TXT} || ':' || {NORM_Q} || '||' || {NORM_WC}) \
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid \
                JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r','p') AND {SCOPE} AND {HAS_WORKSPACE_ID} AND p.polpermissive \
            AND (p.polroles = '{{0}}'::oid[] OR EXISTS ( \
                   SELECT 1 FROM unnest(p.polroles) AS o CROSS JOIN pg_roles m \
                    WHERE m.rolname = $2 AND o <> 0 AND pg_has_role(m.oid, o, 'USAGE'))) \
          ORDER BY 1, 2"
    );
    let rows: Vec<PolicyRow> = sqlx::query_as(&sql)
        .bind(owned(schemas))
        .bind(role)
        .fetch_all(pool)
        .await
        .expect("tenant policy query");
    let mut seen: Vec<String> = Vec::new();
    for (table, polname, cmd, qual, wc, fp) in rows {
        let key = format!("{table}.{polname}");
        let cmd_name = match cmd.as_str() {
            "*" => "ALL",
            "r" => "SELECT",
            "a" => "INSERT",
            "w" => "UPDATE",
            _ => "DELETE",
        };
        if let Some((_, pinned, _)) = allow.iter().find(|(k, _, _)| *k == key) {
            seen.push(key.clone());
            if fp != *pinned {
                out.push(format!(
                    "{table}: allowlisted policy {polname} ({cmd_name}) changed (fingerprint {fp}, pinned {pinned}): re-review GUC_GATED_POLICIES"
                ));
            }
            continue;
        }
        let qual = qual.unwrap_or_default();
        let check = wc.clone().unwrap_or_else(|| qual.clone());
        let bad_using =
            matches!(cmd.as_str(), "*" | "r" | "w" | "d") && !ties_rows_to_workspace(&qual);
        let bad_check = matches!(cmd.as_str(), "a" | "*" | "w") && !ties_rows_to_workspace(&check);
        if bad_using || bad_check {
            out.push(format!(
                "{table}: permissive policy {polname} ({cmd_name}) does not tie its rows to app.workspace_id"
            ));
        }
    }
    if schemas.is_none() {
        for (key, _, _) in allow {
            if !seen.iter().any(|k| k == key) {
                out.push(format!(
                    "{key}: GUC_GATED_POLICIES entry is stale (policy gone, not permissive, or no longer applies to {role})"
                ));
            }
        }
    }
    out
}

/// `md5` over a table's policies, the same text the fingerprints in
/// [`NON_TENANT_POLICY_PINS`] were taken from.
pub async fn table_policy_fingerprint(pool: &PgPool, qualified: &str) -> String {
    let sql = format!(
        "SELECT coalesce(md5(string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text \
                || ':' || {ROLES_TXT} || ':' || {NORM_Q} || '||' || {NORM_WC}, ';;' ORDER BY p.polname)), 'none') \
           FROM pg_policy p WHERE p.polrelid = $1::regclass"
    );
    sqlx::query_scalar(&sql)
        .bind(qualified)
        .fetch_one(pool)
        .await
        .expect("table policy fingerprint")
}

/// (1c) Non-tenant tables kept off `app.workspace_id` on purpose: RLS enabled
/// and FORCEd, policies unchanged since review.
pub async fn non_tenant_policy_violations(pool: &PgPool) -> Vec<String> {
    non_tenant_policy_violations_against(pool, NON_TENANT_POLICY_PINS).await
}

/// [`non_tenant_policy_violations`] with the pin list passed in (controls).
pub async fn non_tenant_policy_violations_against(
    pool: &PgPool,
    pins: &[(&str, &str)],
) -> Vec<String> {
    let mut out = Vec::new();
    for (table, pinned) in pins {
        let state: Option<(bool, bool)> = sqlx::query_as(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)",
        )
        .bind(*table)
        .fetch_optional(pool)
        .await
        .expect("non-tenant state");
        let Some((enabled, forced)) = state else {
            out.push(format!(
                "{table}: NON_TENANT_POLICY_PINS entry is stale (table gone)"
            ));
            continue;
        };
        if !enabled || !forced {
            out.push(format!("{table}: RLS is not enabled and FORCEd"));
            continue;
        }
        let fp = table_policy_fingerprint(pool, table).await;
        if fp != *pinned {
            out.push(format!(
                "{table}: policies changed (fingerprint {fp}, pinned {pinned}): re-review NON_TENANT_POLICY_PINS"
            ));
        }
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
/// the join and schedule paths. Their bodies qualify every relation
/// (`public.x`), so a session's temp schema cannot shadow anything. Entry =
/// exact signature, `md5(prosrc)`, reason: a body change breaks the reason, so
/// it must be re-reviewed (a plpgsql edit that reads an unqualified table
/// would otherwise let a temp table stand in). Follow-up: append `pg_temp` so
/// this list can go.
pub const PG_CATALOG_ONLY_DEFINERS: &[(&str, &str, &str)] = &[
    (
        "momo_join_private.device_link_workspace_id(text)",
        "a9b03cbe6c040b499bbe436c80be424d",
        "body only reads schema-qualified public.* relations and public.digest",
    ),
    (
        "momo_join_private.invite_workspace_id(text)",
        "480be45b58d12f80d4e3e6d04cc1c79a",
        "body only reads schema-qualified public.* relations and public.digest",
    ),
    (
        "momo_join_private.owner_claim_workspace_id(text)",
        "0238cd772f2f469c34923fb1656b40e8",
        "body only reads schema-qualified public.* relations and public.digest",
    ),
    (
        "momo_schedule_private.due_scheduled_messages(integer)",
        "30f3cbd320e5ddd324711ad14b89a703",
        "body only reads schema-qualified public.scheduled_message",
    ),
    (
        "momo_schedule_private.expired_scheduled_messages(integer)",
        "26883dc3ceb3d51694e802b39405af58",
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
    let allow: &[(&str, &str, &str)] = if schemas.is_none() {
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
    allow: &[(&str, &str, &str)],
) -> Vec<String> {
    let sigs: Vec<String> = allow.iter().map(|(n, _, _)| (*n).to_string()).collect();
    let hashes: Vec<String> = allow.iter().map(|(_, h, _)| (*h).to_string()).collect();
    let sql = format!(
        "SELECT {FN_SIG} || ': ' || \
                CASE WHEN sp.cfg IS NULL THEN 'SECURITY DEFINER without a pinned search_path' \
                     ELSE 'search_path must name pg_temp explicitly and last: ' || sp.cfg END \
         {from} \
           AND ((sp.cfg IS NULL) OR (sp.cfg !~ '(^|,)\\s*pg_temp\\s*$')) \
           AND NOT (sp.cfg = 'pg_catalog' AND EXISTS ( \
                 SELECT 1 FROM unnest($2::text[], $3::text[]) AS a(sig, h) \
                  WHERE a.sig = ({FN_SIG}) AND a.h = md5(p.prosrc))) \
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
        .bind(&sigs)
        .bind(&hashes)
        .fetch_all(pool)
        .await
        .expect("definer search_path query");
    if schemas.is_none() {
        let stale: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT a.sig || ': PG_CATALOG_ONLY_DEFINERS entry is stale (gone, body changed, or search_path is no longer exactly pg_catalog)' \
               FROM unnest($1::text[], $2::text[]) AS a(sig, h) \
              WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                                 WHERE p.prosecdef AND ({FN_SIG}) = a.sig AND md5(p.prosrc) = a.h \
                                   AND 'search_path=pg_catalog' = ANY(p.proconfig)) \
              ORDER BY 1"
        ))
        .bind(&sigs)
        .bind(&hashes)
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
/// ones (`has_any_column_privilege` includes PUBLIC, inherited and
/// column-level grants).
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
                                      WHERE CASE WHEN priv = 'DELETE' THEN has_table_privilege($2::text, c.oid, priv) \
                                                 ELSE has_any_column_privilege($2::text, c.oid, priv) END), ',') || \
                ' on a tenant table without enabled+FORCEd RLS' \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r','p') AND {SCOPE} AND {HAS_WORKSPACE_ID} \
            AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity) \
            AND (has_any_column_privilege($2::text, c.oid, 'SELECT') OR has_any_column_privilege($2::text, c.oid, 'INSERT') \
              OR has_any_column_privilege($2::text, c.oid, 'UPDATE') OR has_table_privilege($2::text, c.oid, 'DELETE')) \
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
/// have BYPASSRLS, is not a member of a role that is (membership with
/// `USAGE` means inherited rights), owns no tenant table directly or through a
/// role it inherits (an owner can DISABLE RLS or drop the policy), and cannot
/// TRUNCATE one (TRUNCATE ignores RLS, FORCE or not).
pub async fn role_boundary_violations(
    pool: &PgPool,
    role: &str,
    schemas: Option<&[&str]>,
) -> Vec<String> {
    assert_role_exists(pool, role).await;
    let mut out: Vec<String> = sqlx::query_scalar(
        "SELECT CASE WHEN r.rolname = $1 THEN $1::text ELSE $1::text || ' (via role ' || r.rolname || ')' END \
                || ': ' || CASE WHEN r.rolsuper THEN 'is a superuser' ELSE 'has BYPASSRLS' END \
           FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls) AND (pg_has_role($1, r.oid, 'USAGE') OR pg_has_role($1, r.oid, 'SET')) \
          ORDER BY 1",
    )
    .bind(role)
    .fetch_all(pool)
    .await
    .expect("role attribute query");
    let sql = format!(
        "SELECT n.nspname || '.' || c.relname || ': ' || $2::text || ' ' || \
                CASE WHEN (pg_has_role($2::text, c.relowner, 'USAGE') OR pg_has_role($2::text, c.relowner, 'SET')) \
                     THEN 'owns a tenant table (can disable RLS)' \
                     ELSE 'can TRUNCATE a tenant table (TRUNCATE ignores RLS)' END \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r','p') AND {SCOPE} AND {HAS_WORKSPACE_ID} \
            AND ((pg_has_role($2::text, c.relowner, 'USAGE') OR pg_has_role($2::text, c.relowner, 'SET')) \
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

/// (4e) Every SECURITY DEFINER function `role` can execute (directly, via
/// PUBLIC or inherited) must be on [`APP_EXECUTABLE_DEFINERS`], exact
/// signature; a vanished entry is stale (`schemas = None` only).
pub async fn app_definer_violations(
    pool: &PgPool,
    role: &str,
    schemas: Option<&[&str]>,
) -> Vec<String> {
    let allow: &[&str] = if schemas.is_none() {
        APP_EXECUTABLE_DEFINERS
    } else {
        &[]
    };
    app_definer_violations_against(pool, role, schemas, allow).await
}

/// [`app_definer_violations`] with the allowlist passed in (controls).
pub async fn app_definer_violations_against(
    pool: &PgPool,
    role: &str,
    schemas: Option<&[&str]>,
    allow: &[&str],
) -> Vec<String> {
    assert_role_exists(pool, role).await;
    let allow_owned: Vec<String> = allow.iter().map(|n| (*n).to_string()).collect();
    let sql = format!(
        "SELECT DISTINCT {FN_SIG} || ': SECURITY DEFINER executable by ' || $3::text || ' and not in APP_EXECUTABLE_DEFINERS' \
         {from} AND has_function_privilege($3::text, p.oid, 'EXECUTE') \
            AND ({FN_SIG}) <> ALL($2::text[]) \
         ORDER BY 1",
        from = definer_from()
    );
    let mut out: Vec<String> = sqlx::query_scalar(&sql)
        .bind(owned(schemas))
        .bind(&allow_owned)
        .bind(role)
        .fetch_all(pool)
        .await
        .expect("app definer query");
    if schemas.is_none() {
        let stale: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT a.name || ': APP_EXECUTABLE_DEFINERS entry is stale (gone or no longer executable by ' || $2::text || ')' \
               FROM unnest($1::text[]) AS a(name) \
              WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                                 WHERE p.prosecdef AND ({FN_SIG}) = a.name \
                                   AND has_function_privilege($2::text, p.oid, 'EXECUTE')) \
              ORDER BY 1"
        ))
        .bind(&allow_owned)
        .bind(role)
        .fetch_all(pool)
        .await
        .expect("stale app definer query");
        out.extend(stale);
    }
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
            AND (has_any_column_privilege($2::text, c.oid, 'SELECT') OR has_any_column_privilege($2::text, c.oid, 'INSERT') \
              OR has_any_column_privilege($2::text, c.oid, 'UPDATE') OR has_table_privilege($2::text, c.oid, 'DELETE')) \
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
    let writes = "(has_any_column_privilege($2::text, c.oid, 'INSERT') \
                   OR has_any_column_privilege($2::text, c.oid, 'UPDATE') \
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
