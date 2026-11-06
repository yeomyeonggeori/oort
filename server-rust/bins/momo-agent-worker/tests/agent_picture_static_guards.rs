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
//! | `nothing_in_the_worker_calls_the_picture_writer_but_its_own_module` | any other worker source naming `PictureWriter`, the answer helper, or the mint |
//! | `nothing_outside_the_picture_modules_names_the_write_path_entries` | a route, tool or other crate naming the mint, the writer or the answer entry |
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
    // (needle, the files allowed to name it)
    let allowed: [(&str, &[&str]); 5] = [
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
    ];
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
            for (needle, files) in allowed {
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
