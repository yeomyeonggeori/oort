import { LATE_WAKE_MS, type RestOutcome } from "../../lib/http";
import type { RealtimeStatus } from "../../lib/realtimeEvents";
import { isLateWakeOutcome, isUnreachableOutcome, restUnreachableDeclared } from "./restSignal";
import type { ConnectionState } from "./screenState";

// =============================================================================
// 연결 판정의 기기 안 진단 기록 — 시각과 종류만 (#5587, #5575 후속).
//
// owner의 데스크탑 앱이 창이 뒤에 있고 아무것도 하지 않을 때 「보낼 수 없음」(기기 오프라인·서버에 닿지 못함)으로 흔들렸다. 왜인지는
// 그 기기에서만 보인다. 이 파일은 판정에 들어가는 사실이 바뀐 순간을 **이 기기 안에만** 남기는 기록의 모양이다: 무엇을 남기나(닫힌
// 종류 표), 몇 건·며칠까지 두나, 저장된 값을 어떻게 믿지 않고 읽나, 오늘 몇 번이었나, 복사할 글.
//
// ## 남기는 것: 시각(epoch ms)과 종류 낱말 하나. 그 밖에는 없다.
//   device.*        기기 온라인·오프라인(`navigator.onLine`이 말한 사실)
//   rest.fail.*     닿지 못한 REST 한 건의 분류: 시간 초과 · 늦게 깬 마감의 시간 초과 · 망(응답 없음) · 길 위 장비(502·504·코드 없는 503)
//   rest.declared   「서버에 닿지 못함」이 섰다(서로 다른 요청 3건) · rest.cleared 풀렸다
//   socket.*        소켓이 알린 상태(붙음·여는 중·끊김). 모델이 복귀 때 스스로 다시 세는 틈이 아니라 소켓이 말한 것이다
//   window.*        창 보임·숨김·초점 얻음·잃음
//   wake.late.*     타이머가 예정보다 크게 늦게 깼다(앱 낮잠·맥 잠자기의 흔적). 늦은 정도는 네 칸으로만 접는다
//   send.blocked.*  보내기가 막혔다(「보낼 수 없음」)와 그 원인 · send.open 다시 열렸다
//
// ## 남기지 않는 것
// 요청 주소·메서드(주소에 워크스페이스·채널 id가 든다), 메시지 내용, 이름, 토큰, 서버가 보낸 글, 오류 문장. 종류는 아래 표의 낱말만
// 들어갈 수 있고(저장된 값을 읽을 때도 표 밖의 것은 버린다), 서버로 보내지 않는다(복사는 사람이 손으로 한다).
//
// ## 상한
// 최근 500건 · 7일. 새 기록을 더할 때 둘 다 맞춘다. 저장소는 각 클라이언트가 맡는다(웹 localStorage) — 이 파일은 순수하다.
// =============================================================================

export const CONNECTION_DIAG_KINDS = [
  "device.online",
  "device.offline",
  "rest.fail.timeout",
  "rest.fail.timeoutLate",
  "rest.fail.network",
  "rest.fail.gateway",
  "rest.declared",
  "rest.cleared",
  "socket.connected",
  "socket.connecting",
  "socket.disconnected",
  "window.visible",
  "window.hidden",
  "window.focus",
  "window.blur",
  "wake.late.10s",
  "wake.late.1m",
  "wake.late.10m",
  "wake.late.1h",
  "send.blocked.deviceOffline",
  "send.blocked.serverUnreachable",
  "send.blocked.expired",
  "send.open",
] as const;

export type ConnectionDiagKind = (typeof CONNECTION_DIAG_KINDS)[number];

export interface ConnectionDiagEntry {
  /** epoch ms. */
  readonly at: number;
  readonly kind: ConnectionDiagKind;
}

/** 최근 이만큼만 둔다. */
export const CONNECTION_DIAG_CAPACITY = 500;
/** 이보다 오래된 기록은 버린다(7일). */
export const CONNECTION_DIAG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/**
 * 읽을 때 받아들이는 시각의 아래 끝(2020-01-01 UTC). 이 기록은 2026년에 생겼다: 그 전 시각은 깨진 값이다(#5587 수리 1회차 H1).
 * 위 끝은 읽는 순간 + 하루다(기기 시계가 조금 앞서 있던 기록은 살리고, 날짜로 만들 수 없는 `1e20` 같은 값은 버린다).
 */
export const CONNECTION_DIAG_EARLIEST_AT = Date.UTC(2020, 0, 1);
const CLOCK_SKEW_ALLOWANCE_MS = 24 * 60 * 60 * 1_000;

/** 이 시각이 기록으로 받아들일 수 있는 값인가: 유한하고, 2020년 이후이고, `now` + 하루보다 앞이다. */
function acceptableAt(at: unknown, now: number): at is number {
  return (
    typeof at === "number" &&
    Number.isFinite(at) &&
    at >= CONNECTION_DIAG_EARLIEST_AT &&
    at <= now + CLOCK_SKEW_ALLOWANCE_MS
  );
}

const KIND_SET: ReadonlySet<string> = new Set(CONNECTION_DIAG_KINDS);

export function isConnectionDiagKind(value: unknown): value is ConnectionDiagKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** 기록 한 건을 더한다. 7일보다 오래된 것·하루 넘게 앞선 것과 500건을 넘는 앞쪽을 버린다. 원래 배열은 건드리지 않는다. */
export function appendConnectionDiag(
  log: readonly ConnectionDiagEntry[],
  entry: ConnectionDiagEntry
): ConnectionDiagEntry[] {
  const oldest = entry.at - CONNECTION_DIAG_MAX_AGE_MS;
  const kept = log.filter((item) => item.at >= oldest && acceptableAt(item.at, entry.at));
  kept.push({ at: entry.at, kind: entry.kind });
  return kept.length > CONNECTION_DIAG_CAPACITY ? kept.slice(kept.length - CONNECTION_DIAG_CAPACITY) : kept;
}

/** 저장할 모양: `[시각, 종류]` 쌍의 배열. 다른 칸은 없다. */
export function serializeConnectionDiag(log: readonly ConnectionDiagEntry[]): string {
  return JSON.stringify(log.map((entry) => [entry.at, entry.kind]));
}

/**
 * 저장소에서 읽은 값(믿지 않는 입력, `JSON.parse` 결과)을 기록으로. `[받아들일 시각, 표 안의 종류]` 쌍만 남기고 나머지는 말없이
 * 버린다: 옛 모양·깨진 값·누가 끼워 넣은 글이 화면이나 복사 글에 들어가지 않는다. 시각은 날짜로 만들 수 있는 범위(2020년 ~ `now` +
 * 하루)여야 하고 7일보다 오래되지 않아야 한다: `1e20` 같은 유한하지만 날짜가 아닌 값 하나가 카드를 그리다 `RangeError`로 설정
 * 페이지를 무너뜨렸다(수리 1회차 H1). 상한도 다시 맞춘다.
 */
export function parseConnectionDiag(raw: unknown, now: number): ConnectionDiagEntry[] {
  if (!Array.isArray(raw)) return [];
  const oldest = now - CONNECTION_DIAG_MAX_AGE_MS;
  const entries: ConnectionDiagEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [at, kind] = item as [unknown, unknown];
    if (!acceptableAt(at, now) || at < oldest || !isConnectionDiagKind(kind)) continue;
    entries.push({ at, kind });
  }
  return entries.length > CONNECTION_DIAG_CAPACITY ? entries.slice(entries.length - CONNECTION_DIAG_CAPACITY) : entries;
}

/** 이 기기 시간대로 `now`가 든 날의 0시(epoch ms). */
export function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** 오늘(이 기기 시간대) 일어난 기록의 종류별 횟수. 한 번도 없던 종류는 빠진다. 순서는 종류 표의 순서다. */
export function todayConnectionDiagCounts(
  log: readonly ConnectionDiagEntry[],
  now: number
): Array<{ kind: ConnectionDiagKind; count: number }> {
  const from = startOfLocalDay(now);
  const counts = new Map<ConnectionDiagKind, number>();
  for (const entry of log) {
    if (entry.at < from || entry.at > now) continue;
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  }
  return CONNECTION_DIAG_KINDS.filter((kind) => counts.has(kind)).map((kind) => ({
    kind,
    count: counts.get(kind) ?? 0,
  }));
}

/**
 * 복사할 글: 한 줄에 한 건, 오래된 것부터, 시각은 UTC ISO(서버·엣지 기록과 시간대 변환 없이 맞춰 본다). 폰의 실시간 진단
 * (`clients/mobile/src/realtime/diagnostics.ts`)과 같은 모양이다.
 */
export function formatConnectionDiag(log: readonly ConnectionDiagEntry[]): string {
  // 날짜로 만들 수 없는 시각은 읽을 때 이미 버렸다. 그래도 한 줄 때문에 글 전체(와 그것을 그리는 화면)가 무너지지 않게 건너뛴다.
  const lines = log.flatMap((entry) => {
    const day = new Date(entry.at);
    return Number.isNaN(day.getTime()) ? [] : [`${day.toISOString()} ${entry.kind}`];
  });
  return lines.length === 0 ? "connection: no events recorded" : lines.join("\n");
}

// ---- 화면이 세는 묶음 ------------------------------------------------------------

/**
 * 설정 카드가 오늘 횟수를 보이는 묶음. 종류를 **이름으로** 나열한다(앞글자로 묶지 않는다): 「서버 응답 없음」에 늦게 깬 마감의 시간
 * 초과(`rest.fail.timeoutLate`)가 섞여 들던 일(수리 1회차 M1)이 앞글자 묶음에서 왔다. 그 시간 초과는 서버가 아니라 이 기기의 잠을 잰
 * 것이라 「쉬는 동안 끊긴 요청」으로 따로 센다. 한 종류는 많아야 한 묶음에 든다.
 */
export const CONNECTION_DIAG_GROUPS = {
  sendBlocked: ["send.blocked.deviceOffline", "send.blocked.serverUnreachable", "send.blocked.expired"],
  deviceOffline: ["device.offline"],
  serverNoAnswer: ["rest.fail.timeout", "rest.fail.network", "rest.fail.gateway"],
  socketDown: ["socket.disconnected"],
  appRested: ["wake.late.10s", "wake.late.1m", "wake.late.10m", "wake.late.1h"],
  cutWhileResting: ["rest.fail.timeoutLate"],
  windowHidden: ["window.hidden"],
} as const satisfies Record<string, readonly ConnectionDiagKind[]>;

export type ConnectionDiagGroup = keyof typeof CONNECTION_DIAG_GROUPS;

export interface ConnectionDiagToday {
  /** 묶음별 오늘 횟수(이 기기 시간대 0시부터). */
  readonly counts: Readonly<Record<ConnectionDiagGroup, number>>;
  /**
   * 상한(500건)이 오늘 기록의 앞쪽을 잘랐을 수 있다: 가장 오래 남은 기록이 오늘 것이고 기록이 가득 찼다. 이때 횟수는 남은 기록 기준이라
   * 실제보다 적을 수 있고, 화면은 그 사실을 말한다(수리 1회차 M3).
   */
  readonly cappedToday: boolean;
}

/** 오늘의 묶음별 횟수와, 상한이 오늘 기록을 잘랐을 수 있는지. */
export function connectionDiagToday(log: readonly ConnectionDiagEntry[], now: number): ConnectionDiagToday {
  const perKind = new Map(todayConnectionDiagCounts(log, now).map((item) => [item.kind, item.count]));
  const counts = {} as Record<ConnectionDiagGroup, number>;
  for (const group of Object.keys(CONNECTION_DIAG_GROUPS) as ConnectionDiagGroup[]) {
    counts[group] = CONNECTION_DIAG_GROUPS[group].reduce((sum: number, kind) => sum + (perKind.get(kind) ?? 0), 0);
  }
  const first = log[0];
  const cappedToday = log.length >= CONNECTION_DIAG_CAPACITY && first !== undefined && first.at >= startOfLocalDay(now);
  return { counts, cappedToday };
}

// ---- 무엇을 남기나: 사실에서 종류로 ---------------------------------------------

/** 닿지 못한 REST 한 건의 종류. 서버가 답한 것(어떤 상태든 2xx·4xx·코드 있는 5xx)은 null이다. */
export function restFailureDiagKind(outcome: RestOutcome): ConnectionDiagKind | null {
  if (!isUnreachableOutcome(outcome)) return null;
  if (outcome.kind === "response") return "rest.fail.gateway";
  if (isLateWakeOutcome(outcome)) return "rest.fail.timeoutLate";
  return outcome.failure === "timeout" ? "rest.fail.timeout" : "rest.fail.network";
}

/** 타이머가 예정보다 `lateMs` 늦게 깼을 때의 종류. `LATE_WAKE_MS`(10초) 미만이면 남기지 않는다(null). */
export function wakeLateDiagKind(lateMs: number): ConnectionDiagKind | null {
  if (!(lateMs >= LATE_WAKE_MS)) return null;
  if (lateMs >= 60 * 60_000) return "wake.late.1h";
  if (lateMs >= 10 * 60_000) return "wake.late.10m";
  if (lateMs >= 60_000) return "wake.late.1m";
  return "wake.late.10s";
}

function blockedKind(state: ConnectionState): ConnectionDiagKind | null {
  if (state.view.canSend) return null;
  if (state.view.phase === "expired") return "send.blocked.expired";
  return state.view.cause === "deviceOffline" ? "send.blocked.deviceOffline" : "send.blocked.serverUnreachable";
}

/** 소켓이 알린 상태의 종류. 소켓 사실은 상태 비교가 아니라 소켓이 알릴 때 남긴다(모델은 기기 복귀 때 스스로 틈을 다시 연다). */
export function socketDiagKind(status: RealtimeStatus): ConnectionDiagKind {
  if (status === "connected") return "socket.connected";
  return status === "connecting" ? "socket.connecting" : "socket.disconnected";
}

/**
 * 상태 한 번의 변화(`prev` → `next`)가 남길 종류들. 바뀐 것만 낸다: 같은 상태의 되풀이 알림·보이는 것이 같은 REST 응답은 아무것도
 * 남기지 않는다. 순서는 원인 → 결과(기기 · REST 선언 → 보내기)다. 소켓은 `socketDiagKind`로 따로 남긴다.
 */
export function connectionDiagTransitions(prev: ConnectionState, next: ConnectionState): ConnectionDiagKind[] {
  const kinds: ConnectionDiagKind[] = [];
  const before = prev.input;
  const after = next.input;
  if (before.deviceOnline !== after.deviceOnline && after.deviceOnline !== null) {
    kinds.push(after.deviceOnline ? "device.online" : "device.offline");
  }
  const declaredBefore = restUnreachableDeclared(before.rest);
  const declaredAfter = restUnreachableDeclared(after.rest);
  if (declaredBefore !== declaredAfter) kinds.push(declaredAfter ? "rest.declared" : "rest.cleared");
  const blockedBefore = blockedKind(prev);
  const blockedAfter = blockedKind(next);
  if (blockedBefore !== blockedAfter) kinds.push(blockedAfter ?? "send.open");
  return kinds;
}

// ---- 늦게 깬 타이머를 알아채는 시계 ----------------------------------------------

/** 늦게 깬 타이머를 재는 간격(5초). 숨은 창의 타이머는 1초 단위로 맞춰지므로 10초 늦음은 그 잡음이 아니다. */
export const WAKE_WATCH_PERIOD_MS = 5_000;

export interface WakeWatchDeps {
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** 타이머가 `LATE_WAKE_MS` 넘게 늦게 깼다. 종류는 늦은 정도의 칸이다. */
  readonly onLate: (kind: ConnectionDiagKind, at: number) => void;
}

/**
 * 5초마다 깨는 시계를 걸고, 예정보다 10초 넘게 늦게 깬 번마다 `onLate`를 부른다(앱이 그동안 돌지 않았다: 맥 잠자기, 창이 뒤에 있는
 * 앱의 낮잠). 돌려주는 함수가 멈춤이다. 시계·타이머는 인자로 받아 시험이 가짜를 물린다.
 */
export function startWakeWatch(deps: WakeWatchDeps, periodMs: number = WAKE_WATCH_PERIOD_MS): () => void {
  let stopped = false;
  let handle: unknown = null;
  let dueAt = deps.now() + periodMs;

  function tick(): void {
    handle = null;
    if (stopped) return;
    const at = deps.now();
    const kind = wakeLateDiagKind(at - dueAt);
    if (kind !== null) deps.onLate(kind, at);
    dueAt = at + periodMs;
    handle = deps.setTimer(tick, periodMs);
  }

  handle = deps.setTimer(tick, periodMs);
  return () => {
    stopped = true;
    if (handle !== null) deps.clearTimer(handle);
    handle = null;
  };
}
