import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { DoorOpen } from "lucide-react";
import { leaveDm, uuidEq, type ReadState } from "@momo/core/lib/api";
import {
  DM_LEAVE_KEYS,
  dmLeaveConfirmCopy,
  dmLeaveScheduledCount,
  dmLeaveSeenSeq,
  runDmLeaveCleanup,
  settleDmLeaveFailure,
} from "@momo/core/features/channels/dmLeave";
import { SCHEDULED_COPY } from "@momo/core/features/scheduled/copy";
import { ConfirmDialog } from "@/design/ui/confirm-dialog";
import type { DialogFocusTarget } from "@/design/ui/dialog";
import { INLINE_CONFIRM_MS } from "@/design/ui/inlineConfirm";
import { useShellNav } from "@/app/shellNav";
import { useMessages } from "@/i18n/useMessages";
import { useScheduled } from "@/features/scheduled/useScheduled";
import { useHoverNone } from "@/features/emoji/useHoverNone";
import {
  clearDmLeaveReceipt,
  endDmLeaveRequest,
  isDmLeaveListHeld,
  noteDmLeaveFolded,
  openTimelineFor,
  showDmLeaveReceipt,
  subscribeDmLeaveStore,
  useDmLeaveStore,
  type DmLeaveReceipt,
  type DmLeaveRequest,
} from "./dmLeaveStore";
import { collectDmLeaveRootIds, webDmLeaveCleanupPort } from "./dmLeaveCleanup";
import { focusSidebarChannelRow, neighborSidebarChannelRowId } from "./sidebarRowFocus";

// Reading this as: sidebar (a destructive confirm + a one-line receipt) for internal team users on web + the Tauri shell,
// density 6/10, motion 2/10.

// =============================================================================
// 1:1 「대화 나가기」의 확인 창과 끝난 뒤 (ADR-0177 증보 2026-11-14 D16·D21, #5825).
//
// 두 메뉴(줄 우클릭 · 머리 ⋮)는 `requestDmLeave` 로 요청만 적고, 이 호스트 하나가 확인 창 → 왕복 → 정리 → 이동 → 영수증을 진다
// (`dmLeaveStore.ts` 머리말: 줄·머리 안에 두면 성공하는 순간 같이 사라진다).
//
// ## 네 상태
//
//   쉼      공용 `ConfirmDialog` 위험 변형. 초점은 「취소」. 문장은 코어 사전(D21): 제목 · 본문 · 되살림 · (예약 N개) · 경고(되돌릴 수 없음).
//   진행 중  확정 단추가 `aria-busy` + 「나가는 중…」(사전 `busy`), 취소·Esc·바깥 누름은 잠김(요청이 이미 나갔다).
//   실패    다시 누르면 달라질 수 있는 것(망·5xx·403·400)은 창 안 한 줄(`role="alert"`, 사전 `failed`) + 살아 있는 확정 - 「나가기」가 곧 다시
//           시도다. 다시 눌러도 같은 답인 것은 다르게 닫는다(검수 r1 M5): 404(이미 나갔거나 없는 대화)는 「이미 나간 것」으로 보고 창을 닫고 줄을
//           걷는다(문장 없이 - 채널 나가기와 같다). 409 `dm_leave_unavailable`·405·501 은 「이 대화에서는 나갈 수 없어요.」(사전 `unavailable`) +
//           확정 잠금(405·501 은 이 워크스페이스의 메뉴도 접는다, 409 는 채널·투영을 다시 받는다).
//   확인 중  예약 목록을 아직 모를 때(M2): 창은 바로 서고 확정만 잠긴 채 「확인 중…」(사전 `checking`). 알게 되면 그 자리의 문장만 바뀐다 -
//           설명 끝의 한 칸(`SCHEDULED_SLOT`)을 미리 잡아 두어 창의 높이·단추 줄이 움직이지 않는다.
//   성공    창이 닫히고, 그 대화의 줄 자리에 한 줄 영수증(「대화에서 나갔어요.」, `DmLeaveReceiptRow`). 보고 있었으면 `/` 로 간다.
//
// ## 성공의 차례 (줄 · 주소 · 캐럿)
//
//   1. 이웃 줄을 **지우기 전에** 잡는다(`closeDmRow` 와 같은 규칙).
//   2. 영수증을 세운다 - 3 이 줄을 내리기 전에 그 자리를 영수증이 받는다(줄 높이 그대로, 아래 줄이 움직이지 않는다).
//   3. 정리(`runDmLeaveCleanup`): 투영 행이 먼저라 이 대화는 곧바로 3a 로 숨는다.
//   4. 보고 있었으면 `/` 로. 3 이 먼저여야 한다: 인덱스 폴백이 숨지 않은 이 대화를 다시 고르지 않게.
//   5. 창을 닫는다. 캐럿은 이웃 줄로(사이드바가 보일 때), 아니면 본문의 입력칸으로 - `<body>` 로 떨어지지 않는다.
//   6. 주소가 바뀐 뒤(그 대화의 화면이 내려간 뒤) 초안·답글 초안·트레이·못 보낸 글을 한 번 더 지운다. 정리 범위는 D17 기기 줄이다.
// =============================================================================

/** 확인 창을 연 순간의 `seenSeq`(D16). 다시 시도도 같은 값을 쓴다. */
interface OpenedLeave {
  request: DmLeaveRequest;
  seenSeq: number;
}

/** 이 기기에만 있는 것의 둘째 정리를 기다리는 대화(아래 「성공의 차례」 6). */
interface PendingSecondPass {
  channelId: string;
  rootIds: string[];
}

function readRowOf(rows: readonly ReadState[] | undefined, channelId: string): ReadState | undefined {
  return rows?.find((row) => uuidEq(row.channelId, channelId));
}

/** 사이드바 줄이 아닌 착지: 본문의 입력칸, 없으면 본문 머리의 제목. */
function focusMainLanding(): void {
  const target =
    document.querySelector<HTMLElement>('[data-testid="composer-input"]') ??
    document.querySelector<HTMLElement>('[data-testid="channel-header"] h1[tabindex]');
  target?.focus({ preventScroll: true });
}

export function DmLeaveHost({
  workspaceId,
  selfMemberId,
  readRows,
  openId,
  navRef,
}: {
  workspaceId: string;
  selfMemberId: string;
  /** 읽음 투영(`GET read-state`) 행. `seenSeq` 의 기준이다. */
  readRows: readonly ReadState[] | undefined;
  /** 지금 열려 있는 대화. 나간 대화를 보고 있었으면 `/` 로 간다. */
  openId: string | null;
  /** 사이드바 목록. 이웃 줄을 찾는다. */
  navRef: RefObject<HTMLElement | null>;
}) {
  const { request } = useDmLeaveStore();
  const client = useQueryClient();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const shellNav = useShellNav();
  const messages = useMessages();
  const scheduled = useScheduled();
  const [opened, setOpened] = useState<OpenedLeave | null>(null);
  const [busy, setBusy] = useState(false);
  // 실패의 갈래: `retry` = 다시 누르면 달라질 수 있다(확정이 살아 있다) · `unavailable` = 다시 눌러도 같은 답이다(확정 잠금).
  const [failed, setFailed] = useState<"retry" | "unavailable" | null>(null);
  // 닫힌 뒤 캐럿이 갈 곳. 성공이면 이웃 줄(또는 본문), 아니면 연 자리.
  // `drawerFrom`: 좁은 창에서 머리 ⋮ 로 나갔으면 서랍(목록)을 연다. 주소가 그 자리(`drawerFrom`)를 떠난 뒤에 연다 - `null` 이면 주소가 안 바뀐다.
  const outcomeRef = useRef<
    { kind: "left"; neighborId: string | null; openDrawer: boolean; drawerFrom: string | null } | null
  >(null);
  const shellNavRef = useRef(shellNav);
  shellNavRef.current = shellNav;
  const openerRef = useRef<HTMLElement | null>(null);
  const flightRef = useRef(0);
  const [secondPass, setSecondPass] = useState<PendingSecondPass | null>(null);
  const [drawerAfterRoute, setDrawerAfterRoute] = useState<string | null>(null);

  // 요청이 오면 그 순간의 seq 를 적는다(확인 창이 열린 때). 줄 메뉴로 왔어도 그 대화가 열려 있으면 이력이 본 가장 큰 seq 를 함께 본다.
  useEffect(() => {
    // 요청이 끝나도 앞 판을 들고 있는다: 창이 `open=false` 로 닫혀야 닫힘 캐럿 복귀(`opener`)가 돈다.
    if (request === null || !uuidEq(request.workspaceId, workspaceId)) return;
    const row = readRowOf(client.getQueryData<ReadState[]>(["read-state", workspaceId]) ?? readRows, request.channelId);
    const open = openTimelineFor(workspaceId, request.channelId);
    const observed = Math.max(request.observedSeq ?? 0, open?.newestSeq ?? 0);
    openerRef.current = request.opener;
    outcomeRef.current = null;
    setFailed(null);
    setBusy(false);
    setOpened({ request, seenSeq: dmLeaveSeenSeq(row, observed) });
    if (scheduled.surface === "unknown") scheduled.refetch();
    // 요청이 바뀔 때만: 투영이 새로 와도 연 순간의 seq 를 바꾸지 않는다(D16).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, workspaceId]);

  // 6. 둘째 정리: 그 대화가 열려 있지 않게 된 뒤(주소가 바뀐 커밋 뒤)에 이 기기에만 있는 것을 한 번 더 지운다.
  useEffect(() => {
    if (secondPass === null) return;
    if (openId !== null && uuidEq(openId, secondPass.channelId)) return;
    const port = webDmLeaveCleanupPort(client, workspaceId, selfMemberId);
    port.clearDrafts(secondPass.channelId, secondPass.rootIds);
    port.clearAttachmentTrays(secondPass.channelId, secondPass.rootIds);
    port.forgetFailedSends(secondPass.channelId);
    setSecondPass(null);
  }, [secondPass, openId, client, workspaceId, selfMemberId]);

  // 좁은 창 머리 ⋮ 로 나간 뒤의 서랍. 셸은 주소가 바뀐 커밋의 효과에서 서랍을 닫는다(같은 커밋의 효과는 자식 → 부모 차례라 이 효과가
  // 먼저 돈다). 그래서 주소가 떠난 것을 본 뒤 **다음 프레임**에 연다 - 주소 커밋이 확인 창 닫힘보다 늦게 와도 서랍이 다시 닫히지 않는다.
  useEffect(() => {
    if (drawerAfterRoute === null || pathname === drawerAfterRoute) return;
    setDrawerAfterRoute(null);
    requestAnimationFrame(() => shellNavRef.current.openDrawer());
  }, [drawerAfterRoute, pathname]);

  // 예약 N 개(D21). 서버는 그 방의 내 `pending`·`failed` 를 같이 취소한다. 「모름」을 0 으로 읽지 않는다: 첫 목록이 오기 전에는 창을 먼저 세우고
  // 확정을 잠근 채 「확인 중…」을 말하며(M2), 못 읽었으면 그 까닭을 말하고 잠근 채로 둔다.
  const scheduledCount =
    opened === null
      ? 0
      : scheduled.surface === "present"
        ? dmLeaveScheduledCount(scheduled.rows, opened.request.channelId)
        : scheduled.surface === "absent"
          ? 0
          : null;
  const scheduledFailed = scheduledCount === null && scheduled.isError;
  const scheduledChecking = scheduledCount === null && !scheduledFailed;

  const copy = useMemo(
    () =>
      opened === null
        ? null
        : dmLeaveConfirmCopy(messages.formatMessage, { name: opened.request.name, scheduledCount: scheduledCount ?? 0 }),
    [opened, messages, scheduledCount]
  );

  // 확인 창이 닫힐 때 캐럿을 돌려줄 자리. 닫히는 순간에 고른다: 성공이면 이웃 줄(다음 프레임 - 이동 뒤의 목록), 아니면 연 자리.
  const focusTarget = useMemo<DialogFocusTarget>(
    () => ({
      get isConnected() {
        return true;
      },
      focus() {
        const outcome = outcomeRef.current;
        if (outcome === null) {
          const opener = openerRef.current;
          if (opener?.isConnected) opener.focus();
          else focusMainLanding();
          return;
        }
        if (outcome.openDrawer) {
          // 좁은 창에서 머리 ⋮ 로 나갔다: 직전 화면인 목록(서랍)을 연다. 주소가 바뀐 커밋이 서랍을 닫은 **뒤**에 연다(위 효과).
          // 캐럿은 서랍이 열리며 스스로 잡는다(첫 정거장 = 닫기 단추) - 닫힌 서랍 안의 줄이나 가려질 본문으로 보내지 않는다.
          if (outcome.drawerFrom === null) requestAnimationFrame(() => shellNavRef.current.openDrawer());
          else setDrawerAfterRoute(outcome.drawerFrom);
          return;
        }
        requestAnimationFrame(() => {
          const landed =
            outcome.neighborId !== null && focusSidebarChannelRow(document, outcome.neighborId) && document.activeElement !== document.body;
          if (!landed) focusMainLanding();
        });
      },
    }),
    []
  );

  const close = () => {
    if (busy) return;
    endDmLeaveRequest();
  };

  /**
   * 나가기가 끝난 대화의 뒤처리(성공과 404 가 같이 쓴다): 이웃 줄 잡기 → (영수증) → 정리 → 보던 대화면 `/` → 둘째 정리 → 창 닫기.
   * 404 는 영수증이 없다 - 「이미 나간 것」이라 말할 문장이 없다(M5).
   */
  const finishLeft = (req: DmLeaveRequest, seenSeq: number, rootIds: string[], withReceipt: boolean) => {
    // 1. 이웃 줄(지우기 전에).
    const neighborId = navRef.current === null ? null : neighborSidebarChannelRowId(navRef.current, req.channelId);
    // 2. 영수증이 그 줄 자리를 받는다.
    if (withReceipt) showDmLeaveReceipt(workspaceId, req.channelId);
    // 3. 이 기기의 사본 정리(투영 행 → 캐시 → 초안·답글 초안 → 트레이 → 못 보낸 글).
    runDmLeaveCleanup(webDmLeaveCleanupPort(client, workspaceId, selfMemberId), {
      channelId: req.channelId,
      seenSeq,
      rootIds,
    });
    // 이 행보다 먼저 떠난 투영 읽기가 하한 없는 행으로 덮지 않게 다시 읽는다(나가는 중인 읽기는 버리고 새로 받는다).
    void client.invalidateQueries({ queryKey: ["read-state", workspaceId] });
    // 4. 보고 있던 대화면 떠난다.
    const fromPath = pathnameRef.current;
    const moves = openId !== null && uuidEq(openId, req.channelId) && fromPath !== "/";
    if (openId !== null && uuidEq(openId, req.channelId)) navigate("/");
    // 6. 주소가 바뀐 뒤의 둘째 정리.
    setSecondPass({ channelId: req.channelId, rootIds });
    // 5. 닫는다. 좁은 창에서 머리 ⋮ 로 나갔으면 서랍(목록)을 연다 - 직전 화면이고, 영수증이 서는 자리다(캐럿 복귀에서).
    outcomeRef.current = {
      kind: "left",
      neighborId,
      openDrawer: req.via === "header" && shellNav.isMobile && !shellNav.drawerOpen,
      drawerFrom: moves ? fromPath : null,
    };
    setBusy(false);
    endDmLeaveRequest();
  };

  const confirm = async () => {
    // 예약 목록을 아직 모르거나 다시 눌러도 같은 답인 창은 확정이 잠겨 있다(공용 부품의 잠금과 같은 조건을 한 번 더 막는다).
    if (opened === null || busy || scheduledCount === null || failed === "unavailable") return;
    const { request: req, seenSeq } = opened;
    // 뿌리 글 후보는 PUT 전에 모은다(#5824 검수 r1 M4).
    const rootIds = collectDmLeaveRootIds(client, workspaceId, req.channelId, [
      ...req.rootIds,
      ...(openTimelineFor(workspaceId, req.channelId)?.messageIds ?? []),
    ]);
    const flight = ++flightRef.current;
    setBusy(true);
    setFailed(null);
    try {
      await leaveDm(workspaceId, req.channelId, seenSeq);
    } catch (error) {
      if (flight !== flightRef.current) return;
      const failure = settleDmLeaveFailure(workspaceId, error);
      if (failure === "absent") noteDmLeaveFolded();
      if (failure === "missing" || failure === "unavailable") {
        void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
        void client.invalidateQueries({ queryKey: ["read-state", workspaceId] });
      }
      if (failure === "missing") {
        // 404: 이미 나갔거나 없는 대화다. 다시 눌러도 같은 답이라 「이미 나간 것」으로 보고 창을 닫고 줄을 걷는다(문장 없이).
        finishLeft(req, seenSeq, rootIds, false);
        return;
      }
      setBusy(false);
      setFailed(failure === "failed" ? "retry" : "unavailable");
      return;
    }
    if (flight !== flightRef.current) return;
    finishLeft(req, seenSeq, rootIds, true);
  };

  return (
    <>
      {copy !== null && opened !== null && (
        <ConfirmDialog
          open={request !== null && opened.request === request}
          onOpenChange={(next) => {
            if (!next) close();
          }}
          // 공용 `ConfirmDialog` 는 `HTMLElement` 로 받지만 그대로 `DialogContent` 의 `DialogFocusTarget`(isConnected · focus)으로 넘긴다.
          // 닫히는 순간에 갈 곳을 고르려고 그 두 칸만 가진 대상을 넘긴다(공용 부품은 고치지 않는다).
          opener={focusTarget as unknown as HTMLElement}
          tone="destructive"
          title={copy.title}
          description={
            <>
              {copy.body.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <ScheduledSlot
                state={scheduledFailed ? "failed" : scheduledChecking ? "checking" : "known"}
                checking={messages.formatMessage(DM_LEAVE_KEYS.checking)}
                failedText={SCHEDULED_COPY.load.error}
              >
                {copy.scheduled === null ? null : (
                  <p data-testid="dm-leave-confirm-scheduled">{copy.scheduled}</p>
                )}
              </ScheduledSlot>
            </>
          }
          warning={copy.warning}
          confirmLabel={copy.confirm}
          busyLabel={messages.formatMessage(DM_LEAVE_KEYS.busy)}
          cancelLabel={copy.cancel}
          busy={busy}
          error={failed === "retry" ? messages.formatMessage(DM_LEAVE_KEYS.failed) : null}
          lockedReason={
            failed === "unavailable" ? (
              <span role="alert">{messages.formatMessage(DM_LEAVE_KEYS.unavailable)}</span>
            ) : scheduledFailed ? (
              <span className="sr-only">{SCHEDULED_COPY.load.error}</span>
            ) : scheduledChecking ? (
              <span className="sr-only">{messages.formatMessage(DM_LEAVE_KEYS.checking)}</span>
            ) : undefined
          }
          onConfirm={() => void confirm()}
          testId="dm-leave-confirm"
        />
      )}
      <DmLeaveAnnouncer />
    </>
  );
}

/**
 * 확인 창 설명 끝의 「예약 N개」 칸(M2). 예약 목록을 아직 모를 때 「확인 중…」, 못 읽었을 때 까닭, 알았을 때 「예약해 둔 메시지 N개도 취소돼요.」(없으면 빈
 * 칸)가 **같은 자리**에 선다. 높이를 미리 잡아 두는 셈: 칸의 최소 높이는 본문 한 줄(`1lh`)이고, 확정이 잠겨 있는 동안(모름·못 읽음)에는 공용 부품이
 * 잠금 문장 줄(빈 줄이라도 `gap-3` 한 칸)을 더 세우므로, 알게 되어 그 줄이 걷히는 순간 같은 만큼(`0.75rem`)을 이 칸의 최소 높이가 받는다 - 창의 높이·단추 줄의 y 가
 * 움직이지 않는다. 낭독은 잠금 문장(`lockedReason`)이 맡아서 눈에 보이는 글은 `aria-hidden` 이다.
 */
const SCHEDULED_SLOT_CLASS = "min-h-[1lh]";
/** 알았을 때: 본문 한 줄 + 걷힌 잠금 줄의 `gap-3`(상자 크기가 border-box 라 padding 이 아니라 최소 높이에 더한다). */
const SCHEDULED_SLOT_KNOWN_CLASS = "min-h-[calc(1lh+0.75rem)]";

function ScheduledSlot({
  state,
  checking,
  failedText,
  children,
}: {
  state: "checking" | "failed" | "known";
  checking: string;
  failedText: string;
  children: ReactNode;
}) {
  return (
    <div
      className={state === "known" ? SCHEDULED_SLOT_KNOWN_CLASS : SCHEDULED_SLOT_CLASS}
      data-testid="dm-leave-confirm-slot"
      data-state={state}
    >
      {state === "checking" ? (
        <p aria-hidden="true" data-testid="dm-leave-confirm-checking">
          {checking}
        </p>
      ) : state === "failed" ? (
        <p aria-hidden="true" data-testid="dm-leave-confirm-scheduled-failed">
          {failedText}
        </p>
      ) : (
        children
      )}
    </div>
  );
}

/**
 * 영수증의 낭독. 사이드바가 접혀 있거나(⌘B) 서랍이 닫혀 있으면 줄 자리의 영수증은 접근성 트리 밖이라, 같은 문장을 `body` 의 숨은 상태
 * 영역 하나가 읽는다. 영역은 늘 서 있고 글자만 바뀐다(처음부터 있어야 낭독기가 바뀜을 듣는다).
 */
function DmLeaveAnnouncer() {
  const { receipts } = useDmLeaveStore();
  const latest = receipts.at(-1);
  const messages = useMessages();
  if (typeof document === "undefined") return null;
  return createPortal(
    <p role="status" className="sr-only" data-testid="dm-leave-announce">
      {/* 영역은 늘 서 있고, 영수증마다 새 글 마디를 넣는다(같은 문장이 두 번 와도 다시 읽힌다). */}
      {latest === undefined ? null : <span key={latest.id}>{messages.formatMessage(DM_LEAVE_KEYS.done)}</span>}
    </p>,
    document.body
  );
}

/** 메뉴·창이 닫힌 뒤 `:hover` 가 갱신되기를 기다리는 시간(ms). */
const HOVER_SETTLE_MS = 120;

/**
 * 나간 대화의 줄 자리에 서는 한 줄 영수증(D21 「대화에서 나갔어요.」, 되돌리기 단추 없음). 토스트가 아니라 그 자리의 한 줄이다
 * (`useInlineConfirm` 과 같은 1.6초).
 *
 * **걷힐 때 포인터 밑의 줄이 움직이지 않는다.** 줄과 같은 상자(`sidebar-row`)라 서는 순간에는 아무것도 움직이지 않고, 걷히면 아래 줄이
 * 한 칸 올라온다. 그래서 1.6초가 지나도 포인터가 목록 위에 있으면 걷지 않고, 포인터가 목록을 떠나는 순간 걷는다 - 사람이 겨눈 줄이
 * 다른 줄로 바뀌지 않는다. 목록에서 연 메뉴·창이 열려 있는 동안에도 걷지 않는다(M4: 메뉴 판은 포털이라 메뉴를 열면 포인터가 목록을 나간 것으로
 * 치는데, 그 순간 걷으면 메뉴를 연 줄이 한 칸 올라온다) - 메뉴가 닫히고 포인터가 정말 목록 밖일 때 걷는다. 손가락 표면(`hover: none`)에는 머무는
 * 포인터가 없어 시간과 메뉴·창만 본다.
 */
export function DmLeaveReceiptRow({
  receipt,
  paneRef,
}: {
  receipt: DmLeaveReceipt;
  /** 사이드바 목록 판. 포인터가 이 안에 있으면 걷기를 미룬다. */
  paneRef: RefObject<HTMLElement | null>;
}) {
  const messages = useMessages();
  const touch = useHoverNone();
  useEffect(() => {
    const pane = paneRef.current;
    let elapsed = false;
    let disposed = false;
    let release: number | undefined;
    // 걷어도 되는 때: 시간이 찼고, 포인터가 목록 밖이고, 목록에서 연 메뉴·창이 없다(M4 - 메뉴 판은 포털이라 메뉴가 열리면 포인터가 목록을
    // 나간 것으로 치므로, 「목록 밖」만 보면 메뉴를 연 순간 영수증이 걷히며 아래 줄이 올라온다).
    const settle = () => {
      if (disposed || !elapsed) return;
      if (!touch && pane !== null && pane.matches(":hover")) return;
      if (isDmLeaveListHeld()) return;
      clearDmLeaveReceipt(receipt.id);
    };
    const timer = window.setTimeout(() => {
      elapsed = true;
      settle();
    }, INLINE_CONFIRM_MS);
    pane?.addEventListener("pointerleave", settle);
    // 메뉴·창이 닫히면 다시 본다. 닫힌 직후에는 브라우저가 `:hover` 를 아직 갱신하지 않았을 수 있어 한 박자 뒤에 본다.
    const unsubscribe = subscribeDmLeaveStore(() => {
      window.clearTimeout(release);
      release = window.setTimeout(settle, HOVER_SETTLE_MS);
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearTimeout(release);
      pane?.removeEventListener("pointerleave", settle);
      unsubscribe();
    };
  }, [receipt.id, paneRef, touch]);
  return (
    <li data-testid="dm-leave-receipt" data-channel-id={receipt.channelId}>
      <div className="tap-target sidebar-row flex w-full items-center" data-dim="">
        <span data-row-icon="" aria-hidden="true">
          <DoorOpen />
        </span>
        <span className="min-w-0 flex-1 truncate">{messages.formatMessage(DM_LEAVE_KEYS.done)}</span>
      </div>
    </li>
  );
}
