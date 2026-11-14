//! Inventory of the realtime frames the server publishes, and the relay's classification of the
//! room ones — ADR-0177 증보 D17 (#5857).
//!
//! The relay judges a room frame (`ch:`) by its type ([`momo_relay::audience::ROOM_EVENTS`]). This
//! test keeps that list honest: every place that puts a `broadcast` row on the outbox — a Rust
//! `OutboxKind::Broadcast` site or a SQL function in `server/Migrations` — is a row of [`SITES`]
//! or [`SQL_SITES`], with the channel namespace it publishes on and the types it can publish. A new
//! site, a removed site, a changed count, a room type without a classification and a
//! classification no site publishes all turn it red. At runtime an unclassified room type reaches
//! only the members without a floor (`audience` module docs), so a miss here is closed, not open.
//!
//! No database: it reads the source tree, like the D17 read-path inventory
//! (`bins/momo-server/tests/dm_leave_read_paths.rs`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use momo_relay::audience::ROOM_EVENTS;

/// (file under `server-rust`, enclosing item, `OutboxKind::Broadcast` count, the (namespace, type)
/// pairs it can publish). Namespace `ch` is a room channel and is judged by the relay; every other
/// namespace (`user` personal, `agent` progress rail, `agentwork` job doorbell, `expressions`) is
/// published as it is. An empty list marks a mention that is not an emit site.
type Site = (
    &'static str,
    &'static str,
    usize,
    &'static [(&'static str, &'static str)],
);

#[rustfmt::skip]
const SITES: &[Site] = &[
    ("bins/momo-agent-worker/src/a2a.rs", "route_a2a_mentions_in_tx", 1, &[("agentwork", "agent.job")]),
    ("bins/momo-agent-worker/src/lib.rs", "emit_rail_frame", 1, &[("agent", "agent.status"), ("agent", "agent.partial")]),
    ("bins/momo-agent-worker/src/partial.rs", "flush", 2, &[("agent", "agent.status"), ("agent", "agent.partial")]),
    ("bins/momo-agent-worker/src/tool_exec.rs", "end_session_in_tx", 1, &[("ch", "work.session.ended")]),
    ("bins/momo-agent-worker/src/tool_exec.rs", "spawn_session_in_tx", 1, &[("ch", "work.session.started"), ("ch", "work.control.dispatched")]),
    ("bins/momo-notifier/src/approval_sweep.rs", "settle_expired_in_tx", 2, &[("agent", "agent.status"), ("ch", "approval.decided")]),
    ("bins/momo-notifier/src/control_window_sweep.rs", "settle_lapsed_in_tx", 1, &[("ch", "work.session.control")]),
    ("bins/momo-notifier/src/run_stall_sweep.rs", "settle_stalled_run_in_tx", 1, &[("agent", "agent.status")]),
    ("bins/momo-notifier/src/share_retention_sweep.rs", "sweep_workspace_in_tx", 1, &[("ch", "work.session.share_changed")]),
    ("bins/momo-server/src/routes/agent_mentions.rs", "enqueue_turn_in_tx", 1, &[("agentwork", "agent.job")]),
    ("bins/momo-server/src/routes/agent_runs.rs", "cancel_run_and_cleanup_in_tx", 1, &[("ch", "approval.decided")]),
    ("bins/momo-server/src/routes/agent_runs.rs", "create", 1, &[("agentwork", "agent.job")]),
    ("bins/momo-server/src/routes/approvals.rs", "decide_in_tx", 2, &[("ch", "approval.decided")]),
    ("bins/momo-server/src/routes/approvals.rs", "execute_workspace_action", 2, &[("ch", "approval.decided")]),
    ("bins/momo-server/src/routes/approvals.rs", "settle_expired", 1, &[("ch", "approval.decided")]),
    ("bins/momo-server/src/routes/display_attach.rs", "emit_control_closed_in_tx", 1, &[("ch", "work.session.control")]),
    ("bins/momo-server/src/routes/display_attach.rs", "issue_in_tx", 2, &[("ch", "work.session.control"), ("ch", "work.session.observer")]),
    ("bins/momo-server/src/routes/shared.rs", "emit_rail_frame", 1, &[("agent", "agent.status"), ("agent", "agent.partial")]),
    ("bins/momo-server/src/routes/terminal_attach.rs", "issue_in_tx", 1, &[("ch", "work.session.observer")]),
    ("bins/momo-server/src/routes/work_controls.rs", "emit_control_event", 1, &[("ch", "work.control.dispatched"), ("ch", "work.control.acked")]),
    ("bins/momo-server/src/routes/work_hosts.rs", "emit_work_host_notice", 1, &[("user", "work_host.registered"), ("user", "work_host.revoked")]),
    ("bins/momo-server/src/routes/work_session_share.rs", "share_in_tx", 1, &[("ch", "work.session.share_changed")]),
    ("bins/momo-server/src/routes/work_sessions.rs", "create_in_tx", 1, &[("ch", "work.session.started")]),
    ("bins/momo-server/src/routes/work_sessions.rs", "create_local_in_tx", 1, &[("ch", "work.session.started")]),
    ("bins/momo-server/src/routes/work_sessions.rs", "end_in_tx", 1, &[("ch", "work.session.ended")]),
    // The ACP ingestion types: the closed `match` of `validate_acp_event` (an unknown type is a 400).
    ("bins/momo-server/src/routes/work_sessions.rs", "publish_session_event_in_tx", 1, &[("ch", "agent.partial"), ("ch", "agent.status"), ("ch", "approval.requested"), ("ch", "approval.decided"), ("ch", "approval.auto_allowed")]),
    ("bins/momo-server/src/routes/work_sessions.rs", "resume_in_tx", 1, &[("ch", "work.session.ended"), ("ch", "work.session.started"), ("ch", "work.control.dispatched")]),
    ("bins/momo-server/src/routes/work_sessions.rs", "transition_lifecycle_in_tx", 1, &[("ch", "work.session.idle"), ("ch", "work.session.resumed-to-running")]),
    ("crates/momo-expressions/src/store.rs", "changed_each", 2, &[("expressions", "expression.changed.detail"), ("expressions", "expression.changed")]),
    ("crates/momo-messaging/src/huddle.rs", "emit_huddle_event", 1, &[("ch", "huddle_started"), ("ch", "huddle_participants_changed"), ("ch", "huddle_ended")]),
    ("crates/momo-messaging/src/inbox.rs", "mark_inbox_item_read_in_tx", 1, &[("user", "inbox_item.read")]),
    ("crates/momo-messaging/src/inbox.rs", "mark_inbox_read_all_in_tx", 1, &[("user", "inbox.read_all")]),
    ("crates/momo-messaging/src/interaction.rs", "delete_message_in_tx", 1, &[("ch", "message.deleted")]),
    ("crates/momo-messaging/src/interaction.rs", "edit_message_in_tx", 1, &[("ch", "message.edited")]),
    ("crates/momo-messaging/src/interaction.rs", "emit_message_edited_in_tx", 1, &[("ch", "message.edited")]),
    // `reaction.<ReactionAction::as_wire_label>` and `message.<PinAction::as_wire_label>`.
    ("crates/momo-messaging/src/interaction.rs", "set_pin_in_tx", 1, &[("ch", "message.pinned"), ("ch", "message.unpinned")]),
    ("crates/momo-messaging/src/interaction.rs", "set_reaction_in_tx", 1, &[("ch", "reaction.added"), ("ch", "reaction.removed")]),
    ("crates/momo-messaging/src/interaction.rs", "stream_message_body_in_tx", 1, &[("ch", "message.edited")]),
    ("crates/momo-messaging/src/member_rename.rs", "enqueue_member_renamed", 1, &[("ch", "member.renamed")]),
    ("crates/momo-messaging/src/message.rs", "finish_send_in_tx", 2, &[("ch", "message.new"), ("ch", "thread.updated")]),
    ("crates/momo-messaging/src/presence.rs", "set_declared_presence_in_tx", 1, &[("ch", "presence")]),
    ("crates/momo-messaging/src/read_state.rs", "update_read_cursor_with_intent_in_tx", 1, &[("user", "read_state")]),
    ("crates/momo-messaging/src/scheduled.rs", "record_transition_in_tx", 1, &[("user", "scheduled_message.updated")]),
    ("crates/momo-messaging/src/thread_follow.rs", "emit_followed_unread_in_tx", 1, &[("user", "followed_unread.updated")]),
    ("crates/momo-messaging/src/thread_follow.rs", "mark_followed_threads_read_in_tx", 1, &[("user", "followed_unread.updated")]),
    ("crates/momo-messaging/src/thread_follow.rs", "signal_followers_of_reply_in_tx", 1, &[("user", "followed_unread.updated")]),
    // The enum's label, not an emit site.
    ("crates/momo-outbox/src/emit.rs", "as_db_label", 1, &[]),
    ("crates/momo-unfurl/src/remove.rs", "emit_removed", 1, &[("ch", "message.unfurl.removed")]),
    ("crates/momo-unfurl/src/worker.rs", "emit_unfurl_broadcast", 1, &[("ch", "message.unfurl")]),
];

/// (SQL function whose latest definition inserts a `broadcast` outbox row, namespace, types).
#[rustfmt::skip]
const SQL_SITES: &[(&str, &str, &[&str])] = &[
    ("agent_run_event_emit_frame", "ch", &["agent.run.event"]),
    ("inbox_item_publish_created", "user", &["inbox_item.created"]),
    ("work_run_updated_enqueue", "ch", &["work.run.updated"]),
];

type Key = (String, String);

fn server_rust_root() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn identifier(word: &str) -> String {
    word.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect()
}

/// `fn NAME` at any depth; `const`/`static NAME` only at column 0.
fn item_name(line: &str) -> Option<String> {
    let top_level = !line.starts_with(' ') && !line.starts_with('\t');
    let mut words = line.split_whitespace().peekable();
    while let Some(word) = words.next() {
        let word = word
            .trim_start_matches("pub(crate)")
            .trim_start_matches("pub(super)");
        match word {
            "" | "pub" | "async" | "unsafe" | "extern" => continue,
            "const" | "static" => {
                if words.peek() == Some(&"fn") {
                    continue;
                }
                if !top_level {
                    return None;
                }
                return words.next().map(identifier);
            }
            "fn" => return words.next().map(identifier),
            _ => return None,
        }
    }
    None
}

const NEEDLE: &str = "OutboxKind::Broadcast";

/// Helpers whose event type is an argument chosen by the caller (a new call can publish a new
/// type without a new `OutboxKind::Broadcast` site), with the number of calls the server has.
/// `fn NAME(` definitions are not calls. A changed number is red: list the call's types in the
/// SITES row of the site it reaches, then update the number here.
#[rustfmt::skip]
const TYPE_CHOOSING_HELPERS: &[(&str, usize)] = &[
    ("emit_huddle_event(", 3),
    ("emit_control_event(", 3),
    ("control_event_payload(", 3),
    ("lifecycle_payload(", 7),
    ("tool_lifecycle_payload(", 1),
    ("acp_event_payload(", 1),
];

/// Occurrences of `needle` in `code` that are not the tail of a longer identifier.
fn occurrences(code: &str, needle: &str) -> usize {
    let bytes = code.as_bytes();
    code.match_indices(needle)
        .filter(|(at, _)| {
            *at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_')
        })
        .count()
}

/// Every `OutboxKind::Broadcast` of one source file by enclosing item. Comments and `#[cfg(test)]`
/// modules are not sites.
fn scan_source(text: &str) -> BTreeMap<String, usize> {
    scan_source_for(text, NEEDLE)
}

/// [`scan_source`] for any needle; a `fn NEEDLE` definition line does not count.
fn scan_source_for(text: &str, needle: &str) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    let mut item = String::from("<module>");
    let mut depth: i64 = 0;
    let mut skip_until: Option<i64> = None;
    let mut cfg_test = false;
    for line in text.lines() {
        let trimmed = line.trim();
        let opens = line.matches('{').count() as i64;
        let closes = line.matches('}').count() as i64;
        if let Some(floor) = skip_until {
            depth += opens - closes;
            if depth <= floor {
                skip_until = None;
            }
            continue;
        }
        if trimmed.starts_with("#[cfg(test)]") {
            cfg_test = true;
            continue;
        }
        if cfg_test && !trimmed.is_empty() && !trimmed.starts_with("#[") {
            cfg_test = false;
            let module = trimmed
                .strip_prefix("pub ")
                .unwrap_or(trimmed)
                .starts_with("mod ");
            if module && opens > 0 {
                let floor = depth;
                depth += opens - closes;
                if depth > floor {
                    skip_until = Some(floor);
                }
                continue;
            }
        }
        depth += opens - closes;
        if let Some(name) = item_name(line) {
            item = name;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        let code = line.split("//").next().unwrap_or("");
        if code.contains(&format!("fn {needle}")) {
            continue;
        }
        let count = occurrences(code, needle);
        if count > 0 {
            *out.entry(item.clone()).or_insert(0) += count;
        }
    }
    out
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Total calls of `needle` across `server-rust/{bins,crates}/<crate>/src/**/*.rs`.
fn count_tree(root: &Path, needle: &str) -> usize {
    let mut total = 0;
    for group in ["bins", "crates"] {
        for krate in std::fs::read_dir(root.join(group))
            .expect("readable")
            .flatten()
        {
            let mut files = Vec::new();
            rust_files(&krate.path().join("src"), &mut files);
            for file in files {
                let text = std::fs::read_to_string(&file).expect("read a source file");
                total += scan_source_for(&text, needle).values().sum::<usize>();
            }
        }
    }
    total
}

/// `server-rust/{bins,crates}/<crate>/src/**/*.rs`.
fn scan_tree(root: &Path) -> BTreeMap<Key, usize> {
    let mut out = BTreeMap::new();
    for group in ["bins", "crates"] {
        let Ok(crates) = std::fs::read_dir(root.join(group)) else {
            panic!("{} is not readable", root.join(group).display());
        };
        for krate in crates.flatten() {
            let mut files = Vec::new();
            rust_files(&krate.path().join("src"), &mut files);
            for file in files {
                let text = std::fs::read_to_string(&file).expect("read a source file");
                let rel = file
                    .strip_prefix(root)
                    .expect("under server-rust")
                    .to_string_lossy()
                    .replace('\\', "/");
                for (item, count) in scan_source(&text) {
                    out.insert((rel.clone(), item), count);
                }
            }
        }
    }
    out
}

/// The SQL side: for each function, its LATEST definition across the migrations in order (a later
/// `CREATE OR REPLACE` wins, a `DROP FUNCTION` removes it). Kept: the functions whose body inserts
/// an outbox row of kind `broadcast`, with the namespaces and `'type', '…'` literals it uses.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlSite {
    namespaces: BTreeSet<String>,
    types: BTreeSet<String>,
}

fn function_name(after_keyword: &str) -> String {
    let name: String = after_keyword
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
        .collect();
    name.trim_start_matches("public.").to_ascii_lowercase()
}

fn quoted_after(body: &str, marker: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = body;
    while let Some(at) = rest.find(marker) {
        rest = &rest[at + marker.len()..];
        if let Some(end) = rest.find('\'') {
            out.insert(rest[..end].to_string());
        }
    }
    out
}

fn sql_site(body: &str) -> Option<SqlSite> {
    let lower = body.to_ascii_lowercase();
    if !lower.contains("insert into outbox") || !lower.contains("'broadcast'") {
        return None;
    }
    let mut namespaces = BTreeSet::new();
    if body.contains("'ch:ws'") {
        namespaces.insert("ch".to_string());
    }
    if body.contains("'user:read-state#'") {
        namespaces.insert("user".to_string());
    }
    Some(SqlSite {
        namespaces,
        types: quoted_after(body, "'type', '"),
    })
}

fn scan_migrations(dir: &Path) -> BTreeMap<String, SqlSite> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("migrations readable")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .collect();
    files.sort();
    let mut latest: BTreeMap<String, Option<SqlSite>> = BTreeMap::new();
    for file in files {
        let text = std::fs::read_to_string(&file).expect("read a migration");
        let lower = text.to_ascii_lowercase();
        let mut events: Vec<(usize, String, Option<Option<SqlSite>>)> = Vec::new();
        for marker in ["create function ", "create or replace function "] {
            let mut from = 0;
            while let Some(at) = lower[from..].find(marker) {
                let start = from + at;
                let name = function_name(&text[start + marker.len()..]);
                // The body runs to the next `$$;`/`$$ language`/`$$\n` that closes it: take the
                // text up to the next CREATE so one definition never reads another's body.
                let end = ["create function ", "create or replace function "]
                    .iter()
                    .filter_map(|next| {
                        lower[start + marker.len()..]
                            .find(next)
                            .map(|o| start + marker.len() + o)
                    })
                    .min()
                    .unwrap_or(text.len());
                events.push((start, name, Some(sql_site(&text[start..end]))));
                from = start + marker.len();
            }
        }
        let mut from = 0;
        while let Some(at) = lower[from..].find("drop function ") {
            let start = from + at;
            let rest = &text[start + "drop function ".len()..];
            let rest = rest
                .trim_start()
                .strip_prefix("IF EXISTS")
                .or_else(|| rest.trim_start().strip_prefix("if exists"))
                .unwrap_or(rest);
            events.push((start, function_name(rest), None));
            from = start + 1;
        }
        events.sort_by_key(|event| event.0);
        for (_, name, site) in events {
            match site {
                Some(site) => {
                    latest.insert(name, site);
                }
                None => {
                    latest.remove(&name);
                }
            }
        }
    }
    latest
        .into_iter()
        .filter_map(|(name, site)| site.map(|site| (name, site)))
        .collect()
}

fn table() -> BTreeMap<Key, usize> {
    let mut out = BTreeMap::new();
    for (file, item, count, published) in SITES {
        assert!(
            published
                .iter()
                .all(|(namespace, kind)| !namespace.is_empty() && !kind.is_empty()),
            "{file} {item}: every pair names a namespace and a type"
        );
        assert!(
            out.insert((file.to_string(), item.to_string()), *count)
                .is_none(),
            "{file} {item}: one row per site"
        );
    }
    out
}

fn differences(found: &BTreeMap<Key, usize>, listed: &BTreeMap<Key, usize>) -> Vec<String> {
    let mut out = Vec::new();
    for (key, count) in found {
        match listed.get(key) {
            None => out.push(format!(
                "unlisted site: (\"{}\", \"{}\", {count}, <namespace>, &[<types>])",
                key.0, key.1
            )),
            Some(listed) if listed != count => out.push(format!(
                "count changed: {} {}: source {count}, table {listed}",
                key.0, key.1
            )),
            Some(_) => {}
        }
    }
    for key in listed.keys() {
        if !found.contains_key(key) {
            out.push(format!("stale row: {} {}", key.0, key.1));
        }
    }
    out
}

/// The room types the inventory says the server publishes.
fn room_types_in_inventory() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (_, _, _, published) in SITES {
        for (namespace, kind) in *published {
            if *namespace == "ch" {
                out.insert(kind.to_string());
            }
        }
    }
    for (_, namespace, types) in SQL_SITES {
        if *namespace == "ch" {
            out.extend(types.iter().map(|t| t.to_string()));
        }
    }
    out
}

fn classified() -> BTreeSet<String> {
    ROOM_EVENTS
        .iter()
        .map(|(name, _)| name.to_string())
        .collect()
}

fn classification_gaps(inventory: &BTreeSet<String>, classified: &BTreeSet<String>) -> Vec<String> {
    let mut out = Vec::new();
    for name in inventory.difference(classified) {
        out.push(format!("room type without a classification: {name}"));
    }
    for name in classified.difference(inventory) {
        out.push(format!("classification no site publishes: {name}"));
    }
    out
}

#[test]
fn every_broadcast_site_in_the_server_is_listed() {
    let found = scan_tree(&server_rust_root());
    assert!(
        found.len() >= 40,
        "the scan must see the server's broadcast sites, saw {}",
        found.len()
    );
    let problems = differences(&found, &table());
    assert!(
        problems.is_empty(),
        "every OutboxKind::Broadcast site needs a row in SITES (ADR-0177 D17):\n{}",
        problems.join("\n")
    );
}

#[test]
fn every_call_of_a_type_choosing_helper_is_counted() {
    let root = server_rust_root();
    let mut problems = Vec::new();
    for (needle, listed) in TYPE_CHOOSING_HELPERS {
        let found = count_tree(&root, needle);
        if found != *listed {
            problems.push(format!(
                "{needle}: source {found}, table {listed} — a new call may publish a new type; \
                 list it in SITES and ROOM_EVENTS (ADR-0177 D17)"
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    // The boundary: `tool_lifecycle_payload(` is not a `lifecycle_payload(` call, a definition is
    // not a call, a comment is not a call.
    let sample = "fn lifecycle_payload(a: u8) {}\n\
                  fn x() { lifecycle_payload(1); tool_lifecycle_payload(2); }\n\
                  // lifecycle_payload(3)\n";
    assert_eq!(
        scan_source_for(sample, "lifecycle_payload(")
            .values()
            .sum::<usize>(),
        1
    );
}

#[test]
fn every_sql_broadcast_function_is_listed_with_its_literal_types() {
    let dir = server_rust_root().join("../server/Migrations");
    let found = scan_migrations(&dir);
    assert!(
        found.len() >= 3,
        "the scan must see the SQL broadcast functions, saw {found:?}"
    );
    let listed: BTreeMap<String, SqlSite> = SQL_SITES
        .iter()
        .map(|(name, namespace, types)| {
            (
                name.to_string(),
                SqlSite {
                    namespaces: [namespace.to_string()].into_iter().collect(),
                    types: types.iter().map(|t| t.to_string()).collect(),
                },
            )
        })
        .collect();
    assert_eq!(
        found, listed,
        "every SQL function that inserts a broadcast outbox row needs a row in SQL_SITES with the \
         namespace and the `'type', '…'` literals of its latest definition (ADR-0177 D17)"
    );
}

#[test]
fn every_room_type_is_classified_and_every_classification_is_published() {
    let gaps = classification_gaps(&room_types_in_inventory(), &classified());
    assert!(
        gaps.is_empty(),
        "momo_relay::audience::ROOM_EVENTS must equal the room types of SITES + SQL_SITES \
         (ADR-0177 D17):\n{}",
        gaps.join("\n")
    );
}

#[test]
fn an_unlisted_site_or_type_turns_the_inventory_red() {
    let listed = table();
    let mut found = scan_tree(&server_rust_root());
    assert!(differences(&found, &listed).is_empty(), "baseline is green");

    let source = "pub async fn emit_new_card_event(conn: &mut PgConnection) {\n\
                  \x20   emit_outbox(conn, ws, OutboxKind::Broadcast, \"publish\", &p, None).await?;\n\
                  \x20   // OutboxKind::Broadcast in a comment is not a site\n\
                  }\n\
                  #[cfg(test)]\n\
                  mod tests {\n\
                  \x20   fn helper() { let _ = OutboxKind::Broadcast; }\n\
                  }\n\
                  fn after_the_tests() { let _ = momo_outbox::OutboxKind::Broadcast; }\n";
    let scanned = scan_source(source);
    let expected: BTreeMap<String, usize> = [("emit_new_card_event", 1), ("after_the_tests", 1)]
        .into_iter()
        .map(|(item, n)| (item.to_string(), n))
        .collect();
    assert_eq!(scanned, expected, "comments and test modules are not sites");
    for (item, count) in scanned {
        found.insert(
            ("crates/momo-messaging/src/new_card.rs".to_string(), item),
            count,
        );
    }
    let problems = differences(&found, &listed);
    assert_eq!(problems.len(), 2, "{problems:#?}");
    assert!(problems.iter().all(|p| p.starts_with("unlisted site")));

    // A room type that nobody classified, and a classification nobody publishes.
    let mut inventory = room_types_in_inventory();
    let classified = classified();
    assert!(classification_gaps(&inventory, &classified).is_empty());
    inventory.insert("message.translated".to_string());
    let removed = inventory
        .iter()
        .find(|name| name.as_str() == "message.edited")
        .cloned()
        .expect("message.edited is a room type");
    inventory.remove(&removed);
    let gaps = classification_gaps(&inventory, &classified);
    assert_eq!(gaps.len(), 2, "{gaps:#?}");

    // The SQL scan reads the latest definition: a later CREATE OR REPLACE that stops inserting a
    // broadcast row removes the function, a new one adds it.
    let site = sql_site(
        "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN \
         INSERT INTO outbox (workspace_id, kind) VALUES (x, 'broadcast'); \
         -- 'ch:ws' || upper(...) \n jsonb_build_object('type', 'message.translated') END $$;",
    )
    .expect("a broadcast insert");
    assert!(site.types.contains("message.translated"));
    assert!(site.namespaces.contains("ch"));
    assert_eq!(
        sql_site("CREATE FUNCTION g() AS $$ INSERT INTO outbox VALUES ('push_candidate') $$;"),
        None
    );
}
