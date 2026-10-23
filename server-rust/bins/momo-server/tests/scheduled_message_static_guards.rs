//! #4214 / ADR-0208 — the guards that need no database, so they run in every `cargo test`.
//!
//! | test | what it keeps | revert that makes it red |
//! |---|---|---|
//! | `a_foreign_member_guc_is_bound_only_in_the_three_named_functions` | D14 point 4: only `hold_member_schedules_in_tx`, `hold_lineage_schedules_in_tx` and `cancel_member_schedules_in_tx` bind another member's `app.member_id`; nothing sets that GUC behind the helper | a fourth `set_config('app.member_id' …` file, a fourth caller of `bind_foreign_owner_guc`, or one of the three dropping the call |
//! | `the_scans_go_red_on_a_synthetic_fourth_offender` | the scans above can fail (a text scan that cannot fail proves nothing) | the scan stops seeing a spelling, or the allow-list stops being compared |
//! | `the_lockdown_block_is_the_same_text_in_the_migration_and_both_bootstrap_files` | one `scheduled-message-lockdown`, three copies, no drift | any edit to one copy |

#[path = "common/owner_scope_scan.rs"]
mod owner_scope_scan;

use owner_scope_scan::{callers_of, load_sources, raw_binder_files, violations, Source};
use std::path::PathBuf;

fn server_rust() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn a_foreign_member_guc_is_bound_only_in_the_three_named_functions() {
    let sources = load_sources(&server_rust());
    assert!(
        sources.len() > 100,
        "the scan must actually see the tree ({} files)",
        sources.len()
    );
    let problems = violations(&sources);
    assert!(problems.is_empty(), "{problems:#?}");
}

fn synthetic(path: &str, text: &str) -> Source {
    Source {
        path: path.to_string(),
        text: text.to_string(),
    }
}

#[test]
fn the_scans_go_red_on_a_synthetic_fourth_offender() {
    let clean = load_sources(&server_rust());
    assert!(violations(&clean).is_empty(), "the baseline is clean");

    let with = |extra: Source| {
        let mut sources = load_sources(&server_rust());
        sources.push(extra);
        violations(&sources)
    };

    // scan A — a fourth file binds the member scope itself, in each spelling
    for (label, body) in [
        (
            "set_config",
            "async fn sneak(c: &mut C) { sqlx::query(\"SELECT set_config('app.member_id', $1, true)\"); }",
        ),
        (
            "set_config split over lines",
            "async fn sneak(c: &mut C) { sqlx::query(\"SELECT set_config(\n 'app.member_id', $1, true)\"); }",
        ),
        ("SET LOCAL", "const SQL: &str = \"SET LOCAL app.member_id = 'x'\";"),
        ("SET", "const SQL: &str = \"set   app.member_id to 'x'\";"),
    ] {
        let problems = with(synthetic("crates/momo-foo/src/lib.rs", body));
        assert!(
            problems
                .iter()
                .any(|problem| problem.contains("crates/momo-foo/src/lib.rs")),
            "{label}: scan A must flag a fourth file: {problems:?}"
        );
    }
    // …but a test module's own binding is not production code
    let in_tests = with(synthetic(
        "crates/momo-foo/src/lib.rs",
        "pub fn ok() {}\n#[cfg(test)]\nmod tests { const S: &str = \"set_config('app.member_id', $1, true)\"; }",
    ));
    assert!(in_tests.is_empty(), "{in_tests:?}");

    // scan B — a fourth function calls the foreign binder (or its restore)
    for callee in ["bind_foreign_owner_guc", "restore_owner_guc"] {
        let problems = with(synthetic(
            "crates/momo-messaging/src/extra.rs",
            &format!("pub async fn a_fourth_function(conn: &mut C) {{ {callee}(conn).await; }}"),
        ));
        assert!(
            problems
                .iter()
                .any(|problem| problem.contains(callee) && problem.contains("a_fourth_function")),
            "{callee}: scan B must name the fourth caller: {problems:?}"
        );
    }
    // …and one of the three that stops calling it is just as wrong (the exception would be dead)
    let mut sources = load_sources(&server_rust());
    for source in &mut sources {
        if source.path.ends_with("momo-messaging/src/scheduled.rs") {
            source.text = source.text.replacen(
                "bind_foreign_owner_guc(conn, member_id)",
                "bind_owner_guc(conn, member_id)",
                1,
            );
        }
    }
    assert!(
        violations(&sources)
            .iter()
            .any(|problem| problem.contains("bind_foreign_owner_guc")),
        "scan B must notice a named function that no longer binds"
    );

    // the helpers see what they should: three callers, once each
    let real = load_sources(&server_rust());
    assert_eq!(callers_of(&real, "bind_foreign_owner_guc").len(), 3);
    assert_eq!(callers_of(&real, "restore_owner_guc").len(), 3);
    assert!(raw_binder_files(&real).contains("crates/momo-messaging/src/owner_scope.rs"));
}

fn lockdown_block(relative: &str) -> String {
    let path = server_rust().join("../").join(relative);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"));
    assert_eq!(
        text.matches("-- BEGIN scheduled-message-lockdown").count(),
        1,
        "{relative}: exactly one BEGIN marker"
    );
    assert_eq!(
        text.matches("-- END scheduled-message-lockdown").count(),
        1,
        "{relative}: exactly one END marker"
    );
    let begin = text.find("-- BEGIN scheduled-message-lockdown").unwrap();
    let end = text.find("-- END scheduled-message-lockdown").unwrap()
        + "-- END scheduled-message-lockdown".len();
    assert!(begin < end, "{relative}: markers in order");
    text[begin..end].to_string()
}

#[test]
fn the_lockdown_block_is_the_same_text_in_the_migration_and_both_bootstrap_files() {
    let migration = lockdown_block("server/Migrations/145_scheduled_message.sql");
    let dev = lockdown_block("infra/rust/sql/bootstrap_roles.sql");
    let runtime = lockdown_block("infra/rust/sql/bootstrap_runtime_roles.sql");
    assert_eq!(
        migration, dev,
        "bootstrap_roles.sql drifted from the migration"
    );
    assert_eq!(
        migration, runtime,
        "bootstrap_runtime_roles.sql drifted from the migration"
    );
    // the block still says what it exists for (a comparison of three empty strings would pass)
    for needle in [
        "REVOKE ALL ON TABLE public.%I FROM %I",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO momo_app",
        "to_regprocedure(f) IS NULL",
        "must not execute",
        "momo_sched_definer",
    ] {
        assert!(migration.contains(needle), "the block lost `{needle}`");
    }
}
