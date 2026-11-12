import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { ListChecks, SquareTerminal } from "lucide-react";
import { Link, useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router-dom";
import type { SharedWorkSession } from "@momo/core/lib/api";
import { uuidEq } from "@momo/core/lib/api";
import { isRealtimeConnected } from "@momo/core/lib/realtimeEvents";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import { approvalWaitingLine } from "@momo/core/features/timeline/requestBundle";
import {
  NEEDS_ME_SECTION,
  WORK_JOBS_COPY,
  inProgressCount,
  inProgressLabel,
  itemsForFilter,
  keepNeedsMeSlots,
  reportedSummary,
  requesterToAgent,
  rowNeedsMe,
  searchWithFilter,
  workJobStateLabel,
  workJobResultHasControls,
  workJobResultKind,
  workJobRow,
  workJobSections,
  type NeedsMeAsk,
  type NeedsMeSlot,
  type WorkFilter,
  type WorkJobResultKind,
  type WorkJobRow,
} from "@momo/core/features/workbench/workJobs";
import { TEAM_BOARD_COPY, isRunItem } from "@momo/core/features/workbench/teamBoard";
import { LOCAL_TERMINALS_PATH, agentPanePath } from "@momo/core/features/workbench/workTab";
import { SESSION_STATUS_LABEL } from "@momo/core/features/workbench/sessionList";
import { PANE_MARK_LABEL, isFailedMark } from "@momo/core/features/workbench/paneStatus";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { decisionNote } from "@/features/inbox/approvalsPanel";
import { useInvalidateApprovals } from "@/features/inbox/useInbox";
import { useWorkDecisions, type DecidableApproval } from "@/features/inbox/useNeedsMe";
import { useLocalPaneAttention } from "@/features/workbench/local/paneAttention";
import { TeamBoardDrawer } from "@/features/workTab/teamBoard/TeamBoardDrawer";
import { StateChip } from "@/features/workTab/teamBoard/TeamBoardParts";
import { useTeamBoardItem, useTeamBoardRail } from "@/features/workTab/teamBoard/useTeamBoard";
import {
  rememberWorkReturnSpot,
  takeWorkReturnSpot,
  workConsoleSessionPath,
} from "@/features/workConsole/model";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { isDesktop } from "@/lib/tauri";
import {
  JobResultActions,
  JobResultCell,
  decidesInRow,
  type JobApprovalFacts,
} from "./WorkJobResult";
import { currentWorkFilter, rememberWorkFilter, useWorkJobsList } from "./useWorkJobs";

// Reading this as: 「작업」 한 화면(결과 중심 목록 + 서랍) for internal team users on web+Tauri,
// density 7/10, motion 0/10.
//
// ADR-0202 D1·D2·D6 (U1 #3842). 줄 하나 = 맡긴 일 하나. 열은 작업 · 결과 · 상태 · 작업 시간 · 요청 채널(owner 2026-11-11)이고,
// 줄이 말하는 것은 결과다: 결과 칸 머리의 꼬리표가 승인 요청 · 권한 요청 · 에이전트 보고를 가른다(`WorkJobResult`). 진행 스트림은
// 줄을 열면 서랍(기존 `TeamBoardDrawer`)에서만 본다. 승인 단추는 「내 작업」 「응답 필요」의 내 run 줄에, 그 승인의 결정자 본인에게만
// 선다(ADR-0202 증보 2026-11-11: 인박스·대화 카드와 같은 결정 부품·같은 원장·같은 라우트). 그 밖의 승인 대기 줄은 카드가 있는 채널로
// 간다. 「팀 전체」와 남의 줄에는 단추가 없다(D5 「대신 승인 없음」). 남의 터미널·화면은 여기에 오지 않는다(D5).
//
// 한 작업 = 한 덩어리(owner 2026-11-11): 줄마다 아래에 머리카락 선 하나를 두고, 딸린 컨트롤(승인·거부, 카드 링크, PR 링크)은 줄 아래
// 따로 서지 않고 결과 열 안으로 내려앉는다.
//
// 필터는 주소가 정본이다(`?who=mine|team`, 옛 `?view=team`은 「팀 전체」). 주소가 말하지 않으면
// 기기 기억, 그것도 없으면 「내 것」(D2).
//
// 키보드: j/k 또는 위·아래 화살표로 줄을 옮기고, Enter가 서랍을 열고, Esc가 닫고 열었던 줄로
// 돌아온다. 줄은 로빙 tabindex 한 벌이다(팀 보드와 같은 문법).
//
// 「응답 필요」 구간(#5640, ADR-0202 D1·D5, ADR-0188 D5): 「내 작업」 맨 위. 줄을 올리는 판정은 코어 `rowNeedsMe` 하나다 —
// 내 맥 세션은 서버가 준 상태 `waiting`(#5639)만, 내가 맡긴 run은 인박스 배지와 같은 승인 원장·같은 판정
// (`useWorkDecisions`)만 읽는다. 화면이 세션마다 진행을 따로 읽어 짐작하지 않는다. 내 맥 세션 줄의 Enter·클릭과 결과 칸의
// 「열어서 답하기」는 서랍이 아니라 승인 카드로 간다: 데스크탑은 그 세션의 A 칸(`agentPanePath`, 격자가 카드에 초점), 브라우저는
// 세션 화면(작업 콘솔)이고 허락은 결과 칸의 한 줄이 폰·데스크탑 앱으로 안내한다(브라우저에는 허락 카드가 없다, ADR-0146 D-4).
//
// 갱신: 그 세션의 권한 요청·결정(ACP `approval.*`)이 실시간으로 오면 다시 읽는다. 60초 박자는 실시간이 끊겼거나 듣지 못하는
// 채널이 있을 때만이다. 줄이 구간 사이를 옮겨도 초점은 그 줄을 따라가고, 스크롤한 목록은 보던 줄이 제자리에 남는다(움직임 없음).
//
// 「응답 필요」의 칸은 화면에 떠 있는 동안 자리를 지킨다(#5738, 코어 `keepNeedsMeSlots`): 결정한 줄은 같은 상자의 결과 줄이 되고,
// 다른 곳에서 끝난 줄도 그 자리의 결과 줄이 되며, 새 요청은 구간 맨 아래에 붙는다. 그래서 방금 누른 자리에 다른 줄의 결정 단추가
// 오지 않는다. 시간·포인터로 막지 않는다(남은 막기는 같은 단추의 연타를 거르는 「보내는 중」뿐이다, `ApprovalActions`).

const MINUTE_MS = 60_000;

/**
 * 「응답 필요」 칸이 그리는 사실(#5738): run 줄은 묻는 승인과 서버가 쓴 카드 문장, 내 맥 세션의 권한 요청은 없음. 칸이 처음 선 때의 것을
 * 끝까지 쓴다 — 늦게 온 카드 문장이 줄 높이를 바꾸어 아래 줄의 단추를 손 밑으로 옮기지 않게.
 */
interface SlotFacts {
  decision: DecidableApproval;
  intent: string | null;
}
type Slot = NeedsMeSlot<SlotFacts | null>;

const NO_RECEIPTS: ReadonlyMap<string, string> = new Map();
const NO_KEYS: ReadonlySet<string> = new Set();

/** 줄의 run 열쇠(소문자) — `rowNeedsMe`가 원장과 맞추는 것과 같은 값. */
function runKeyOf(row: WorkJobRow): string {
  return (row.item.runId ?? row.item.sessionId).toLowerCase();
}

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function WorkJobsRoute() {
  const { workspaceId, session, realtime, connStatus } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const offline = useOffline();
  const [params, setParams] = useSearchParams();
  const openId = params.get("card");
  const filter = currentWorkFilter(location.search);
  const nowMs = useMinuteNow();
  const desktop = isDesktop();
  const formatMessage = useFormatMessage();
  const selfId = session.member.id;

  // 실시간이 붙어 있으면 60초 박자를 멈춘다(듣지 못하는 채널이 있으면 `useWorkJobsList`가 박자를 지킨다).
  const live = realtime !== null && isRealtimeConnected(connStatus);
  const list = useWorkJobsList(workspaceId, filter, live);
  useTeamBoardRail(workspaceId, list.items, { rereadOnApproval: true });
  const decisions = useWorkDecisions();
  const invalidateApprovals = useInvalidateApprovals();
  // 그 자리 결정의 결과 한 줄(받은함과 같은 문장, `decisionNote`)을 낭독한다. 보이는 영수증은 그 칸에 선다.
  const [decisionText, setDecisionText] = useState("");

  const chooseFilter = useCallback(
    (next: WorkFilter) => {
      rememberWorkFilter(next);
      navigate(
        { pathname: location.pathname, search: searchWithFilter(location.search, next) },
        { replace: true }
      );
    },
    [location.pathname, location.search, navigate]
  );

  const rows = useMemo<WorkJobRow[]>(
    () =>
      itemsForFilter(list.items, filter, session.member.id, list.mode).map((item) =>
        workJobRow(item, nowMs)
      ),
    [list.items, list.mode, filter, session.member.id, nowMs]
  );

  // ---- 「응답 필요」의 칸 (#5738) -----------------------------------------------------------------------------------------------
  // 구간이 화면에 떠 있는 동안 칸은 자리를 지킨다(코어 `keepNeedsMeSlots`): 결정한 칸은 그 자리의 결과 칸이 되고, 내가 일으키지 않은
  // 변화(다른 기기의 결정, 새 요청, 서버의 순서)도 칸을 옮기지 않으며, 새 요청은 맨 아래에 붙는다. 그래서 방금 누른 자리에 다른 줄의
  // 결정 단추가 오지 않는다 — 시간·포인터 규칙 없이. 칸이 정리되는 것은 「작업」을 떠났다 돌아올 때(이 화면이 새로 선다)와 「내 작업/팀
  // 전체」를 갈아탈 때(`scope`)뿐이다.
  const scope = `${workspaceId}:${filter}`;
  const [receiptsState, setReceiptsState] = useState<{ scope: string; byKey: ReadonlyMap<string, string> }>({
    scope,
    byKey: NO_RECEIPTS,
  });
  const receipts = receiptsState.scope === scope ? receiptsState.byKey : NO_RECEIPTS;
  const [sendingState, setSendingState] = useState<{ scope: string; keys: ReadonlySet<string> }>({ scope, keys: NO_KEYS });
  const sending = sendingState.scope === scope ? sendingState.keys : NO_KEYS;
  const asks = useMemo<NeedsMeAsk<SlotFacts | null>[]>(() => {
    if (filter !== "mine") return [];
    const approvalRunIds = new Set(decisions.byRun.keys());
    return rows
      .filter((row) => rowNeedsMe(row, { filter, selfMemberId: selfId, approvalRunIds }))
      .map((row) => {
        const decision = isRunItem(row.item) ? (decisions.byRun.get(runKeyOf(row)) ?? null) : null;
        return {
          row,
          askId: decision?.approvalId ?? null,
          facts:
            decision === null
              ? null
              : { decision, intent: decisions.intentFor(row.channelId, row.item.runId ?? row.id, decision.approvalId) },
        };
      });
  }, [rows, filter, selfId, decisions]);
  const slotsRef = useRef<{ scope: string; slots: Slot[] }>({ scope, slots: [] });
  const slots = useMemo(() => {
    const previous = slotsRef.current.scope === scope ? slotsRef.current.slots : [];
    const next = keepNeedsMeSlots(previous, asks, { decidedHere: new Set(receipts.keys()), sending });
    slotsRef.current = { scope, slots: next };
    return next;
  }, [scope, asks, receipts, sending]);
  const onDecided = useCallback(
    (outcome: DecisionOutcome, slotKey: string) => {
      const receipt = decisionNote(outcome).text;
      setDecisionText(receipt);
      setReceiptsState((current) => ({
        scope,
        byKey: new Map(current.scope === scope ? current.byKey : NO_RECEIPTS).set(slotKey, receipt),
      }));
      // 받은함과 같이 원장을 다시 읽고(배지가 함께 바뀐다), 줄의 phase가 바뀌었으니 목록도 다시 읽는다. 칸은 그대로다.
      invalidateApprovals();
      void list.refetch();
    },
    [scope, invalidateApprovals, list]
  );
  const onSending = useCallback(
    (slotKey: string, busy: boolean) => {
      setSendingState((current) => {
        const keys = new Set(current.scope === scope ? current.keys : NO_KEYS);
        if (busy) keys.add(slotKey);
        else keys.delete(slotKey);
        return { scope, keys };
      });
    },
    [scope]
  );
  // 칸에 선 줄은 다른 구간에 두 번 서지 않는다(결정 뒤 그 run이 「지금」·「끝난 일」로 갈 차례여도, 칸이 정리될 때까지).
  const sections = useMemo(() => {
    const inSlots = new Set(slots.map((slot) => slot.row.id.toLowerCase()));
    const rest = workJobSections(rows.filter((row) => !inSlots.has(row.id.toLowerCase())));
    return slots.length === 0
      ? rest.map((section) => ({ ...section, slots: null }))
      : [
          { key: NEEDS_ME_SECTION, label: WORK_JOBS_COPY.sectionNeedsMe, rows: slots.map((slot) => slot.row), slots },
          ...rest.map((section) => ({ ...section, slots: null })),
        ];
  }, [rows, slots]);
  const running = inProgressCount(rows);

  const fromList =
    openId === null ? null : list.items.find((i) => uuidEq(i.sessionId, openId)) ?? null;
  // 단건 읽기는 세션 전용이다(실행 줄은 목록의 줄이 정본이다).
  const single = useTeamBoardItem(workspaceId, openId, fromList === null || !isRunItem(fromList));
  const openItem: SharedWorkSession | null = single.data ?? fromList;
  const drawerGone = openId !== null && single.gone && fromList === null;

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const lastOpenedRef = useRef<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** 그 작업의 줄 단추(서랍을 닫고 돌아갈 곳). 칸 둘에 선 run이면 아직 묻는 칸이 먼저다. */
  const rowElementOf = useCallback((id: string): HTMLButtonElement | null => {
    const direct = rowRefs.current.get(id.toLowerCase());
    if (direct) return direct;
    const matches = [...rowRefs.current.values()].filter((el) => el.dataset.jobId !== undefined && uuidEq(el.dataset.jobId, id));
    return matches.at(-1) ?? null;
  }, []);

  const setCard = useCallback(
    (id: string | null) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (id === null) next.delete("card");
        else next.set("card", id);
        return next;
      });
    },
    [setParams]
  );
  const close = useCallback(() => setCard(null), [setCard]);
  useEscapeLayer(openId !== null, close);

  const drawerReady = openItem !== null;
  useEffect(() => {
    if (openId === null) return;
    lastOpenedRef.current = openId;
    drawerRef.current?.focus();
  }, [openId, drawerReady]);
  useEffect(() => {
    if (openId !== null) return;
    const last = lastOpenedRef.current;
    if (last === null) return;
    lastOpenedRef.current = null;
    (rowElementOf(last) ?? listRef.current)?.focus();
  }, [openId, rowElementOf]);

  const [goneNotice, setGoneNotice] = useState(false);
  useEffect(() => {
    if (!drawerGone) return;
    setGoneNotice(true);
    setCard(null);
  }, [drawerGone, setCard]);
  useEffect(() => {
    if (openId !== null) setGoneNotice(false);
  }, [openId]);

  // 줄 열쇠: 「응답 필요」의 칸은 칸 열쇠(같은 run이 다음 승인을 물으면 그 run이 칸 둘에 선다), 그 밖은 줄 id. 로빙 초점·캐럿 복귀·
  // 스크롤 고정이 이 열쇠로 줄을 찾는다.
  const orderedKeys = useMemo(
    () => sections.flatMap((s) => (s.slots ? s.slots.map((slot) => slot.key) : s.rows.map((r) => r.id.toLowerCase()))),
    [sections]
  );
  const sectionOf = useMemo(
    () =>
      new Map(
        sections.flatMap((s) =>
          s.slots ? s.slots.map((slot) => [slot.key, s.key] as const) : s.rows.map((r) => [r.id.toLowerCase(), s.key] as const)
        )
      ),
    [sections]
  );

  // 줄이 구간을 옮기면(지금 → 응답 필요) 그 줄은 다른 목록에서 새로 서고, 그 줄에 있던 캐럿은 body로 떨어진다. 그 줄로 돌려준다.
  const focusedRowRef = useRef<{ key: string; id: string; el: HTMLElement } | null>(null);
  const onRowFocus = useCallback((key: string, id: string, el: HTMLElement) => {
    focusedRowRef.current = { key, id, el };
  }, []);
  const onRowBlur = useCallback((event: FocusEvent<HTMLButtonElement>) => {
    const el = event.currentTarget;
    if (event.relatedTarget !== null) {
      if (focusedRowRef.current?.el === el) focusedRowRef.current = null;
      return;
    }
    // 받는 곳 없는 blur는 둘 중 하나다: 사람이 빈 곳을 눌렀거나(줄은 그대로 있다), 줄이 구간을 옮겨 DOM에서 빠졌다.
    queueMicrotask(() => {
      if (el.isConnected && focusedRowRef.current?.el === el) focusedRowRef.current = null;
    });
  }, []);

  // 스크롤한 목록에서 줄이 구간을 옮겨도 보던 줄이 밀리지 않게 한다. 데스크탑 셸(WebKit)은 브라우저의 스크롤 고정(overflow-anchor)이
  // 없어 직접 맞춘다: 보이는 줄 가운데 구간이 그대로인 첫 줄을 제자리에 둔다. 맨 위(scrollTop 0)에서는 맞추지 않는다 — 새로 선
  // 「응답 필요」가 보여야 한다. 움직임은 없다(scrollTop을 한 번에 고친다).
  const anchorsRef = useRef<RowAnchor[]>([]);
  const readAnchors = useCallback(() => {
    anchorsRef.current = visibleRowAnchors(listRef.current);
  }, []);
  useLayoutEffect(() => {
    const last = focusedRowRef.current;
    if (last !== null && !last.el.isConnected) {
      const active = document.activeElement;
      const next = rowRefs.current.get(last.key) ?? rowElementOf(last.id);
      if (next && (active === null || active === document.body)) {
        next.focus({ preventScroll: true });
        focusedRowRef.current = { key: next.dataset.rowKey ?? last.key, id: last.id, el: next };
      } else if (!next) {
        focusedRowRef.current = null;
      }
    }
    const list = listRef.current;
    if (list !== null && list.scrollTop > 0) {
      const top = list.getBoundingClientRect().top;
      for (const anchor of anchorsRef.current) {
        if (sectionOf.get(anchor.key) !== anchor.section) continue;
        const el = rowRefs.current.get(anchor.key);
        if (!el) continue;
        const delta = el.getBoundingClientRect().top - top - anchor.offset;
        if (delta !== 0) list.scrollTop += delta;
        break;
      }
    }
    readAnchors();
  }, [sectionOf, readAnchors, rowElementOf]);
  // 세션 상세에서 돌아왔으면 열었던 줄에 초점을 두고 스크롤을 되돌린다(한 번, #5673). 줄이 아직 없으면(첫 읽기 중) 다음 렌더에서 다시 본다.
  const returnSpotRef = useRef<{ rowId: string; scrollTop: number } | null | undefined>(undefined);
  useLayoutEffect(() => {
    // 되찾는 것은 세션 화면에서 「← 작업」·브라우저 뒤로 돌아온 방문뿐이다. 사이드바로 새로 들어온 방문은 묵은 자리를 버린다.
    if (returnSpotRef.current === undefined) {
      const spot = takeWorkReturnSpot();
      const back = navigationType === "POP" || (location.state as { restoreWork?: boolean } | null)?.restoreWork === true;
      returnSpotRef.current = back ? spot : null;
    }
    const spot = returnSpotRef.current;
    if (spot === null || spot === undefined) return;
    const row = rowElementOf(spot.rowId);
    if (row === null) return;
    returnSpotRef.current = null;
    const list = listRef.current;
    if (list !== null) list.scrollTop = spot.scrollTop;
    setActiveKey(row.dataset.rowKey ?? spot.rowId.toLowerCase());
    row.focus({ preventScroll: true });
    // 자리를 비운 사이 줄이 옮겨 갔으면 되돌린 스크롤에서 줄이 가려질 수 있다: 보이게만 맞춘다.
    row.scrollIntoView?.({ block: "nearest" });
  });
  const rovingKey =
    activeKey !== null && orderedKeys.includes(activeKey) ? activeKey : (orderedKeys[0] ?? null);

  const moveFocus = useCallback(
    (from: string, delta: number | "first" | "last") => {
      const index = orderedKeys.indexOf(from);
      let next = index;
      if (delta === "first") next = 0;
      else if (delta === "last") next = orderedKeys.length - 1;
      else next = Math.min(orderedKeys.length - 1, Math.max(0, index + delta));
      const key = orderedKeys[next];
      if (key === undefined) return;
      setActiveKey(key);
      rowRefs.current.get(key)?.focus();
    },
    [orderedKeys]
  );

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(key, 1);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(key, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(key, "first");
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(key, "last");
    }
  };

  // 서랍은 연 줄과 같은 말을 한다(#5640 수리 3회차, 검수 질문 ③): 칩 낱말, 그리고 목록에서 바로 결정하는 줄이면 「그 카드에서」가 아니다.
  // 「응답 필요」인 것은 아직 묻는 칸에 선 줄뿐이다(결과 칸은 아니다).
  const openRow = openId === null ? null : (rows.find((r) => uuidEq(r.id, openId)) ?? null);
  const openSlot = openId === null ? null : (slots.find((slot) => slot.settled === null && uuidEq(slot.row.id, openId)) ?? null);
  const openNeeds = openRow !== null && openSlot !== null;
  const openDecision = openSlot?.facts?.decision ?? null;
  const drawerFacts = {
    stateLabel: openRow === null ? undefined : workJobStateLabel(openRow, openNeeds, formatMessage),
    approvalHint:
      openDecision !== null && decidesInRow(openDecision)
        ? formatMessage("desktop.workJobs.approvalHintInList")
        : undefined,
  };
  const sectionCount = (section: (typeof sections)[number]) =>
    section.slots ? section.slots.filter((slot) => slot.settled === null).length : section.rows.length;

  const hasData = list.data !== undefined;
  const firstLoad = list.isPending && !hasData;
  const blockingError = list.error !== null && !hasData;
  const staleError = list.error !== null && hasData;
  const drawerOpen = openId !== null && !drawerGone;

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="work-jobs-route" data-filter={filter}>
      <header className="flex h-work-board-bar shrink-0 items-center gap-3 border-b border-line px-4">
        <SidebarDrawerToggle />
        <h1 className="flex min-w-0 items-center gap-2 text-title font-bold text-ink">
          <ListChecks aria-hidden className="size-4 shrink-0 text-icon" />
          <span className="truncate">{WORK_JOBS_COPY.title}</span>
        </h1>
        {hasData && (
          <span
            className="shrink-0 text-meta text-ink-muted"
            data-testid="work-jobs-running"
            aria-live="polite"
          >
            <span data-numeric>{inProgressLabel(running, list.hasNextPage)}</span>
          </span>
        )}
        <div
          role="group"
          aria-label={WORK_JOBS_COPY.filterGroup}
          className="ms-auto flex shrink-0 gap-1 rounded-lg bg-surface-muted p-1"
        >
          {(
            [
              ["mine", WORK_JOBS_COPY.filterMine],
              ["team", WORK_JOBS_COPY.filterTeam],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => chooseFilter(key)}
              data-testid={`work-jobs-filter-${key}`}
              className={cn(
                "h-control-sm rounded-md px-3 text-meta font-medium press focus-visible:focus-ring",
                filter === key ? "bg-surface text-ink shadow-sm" : "text-ink-muted hover:text-ink"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {offline && !hasData && (
        <InlineBanner tone="neutral" message={WORK_JOBS_COPY.offlineEmpty} testId="work-jobs-offline" />
      )}
      {staleError && !offline && (
        <InlineBanner
          message={WORK_JOBS_COPY.staleError}
          actionLabel={WORK_JOBS_COPY.errorAction}
          onAction={() => void list.refetch()}
          testId="work-jobs-stale-error"
        />
      )}
      {hasData && list.mode === "legacy" && (
        <InlineBanner tone="neutral" message={WORK_JOBS_COPY.legacyNotice} testId="work-jobs-legacy" />
      )}
      {goneNotice && (
        <InlineBanner
          tone="neutral"
          message="이 작업은 더 이상 보이지 않아요. 공유가 꺼졌거나 이 채널의 멤버가 아니에요."
          actionLabel="닫기"
          onAction={() => setGoneNotice(false)}
          testId="work-jobs-gone"
        />
      )}

      <div className="team-board-layout" data-drawer={drawerOpen ? "" : undefined}>
        <div
          ref={listRef}
          tabIndex={-1}
          data-team-board-list=""
          className="work-jobs-list flex min-h-0 min-w-0 flex-col overflow-y-auto focus-visible:focus-ring"
          aria-label={WORK_JOBS_COPY.listLabel}
          aria-busy={firstLoad}
          role="region"
          onScroll={readAnchors}
        >
          {desktop && filter === "mine" && <ThisDeviceStrip />}
          {firstLoad ? (
            <Skeleton ready={false} rows={6} className="p-4" />
          ) : blockingError ? (
            <EmptyInvite
              headline={WORK_JOBS_COPY.errorTitle}
              detail={WORK_JOBS_COPY.errorBody}
              testId="work-jobs-error"
              actions={
                <Button
                  type="button"
                  size="sm"
                  className="tap-target"
                  onClick={() => void list.refetch()}
                  data-testid="work-jobs-retry"
                >
                  {WORK_JOBS_COPY.errorAction}
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyInvite
              headline={filter === "mine" ? WORK_JOBS_COPY.emptyMineTitle : WORK_JOBS_COPY.emptyTeamTitle}
              detail={filter === "mine" ? WORK_JOBS_COPY.emptyMineBody : WORK_JOBS_COPY.emptyTeamBody}
              testId="work-jobs-empty"
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="tap-target"
                  onClick={() => navigate("/")}
                  data-testid="work-jobs-empty-action"
                >
                  {WORK_JOBS_COPY.emptyAction}
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col px-2 pb-4" data-testid="work-jobs-table">
              <p className="sr-only" role="status" data-testid="work-jobs-decision-note">
                {decisionText}
              </p>
              <div
                aria-hidden
                className="work-jobs-row border-b border-line px-3 py-2 text-timestamp font-semibold text-ink-muted"
              >
                <span>{WORK_JOBS_COPY.colTask}</span>
                <span data-col="result">{WORK_JOBS_COPY.colResult}</span>
                <span>{WORK_JOBS_COPY.colState}</span>
                <span data-col="duration">{WORK_JOBS_COPY.colDuration}</span>
                <span data-col="channel">{WORK_JOBS_COPY.colChannel}</span>
              </div>
              {sections.map((section) => (
                <section
                  key={section.key}
                  aria-label={`${section.label} ${sectionCount(section)}개`}
                  data-testid="work-jobs-section"
                  data-section={section.key}
                >
                  <h2 className="px-3 pt-3 pb-1 text-meta font-semibold text-ink-muted">
                    {section.label}{" "}
                    <span data-numeric className="font-mono font-normal" data-testid="work-jobs-section-count">
                      {sectionCount(section)}
                    </span>
                  </h2>
                  <ul className="flex flex-col">
                    {section.slots
                      ? section.slots.map((slot) => {
                          // 칸에 선 줄(#5738): 아직 묻는 칸은 그 사실로 단추를, 결과 칸은 같은 상자에 결과 한 줄을 세운다. 줄은 칸이 처음
                          // 선 때의 것으로 그리고(높이를 지키려고), 결과 칸의 칩만 지금 목록이 말하는 상태다.
                          const live = rows.find((r) => uuidEq(r.id, slot.row.id)) ?? null;
                          const row = workJobRow(slot.row.item, nowMs);
                          const kind = workJobResultKind(row, true);
                          const permission = kind === "permission";
                          const openPermission = () => {
                            if (desktop) {
                              navigate(agentPanePath(row.id));
                              return;
                            }
                            // 세션 상세에서 돌아오면 이 줄에 초점과 스크롤이 되돌아온다(#5673).
                            rememberWorkReturnSpot({ rowId: row.id, scrollTop: listRef.current?.scrollTop ?? 0 });
                            navigate(workConsoleSessionPath(row.id));
                          };
                          const result =
                            slot.settled === null
                              ? null
                              : slot.settled === "mine"
                                ? (receipts.get(slot.key) ?? "")
                                : formatMessage("desktop.workJobs.settledElsewhere");
                          return (
                            <JobRow
                              key={slot.key}
                              rowKey={slot.key}
                              row={row}
                              needsMe
                              stateLabel={
                                slot.settled === null
                                  ? workJobStateLabel(row, true, formatMessage)
                                  : workJobStateLabel(live ?? row, false, formatMessage)
                              }
                              kind={kind}
                              permission={permission}
                              inApp={permission && !desktop ? formatMessage("desktop.workPermission.allowInApp") : null}
                              settledLine={result}
                              approval={
                                kind === "approval"
                                  ? slotApprovalFacts(slot, result)
                                  : null
                              }
                              desktop={desktop}
                              onOpenPermission={() => {
                                setActiveKey(slot.key);
                                openPermission();
                              }}
                              onDecided={(outcome) => onDecided(outcome, slot.key)}
                              onSending={(busy) => onSending(slot.key, busy)}
                              selected={openId !== null && uuidEq(row.id, openId)}
                              tabStop={rovingKey === slot.key}
                              rowRef={(el) => {
                                if (el) rowRefs.current.set(slot.key, el);
                                else rowRefs.current.delete(slot.key);
                              }}
                              onOpen={() => {
                                setActiveKey(slot.key);
                                if (permission && slot.settled === null) openPermission();
                                else setCard(row.id);
                              }}
                              onKeyDown={(e) => onRowKeyDown(e, slot.key)}
                              onFocus={onRowFocus}
                              onBlur={onRowBlur}
                            />
                          );
                        })
                      : section.rows.map((row) => {
                          const key = row.id.toLowerCase();
                          const kind = workJobResultKind(row, false);
                          return (
                            <JobRow
                              key={row.id}
                              rowKey={key}
                              row={row}
                              needsMe={false}
                              stateLabel={workJobStateLabel(row, false, formatMessage)}
                              kind={kind}
                              permission={false}
                              inApp={null}
                              settledLine={null}
                              approval={kind === "approval" ? approvalFacts(row, decisions) : null}
                              desktop={desktop}
                              onOpenPermission={() => undefined}
                              onDecided={() => undefined}
                              onSending={() => undefined}
                              selected={openId !== null && uuidEq(row.id, openId)}
                              tabStop={rovingKey === key}
                              rowRef={(el) => {
                                if (el) rowRefs.current.set(key, el);
                                else rowRefs.current.delete(key);
                              }}
                              onOpen={() => {
                                setActiveKey(key);
                                setCard(row.id);
                              }}
                              onKeyDown={(e) => onRowKeyDown(e, key)}
                              onFocus={onRowFocus}
                              onBlur={onRowBlur}
                            />
                          );
                        })}
                  </ul>
                </section>
              ))}
              {list.hasNextPage && (
                <div className="px-3 pt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="tap-target"
                    disabled={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                    data-testid="work-jobs-more"
                  >
                    {list.isFetchingNextPage ? WORK_JOBS_COPY.loadingMore : WORK_JOBS_COPY.loadMore}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {drawerOpen && (
          <div data-team-board-drawer="" className="flex min-h-0 min-w-0 flex-col">
            {openItem !== null ? (
              <TeamBoardDrawer
                ref={drawerRef}
                item={openItem}
                nowMs={nowMs}
                onClose={close}
                stateLabel={drawerFacts.stateLabel}
                approvalHint={drawerFacts.approvalHint}
              />
            ) : (
              <aside
                ref={drawerRef}
                tabIndex={-1}
                aria-label={TEAM_BOARD_COPY.drawerLabel}
                className="flex min-h-0 flex-1 flex-col border-s border-line bg-surface focus-visible:focus-ring"
                data-testid="work-jobs-drawer-loading"
              >
                <Skeleton ready={false} rows={6} className="p-4" />
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 보이는 줄 하나의 자리(스크롤 고정의 재료). */
interface RowAnchor {
  /** 줄 열쇠(`data-row-key`). */
  key: string;
  section: string;
  /** 목록 상자 위 가장자리에서 줄 위 가장자리까지(px). */
  offset: number;
}

/** 고정 후보로 적어 두는 보이는 줄의 상한. 줄이 구간을 옮기면 그 줄은 건너뛰고 다음 후보를 쓴다. */
const MAX_ROW_ANCHORS = 8;

function visibleRowAnchors(list: HTMLElement | null): RowAnchor[] {
  if (list === null) return [];
  const box = list.getBoundingClientRect();
  const out: RowAnchor[] = [];
  for (const el of list.querySelectorAll<HTMLElement>('[data-testid="work-job-row"]')) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
    const key = el.dataset.rowKey;
    const section = el.closest<HTMLElement>("[data-section]")?.dataset.section;
    if (key === undefined || section === undefined) continue;
    out.push({ key, section, offset: rect.top - box.top });
    if (out.length >= MAX_ROW_ANCHORS) break;
  }
  return out;
}

/**
 * 「응답 필요」 칸의 승인 사실(#5738). 아직 묻는 칸은 칸이 처음 선 때의 승인과 카드 문장으로 단추를 세운다(그 칸의 승인 id는 바뀌지
 * 않는다 — 같은 run의 다음 승인은 맨 아래 새 칸이다). 결과 칸은 단추 대신 결과 한 줄(`receipt`)이고, 결정 전의 꼬리표·되돌릴 수
 * 없음·만료는 자리만 남긴다(`JobResultCell`) — 무엇을 결정했는지(요약)는 그대로 보인다.
 */
function slotApprovalFacts(slot: Slot, result: string | null): JobApprovalFacts {
  const facts = slot.facts;
  return {
    decision: result === null ? (facts?.decision ?? null) : null,
    item: facts?.decision.item ?? null,
    intent: facts?.intent ?? null,
    waiting: null,
    receipt: result,
  };
}

/**
 * 「응답 필요」 밖 승인 요청 줄이 아는 사실: 서버가 쓴 카드 문장, 결정자가 아닐 때의 대기 줄. 단추는 없다 — 결정은 「응답 필요」 칸에만
 * 선다(그 구간이 곧 「내 작업」 · 내가 맡긴 run · 인박스와 같은 판정으로 내가 결정할 승인이다, `rowNeedsMe`). 「팀 전체」와 남의 줄은
 * 원장에 같은 승인이 있어도 단추가 없다(ADR-0202 D5 「대신 승인 없음」). 대기 줄은 원장이 답했고 그 승인이 원장의 내 결정 목록에 없을
 * 때만 선다 — 원장이 오는 중이거나 없는 서버, 또는 내가 결정할 수 있는데 「팀 전체」라 단추만 없는 줄에서 「기다려요」를 지어내지 않는다.
 */
function approvalFacts(row: WorkJobRow, decisions: ReturnType<typeof useWorkDecisions>): JobApprovalFacts {
  const runId = row.item.runId ?? row.id;
  const mine = decisions.byRun.get(runId.toLowerCase()) ?? null;
  return {
    decision: null,
    item: mine?.item ?? null,
    intent: decisions.intentFor(row.channelId, runId, mine?.approvalId),
    waiting: mine === null && decisions.ledgerKnown ? approvalWaitingLine() : null,
    receipt: null,
  };
}

function JobRow({
  rowKey,
  row,
  needsMe,
  stateLabel,
  kind,
  permission,
  inApp,
  settledLine,
  approval,
  desktop,
  onOpenPermission,
  onDecided,
  onSending,
  selected,
  tabStop,
  rowRef,
  onOpen,
  onKeyDown,
  onFocus,
  onBlur,
}: {
  /** 줄 열쇠: 「응답 필요」 칸은 칸 열쇠, 그 밖은 줄 id(소문자). */
  rowKey: string;
  row: WorkJobRow;
  needsMe: boolean;
  /** 상태 칩 낱말(코어 `workJobStateLabel`: 「응답 필요」는 구간에서 답을 기다리는 줄만). */
  stateLabel: string;
  /** 결과 칸이 말하는 종류(코어 `workJobResultKind`). */
  kind: WorkJobResultKind;
  /**
   * 내 맥 세션의 권한 요청 줄(「응답 필요」). 누르면 서랍 대신 승인 카드로 간다: 데스크탑은 그 세션의 A 칸, 브라우저는 세션 화면.
   */
  permission: boolean;
  /** 권한 요청 줄, 브라우저에서만 서는 안내(허락은 폰·데스크탑 앱에서). */
  inApp: string | null;
  /** 결과 칸(#5738)의 결과 한 줄: 권한 요청 칸이 더는 묻지 않을 때. 승인 칸은 `approval.receipt`가 말한다. */
  settledLine: string | null;
  approval: JobApprovalFacts | null;
  desktop: boolean;
  onOpenPermission: () => void;
  onDecided: (outcome: DecisionOutcome) => void;
  /** 그 칸의 결정이 서버에 나가 있는 동안(칸이 「다른 곳에서」로 바뀌지 않게). */
  onSending: (busy: boolean) => void;
  selected: boolean;
  tabStop: boolean;
  rowRef: (element: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onFocus: (key: string, id: string, element: HTMLElement) => void;
  onBlur: (event: FocusEvent<HTMLButtonElement>) => void;
}) {
  const reported = reportedSummary(row.reported);
  const result = (
    <JobResultCell row={row} kind={kind} reported={reported} approval={approval} inApp={inApp} settledLine={settledLine} />
  );
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    // 한 작업 = 한 덩어리: 줄 단추와 결과 열의 컨트롤이 한 `li` 안에 서고, 덩어리 사이는 머리카락 선 하나다(가장 조용한 구분).
    //
    // 줄의 띠(가리킴·펼침·눌림 채움과 키보드 초점 링)는 `li`가 그린다(#5640 수리 2회차, 둥근 호버 채움이 구분선과 어울리지 않는다는
    // owner 검수): 구분선 사이를 끝에서 끝까지 채우는 **각진** 띠다(Linear·GitHub 표와 같은 꼴). 줄 단추에 둥근 채움을 두면 컨트롤 층(승인·
    // 거부, PR 링크)이 띠 밖에 남고 모서리가 선과 어긋났다. 띠의 상태는 **직계 줄 단추**에서만 읽는다:
    //   - 가리킴: 포인터가 줄 단추 위일 때만. 컨트롤 층 위에서는 켜지 않는다 — 보조 알약(거부·열기)의 가리킴 채움이 띠와 같은
    //     `--surface-hover`라, 띠가 켜진 채로 알약을 가리키면 알약이 띠에 녹아 사라진다(README 「상태 토큰과 그릇 토큰」과 같은 산술).
    //   - 눌림: 줄 단추를 누를 때만(`li:active`는 안의 승인·거부를 눌러도 켜진다). 가리킴 규칙은 `:not(:active)`로 눌림과 겹치지
    //     않게 둔다 — 두 규칙의 특정도가 같고 `pointer-hover:` 규칙이 CSS에서 뒤에 나와, 겹치면 눌림 채움이 지고 만다(빌드 실측).
    //   - 초점 링: 줄 단추가 키보드 초점일 때 띠 둘레에. 안의 승인·거부에 초점이 가면 그 단추 자신의 링만 선다(두 겹 없음).
    // 줄 안의 칩·단추의 둥근 모서리는 그대로다.
    <li
      className={cn(
        // 구분선은 줄 **위**에 둔다(첫 줄 빼고): 맨 아래에 새 줄이 붙어도 앞 줄의 상자(높이)가 바뀌지 않는다(#5738 — 「마지막 줄은 아래
        // 선 없음」이면 새 줄이 붙는 순간 앞 마지막 줄이 1px 자랐다).
        "border-t border-line first:border-t-0",
        selected ? "bg-surface-hover" : "pointer-hover:has-[>button:hover:not(:active)]:bg-surface-hover",
        // 펼친 줄(띠 = `--surface-hover`) 안의 보조 알약(거부·열기·열어서 답하기)은 가리킴 채움이 띠와 같은 토큰이라 녹는다: 그 줄
        // 안에서만 한 단계 진한 `--surface-pressed`로 가리킨다(#5640 수리 3회차, 검수 질문 ② (a)). 공용 단추 변형은 그대로다.
        selected && "[&>[data-testid=work-job-extras]_.bg-surface-muted:hover]:bg-surface-pressed",
        "has-[>button:active]:bg-surface-pressed has-[>button:focus-visible]:focus-ring"
      )}
      data-testid="work-job"
      data-selected={selected ? "" : undefined}
    >
      <button
        ref={(el) => {
          buttonRef.current = el;
          rowRef(el);
        }}
        type="button"
        tabIndex={tabStop ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        // 권한 요청 줄은 서랍을 열지 않고 다른 화면으로 간다: 펼침 상태를 말하지 않는다.
        aria-expanded={permission ? undefined : selected}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        onFocus={(event) => onFocus(rowKey, row.id, event.currentTarget)}
        onBlur={onBlur}
        data-testid="work-job-row"
        data-job-id={row.id}
        data-row-key={rowKey}
        data-source={row.item.source}
        data-approval={row.awaitingApproval ? "" : undefined}
        data-needs-me={needsMe ? "" : undefined}
        data-permission={permission ? "" : undefined}
        data-result-kind={kind}
        // 단추는 자기 자리를 띠와 **같은 토큰·각진 모서리**로 칠한다(전폭 행의 채움 눌림, 눌림 장부 ADR-0179 D5) — 띠(`li`)와 한
        // 색이라 이음매가 없고, 컨트롤 층까지는 띠가 잇는다. 링은 띠가 그리므로 단추 자신의 링은 걷는다(두 겹 없음).
        className={cn(
          "work-jobs-row w-full px-3 py-2 text-start text-body text-ink focus-visible:outline-none",
          "active:bg-surface-pressed",
          selected ? "bg-surface-hover" : "hover:bg-surface-hover"
        )}
      >
        <span className="flex min-w-0 flex-col" data-col="task">
          {/* 제목과 결과는 한 줄로 자르지 않는다(ADR-0112 D6, #3850 리뷰): 두 줄까지 어절에서 접고,
              폰 줄(`numberOfLines={2}`)과 같은 길이를 보여 준다. 전체는 서랍이 말한다. */}
          <span className="line-clamp-2 break-keep break-words font-medium" title={row.title}>
            {row.title}
          </span>
          <span
            className={cn(
              "truncate text-timestamp",
              row.agentIsMember ? "text-agent" : "text-ink-muted"
            )}
            data-testid="work-job-who"
          >
            {requesterToAgent(row)}
          </span>
          <span data-narrow="" className="min-w-0 flex-col gap-1 pt-1 text-timestamp text-ink-muted">
            {result}
            <span className="truncate">{row.channel}</span>
          </span>
        </span>
        <span className="flex min-w-0 flex-col gap-1" data-col="result">
          {result}
        </span>
        <span data-col="state">
          <StateChip item={row.item} label={stateLabel} />
        </span>
        <span className="text-meta text-ink-muted" data-col="duration" data-testid="work-job-duration">
          {row.durationText ?? ""}
        </span>
        <span className="truncate text-meta text-ink-muted" data-col="channel">
          {row.channel}
        </span>
      </button>
      {workJobResultHasControls(row, kind, desktop) && (
        // 결과 열 안으로 내려앉는 컨트롤(단추 안에 단추를 둘 수 없어 형제로 둔다). 같은 열 격자라 넓을 때는 결과 열, 좁을 때는 첫 열에 선다.
        <div className="work-jobs-row px-3 pb-2" data-testid="work-job-extras">
          <span data-col="extra" className="min-w-0">
            <JobResultActions
              row={row}
              kind={kind}
              approval={approval}
              settledLine={settledLine}
              desktop={desktop}
              onOpenPermission={onOpenPermission}
              onDecided={onDecided}
              onSending={onSending}
              focusRow={() => buttonRef.current?.focus({ preventScroll: true })}
            />
          </span>
        </div>
      )}
    </li>
  );
}

/**
 * 데스크탑 「내 것」의 「이 기기」 줄(ADR-0202 D6): 옛 「내 작업」 격자는 사이드바 줄 없이
 * 여기서 연다. 내 기기의 응답 대기 신호일 뿐 팀 감시가 아니다.
 */
function ThisDeviceStrip() {
  const entries = useLocalPaneAttention();
  const waiting = entries.filter((e) => e.status === "waiting").length;
  // 오류로 끝난 칸은 「끝남」 수에 섞지 않는다(#5584 H1).
  const failed = entries.filter((e) => isFailedMark(e.mark)).length;
  const done = entries.filter((e) => e.status === "done").length - failed;
  const parts = [
    waiting > 0 ? `${SESSION_STATUS_LABEL.waiting} ${waiting}` : null,
    done > 0 ? `${SESSION_STATUS_LABEL.done} ${done}` : null,
    failed > 0 ? `${PANE_MARK_LABEL.failed} ${failed}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <div
      className="flex min-w-0 items-center gap-3 border-b border-line px-4 py-2"
      data-testid="work-jobs-this-device"
    >
      <SquareTerminal aria-hidden className="size-4 shrink-0 text-icon" />
      <span className="min-w-0 truncate text-body text-ink">
        {WORK_JOBS_COPY.thisDevice}
        {parts.length > 0 && <span className="ms-2 text-meta text-ink-muted">{parts.join(" · ")}</span>}
      </span>
      <Button asChild size="sm" variant="secondary" className="ms-auto shrink-0">
        <Link to={LOCAL_TERMINALS_PATH} data-testid="work-jobs-open-terminals">
          {WORK_JOBS_COPY.openTerminals}
        </Link>
      </Button>
    </div>
  );
}
