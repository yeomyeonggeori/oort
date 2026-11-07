//! #5371 WA20, changed on purpose by #5372 (S4): **the picture write path has exactly the callers the
//! delegation of a picture needs, and no others** (ADR-0151 증보 8 W11, ADR-0201 P6 / P14-S3 / P14-S4).
//!
//! S3 built the road and put nothing on it, and this file said so: *no* source could name the worker's
//! `PictureWriter`, the write-token mint or the answer entry that binds a run's pictures. S4 brings the one
//! caller — the delegation step of the team AI (`team_ai/delegate.rs` writes the picture; `team_ai.rs`'s
//! finishing transaction posts the answer with it) — so the contract this file holds is now a **table of who
//! may name what**: any other worker source, route, tool or crate naming an entry (a half-merged branch, a
//! copied snippet, the conversation that will ask for a picture in #5334 before it has its own review) turns
//! it red until its author adds a row on purpose, in the same PR. The table is read both ways: a needle in a
//! file the table does not allow fails, and a file the table allows that no longer names its needle fails
//! too (the allowance cannot go stale and keep the guard green for the wrong reason). No database: it reads
//! the sources.
//!
//! | test | what turns it red |
//! |---|---|
//! | `only_the_delegation_step_and_its_finishing_transaction_call_the_picture_writer` | a worker source other than the table's naming `PictureWriter`, the answer helper, the mint, the redeem, the refusal audit or the messaging module path; or a table row whose file no longer names its needle |
//! | `nothing_outside_the_picture_modules_names_the_write_path_entries` | a route, tool or other crate naming an entry of the table below, or the messaging module's path (`agent_picture::`) |
//! | `the_messaging_picture_module_is_private_and_every_function_it_exports_is_watched` | `pub mod agent_picture` (a caller could then walk around the names with a module path), or a function exported at the crate root that the table does not watch (implementation review L-1) |
//! | `the_image_kind_is_switched_by_the_constant_and_the_declaration_and_nothing_else` | the constant turned off again, a worker source other than the door and the step reading it, or the door's `image_path_ready` made to depend on anything else (an environment variable, `OORT_API_INTERNAL_ORIGIN`, A10) |

use std::path::{Path, PathBuf};

fn server_rust() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Every `.rs` file under `dir` (recursively), as (path relative to `server-rust`, text).
fn sources(dir: &Path) -> Vec<(String, String)> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // build output and test fixtures are not sources of a caller
                if path.file_name().is_some_and(|name| name == "target") {
                    continue;
                }
                walk(&path, out);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, &mut files);
    let root = server_rust().canonicalize().expect("server-rust");
    files
        .into_iter()
        .map(|path| {
            let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
            let relative = path
                .canonicalize()
                .expect("canonical")
                .strip_prefix(&root)
                .expect("inside server-rust")
                .to_string_lossy()
                .into_owned();
            (relative, text)
        })
        .collect()
}

/// Source lines that are not comments, so a doc line that merely names an entry is not a caller.
fn code(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The entries of the write path and the shipped files that may name each one: the single table the
/// scan and the export check below both read. A needle is matched as a substring, so `mint_agent_picture`
/// covers the root names `mint_agent_picture_in_tx` and `mint_agent_picture_with_ttl_in_tx`.
///
/// `agent_picture::` is the messaging module's own path. The module is private now (review L-1), so no
/// other crate can write it; the needle is the second lock — it turns a regression to `pub mod` plus a
/// call by module path red, where the names alone would not see it.
const WRITE_PATH_ENTRIES: [(&str, &[&str]); 9] = [
    (
        "mint_agent_picture",
        &[
            "crates/momo-messaging/src/lib.rs",
            "bins/momo-agent-worker/src/agent_picture.rs",
        ],
    ),
    (
        "send_thread_notice_with_run_pictures_in_tx",
        &[
            "crates/momo-messaging/src/lib.rs",
            "crates/momo-messaging/src/message.rs",
            "bins/momo-agent-worker/src/agent_picture.rs",
        ],
    ),
    (
        "PictureWriter",
        &[
            "bins/momo-agent-worker/src/agent_picture.rs",
            // S4: the delegation step writes the picture of an `image` delegation, once
            "bins/momo-agent-worker/src/team_ai/delegate.rs",
        ],
    ),
    (
        "send_answer_with_run_pictures_in_tx",
        &[
            "bins/momo-agent-worker/src/agent_picture.rs",
            // S4: the finishing transaction of a delegation that wrote a picture
            "bins/momo-agent-worker/src/team_ai.rs",
        ],
    ),
    (
        "redeem_agent_picture_in_tx",
        &[
            "crates/momo-messaging/src/lib.rs",
            "bins/momo-server/src/routes/agent_media.rs",
        ],
    ),
    (
        "write_picture_in_tx",
        &[
            "crates/momo-messaging/src/lib.rs",
            "crates/momo-messaging/src/agent_picture.rs",
            "bins/momo-server/src/routes/agent_media.rs",
            "bins/momo-agent-worker/src/agent_picture.rs",
        ],
    ),
    (
        "record_picture_refused_in_tx",
        &[
            "crates/momo-messaging/src/lib.rs",
            "bins/momo-server/src/routes/agent_media.rs",
        ],
    ),
    (
        "run_picture_ids_in_tx",
        &[
            "crates/momo-messaging/src/lib.rs",
            "crates/momo-messaging/src/message.rs",
        ],
    ),
    (
        "agent_picture::",
        &[
            "crates/momo-messaging/src/lib.rs",
            "crates/momo-messaging/src/message.rs",
            // the **worker's** own module path (`crate::agent_picture::…`, not messaging's, which is private):
            // the two files of S4's caller. The worker-only table above says which of the worker's files may
            // use which name; this row only keeps the module path from appearing anywhere new.
            "bins/momo-agent-worker/src/team_ai/delegate.rs",
            "bins/momo-agent-worker/src/team_ai.rs",
        ],
    ),
];

/// Functions the messaging crate exports at its root that are not entries of the write path: a pure name
/// builder. Anything else exported must be in [`WRITE_PATH_ENTRIES`].
const PURE_EXPORTS: [&str; 1] = ["picture_name"];

/// Who in the **worker** may name each entry of the write path. The worker's own module
/// (`agent_picture.rs`) is always allowed; the rest is the table. `crate::agent_picture` is the worker's own
/// module path (the delegation reaches `PictureWriter` through it); `momo_messaging::agent_picture` is the
/// messaging module's, which only the worker's own module may spell (it is private, review L-1, so nothing
/// else could — the needle is the second lock).
const WORKER_ALLOWANCES: [(&str, &[&str]); 10] = [
    (
        "PictureWriter",
        &["bins/momo-agent-worker/src/team_ai/delegate.rs"],
    ),
    (
        "send_answer_with_run_pictures_in_tx",
        &["bins/momo-agent-worker/src/team_ai.rs"],
    ),
    (
        "crate::agent_picture",
        &[
            "bins/momo-agent-worker/src/team_ai/delegate.rs",
            "bins/momo-agent-worker/src/team_ai.rs",
        ],
    ),
    ("mint_agent_picture", &[]),
    ("send_thread_notice_with_run_pictures_in_tx", &[]),
    ("run_picture_ids_in_tx", &[]),
    ("write_picture_in_tx", &[]),
    ("redeem_agent_picture", &[]),
    ("record_picture_refused_in_tx", &[]),
    ("momo_messaging::agent_picture", &[]),
];

#[test]
fn only_the_delegation_step_and_its_finishing_transaction_call_the_picture_writer() {
    let worker = sources(&server_rust().join("bins/momo-agent-worker/src"));
    assert!(
        worker.len() > 10,
        "the scan must actually see the worker's sources, or it proves nothing"
    );
    let own = "bins/momo-agent-worker/src/agent_picture.rs";
    assert!(
        worker.iter().any(|(path, _)| path == own),
        "the picture module moved: update this guard with it"
    );
    for (needle, allowed) in WORKER_ALLOWANCES {
        // the table must not go stale: a file it allows has to be using what it is allowed to use
        for file in allowed {
            let (_, text) = worker
                .iter()
                .find(|(path, _)| path == file)
                .unwrap_or_else(|| {
                    panic!("{file} is in the allowance table and is not a worker source")
                });
            assert!(
                code(text).contains(needle),
                "{file} no longer names `{needle}`: drop its row from WORKER_ALLOWANCES (or this guard is \
                 green for a reason that is not true any more)"
            );
        }
        for (path, text) in &worker {
            if path == own || allowed.contains(&path.as_str()) {
                continue;
            }
            assert!(
                !code(text).contains(needle),
                "{path} names `{needle}`: only {allowed:?} may (ADR-0151 증보 8 W11, ADR-0201 P14-S4) — a new \
                 caller of the picture write path adds its own row here, in its own PR"
            );
        }
    }
}

#[test]
fn nothing_outside_the_picture_modules_names_the_write_path_entries() {
    let mut seen = 0usize;
    for tree in ["bins", "crates"] {
        for (path, text) in sources(&server_rust().join(tree)) {
            // tests of the path itself are the path's own business; only shipped sources count
            if path.contains("/tests/")
                || path.ends_with("/agent_picture.rs") && path.contains("momo-messaging")
            {
                continue;
            }
            seen += 1;
            let body = code(&text);
            for (needle, files) in WRITE_PATH_ENTRIES {
                if body.contains(needle) {
                    assert!(
                        files.contains(&path.as_str()),
                        "{path} names `{needle}`: only {files:?} may (ADR-0151 증보 8 W11 — S3 adds no caller)"
                    );
                }
            }
        }
    }
    assert!(seen > 100, "the scan saw only {seen} shipped sources");
}

/// L-1 (implementation review): the guard above watches NAMES. With `pub mod agent_picture` a caller could
/// reach every function by its module path and no name here would see it — so the module is private, the
/// root re-exports are the only way in, and this test holds both halves: the module stays private, and every
/// function the crate root exports from it is one [`WRITE_PATH_ENTRIES`] watches (or a pure builder).
#[test]
fn the_messaging_picture_module_is_private_and_every_function_it_exports_is_watched() {
    let lib = std::fs::read_to_string(server_rust().join("crates/momo-messaging/src/lib.rs"))
        .expect("momo-messaging/src/lib.rs");
    let body = code(&lib);
    assert!(
        !body.contains("pub mod agent_picture"),
        "`pub mod agent_picture` lets a caller walk around every name this guard watches with a module \
         path (review L-1): keep the module private and export names from the crate root"
    );
    assert!(
        body.lines().any(|line| line.trim() == "mod agent_picture;"),
        "the module declaration moved: update this guard with it"
    );
    let opening = "pub use agent_picture::{";
    let start = body
        .find(opening)
        .expect("the root re-export block of the picture module");
    let end = start
        + body[start..]
            .find("};")
            .expect("the re-export block ends with `};`");
    let mut functions = 0usize;
    for item in body[start + opening.len()..end]
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        // `mint_in_tx as mint_agent_picture_in_tx` is exported as the name after `as`
        let exported = item.rsplit(" as ").next().expect("a name").trim();
        if !exported.chars().next().is_some_and(char::is_lowercase) {
            continue; // a type or a constant is not an entry
        }
        functions += 1;
        let watched = WRITE_PATH_ENTRIES
            .iter()
            .any(|(needle, _)| exported.contains(needle))
            || PURE_EXPORTS.contains(&exported);
        assert!(
            watched,
            "`{exported}` is exported from the picture module at the crate root and no entry of \
             WRITE_PATH_ENTRIES watches it: add it there (and to the allowed files) so a caller of it turns \
             this guard red"
        );
    }
    assert!(
        functions >= 5,
        "the scan saw only {functions} exported functions: it is reading the wrong block"
    );
}

#[test]
fn the_image_kind_is_switched_by_the_constant_and_the_declaration_and_nothing_else() {
    // ADR-0201 P6 / owner Q1 「가」 / A10: the `image` kind is offered when the code constant is `true` — S4
    // (#5372) turned it on — and the operator declared it. Nothing else switches it.
    let switch = std::fs::read_to_string(
        server_rust().join("crates/momo-workspace-actions/src/team_ai_hermes.rs"),
    )
    .expect("the switch's source");
    assert!(
        code(&switch).contains("pub const ATTACHMENT_WRITE_PATH_READY: bool = true;"),
        "the constant that switches the image tool on is off again: either a deliberate rollback (then \
         this guard and ADR-0201 v4.3 change with it) or a slip"
    );
    // who reads the constant: the door (`team_ai.rs`) and the step's re-judgement (`delegate.rs`)
    let readers = [
        "bins/momo-agent-worker/src/team_ai.rs",
        "bins/momo-agent-worker/src/team_ai/delegate.rs",
    ];
    let worker = sources(&server_rust().join("bins/momo-agent-worker/src"));
    for (path, text) in &worker {
        let body = code(text);
        let reads = body.contains("ATTACHMENT_WRITE_PATH_READY");
        if readers.contains(&path.as_str()) {
            assert!(
                reads,
                "{path} no longer reads the constant: the door and the step must both judge `image` by it"
            );
        } else {
            assert!(
                !reads,
                "{path} reads ATTACHMENT_WRITE_PATH_READY: only the door and the step may decide whether \
                 `image` is on"
            );
        }
        assert!(
            !body.contains("AGENT_PICTURES_PER_RUN") || path.ends_with("agent_picture.rs"),
            "{path}: the per-run picture limit is the write path's, not a tool's"
        );
    }
    // the door's parameter is the constant itself — not the constant AND something, and never an
    // environment-derived value (A10: `OORT_API_INTERNAL_ORIGIN` is never the constant's evidence)
    let team_ai = code(
        &std::fs::read_to_string(server_rust().join("bins/momo-agent-worker/src/team_ai.rs"))
            .expect("team_ai.rs"),
    );
    let assignments: Vec<&str> = team_ai
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("image_path_ready:"))
        .collect();
    assert_eq!(
        assignments,
        ["image_path_ready: team_ai_hermes::ATTACHMENT_WRITE_PATH_READY,"],
        "the door must offer `image` by the constant and the declaration alone"
    );
}
