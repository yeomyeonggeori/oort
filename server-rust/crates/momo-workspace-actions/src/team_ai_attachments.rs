//! The domain half of the helper's `read_attachment` (ADR-0201 증보 v3 B6-1, #4970 S7).
//!
//! The worker owns the plumbing — the bytes (through the api's private address, ADR-0151 증보 3·4),
//! the extraction, the picture for the model. **Everything that decides lives here**: whose file may
//! be read, what is said when it may not, how a document's letters are made safe to show a model.
//!
//! ## Two rules, one answer
//!
//! A read is asked **as the person who asked** and answered **in the room they asked in**, so a file
//! must pass two rules and every refusal of either is the same [`ToolOutcome::NotFound`]:
//!
//! 1. **the requester's rule** — [`momo_messaging::find_requester_attachment_for_in_tx`] for
//!    [`RequesterAttachmentUse::ReadAnyType`], the one statement every requester-attachment read follows
//!    (complete, on a live message **the requester wrote, in the conversation the run is in**, an
//!    unarchived channel; the type is narrowed afterwards, so the requester's own file of a type the
//!    helper does not read is told so). Somebody else's file, a file of another channel
//!    or workspace, a deleted message's file and an id that does not exist are all `None`;
//! 2. **the reply channel's audience rule** (H4-3) — the file's channel must be one the room the
//!    answer goes to may hear about ([`ReadScope::audience`]).
//!
//! Today the first rule already pins the file to the reply channel, which the second always admits,
//! so through [`crate::team_ai_tools::load_scope_in_tx`] the audience check never refuses on its own.
//! It stays — checked here, as a function argument, not a sentence in a prompt — because the day a
//! file search (F2) lets the requester name a file of another channel, **this** is the line that keeps
//! a private channel's file out of a public room. A test builds a scope whose audience excludes the
//! file's channel and shows it refuse.
//!
//! ## What is never stored
//!
//! A file's letters, the extracted text and a picture are not in an audit row, a log line, a work
//! note or any column: what a caller keeps is an id, a size, a media type and a closed outcome code
//! (B13-I6). [`AttachmentTarget`] and [`ToolOutcome`] print lengths, not content, in `Debug`.

use momo_agent::team_ai_roles::{self as roles, TeamAiRoles};
use momo_db::{DbError, PgConnection};
use momo_messaging::{
    find_requester_attachment_for_in_tx, read_kind, ReadKind, RequesterAttachmentUse,
    SELF_MEDIA_MAX_BYTES,
};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::team_ai_tools::{
    args_object, opt_str, ReadScope, ToolOutcome, DOCUMENT_CHARS_MAX, HELPER_READ_ROLE,
};

/// The largest file a person can read through the helper: the same ceiling as the picture route
/// ([`SELF_MEDIA_MAX_BYTES`], 5 MiB). ADR-0201 B6-1 wrote 10MB as an estimate; the route's ceiling is
/// pinned to the avatar's by a test, and one number is what keeps a file the lookup accepts from being
/// one the route refuses.
pub const READ_MAX_BYTES: i64 = SELF_MEDIA_MAX_BYTES;

/// The largest file the table can hold (`attachment_size_ck`, migration 017). Ownership is judged under
/// **this** ceiling so a person's own oversized file is told 「너무 커요」 instead of 「못 찾아요」: they wrote
/// it, so nothing leaks, and a file that is not theirs is `None` whatever its size.
const TABLE_MAX_BYTES: i64 = 104_857_600;

/// How many attachments the trigger turn lists for the model to name. Small on purpose: the list
/// is reserved room in a turn of at most 1,500 characters, and a long list would squeeze out the
/// person's own request.
pub const LISTED_ATTACHMENTS_MAX: i64 = 8;

// ---------------------------------------------------------------------------
// the honest sentences (B6-1)
// ---------------------------------------------------------------------------

const fn notice(code: &'static str, sentence: &'static str) -> ToolOutcome {
    ToolOutcome::Notice { code, sentence }
}

/// The `files` bundle is off (B13-I5: not advertised **and** refused when named anyway).
pub const FILES_OFF: ToolOutcome = notice(
    "files_off",
    "이 워크스페이스에서는 도우미의 파일 읽기 역할이 꺼져 있어요. 관리자에게 부탁해 켤 수 있어요.",
);
/// The requester's own file is over [`READ_MAX_BYTES`].
pub const TOO_LARGE: ToolOutcome = notice(
    "too_large",
    "이 파일은 너무 커서 읽지 못해요. 5MB 이하 파일만 읽을 수 있어요.",
);
/// A type the helper does not read (it is the requester's own file, so saying so leaks nothing).
pub const UNSUPPORTED_TYPE: ToolOutcome = notice(
    "unsupported_type",
    "이 종류의 파일은 아직 못 읽어요. 글 파일(txt·md·csv·json)과 PDF, 이미지(png·jpeg·webp)만 읽을 수 있어요.",
);
/// The server could not read the file (the archive or the api's private door failed) — **a hiccup**: asking
/// again is the right answer. What is wrong with the file itself is [`NOT_READABLE_FORMAT`] or
/// [`EMPTY_FILE`], never this (#4970 review, L1: a permanent cause must not be told as 「잠시 뒤에」).
pub const UNREADABLE: ToolOutcome = notice(
    "unreadable",
    "서버가 이 파일을 읽지 못했어요. 잠시 뒤에 다시 부탁해 주세요.",
);
/// The requester's own file has no bytes (a permanent property of the file).
pub const EMPTY_FILE: ToolOutcome = notice(
    "empty_file",
    "이 파일은 비어 있어요. 내용이 있는 파일을 올려서 다시 부탁해 주세요.",
);
/// The bytes are not something the helper can read — a text file in another encoding (UTF-16…), a file that
/// calls itself a PDF and is not one, a PDF that is broken or too complex to open. A permanent property of
/// **this file**: said as such, with what would work, and never as a reason to try again in a moment.
pub const NOT_READABLE_FORMAT: ToolOutcome = notice(
    "unreadable_format",
    "이 파일은 읽을 수 없는 형식이에요. 글 파일은 UTF-8이나 EUC-KR이어야 하고, PDF는 열리고 너무 복잡하지 않아야 해요. 다시 만들어 올려 주세요.",
);
/// The file was read but no letters came out of it.
pub const NO_TEXT: ToolOutcome = notice(
    "no_text",
    "이 파일에서 글자를 뽑지 못했어요. 스캔한 PDF이거나 암호가 걸려 있을 수 있어요.",
);
/// The team's model connection cannot take a picture as input.
pub const IMAGE_NOT_SUPPORTED: ToolOutcome = notice(
    "image_not_supported",
    "이 연결로는 이미지를 못 봐요. 이미지 속 글자나 그림 내용은 말해 줄 수 없어요.",
);
/// A second picture in one request.
pub const ONE_IMAGE_ONLY: ToolOutcome = notice(
    "one_image_only",
    "이미지는 한 번에 하나만 볼 수 있어요. 하나씩 나눠서 물어봐 주세요.",
);
/// Too many files are being read at once (the extraction's process-wide slots).
pub const BUSY: ToolOutcome = notice(
    "busy",
    "지금 파일을 읽는 일이 몰려 있어요. 잠시 뒤에 다시 부탁해 주세요.",
);
/// The picture could not be made ready for the model (not a still picture, too big to open).
pub const IMAGE_UNREADABLE: ToolOutcome = notice(
    "image_unreadable",
    "이 이미지는 열 수 없어요. 움직이는 이미지이거나 너무 크거나 깨진 파일일 수 있어요.",
);

// ---------------------------------------------------------------------------
// the lookup
// ---------------------------------------------------------------------------

/// A file the requester may read here, as the database has just proved it. Deliberately not
/// `Debug`-derived: `drive_file_id` is the archive's own name for the file, and no log line, error or
/// audit row has any business holding it.
#[derive(Clone, PartialEq, Eq)]
pub struct AttachmentTarget {
    pub attachment_id: Uuid,
    pub channel_id: Uuid,
    pub drive_file_id: String,
    pub size_bytes: i64,
    pub mime: String,
    pub kind: ReadKind,
}

impl std::fmt::Debug for AttachmentTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AttachmentTarget")
            .field("attachment_id", &self.attachment_id)
            .field("kind", &self.kind)
            .field("size_bytes", &self.size_bytes)
            .finish()
    }
}

/// Which file the model named, and whether the requester may have it read **in this room**.
///
/// The caller has entered `momo_helper_read` (SELECT only, NOBYPASSRLS) and built `scope` from
/// the run's own rows ([`crate::team_ai_tools::load_scope_in_tx`]): the requester, the reply channel and
/// the audience are the server's, and the only thing the model supplies is the attachment id.
///
/// `Err(outcome)` is a refusal the model is shown; `Err(DbError)` — the outer `Result` — is a
/// database failure. **Every refusal that is about a file somebody could not see is the same
/// [`ToolOutcome::NotFound`]** — a missing id, another workspace's, a deleted message's, a file of
/// somebody else, of another channel, of an archived one, one still uploading — in the same words.
pub async fn lookup_in_tx(
    conn: &mut PgConnection,
    scope: &ReadScope,
    raw_args: &Value,
) -> Result<Result<AttachmentTarget, ToolOutcome>, DbError> {
    // H9-I3, structurally: this decision is made **as the person who asked** — in a transaction that
    // has dropped the worker's BYPASSRLS (`SET LOCAL ROLE momo_helper_read`). A caller that forgot is
    // refused here, before a row is read, so the workspace boundary is the database's and not only the
    // `workspace_id` in the statements below.
    let current: String = sqlx::query_scalar("SELECT current_user::text")
        .fetch_one(&mut *conn)
        .await?;
    if current != HELPER_READ_ROLE {
        return Err(DbError::from(sqlx::Error::Protocol(
            "read_attachment's lookup must run as momo_helper_read".into(),
        )));
    }
    let args = match args_object(raw_args, &["attachmentId"]) {
        Ok(args) => args,
        Err(outcome) => return Ok(Err(outcome)),
    };
    let raw_id = match opt_str(args, "attachmentId") {
        Ok(Some(raw)) => raw,
        Ok(None) => return Ok(Err(ToolOutcome::Invalid("attachmentId is required"))),
        Err(outcome) => return Ok(Err(outcome)),
    };
    let Ok(attachment_id) = Uuid::parse_str(raw_id) else {
        return Ok(Err(ToolOutcome::Invalid(
            "attachmentId must be an attachment id",
        )));
    };

    // B13-I5, at execution: the tool was not offered while `files` is off, and a call that names it
    // anyway (a model going off script, or the switch moving while it thought) is refused here too.
    // Unreadable settings never read as "on".
    let settings: Option<Value> =
        sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
            .bind(scope.workspace_id)
            .fetch_optional(&mut *conn)
            .await?;
    let switches = match settings {
        Some(settings) => TeamAiRoles::from_settings(&settings),
        None => TeamAiRoles::none_on(),
    };
    if !switches.tool_allowed(roles::TOOL_READ_ATTACHMENT) || !switches.is_on(roles::FILES) {
        return Ok(Err(FILES_OFF));
    }

    // Rule 1: the requester's.
    let Some(source) = find_requester_attachment_for_in_tx(
        conn,
        scope.workspace_id,
        scope.requester,
        scope.reply_channel,
        attachment_id,
        TABLE_MAX_BYTES,
        RequesterAttachmentUse::ReadAnyType,
    )
    .await?
    else {
        return Ok(Err(ToolOutcome::NotFound));
    };
    // Rule 2: the reply channel's audience (H4-3), as a function argument.
    if !scope.audience.allows(source.channel_id) {
        return Ok(Err(ToolOutcome::NotFound));
    }
    // From here the file is the requester's own, in this room: what is said about it leaks nothing.
    // The type first: a ceiling means nothing for a file that is not read at all.
    let Some(kind) = read_kind(&source.mime) else {
        return Ok(Err(UNSUPPORTED_TYPE));
    };
    if source.size_bytes > READ_MAX_BYTES {
        return Ok(Err(TOO_LARGE));
    }
    // An empty file reaches here only because the lookup use admits one (`min_bytes() == 0`): it is the
    // requester's own, so it is told what is wrong with it. Nothing is minted or fetched for it.
    if source.size_bytes == 0 {
        return Ok(Err(EMPTY_FILE));
    }
    Ok(Ok(AttachmentTarget {
        attachment_id: source.id,
        channel_id: source.channel_id,
        drive_file_id: source.drive_file_id,
        size_bytes: source.size_bytes,
        mime: source.mime,
        kind,
    }))
}

// ---------------------------------------------------------------------------
// what the trigger turn lists
// ---------------------------------------------------------------------------

/// The complete attachments of one **live** message, of **any** type — what the trigger turn names so
/// the model has an id to read (and, for a type the helper does not read, a reason to say so):
/// `(id, recorded media type, size)`, oldest first, at most
/// [`LISTED_ATTACHMENTS_MAX`]. Server-owned values only: **no file name** goes into the instruction
/// channel (a name is whatever the file's author typed, and this block rides in the one place the model
/// takes instructions from).
///
/// Run in the worker's gather transaction (tenant GUC bound, explicit workspace predicate), like the
/// image list the profile flow has always carried.
pub async fn readable_attachments_of_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
) -> Result<Vec<(Uuid, String, i64)>, DbError> {
    let rows = sqlx::query(
        "SELECT a.id, a.mime, a.size_bytes \
           FROM attachment a \
           JOIN message m ON m.workspace_id = a.workspace_id AND m.id = a.message_id \
          WHERE a.workspace_id = $1 AND a.message_id = $2 AND a.status = 'complete' \
            AND a.drive_file_id IS NOT NULL \
            AND m.state <> 'deleted' AND m.deleted_at IS NULL \
          ORDER BY a.created_at ASC, a.id ASC LIMIT $3",
    )
    .bind(workspace_id)
    .bind(message_id)
    .bind(LISTED_ATTACHMENTS_MAX)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok((
                row.try_get::<Uuid, _>("id")?,
                row.try_get::<String, _>("mime")?,
                row.try_get::<i64, _>("size_bytes")?,
            ))
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// The block that follows the trigger's text when the message carries readable files: a header the
/// model reads as data, then one line per file — `id · type · bytes`. Empty for no files.
pub fn attachment_list_block(files: &[(Uuid, String, i64)]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut block =
        String::from("\n[데이터: 이 메시지의 첨부 — read_attachment에는 이 attachmentId만 써]\n");
    for (id, mime, size) in files.iter().take(LISTED_ATTACHMENTS_MAX as usize) {
        block.push_str(&format!("{id} · {mime} · {size}바이트\n"));
    }
    block
}

// ---------------------------------------------------------------------------
// a document's letters
// ---------------------------------------------------------------------------

/// Is this one of the characters that carry no letter a reader sees but can carry an instruction a
/// model reads — zero-width and bidirectional controls, the BOM, the Unicode tag block, the invisible
/// Hangul fillers, the soft hyphen and the other default-ignorable formatters?
///
/// The list is the repository's own ([`momo_messaging::name_guard::is_invisible_format_char`], which
/// the names people type are held to), **plus the variation selectors** U+FE00–U+FE0F: a name may keep
/// one for an emoji, but a document must not — a run of them after one emoji or letter is a known way
/// to hide a message in text that looks empty (the supplement U+E0100–U+E01EF is in the shared list).
/// Removing one from a real emoji costs its colour presentation and nothing a reader needs.
fn is_invisible_format(c: char) -> bool {
    momo_messaging::name_guard::is_invisible_format_char(c) || matches!(c, '\u{FE00}'..='\u{FE0F}')
}

/// A document's text as it may be shown to a model: **line breaks kept** (a document is its lines,
/// unlike [`crate::team_ai_tools::data_text`], which flattens a one-line datum), every other control
/// character and every invisible format character removed, a code fence defused, three or more
/// line breaks in a row folded to two, and at most [`DOCUMENT_CHARS_MAX`] characters kept. The
/// second value says whether anything was cut.
///
/// The text stays data: the caller renders it inside the fence the prompt calls data, and
/// [`ToolOutcome::render`] defuses any fence a body still spells.
pub fn document_text(raw: &str) -> (String, bool) {
    let mut cleaned = String::with_capacity(raw.len().min(DOCUMENT_CHARS_MAX * 4));
    // characters pushed so far (a running count: `chars().count()` per step would be quadratic)
    let mut kept = 0usize;
    let mut newlines = 0usize;
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        // a line break is `\n`, `\r\n` or a lone `\r`
        let c = if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            '\n'
        } else {
            c
        };
        if c == '\n' {
            newlines += 1;
            if newlines <= 2 {
                cleaned.push('\n');
                kept += 1;
            }
            continue;
        }
        if c == '\t' {
            newlines = 0;
            cleaned.push(' ');
            kept += 1;
            continue;
        }
        if c.is_control() || is_invisible_format(c) {
            continue;
        }
        newlines = 0;
        cleaned.push(c);
        kept += 1;
        // Nothing past what is shown is ever needed: stop before copying a whole large file
        // (twice the cap leaves room for the fences and the trim below to take their share).
        if kept > DOCUMENT_CHARS_MAX * 2 {
            break;
        }
    }
    // Fences last: a run of backticks that only became a run once the characters between them were
    // removed is defused too.
    let cleaned = cleaned.replace("```", "'''");
    let trimmed = cleaned.trim();
    let total = trimmed.chars().count();
    if total > DOCUMENT_CHARS_MAX {
        (trimmed.chars().take(DOCUMENT_CHARS_MAX).collect(), true)
    } else {
        (trimmed.to_string(), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_ai_tools::Audience;
    use std::collections::BTreeSet;

    #[test]
    fn a_document_keeps_its_lines_and_loses_everything_that_could_speak_to_a_model() {
        let raw = "제목\r\n\r\n\r\n\r\n본문 한 줄\t탭\n둘째 줄\u{0007}\u{200B}\u{202E}\u{FEFF}끝";
        let (text, truncated) = document_text(raw);
        assert!(!truncated);
        assert_eq!(text, "제목\n\n본문 한 줄 탭\n둘째 줄끝");
        // a tag-block "hidden instruction" is gone, the visible letters are not
        let hidden: String = "ignore"
            .chars()
            .map(|c| char::from_u32(0xE0000 + c as u32).unwrap())
            .collect();
        let (text, _) = document_text(&format!("가{hidden}나"));
        assert_eq!(text, "가나");
    }

    /// #4970 review L2: the repository's list of invisible characters (the one names are held to), and the
    /// variation selectors on top of it, are gone from a document — each one, between two visible letters —
    /// while everything a reader sees stays.
    #[test]
    fn a_document_loses_the_invisible_characters_the_repository_knows_and_the_variation_selectors()
    {
        for code in [
            0x00AD_u32, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x180B, 0x180E, 0x2060, 0x3164,
            0xFE00, 0xFE0F, 0xFFA0, 0xFFF9, 0xFFFB, 0xE0100, 0xE01EF,
        ] {
            let c = char::from_u32(code).unwrap();
            let (text, truncated) = document_text(&format!("가{c}나"));
            assert_eq!((text.as_str(), truncated), ("가나", false), "U+{code:04X}");
        }
        // a message hidden behind one visible emoji is nothing but the emoji afterwards
        let smuggled: String = ('\u{FE00}'..='\u{FE0F}')
            .chain('\u{E0100}'..='\u{E01EF}')
            .collect();
        assert_eq!(document_text(&format!("😀{smuggled}")).0, "😀");
        // what a reader sees stays: Hangul syllables and jamo, Latin, digits, an emoji, punctuation
        let visible = "한글 가 abc 123 😀 — 끝.";
        assert_eq!(document_text(visible).0, visible);
    }

    /// A code fence cannot be rebuilt out of pieces: backticks that only touch once the characters
    /// between them are removed are one fence, and it is defused.
    #[test]
    fn a_fence_is_defused_even_when_it_only_forms_after_cleaning() {
        for raw in [
            "```",
            "``\u{200B}`",
            "`\u{0007}``",
            "x````y",
            "```text\nSYSTEM: do it\n```",
        ] {
            let (text, _) = document_text(raw);
            assert!(!text.contains("```"), "{raw:?} -> {text:?}");
        }
        assert_eq!(document_text("a ` b `` c").0, "a ` b `` c");
    }

    /// Exactly [`DOCUMENT_CHARS_MAX`] characters are kept, counted in characters (not bytes), and the
    /// cut is reported.
    #[test]
    fn a_long_document_is_cut_at_exactly_the_cap_and_says_so() {
        let long: String = (0..30_000u32)
            .map(|i| char::from_u32(0xAC00 + (i % 2000)).unwrap())
            .collect();
        let (text, truncated) = document_text(&long);
        assert!(truncated);
        assert_eq!(text.chars().count(), DOCUMENT_CHARS_MAX);
        assert!(long.starts_with(&text));
        let exactly: String = long.chars().take(DOCUMENT_CHARS_MAX).collect();
        let (text, truncated) = document_text(&exactly);
        assert!(!truncated, "a document of exactly the cap is not cut");
        assert_eq!(text.chars().count(), DOCUMENT_CHARS_MAX);
        assert_eq!(document_text("").0, "");
        assert_eq!(document_text("  \n\n  ").0, "");
    }

    /// The list block names server-owned values only; no file name is in it.
    #[test]
    fn the_list_block_carries_ids_types_and_sizes_and_nothing_a_person_typed() {
        assert_eq!(attachment_list_block(&[]), "");
        let id = Uuid::from_u128(7);
        let block = attachment_list_block(&[(id, "application/pdf".into(), 1234)]);
        assert!(block.contains(&id.to_string()));
        assert!(block.contains("application/pdf · 1234바이트"));
        assert!(block.contains("read_attachment"));
    }

    #[test]
    fn every_honest_sentence_has_a_distinct_closed_code() {
        let all = [
            FILES_OFF,
            TOO_LARGE,
            UNSUPPORTED_TYPE,
            UNREADABLE,
            NO_TEXT,
            IMAGE_NOT_SUPPORTED,
            ONE_IMAGE_ONLY,
            BUSY,
            IMAGE_UNREADABLE,
            EMPTY_FILE,
            NOT_READABLE_FORMAT,
        ];
        let codes: BTreeSet<&str> = all.iter().map(ToolOutcome::code).collect();
        assert_eq!(codes.len(), all.len(), "two sentences share a code");
        for outcome in &all {
            let ToolOutcome::Notice { code, sentence } = outcome else {
                panic!("not a notice");
            };
            assert!(code.chars().all(|c| c.is_ascii_lowercase() || c == '_'));
            assert!(sentence.ends_with("요."), "{sentence}");
            // they are the model's to repeat: no id, no path, no name
            assert!(!sentence.contains('/'), "{sentence}");
        }
        // none of them is a refusal about existence: those are `NotFound`, in one voice
        assert_ne!(TOO_LARGE.code(), ToolOutcome::NotFound.code());
        // #4970 review L1: only the server's own hiccup says 「잠시 뒤에 다시」; a permanent property of the
        // file (too big, not a type we read, empty, not a readable format) never does
        for permanent in [TOO_LARGE, UNSUPPORTED_TYPE, EMPTY_FILE, NOT_READABLE_FORMAT] {
            let ToolOutcome::Notice { sentence, .. } = permanent else {
                panic!("not a notice");
            };
            assert!(!sentence.contains("잠시 뒤"), "{sentence}");
        }
        let ToolOutcome::Notice { sentence, .. } = UNREADABLE else {
            panic!("not a notice");
        };
        assert!(
            sentence.contains("잠시 뒤"),
            "the hiccup keeps its honest 「잠시 뒤에」"
        );
    }

    #[test]
    fn the_audience_rule_admits_only_the_channels_the_room_may_hear_about() {
        let reply = Uuid::from_u128(1);
        let public = Uuid::from_u128(2);
        let private = Uuid::from_u128(3);
        let room = Audience::Channels(BTreeSet::from([reply, public]));
        assert!(room.allows(reply));
        assert!(room.allows(public));
        assert!(!room.allows(private));
        assert!(Audience::RequesterView.allows(private));
    }
}
