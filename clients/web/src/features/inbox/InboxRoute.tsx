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
  mailboxFilterLabel,
  parseMailboxFilter,
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
// `useMailbox.ts` 머리말에 있다 — 서버 인박스 투영(ADR-0199)이 정본이고, 투영이 없는
// 구 서버에서는 이미 있는 읽기 계약을 모아 보여 준다. 클라이언트가 세거나 지어낸 것은 없다.
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

type EmptyCopy = { headline: string; detail: string };

/** 서버 투영은 읽은 것을 30일 남기고, 구 서버는 남기지 않는다. 빈 화면이 그 사실을 말한다. */
function emptyCopyFor(
  filter: MailboxFilter,
  source: "server" | "composed" | "probing"
): EmptyCopy {
  const server = source === "server";
  switch (filter) {
    case "all":
      return {
        headline: "인박스가 비어 있어요. 조용한 게 정상이에요.",
        detail:
          "DM, 나를 부른 멘션, 내 글에 단 답글, 허락이 필요한 일이 생기면 여기 모여요.",
      };
    case "unread":
      return {
        headline: "안 읽은 항목이 없어요. 조용한 게 정상이에요.",
        detail: server
          ? "읽은 항목은 30일 동안 「전체」에서 볼 수 있어요."
          : "읽은 DM은 「전체」에서 계속 볼 수 있어요.",
      };
    case "mention":
      return server
        ? {
            headline: "멘션이 없어요. 조용한 게 정상이에요.",
            detail: "누군가 나를 부르면 여기 모여요. 읽은 멘션도 30일 동안 남아요.",
          }
        : {
            headline: "읽지 않은 멘션이 없어요. 조용한 게 정상이에요.",
            detail:
              "누군가 나를 부르면 여기 모여요. 이 서버는 읽은 멘션을 목록에 남기지 않아요.",
          };
    case "reply":
      return {
        headline: "내 글에 달린 답글이 없어요.",
        detail:
          "누군가 내 글에 답하거나 인용하면 여기 모여요. 읽은 답글도 30일 동안 남아요.",
      };
    case "dm":
      return {
        headline: "주고받은 DM이 없어요.",
        detail: "사람이나 에이전트와 DM을 시작하면 여기 대화가 쌓여요.",
      };
    case "thread":
      // 두 원천의 「스레드」는 약속이 다르다: 서버는 내가 참여한 스레드의 새 글, 구 서버는
      // 내가 쓴 글에 달린 새 답글만 안다. 빈 화면은 그 원천이 말할 수 있는 것만 말한다.
      return server
        ? {
            headline: "새 답글이 달린 스레드가 없어요.",
            detail: "내가 참여한 스레드에 답글이 달리면 여기 모여요.",
          }
        : {
            headline: "새 답글이 달린 내 글이 없어요.",
            detail: "내가 쓴 글에 답글이 달리면 여기 모여요.",
          };
    case "task":
      return {
        headline: "지금 처리할 일이 없어요. 조용한 게 정상이에요.",
        detail: "에이전트가 사람의 허가를 기다릴 때만 여기 쌓여요.",
      };
  }
}

/**
 * 결정 대기가 비었는데 이 기기의 칸이 내 결정을 기다릴 때(#2776, design-review H1).
 * 「처리할 일이 없습니다」는 위의 「응답 필요」 줄과 모순이다.
 */
const EMPTY_WITH_LOCAL_WAITING = {
  headline: "에이전트 승인 요청은 없어요.",
  detail: "위의 「이 기기의 칸」이 내 결정을 기다려요. 누르면 그 칸으로 가요.",
};

export function InboxRoute() {
  const { session } = useSession();
  const needs = useNeedsMe();
  const localWaiting = needs.panes;
  const [params, setParams] = useSearchParams();
  const isMobile = useIsMobileShell();
  const tasksProvided = isSurfaceProvided("approvals");
  // 「답글」은 서버 투영에만 있는 종류다. 구 서버에서는 항상 빈 탭이 되므로 세우지 않는다.
  const rawFilter = params.get("filter");
  const mailbox = useMailbox(
    rawFilter === "reminders" ? "reminders" : parseMailboxFilter(rawFilter)
  );
  const isServer = mailbox.source === "server";
  const tabs = useMemo(
    () => mailboxTabs(tasksProvided, isServer),
    [tasksProvided, isServer]
  );
  const filter = parseWebMailboxFilter(rawFilter, tabs);
  const context = useFeedContext();
  const mentionCount = useMentionCount();
  const reminders = useReminders(session.member.workspaceId);
  const reminderDueCount = (reminders.data?.reminders ?? []).filter((row) =>
    reminderIsOverdue(row, Date.now())
  ).length;

  const markMentionsRead = useMarkRead();
  const unreadChannels = useUnreadMentionChannels();
  const invalidateApprovals = useInvalidateApprovals();
  const { markRead, markUnread, markAllRead: markAllServerRead } =
    useMailboxReadActions();
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
          setReadError("읽음으로 표시하지 못했어요. 잠시 뒤에 다시 시도하세요.");
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
        setReadError("읽음 상태를 바꾸지 못했어요. 잠시 뒤에 다시 시도하세요.");
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
    if (isServer) {
      // 항목만 읽음이 된다. 채널의 읽음 위치는 움직이지 않는다.
      setReadError(null);
      void markAllServerRead(filter).catch(() => {
        setReadError("모두 읽음으로 표시하지 못했어요. 잠시 뒤에 다시 시도하세요.");
      });
      return;
    }
    for (const channel of unreadChannels) {
      void markMentionsRead(channel.channelId, channel.seq);
    }
  }, [isServer, filter, markAllServerRead, unreadChannels, markMentionsRead]);

  // 옛 「에이전트」 탭 딥링크는 활동으로 보낸다(#3337).
  if (params.get("filter") === "agents") {
    return <Navigate to="/activity" replace />;
  }

  // 서버 경로는 읽어 온 쪽만 알 수 있어서 종류별 수를 지어내지 않는다. 서버가 센
  // 전체 안 읽음 수만 「전체」·「안 읽음」에 쓴다.
  const tabCounts: Partial<Record<(typeof tabs)[number], number>> = isServer
    ? {
        all: mailbox.serverUnreadCount ?? undefined,
        unread: mailbox.serverUnreadCount ?? undefined,
        task: needs.approvals + needs.panes,
        reminders: reminderDueCount,
      }
    : {
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

  // 로딩과 오류는 **이 탭에 보일 줄**이 없을 때만 말한다. 전체 항목 수(`entries`)로 가르면 투영에 줄이
  // 있는 순간 「처리할 일」 탭이 원장의 실패·로딩을 가리고 「지금 처리할 일이 없어요」라고 말한다 —
  // 그 탭의 내용은 승인 원장 하나다(#5092).
  const state =
    mailbox.isLoading && shown.length === 0
      ? "loading"
      : mailbox.error && shown.length === 0
        ? "error"
        : shown.length === 0
          ? "empty"
          : "list";

  const emptyCopy =
    filter === "task" && localWaiting > 0
      ? EMPTY_WITH_LOCAL_WAITING
      : emptyCopyFor(filter === "reminders" ? "all" : filter, mailbox.source);
  const scopeLabel = mailboxFilterLabel(filter === "reminders" ? "all" : filter);
  const serverUnreadHere = shown.some((e) => e.itemId !== undefined && e.unread);
  const canMarkAllServer =
    filter !== "task" &&
    filter !== "reminders" &&
    (serverUnreadHere ||
      ((filter === "all" || filter === "unread") &&
        (mailbox.serverUnreadCount ?? 0) > 0));

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
                )}. 아래는 그때의 상태예요.`
              : "오프라인이에요. 아직 이 목록을 한 번도 받지 못했어요."
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
                  message="인박스를 불러오지 못했어요."
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
                          채널이 많아 일부만 불러왔어요. 나머지는 채널에서 확인하세요.
                        </p>
                      )}
                      {isServer && mailbox.hasMore && filter !== "task" && (
                        <div className="px-4 py-3">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={mailbox.fetchMore}
                            disabled={mailbox.isFetchingMore}
                            aria-busy={mailbox.isFetchingMore}
                            data-testid="inbox-load-more"
                          >
                            {mailbox.moreError ? "다시 시도" : "더 보기"}
                          </Button>
                          {mailbox.moreError && (
                            <p
                              className="pt-2 text-meta text-ink-muted"
                              role="status"
                              data-testid="inbox-more-error"
                            >
                              다음 항목을 불러오지 못했어요. 이미 받은 항목은 그대로예요.
                            </p>
                          )}
                        </div>
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
                {isServer
                  ? "왼쪽에서 항목을 고르면 그 대화와 답장 입력이 여기에 열려요. 항목을 열면 그 항목만 읽음이 되고, 채널의 읽음 위치는 그대로예요."
                  : "왼쪽에서 항목을 고르면 그 대화와 답장 입력이 여기에 열려요. 읽음 표시는 같은 채널의 앞선 메시지까지 함께 읽음으로 바꿔요."}
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
        {isServer ? (
          confirmingAll ? (
            <>
              <span className="text-meta text-ink" role="status" data-testid="mark-all-text">
                「{scopeLabel}」 탭의 안 읽은 항목을 모두 읽음으로 표시해요. 채널의 읽음 위치는 바뀌지 않아요.
              </span>
              {/* 누른 버튼이 확인 줄로 바뀌므로 포커스를 확인 버튼으로 옮긴다. */}
              <Button
                size="sm"
                onClick={markAllRead}
                autoFocus
                data-testid="mark-all-confirm"
              >
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
          ) : filter === "task" || filter === "reminders" ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={!canMarkAllServer}
              onClick={() => setConfirmingAll(true)}
              data-testid="mark-all-read"
            >
              모두 읽음 처리
            </Button>
          )
        ) : confirmingAll ? (
          <>
            <span className="text-meta text-ink">
              멘션 {mentionCount}개를 읽음으로 표시해요. 해당 채널의 다른 안 읽은 메시지도 함께 읽음 처리되며, 되돌릴 수 없어요.
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
