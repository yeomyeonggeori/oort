import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { LoadFailureBox } from "@/features/common/LoadFailureBox";
import { loadCauseOf, loadFailureSentence } from "@/features/common/loadFailure";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
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
import { decisionNote, receiptSaidInPane, settledStatusLine, type DecisionNote } from "./approvalsPanel";
import { useSettledApproval } from "@/features/timeline/settledApprovals";
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
import { BlockedListLine } from "@/features/common/BlockedReason";

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

// 목록 칸 폭 22rem(352). 아래 목록 칸의 `w-[22rem]`과 같은 값이다.
const INBOX_LIST_PX = 352;
// 상세가 두 칸일 때 지켜야 하는 폭 = 256(16rem). 스레드 항목의 입력 카드가 도구 줄(첨부·멘션·이모지·보내기·「예약해서
// 보내기」)을 카드 안에 담고, 메시지 이름이 한 줄로 서는 가장 좁은 칸이 252쯤이라(검수 잰 값) 리듬 배수(8)로 올렸다.
// 이 폭에 맞는 기존 토큰이 없다: `--spacing-pane-sm`(192)은 「목록으로 읽히는 폭」이고 입력 카드는 그보다 넓다.
// 이 자리의 폭이 목록 + 이 값에 못 미치면 폰 폭과 같은 한 칸(목록 ↔ 상세)이 된다. 값은 화면 폭이 아니라 **인박스
// 자리의 폭**에 건다 — 같은 창 폭도 사이드바를 펴면 자리가 332(사이드바 324 + 오른쪽 인셋 8) 줄어 상세가 36px로
// 눌렸다(#5754). 문턱은 자리 608 = 사이드바를 편 창 940이다(창 900×600 · 사이드바 펼침은 한 칸).
const INBOX_DETAIL_FLOOR_PX = 256;
const INBOX_SPLIT_MIN_PX = INBOX_LIST_PX + INBOX_DETAIL_FLOOR_PX;

/** 이 상자의 폭이 두 칸에 모자란가. 폭을 모르면(0 · ResizeObserver 없음) 모자라다고 하지 않는다. */
function useRouteTooNarrow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const read = () => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) setNarrow(width < INBOX_SPLIT_MIN_PX);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

export function InboxRoute() {
  const { session } = useSession();
  const needs = useNeedsMe();
  const localWaiting = needs.panes;
  const [params, setParams] = useSearchParams();
  const isPhoneShell = useIsMobileShell();
  const routeRef = useRef<HTMLDivElement | null>(null);
  const routeTooNarrow = useRouteTooNarrow(routeRef);
  // 한 칸(목록 ↔ 상세): 폰 폭 셸이거나 이 자리가 두 칸에 모자랄 때.
  const isMobile = isPhoneShell || routeTooNarrow;
  const tasksProvided = isSurfaceProvided("approvals");
  // 「답글」은 서버 투영에만 있는 종류다. 구 서버에서는 항상 빈 탭이 되므로 세우지 않는다.
  const rawFilter = params.get("filter");
  const mailbox = useMailbox(
    rawFilter === "reminders" ? "reminders" : parseMailboxFilter(rawFilter)
  );
  const formatMessage = useFormatMessage();
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

  // **승인은 예외다** (#5116). 승인 원장이 답했는데 고른 승인이 목록에 없으면 그 승인은 더 이상 결정을
  // 기다리지 않는다: 이 클라이언트가 방금 결정했든, 다른 기기에서 결정됐든(원장은 카드의 `message.edited`
  // 신호로 바로 다시 읽힌다, `ApprovalsLiveSync`) 같다. 스냅샷은 읽은 멘션 같은 줄을 손 밑에서 치우지
  // 않으려는 장치이지 결정이 끝난 승인을 선택된 채 붙들어 두는 장치가 아니다 — 되돌릴 수 없는 액션이라
  // 낡은 컨트롤이 남는 값이 다르다. 이 렌더부터 패널과 줄이 없고, 아래 효과가 선택을 놓고 초점을 잇는다.
  const approvalGone =
    selected !== null &&
    selected.task !== undefined &&
    live === null &&
    mailbox.ledgerAnswered;
  const active: MailboxEntry | null = approvalGone ? null : (live ?? selected);

  // 결정 영수증이 눈에 보이는 자리는 하나다(#5174 L5). 상세 패널이 같은 승인의 같은 문장을 컨트롤 자리에서 이미 말하는
  // 동안 배너 노드는 눈에서만 물러나고(낭독은 이 노드가 한 번 맡는다), 패널이 닫히면 같은 노드가 눈에 보이게 올라온다.
  const paneApprovalId = active?.task?.approvalId;
  const paneReceipt = useSettledApproval(paneApprovalId);
  const bannerYields = receiptSaidInPane(note, {
    approvalId: paneApprovalId,
    line: paneReceipt === null ? null : settledStatusLine(paneReceipt.status),
  });

  const counts = useMemo(() => mailboxCounts(mailbox.entries), [mailbox.entries]);

  const shown = useMemo(() => {
    if (filter === "reminders") return [];
    const filtered = filterMailbox(mailbox.entries, filter);
    if (
      selected === null ||
      approvalGone ||
      filtered.some((e) => e.key === selected.key)
    ) {
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
  }, [mailbox.entries, filter, selected, active, approvalGone]);

  useEffect(() => {
    setNote(null);
  }, [filter]);

  // 원장이 뺀 승인의 자리를 이웃 줄로 잇는다(#5116). 디자인 시스템의 「행이 사라질 때 초점은 다음 행으로,
  // 다음이 없으면 앞 행으로, 행이 하나도 없으면 목록으로」 규칙을 따른다. **줄을 대신 고르지는 않는다**:
  // 초점은 줄에 앉을 뿐 선택이 아니다(Enter·클릭이 선택이다, `MailboxList`). 다음 줄을 자동으로 열면
  // 안 읽은 줄이 읽음이 되고(열어서 읽는 것이 읽음이다), 되돌릴 수 없는 결정 컨트롤이 방금 누른 자리에
  // 그대로 선다 — 누른 손이 다음 승인을 결정하게 된다.
  const listPaneRef = useRef<HTMLDivElement | null>(null);
  // 마지막으로 그린 목록의 줄 순서: 사라진 줄이 어디에 있었는지는 사라진 뒤에는 알 수 없다.
  const shownKeys = useRef<string[]>([]);
  useEffect(() => {
    if (!approvalGone) shownKeys.current = shown.map((entry) => entry.key);
  });
  useEffect(() => {
    if (!approvalGone || selected === null) return;
    const before = shownKeys.current;
    const at = before.indexOf(selected.key);
    const remaining = new Set(shown.map((entry) => entry.key));
    const neighbor = [
      ...before.slice(at + 1),
      ...before.slice(0, Math.max(at, 0)).reverse(),
    ].find((key) => remaining.has(key));
    setSelected(null);
    // 초점이 패널·줄과 함께 사라졌을 때만 옮긴다. 사용자가 이미 다른 곳(사이드바, 다른 줄)에 있으면 뺏지 않는다.
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body && document.body.contains(focused)) {
      return;
    }
    const pane = listPaneRef.current;
    const row = Array.from(
      pane?.querySelectorAll<HTMLElement>("[data-mailbox-row]") ?? []
    ).find((element) => element.getAttribute("data-entry-key") === neighbor);
    (row ?? pane)?.focus();
  }, [approvalGone, selected, shown]);

  // 한 칸에서 열었다 돌아오면 열었던 줄에 초점을 주고 목록 스크롤을 되돌린다(목록 칸이 떼였다 다시 붙어 맨 위로 갔다).
  const openedRef = useRef<{ key: string; scrollTop: number } | null>(null);
  const select = useCallback(
    (entry: MailboxEntry) => {
      openedRef.current = {
        key: entry.key,
        scrollTop: listPaneRef.current?.scrollTop ?? 0,
      };
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
    (outcome: DecisionOutcome, approvalId: string) => {
      setNote({ ...decisionNote(outcome), approvalId });
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
  const wasListHidden = useRef(false);
  useLayoutEffect(() => {
    const returned = wasListHidden.current && !listHidden;
    wasListHidden.current = listHidden;
    const opened = openedRef.current;
    const pane = listPaneRef.current;
    if (!returned || opened === null || pane === null) return;
    pane.scrollTop = opened.scrollTop;
    // 칸 수만 바뀐 경우(사이드바 접기·펴기, 상세는 그대로)에는 초점을 건드리지 않는다.
    if (showDetail) return;
    const row = Array.from(
      pane.querySelectorAll<HTMLElement>("[data-mailbox-row]")
    ).find((element) => element.getAttribute("data-entry-key") === opened.key);
    row?.focus({ preventScroll: true });
  }, [listHidden, showDetail]);

  // 옛 「에이전트」 탭 딥링크는 활동으로 보낸다(#3337). 이 이른 return 은 모든 훅 **아래**에 둔다 —
  // 위에 두면 인박스가 열린 채 그 링크로 올 때 훅 수가 달라져 화면이 죽는다(#5754 검수 2회차).
  if (params.get("filter") === "agents") {
    return <Navigate to="/activity" replace />;
  }

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

  // 오프라인 띠의 「마지막 동기화 …. 아래는 그때의 상태예요」는 **아래에 받아 둔 목록이 서 있을 때만** 참이다(#5307 L4, 검수 5b). 스켈레톤이나 오류 상자
  // 위에서는 그때의 상태가 아래에 없으므로 「아직 이 목록을 한 번도 받지 못했어요」로 말한다. 시각은 값이 없으면(0) 같은 갈래다.
  // 「나중에」 탭은 자기 목록(`RemindersPanel`)이 자기 로딩을 말하므로 그 목록의 시각을 그대로 쓴다.
  const bandSyncedAtMs = filter === "reminders" ? reminders.dataUpdatedAt : mailbox.updatedAtMs;
  const bandListBelow = filter === "reminders" || shown.length > 0 || !(mailbox.isLoading || mailbox.error);
  const bandRelativeTime = bandListBelow && bandSyncedAtMs > 0 ? relativeLabel(bandSyncedAtMs, Date.now()) : null;

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
    <div ref={routeRef} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="inbox-route">
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
        // 같은 노드가 두 모습을 가진다: 패널이 같은 문장을 말하는 동안은 `sr-only`(낭독만, 닫기 단추 없음: 보이지 않는
        // 단추에 초점이 앉지 않게), 패널이 닫히면 눈에 보이는 배너. 노드를 갈아 끼우면 낭독이 두 번 된다.
        // 클래스는 정적 문자열이고 모습은 `data-said-in-pane`이 고른다(직접 문구 장부가 JSX 식 안의 문자열을 세므로).
        <div
          className="data-said-in-pane:sr-only"
          data-said-in-pane={bannerYields ? "" : undefined}
        >
          <InlineBanner
            tone={note.tone === "error" ? "error" : "neutral"}
            message={note.text}
            actionLabel="닫기"
            onAction={bannerYields ? undefined : () => setNote(null)}
            testId="inbox-decision-note"
          />
        </div>
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
          message={<BlockedListLine relativeTime={bandRelativeTime} />}
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
              ref={listPaneRef}
              tabIndex={-1}
              role="tabpanel"
              id={webMailboxPanelId(filter)}
              aria-labelledby={webMailboxTabId(filter)}
              data-testid="inbox-list-pane"
              className={
                isMobile
                  ? "min-h-0 flex-1 overflow-y-auto focus-visible:focus-ring"
                  : "min-h-0 w-[22rem] shrink-0 overflow-y-auto border-r border-line focus-visible:focus-ring"
              }
            >
              {state === "error" ? (
                <LoadFailureBox
                  titleKey={CONNECTION_KEYS.loadInboxTitle}
                  cause={loadCauseOf(mailbox.failure)}
                  onRetry={mailbox.refetch}
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
                              {loadFailureSentence(
                                formatMessage,
                                CONNECTION_KEYS.loadInboxMoreTitle,
                                loadCauseOf(mailbox.failure)
                              )}
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

      {/* 에이전트가 한 일 전체는 활동에서 본다(#3337). 인박스는 나에게 필요한 것만 담는다.
          이 줄은 칼럼 전체 폭이라 눌림은 채움만 한다: `press`(0.98배)는 넓은 면을 줄여 가장자리가 흔들린다. `press-instant-fill`이
          `:active`에 크기 없이 `--surface-pressed`를 칠한다(#5094, #5048 D7, 넓은 줄 규칙). 쉬는 면이 이미 `--surface-hover`라
          호버(`--surface-pressed`)와 눌림이 같은 채움을 쓴다 — 손가락(호버 없음)에서는 쉼 → 눌림이 눈에 보인다. */}
      <Link
        to="/activity"
        data-testid="inbox-activity-link"
        className="press-instant-fill mx-4 mb-2 mt-2 flex h-control items-center justify-between rounded-lg bg-surface-hover px-3 text-body text-ink-muted hover:bg-surface-pressed hover:text-ink focus-visible:focus-ring"
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
