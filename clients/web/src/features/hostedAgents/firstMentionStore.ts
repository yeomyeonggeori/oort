// =============================================================================
// 첫 왕복 온보딩의 완료/닫기 기록 (T-6 검수 H-4).
//
// 완료 판정은 채널 HEAD(50) 안의 에이전트 메시지다. 그 창 밖으로 밀리면
// 왕복이 끝나지 않은 것처럼 다시 뜬다. 닫기는 아예 경로가 없었다. 둘 다
// 이 기기에서 지속한다. 초안 저장소(`draftStore`)와 같은 이유·같은 자리
// (localStorage, 로그아웃에 지움)이고, 열쇠는 워크스페이스+채널+에이전트다.
// A 채널의 기록이 B 채널로 따라가지 않는다.
// =============================================================================

const PREFIX = "momo.firstMention.v1:";
/** 동시에 들고 있는 기록의 최대 개수. */
export const MAX_FIRST_MENTION_RECORDS = 200;

export type FirstMentionStoredKind = "complete" | "dismissed";

interface StoredRecord {
  kind: FirstMentionStoredKind;
  atMs: number;
}

export function firstMentionRecordKey(
  workspaceId: string,
  channelId: string,
  agentMemberId: string
): string {
  return `${PREFIX}${workspaceId.toLowerCase()}:${channelId.toLowerCase()}:${agentMemberId.toLowerCase()}`;
}

function readRaw(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 초안 저장소와 같다: 막힌 저장소는 기록이 안 남을 뿐 표면은 동작한다. */
  }
}

function recordKeys(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function parse(raw: string | null): StoredRecord | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { kind, atMs } = value as Record<string, unknown>;
    if (kind !== "complete" && kind !== "dismissed") return null;
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
    return { kind, atMs };
  } catch {
    return null;
  }
}

export function readFirstMentionRecord(
  workspaceId: string,
  channelId: string,
  agentMemberId: string
): FirstMentionStoredKind | null {
  return parse(
    readRaw(firstMentionRecordKey(workspaceId, channelId, agentMemberId))
  )?.kind ?? null;
}

/**
 * 완료는 닫기보다 강하다. 이미 끝난 왕복을 닫기로 낮추지 않는다.
 */
export function writeFirstMentionRecord(
  workspaceId: string,
  channelId: string,
  agentMemberId: string,
  kind: FirstMentionStoredKind,
  nowMs: number = Date.now()
): void {
  const key = firstMentionRecordKey(workspaceId, channelId, agentMemberId);
  if (parse(readRaw(key))?.kind === "complete") return;
  writeRaw(key, JSON.stringify({ kind, atMs: nowMs } satisfies StoredRecord));
  pruneFirstMentionRecords();
}

export function clearAllFirstMentionRecords(): void {
  for (const key of recordKeys()) writeRaw(key, null);
}

function pruneFirstMentionRecords(): void {
  const entries: { key: string; atMs: number }[] = [];
  for (const key of recordKeys()) {
    const record = parse(readRaw(key));
    if (record === null) {
      writeRaw(key, null);
      continue;
    }
    entries.push({ key, atMs: record.atMs });
  }
  if (entries.length <= MAX_FIRST_MENTION_RECORDS) return;
  entries.sort((a, b) => a.atMs - b.atMs);
  for (const entry of entries.slice(
    0,
    entries.length - MAX_FIRST_MENTION_RECORDS
  )) {
    writeRaw(entry.key, null);
  }
}
