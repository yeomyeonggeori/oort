//! #5371 (ADR-0151 증보 8 W1, security review M2) — the table-privilege lockdown of
//! `attachment_write_token` is one block of SQL that lives in three files, and these are the guards that
//! keep the three the same text and in the one order in which the last file applied cannot undo it. No
//! database: it reads the files. (The same shape as `self_media_static_guards.rs`, for the new block.)
//!
//! | test | what turns it red |
//! |---|---|
//! | `the_lockdown_block_is_the_same_text_in_the_migration_and_both_bootstrap_files` | any edit to one copy and not the others |
//! | `both_bootstrap_files_apply_the_block_after_they_grant_every_table` | moving the block above the `ALL TABLES` grant (the grant would hand every verb back) |
//! | `the_migration_applies_the_block_after_it_created_the_table` | moving the block above `CREATE TABLE` (a pass before the table exists returns early and locks nothing) |
//! | `the_migration_grants_nothing_on_the_table_outside_the_block` | a `GRANT` re-added to the migration after or beside the block |
//! | `the_block_still_says_what_it_exists_for` | a block that compares equal because it was emptied everywhere, or one that grants a role the flow does not need |

use std::path::PathBuf;

const BEGIN: &str = "-- BEGIN attachment-write-token-lockdown";
const END: &str = "-- END attachment-write-token-lockdown";
const MIGRATION: &str = "server/Migrations/175_attachment_write_token.sql";
const DEV: &str = "infra/rust/sql/bootstrap_roles.sql";
const RUNTIME: &str = "infra/rust/sql/bootstrap_runtime_roles.sql";

fn read(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"))
}

/// The text from the BEGIN marker through the END marker, and where it starts.
fn block_of(relative: &str, text: &str) -> (usize, String) {
    assert_eq!(
        text.matches(BEGIN).count(),
        1,
        "{relative}: exactly one BEGIN marker"
    );
    assert_eq!(
        text.matches(END).count(),
        1,
        "{relative}: exactly one END marker"
    );
    let begin = text.find(BEGIN).unwrap();
    let end = text.find(END).unwrap() + END.len();
    assert!(begin < end, "{relative}: markers in order");
    (begin, text[begin..end].to_string())
}

#[test]
fn the_lockdown_block_is_the_same_text_in_the_migration_and_both_bootstrap_files() {
    let (_, migration) = block_of(MIGRATION, &read(MIGRATION));
    let (_, dev) = block_of(DEV, &read(DEV));
    let (_, runtime) = block_of(RUNTIME, &read(RUNTIME));
    assert_eq!(
        migration, dev,
        "bootstrap_roles.sql drifted from the migration"
    );
    assert_eq!(
        migration, runtime,
        "bootstrap_runtime_roles.sql drifted from the migration"
    );
}

#[test]
fn both_bootstrap_files_apply_the_block_after_they_grant_every_table() {
    for relative in [DEV, RUNTIME] {
        let text = read(relative);
        let (begin, _) = block_of(relative, &text);
        // the LAST such grant: one added after the block would hand every verb back just the same
        let grant = text
            .rfind("ON ALL TABLES IN SCHEMA public")
            .unwrap_or_else(|| panic!("{relative}: no ALL TABLES grant to come after"));
        assert!(
            grant < begin,
            "{relative}: the lockdown must come after every ALL TABLES grant, or the grant hands the verbs back"
        );
        // and the default privileges a later-created table inherits come first as well
        let defaults = text
            .rfind("ALTER DEFAULT PRIVILEGES IN SCHEMA public")
            .unwrap_or_else(|| panic!("{relative}: no default privileges"));
        assert!(defaults < begin, "{relative}: the lockdown comes last");
    }
}

#[test]
fn the_migration_applies_the_block_after_it_created_the_table() {
    let text = read(MIGRATION);
    let (begin, _) = block_of(MIGRATION, &text);
    let created = text
        .find("CREATE TABLE attachment_write_token (")
        .expect("the migration creates the table");
    // The block starts with `to_regclass(...) IS NULL THEN RETURN`: placed above the CREATE TABLE it
    // would finish before the table exists and the migration would lock nothing (the bootstrap files
    // would be the only thing standing, and they run after the migration only on some paths).
    assert!(
        created < begin,
        "the block must come after CREATE TABLE attachment_write_token"
    );
    // the guard trigger and the RLS statements belong to the same table and come before it as well
    for needle in [
        "CREATE TRIGGER attachment_write_token_guard BEFORE UPDATE ON attachment_write_token",
        "ALTER TABLE %I FORCE ROW LEVEL SECURITY",
    ] {
        let at = text
            .find(needle)
            .unwrap_or_else(|| panic!("the migration lost `{needle}`"));
        assert!(at < begin, "`{needle}` must come before the lockdown block");
    }
}

#[test]
fn the_migration_grants_nothing_on_the_table_outside_the_block() {
    let text = read(MIGRATION);
    let (_, block) = block_of(MIGRATION, &text);
    let outside = text.replace(&block, "");
    // the comments name the roles and verbs; only an actual statement would matter
    let statements: String = outside
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !statements.to_uppercase().contains("GRANT"),
        "a GRANT outside the lockdown block would change what the block settles: {statements}"
    );
}

#[test]
fn the_block_still_says_what_it_exists_for() {
    let (_, block) = block_of(MIGRATION, &read(MIGRATION));
    for needle in [
        // it is a no-op until the table exists, and it starts from nothing for everybody
        "to_regclass('public.attachment_write_token') IS NULL",
        "REVOKE ALL ON TABLE public.attachment_write_token FROM PUBLIC",
        "REVOKE ALL ON TABLE public.attachment_write_token FROM %I",
        // the api spends a token and records the attachment it made; the worker mints and sweeps
        "WHEN 'momo_app' THEN ARRAY['SELECT', 'UPDATE']",
        "WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT', 'DELETE']",
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
