//! #4820 C2a security review (L6) — the table-privilege lockdown is one block of SQL that lives in
//! three files, and these are the guards that keep the three the same text and in the one order in
//! which the last file applied cannot undo it. No database: it reads the files.
//!
//! | test | what turns it red |
//! |---|---|
//! | `the_lockdown_block_is_the_same_text_in_the_migration_and_both_bootstrap_files` | any edit to one copy and not the others |
//! | `both_bootstrap_files_apply_the_block_after_they_grant_every_table` | moving the block above the `ALL TABLES` grant (the grant would hand every verb back) |
//! | `the_migration_grants_nothing_on_the_table_outside_the_block` | a `GRANT` re-added to the migration after or beside the block |
//! | `the_block_still_says_what_it_exists_for` | a block that compares equal because it was emptied everywhere |

use std::path::PathBuf;

const BEGIN: &str = "-- BEGIN self-media-token-lockdown";
const END: &str = "-- END self-media-token-lockdown";
const MIGRATION: &str = "server/Migrations/160_self_media_token.sql";
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
        "REVOKE ALL ON TABLE public.self_media_token FROM PUBLIC",
        "REVOKE ALL ON TABLE public.self_media_token FROM %I",
        "WHEN 'momo_app' THEN ARRAY['SELECT', 'UPDATE']",
        "WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT', 'DELETE']",
        "ELSE ARRAY[]::text[]",
        "'momo_relay'",
        "'momo_notifier'",
        "'momo_platform_admin'",
        "RAISE EXCEPTION",
        "to_regclass('public.self_media_token') IS NULL",
    ] {
        assert!(block.contains(needle), "the block lost `{needle}`");
    }
    // the privileges the flow does not use are not in it
    for forbidden in [
        "momo_relay' THEN",
        "momo_notifier' THEN",
        "ALL ON TABLE public.self_media_token TO",
    ] {
        assert!(!block.contains(forbidden), "the block grants `{forbidden}`");
    }
}
