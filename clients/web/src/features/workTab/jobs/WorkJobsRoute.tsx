import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { ListChecks, SquareTerminal } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
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
  reportedSummary,
  requesterToAgent,
  rowNeedsMe,
  searchWithFilter,
  workJobStateLabel,
  workJobResultHasControls,
  workJobResultKind,
  workJobRow,
  workJobSections,
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
import { workConsoleSessionPath } from "@/features/workConsole/model";
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

const MINUTE_MS = 60_000;

/** 결정한 줄을 그 자리에 붙드는 최소 시간: 영수증을 읽을 틈(#5640 수리 3회차 H1). */
const HOLD_MIN_MS = 1200;
/** 목록이 그 run을 늦게 바꿔도 이만큼 지나면 놓는다(포인터가 구간 위면 여전히 붙든다). */
const HOLD_MAX_MS = 10_000;
const HOLD_TICK_MS = 200;
/** 결정 단추가 새 자리에 선 뒤(그 단추가 「선 때」부터) 그 자리의 포인터 누름을 받지 않는 시간. 마우스가 움직이면 더 일찍 풀린다. */
const SHIFT_GUARD_MS = 1000;
/** 삼킨 누름의 막힌 모양을 보이는 가장 짧은 시간(막기가 곧 끝나도 눈에 띄게, 검수 3회차 L1). */
const GUARD_LOOK_MIN_MS = 600;
/** 「포인터가 움직였다」의 문턱(px). 같은 자리 두 번 누름 사이의 손떨림은 움직임이 아니다. */
const SHIFT_GUARD_MOVE_PX = 6;
/** 결정 단추(승인·거부)의 표지(`ApprovalActions`의 `data-decision`). */
const DECISION_CONTROL = "[data-decision]";

interface PointerSpot {
  x: number;
  y: number;
}

type Box = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "height">;

/**
 * 「같은 자리」의 표지(수리 5회차, 검수 3회차 H1): 누른 점과 누른 결정 단추의 상자. 마우스는 누른 점 6px 안, **터치는 누른 단추의
 * 상자 안**(좁은 폭 44px 표적) — 손가락은 같은 단추를 다시 누를 때 6px 넘게 흩어진다. `touch`는 손가락처럼 누른 손(터치·펜, `fingerLike`).
 */
interface PressMark {
  spot: PointerSpot;
  box: Box | null;
  touch: boolean;
}

/** 붙든 결정: 그 run의 결정, 결정이 닿은 때, 영수증 문장(받은함과 같은 `decisionNote`), 누른 손이 터치였는지와 누른 자리, 그리고
 * 사람이 그 줄을 떠났는지(붙든 줄 상자 밖을 눌렀거나 목록을 굴림 — 터치로 붙든 줄은 이것으로만 놓인다). */
interface HeldDecision {
  decision: DecidableApproval;
  atMs: number;
  receipt: string;
  touch: boolean;
  press: PressMark | null;
  movedOn: boolean;
}

/** 마지막으로 결정 단추를 누른 일(포인터면 그 자리와 종류, 키보드면 자리 없음). */
interface DecisionPress {
  mark: PressMark | null;
  touch: boolean;
}

/** 결정 단추 하나가 지금 자리에 선 일: 자리 표지(「응답 필요」의 몇째 줄 · 화면 좌표), 선 때, 그때의 「같은 자리」 기준들. */
interface Arrival {
  sig: string;
  atMs: number;
  marks: PressMark[];
  released: boolean;
}

/** 붙든 줄의 지금: 붙들었는가, 그리고 원장이 그 run의 **다른** 승인(새 요청)을 내놓았는가. */
function heldStateOf(
  row: WorkJobRow,
  held: ReadonlyMap<string, HeldDecision>,
  byRun: ReadonlyMap<string, DecidableApproval>
): { entry: HeldDecision | null; nextAsk: DecidableApproval | null } {
  const key = runKeyOf(row);
  const entry = held.get(key) ?? null;
  if (entry === null) return { entry, nextAsk: null };
  const next = byRun.get(key) ?? null;
  return { entry, nextAsk: next !== null && !uuidEq(next.approvalId, entry.decision.approvalId) ? next : null };
}

/** 붙든 줄이 있는 동안 「응답 필요」의 칸 순서를 지킨다: 앞서 그린 순서를 먼저, 새로 온 줄은 그 아래에(포인터 밑으로 끼어들지 않게). */
function keepSlots(rows: readonly WorkJobRow[], previous: readonly string[]): WorkJobRow[] {
  const at = new Map(previous.map((id, index) => [id, index] as const));
  const known = rows.filter((row) => at.has(row.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...known, ...rows.filter((row) => !at.has(row.id))];
}

/** 포인터가 그 상자 위인가(자리를 모르면 아니다 — 터치는 손을 떼면 자리가 없다). 상자 높이가 0이면 아니다. */
// eslint-disable-next-line react-refresh/only-export-components -- 붙들기 판정을 시험이 직접 잠그려고 내보낸다.
export function pointerInside(spot: PointerSpot | null, box: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "height"> | null): boolean {
  return spot !== null && box !== null && box.height > 0 && spot.x >= box.left && spot.x <= box.right && spot.y >= box.top && spot.y <= box.bottom;
}

function near(a: PointerSpot, b: PointerSpot): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < SHIFT_GUARD_MOVE_PX;
}

/**
 * 손가락처럼 누르는 포인터(터치·펜, #5712): 화면 위에 자리를 들고 있지 않고(떼면 자리가 없다), 같은 단추를 다시 누를 때 6px 넘게
 * 흩어진다. 마우스 자리(`pointerRef`)는 이 손이 적지도 지우지도 않는다.
 */
function fingerLike(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

/**
 * 그 누름이 표지와 같은 자리인가: 누른 점 6px 안, 또는 누른 단추의 상자 안. 6px만 보는 것은 **표지도 지금 누름도 마우스일 때뿐**이다 —
 * 마우스로 결정하고 손가락으로 다시 누르는 손도 같은 단추를 겨눈다(#5712, 검수 4회차 M2).
 */
function samePlace(spot: PointerSpot, mark: PressMark, mouseNow: boolean): boolean {
  return near(spot, mark.spot) || ((mark.touch || !mouseNow) && pointerInside(spot, mark.box));
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.height > 0 && b.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

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
  // 방금 결정한 줄(#5640 수리 3회차 H1): 원장이 그 승인을 뺀 뒤에도 영수증을 보인 채 「응답 필요」의 그 자리에 잠깐 남는다(`useHeldDecisions`).
  const [held, setHeld] = useState<ReadonlyMap<string, HeldDecision>>(() => new Map());
  const heldRef = useRef(held);
  heldRef.current = held;
  const approvalRunIds = useMemo(() => new Set(decisions.byRun.keys()), [decisions.byRun]);
  /** 마지막으로 결정 단추를 누른 일(`onListClickCapture`가 적는다). 붙든 줄과 움직인 뒤 막기의 기준점이다. */
  const lastPressRef = useRef<DecisionPress | null>(null);
  const invalidateApprovals = useInvalidateApprovals();
  // 그 자리 결정의 결과 한 줄(받은함과 같은 문장, `decisionNote`). 결정이 닿으면 줄이 구간을 옮기므로 결과는 목록 위 상태 노드가 읽는다.
  const [decisionText, setDecisionText] = useState("");
  const onDecided = useCallback(
    (outcome: DecisionOutcome, runKey: string, decision: DecidableApproval) => {
      const receipt = decisionNote(outcome).text;
      setDecisionText(receipt);
      const press = lastPressRef.current;
      setHeld((current) =>
        new Map(current).set(runKey, {
          decision,
          atMs: Date.now(),
          receipt,
          touch: press?.touch ?? false,
          press: press?.mark ?? null,
          movedOn: false,
        })
      );
      // 받은함과 같이 원장을 다시 읽고(배지·「응답 필요」가 함께 바뀐다), 줄의 phase가 바뀌었으니 목록도 다시 읽는다.
      invalidateApprovals();
      void list.refetch();
    },
    [invalidateApprovals, list]
  );

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
  // 붙든 줄은 끝났어도(거부하면 서버가 run을 바로 끝낸다) 「응답 필요」의 그 칸에 남고, 붙든 동안은 칸 순서가 바뀌지 않는다(수리 4회차).
  const needsMeOrderRef = useRef<string[]>([]);
  const sections = useMemo(() => {
    const built = workJobSections(
      rows,
      (row) => rowNeedsMe(row, { filter, selfMemberId: selfId, approvalRunIds }),
      (row) => filter === "mine" && held.has(runKeyOf(row))
    );
    if (held.size === 0) return built;
    return built.map((section) =>
      section.key === NEEDS_ME_SECTION ? { ...section, rows: keepSlots(section.rows, needsMeOrderRef.current) } : section
    );
  }, [rows, filter, selfId, approvalRunIds, held]);
  useEffect(() => {
    needsMeOrderRef.current = sections.find((s) => s.key === NEEDS_ME_SECTION)?.rows.map((r) => r.id) ?? [];
  }, [sections]);
  const running = inProgressCount(rows);

  // ---- 누른 자리에 다른 결정이 서지 않게 (#5640 수리 3회차 H1) -------------------------------------------------------------
  // 받은함은 결정 뒤 다음 줄을 대신 열지 않는다 — 되돌릴 수 없는 컨트롤이 방금 누른 자리에 서면 누른 손이 다음 승인을 결정한다
  // (`InboxRoute`, #5116). 이 목록도 같은 규칙이다. 두 겹으로 막는다:
  //   1. 붙들기: 결정한 줄은 영수증을 보인 채 그 자리에 남는다. 포인터가 「응답 필요」 구간 위에 있는 동안, 그리고 영수증을 읽을
  //      틈(`HOLD_MIN_MS`) 동안은 놓지 않는다. 목록이 아직 그 run을 승인 대기로 말하면 더 기다린다(놓자마자 「지금」에서 「승인
  //      대기」로 서지 않게, 상한 `HOLD_MAX_MS`).
  //   2. 움직인 뒤 잠깐 막기: 결정 단추가 새 자리에 서면(붙든 줄을 놓을 때, 원장이 늦게 와 줄이 올라올 때, 서버의 「못 한다」가
  //      늦게 와 줄이 빠질 때, 위 줄의 높이가 바뀔 때) **그 단추가 선 때부터** `SHIFT_GUARD_MS` 동안 그 자리의 포인터 누름을 받지 않는다.
  // 키보드 초점은 결정 뒤 그 줄 단추에 있고(`focusRow`), 줄이 옮기면 그 줄을 따라간다 — 다음 줄의 단추로 가지 않는다.
  const pointerRef = useRef<PointerSpot | null>(null);
  const needsMeRef = useRef<HTMLElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const byRunRef = useRef(decisions.byRun);
  byRunRef.current = decisions.byRun;
  /** 붙든 run의 줄(`li`). 붙든 줄 상자 안의 누름은 「다른 곳」이 아니다. */
  const heldRowOf = useCallback((runKey: string): HTMLElement | null => {
    const row = rowsRef.current.find((r) => runKeyOf(r) === runKey);
    return row === undefined ? null : (rowRefs.current.get(row.id.toLowerCase())?.closest("li") ?? null);
  }, []);
  /** 사람이 붙든 줄을 떠났다(그 줄 상자 밖을 누름·목록을 굴림): 누른 자리를 잊고, 터치로 붙든 줄은 다음 박자에 놓는다. */
  const moveOn = useCallback((runKeys: readonly string[]) => {
    if (runKeys.length === 0) return;
    setHeld((current) => {
      const next = new Map(current);
      for (const key of runKeys) {
        const entry = next.get(key);
        if (entry !== undefined) next.set(key, { ...entry, press: null, movedOn: true });
      }
      return next;
    });
  }, []);
  const heldNonEmpty = held.size > 0;
  useEffect(() => {
    if (!heldNonEmpty) return;
    const onClick = (event: globalThis.MouseEvent) => {
      if (event.detail === 0) return;
      const spot = { x: event.clientX, y: event.clientY };
      const target = event.target instanceof Node ? event.target : null;
      const left: string[] = [];
      for (const [runKey, entry] of heldRef.current) {
        if (entry.movedOn) continue;
        // 「다른 곳」은 붙든 줄의 상자 밖이다 — 영수증·그 줄의 단추·여백을 다시 누르는 손가락은 아직 그 줄에 있다(수리 5회차 H1).
        const li = heldRowOf(runKey);
        const inside = li !== null && ((target !== null && li.contains(target)) || pointerInside(spot, li.getBoundingClientRect()));
        if (!inside) left.push(runKey);
      }
      moveOn(left);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [heldNonEmpty, heldRowOf, moveOn]);
  useEffect(() => {
    if (held.size === 0) return;
    const tick = () => {
      const now = Date.now();
      const spot = pointerRef.current;
      const box = needsMeRef.current?.getBoundingClientRect() ?? null;
      const pointerOnSection = pointerInside(spot, box);
      const gone: string[] = [];
      const free: string[] = [];
      let underHand = false;
      for (const [runKey, entry] of held) {
        const row = rowsRef.current.find((r) => runKeyOf(r) === runKey) ?? null;
        if (row === null) {
          gone.push(runKey);
          continue;
        }
        const waited = now - entry.atMs;
        // 원장이 그 run의 **다른** 승인(새 요청)을 내놓았으면 그 요청은 영수증 아래 새 줄에 선다(`approvalFacts`) — 붙들기는 같은 규칙으로
        // 끝난다(수리 5회차 M3: 놓이면 새 단추가 누른 그 점으로 올라오므로, 사람이 그 줄을 떠나기 전에는 놓지 않는다).
        const next = byRunRef.current.get(runKey);
        const sameAsk = next === undefined || uuidEq(next.approvalId, entry.decision.approvalId);
        const stillAsking = row.awaitingApproval && sameAsk && waited < HOLD_MAX_MS;
        if (waited >= HOLD_MIN_MS && (entry.touch ? entry.movedOn : !pointerOnSection && !stillAsking)) free.push(runKey);
        else if (entry.press !== null) underHand = true;
      }
      // 아직 손 밑인 붙든 줄(누른 자리가 살아 있음)이 하나라도 있으면 어떤 줄도 놓지 않고, 놓을 때는 함께 놓는다(#5712, 검수 4회차 M1):
      // 위 줄이 빠지면 아래 줄들이 한 칸씩 올라와 다음 줄의 단추가 그 누른 자리에 서고, 「붙든 동안 같은 자리」 삼킴이 그 단추를 끝없이
      // 막는다(줄을 차례로 결정하는 터치에서 셋째 줄이 안 눌림). 입력 종류와 상관없이 같다 — 마우스는 포인터가 구간 위인 동안 원래 이렇다.
      const release = underHand ? gone : [...gone, ...free];
      if (release.length === 0) return;
      setHeld((current) => {
        const next = new Map(current);
        for (const key of release) next.delete(key);
        return next;
      });
    };
    const id = setInterval(tick, HOLD_TICK_MS);
    return () => clearInterval(id);
  }, [held]);

  // 막기(수리 5회차, 검수 3회차 H1·M1): 결정 단추마다 **그 단추가 지금 자리에 선 때**를 적는다(「응답 필요」의 몇째 줄 · 화면 좌표가
  // 바뀌거나 새로 섰을 때, `measureArrivals`). 선 지 `SHIFT_GUARD_MS` 안의 포인터 누름이 「같은 자리」면 삼킨다. 「같은 자리」의 기준은
  // 그 단추가 선 때의 마우스 자리(6px)와 **마지막으로 결정 단추를 누른 자리**(마우스 6px · 터치는 누른 단추의 상자)이고, 기준이 하나도
  // 없으면(터치로 들어와 아직 누른 적 없음) 그 단추의 누름을 모두 삼킨다. 마우스가 모든 기준에서 멀어지면 일찍 풀린다(터치의 손떨림은
  // 움직임이 아니다). 움직이지 않은 단추는 막지 않는다 — 다른 줄을 차례로 결정하는 손은 막히지 않는다.
  const arrivalsRef = useRef(new Map<Element, Arrival>());
  const measuredOnceRef = useRef(false);
  const [guardShown, setGuardShown] = useState(false);
  const guardLookUntilRef = useRef(0);
  const [guardLookAt, setGuardLookAt] = useState(0);
  /** 삼킨 누름의 표시: 결정 단추가 막힌 승인의 모양으로, 막기가 끝날 때까지(적어도 `GUARD_LOOK_MIN_MS`). */
  const showGuardLook = useCallback((untilMs: number) => {
    const now = performance.now();
    guardLookUntilRef.current = Math.max(guardLookUntilRef.current, untilMs, now + GUARD_LOOK_MIN_MS);
    setGuardShown(true);
    setGuardLookAt(now);
  }, []);
  useEffect(() => {
    if (!guardShown) return;
    const id = setTimeout(() => setGuardShown(false), Math.max(0, guardLookUntilRef.current - performance.now()));
    return () => clearTimeout(id);
  }, [guardShown, guardLookAt]);
  const guardMarks = (): PressMark[] => {
    const marks: PressMark[] = [];
    if (pointerRef.current !== null) marks.push({ spot: pointerRef.current, box: null, touch: false });
    const last = lastPressRef.current?.mark ?? null;
    if (last !== null) marks.push(last);
    return marks;
  };
  /** 붙든 줄 안에 선 새 요청의 단추가 방금 누른 단추의 상자와 겹치면(배치가 그렇게 되면) 사람이 그 줄을 떠날 때까지 막는다(M3). */
  const pinnedRef = useRef(new Set<Element>());
  const [pinnedRuns, setPinnedRuns] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 결정 단추의 자리를 잰다. `scrolled`면 사람이 목록을 굴린 때다: 붙든 줄이 있으면 굴려서 그 점에 온 단추도 막 선 것으로 친다(그 점은
   * 더는 누른 그 내용이 아니다 — 굴림이 끝나고 1초 뒤에는 받는다, M1), 붙든 줄이 없으면 자리만 새로 적는다(굴림은 사람이 한 일이다).
   */
  const measureArrivals = useCallback((scrolled: boolean) => {
    const section = needsMeRef.current;
    const now = performance.now();
    const before = arrivalsRef.current;
    const next = new Map<Element, Arrival>();
    const pinned = new Set<Element>();
    const pinnedKeys = new Set<string>();
    const stamp = !measuredOnceRef.current ? -Infinity : now;
    const heldNow = heldRef.current;
    const heldLis = new Map<Element, PressMark>();
    for (const [runKey, entry] of heldNow) {
      const li = entry.press?.box ? heldRowOf(runKey) : null;
      if (li !== null && entry.press !== null) heldLis.set(li, entry.press);
    }
    const lis = section === null ? [] : [...section.querySelectorAll(":scope > ul > li")];
    lis.forEach((li, index) => {
      const pressInRow = heldLis.get(li) ?? null;
      for (const control of li.querySelectorAll(DECISION_CONTROL)) {
        const r = control.getBoundingClientRect();
        const sig = `${index}:${Math.round(r.left)}:${Math.round(r.top)}`;
        const was = before.get(control);
        if (scrolled) {
          next.set(control, heldNow.size > 0 ? { sig, atMs: now, marks: guardMarks(), released: false } : { ...(was ?? { atMs: -Infinity, marks: [], released: true }), sig });
        } else if (was === undefined || was.sig !== sig) {
          next.set(control, { sig, atMs: stamp, marks: guardMarks(), released: false });
        } else {
          next.set(control, was);
        }
        if (pressInRow?.box && boxesOverlap(r, pressInRow.box)) {
          pinned.add(control);
          for (const [runKey] of heldNow) if (heldRowOf(runKey) === li) pinnedKeys.add(runKey);
        }
      }
    });
    measuredOnceRef.current = true;
    arrivalsRef.current = next;
    pinnedRef.current = pinned;
    setPinnedRuns((current) => (current.size === pinnedKeys.size && [...pinnedKeys].every((k) => current.has(k)) ? current : pinnedKeys));
  }, [heldRowOf]);
  const pointerTypeRef = useRef<string>("");
  const onListPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    pointerTypeRef.current = event.pointerType;
  }, []);
  const onListPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (fingerLike(event.pointerType)) return;
    const spot = { x: event.clientX, y: event.clientY };
    pointerRef.current = spot;
    for (const arrival of arrivalsRef.current.values()) {
      if (!arrival.released && arrival.marks.every((mark) => !samePlace(spot, mark, true))) arrival.released = true;
    }
  }, []);
  // 마우스 자리는 마우스가 떠날 때만 지운다: 터치 탭이 끝나며 오는 `pointerleave`가 지우면 마우스로 붙든 줄이 손 밑에서 놓인다(#5712).
  const onListPointerLeave = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!fingerLike(event.pointerType)) pointerRef.current = null;
  }, []);
  const onListClickCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!(event.target instanceof Element)) return;
      // 키보드가 누른 단추(`detail === 0`)는 사람이 초점을 거기로 옮긴 것이다 — 줄이 움직여도 초점은 결정 단추로 가지 않는다.
      const pointer = event.detail !== 0;
      const spot = pointer ? { x: event.clientX, y: event.clientY } : null;
      const touch = pointer && fingerLike(pointerTypeRef.current);
      const control = event.target.closest(DECISION_CONTROL);
      const swallow = (look: boolean, untilMs = 0) => {
        event.preventDefault();
        event.stopPropagation();
        if (look) showGuardLook(untilMs);
      };
      // 붙든 동안 방금 누른 자리를 다시 누르는 것은 아무 일도 아니다(받은함에서 결정한 뒤 같은 자리를 다시 누르는 것과 같다): 그 자리
      // 밑이 영수증이 아니라 줄 단추(서랍)여도 삼킨다. 삼킨 것이 결정 단추면 막힌 모양을 보인다(M1).
      if (spot !== null && event.target.closest("[data-section] li") !== null) {
        for (const entry of heldRef.current.values()) {
          if (entry.press !== null && samePlace(spot, entry.press, !touch)) return swallow(control !== null);
        }
      }
      if (control === null) return;
      if (spot !== null) {
        if (pinnedRef.current.has(control)) return swallow(true);
        const arrival = arrivalsRef.current.get(control);
        const fresh = arrival !== undefined && !arrival.released && performance.now() - arrival.atMs < SHIFT_GUARD_MS;
        if (fresh && (arrival.marks.length === 0 || arrival.marks.some((mark) => samePlace(spot, mark, !touch)))) {
          return swallow(true, arrival.atMs + SHIFT_GUARD_MS);
        }
      }
      lastPressRef.current = { mark: spot === null ? null : { spot, box: control.getBoundingClientRect(), touch }, touch };
    },
    [showGuardLook]
  );
  const onListScroll = useCallback(() => {
    if (selfScrollTopRef.current !== null && listRef.current?.scrollTop === selfScrollTopRef.current) {
      selfScrollTopRef.current = null;
      return;
    }
    // 사람이 굴렸다: 붙든 줄의 누른 자리는 더는 그 내용이 아니다(놓기·잊기), 그 점에 온 단추는 굴림이 끝나고 1초 뒤에 받는다(M1).
    measureArrivals(true);
    moveOn([...heldRef.current].filter(([, entry]) => !entry.movedOn).map(([key]) => key));
  }, [measureArrivals, moveOn]);

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
  const [activeId, setActiveId] = useState<string | null>(null);

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
    const row = rowRefs.current.get(last.toLowerCase());
    (row ?? listRef.current)?.focus();
  }, [openId]);

  const [goneNotice, setGoneNotice] = useState(false);
  useEffect(() => {
    if (!drawerGone) return;
    setGoneNotice(true);
    setCard(null);
  }, [drawerGone, setCard]);
  useEffect(() => {
    if (openId !== null) setGoneNotice(false);
  }, [openId]);

  const orderedIds = useMemo(() => sections.flatMap((s) => s.rows.map((r) => r.id)), [sections]);
  const sectionOf = useMemo(
    () => new Map(sections.flatMap((s) => s.rows.map((r) => [r.id.toLowerCase(), s.key] as const))),
    [sections]
  );

  // 줄이 구간을 옮기면(지금 → 응답 필요) 그 줄은 다른 목록에서 새로 서고, 그 줄에 있던 캐럿은 body로 떨어진다. 그 줄로 돌려준다.
  const focusedRowRef = useRef<{ id: string; el: HTMLElement } | null>(null);
  const onRowFocus = useCallback((id: string, el: HTMLElement) => {
    focusedRowRef.current = { id, el };
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
  const selfScrollTopRef = useRef<number | null>(null);
  const readAnchors = useCallback(() => {
    anchorsRef.current = visibleRowAnchors(listRef.current);
  }, []);
  useLayoutEffect(() => {
    const last = focusedRowRef.current;
    if (last !== null && !last.el.isConnected) {
      const active = document.activeElement;
      const next = rowRefs.current.get(last.id.toLowerCase());
      if (next && (active === null || active === document.body)) {
        next.focus({ preventScroll: true });
        focusedRowRef.current = { id: last.id, el: next };
      } else if (!next) {
        focusedRowRef.current = null;
      }
    }
    const list = listRef.current;
    if (list !== null && list.scrollTop > 0) {
      const top = list.getBoundingClientRect().top;
      for (const anchor of anchorsRef.current) {
        if (sectionOf.get(anchor.id) !== anchor.section) continue;
        const el = rowRefs.current.get(anchor.id);
        if (!el) continue;
        const delta = el.getBoundingClientRect().top - top - anchor.offset;
        if (delta !== 0) {
          list.scrollTop += delta;
          // 화면이 맞춘 스크롤은 사람이 굴린 것이 아니다(터치로 붙든 줄을 놓지 않는다).
          selfScrollTopRef.current = list.scrollTop;
        }
        break;
      }
    }
    readAnchors();
  }, [sectionOf, readAnchors]);
  // 스크롤 고정이 자리를 맞춘 뒤에 결정 단추의 자리를 잰다(렌더마다 — 위 줄의 높이가 바뀌어 단추가 움직인 것도 「새 자리」다).
  useLayoutEffect(() => {
    measureArrivals(false);
  });
  const rovingId =
    activeId !== null && orderedIds.some((id) => uuidEq(id, activeId))
      ? activeId
      : (orderedIds[0] ?? null);

  const moveFocus = useCallback(
    (from: string, delta: number | "first" | "last") => {
      const index = orderedIds.findIndex((id) => uuidEq(id, from));
      let next = index;
      if (delta === "first") next = 0;
      else if (delta === "last") next = orderedIds.length - 1;
      else next = Math.min(orderedIds.length - 1, Math.max(0, index + delta));
      const id = orderedIds[next];
      if (id === undefined) return;
      setActiveId(id);
      rowRefs.current.get(id.toLowerCase())?.focus();
    },
    [orderedIds]
  );

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(id, 1);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(id, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(id, "first");
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(id, "last");
    }
  };

  // 「응답 필요」의 줄이 아직 내 답을 기다리는가: 붙든 줄(방금 결정함)은 아니다 — 같은 run의 새 요청이 섰으면 다시 기다린다.
  const stillAsksMe = (row: WorkJobRow) => {
    const now = heldStateOf(row, held, decisions.byRun);
    return now.entry === null || now.nextAsk !== null;
  };
  // 서랍은 연 줄과 같은 말을 한다(#5640 수리 3회차, 검수 질문 ③): 칩 낱말, 그리고 목록에서 바로 결정하는 줄이면 「그 카드에서」가 아니다.
  const openRow = openId === null ? null : (rows.find((r) => uuidEq(r.id, openId)) ?? null);
  const openNeeds =
    openRow !== null && sectionOf.get(openRow.id.toLowerCase()) === NEEDS_ME_SECTION && stillAsksMe(openRow);
  const openDecision = openRow === null || !openNeeds ? null : (decisions.byRun.get(runKeyOf(openRow)) ?? null);
  const drawerFacts = {
    stateLabel: openRow === null ? undefined : workJobStateLabel(openRow, openNeeds, formatMessage),
    approvalHint:
      openDecision !== null && decidesInRow(openDecision)
        ? formatMessage("desktop.workJobs.approvalHintInList")
        : undefined,
  };
  const sectionCount = (section: (typeof sections)[number]) =>
    section.key === NEEDS_ME_SECTION ? section.rows.filter(stillAsksMe).length : section.rows.length;

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
          className={cn(
            "work-jobs-list flex min-h-0 min-w-0 flex-col overflow-y-auto focus-visible:focus-ring",
            // 막기가 누름을 삼키는 동안 결정 단추는 막힌 승인과 같은 모양이다(채움을 버리고 옅은 글자, 투명해지지 않는다 — `ApprovalActions`).
            "data-shift-guard:[&_[data-decision]]:cursor-not-allowed data-shift-guard:[&_[data-decision]]:bg-surface-muted data-shift-guard:[&_[data-decision]]:text-ink-muted"
          )}
          aria-label={WORK_JOBS_COPY.listLabel}
          aria-busy={firstLoad}
          role="region"
          onScroll={() => {
            readAnchors();
            onListScroll();
          }}
          onPointerDown={onListPointerDown}
          onPointerMove={onListPointerMove}
          onPointerLeave={onListPointerLeave}
          onClickCapture={onListClickCapture}
          data-shift-guard={guardShown ? "" : undefined}
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
                  ref={section.key === NEEDS_ME_SECTION ? needsMeRef : undefined}
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
                    {section.rows.map((row) => {
                      const needsMe = section.key === NEEDS_ME_SECTION;
                      const kind = workJobResultKind(row, needsMe);
                      // 붙든 줄(방금 결정함)은 구간에 남아도 더는 내 답을 기다리지 않는다: 칩도 머리글 수도 「응답 필요」로 세지 않는다.
                      const heldNow = heldStateOf(row, held, decisions.byRun);
                      const open = needsMe && (heldNow.entry === null || heldNow.nextAsk !== null);
                      // 내 맥 세션의 권한 요청: 줄이 곧 승인 카드로 가는 길이다(서랍이 아니다).
                      const permission = kind === "permission";
                      const openPermission = () =>
                        navigate(desktop ? agentPanePath(row.id) : workConsoleSessionPath(row.id));
                      return (
                        <JobRow
                          key={row.id}
                          row={row}
                          needsMe={needsMe}
                          stateLabel={workJobStateLabel(row, open, formatMessage)}
                          kind={kind}
                          permission={permission}
                          inApp={permission && !desktop ? formatMessage("desktop.workPermission.allowInApp") : null}
                          approval={kind === "approval" ? approvalFacts(row, decisions, needsMe, held) : null}
                          desktop={desktop}
                          onOpenPermission={() => {
                            setActiveId(row.id);
                            openPermission();
                          }}
                          onDecided={onDecided}
                          selected={openId !== null && uuidEq(row.id, openId)}
                          tabStop={rovingId !== null && uuidEq(row.id, rovingId)}
                          pinned={pinnedRuns.has(runKeyOf(row))}
                          rowRef={(el) => {
                            const key = row.id.toLowerCase();
                            if (el) rowRefs.current.set(key, el);
                            else rowRefs.current.delete(key);
                          }}
                          onOpen={() => {
                            setActiveId(row.id);
                            if (permission) openPermission();
                            else setCard(row.id);
                          }}
                          onKeyDown={(e) => onRowKeyDown(e, row.id)}
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
  id: string;
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
    const id = el.dataset.jobId?.toLowerCase();
    const section = el.closest<HTMLElement>("[data-section]")?.dataset.section;
    if (id === undefined || section === undefined) continue;
    out.push({ id, section, offset: rect.top - box.top });
    if (out.length >= MAX_ROW_ANCHORS) break;
  }
  return out;
}

/**
 * 승인 요청 줄이 아는 사실을 모은다: 내가 결정할 승인, 서버가 쓴 카드 문장, 결정자가 아닐 때의 대기 줄.
 *
 * 결정(단추)은 **「응답 필요」에 선 줄에만** 준다 — 그 구간이 곧 「내 작업」 · 내가 맡긴 run · 인박스와 같은 판정으로 내가 결정할
 * 승인이다(`rowNeedsMe`). 「팀 전체」와 남의 줄은 원장에 같은 승인이 있어도 단추가 없다(ADR-0202 D5 「대신 승인 없음」). 대기 줄은
 * 원장이 답했고 그 승인이 원장의 내 결정 목록에 없을 때만 선다 — 원장이 오는 중이거나 없는 서버, 또는 내가 결정할 수 있는데 「팀
 * 전체」라 단추만 없는 줄에서 「기다려요」를 지어내지 않는다.
 */
function approvalFacts(
  row: WorkJobRow,
  decisions: ReturnType<typeof useWorkDecisions>,
  needsMe: boolean,
  held: ReadonlyMap<string, HeldDecision>
): JobApprovalFacts {
  const runId = row.item.runId ?? row.id;
  const { entry, nextAsk } = heldStateOf(row, held, decisions.byRun);
  if (needsMe && entry !== null) {
    // 붙든 줄은 결정된 모습만: 영수증 한 줄(꼬리표·되돌릴 수 없음·만료·카드 링크를 걷는다, 수리 4회차). 원장이 같은 run의 새 요청을
    // 내놓았으면 그 요청은 영수증 **아래 새 줄**에 바로 선다(수리 5회차 M3) — 결과 칸과 영수증은 방금 결정한 승인 그대로라 누른 자리에
    // 새 단추가 오지 않는다.
    return {
      decision: nextAsk,
      item: entry.decision.item,
      intent: decisions.intentFor(row.channelId, runId, entry.decision.approvalId),
      waiting: null,
      receipt: entry.receipt,
      nextAsk: nextAsk === null ? null : { item: nextAsk.item, intent: decisions.intentFor(row.channelId, runId, nextAsk.approvalId) },
    };
  }
  const mine = decisions.byRun.get(runId.toLowerCase()) ?? null;
  return {
    decision: needsMe ? mine : null,
    item: mine?.item ?? null,
    intent: decisions.intentFor(row.channelId, runId, mine?.approvalId),
    waiting: mine === null && decisions.ledgerKnown ? approvalWaitingLine() : null,
    receipt: null,
  };
}

function JobRow({
  row,
  needsMe,
  stateLabel,
  kind,
  permission,
  inApp,
  approval,
  desktop,
  onOpenPermission,
  onDecided,
  selected,
  tabStop,
  pinned,
  rowRef,
  onOpen,
  onKeyDown,
  onFocus,
  onBlur,
}: {
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
  approval: JobApprovalFacts | null;
  desktop: boolean;
  onOpenPermission: () => void;
  onDecided: (outcome: DecisionOutcome, runKey: string, decision: DecidableApproval) => void;
  selected: boolean;
  tabStop: boolean;
  /** 붙든 줄의 새 요청 단추가 방금 누른 단추의 상자와 겹쳐 막혀 있다(사람이 그 줄을 떠날 때까지, 막힌 모양). */
  pinned: boolean;
  rowRef: (element: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onFocus: (id: string, element: HTMLElement) => void;
  onBlur: (event: FocusEvent<HTMLButtonElement>) => void;
}) {
  const reported = reportedSummary(row.reported);
  const result = (
    <JobResultCell row={row} kind={kind} reported={reported} approval={approval} inApp={inApp} />
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
        "border-b border-line last:border-b-0",
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
        onFocus={(event) => onFocus(row.id, event.currentTarget)}
        onBlur={onBlur}
        data-testid="work-job-row"
        data-job-id={row.id}
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
        <div
          className={cn(
            "work-jobs-row px-3 pb-2",
            "data-shift-guard:[&_[data-decision]]:cursor-not-allowed data-shift-guard:[&_[data-decision]]:bg-surface-muted data-shift-guard:[&_[data-decision]]:text-ink-muted"
          )}
          data-testid="work-job-extras"
          data-shift-guard={pinned ? "" : undefined}
        >
          <span data-col="extra" className="min-w-0">
            <JobResultActions
              row={row}
              kind={kind}
              approval={approval}
              desktop={desktop}
              onOpenPermission={onOpenPermission}
              onDecided={(outcome) => {
                if (approval?.decision) onDecided(outcome, runKeyOf(row), approval.decision);
              }}
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
