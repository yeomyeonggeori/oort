//! #5823 / ADR-0177 증보 2026-11-14 D17 — 길 전수 표 (ADR-0219 T2 방식), source leg.
//!
//! The leave floor is one `message` read policy (`dm_leave_history_floor`, migration 180). A read
//! is covered when it is a `message` statement in a tenant transaction that a human request runs
//! (the requester is bound there), or a copy that reaches `message` before it answers. What would
//! slip past it is a **new** read nobody looked at: a copy read that never touches `message`, or a
//! read that serves a human from somewhere the requester is not bound.
//!
//! This test scans the server source (`server-rust/{bins,crates}/*/src`, outside `#[cfg(test)]`
//! modules and comments) for every SQL read of `message` and of the content copies that are read by
//! id (`message_unfurl`, `attachment`, `attachment_media`), keyed by file, enclosing item and table,
//! and holds the result **equal** to the table [`PATHS`]: a read with no row is red, a row whose read
//! is gone is red, a changed count is red. Every row carries a class and the reason it is covered.
//! The other copies (tables that reference `message` by a foreign key, and the definer functions
//! that read it) are classified against the real catalog in `dm_leave_copies_pg.rs`.
//!
//! Runs in `cargo test --workspace` (no database). Reads only files under `server-rust/`.
//!
//! | proof | test |
//! |---|---|
//! | every read in the source has a row, every row has a read, counts equal | `every_message_read_in_the_server_source_is_classified` |
//! | an unclassified read (also one split across a line continuation) turns the comparison red; comments, test modules and look-alike tables do not count | `an_unclassified_read_turns_the_inventory_red` |

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Why a read cannot hand a person who left a 1:1 the messages below their floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    /// A statement that reads `message` (or reaches it in the same statement) inside a tenant
    /// transaction. When a human request runs it, the requester is bound and the policy decides.
    Floor,
    /// A copy read that runs only after a check in the same transaction that went through `message`
    /// (the caller already holds a readable message or file).
    Gated,
    /// Inside a write or its target check. Below the floor the target is the unknown id or the
    /// coded 409 (ADR-0177 D17 write table).
    Write,
    /// Runs without a human requester: a worker process, an agent principal or a signed work host.
    /// The policy lets it through by design (D17), and no agent sits in a human 1:1 (D20).
    Machine,
}

use Class::{Floor, Gated, Machine, Write};

/// The tables whose reads are inventoried here.
const TRACKED: &[&str] = &[
    "message",
    "message_unfurl",
    "attachment",
    "attachment_media",
];

/// `(file under server-rust, enclosing item, table, reads, class, why)`.
#[rustfmt::skip]
const PATHS: &[(&str, &str, &str, usize, Class, &str)] = &[
    ("bins/momo-agent-worker/src/team_ai.rs", "read", "message", 1, Machine, "team AI worker"),
    ("bins/momo-agent-worker/src/team_ai.rs", "sqlx_body", "message", 1, Machine, "team AI worker"),
    ("bins/momo-relay/src/audience.rs", "APPROVAL_CARD_SEQ_SQL", "message", 1, Machine, "relay: the seq of a room frame's target, never sent (D17)"),
    ("bins/momo-relay/src/audience.rs", "MESSAGE_SEQ_SQL", "message", 1, Machine, "relay: the seq of a room frame's target, never sent (D17)"),
    ("bins/momo-relay/src/audience.rs", "SESSION_CARD_SEQ_SQL", "message", 1, Machine, "relay: the seq of a room frame's target, never sent (D17)"),
    ("bins/momo-server/src/routes/work_controls.rs", "card_thread_root_in_tx", "message", 1, Floor, "work control route"),
    ("bins/momo-server/src/routes/work_instructions.rs", "replay_in_tx", "message", 2, Floor, "work instruction route"),
    ("bins/momo-server/src/routes/work_sessions.rs", "signed_agent_matches_source_in_tx", "message", 1, Floor, "signed host or agent check in a work-session route"),
    ("bins/momo-server/src/routes/work_spawns.rs", "origin_is_valid_in_tx", "message", 2, Floor, "spawn origin check in a request"),
    ("crates/momo-agent/src/approval.rs", "APPROVAL_CARD_JOIN_SQL", "message", 1, Floor, "approval list joins the card message"),
    ("crates/momo-agent/src/approval.rs", "list_approval_page_in_tx", "message", 1, Floor, "approval list route"),
    ("crates/momo-agent/src/card_suggest.rs", "suggestion_requester_in_tx", "message", 1, Machine, "agent tools and team AI"),
    ("crates/momo-agent/src/memory.rs", "active_channels", "message", 1, Machine, "memory worker; a human 1:1 is not memory-eligible"),
    ("crates/momo-agent/src/memory.rs", "backfill_floor_seq", "message", 1, Machine, "memory worker"),
    ("crates/momo-agent/src/memory.rs", "day_bounds", "message", 1, Machine, "memory worker"),
    ("crates/momo-agent/src/memory.rs", "pending_stats", "message", 1, Machine, "memory worker"),
    ("crates/momo-agent/src/memory.rs", "read_channel_window", "message", 1, Floor, "memory worker and the memory route"),
    ("crates/momo-agent/src/memory.rs", "read_evidence_refs", "message", 1, Machine, "memory worker"),
    ("crates/momo-agent/src/memory.rs", "read_range", "message", 1, Machine, "memory worker"),
    ("crates/momo-agent/src/memory.rs", "read_thread_window", "message", 1, Machine, "memory worker"),
    ("crates/momo-agent/src/memory.rs", "thread_candidates", "message", 1, Machine, "memory worker"),
    ("crates/momo-agent/src/memory_suggest.rs", "resolve_evidence", "message", 1, Machine, "agent tool"),
    ("crates/momo-agent/src/run.rs", "ANSWER_PLACE_JOINS", "message", 2, Machine, "agent run answer place"),
    ("crates/momo-agent/src/run_progress.rs", "ACTIVE_VISIBLE_WHERE", "message", 1, Floor, "run progress list"),
    ("crates/momo-agent/src/subscription.rs", "lock_and_find_recent_server_notice_in_tx", "message", 1, Write, "server notice dedupe"),
    ("crates/momo-agent/src/subscription_transition.rs", "inspect", "message", 1, Machine, "subscription worker"),
    ("crates/momo-agent/src/team_ai_task.rs", "delegation_counts_in_tx", "message", 1, Machine, "team AI limits"),
    ("crates/momo-agent/src/team_ai_task.rs", "running_counts_in_tx", "message", 1, Machine, "team AI limits"),
    ("crates/momo-agent/src/thread_wake.rs", "find_unclaimed_thread_run_in_tx", "message", 1, Write, "agent mention routing at send"),
    ("crates/momo-agent/src/thread_wake.rs", "load_thread_wake_target_in_tx", "message", 2, Write, "agent mention routing at send"),
    ("crates/momo-agent/src/welcome.rs", "welcome_opener_already_queued_in_tx", "message", 1, Write, "welcome opener dedupe"),
    ("crates/momo-expressions/src/set.rs", "prove_run", "message", 1, Floor, "expression set proof"),
    ("crates/momo-expressions/src/store.rs", "attachment_source", "attachment", 1, Floor, "the same statement joins message"),
    ("crates/momo-expressions/src/store.rs", "attachment_source", "message", 1, Floor, "the caller's own sent file"),
    ("crates/momo-messaging/src/agent_avatar.rs", "attachments_for_messages_in_tx", "attachment", 1, Machine, "Agent Port"),
    ("crates/momo-messaging/src/agent_avatar.rs", "attachments_for_messages_in_tx", "message", 1, Machine, "Agent Port"),
    ("crates/momo-messaging/src/agent_avatar.rs", "find_requester_attachment_for_in_tx", "attachment", 1, Machine, "Agent Port and team AI"),
    ("crates/momo-messaging/src/agent_avatar.rs", "find_requester_attachment_for_in_tx", "message", 1, Machine, "Agent Port and team AI"),
    ("crates/momo-messaging/src/agent_avatar.rs", "find_visible_image_attachment_in_tx", "attachment", 1, Machine, "Agent Port"),
    ("crates/momo-messaging/src/agent_avatar.rs", "find_visible_image_attachment_in_tx", "message", 1, Machine, "Agent Port"),
    ("crates/momo-messaging/src/agent_avatar.rs", "requester_of_run_in_tx", "message", 1, Machine, "Agent Port and agent tools"),
    ("crates/momo-messaging/src/agent_picture.rs", "agent_picture_binding_in_tx", "message", 1, Machine, "agent picture"),
    ("crates/momo-messaging/src/attachment.rs", "PAGED_ATTACHMENT_JOIN", "attachment", 1, Gated, "joined onto a page of readable messages"),
    ("crates/momo-messaging/src/attachment.rs", "PAGED_ATTACHMENT_JOIN", "attachment_media", 1, Gated, "joined onto a page of readable messages"),
    ("crates/momo-messaging/src/attachment.rs", "link_attachments_in_tx", "attachment", 1, Write, "binding the sender's uploads"),
    ("crates/momo-messaging/src/attachment.rs", "load_attachment_in_tx", "attachment", 1, Write, "the uploader's own file"),
    ("crates/momo-messaging/src/attachment.rs", "load_readable_attachment_in_tx", "attachment", 1, Floor, "LEFT JOIN message in the same statement"),
    ("crates/momo-messaging/src/attachment.rs", "load_readable_attachment_in_tx", "message", 1, Floor, "content and poster routes"),
    ("crates/momo-messaging/src/attachment.rs", "message_attachments_in_tx", "attachment", 1, Write, "projection of a message just written"),
    ("crates/momo-messaging/src/attachment.rs", "message_attachments_in_tx", "attachment_media", 1, Write, "projection of a message just written"),
    ("crates/momo-messaging/src/attachment.rs", "message_attachments_in_tx", "message", 1, Write, "projection of a message just written"),
    ("crates/momo-messaging/src/attachment.rs", "message_attachments_without_media_in_tx", "attachment", 1, Write, "projection of a message just written"),
    ("crates/momo-messaging/src/attachment.rs", "message_attachments_without_media_in_tx", "message", 1, Write, "projection of a message just written"),
    ("crates/momo-messaging/src/attachment_media.rs", "load_poster_in_tx", "attachment_media", 1, Gated, "after load_readable_attachment_in_tx"),
    ("crates/momo-messaging/src/attachment_media.rs", "set_attachment_media_in_tx", "attachment_media", 1, Write, "the uploader's unsent file"),
    ("crates/momo-messaging/src/attachment_reclaim.rs", "candidate_ids_sql", "attachment", 1, Machine, "reclaim sweeper"),
    ("crates/momo-messaging/src/attachment_reclaim.rs", "recheck_sql", "attachment", 1, Machine, "reclaim sweeper"),
    ("crates/momo-messaging/src/attachment_reclaim.rs", "reclaim_unbound_attachment_in_tx", "attachment", 2, Machine, "reclaim sweeper"),
    ("crates/momo-messaging/src/attachment_reclaim.rs", "tally_sql", "attachment", 1, Machine, "reclaim sweeper"),
    ("crates/momo-messaging/src/attachment_reclaim.rs", "workspaces_sql", "attachment", 1, Machine, "reclaim sweeper"),
    ("crates/momo-messaging/src/hosted_inbox.rs", "append_message_reference_in_tx", "message", 1, Machine, "hosted agent inbox"),
    ("crates/momo-messaging/src/hosted_inbox.rs", "list_hosted_inbox_in_tx", "message", 1, Machine, "hosted agent inbox"),
    ("crates/momo-messaging/src/inbox.rs", "VISIBLE_FROM_WHERE", "message", 2, Floor, "inbox list and count"),
    ("crates/momo-messaging/src/interaction.rs", "channel_pins", "message", 1, Floor, "pin list"),
    ("crates/momo-messaging/src/interaction.rs", "channel_reaction_snapshot", "message", 1, Floor, "reaction list"),
    ("crates/momo-messaging/src/interaction.rs", "delete_message_in_tx", "message", 1, Write, "delete target"),
    ("crates/momo-messaging/src/interaction.rs", "lock_message_in_tx", "message", 1, Write, "edit, reaction and pin target"),
    ("crates/momo-messaging/src/interaction.rs", "message_props_in_tx", "message", 1, Write, "card props write"),
    ("crates/momo-messaging/src/interaction.rs", "open_stream_message_for_run_in_tx", "message", 1, Floor, "agent run stream; also read by the deliver and message routes"),
    ("crates/momo-messaging/src/interaction.rs", "reread_interaction_in_tx", "message", 1, Write, "re-read after a write"),
    ("crates/momo-messaging/src/interaction.rs", "set_pin_in_tx", "message", 1, Write, "pin target"),
    ("crates/momo-messaging/src/memory.rs", "attach_evidence", "message", 1, Floor, "memory route; a human 1:1 is not memory-eligible"),
    ("crates/momo-messaging/src/memory.rs", "evidence_for_digests_in_tx", "message", 1, Floor, "memory route"),
    ("crates/momo-messaging/src/memory.rs", "evidence_for_items_in_tx", "message", 1, Floor, "memory route"),
    ("crates/momo-messaging/src/memory.rs", "get_serving_in_tx", "message", 1, Floor, "memory route"),
    ("crates/momo-messaging/src/message.rs", "PAGED_QUOTE_JOIN", "message", 1, Floor, "quote on a history page"),
    ("crates/momo-messaging/src/message.rs", "agent_auto_reply_streak_in_tx", "message", 2, Machine, "agent-to-agent gate"),
    ("crates/momo-messaging/src/message.rs", "agent_context_window_for_member_in_tx", "message", 4, Floor, "agent context; also read by the mention route"),
    ("crates/momo-messaging/src/message.rs", "channel_page_sql", "message", 1, Floor, "history"),
    ("crates/momo-messaging/src/message.rs", "client_msg_id_of", "message", 1, Write, "send retry"),
    ("crates/momo-messaging/src/message.rs", "find_client_message_in_tx", "message", 1, Machine, "agent gateway and tools"),
    ("crates/momo-messaging/src/message.rs", "find_message_in_tx", "message", 1, Floor, "approval and mention routes"),
    ("crates/momo-messaging/src/message.rs", "insert_message_in_tx", "message", 1, Write, "send retry re-read (409 below the floor)"),
    ("crates/momo-messaging/src/message.rs", "list_messages", "message", 1, Floor, "history"),
    ("crates/momo-messaging/src/message.rs", "thread_replies_sql", "message", 1, Floor, "thread replies"),
    ("crates/momo-messaging/src/message.rs", "thread_root_state_in_tx", "message", 1, Write, "reply root check (404 below the floor)"),
    ("crates/momo-messaging/src/read_state.rs", "record_mentions_in_tx", "message", 1, Write, "quoted author at send"),
    ("crates/momo-messaging/src/read_state.rs", "update_read_cursor_with_intent_in_tx", "message", 2, Floor, "mention recount on read"),
    ("crates/momo-messaging/src/reminder.rs", "authorize_reminder_message_in_tx", "message", 1, Write, "reminder target"),
    ("crates/momo-messaging/src/scheduled.rs", "reserve_attachments_in_tx", "attachment", 1, Write, "the author's own schedule"),
    ("crates/momo-messaging/src/scheduled.rs", "schedule_attachments_in_tx", "attachment", 1, Write, "the author's own schedule"),
    ("crates/momo-messaging/src/search.rs", "SEARCH_FROM", "message", 1, Floor, "search"),
    ("crates/momo-messaging/src/self_media.rs", "trigger_photo_in_tx", "attachment", 1, Machine, "agent self media"),
    ("crates/momo-messaging/src/thread_follow.rs", "AUTO_FOLLOW_SQL", "message", 2, Write, "auto follow at send"),
    ("crates/momo-messaging/src/thread_follow.rs", "followed_unread_by_channel_in_tx", "message", 1, Floor, "followed thread counts"),
    ("crates/momo-messaging/src/thread_follow.rs", "mark_followed_threads_read_in_tx", "message", 1, Floor, "followed threads read"),
    ("crates/momo-messaging/src/thread_follow.rs", "thread_follow_views_in_tx", "message", 1, Floor, "followed thread list"),
    ("crates/momo-push/src/judgment.rs", "judge_targets_for_source", "message", 4, Machine, "notifier; a push carries ids only"),
    ("crates/momo-push/src/refine.rs", "refine_targets", "message", 1, Floor, "notifier and the presence route"),
    ("crates/momo-t3/src/lifecycle.rs", "create_local_pty_work_session_with_id_in_tx", "message", 1, Write, "work session create"),
    ("crates/momo-t3/src/lifecycle.rs", "create_work_session_with_id_in_tx", "message", 1, Write, "work session create"),
    ("crates/momo-t3/src/lifecycle.rs", "lock_work_session_detail_in_tx", "message", 1, Write, "work session lock"),
    ("crates/momo-t3/src/reattach.rs", "list_session_events_in_tx", "message", 1, Floor, "session events"),
    ("crates/momo-t3/src/reattach.rs", "load_session_reattach_state_in_tx", "message", 1, Floor, "session reattach"),
    ("crates/momo-t3/src/reattach.rs", "reattach_columns", "message", 1, Floor, "session reattach"),
    ("crates/momo-t3/src/work_board.rs", "SELECT", "message", 2, Floor, "work board"),
    ("crates/momo-unfurl/src/remove.rs", "message_channel", "message", 1, Floor, "card list and removal check"),
    ("crates/momo-unfurl/src/remove.rs", "remove_unfurls_in_tx", "message_unfurl", 1, Write, "the author removing cards"),
    ("crates/momo-unfurl/src/store.rs", "list_unfurls_in_tx", "message_unfurl", 1, Gated, "after message_channel; the unfurl worker"),
    ("crates/momo-unfurl/src/store.rs", "load_message", "message", 1, Machine, "unfurl worker"),
    ("crates/momo-unfurl/src/store.rs", "load_unfurl_in_tx", "message", 1, Floor, "card picture and icon (D17)"),
    ("crates/momo-unfurl/src/store.rs", "load_unfurl_in_tx", "message_unfurl", 1, Floor, "EXISTS message in the same statement"),
    ("crates/momo-workspace-actions/src/action_resolve.rs", "resolve_pin_target_scoped_in_tx", "attachment", 2, Floor, "the same statement joins message"),
    ("crates/momo-workspace-actions/src/action_resolve.rs", "resolve_pin_target_scoped_in_tx", "message", 1, Floor, "workspace action target"),
    ("crates/momo-workspace-actions/src/team_ai.rs", "recent_requests_by_in_tx", "message", 1, Machine, "team AI"),
    ("crates/momo-workspace-actions/src/team_ai_attachments.rs", "readable_attachments_of_message_in_tx", "attachment", 1, Machine, "team AI"),
    ("crates/momo-workspace-actions/src/team_ai_attachments.rs", "readable_attachments_of_message_in_tx", "message", 1, Machine, "team AI"),
    ("crates/momo-workspace-actions/src/team_ai_tools.rs", "read_channel", "message", 1, Machine, "team AI"),
    ("crates/momo-workspace-actions/src/team_ai_tools.rs", "read_thread", "message", 1, Machine, "team AI"),
];

type Key = (String, String, String);

fn server_rust_root() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

/// `fn NAME` at any depth; `const`/`static NAME` only at column 0 (a const inside a function body
/// belongs to that function).
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

fn identifier(word: &str) -> String {
    word.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect()
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Tracked tables named right after a `FROM` or `JOIN` keyword and whitespace, in one (already
/// joined) line. `String::from(message)` is not a read: the keyword must be followed by whitespace.
fn reads_in(line: &str) -> Vec<&'static str> {
    let lower = line.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut found = Vec::new();
    for keyword in ["from", "join"] {
        let mut start = 0;
        while let Some(offset) = lower[start..].find(keyword) {
            let at = start + offset;
            start = at + keyword.len();
            if at > 0 && is_word(bytes[at - 1]) {
                continue;
            }
            let mut cursor = start;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor == start {
                continue;
            }
            if lower[cursor..].starts_with("public.") {
                cursor += "public.".len();
            }
            let end = (cursor..bytes.len())
                .find(|&i| !is_word(bytes[i]))
                .unwrap_or(bytes.len());
            let table = &lower[cursor..end];
            if let Some(tracked) = TRACKED.iter().find(|tracked| **tracked == table) {
                found.push(*tracked);
            }
        }
    }
    found
}

/// Every tracked read of one source file, by enclosing item and table. A string continued with a
/// trailing `\` is read as one line, so `FROM \` + `message` on the next line is still a read.
fn scan_source(text: &str) -> BTreeMap<(String, String), usize> {
    let raw: Vec<&str> = text.lines().collect();
    let mut out = BTreeMap::new();
    let mut item = String::from("<module>");
    let mut depth: i64 = 0;
    let mut skip_until: Option<i64> = None;
    let mut cfg_test = false;
    let mut index = 0;
    while index < raw.len() {
        let mut line = raw[index].to_string();
        while line.trim_end().ends_with('\\') && index + 1 < raw.len() {
            index += 1;
            let kept = line.trim_end().trim_end_matches('\\').to_string();
            line = format!("{kept} {}", raw[index].trim());
        }
        index += 1;
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
        if let Some(name) = item_name(&line) {
            item = name;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        for table in reads_in(&line) {
            *out.entry((item.clone(), table.to_string())).or_insert(0) += 1;
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
                for ((item, table), count) in scan_source(&text) {
                    out.insert((rel.clone(), item, table), count);
                }
            }
        }
    }
    out
}

fn table() -> BTreeMap<Key, usize> {
    let mut out = BTreeMap::new();
    for (file, item, table, count, _, why) in PATHS {
        assert!(!why.is_empty(), "{file} {item}: a row says why");
        let key = (file.to_string(), item.to_string(), table.to_string());
        assert!(
            out.insert(key, *count).is_none(),
            "{file} {item} {table}: one row per read site"
        );
    }
    out
}

/// What the source has and the table does not, and the other way round.
fn differences(found: &BTreeMap<Key, usize>, listed: &BTreeMap<Key, usize>) -> Vec<String> {
    let mut out = Vec::new();
    for (key, count) in found {
        match listed.get(key) {
            None => out.push(format!(
                "unclassified: (\"{}\", \"{}\", \"{}\", {count}, <class>, \"<why>\")",
                key.0, key.1, key.2
            )),
            Some(listed) if listed != count => out.push(format!(
                "count changed: {} {} {}: source {count}, table {listed}",
                key.0, key.1, key.2
            )),
            Some(_) => {}
        }
    }
    for key in listed.keys() {
        if !found.contains_key(key) {
            out.push(format!("stale row: {} {} {}", key.0, key.1, key.2));
        }
    }
    out
}

#[test]
fn every_message_read_in_the_server_source_is_classified() {
    let found = scan_tree(&server_rust_root());
    assert!(
        found.len() >= 100,
        "the scan must see the server's reads, saw {}",
        found.len()
    );
    let problems = differences(&found, &table());
    assert!(
        problems.is_empty(),
        "every read of message or of a content copy needs a row in PATHS (ADR-0177 D17 길 전수 표):\n{}",
        problems.join("\n")
    );
    for class in [Floor, Gated, Write, Machine] {
        assert!(
            PATHS.iter().any(|row| row.4 == class),
            "{class:?} is in use"
        );
    }
}

#[test]
fn an_unclassified_read_turns_the_inventory_red() {
    let listed = table();
    let mut found = scan_tree(&server_rust_root());
    assert!(differences(&found, &listed).is_empty(), "baseline is green");

    // A new read in a new function: one more site than the table knows.
    let source = "pub async fn sneaky_page_in_tx(conn: &mut PgConnection) {\n\
                  \x20   sqlx::query(\"SELECT body FROM \\\n\
                  \x20        message WHERE channel_id = $1\");\n\
                  \x20   sqlx::query(\"SELECT title FROM message_unfurl WHERE id = $1\");\n\
                  }\n\
                  // SELECT body FROM message — a comment is not a read\n\
                  pub fn not_a_table() { let _ = \"FROM message_reminder JOIN messages\"; }\n\
                  #[cfg(test)]\n\
                  mod tests {\n\
                  \x20   fn helper() { let _ = \"SELECT 1 FROM message\"; }\n\
                  }\n\
                  fn after_the_tests() { let _ = \"x JOIN public.attachment a\"; }\n";
    let scanned = scan_source(source);
    let expected: BTreeMap<(String, String), usize> = [
        (("sneaky_page_in_tx", "message"), 1),
        (("sneaky_page_in_tx", "message_unfurl"), 1),
        (("after_the_tests", "attachment"), 1),
    ]
    .into_iter()
    .map(|((item, table), n)| ((item.to_string(), table.to_string()), n))
    .collect();
    assert_eq!(
        scanned, expected,
        "a split read is seen; comments, test modules and look-alike tables are not"
    );
    for ((item, table), count) in scanned {
        found.insert(
            (
                "crates/momo-messaging/src/sneaky.rs".to_string(),
                item,
                table,
            ),
            count,
        );
    }
    let problems = differences(&found, &listed);
    assert_eq!(problems.len(), 3, "{problems:#?}");
    assert!(problems.iter().all(|p| p.starts_with("unclassified")));

    // A read that disappears leaves a stale row, and a second read in a listed function changes
    // its count: both are red too.
    let mut moved = scan_tree(&server_rust_root());
    let search = (
        "crates/momo-messaging/src/search.rs".to_string(),
        "SEARCH_FROM".to_string(),
        "message".to_string(),
    );
    moved.remove(&search);
    let history = (
        "crates/momo-messaging/src/message.rs".to_string(),
        "channel_page_sql".to_string(),
        "message".to_string(),
    );
    *moved.get_mut(&history).expect("history is listed") += 1;
    let problems = differences(&moved, &listed);
    assert_eq!(problems.len(), 2, "{problems:#?}");
}
