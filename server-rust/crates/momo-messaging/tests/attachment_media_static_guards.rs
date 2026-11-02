//! #4673 C5 (ADR-0151 증보 5 D5) — the `attachment_media` privilege lockdown is one block of SQL that
//! lives in three files, the table's foreign key must be one the reclaim check names, and the
//! poster's bytes may be named by exactly one module. These are the guards that keep those three
//! facts from drifting. No database: it reads files. (The privileges a database ends up with, the
//! tenant boundary and the cascade are measured against a real Postgres by
//! `attachment_media_conformance_pg`; the role scan lives in `prod_role_conformance_pg`.)
//!
//! | test | what turns it red |
//! |---|---|
//! | `the_lockdown_block_is_the_same_text_in_the_migration_and_both_bootstrap_files` | any edit to one copy and not the others |
//! | `both_bootstrap_files_apply_the_block_after_they_grant_every_table` | moving the block above the `ALL TABLES` grant (the grant would hand every verb back) |
//! | `the_migration_grants_nothing_on_the_table_outside_the_block` | a `GRANT` re-added to the migration after or beside the block |
//! | `the_block_still_says_what_it_exists_for` | a block that compares equal because it was emptied everywhere, a role handed a verb the code does not use, or the team AI's read role handed the poster's bytes |
//! | `the_reclaim_check_names_the_media_foreign_key` | the migration's FK renamed (or the check SQL's known list edited) without the other |
//! | `only_one_module_names_the_posters_bytes` | any other source file selecting, binding or mentioning the column: a new projection that would carry the picture |

use std::path::{Path, PathBuf};

const BEGIN: &str = "-- BEGIN attachment-media-lockdown";
const END: &str = "-- END attachment-media-lockdown";
const MIGRATION: &str = "server/Migrations/173_attachment_media.sql";
const DEV: &str = "infra/rust/sql/bootstrap_roles.sql";
const RUNTIME: &str = "infra/rust/sql/bootstrap_runtime_roles.sql";
const CHECK_SQL: &str = "infra/rust/sql/attachment_reclaim_check.sql";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn read(relative: &str) -> String {
    let path = repo_root().join(relative);
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
        "REVOKE ALL ON TABLE public.attachment_media FROM PUBLIC",
        "REVOKE ALL ON TABLE public.attachment_media FROM %I",
        "WHEN 'momo_app' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']",
        "ELSE ARRAY[]::text[]",
        "'momo_relay'",
        "'momo_worker'",
        "'momo_notifier'",
        "'momo_platform_admin'",
        "'momo_helper_read'",
        "RAISE EXCEPTION",
        "to_regclass('public.attachment_media') IS NULL",
        // the helper role reads the summary columns, and the poster's bytes are not among them
        "GRANT SELECT (workspace_id, attachment_id, duration_ms, width, height, poster_mime, poster_width, poster_height, created_at)",
        "has_column_privilege",
        "c <> 'poster_bytes'",
    ] {
        assert!(block.contains(needle), "the block lost `{needle}`");
    }
    // the privileges the code does not use are not in it: the BYPASSRLS roles that skip the row
    // policy get nothing at all and nobody is handed everything (the app's exact array is pinned
    // by the needles above, so a `DELETE` appended to it is a different text and fails there)
    for forbidden in [
        "WHEN 'momo_relay' THEN",
        "WHEN 'momo_worker' THEN",
        "WHEN 'momo_notifier' THEN",
        "WHEN 'momo_platform_admin' THEN",
        "WHEN 'momo_helper_read' THEN",
        "ALL ON TABLE public.attachment_media TO",
    ] {
        assert!(!block.contains(forbidden), "the block grants `{forbidden}`");
    }
    // the helper role's column list never names the poster's bytes
    let grant = block
        .lines()
        .find(|line| line.contains("GRANT SELECT (workspace_id"))
        .expect("the helper role's column grant");
    assert!(
        !grant.contains("poster_bytes"),
        "the team AI's read role must not be granted the poster's bytes: {grant}"
    );
}

#[test]
fn the_reclaim_check_names_the_media_foreign_key() {
    // the migration declares the constraint by name, and the check SQL's section 4 knows that name:
    // an unknown foreign key into `attachment` is reported as UNKNOWN there (and the notifier's
    // `the_operators_check_sql_agrees_with_the_sweep…` test counts six)
    let migration = read(MIGRATION);
    assert!(
        migration.contains(
            "CONSTRAINT attachment_media_attachment_fkey FOREIGN KEY (workspace_id, attachment_id)"
        ) && migration.contains("REFERENCES attachment (workspace_id, id) ON DELETE CASCADE"),
        "the migration declares the composite, cascading FK under its name"
    );
    let check = read(CHECK_SQL);
    assert!(
        check.contains("'attachment_media_attachment_fkey'"),
        "the check SQL's list of known foreign keys into attachment lost the media row's"
    );
}

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn only_one_module_names_the_posters_bytes() {
    // Every `src` tree of the server: the domain crates and the binaries (tests are not shipped).
    let server = repo_root().join("server-rust");
    let mut sources = Vec::new();
    for group in ["crates", "bins"] {
        let Ok(members) = std::fs::read_dir(server.join(group)) else {
            continue;
        };
        for member in members.flatten() {
            rust_sources(&member.path().join("src"), &mut sources);
        }
    }
    assert!(
        sources.len() > 100,
        "the scan must actually see the server's sources ({} files), or it proves nothing",
        sources.len()
    );
    let mut naming: Vec<String> = sources
        .iter()
        .filter(|path| {
            std::fs::read_to_string(path)
                .unwrap_or_default()
                .contains("poster_bytes")
        })
        .map(|path| {
            path.strip_prefix(&server)
                .expect("under server-rust")
                .display()
                .to_string()
        })
        .collect();
    naming.sort();
    assert_eq!(
        naming,
        vec!["crates/momo-messaging/src/attachment_media.rs".to_string()],
        "the poster's bytes are read by `GET …/poster` alone: any other source naming the column is a \
         projection that could carry the picture (ADR-0151 증보 5 D5)"
    );
}
