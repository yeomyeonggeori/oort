import { uuidEq } from "@momo/core/lib/api";

// =============================================================================
// 첫 에이전트 퍼널의 건너뛰기/완료 마커 (#2216).
//
// firstMentionStore 와 같은 자리(localStorage, 워크스페이스 키)이고, 완료는
// 건너뛰기보다 강하다. 세션 pending 은 이번 로그인 탭에만 산다.
// `deferred` 는 아직 접속이 없을 때 OpenAI 호환으로 설정에 넘긴 기록이다.
// 이번 탭에서는 오버레이를 닫고, 다음 세션에서 접속이 없으면 다시 선다.
// =============================================================================

const MARKER_PREFIX = "momo.web.firstAgent.v1:";
const PENDING_SLOT = "momo.web.firstAgentPending.v1";
const RESUME_HASH_SLOT = "momo.web.firstAgentResumeHash.v1";
const DEFER_DISMISS_SLOT = "momo.web.firstAgentDeferDismiss.v1";
const FOCUS_TARGET_SLOT = "momo.web.firstAgentFocusTarget.v1";

export type FirstAgentMarker = "skipped" | "done" | "deferred";

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
    if (kind !== "skipped" && kind !== "done" && kind !== "deferred") return null;
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
 * 완료는 건너뛰기·보류보다 강하다. 이미 끝난 퍼널을 낮추지 않는다.
 */
export function writeFirstAgentMarker(
  workspaceId: string,
  kind: FirstAgentMarker,
  nowMs: number = Date.now()
): void {
  const key = firstAgentMarkerKey(workspaceId);
  const existing = parse(localStore()?.getItem(key) ?? null)?.kind;
  if (existing === "done") return;
  try {
    localStore()?.setItem(
      key,
      JSON.stringify({ kind, atMs: nowMs } satisfies StoredRecord)
    );
  } catch {
    /* 초안 저장소와 같다: 막힌 저장소는 기록이 안 남을 뿐 표면은 동작한다. */
  }
  if (kind !== "deferred") clearFirstAgentPending();
}

export function markFirstAgentPending(workspaceId: string): void {
  const marker = readFirstAgentMarker(workspaceId);
  if (marker === "done" || marker === "skipped") return;
  try {
    sessionStore()?.setItem(PENDING_SLOT, workspaceId);
  } catch {
    // Private mode: the stage then does not appear.
  }
}

export function dismissFirstAgentDeferred(): void {
  try {
    sessionStore()?.setItem(DEFER_DISMISS_SLOT, "1");
  } catch {
    // same as mark
  }
}

function firstAgentDeferDismissed(): boolean {
  try {
    return sessionStore()?.getItem(DEFER_DISMISS_SLOT) === "1";
  } catch {
    return false;
  }
}

export function firstAgentIsPending(workspaceId: string): boolean {
  const marker = readFirstAgentMarker(workspaceId);
  if (marker === "done" || marker === "skipped") return false;
  if (firstAgentDeferDismissed()) return false;
  if (marker === "deferred") return true;
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

export function markFirstAgentFocusTarget(): void {
  try {
    sessionStore()?.setItem(FOCUS_TARGET_SLOT, "1");
  } catch {
    // same as mark
  }
}

export function takeFirstAgentFocusTarget(): boolean {
  try {
    const store = sessionStore();
    const value = store?.getItem(FOCUS_TARGET_SLOT);
    store?.removeItem(FOCUS_TARGET_SLOT);
    return value === "1";
  } catch {
    return false;
  }
}

/** 핸드오프 뒤 초점은 채널 제목 또는 컴포저. `<body>` 로 떨어지지 않는다. */
export function applyFirstAgentFocus(): void {
  if (!takeFirstAgentFocusTarget()) return;
  const input = document.getElementById("composer-input");
  if (input instanceof HTMLElement) {
    input.focus();
    return;
  }
  const heading = document.querySelector<HTMLElement>(
    '[data-testid="channel-header"] h1'
  );
  if (heading) {
    heading.focus();
    return;
  }
  const header = document.querySelector<HTMLElement>(
    '[data-testid="channel-header"]'
  );
  header?.focus();
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
  try {
    sessionStore()?.removeItem(DEFER_DISMISS_SLOT);
    sessionStore()?.removeItem(FOCUS_TARGET_SLOT);
  } catch {
    // same as mark
  }
}
