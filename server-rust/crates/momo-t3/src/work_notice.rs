//! #5594 — the lines that tell a work session's owner the work stopped
//! (ADR-0188 D7·D8, ADR-0220 P2 ③ 막힘 · ④ 실패 and P3).
//!
//! A Mac that went quiet, a Mac that refused to start the work, a session the
//! Mac ended with an error and a permission request nobody answered in time
//! are **server facts** the agent cannot report itself (ADR-0220 P3 (b)): its
//! process is gone, never started, or is still waiting. So the server writes one
//! System line, in the same transaction as the fact, through the one send spine
//! (`channel_seq` + message INSERT + outbox, `momo_messaging::send_message_in_tx`).
//! The relay carries it to Centrifugo; nothing here publishes directly.
//!
//! ## The line
//!
//! `props.kind = work_session_notice` (server-only: a client's own `kind` of
//! that value is dropped on the REST send, `messages.rs` `SERVER_ONLY_PROPS_KINDS`)
//! and a closed `code`:
//!
//! | code | where | body | push (judgment, `momo-push`) |
//! |---|---|---|---|
//! | `host_lost` | the session's thread | 「맥 연결이 끊겨 작업이 멈췄어요」 | the owner, `resume_offer` (resumable) — or the failure arm when the policy ended the session; nobody when no turn was running |
//! | `spawn_refused` | the thread the owner called from | 「맥에서 작업을 시작하지 못했어요 — …」 | nobody |
//! | `failed` | the session's thread | 「작업이 오류로 끝났어요」 | the owner, the failure arm |
//! | `permission_expired` | the session's thread | 「10분이 지나 이 요청은 닫혔어요」 | the owner, the failure arm |
//!
//! **No host-supplied text reaches a line.** The host's refusal label is a
//! 1–120 character string the server does not control
//! (`work_control::validated_error_label`); it is mapped onto
//! [`SpawnRefusalReason`]'s six words here and only the word is stored. An exit
//! code is a number. A permission request contributes its id, never its tool,
//! title or preview (ADR-0188 D5: the preview is the owner's to read).
//!
//! **Who hears it** is decided in one place, the push judgment: the session's
//! owner and nobody else (ADR-0188 D3, ADR-0202 — no team broadcast). The line
//! names the owner (`owner_member_id`) and the session (`session_id`); judgment
//! re-checks both against `work_session` before it selects anyone.

use momo_db::PgConnection;
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::T3Error;

/// `props.kind` of every line this module writes.
pub const PROPS_KIND: &str = "work_session_notice";
/// `props.schema`.
pub const SCHEMA: &str = "momo.work_session.notice.v1";

pub const CODE_HOST_LOST: &str = "host_lost";
pub const CODE_SPAWN_REFUSED: &str = "spawn_refused";
pub const CODE_FAILED: &str = "failed";
pub const CODE_PERMISSION_EXPIRED: &str = "permission_expired";

/// The closed `code` vocabulary, in table order.
pub const CODES: [&str; 4] = [
    CODE_HOST_LOST,
    CODE_SPAWN_REFUSED,
    CODE_FAILED,
    CODE_PERMISSION_EXPIRED,
];

pub const BODY_HOST_LOST: &str = "맥 연결이 끊겨 작업이 멈췄어요";
pub const BODY_FAILED: &str = "작업이 오류로 끝났어요";
pub const BODY_PERMISSION_EXPIRED: &str = "10분이 지나 이 요청은 닫혔어요";

/// Why the Mac did not start the work — the closed words a refusal line may
/// say. Everything the host can answer maps onto one of these; a label this
/// server has never heard of is [`SpawnRefusalReason::Other`], never echoed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnRefusalReason {
    /// 로그인 필요 — Codex or the 원격 작업 profile is not signed in.
    LoginRequired,
    /// 폴더 없음 — the folder id is unknown, unsafe or not a directory.
    FolderMissing,
    /// 한도 — the Mac already runs as many sessions as it allows.
    HostBusy,
    /// 모드 거부 — the agent is not in the host's fixed permission mode.
    ModeRefused,
    /// 설정 확인 실패 — the host could not verify its own or the project's configuration.
    ConfigUnverified,
    /// Any other refusal (a tool the host does not allow, the agent did not start,
    /// a device signature the host did not accept …).
    Other,
}

impl SpawnRefusalReason {
    pub const ALL: [SpawnRefusalReason; 6] = [
        Self::LoginRequired,
        Self::FolderMissing,
        Self::HostBusy,
        Self::ModeRefused,
        Self::ConfigUnverified,
        Self::Other,
    ];

    /// Map the host's ack label (`momo-workd` `policy::Refusal::label`) onto the
    /// closed reasons. Exact matches only: the label is never parsed for parts.
    pub fn from_host_label(label: Option<&str>) -> Self {
        match label.map(str::trim) {
            Some("codex_login_required" | "profile_login_required") => Self::LoginRequired,
            Some("workdir_unavailable" | "folder_unknown" | "folder_unsafe") => Self::FolderMissing,
            Some("host_busy") => Self::HostBusy,
            Some("permission_mode_refused") => Self::ModeRefused,
            Some(
                "codex_config_unverified"
                | "codex_home_refused"
                | "project_config_refused"
                | "profile_not_found"
                | "profile_refused",
            ) => Self::ConfigUnverified,
            _ => Self::Other,
        }
    }

    /// `props.reason`.
    pub fn code(self) -> &'static str {
        match self {
            Self::LoginRequired => "login_required",
            Self::FolderMissing => "folder_missing",
            Self::HostBusy => "host_busy",
            Self::ModeRefused => "mode_refused",
            Self::ConfigUnverified => "config_unverified",
            Self::Other => "other",
        }
    }

    /// The line's body: fixed copy, one sentence per reason.
    pub fn body(self) -> &'static str {
        match self {
            Self::LoginRequired => "맥에서 작업을 시작하지 못했어요 — 로그인이 필요해요",
            Self::FolderMissing => "맥에서 작업을 시작하지 못했어요 — 폴더를 찾지 못했어요",
            Self::HostBusy => {
                "맥에서 작업을 시작하지 못했어요 — 동시에 돌릴 수 있는 작업이 가득 찼어요"
            }
            Self::ModeRefused => "맥에서 작업을 시작하지 못했어요 — 권한 모드가 맞지 않아요",
            Self::ConfigUnverified => "맥에서 작업을 시작하지 못했어요 — 설정을 확인하지 못했어요",
            Self::Other => "맥에서 작업을 시작하지 못했어요",
        }
    }
}

/// One fact worth a line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkNotice {
    /// The host stopped answering and the sweep took the session away from it.
    /// `resumable` is false only when the member's tier policy ended the
    /// session instead of leaving it `orphaned` (`t1_only`). `was_running`: a
    /// turn was in progress; a session that had already finished its turn
    /// (`idle`) gets the line but no push (ADR-0220 P5: a Mac that sleeps with
    /// four finished sessions is one cause, not four interruptions).
    HostLost {
        session_id: Uuid,
        owner_member_id: Uuid,
        resumable: bool,
        was_running: bool,
    },
    /// The host refused a spawn control.
    SpawnRefused {
        control_id: Uuid,
        owner_member_id: Uuid,
        session_id: Option<Uuid>,
        reason: SpawnRefusalReason,
    },
    /// The host ended the session with a non-zero exit code nobody asked for.
    Failed {
        session_id: Uuid,
        owner_member_id: Uuid,
        exit_code: i32,
    },
    /// A permission request passed its deadline unanswered.
    PermissionExpired {
        session_id: Uuid,
        owner_member_id: Uuid,
        request_id: Uuid,
        request_event_id: Uuid,
    },
}

/// Fixed namespace for the line's idempotency key (`client_msg_id`).
const NOTICE_NAMESPACE: Uuid = Uuid::from_u128(0x5594_0000_0000_4000_8000_0000_0000_5594);

impl WorkNotice {
    pub fn code(&self) -> &'static str {
        match self {
            Self::HostLost { .. } => CODE_HOST_LOST,
            Self::SpawnRefused { .. } => CODE_SPAWN_REFUSED,
            Self::Failed { .. } => CODE_FAILED,
            Self::PermissionExpired { .. } => CODE_PERMISSION_EXPIRED,
        }
    }

    pub fn body(&self) -> &'static str {
        match self {
            Self::HostLost { .. } => BODY_HOST_LOST,
            Self::SpawnRefused { reason, .. } => reason.body(),
            Self::Failed { .. } => BODY_FAILED,
            Self::PermissionExpired { .. } => BODY_PERMISSION_EXPIRED,
        }
    }

    /// The line's `props`: ids, closed words and a number — nothing a host or an
    /// agent wrote.
    pub fn props(&self) -> Value {
        let mut props = json!({
            "kind": PROPS_KIND,
            "schema": SCHEMA,
            "code": self.code(),
        });
        let object = props.as_object_mut().expect("a json object");
        match self {
            Self::HostLost {
                session_id,
                owner_member_id,
                resumable,
                was_running,
            } => {
                object.insert("session_id".into(), json!(session_id.to_string()));
                object.insert("owner_member_id".into(), json!(owner_member_id.to_string()));
                object.insert("resumable".into(), json!(resumable));
                object.insert("was_running".into(), json!(was_running));
            }
            Self::SpawnRefused {
                control_id,
                owner_member_id,
                session_id,
                reason,
            } => {
                object.insert("control_id".into(), json!(control_id.to_string()));
                object.insert("owner_member_id".into(), json!(owner_member_id.to_string()));
                if let Some(session_id) = session_id {
                    object.insert("session_id".into(), json!(session_id.to_string()));
                }
                object.insert("reason".into(), json!(reason.code()));
            }
            Self::Failed {
                session_id,
                owner_member_id,
                exit_code,
            } => {
                object.insert("session_id".into(), json!(session_id.to_string()));
                object.insert("owner_member_id".into(), json!(owner_member_id.to_string()));
                object.insert("exit_code".into(), json!(exit_code));
            }
            Self::PermissionExpired {
                session_id,
                owner_member_id,
                request_event_id,
                ..
            } => {
                object.insert("session_id".into(), json!(session_id.to_string()));
                object.insert("owner_member_id".into(), json!(owner_member_id.to_string()));
                object.insert(
                    "request_event_id".into(),
                    json!(request_event_id.to_string()),
                );
            }
        }
        props
    }

    /// The idempotency key: one line per fact. A host-lost line is one per
    /// session (a session is orphaned at most once: a resume retires it), a
    /// refusal one per control, a failure one per session (it ends once), an
    /// expiry one per request.
    pub fn client_msg_id(&self) -> Uuid {
        let name = match self {
            Self::HostLost { session_id, .. } => format!("host_lost:{session_id}"),
            Self::SpawnRefused { control_id, .. } => format!("spawn_refused:{control_id}"),
            Self::Failed { session_id, .. } => format!("failed:{session_id}"),
            Self::PermissionExpired { request_id, .. } => {
                format!("permission_expired:{request_id}")
            }
        };
        Uuid::new_v5(&NOTICE_NAMESPACE, name.as_bytes())
    }
}

/// Where a line goes and who speaks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoticeSite {
    pub channel_id: Uuid,
    /// The thread; `None` only for a refusal of a spawn that named no thread
    /// and no message (the line then stands in the room it was called from).
    pub root_id: Option<Uuid>,
    /// The session's voice (`work_session.persona_member_id`, else its owner) —
    /// the same author the session's other lines have.
    pub author_member_id: Uuid,
}

/// A session's thread and voice, plus the owner, read inside the caller's
/// tenant transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionNoticeSite {
    pub site: NoticeSite,
    pub owner_member_id: Uuid,
    pub status_running: bool,
}

/// The thread of one session (its card's root) and the voice its lines use.
pub async fn session_notice_site_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<SessionNoticeSite>, T3Error> {
    let row = sqlx::query(
        "SELECT channel_id, root_message_id, member_id, \
                COALESCE(persona_member_id, member_id) AS author_member_id, \
                status = 'running' AS status_running \
           FROM work_session \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(SessionNoticeSite {
        site: NoticeSite {
            channel_id: row.try_get("channel_id")?,
            root_id: Some(row.try_get("root_message_id")?),
            author_member_id: row.try_get("author_member_id")?,
        },
        owner_member_id: row.try_get("member_id")?,
        status_running: row.try_get("status_running")?,
    }))
}

/// Write one notice line. Returns `false` when the same fact already has its
/// line (a retried write).
pub async fn post_work_notice_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    site: NoticeSite,
    notice: &WorkNotice,
) -> Result<bool, T3Error> {
    let sent = send_message_in_tx(
        conn,
        workspace_id,
        NewMessage {
            channel_id: site.channel_id,
            author_member_id: site.author_member_id,
            message_type: MessageType::System,
            body: Some(notice.body().to_string()),
            props: notice.props(),
            root_id: site.root_id,
            reply_to_id: None,
            client_msg_id: Some(notice.client_msg_id()),
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;
    Ok(!sent.deduped)
}

/// Write one notice in a session's thread, in its voice. `Ok(false)` when the
/// session row is gone or the line already exists.
pub async fn post_session_notice_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    notice: &WorkNotice,
) -> Result<bool, T3Error> {
    let Some(found) = session_notice_site_in_tx(conn, workspace_id, session_id).await? else {
        return Ok(false);
    };
    post_work_notice_in_tx(conn, workspace_id, found.site, notice).await
}

/// Did anyone ask this session to stop (a `kill` control that reached, or is on its
/// way to, the host)? A host ends a killed session with the signal's exit code
/// (`momo-workd` `terminate`: SIGTERM → 143), which is not a failure: the person
/// who pressed 멈추기 is not told their own stop failed.
pub async fn kill_requested_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<bool, T3Error> {
    let requested: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM work_control \
            WHERE workspace_id = $1 AND session_id = $2 AND kind = $3 \
              AND status IN ($4, $5, $6) \
         )",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(crate::work_control::KIND_KILL)
    .bind(crate::work_control::STATUS_APPROVED)
    .bind(crate::work_control::STATUS_DISPATCHED)
    .bind(crate::work_control::STATUS_ACKED)
    .fetch_one(&mut *conn)
    .await?;
    Ok(requested)
}

/// The exit code `momo-workd` reports when **it** stopped the agent: its
/// `terminate` sends SIGTERM (128 + 15). It does so for a kill control, for the
/// desktop app quitting (`SessionTable::shutdown`), for a spawned session whose
/// ack the server refused, and for a mode escape (which writes its own status
/// line). None of those is the agent failing, and the app quitting would
/// otherwise read as a failure of every open session. An agent that crashes on
/// its own exits with its own code or another signal (SIGKILL 137 for an OOM
/// kill stays a failure).
pub const HOST_STOP_EXIT_CODE: i32 = 143;

/// Is this end a failure the owner should hear about (#5594)? Only the host says
/// so — a person who ended their own session knows — with a non-zero exit code
/// that is not the host's own stop ([`HOST_STOP_EXIT_CODE`]), and only when
/// nobody asked the session to stop.
pub fn is_failed_end(host_signed: bool, exit_code: Option<i32>, kill_requested: bool) -> bool {
    host_signed
        && matches!(exit_code, Some(code) if code != 0 && code != HOST_STOP_EXIT_CODE)
        && !kill_requested
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> (Uuid, Uuid) {
        (Uuid::from_u128(1), Uuid::from_u128(2))
    }

    #[test]
    fn every_host_label_maps_onto_a_closed_reason_and_nothing_is_echoed() {
        let cases = [
            ("codex_login_required", SpawnRefusalReason::LoginRequired),
            ("profile_login_required", SpawnRefusalReason::LoginRequired),
            ("workdir_unavailable", SpawnRefusalReason::FolderMissing),
            ("folder_unknown", SpawnRefusalReason::FolderMissing),
            ("folder_unsafe", SpawnRefusalReason::FolderMissing),
            ("host_busy", SpawnRefusalReason::HostBusy),
            ("permission_mode_refused", SpawnRefusalReason::ModeRefused),
            (
                "codex_config_unverified",
                SpawnRefusalReason::ConfigUnverified,
            ),
            ("codex_home_refused", SpawnRefusalReason::ConfigUnverified),
            (
                "project_config_refused",
                SpawnRefusalReason::ConfigUnverified,
            ),
            ("profile_not_found", SpawnRefusalReason::ConfigUnverified),
            ("profile_refused", SpawnRefusalReason::ConfigUnverified),
            ("agent_start_failed", SpawnRefusalReason::Other),
            ("device_signature_invalid", SpawnRefusalReason::Other),
            ("host_busy; rm -rf ~ <script>", SpawnRefusalReason::Other),
        ];
        for (label, expected) in cases {
            assert_eq!(
                SpawnRefusalReason::from_host_label(Some(label)),
                expected,
                "{label}"
            );
        }
        assert_eq!(
            SpawnRefusalReason::from_host_label(None),
            SpawnRefusalReason::Other
        );
        let (owner, control) = ids();
        let raw = "host_busy; rm -rf ~ <script>";
        let notice = WorkNotice::SpawnRefused {
            control_id: control,
            owner_member_id: owner,
            session_id: None,
            reason: SpawnRefusalReason::from_host_label(Some(raw)),
        };
        assert!(!notice.props().to_string().contains("rm -rf"));
        assert!(!notice.body().contains("rm -rf"));
    }

    #[test]
    fn the_props_are_ids_closed_words_and_a_number() {
        let (owner, session) = ids();
        for notice in [
            WorkNotice::HostLost {
                session_id: session,
                owner_member_id: owner,
                resumable: true,
                was_running: true,
            },
            WorkNotice::Failed {
                session_id: session,
                owner_member_id: owner,
                exit_code: 1,
            },
            WorkNotice::PermissionExpired {
                session_id: session,
                owner_member_id: owner,
                request_id: Uuid::from_u128(3),
                request_event_id: Uuid::from_u128(4),
            },
            WorkNotice::SpawnRefused {
                control_id: Uuid::from_u128(5),
                owner_member_id: owner,
                session_id: None,
                reason: SpawnRefusalReason::HostBusy,
            },
        ] {
            let props = notice.props();
            assert_eq!(props["kind"], PROPS_KIND);
            assert_eq!(props["schema"], SCHEMA);
            assert!(CODES.contains(&props["code"].as_str().unwrap()));
            assert_eq!(props["owner_member_id"], owner.to_string());
        }
    }

    #[test]
    fn one_fact_one_key() {
        let (owner, session) = ids();
        let lost = WorkNotice::HostLost {
            session_id: session,
            owner_member_id: owner,
            resumable: true,
            was_running: true,
        };
        let failed = WorkNotice::Failed {
            session_id: session,
            owner_member_id: owner,
            exit_code: 1,
        };
        assert_eq!(lost.client_msg_id(), lost.clone().client_msg_id());
        assert_ne!(lost.client_msg_id(), failed.client_msg_id());
        assert_ne!(lost.client_msg_id(), session);
    }

    #[test]
    fn only_a_host_reported_non_zero_end_nobody_asked_for_is_a_failure() {
        assert!(is_failed_end(true, Some(1), false));
        assert!(
            is_failed_end(true, Some(137), false),
            "an OOM kill is a failure"
        );
        assert!(
            !is_failed_end(true, Some(137), true),
            "a kill is not a failure"
        );
        assert!(
            !is_failed_end(true, Some(HOST_STOP_EXIT_CODE), false),
            "the host stopped it (app quit, kill, cleanup)"
        );
        assert!(!is_failed_end(true, Some(0), false));
        assert!(!is_failed_end(true, None, false));
        assert!(!is_failed_end(false, Some(1), false), "the owner ended it");
    }

    #[test]
    fn every_reason_has_its_own_word_and_sentence() {
        let codes: std::collections::BTreeSet<_> =
            SpawnRefusalReason::ALL.iter().map(|r| r.code()).collect();
        let bodies: std::collections::BTreeSet<_> =
            SpawnRefusalReason::ALL.iter().map(|r| r.body()).collect();
        assert_eq!(codes.len(), SpawnRefusalReason::ALL.len());
        assert_eq!(bodies.len(), SpawnRefusalReason::ALL.len());
    }
}
