import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useSession } from "@/app/session";
import { useIsMobileShell } from "@/app/shellNav";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import {
  EmptyInvite,
  InlineBanner,
  Skeleton,
} from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { Button } from "@/design/ui/button";
import { FilterTabs } from "@/features/common/FilterTabs";
import { reminderIsOverdue } from "@momo/core/features/reminders/model";
import { RemindersPanel } from "@/features/reminders/RemindersPanel";
import { useReminders } from "@/features/reminders/useReminders";
import { LocalPaneInbox } from "./LocalPaneInbox";
import { isDesktop } from "@/lib/tauri";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import { SurfaceUnavailableSection } from "@/features/capabilities/SurfaceUnavailable";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import { decisionNote, type DecisionNote } from "./approvalsPanel";
import {
  filterMailbox,
  mailboxCounts,
  type MailboxEntry,
  type MailboxFilter,
} from "@momo/core/features/inbox/mailbox";
import { relativeLabel } from "@momo/core/features/inbox/model";
import { useFeedContext, useInvalidateApprovals, useMentionCount, useUnreadMentionChannels, useMarkRead } from "./useInbox";
import { useMailbox, useMailboxReadActions } from "./useMailbox";
import { useNeedsMe } from "./useNeedsMe";
import { MailboxList } from "./MailboxList";
import { InboxDetail } from "./InboxDetail";
import {
  mailboxTabs,
  mailboxTabsSpec,
  parseWebMailboxFilter,
  webMailboxPanelId,
  webMailboxTabId,
} from "./mailboxTab";

// =============================================================================
// 인박스 (#3663). 메일함·알림함처럼 **나와 관련된 것의 목록**과 오른쪽의 **맥락 패널**.
//
// 한 줄은 「누가 · 어디서 · 무슨 일로 나를 찾았는가」다: DM, 나를 부른 멘션, 내 글에
// 달린 답글, 내가 허락해야 하는 일. 줄을 고르면 오른쪽에 그 대화와 답장 입력(처리할
// 일이면 결정 버튼)이 열린다. 목록의 원천과 한계는 core `mailbox.ts`와
// `useMailbox.ts` 머리말에 있다 — 서버에 인박스 라우트는 아직 없고, 여기 모든 줄은
// 이미 있는 읽기 계약에서 온다. 클라이언트가 세거나 지어낸 것은 없다.
//
// 「조용한 게 정상」은 그대로다: 알림은 꺼 두는 것이 아니라 애초에 보내지 않는다.
// 이 표면은 그 급진적 감축을 안전하게 만드는 그물이다.
//
// ## 승인함이기도 하다 (goal W-AP1)
//
// 결정 컨트롤은 타임라인 카드와 공유하는 `ApprovalActions` 한 벌이다. 세 번째
// 표면을 세우면 세 번째 멱등 정책과 세 번째 409 문구가 생긴다. 이 파일은 그
// 컨트롤을 패널 안에 놓고, 결정의 답(영수증)을 한 줄로 말하는 일만 한다.
// =============================================================================

const EMPTY_COPY: Record<MailboxFilter, { headline: string; detail: string }> = {
  all: {
    headline: "인박스가 비어 있습니다. 조용한 게 정상입니다.",
    detail:
      "DM, 나를 부른 멘션, 내 글의 새 답글, 허락이 필요한 일이 생기면 여기 모입니다.",
  },
  unread: {
    headline: "안 읽은 항목이 없습니다. 조용한 게 정상입니다.",
    detail: "읽은 DM은 「전체」에서 계속 볼 수 있습니다.",
  },
  mention: {
    headline: "읽지 않은 멘션이 없습니다. 조용한 게 정상입니다.",
    detail: "누군가 회원님을 부르면 여기 모입니다. 읽은 멘션은 목록에 남지 않습니다.",
  },
  dm: {
    headline: "주고받은 DM이 없습니다.",
    detail: "사람이나 에이전트와 DM을 시작하면 여기 대화가 쌓입니다.",
  },
  thread: {
    headline: "새 답글이 달린 내 글이 없습니다.",
    detail: "내가 쓴 글에 답글이 달리면 여기 모입니다.",
  },
  task: {
    headline: "지금 처리할 일이 없습니다. 조용한 게 정상입니다.",
    detail: "에이전트가 사람의 허가를 기다릴 때만 여기 쌓입니다.",
  },
};

/**
 * 결정 대기가 비었는데 이 기기의 칸이 회원님을 기다릴 때(#2776, design-review H1).
 * 「처리할 일이 없습니다」는 위의 「응답 필요」 줄과 모순이다.
 */
const EMPTY_WITH_LOCAL_WAITING = {
  headline: "에이전트 승인 요청은 없습니다.",
  detail: "위의 「이 기기의 칸」이 회원님을 기다립니다. 누르면 그 칸으로 갑니다.",
};

export function InboxRoute() {
  const { session } = useSession();
  const needs = useNeedsMe();
  const localWaiting = needs.panes;
  const [params, setParams] = useSearchParams();
  const isMobile = useIsMobileShell();
  const tasksProvided = isSurfaceProvided("approvals");
  const tabs = useMemo(() => mailboxTabs(tasksProvided), [tasksProvided]);
  const filter = parseWebMailboxFilter(params.get("filter"), tabs);

  const mailbox = useMailbox();
  const context = useFeedContext();
  const mentionCount = useMentionCount();
  const reminders = useReminders(session.member.workspaceId);
  const reminderDueCount = (reminders.data?.reminders ?? []).filter((row) =>
    reminderIsOverdue(row, Date.now())
  ).length;

  const markMentionsRead = useMarkRead();
  const unreadChannels = useUnreadMentionChannels();
  const invalidateApprovals = useInvalidateApprovals();
  const { markRead, markUnread } = useMailboxReadActions();
  const offline = useOffline();
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [note, setNote] = useState<DecisionNote | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [readBusy, setReadBusy] = useState(false);

  // 고른 항목은 읽음 처리로 서버 투영에서 사라질 수 있다(읽은 멘션). 그래도 패널과
  // 목록의 그 줄은 사용자가 다른 줄을 고를 때까지 남는다 — 메일함이 읽은 편지를
  // 손 밑에서 치우지 않는 것과 같다. 스냅샷은 사라진 줄만 대신한다.
  const [selected, setSelected] = useState<MailboxEntry | null>(null);

  const live = useMemo(
    () =>
      selected === null
        ? null
        : (mailbox.entries.find((entry) => entry.key === selected.key) ?? null),
    [mailbox.entries, selected]
  );
  const active: MailboxEntry | null = live ?? selected;

  const counts = useMemo(() => mailboxCounts(mailbox.entries), [mailbox.entries]);

  const shown = useMemo(() => {
    if (filter === "reminders") return [];
    const filtered = filterMailbox(mailbox.entries, filter);
    if (selected === null || filtered.some((e) => e.key === selected.key)) {
      return filtered;
    }
    // 고른 줄이 필터 밖으로 빠졌다(읽음으로 바뀐 줄이 「안 읽음」에서 빠지는 식).
    // 사용자가 보고 있는 줄이므로 그 자리에 남긴다.
    return [...filtered, active ?? selected].sort((a, b) =>
      a.kind === "task" && b.kind !== "task"
        ? -1
        : b.kind === "task" && a.kind !== "task"
          ? 1
          : b.atMs - a.atMs
    );
  }, [mailbox.entries, filter, selected, active]);

  useEffect(() => {
    setNote(null);
  }, [filter]);

  const select = useCallback(
    (entry: MailboxEntry) => {
      setReadError(null);
      setSelected(entry);
      // 열어서 읽는 것이 읽음이다. 처리할 일은 결정이 닫는다.
      if (entry.unread && entry.kind !== "task" && !offline) {
        setSelected({ ...entry, unread: false, unreadCount: 0 });
        void markRead(entry).catch(() => {
          // 서버가 거절하면 되돌려 사실대로 안 읽음으로 둔다.
          setSelected(entry);
          setReadError("읽음으로 표시하지 못했습니다. 잠시 뒤에 다시 시도하세요.");
        });
      }
    },
    [markRead, offline]
  );

  const toggleRead = useCallback(
    async (entry: MailboxEntry) => {
      setReadBusy(true);
      setReadError(null);
      try {
        if (entry.unread) {
          await markRead(entry);
          setSelected({ ...entry, unread: false, unreadCount: 0 });
        } else {
          await markUnread(entry);
          setSelected({ ...entry, unread: true });
        }
      } catch {
        setReadError("읽음 상태를 바꾸지 못했습니다. 잠시 뒤에 다시 시도하세요.");
      } finally {
        setReadBusy(false);
      }
    },
    [markRead, markUnread]
  );

  const onDecided = useCallback(
    (outcome: DecisionOutcome) => {
      setNote(decisionNote(outcome));
      invalidateApprovals();
    },
    [invalidateApprovals]
  );

  const markAllRead = useCallback(() => {
    setConfirmingAll(false);
    for (const channel of unreadChannels) {
      void markMentionsRead(channel.channelId, channel.seq);
    }
  }, [unreadChannels, markMentionsRead]);

  // 옛 「에이전트」 탭 딥링크는 활동으로 보낸다(#3337).
  if (params.get("filter") === "agents") {
    return <Navigate to="/activity" replace />;
  }

  const tabCounts: Partial<Record<(typeof tabs)[number], number>> = {
    all: counts.all,
    unread: counts.unread,
    mention: counts.mention,
    dm: counts.dm,
    thread: counts.thread,
    task: needs.approvals + needs.panes,
    reminders: reminderDueCount,
  };

  const showDetail = active !== null && filter !== "reminders";
  const listHidden = isMobile && showDetail;

  const state =
    mailbox.isLoading && mailbox.entries.length === 0
      ? "loading"
      : mailbox.error && mailbox.entries.length === 0
        ? "error"
        : shown.length === 0
          ? "empty"
          : "list";

  const emptyCopy =
    filter === "task" && localWaiting > 0
      ? EMPTY_WITH_LOCAL_WAITING
      : EMPTY_COPY[filter === "reminders" ? "all" : filter];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="inbox-route">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarDrawerToggle />
          <h1 className="text-body font-semibold">인박스</h1>
          {/* 헤더 수 = 「나에게 필요한 일」(레일 배지와 같은 훅). 0이면 그리지 않는다. */}
          {needs.total > 0 && (
            <span
              data-testid="inbox-needs-me-count"
              aria-label={`나에게 필요한 일 ${needs.total}개`}
              className="sidebar-badge bg-signal text-on-signal"
            >
              {needs.total > 99 ? "99+" : needs.total}
            </span>
          )}
        </div>
        <FilterTabs
          spec={mailboxTabsSpec(tabs)}
          value={filter}
          onChange={(next) => {
            // 필터를 바꾸면 고른 줄을 놓는다: 다른 종류의 줄이 새 필터의 목록과 패널에
            // 남아 있으면 「DM만」이 DM만이 아니게 된다.
            setSelected(null);
            setParams({ filter: next }, { replace: true });
          }}
          counts={tabCounts}
        />
      </header>

      {isDesktop() ? <LocalPaneInbox /> : null}

      {note && (
        <InlineBanner
          tone={note.tone === "error" ? "error" : "neutral"}
          message={note.text}
          actionLabel="닫기"
          onAction={() => setNote(null)}
          testId="inbox-decision-note"
        />
      )}

      {readError && (
        <InlineBanner
          tone="error"
          message={readError}
          actionLabel="닫기"
          onAction={() => setReadError(null)}
          testId="inbox-read-error"
        />
      )}

      {offline && (
        <InlineBanner
          tone="neutral"
          message={
            (filter === "reminders" ? reminders.dataUpdatedAt : mailbox.updatedAtMs) > 0
              ? `오프라인, 마지막 동기화 ${relativeLabel(
                  filter === "reminders" ? reminders.dataUpdatedAt : mailbox.updatedAtMs,
                  Date.now()
                )}. 아래는 그때의 상태입니다.`
              : "오프라인. 아직 이 목록을 한 번도 받지 못했습니다."
          }
          testId="inbox-offline"
        />
      )}

      {filter === "reminders" ? (
        <div
          role="tabpanel"
          id={webMailboxPanelId(filter)}
          aria-labelledby={webMailboxTabId(filter)}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <RemindersPanel />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!listHidden && (
            <div
              role="tabpanel"
              id={webMailboxPanelId(filter)}
              aria-labelledby={webMailboxTabId(filter)}
              data-testid="inbox-list-pane"
              className={
                isMobile
                  ? "min-h-0 flex-1 overflow-y-auto"
                  : "min-h-0 w-[22rem] shrink-0 overflow-y-auto border-r border-line"
              }
            >
              {state === "error" ? (
                <InlineBanner
                  message="인박스를 불러오지 못했습니다."
                  actionLabel="다시 시도"
                  onAction={mailbox.refetch}
                  testId="inbox-error"
                />
              ) : filter === "task" && mailbox.tasksAbsent ? (
                <SurfaceUnavailableSection
                  surface="approvals"
                  testId="inbox-unavailable"
                />
              ) : (
                <Skeleton ready={state !== "loading"} rows={4} className="p-4">
                  {state === "empty" ? (
                    <EmptyInvite
                      headline={emptyCopy.headline}
                      detail={emptyCopy.detail}
                      testId="inbox-empty"
                    />
                  ) : (
                    <>
                      <MailboxList
                        entries={shown}
                        selectedKey={active?.key ?? null}
                        onSelect={select}
                        directory={context.directory}
                      />
                      {mailbox.capped && (
                        <p
                          className="px-4 py-3 text-meta text-ink-muted"
                          data-testid="inbox-capped"
                        >
                          채널이 많아 일부만 불러왔습니다. 나머지는 채널에서 확인하세요.
                        </p>
                      )}
                    </>
                  )}
                </Skeleton>
              )}
            </div>
          )}
          {showDetail && active ? (
            <InboxDetail
              key={active.key}
              entry={active}
              directory={context.directory}
              offline={offline}
              onBack={isMobile ? () => setSelected(null) : undefined}
              onToggleRead={(entry) => void toggleRead(entry)}
              onDecided={onDecided}
              readBusy={readBusy}
            />
          ) : !isMobile && state === "list" ? (
            <div
              className="flex min-w-0 flex-1 items-center justify-center px-6"
              data-testid="inbox-detail-empty"
            >
              <p className="max-w-sm break-keep text-center text-body text-ink-muted">
                왼쪽에서 항목을 고르면 그 대화와 답장 입력이 여기에 열립니다.
                읽음 표시는 같은 채널의 앞선 메시지까지 함께 읽음으로 바꿉니다.
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* 에이전트가 한 일 전체는 활동에서 본다(#3337). 인박스는 나에게 필요한 것만 담는다. */}
      <Link
        to="/activity"
        data-testid="inbox-activity-link"
        className="press mx-4 mb-2 mt-2 flex h-control items-center justify-between rounded-lg bg-surface-hover px-3 text-body text-ink-muted hover:bg-surface-pressed hover:text-ink focus-visible:focus-ring"
      >
        <span>에이전트가 한 일 전체는 활동에서 봐요</span>
        <span className="flex items-center gap-1 text-ink">
          활동 열기
          <ChevronRight className="size-4" aria-hidden="true" />
        </span>
      </Link>

      <footer className="safe-area-bottom flex flex-wrap items-center gap-3 border-t border-line px-4 py-2">
        {confirmingAll ? (
          <>
            <span className="text-meta text-ink">
              멘션 {mentionCount}개를 읽음으로 표시합니다. 해당 채널의 다른 안 읽은 메시지도 함께 읽음 처리되며, 되돌릴 수 없습니다.
            </span>
            <Button size="sm" onClick={markAllRead} data-testid="mark-all-confirm">
              읽음으로 표시
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingAll(false)}
            >
              취소
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={mentionCount === 0}
            onClick={() => setConfirmingAll(true)}
            data-testid="mark-all-read"
          >
            멘션 모두 읽음 처리
          </Button>
        )}
        {/* Land on the 알림 규칙 panel, not the settings root: SettingsRoute reads
            ?section= (default 프로필), so a bare /settings dropped this link on the
            first panel instead of the rules it names (ADR-0124 증보 1). */}
        <Link
          to="/settings?section=notifications"
          className="rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:focus-ring"
          data-testid="inbox-notification-rules"
        >
          알림 규칙 설정
        </Link>
      </footer>
    </div>
  );
}
