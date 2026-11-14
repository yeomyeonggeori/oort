import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
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
  noteDmLeaveFolded,
  showDmLeaveReceipt,
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
//   진행 중  확정 단추가 `aria-busy`, 취소·Esc·바깥 누름은 잠김(요청이 이미 나갔다). 진행 낱말 키가 사전에 없어 확정 낱말 그대로다.
//   실패    창 안 한 줄(`role="alert"`, 사전 `failed`), 단추는 다시 살아난다 - 「나가기」가 곧 다시 시도다. 아무것도 바뀌지 않았다.
//           405·501 은 이 워크스페이스의 메뉴를 접고, 404·409 는 채널·투영을 다시 받는다(그 대화가 이 기기의 생각과 다르다).
//   성공    창이 닫히고, 그 대화의 줄 자리에 한 줄 영수증(「대화에서 나갔어요.」, `DmLeaveReceiptRow`). 보고 있었으면 `/` 로 간다.
//
// ## 성공의 차례 (줄 · 주소 · 캐럿)
//
//   1. 이웃 줄을 **지우기 전에** 잡는다(`closeDmRow` 와 같은 규칙).
//   2. 영수증을 세운다 - 3 이 줄을 내리기 전에 그 자리를 영수증이 받는다(줄 높이 그대로, 아래 줄이 움직이지 않는다).
//   3. 정리(`runDmLeaveCleanup`): 투영 행이 먼저라 이 대화는 곧바로 3a 로 숨는다.
//   4. 보고 있었으면 `/` 로. 3 이 먼저여야 한다: 인덱스 폴백이 숨지 않은 이 대화를 다시 고르지 않게.
//   5. 창을 닫는다. 캐럿은 이웃 줄로(사이드바가 보일 때), 아니면 본문의 입력칸으로 - `<body>` 로 떨어지지 않는다.
// =============================================================================

/** 확인 창을 연 순간의 `seenSeq`(D16 - 확인 창을 보는 사이에 온 글은 묻히지 않는다). 다시 시도도 같은 값을 쓴다. */
interface OpenedLeave {
  request: DmLeaveRequest;
  seenSeq: number;
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
  const shellNav = useShellNav();
  const messages = useMessages();
  const scheduled = useScheduled();
  const [opened, setOpened] = useState<OpenedLeave | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // 닫힌 뒤 캐럿이 갈 곳. 성공이면 이웃 줄(또는 본문), 아니면 연 자리.
  const outcomeRef = useRef<{ kind: "left"; neighborId: string | null } | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const flightRef = useRef(0);

  // 요청이 바뀌면 그 순간의 seq 를 적는다(확인 창이 열린 때). 예약 수를 모르면 한 번 다시 읽는다.
  const requestKey = request ? `${request.workspaceId}:${request.channelId}`.toLowerCase() : null;
  useEffect(() => {
    // 요청이 끝나도 앞 판을 들고 있는다: 창이 `open=false` 로 닫혀야 닫힘 캐럿 복귀(`opener`)가 돈다.
    if (request === null || !uuidEq(request.workspaceId, workspaceId)) return;
    const row = readRowOf(client.getQueryData<ReadState[]>(["read-state", workspaceId]) ?? readRows, request.channelId);
    openerRef.current = request.opener;
    outcomeRef.current = null;
    setFailed(false);
    setBusy(false);
    setOpened({ request, seenSeq: dmLeaveSeenSeq(row, request.observedSeq) });
    if (scheduled.surface === "unknown") scheduled.refetch();
    // 요청이 바뀔 때만: 투영이 새로 와도 연 순간의 seq 를 바꾸지 않는다(D16).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, workspaceId]);

  // 예약 N 개(D21). 서버는 그 방의 내 `pending`·`failed` 를 같이 취소한다. 「모름」을 0 으로 읽지 않는다: 첫 목록이 오기 전에는 창을 열지
  // 않고(사이드바가 앱을 열 때 이미 읽어 두어 보통은 바로다), 못 읽었으면 그 까닭을 말하고 확정을 잠근다.
  const scheduledCount =
    opened === null
      ? 0
      : scheduled.surface === "present"
        ? dmLeaveScheduledCount(scheduled.rows, opened.request.channelId)
        : scheduled.surface === "absent"
          ? 0
          : null;
  const scheduledFailed = scheduledCount === null && scheduled.isError;
  const ready = opened !== null && (scheduledCount !== null || scheduledFailed);

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

  const confirm = async () => {
    if (opened === null || busy) return;
    const { request: req, seenSeq } = opened;
    // 뿌리 글 id 는 PUT 전에 모은다(#5824 검수 r1 M4): 뒤에는 서버가 하한 아래 뿌리를 내려 주지 않는다.
    const rootIds = collectDmLeaveRootIds(client, workspaceId, req.channelId, req.rootIds);
    const flight = ++flightRef.current;
    setBusy(true);
    setFailed(false);
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
      setBusy(false);
      setFailed(true);
      return;
    }
    if (flight !== flightRef.current) return;
    // 1. 이웃 줄(지우기 전에).
    const neighborId = navRef.current === null ? null : neighborSidebarChannelRowId(navRef.current, req.channelId);
    // 2. 영수증이 그 줄 자리를 받는다.
    showDmLeaveReceipt(workspaceId, req.channelId);
    // 3. 이 기기의 사본 정리(투영 행 → 캐시 → 초안·답글 초안 → 트레이 → 못 보낸 글).
    runDmLeaveCleanup(webDmLeaveCleanupPort(client, workspaceId, selfMemberId), {
      channelId: req.channelId,
      seenSeq,
      rootIds,
    });
    // 4. 보고 있던 대화면 떠난다.
    if (openId !== null && uuidEq(openId, req.channelId)) navigate("/");
    // 5. 닫는다. 좁은 창에서 머리 ⋮ 로 나갔으면 서랍(목록)을 연다 - 직전 화면이고, 영수증이 서는 자리다.
    outcomeRef.current = { kind: "left", neighborId };
    setBusy(false);
    endDmLeaveRequest();
    if (req.via === "header" && shellNav.isMobile && !shellNav.drawerOpen) shellNav.openDrawer();
  };

  return (
    <>
      {copy !== null && opened !== null && (
        <ConfirmDialog
          open={ready && request !== null}
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
              {copy.lines.slice(0, 2).map((line) => (
                <p key={line}>{line}</p>
              ))}
              {copy.lines.slice(3).map((line) => (
                <p key={line} data-testid="dm-leave-confirm-scheduled">
                  {line}
                </p>
              ))}
            </>
          }
          warning={copy.lines[2]}
          confirmLabel={copy.confirm}
          busyLabel={copy.confirm}
          cancelLabel={copy.cancel}
          busy={busy}
          error={failed ? messages.formatMessage(DM_LEAVE_KEYS.failed) : null}
          lockedReason={scheduledFailed ? SCHEDULED_COPY.load.error : undefined}
          onConfirm={() => void confirm()}
          testId="dm-leave-confirm"
        />
      )}
      <DmLeaveAnnouncer />
    </>
  );
}

/**
 * 영수증의 낭독. 사이드바가 접혀 있거나(⌘B) 서랍이 닫혀 있으면 줄 자리의 영수증은 접근성 트리 밖이라, 같은 문장을 `body` 의 숨은 상태
 * 영역 하나가 읽는다. 영역은 늘 서 있고 글자만 바뀐다(처음부터 있어야 낭독기가 바뀜을 듣는다).
 */
function DmLeaveAnnouncer() {
  const { receipt } = useDmLeaveStore();
  const messages = useMessages();
  if (typeof document === "undefined") return null;
  return createPortal(
    <p role="status" className="sr-only" data-testid="dm-leave-announce">
      {receipt === null ? "" : messages.formatMessage(DM_LEAVE_KEYS.done)}
    </p>,
    document.body
  );
}

/**
 * 나간 대화의 줄 자리에 서는 한 줄 영수증(D21 「대화에서 나갔어요.」, 되돌리기 단추 없음). 토스트가 아니라 그 자리의 한 줄이다
 * (`useInlineConfirm` 과 같은 1.6초).
 *
 * **걷힐 때 포인터 밑의 줄이 움직이지 않는다.** 줄과 같은 상자(`sidebar-row`)라 서는 순간에는 아무것도 움직이지 않고, 걷히면 아래 줄이
 * 한 칸 올라온다. 그래서 1.6초가 지나도 포인터가 목록 위에 있으면 걷지 않고, 포인터가 목록을 떠나는 순간 걷는다 - 사람이 겨눈 줄이
 * 다른 줄로 바뀌지 않는다. 손가락 표면(`hover: none`)에는 머무는 포인터가 없어 시간만 본다.
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
    const done = () => clearDmLeaveReceipt(receipt.id);
    let waiting = false;
    const timer = window.setTimeout(() => {
      if (!touch && pane !== null && pane.matches(":hover")) {
        waiting = true;
        pane.addEventListener("pointerleave", done, { once: true });
        return;
      }
      done();
    }, INLINE_CONFIRM_MS);
    return () => {
      window.clearTimeout(timer);
      if (waiting) pane?.removeEventListener("pointerleave", done);
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
