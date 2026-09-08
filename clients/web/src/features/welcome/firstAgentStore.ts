import { uuidEq } from "@momo/core/lib/api";

// =============================================================================
// 첫 에이전트 퍼널의 건너뛰기/완료 마커 (#2216).
//
// firstMentionStore 와 같은 자리(localStorage, 워크스페이스 키)이고, 완료는
// 건너뛰기보다 강하다. 세션 pending 은 이번 로그인 탭에만 산다.
// =============================================================================

const MARKER_PREFIX = "momo.web.firstAgent.v1:";
const PENDING_SLOT = "momo.web.firstAgentPending.v1";
const RESUME_HASH_SLOT = "momo.web.firstAgentResumeHash.v1";

export type FirstAgentMarker = "skipped" | "done";

interface StoredRecord {
  kind: FirstAgentMarker;
  atMs: number;
}

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function firstAgentMarkerKey(workspaceId: string): string {
  return `${MARKER_PREFIX}${workspaceId.toLowerCase()}`;
}

function parse(raw: string | null): StoredRecord | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { kind, atMs } = value as Record<string, unknown>;
    if (kind !== "skipped" && kind !== "done") return null;
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
    return { kind, atMs };
  } catch {
    return null;
  }
}

export function readFirstAgentMarker(workspaceId: string): FirstAgentMarker | null {
  return parse(localStore()?.getItem(firstAgentMarkerKey(workspaceId)) ?? null)
    ?.kind ?? null;
}

/**
 * 완료는 건너뛰기보다 강하다. 이미 끝난 퍼널을 건너뛰기로 낮추지 않는다.
 */
export function writeFirstAgentMarker(
  workspaceId: string,
  kind: FirstAgentMarker,
  nowMs: number = Date.now()
): void {
  const key = firstAgentMarkerKey(workspaceId);
  if (parse(localStore()?.getItem(key) ?? null)?.kind === "done") return;
  try {
    localStore()?.setItem(
      key,
      JSON.stringify({ kind, atMs: nowMs } satisfies StoredRecord)
    );
  } catch {
    /* 초안 저장소와 같다: 막힌 저장소는 기록이 안 남을 뿐 표면은 동작한다. */
  }
  clearFirstAgentPending();
}

export function markFirstAgentPending(workspaceId: string): void {
  if (readFirstAgentMarker(workspaceId) !== null) return;
  try {
    sessionStore()?.setItem(PENDING_SLOT, workspaceId);
  } catch {
    // Private mode: the stage then does not appear.
  }
}

export function firstAgentIsPending(workspaceId: string): boolean {
  if (readFirstAgentMarker(workspaceId) !== null) return false;
  try {
    const pending = sessionStore()?.getItem(PENDING_SLOT);
    return typeof pending === "string" && uuidEq(pending, workspaceId);
  } catch {
    return false;
  }
}

export function clearFirstAgentPending(): void {
  try {
    sessionStore()?.removeItem(PENDING_SLOT);
  } catch {
    // same as mark
  }
}

export function setFirstAgentResumeHash(hash: string): void {
  try {
    sessionStore()?.setItem(RESUME_HASH_SLOT, hash);
  } catch {
    // same as mark
  }
}

export function takeFirstAgentResumeHash(): string | null {
  try {
    const store = sessionStore();
    const value = store?.getItem(RESUME_HASH_SLOT) ?? null;
    store?.removeItem(RESUME_HASH_SLOT);
    return value;
  } catch {
    return null;
  }
}

export function clearAllFirstAgentMarkers(): void {
  const store = localStore();
  if (!store) return;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key !== null && key.startsWith(MARKER_PREFIX)) keys.push(key);
  }
  for (const key of keys) {
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  clearFirstAgentPending();
}
