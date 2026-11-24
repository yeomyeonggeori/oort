//! #6013 (ADR-0151 증보 10 P2 · PA13) — the table-privilege lockdown of `agent_upload_token` is one block of
//! SQL, and the table is the source of this road's counts. These guards keep the block saying what it exists
//! for and the table free of foreign keys. No database: it reads the files. (The privileges a database ends
//! up with are measured against a real Postgres by `agent_port_picture_conformance_pg::only_the_api_holds_the_token_table`.)
//!
//! | test | what turns it red |
//! |---|---|
//! | `the_block_grants_the_api_alone_and_checks_every_verb` | a grant to any role but `momo_app`, a verb the api does not use, a role loop that no longer walks the helper's read role or `momo_memory`, an emptied block |
//! | `the_block_comes_after_the_table_and_no_grant_stands_outside_it` | the block above `CREATE TABLE` (it would return before the table exists), a `GRANT` beside it |
//! | `the_block_is_the_same_text_in_the_migration_and_both_bootstrap_files` | an edit to one copy and not the others |
//! | `both_bootstrap_files_apply_the_block_after_they_grant_every_table` | the block above the `ALL TABLES` grant or the default privileges (the grant would hand every verb back to the BYPASSRLS roles) |
//! | `the_token_table_has_no_foreign_key_and_the_mark_keeps_its_guard` | a `REFERENCES` / `FOREIGN KEY` on the token table; any statement on `agent_picture_mark` but dropping NOT NULL on `run_id` |

use std::path::PathBuf;

const BLOCK: &str = "agent-upload-token-lockdown";
const MIGRATION: &str = "server/Migrations/189_agent_upload_token.sql";
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
    for needle in [
        "to_regclass('public.agent_upload_token') IS NULL",
        "REVOKE ALL ON TABLE public.agent_upload_token FROM PUBLIC",
        "REVOKE ALL ON TABLE public.agent_upload_token FROM %I",
        "WHEN 'momo_app' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']",
        "ELSE ARRAY[]::text[]",
        "'momo_relay'",
        "'momo_worker'",
        "'momo_notifier'",
        "'momo_platform_admin'",
        "'momo_helper_read'",
        "'momo_memory'",
        "ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']",
        "has_table_privilege(r, 'public.agent_upload_token', p) IS DISTINCT FROM (p = ANY (allowed))",
        "RAISE EXCEPTION",
    ] {
        assert!(block.contains(needle), "the block lost `{needle}`");
    }
    assert_eq!(
        block.matches("THEN ARRAY[").count(),
        1,
        "the block must grant to momo_app and nobody else"
    );
    for forbidden in [
        "momo_worker' THEN",
        "momo_relay' THEN",
        "momo_notifier' THEN",
        "momo_platform_admin' THEN",
        "momo_helper_read' THEN",
        "momo_memory' THEN",
        "ALL ON TABLE public.agent_upload_token TO",
        "GRANT ALL",
        "attachment_write_token",
    ] {
        // statements only: the block's comment names the worker road's table to say why it differs
        assert!(
            !statements(&block).contains(forbidden),
            "the block grants `{forbidden}`"
        );
    }
}

#[test]
fn the_block_comes_after_the_table_and_no_grant_stands_outside_it() {
    let text = read(MIGRATION);
    let (begin, block) = block_of(MIGRATION, &text);
    for needle in [
        "CREATE TABLE agent_upload_token (",
        "CREATE TRIGGER agent_upload_token_guard BEFORE UPDATE ON agent_upload_token",
        "ALTER TABLE %I FORCE ROW LEVEL SECURITY",
    ] {
        let at = text
            .find(needle)
            .unwrap_or_else(|| panic!("the migration lost `{needle}`"));
        assert!(at < begin, "`{needle}` must come before the lockdown block");
    }
    let outside = text.replace(&block, "");
    assert!(
        !statements(&outside).to_uppercase().contains("GRANT"),
        "a GRANT outside the lockdown block: {}",
        statements(&outside)
    );
}

#[test]
fn the_token_table_has_no_foreign_key_and_the_mark_keeps_its_guard() {
    let sql = statements(&read(MIGRATION));
    let from = sql
        .find("CREATE TABLE agent_upload_token (")
        .expect("the migration creates the token table");
    let create = &sql[from..from + sql[from..].find(");").expect("the statement ends")];
    for forbidden in ["REFERENCES", "FOREIGN KEY"] {
        assert!(
            !create.to_uppercase().contains(forbidden),
            "a foreign key on the token table lets a cascade clear the counts it is the source of: {create}"
        );
    }
    // the only statement on the mark table: its run_id admits this road's rows; nothing else of 179 moves
    let on_mark: Vec<&str> = sql
        .lines()
        .filter(|line| line.contains("agent_picture_mark"))
        .collect();
    assert_eq!(
        on_mark,
        ["ALTER TABLE agent_picture_mark ALTER COLUMN run_id DROP NOT NULL;"],
        "189 may only drop NOT NULL on agent_picture_mark.run_id"
    );
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
