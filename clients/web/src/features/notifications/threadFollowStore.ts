import { fetchThreadReplies } from "@momo/core/lib/api";

// =============================================================================
// 「이 스레드를 따라가는가」의 이 기기 장부 (#4890, ADR-0206 증보 1 F8).
//
// 데스크탑 배너는 **서버가 따라간다고 말한 스레드의 답글만** 알린다. 그런데 서버가 이 기기에 그것을 알려 주는 길은
// 둘뿐이다: 스레드를 열 때의 `following`(`GET …/replies`)과 `PUT`/`DELETE …/follow` 의 응답. 실시간 `message.new` 는
// 채널 전체로 나가서 받는 사람별 값을 실을 수 없고(F5), 「따라가는 스레드 목록」 읽기 API 는 아직 없다(남는 위험 23).
// 그래서 이 장부는 **서버가 말한 값만** 적는다 — 누가 글을 썼는지로 따라가는지를 짐작해 채우지 않는다. 장부에 없는
// (또는 늙은) 스레드는 배너를 미루고 `resolveFollowing` 으로 그 스레드 하나를 서버에 묻는다: 스레드 열기와 같은
// 읽기를 한 건(`limit=1`)만 보낸다.
//
//   * 값은 `TTL_MS` 동안만 믿는다. 다른 기기에서 그만 따라간 것이 이 기기에 닿는 길은 다음 읽기뿐이라서(개인 설정은
//     방송하지 않는다), 늙은 값을 믿으면 끈 스레드의 배너가 계속 뜬다. 다시 묻는 비용이 분당 한 건이다.
//   * 읽기가 실패하면(네트워크·403·404) **따라가지 않는 것으로** 짧게(`FAILED_TTL_MS`) 적는다: 모르는 채로 알리는 것보다
//     덜 알리는 쪽이 안전하고, 실패한 읽기를 다음 글마다 되풀이해 서버를 두드리지 않는다.
//   * 같은 스레드를 동시에 묻는 요청은 하나로 합친다. 장부는 `MAX_ENTRIES` 를 넘으면 오래된 것부터 버린다.
// =============================================================================

/** 서버가 말한 값을 믿는 시간. */
export const TTL_MS = 60_000;
/** 읽기가 실패했을 때 「따라가지 않음」으로 두는 시간. */
export const FAILED_TTL_MS = 10_000;
/** 장부의 크기 상한(한 세션이 만나는 스레드 수의 현실적인 위). */
export const MAX_ENTRIES = 500;

interface Entry {
  following: boolean;
  expiresAtMs: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();

function keyOf(workspaceId: string, rootId: string): string {
  return `${workspaceId.toLowerCase()}/${rootId.toLowerCase()}`;
}

/** 서버가 알려 준 값. 모르거나(적힌 적 없음) 늙었으면 `undefined` — 판정은 그때 서버에 묻는다. */
export function followingKnown(
  workspaceId: string,
  rootId: string,
  nowMs: number = Date.now()
): boolean | undefined {
  const entry = entries.get(keyOf(workspaceId, rootId));
  if (entry === undefined || entry.expiresAtMs <= nowMs) return undefined;
  return entry.following;
}

function write(key: string, following: boolean, expiresAtMs: number): void {
  // 다시 쓰면 맨 뒤로 보낸다(오래된 것부터 버리려고 삽입 순서를 쓴다).
  entries.delete(key);
  entries.set(key, { following, expiresAtMs });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** **서버가 말한 값만** 넣는다: 스레드 열기 응답·`PUT`/`DELETE …/follow` 응답·`resolveFollowing`. */
export function noteFollowing(
  workspaceId: string,
  rootId: string,
  following: boolean,
  nowMs: number = Date.now()
): void {
  write(keyOf(workspaceId, rootId), following, nowMs + TTL_MS);
}

/**
 * 이 스레드를 따라가는지 서버에 한 번 묻고 장부에 적는다. 같은 스레드의 진행 중인 물음은 하나로 합친다. 약속은 던지지 않고
 * 풀린다 — 호출부는 풀린 뒤 판정을 한 번 더 한다(그때도 모르면 알리지 않는다).
 */
export function resolveFollowing(
  workspaceId: string,
  channelId: string,
  rootId: string,
  nowMs: () => number = Date.now
): Promise<void> {
  const key = keyOf(workspaceId, rootId);
  const running = inflight.get(key);
  if (running !== undefined) return running;
  const request = (async () => {
    try {
      const page = await fetchThreadReplies(workspaceId, channelId, rootId, undefined, 1);
      // 옛 서버는 키가 없다: 「따라가지 않음」으로 읽는다(api.ts `ThreadRepliesPage.following`).
      write(key, page.following === true, nowMs() + TTL_MS);
    } catch {
      write(key, false, nowMs() + FAILED_TTL_MS);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, request);
  return request;
}

/** 시험용: 장부를 비운다. */
export function resetThreadFollowStoreForTest(): void {
  entries.clear();
  inflight.clear();
}
