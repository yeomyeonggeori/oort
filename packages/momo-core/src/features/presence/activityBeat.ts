import { absoluteApiBase } from "../../runtime/host";
import { ApiError, authedRequest } from "../../lib/api";

// =============================================================================
// 「지금 쓰는 중」 활동 신호 (ADR-0206 D4, #4508 N12 / 서버 #4497).
//
// 웹·데스크탑 창이 **앞에 있고 마지막 입력이 5분 이내**인 동안 20초 이하 주기로 PUT 하나를
// 보낸다. 서버는 30초 안의 신호를 「이 사람이 데스크탑을 쓰는 중」으로 읽고, 그동안 이 사람의
// 폰 푸시를 설정한 시간만큼 늦춘다(읽으면 취소). 신호는 본문이 없다: 무엇을 보는지도 어느
// 채널인지도 싣지 않고, 소유자는 bearer 뿐이다. 폰은 이 신호를 보내지 않는다(앞에 있는 폰
// 앱은 OS가 배너를 안 낸다). 그래서 이 파일은 폰이 읽는 `readState/viewingBeat` 와 따로 있다.
//
// 멈추는 때 (정지 신호는 없다 - 서버가 30초 뒤 알아서 잊는다):
//   1. 창이 뒤로 갔다 - `ActivityPort.subscribe` (탭 숨김·포커스 잃음).
//   2. 마지막 입력이 5분 지났다 - 틱마다 시계로 다시 잰다. 잠금 화면 뒤로 입력이 없는 경우가 이것이다.
//   3. 시계가 건너뛰었다 - 절전이 끝난 뒤 첫 틱은 한참 늦게 온다. 절전 전의 입력은 지금에 대해 아무것도
//      말하지 않으므로 입력 기록을 버리고 새 입력이 올 때까지 보내지 않는다.
//   4. 서버가 거절했다 - 아래 표.
//   (앱 종료는 타이머가 함께 죽는 것으로 끝난다. 셸에는 잠금·절전 이벤트가 없어서 2·3이 그 자리를 맡는다.)
//
// 서버의 거절 (docs/api/openapi.yaml `touchPresenceActivity`, #5353):
//   404·405  옛 서버다 - 그 서버(serverKey)로는 앱을 다시 켜기 전까지 보내지 않는다(AC 38).
//   403      사람 멤버가 아니다(에이전트 bearer · 정지/탈퇴 멤버) - 이 세션에서 멈춘다. 세션 = 이 hold.
//   503      락 경합이라 아무것도 쓰지 못했다(+ `Retry-After`) - 그 시간이 지난 뒤 **다음 주기**에 다시 보낸다.
//            멈추지 않는다: 404·405 와 달리 길이 없는 게 아니다.
//   그 밖(네트워크·5xx)  조용히 넘기고 다음 주기에 다시 보낸다.
//
// 이 파일은 프레임워크를 모른다. 웹·데스크탑은 `ActivityPort` 를 만들어 넘긴다.
// =============================================================================

/** 서버가 요구하는 상한은 20초다. 그 아래에서 고른 값이고, 상한을 넘기지 않는다. */
export const ACTIVITY_BEAT_INTERVAL_MS = 15_000;

/** 마지막 입력이 이만큼 지나면 「쓰는 중」이 아니다(ADR-0206 D4: 5분). */
export const ACTIVITY_IDLE_LIMIT_MS = 5 * 60_000;

/** 이만큼 지나도 끝나지 않은 요청은 죽은 것으로 보고 다음 주기에 새로 보낸다. */
const STALE_IN_FLIGHT_MS = 30_000;

/**
 * 틱 사이가 이보다 벌어지면 타이머가 제때 돌지 못한 것이다(절전·동결). 주기의 두 배에 5초를
 * 얹은 값이라 바쁜 메인 스레드가 한두 번 늦는 것은 넘기고, 뜻밖에 멈춘 쪽은 입력 기록을 비운다.
 * 잘못 멈춘 대가는 다음 입력(쓰는 사람이면 1초 안)까지의 공백이라 작다.
 */
const SLEEP_GAP_MS = 2 * ACTIVITY_BEAT_INTERVAL_MS + 5_000;

/** `Retry-After` 를 따르는 상한. 서버 창이 30초라 이보다 오래 기다릴 이유가 없다. */
const MAX_RETRY_AFTER_MS = 60_000;

/** 창 상태와 입력을 알려 주는 클라이언트별 어댑터. 폰은 이것을 만들지 않는다. */
export interface ActivityPort {
  /** 창이 앞에 있는가(탭이 보이고 포커스를 가졌다). */
  isForeground(): boolean;
  /** 앞뒤가 바뀔 때마다 부른다. 돌려주는 함수가 구독 해제다. */
  subscribe(onChange: (foreground: boolean) => void): () => void;
  /**
   * 사람의 입력(키·포인터·휠·터치)이 있을 때 부른다. 어댑터가 초당 한 번쯤으로 솎아 준다.
   * 입력의 **내용은 넘기지 않는다**. 돌려주는 함수가 구독 해제다.
   */
  subscribeInput(onInput: () => void): () => void;
}

export interface ActivityBeatDeps {
  send: (workspaceId: string) => Promise<void>;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** 옛 서버 판정의 키 - 서버가 바뀌면 다시 시험해 볼 수 있어야 한다. */
  serverKey: () => string;
}

/**
 * 한 번 보내기. 주기·멈춤은 이 파일의 `holdActivityBeat` 가 정한다.
 * `authedRequest` 를 쓴다: 에러가 `Retry-After` 를 `ApiError.retryAfterSeconds` 로 싣는 길이다.
 */
export async function touchPresenceActivity(workspaceId: string): Promise<void> {
  await authedRequest(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/presence/activity`,
    { method: "PUT" }
  );
}

const defaultDeps: ActivityBeatDeps = {
  send: touchPresenceActivity,
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  serverKey: () => absoluteApiBase(),
};

interface Entry {
  holders: number;
  timer: unknown;
  /** 요청을 보낸 시각(ms), 없으면 null. 응답이 끝내 안 오는 요청이 타이머를 죽이지 않게 한다. */
  inFlightAt: number | null;
  foreground: boolean;
  /** 마지막 사람 입력의 시각. 없으면 아직 입력을 보지 못했다(= 쓰는 중이 아니다). */
  lastInputAt: number | null;
  /** 직전 틱의 시각. 틱 사이의 벌어짐으로 절전을 알아챈다. */
  lastTickAt: number;
  /** 503·429 의 `Retry-After` 가 끝나는 시각. 그 전의 틱은 보내지 않고 건너뛴다. */
  notBefore: number;
  /** 403 을 받았다: 이 hold(= 이 세션)는 더 보내지 않는다. */
  forbidden: boolean;
  unsubscribe: () => void;
  workspaceId: string;
  serverKey: string;
}

const entries = new Map<string, Entry>();
/** 404·405 를 받은 서버들. 이 서버에는 다시 보내지 않는다. */
const legacyServers = new Set<string>();

/** 옛 서버의 대답이다: 라우트가 없다(404) 또는 메서드가 없다(405). */
export function isLegacyActivityRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405);
}

/** 사람 멤버가 아니라는 대답이다: 에이전트 bearer · 정지 · 탈퇴 · 다른 워크스페이스 경로. */
export function isForbiddenActivityRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/**
 * 503(락 경합, 아무것도 쓰지 않았다)·429 가 `Retry-After` 로 말한 기다림(ms), 아니면 null.
 * 서버가 길이를 말하지 않았으면 기다림을 지어내지 않는다: 다음 주기가 곧 기다림이다.
 */
export function activityRetryDelayMs(error: unknown): number | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 503 && error.status !== 429) return null;
  if (error.retryAfterSeconds === undefined) return null;
  return Math.min(Math.max(error.retryAfterSeconds, 0) * 1000, MAX_RETRY_AFTER_MS);
}

function keyOf(serverKey: string, workspaceId: string): string {
  return `${serverKey}|${workspaceId.toLowerCase()}`;
}

function isRefused(entry: Entry): boolean {
  return entry.forbidden || legacyServers.has(entry.serverKey);
}

/** 마지막 입력이 5분 안이다. 시계가 거꾸로 갔으면(경과가 음수) 믿지 않는다. */
function isFresh(entry: Entry, now: number): boolean {
  if (entry.lastInputAt === null) return false;
  const elapsed = now - entry.lastInputAt;
  return elapsed >= 0 && elapsed < ACTIVITY_IDLE_LIMIT_MS;
}

function stopTimer(entry: Entry, deps: ActivityBeatDeps): void {
  if (entry.timer !== null) {
    deps.clearInterval(entry.timer);
    entry.timer = null;
  }
}

function settle(entry: Entry, error: unknown, deps: ActivityBeatDeps): void {
  if (isLegacyActivityRefusal(error)) {
    legacyServers.add(entry.serverKey);
    stopTimer(entry, deps);
    return;
  }
  if (isForbiddenActivityRefusal(error)) {
    entry.forbidden = true;
    stopTimer(entry, deps);
    return;
  }
  const wait = activityRetryDelayMs(error);
  if (wait !== null) entry.notBefore = Math.max(entry.notBefore, deps.now() + wait);
  // 그 밖의 실패(네트워크 등)는 삼킨다. 다음 주기가 다시 보낸다.
}

function beat(entry: Entry, deps: ActivityBeatDeps): void {
  if (isRefused(entry)) return;
  const now = deps.now();
  if (now < entry.notBefore) return;
  if (entry.inFlightAt !== null && now - entry.inFlightAt < STALE_IN_FLIGHT_MS) return;
  entry.inFlightAt = now;
  const mine = now;
  let result: Promise<void>;
  try {
    result = deps.send(entry.workspaceId);
  } catch (error) {
    result = Promise.reject(error);
  }
  result.then(
    () => {
      if (entry.inFlightAt === mine) entry.inFlightAt = null;
    },
    (error: unknown) => {
      if (entry.inFlightAt === mine) entry.inFlightAt = null;
      settle(entry, error, deps);
    }
  );
}

/** 지금 보내야 하는 상태면 타이머를 돌리고(처음엔 바로 한 번), 아니면 끈다. */
function sync(entry: Entry, deps: ActivityBeatDeps): void {
  const now = deps.now();
  if (isRefused(entry) || !entry.foreground || !isFresh(entry, now)) {
    stopTimer(entry, deps);
    return;
  }
  if (entry.timer !== null) return;
  entry.lastTickAt = now;
  beat(entry, deps);
  entry.timer = deps.setInterval(() => tick(entry, deps), ACTIVITY_BEAT_INTERVAL_MS);
}

function tick(entry: Entry, deps: ActivityBeatDeps): void {
  const now = deps.now();
  const gap = now - entry.lastTickAt;
  entry.lastTickAt = now;
  if (gap > SLEEP_GAP_MS) {
    // 절전·동결에서 깼다. 그 전의 입력은 지금을 말하지 않는다 - 새 입력이 올 때까지 쉰다.
    entry.lastInputAt = null;
    stopTimer(entry, deps);
    return;
  }
  if (isRefused(entry) || !entry.foreground || !isFresh(entry, now)) {
    stopTimer(entry, deps);
    return;
  }
  beat(entry, deps);
}

/**
 * 이 워크스페이스에서 쓰는 동안의 신호를 시작한다. 돌려주는 함수를 로그아웃·워크스페이스 전환 때
 * 부른다. 같은 워크스페이스를 여러 번 잡아도 타이머는 하나다.
 *
 * 처음에는 입력을 본 적이 없으므로 아무것도 보내지 않는다: 첫 입력이 와야 시작한다.
 */
export function holdActivityBeat(
  workspaceId: string,
  port: ActivityPort,
  deps: ActivityBeatDeps = defaultDeps
): () => void {
  const serverKey = deps.serverKey();
  const key = keyOf(serverKey, workspaceId);
  let entry = entries.get(key);
  if (entry === undefined) {
    const created: Entry = {
      holders: 0,
      timer: null,
      inFlightAt: null,
      foreground: port.isForeground(),
      lastInputAt: null,
      lastTickAt: deps.now(),
      notBefore: 0,
      forbidden: false,
      unsubscribe: () => {},
      workspaceId,
      serverKey,
    };
    const offForeground = port.subscribe((foreground) => {
      created.foreground = foreground;
      sync(created, deps);
    });
    const offInput = port.subscribeInput(() => {
      created.lastInputAt = deps.now();
      sync(created, deps);
    });
    created.unsubscribe = () => {
      offForeground();
      offInput();
    };
    entries.set(key, created);
    entry = created;
  }
  const held = entry;
  held.holders += 1;
  sync(held, deps);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    if (held.holders > 0) return;
    stopTimer(held, deps);
    held.unsubscribe();
    if (entries.get(key) === held) entries.delete(key);
  };
}

/** 시험 전용: 보유 상태와 옛 서버 기억을 비운다. */
export function resetActivityBeatForTests(): void {
  entries.clear();
  legacyServers.clear();
}
