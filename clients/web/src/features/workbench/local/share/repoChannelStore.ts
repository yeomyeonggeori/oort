// 저장소별 「마지막으로 공유한 채널」(ADR-0190 D4-b 집 채널, Q4). **이 기기에만** 둔다
// (ADR-0174): 서버는 저장소 → 채널 대응을 저장하지 않는다. 워크스페이스마다 따로이고,
// 키는 저장소 표시 이름(마지막 경로 요소)이다. 경로·원격 URL은 받지도 저장하지도 않는다.
// 저장소를 못 읽었으면(null) 기억하지도 불러오지도 않는다: 아무 저장소의 채널을 기본값으로
// 삼지 않는다.

const KEY_PREFIX = "momo.work.shareChannel.v1:";

export interface RepoChannelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): RepoChannelStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(storage: RepoChannelStorage | null, workspaceId: string): Record<string, string> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(KEY_PREFIX + workspaceId.toLowerCase());
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [repo, channel] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof channel === "string") out[repo] = channel;
    }
    return out;
  } catch {
    return {};
  }
}

/** 이 저장소로 마지막에 공유한 채널 id. 처음이거나 저장소를 모르면 null. */
export function lastChannelFor(
  workspaceId: string,
  repoLabel: string | null,
  storage: RepoChannelStorage | null = defaultStorage()
): string | null {
  if (!repoLabel) return null;
  return read(storage, workspaceId)[repoLabel] ?? null;
}

/** 공유를 켠 채널을 기억한다. 저장소를 모르면 아무것도 쓰지 않는다. */
export function rememberChannelFor(
  workspaceId: string,
  repoLabel: string | null,
  channelId: string,
  storage: RepoChannelStorage | null = defaultStorage()
): void {
  if (!repoLabel || !storage) return;
  try {
    const next = { ...read(storage, workspaceId), [repoLabel]: channelId };
    storage.setItem(KEY_PREFIX + workspaceId.toLowerCase(), JSON.stringify(next));
  } catch {
    // 저장이 막혀도 공유는 된다. 다음에 다시 고른다.
  }
}
