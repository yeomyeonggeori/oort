//! #5371 (ADR-0151 증보 8 W1, security review M2) and #5530 (증보 8 보충, implementation review M-1 (b)) — the
//! table-privilege lockdown of `attachment_write_token` and of `agent_picture_mark` is one block of SQL each,
//! and each block lives in three files. These are the guards that keep the three the same text and in the
//! one order in which the last file applied cannot undo it. No database: it reads the files. (The same shape
//! as `self_media_static_guards.rs`; the privileges a database ends up with are measured against a real
//! Postgres by `agent_picture_pg` and `prod_role_conformance_pg`.)
//!
//! The migration that carries the **current** copy of both blocks is 179. 175 keeps the first copy of the
//! token block (an applied file is not edited; the same arrangement as 169 → 177 for `team-ai-task-lockdown`):
//! its worker arm still says DELETE, and 179, applied after it, takes the verb away; both bootstrap files carry
//! the text of 179.
//!
//! | test | what turns it red |
//! |---|---|
//! | `each_lockdown_block_is_the_same_text_in_the_migration_and_both_bootstrap_files` | any edit to one copy and not the others (either block) |
//! | `both_bootstrap_files_apply_each_block_after_they_grant_every_table` | moving a block above the `ALL TABLES` grant (the grant would hand every verb back) |
//! | `the_migrations_apply_each_block_after_they_created_the_table` | moving the mark block above its `CREATE TABLE` (a pass before the table exists returns early and locks nothing); 175's first copy of the token block likewise |
//! | `the_migrations_grant_nothing_on_the_tables_outside_the_blocks` | a `GRANT` re-added to 175 or 179 after or beside a block |
//! | `the_token_block_still_says_what_it_exists_for` | a block that compares equal because it was emptied everywhere, a worker arm that has DELETE again, an api arm that lost it, or a grant to a role the flow does not use |
//! | `the_mark_block_still_says_what_it_exists_for` | the same for the mark table: any grant at all to the worker, relay, notifier, platform_admin or the helper's read role; an UPDATE for anybody; a role loop that no longer walks the helper's read role |
//! | `the_mark_table_has_no_foreign_key_and_the_ceiling_counts_what_the_trigger_protects` | a `REFERENCES` / `FOREIGN KEY` in the mark table's `CREATE TABLE` (a cascade runs as the table's owner and would clear the count), the 24-hour window of the count and of the trigger drifting apart |

use std::path::PathBuf;

const TOKEN: &str = "attachment-write-token-lockdown";
const MARK: &str = "agent-picture-mark-lockdown";
/// The migration that carries the **current** copy of both blocks.
const MIGRATION: &str = "server/Migrations/179_agent_picture_mark.sql";
/// The first copy of the token block (an applied file: not edited, superseded by 179's).
const FIRST_TOKEN_MIGRATION: &str = "server/Migrations/175_attachment_write_token.sql";
const DEV: &str = "infra/rust/sql/bootstrap_roles.sql";
const RUNTIME: &str = "infra/rust/sql/bootstrap_runtime_roles.sql";
const CODE: &str = "server-rust/crates/momo-messaging/src/agent_picture.rs";

fn read(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"))
}

/// The text from the BEGIN marker through the END marker, and where it starts.
fn block_of(name: &str, relative: &str, text: &str) -> (usize, String) {
    let begin_marker = format!("-- BEGIN {name}");
    let end_marker = format!("-- END {name}");
    assert_eq!(
        text.matches(&begin_marker).count(),
        1,
        "{relative}: exactly one BEGIN marker of {name}"
    );
    assert_eq!(
        text.matches(&end_marker).count(),
        1,
        "{relative}: exactly one END marker of {name}"
    );
    let begin = text.find(&begin_marker).unwrap();
    let end = text.find(&end_marker).unwrap() + end_marker.len();
    assert!(begin < end, "{relative}: markers of {name} in order");
    (begin, text[begin..end].to_string())
}

/// Source lines that are not SQL comments: a comment that names a role or a verb is not a statement.
fn statements(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn each_lockdown_block_is_the_same_text_in_the_migration_and_both_bootstrap_files() {
    for name in [TOKEN, MARK] {
        let (_, migration) = block_of(name, MIGRATION, &read(MIGRATION));
        let (_, dev) = block_of(name, DEV, &read(DEV));
        let (_, runtime) = block_of(name, RUNTIME, &read(RUNTIME));
        assert_eq!(
            migration, dev,
            "{name}: bootstrap_roles.sql drifted from the migration"
        );
        assert_eq!(
            migration, runtime,
            "{name}: bootstrap_runtime_roles.sql drifted from the migration"
        );
    }
}

#[test]
fn both_bootstrap_files_apply_each_block_after_they_grant_every_table() {
    for relative in [DEV, RUNTIME] {
        let text = read(relative);
        for name in [TOKEN, MARK] {
            let (begin, _) = block_of(name, relative, &text);
            // the LAST such grant: one added after the block would hand every verb back just the same
            let grant = text
                .rfind("ON ALL TABLES IN SCHEMA public")
                .unwrap_or_else(|| panic!("{relative}: no ALL TABLES grant to come after"));
            assert!(
                grant < begin,
                "{relative}: the {name} lockdown must come after every ALL TABLES grant, or the grant hands the verbs back"
            );
            // and the default privileges a later-created table inherits come first as well
            let defaults = text
                .rfind("ALTER DEFAULT PRIVILEGES IN SCHEMA public")
                .unwrap_or_else(|| panic!("{relative}: no default privileges"));
            assert!(
                defaults < begin,
                "{relative}: the {name} lockdown comes last"
            );
        }
    }
}

#[test]
fn the_migrations_apply_each_block_after_they_created_the_table() {
    // 179: the mark table is created here, and its trigger and RLS statements come before the block
    let text = read(MIGRATION);
    let (begin, _) = block_of(MARK, MIGRATION, &text);
    let created = text
        .find("CREATE TABLE agent_picture_mark (")
        .expect("the migration creates the mark table");
    // The block starts with `to_regclass(...) IS NULL THEN RETURN`: placed above the CREATE TABLE it
    // would finish before the table exists and the migration would lock nothing (the bootstrap files
    // would be the only thing standing, and they run after the migration only on some paths).
    assert!(
        created < begin,
        "the block must come after CREATE TABLE agent_picture_mark"
    );
    for needle in [
        "CREATE TRIGGER agent_picture_mark_guard BEFORE UPDATE OR DELETE ON agent_picture_mark",
        "ALTER TABLE %I FORCE ROW LEVEL SECURITY",
    ] {
        let at = text
            .find(needle)
            .unwrap_or_else(|| panic!("the migration lost `{needle}`"));
        assert!(at < begin, "`{needle}` must come before the lockdown block");
    }
    // 179's token block re-issues the one 175 created the table for; 175 comes first by its number, and its own
    // copy still stands after its CREATE TABLE
    let first = read(FIRST_TOKEN_MIGRATION);
    let (first_begin, _) = block_of(TOKEN, FIRST_TOKEN_MIGRATION, &first);
    assert!(
        first
            .find("CREATE TABLE attachment_write_token (")
            .expect("175 creates the token table")
            < first_begin,
        "175's block must come after CREATE TABLE attachment_write_token"
    );
    // the token block of 179 re-issues, it does not create
    assert!(
        !statements(&text).contains("CREATE TABLE attachment_write_token"),
        "179 must not create the token table"
    );
}

#[test]
fn the_migrations_grant_nothing_on_the_tables_outside_the_blocks() {
    // 179: strip BOTH blocks, then no GRANT may remain
    let text = read(MIGRATION);
    let (_, mark) = block_of(MARK, MIGRATION, &text);
    let (_, token) = block_of(TOKEN, MIGRATION, &text);
    let outside = text.replace(&mark, "").replace(&token, "");
    assert!(
        !statements(&outside).to_uppercase().contains("GRANT"),
        "a GRANT outside the lockdown blocks would change what the blocks settle: {}",
        statements(&outside)
    );
    // 175: its one block, and nothing else
    let first = read(FIRST_TOKEN_MIGRATION);
    let (_, first_block) = block_of(TOKEN, FIRST_TOKEN_MIGRATION, &first);
    let outside = first.replace(&first_block, "");
    assert!(
        !statements(&outside).to_uppercase().contains("GRANT"),
        "a GRANT outside 175's lockdown block would change what the blocks settle: {}",
        statements(&outside)
    );
}

#[test]
fn the_token_block_still_says_what_it_exists_for() {
    let (_, block) = block_of(TOKEN, MIGRATION, &read(MIGRATION));
    for needle in [
        // it is a no-op until the table exists, and it starts from nothing for everybody
        "to_regclass('public.attachment_write_token') IS NULL",
        "REVOKE ALL ON TABLE public.attachment_write_token FROM PUBLIC",
        "REVOKE ALL ON TABLE public.attachment_write_token FROM %I",
        // the api spends a token, records the attachment it made and sweeps; the worker mints and reads
        "WHEN 'momo_app' THEN ARRAY['SELECT', 'UPDATE', 'DELETE']",
        "WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT']",
        // relay, notifier and platform_admin get nothing: they are in the loop and fall to the ELSE
        "ELSE ARRAY[]::text[]",
        "'momo_relay'",
        "'momo_notifier'",
        "'momo_platform_admin'",
        // and the result is checked against the table for all seven verbs, loudly
        "ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']",
        "has_table_privilege(r, 'public.attachment_write_token', p) IS DISTINCT FROM (p = ANY (allowed))",
        "RAISE EXCEPTION",
    ] {
        assert!(block.contains(needle), "the block lost `{needle}`");
    }
    // exactly two roles get anything: a third arm (for relay, notifier or platform_admin, under any
    // spelling) is a privilege the flow does not use
    assert_eq!(
        block.matches("THEN ARRAY[").count(),
        2,
        "the block must grant to exactly momo_app and momo_worker"
    );
    // the privileges the flow does not use are not in it
    for forbidden in [
        // the worker's DELETE is gone for good (#5530): it freed its own spent slot, and the sweep is the api's
        "WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT', 'DELETE']",
        "WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT', 'UPDATE'",
        // the api never creates a token
        "WHEN 'momo_app' THEN ARRAY['SELECT', 'INSERT'",
        "momo_relay' THEN",
        "momo_notifier' THEN",
        "momo_platform_admin' THEN",
        "ALL ON TABLE public.attachment_write_token TO",
        "GRANT ALL",
        // a copy-paste from the read table's block that kept the wrong table name
        "self_media_token",
    ] {
        assert!(!block.contains(forbidden), "the block grants `{forbidden}`");
    }
}

#[test]
fn the_mark_block_still_says_what_it_exists_for() {
    let (_, block) = block_of(MARK, MIGRATION, &read(MIGRATION));
    for needle in [
        "to_regclass('public.agent_picture_mark') IS NULL",
        "REVOKE ALL ON TABLE public.agent_picture_mark FROM PUBLIC",
        "REVOKE ALL ON TABLE public.agent_picture_mark FROM %I",
        // the api counts, writes the row and sweeps; nobody updates
        "WHEN 'momo_app' THEN ARRAY['SELECT', 'INSERT', 'DELETE']",
        // everybody else, the helper's read role included, falls to the ELSE and holds nothing
        "ELSE ARRAY[]::text[]",
        "'momo_relay'",
        "'momo_worker'",
        "'momo_notifier'",
        "'momo_platform_admin'",
        "'momo_helper_read'",
        "ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']",
        "has_table_privilege(r, 'public.agent_picture_mark', p) IS DISTINCT FROM (p = ANY (allowed))",
        "RAISE EXCEPTION",
    ] {
        assert!(block.contains(needle), "the block lost `{needle}`");
    }
    // exactly ONE arm: the api. A second arm — the worker above all — is the hole this table exists to close.
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
        "ALL ON TABLE public.agent_picture_mark TO",
        "GRANT ALL",
    ] {
        assert!(!block.contains(forbidden), "the block grants `{forbidden}`");
    }
    // nobody updates a mark, the api included: the grant arm is the one line that names verbs to give
    let arm: String = block
        .lines()
        .filter(|line| line.contains("THEN ARRAY["))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !arm.contains("UPDATE") && !arm.contains("TRUNCATE") && !arm.contains("REFERENCES"),
        "the grant arm hands out a verb nothing needs: {arm}"
    );
}

#[test]
fn the_mark_table_has_no_foreign_key_and_the_ceiling_counts_what_the_trigger_protects() {
    let migration = read(MIGRATION);
    let sql = statements(&migration);
    // the mark table's CREATE TABLE, through its closing `);`
    let from = sql
        .find("CREATE TABLE agent_picture_mark (")
        .expect("the migration creates the mark table");
    let create = &sql[from..from + sql[from..].find(");").expect("the statement ends")];
    for forbidden in ["REFERENCES", "FOREIGN KEY"] {
        assert!(
            !create.to_uppercase().contains(forbidden),
            "a foreign key on the mark table lets a cascade (it runs as the table's owner) clear the count: {create}"
        );
    }
    // no other statement in the migration points a key at the table either
    for line in sql.lines() {
        let upper = line.to_uppercase();
        assert!(
            !(upper.contains("REFERENCES") && upper.contains("AGENT_PICTURE_MARK")),
            "something references the mark table: {line}"
        );
    }
    // the count's window and the trigger's window are one number: 24 hours
    let code = read(CODE);
    assert!(
        code.contains("SELECT count(*) FROM agent_picture_mark")
            && code.contains(
                "WHERE workspace_id = $1 AND written_at > clock_timestamp() - interval '24 hours'"
            ),
        "the count reads the marks of the last 24 hours"
    );
    assert!(
        sql.contains("OLD.written_at > clock_timestamp() - interval '24 hours'"),
        "the trigger refuses the delete of exactly the rows the count sees"
    );
}
