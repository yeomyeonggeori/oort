import { absoluteApiBase } from "../../runtime/host";
import { ApiError, touchChannelViewing } from "../../lib/api";

// =============================================================================
// 「보고 있음」 존재 신호 (ADR-0204 증보 3, #4018 서버 / #4063 클라이언트).
//
// 서버는 채널 화면이 앞에 있는 동안 약 15초마다(최대 20초) 오는 PUT 하나로 「이
// 사람이 이 채널을 보고 있다」를 30초 동안 믿는다. 신호가 멈추면 서버가 알아서
// 잊으므로 「정지」 신호는 없고, 클라이언트의 책임은 셋뿐이다:
//
//   1. 앞에 있는 동안만 보낸다 - 앱이 백그라운드로 가거나 창이 가려지면 타이머를
//      **끈다**(배터리). 돌아오면 바로 한 번 보내고 다시 돈다.
//   2. 같은 채널이 두 번 마운트돼도 타이머는 하나다(채널당 보유자 수를 센다).
//   3. 옛 서버(404·405)는 조용히 멈추고 다시 시도하지 않는다. 네트워크 실패나
//      그 밖의 오류는 조용히 넘기고 다음 주기에 다시 보낸다.
//
// 이 파일은 프레임워크를 모른다. 폰(AppState)과 웹·데스크탑(visibilitychange·
// focus)은 `ForegroundPort`만 만들어 넘긴다.
// =============================================================================

/** 서버가 요구하는 주기(15초)이고 상한은 20초다. 상한을 넘기지 않는다. */
export const VIEWING_BEAT_INTERVAL_MS = 15_000;

/** 이만큼 지나도 끝나지 않은 요청은 죽은 것으로 보고 다음 주기에 새로 보낸다. */
const STALE_IN_FLIGHT_MS = 30_000;

/** 화면이 앞에 있는지 알려 주는 클라이언트별 어댑터. */
export interface ForegroundPort {
  isForeground(): boolean;
  /** 바뀔 때마다 부른다. 돌려주는 함수가 구독 해제다. */
  subscribe(onChange: (foreground: boolean) => void): () => void;
}

export interface ViewingBeatDeps {
  send: (workspaceId: string, channelId: string) => Promise<void>;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** 옛 서버 판정의 키 - 서버가 바뀌면 다시 시험해 볼 수 있어야 한다. */
  serverKey: () => string;
}

const defaultDeps: ViewingBeatDeps = {
  send: touchChannelViewing,
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
  unsubscribe: () => void;
  workspaceId: string;
  channelId: string;
  serverKey: string;
}

const entries = new Map<string, Entry>();
/** 404·405를 받은 서버들. 이 서버에는 다시 보내지 않는다. */
const legacyServers = new Set<string>();

function keyOf(workspaceId: string, channelId: string): string {
  return `${workspaceId.toLowerCase()}:${channelId.toLowerCase()}`;
}

/** 옛 서버의 대답이다: 라우트가 없다(404) 또는 메서드가 없다(405). */
export function isLegacyViewingRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405);
}

function stopTimer(entry: Entry, deps: ViewingBeatDeps): void {
  if (entry.timer !== null) {
    deps.clearInterval(entry.timer);
    entry.timer = null;
  }
}

function beat(entry: Entry, deps: ViewingBeatDeps): void {
  if (legacyServers.has(entry.serverKey)) return;
  const now = Date.now();
  if (entry.inFlightAt !== null && now - entry.inFlightAt < STALE_IN_FLIGHT_MS) {
    return;
  }
  entry.inFlightAt = now;
  const mine = now;
  let result: Promise<void>;
  try {
    result = deps.send(entry.workspaceId, entry.channelId);
  } catch (error) {
    result = Promise.reject(error);
  }
  result.then(
    () => {
      if (entry.inFlightAt === mine) entry.inFlightAt = null;
    },
    (error: unknown) => {
      if (entry.inFlightAt === mine) entry.inFlightAt = null;
      if (isLegacyViewingRefusal(error)) {
        legacyServers.add(entry.serverKey);
        stopTimer(entry, deps);
      }
      // 그 밖의 실패(네트워크 등)는 삼킨다. 다음 주기가 다시 보낸다.
    }
  );
}

function sync(entry: Entry, deps: ViewingBeatDeps): void {
  const shouldRun =
    entry.foreground && entry.holders > 0 && !legacyServers.has(entry.serverKey);
  if (!shouldRun) {
    stopTimer(entry, deps);
    return;
  }
  if (entry.timer !== null) return;
  beat(entry, deps);
  entry.timer = deps.setInterval(() => beat(entry, deps), VIEWING_BEAT_INTERVAL_MS);
}

/**
 * 이 채널을 화면에 띄웠다. 돌려주는 함수를 화면을 떠날 때(언마운트·채널 전환)
 * 부른다. 같은 채널을 여러 번 잡아도 타이머는 하나다.
 */
export function holdChannelViewing(
  workspaceId: string,
  channelId: string,
  foreground: ForegroundPort,
  deps: ViewingBeatDeps = defaultDeps
): () => void {
  const key = keyOf(workspaceId, channelId);
  let entry = entries.get(key);
  if (entry === undefined) {
    const created: Entry = {
      holders: 0,
      timer: null,
      inFlightAt: null,
      foreground: foreground.isForeground(),
      unsubscribe: () => {},
      workspaceId,
      channelId,
      serverKey: deps.serverKey(),
    };
    created.unsubscribe = foreground.subscribe((now) => {
      created.foreground = now;
      sync(created, deps);
    });
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
export function resetViewingBeatForTests(): void {
  entries.clear();
  legacyServers.clear();
}
