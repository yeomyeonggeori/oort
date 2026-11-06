//! #5459 S1a (ADR-0218 증보 6 §12 L10.1, A38) — the `expression_set` privilege lockdown is one block of
//! SQL that lives in three files, and these are the guards that keep the three the same text and in
//! the one order in which the last file applied cannot undo it. No database: it reads the files.
//! (The privileges a database ends up with are measured against a real Postgres by `set_pg`, A37.)
//! Same four guards as `momo-agent/tests/team_ai_task_static_guards.rs` (169), plus one that reads
//! the block's verb table as data.
//!
//! | test | what turns it red |
//! |---|---|
//! | `the_lockdown_block_is_the_same_text_in_the_migration_and_both_bootstrap_files` | any edit to one copy and not the others |
//! | `both_bootstrap_files_apply_the_block_after_they_grant_every_table` | moving the block above the `ALL TABLES` grant or the default privileges (they would hand every verb back) |
//! | `the_migration_grants_nothing_outside_the_block` | a `GRANT` added to the migration after or beside the block (the RLS loop of 159 has one) |
//! | `the_block_still_says_what_it_exists_for` | a block that compares equal because it was emptied everywhere, or one that names a role it must not |
//! | `the_verb_table_in_the_block_is_exactly_the_one_in_the_adr` | a verb added or dropped for any role on any of the four tables (L10.1's table) |

use std::path::PathBuf;

const BEGIN: &str = "-- BEGIN expression-set-lockdown";
const END: &str = "-- END expression-set-lockdown";
const MIGRATION: &str = "server/Migrations/177_expression_set.sql";
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
fn the_migration_grants_nothing_outside_the_block() {
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
        "REVOKE ALL ON TABLE public.%I FROM PUBLIC",
        "REVOKE ALL ON TABLE public.%I FROM %I",
        "ELSE ARRAY[]::text[]",
        "'momo_relay'",
        "'momo_notifier'",
        "'momo_platform_admin'",
        "'momo_helper_read'",
        "GRANT SELECT (workspace_id, state, expires_at) ON expression_set TO momo_notifier",
        "has_table_privilege",
        "has_column_privilege",
        "RAISE EXCEPTION",
        "to_regclass(format('public.%I', t)) IS NULL",
        // the reason the block exists, in the block's own words
        "BYPASSRLS",
        "T20",
    ] {
        assert!(block.contains(needle), "the block lost `{needle}`");
    }
    // nobody is handed everything, and no role the code does not use for these tables is named as a
    // key of the verb table (the CASE keys read `<table>/<role>`)
    for forbidden in [
        "ALL ON TABLE public.%I TO",
        "/momo_relay'",
        "/momo_notifier' THEN",
        "/momo_platform_admin'",
        "/momo_helper_read'",
    ] {
        assert!(!block.contains(forbidden), "the block grants `{forbidden}`");
    }
}

/// L10.1's table, as data: `(table/role, verbs)`. The block repeats its verb table once for the
/// grant pass and once for the verification pass; both must equal this, so changing one pass
/// alone, or one cell of either, turns this red.
#[test]
fn the_verb_table_in_the_block_is_exactly_the_one_in_the_adr() {
    let expected: [(&str, &[&str]); 8] = [
        ("expression_set/momo_worker", &["SELECT", "INSERT", "UPDATE"]),
        ("expression_set/momo_app", &["SELECT", "UPDATE"]),
        ("expression_set_slot/momo_worker", &["SELECT", "INSERT", "UPDATE"]),
        ("expression_set_slot/momo_app", &["SELECT", "UPDATE"]),
        ("expression_set_image/momo_worker", &["SELECT", "INSERT", "DELETE"]),
        ("expression_set_image/momo_app", &["SELECT", "DELETE"]),
        ("expression_set_notice/momo_worker", &["SELECT"]),
        ("expression_set_notice/momo_app", &["SELECT", "INSERT"]),
    ];
    for relative in [MIGRATION, DEV, RUNTIME] {
        let (_, block) = block_of(relative, &read(relative));
        let arms: Vec<(String, Vec<String>)> = block
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let rest = line.strip_prefix("WHEN '")?;
                let (key, rest) = rest.split_once("' THEN ARRAY[")?;
                let verbs = rest.strip_suffix(']')?;
                Some((
                    key.to_string(),
                    verbs
                        .split(',')
                        .map(|verb| verb.trim().trim_matches('\'').to_string())
                        .collect(),
                ))
            })
            .collect();
        assert_eq!(
            arms.len(),
            expected.len() * 2,
            "{relative}: the table appears once per pass (grant, verify), eight cells each"
        );
        for pass in arms.chunks(expected.len()) {
            for ((key, verbs), (want_key, want_verbs)) in pass.iter().zip(expected.iter()) {
                assert_eq!(key, want_key, "{relative}: cell order");
                assert_eq!(
                    verbs.iter().map(String::as_str).collect::<Vec<_>>(),
                    want_verbs.to_vec(),
                    "{relative}: the verbs of {key} are not the ADR's"
                );
            }
        }
    }
}
