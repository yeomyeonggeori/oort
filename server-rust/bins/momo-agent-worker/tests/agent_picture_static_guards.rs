//! #5371 WA20 — **the picture write path has no caller yet** (ADR-0151 증보 8 W11, ADR-0201 P6 / P14-S3).
//!
//! S3 builds the road and puts nothing on it: no tool, card, message or HTTP surface may reach the
//! worker's `PictureWriter`, the write-token mint or the answer entry that binds a run's pictures.
//! The delegation that draws the picture (S4, #5372) and the conversation that asks for one (#5334)
//! bring the callers — and then **change this file on purpose**, in the same PR, which is the point:
//! a caller added by accident (a half-merged branch, a copied snippet) turns this red. No database:
//! it reads the sources.
//!
//! | test | what turns it red |
//! |---|---|
//! | `nothing_in_the_worker_calls_the_picture_writer_but_its_own_module` | any other worker source naming `PictureWriter`, the answer helper, the mint, the redeem, the refusal audit or the module path |
//! | `nothing_outside_the_picture_modules_names_the_write_path_entries` | a route, tool or other crate naming an entry of the table below, or the messaging module's path (`agent_picture::`) |
//! | `the_messaging_picture_module_is_private_and_every_function_it_exports_is_watched` | `pub mod agent_picture` (a caller could then walk around the names with a module path), or a function exported at the crate root that the table does not watch (implementation review L-1) |
//! | `the_image_tool_is_not_advertised_by_anything_this_slice_added` | a constant that switches the `image` tool on, appearing in the worker before S4 |

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
const WRITE_PATH_ENTRIES: [(&str, &[&str]); 8] = [
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
        &["bins/momo-agent-worker/src/agent_picture.rs"],
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
        ],
    ),
];

/// Functions the messaging crate exports at its root that are not entries of the write path: a pure name
/// builder. Anything else exported must be in [`WRITE_PATH_ENTRIES`].
const PURE_EXPORTS: [&str; 1] = ["picture_name"];

#[test]
fn nothing_in_the_worker_calls_the_picture_writer_but_its_own_module() {
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
    for (path, text) in &worker {
        if path == own {
            continue;
        }
        let body = code(text);
        for needle in [
            "PictureWriter",
            "send_answer_with_run_pictures_in_tx",
            "mint_agent_picture",
            "send_thread_notice_with_run_pictures_in_tx",
            "run_picture_ids_in_tx",
            "write_picture_in_tx",
            "redeem_agent_picture",
            "record_picture_refused_in_tx",
            "agent_picture::",
        ] {
            assert!(
                !body.contains(needle),
                "{path} names `{needle}`: the picture write path has no caller in S3 (ADR-0151 증보 8 W11) — \
                 S4/#5334 add one and update this guard in the same PR"
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
fn the_image_tool_is_not_advertised_by_anything_this_slice_added() {
    // ADR-0201 P6 / owner Q1 「가」: the `image` kind is switched on by a code constant that S4 changes.
    // S3 neither adds it nor advertises a picture tool, so nothing in the worker may name either.
    for (path, text) in sources(&server_rust().join("bins/momo-agent-worker/src")) {
        let body = code(&text);
        assert!(
            !body.contains("ATTACHMENT_WRITE_PATH_READY"),
            "{path}: the switch that turns the image tool on belongs to S4, not to the write path (S3)"
        );
        assert!(
            !body.contains("AGENT_PICTURES_PER_RUN") || path.ends_with("agent_picture.rs"),
            "{path}: the per-run picture limit is the write path's, not a tool's"
        );
    }
}
