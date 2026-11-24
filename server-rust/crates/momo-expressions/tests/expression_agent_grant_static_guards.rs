//! #6069 (ADR-0218 증보 13 §19 Y2.1 · Y2.3) — the table-privilege lockdown of `expression_agent_grant` and
//! `expression_agent_call` is one block of SQL in three files. These guards keep the block saying what it exists
//! for. No database: it reads the files. (The privileges a database ends up with are measured against a real
//! Postgres by `expression_self_register_pg::only_the_api_holds_the_grant_tables`.)
//!
//! | test | what turns it red |
//! |---|---|
//! | `the_block_grants_the_api_alone_and_checks_every_verb` | a grant to any role but `momo_app`, DELETE on grants, a role loop that no longer walks the helper's read role or `momo_memory` |
//! | `the_block_comes_after_the_tables_and_no_grant_stands_outside_it` | the block above `CREATE TABLE`, a `GRANT` beside it |
//! | `the_block_is_the_same_text_in_the_migration_and_both_bootstrap_files` | an edit to one copy and not the others |
//! | `both_bootstrap_files_apply_the_block_after_they_grant_every_table` | the block above the `ALL TABLES` grant or the default privileges |
//! | `the_call_table_has_no_foreign_key` | a `REFERENCES` / `FOREIGN KEY` on the count source |

use std::path::PathBuf;

const BLOCK: &str = "expression-agent-grant-lockdown";
const MIGRATION: &str = "server/Migrations/192_expression_agent_grant.sql";
const DEV: &str = "infra/rust/sql/bootstrap_roles.sql";
const RUNTIME: &str = "infra/rust/sql/bootstrap_runtime_roles.sql";

fn read(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"))
}

fn block_of(relative: &str, text: &str) -> (usize, String) {
    let begin_marker = format!("-- BEGIN {BLOCK}");
    let end_marker = format!("-- END {BLOCK}");
    assert_eq!(
        text.matches(&begin_marker).count(),
        1,
        "{relative}: one BEGIN"
    );
    assert_eq!(text.matches(&end_marker).count(), 1, "{relative}: one END");
    let begin = text.find(&begin_marker).unwrap();
    let end = text.find(&end_marker).unwrap() + end_marker.len();
    (begin, text[begin..end].to_string())
}

fn statements(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_block_grants_the_api_alone_and_checks_every_verb() {
    let (_, block) = block_of(MIGRATION, &read(MIGRATION));
    let block = statements(&block);
    for needle in [
        "ARRAY['expression_agent_grant', 'expression_agent_call']",
        "CONTINUE WHEN to_regclass('public.' || t) IS NULL",
        "REVOKE ALL ON TABLE public.%I FROM PUBLIC",
        "REVOKE ALL ON TABLE public.%I FROM %I",
        "WHEN r = 'momo_app' AND t = 'expression_agent_grant' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']",
        "WHEN r = 'momo_app' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']",
        "ELSE ARRAY[]::text[]",
        "'momo_relay'",
        "'momo_worker'",
        "'momo_notifier'",
        "'momo_platform_admin'",
        "'momo_helper_read'",
        "'momo_memory'",
        "ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']",
        "has_table_privilege(r, 'public.' || t, p) IS DISTINCT FROM (p = ANY (allowed))",
        "RAISE EXCEPTION",
    ] {
        assert!(block.contains(needle), "the block lost `{needle}`");
    }
    assert_eq!(
        block.matches("THEN ARRAY[").count(),
        2,
        "the block grants to momo_app (two tables) and nobody else"
    );
    for forbidden in [
        "'momo_worker' THEN",
        "'momo_relay' THEN",
        "'momo_notifier' THEN",
        "'momo_platform_admin' THEN",
        "'momo_helper_read' THEN",
        "'momo_memory' THEN",
        "GRANT ALL",
    ] {
        assert!(!block.contains(forbidden), "the block grants `{forbidden}`");
    }
}

#[test]
fn the_block_comes_after_the_tables_and_no_grant_stands_outside_it() {
    let text = read(MIGRATION);
    let (begin, block) = block_of(MIGRATION, &text);
    for needle in [
        "CREATE TABLE expression_agent_grant (",
        "CREATE TABLE expression_agent_call (",
        "CREATE TRIGGER expression_agent_grant_guard",
        "CREATE TRIGGER expression_agent_call_guard",
        "ALTER TABLE %I FORCE ROW LEVEL SECURITY",
    ] {
        let at = text
            .find(needle)
            .unwrap_or_else(|| panic!("the migration lost `{needle}`"));
        assert!(at < begin, "`{needle}` must come before the lockdown block");
    }
    let outside = text.replace(&block, "");
    assert!(
        !statements(&outside).to_uppercase().contains("GRANT "),
        "a GRANT outside the lockdown block: {}",
        statements(&outside)
    );
}

#[test]
fn the_call_table_has_no_foreign_key() {
    let sql = statements(&read(MIGRATION));
    let from = sql
        .find("CREATE TABLE expression_agent_call (")
        .expect("the migration creates the call table");
    let create = &sql[from..from + sql[from..].find(");").expect("the statement ends")];
    for forbidden in ["REFERENCES", "FOREIGN KEY"] {
        assert!(
            !create.to_uppercase().contains(forbidden),
            "a foreign key on the count source lets a cascade clear the counts: {create}"
        );
    }
}

#[test]
fn the_block_is_the_same_text_in_the_migration_and_both_bootstrap_files() {
    let (_, migration) = block_of(MIGRATION, &read(MIGRATION));
    for relative in [DEV, RUNTIME] {
        let (_, copy) = block_of(relative, &read(relative));
        assert_eq!(
            migration, copy,
            "{relative} drifted from the migration's block"
        );
    }
}

#[test]
fn both_bootstrap_files_apply_the_block_after_they_grant_every_table() {
    for relative in [DEV, RUNTIME] {
        let text = read(relative);
        let (begin, _) = block_of(relative, &text);
        let grant = text
            .rfind("ON ALL TABLES IN SCHEMA public")
            .unwrap_or_else(|| panic!("{relative}: no ALL TABLES grant to come after"));
        assert!(
            grant < begin,
            "{relative}: the lockdown must come after every ALL TABLES grant"
        );
        let defaults = text
            .rfind("ALTER DEFAULT PRIVILEGES IN SCHEMA public")
            .unwrap_or_else(|| panic!("{relative}: no default privileges"));
        assert!(defaults < begin, "{relative}: the lockdown comes last");
    }
}
