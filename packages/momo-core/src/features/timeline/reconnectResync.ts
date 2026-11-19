import type {
  Message,
  MessageQuery,
  PinnedMessageWire,
  ReactionSnapshotWire,
} from "../../lib/api";
import { sameProjection } from "./model";
import { normalizePinList, type PinMap } from "./pins";
import { normalizeReactionSnapshot, type ReactionMap } from "./reactions";

// =============================================================================
// 재연결 뒤 열린 대화를 한 번 다시 읽어 맞추기 (#5885, ADR-0177 증보 2026-11-14 D17 「보관하지 않아요」 · D22 한계 5).
//
// 1:1 에서 상대가 나간 방의 하한 아래 옛 글에 대한 이벤트(수정 · 지움 · 반응 · 고정)는 볼 수 있는 멤버의 개인 채널로 가고, 실시간 서버는 그
// 프레임을 보관하지 않는다. 그래서 그 순간 끊겨 있던 기기는 다시 붙어도(복구됨이라도) 그 사이의 변경을 받지 못한다. 클라이언트는 어느 방에서
// 무엇이 빠졌는지 알 수 없으므로(개인 채널도 「복구됨」이라고 답한다) **열려 있는 대화는 모두 같은 길로** 다시 읽는다 — 하한을 가진 멤버가 있는
// 1:1 만 가려 읽으면 그 판정이 틀릴 때 조용히 빠진다.
//
// 웹(`clients/web/src/features/timeline/useTimeline.ts`)과 폰(`clients/mobile/src/features/conversation/useTimeline.ts`)이 이 파일의
// 판정을 같이 쓴다: 언제 읽나(`createReconnectResync`) · 무엇을 읽나(`resyncHistoryQuery`, `readOpenConversation`) · 어떻게 맞추나
// (`reprojectHeldRows` — model.ts, `resyncReactionMap`, `resyncPinMap`).
// =============================================================================

/**
 * 다시 붙은 뒤 이만큼 붙어 있으면 읽는다. 소켓이 짧게 여러 번 붙었다 떨어지면(같은 순간 두 번 다시 구독하는 오프라인 → 온라인 길 포함)
 * 마지막 붙음에서 다시 센다 — 겹친 재연결의 다시 읽기는 한 번이다.
 */
export const RESYNC_SETTLE_MS = 250;
/** 화면에 든 구간이 없을 때(바닥에 있거나 아직 모름) 읽는 가장 새 글의 수. 대화를 여는 머리 읽기와 같다. */
export const RESYNC_HEAD_LIMIT = 50;
/** 한 번에 읽는 글의 상한(서버 `HISTORY_LIMIT_MAX`). */
export const RESYNC_WINDOW_MAX = 200;

/** 화면에 그려진 메시지 줄의 seq 범위(가장 옛 줄 · 가장 새 줄). */
export interface VisibleSeqRange {
  firstSeq: number;
  lastSeq: number;
}

export interface ReconnectResync {
  /** 이 대화의 구독이 다시 붙었다(첫 구독이 아닐 때만 부른다 — 첫 구독은 대화를 여는 길이 이미 읽는다). */
  reconnected(): void;
  /** 실시간 프레임 · 내 낙관 적용이 이 글을 바꿨다. 읽는 동안 바뀐 글은 읽은 답(더 옛것)으로 덮지 않는다. */
  touch(messageId: string): void;
  /** 지금 읽는 동안 바뀐 글의 id(소문자). */
  touched(): ReadonlySet<string>;
  dispose(): void;
}

/**
 * 다시 읽기의 차례. 한 번에 하나만 읽고(진행 중이면 겹치지 않는다), 붙음이 짧게 겹치면 한 번으로 합친다. 읽는 **중에** 다시 붙으면 끝난 뒤
 * 한 번 더 읽는다 — 그 두 번째 끊김 사이의 변경은 앞 읽기의 답보다 뒤일 수 있고, 망이 흔들려 앞 읽기가 실패했으면 그것이 유일한 기회다.
 * `run` 의 실패는 여기서 조용히 끝난다(다음 재연결이나 대화를 다시 열 때 맞춰진다 — 연결 띠의 문장은 그대로다).
 */
export function createReconnectResync(
  run: () => Promise<unknown>,
  settleMs: number = RESYNC_SETTLE_MS
): ReconnectResync {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  let disposed = false;
  let touched = new Set<string>();

  const start = () => {
    timer = null;
    if (disposed) return;
    inFlight = true;
    again = false;
    touched = new Set();
    let flight: Promise<unknown>;
    try {
      flight = run();
    } catch (error) {
      flight = Promise.reject(error);
    }
    flight
      .catch(() => {
        /* 조용히 넘어간다 — 위 설명 */
      })
      .finally(() => {
        inFlight = false;
        if (again && !disposed) schedule();
      });
  };
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(start, settleMs);
  };

  return {
    reconnected() {
      if (disposed) return;
      if (inFlight) {
        again = true;
        return;
      }
      schedule();
    },
    touch(messageId) {
      if (inFlight) touched.add(messageId.toLowerCase());
    },
    touched: () => touched,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * 다시 읽을 기록 쪽. 화면에 든 구간을 덮는 한 번의 읽기다.
 * - 든 글이 없으면 읽지 않는다(`null` — 대화를 여는 길이 아직 읽는 중이다).
 * - 바닥(가장 새 글이 화면에 있음)이거나 구간을 모르면 가장 새 `RESYNC_HEAD_LIMIT` 개.
 * - 위로 올려 읽는 중이면 화면의 가장 새 줄 바로 위부터 아래로 그 구간의 seq 수만큼(스레드 답글처럼 화면에 서지 않는 seq 가 끼어도 덮이게).
 */
export function resyncHistoryQuery(
  newestHeldSeq: number | null,
  visible: VisibleSeqRange | null,
  headLimit: number = RESYNC_HEAD_LIMIT
): MessageQuery | null {
  if (newestHeldSeq === null) return null;
  if (visible === null || visible.lastSeq >= newestHeldSeq) {
    const span = visible === null ? 0 : newestHeldSeq - visible.firstSeq + 1;
    return { limit: Math.min(Math.max(headLimit, span), RESYNC_WINDOW_MAX) };
  }
  const span = visible.lastSeq - visible.firstSeq + 1;
  return { before: visible.lastSeq + 1, limit: Math.min(Math.max(span, 1), RESYNC_WINDOW_MAX) };
}

export interface OpenConversationRead {
  /** 실패했거나 읽지 않았으면 `null`. */
  messages: Message[] | null;
  reactions: ReactionSnapshotWire | null;
  pins: PinnedMessageWire[] | null;
}

/**
 * 셋을 나란히 읽는다. 하나가 실패해도 나머지는 맞춘다. 실패는 `null` 로 조용히 — 대화는 그대로 쓸 수 있고, 다음 재연결이나 대화를 다시
 * 열 때 맞춰진다.
 */
export async function readOpenConversation(ports: {
  query: MessageQuery | null;
  fetchMessages: (query: MessageQuery) => Promise<{ messages: Message[] }>;
  fetchReactions: () => Promise<ReactionSnapshotWire>;
  fetchPins: () => Promise<PinnedMessageWire[]>;
}): Promise<OpenConversationRead> {
  const query = ports.query;
  const [page, reactions, pins] = await Promise.allSettled([
    query === null ? Promise.resolve(null) : ports.fetchMessages(query),
    ports.fetchReactions(),
    ports.fetchPins(),
  ]);
  return {
    messages: page.status === "fulfilled" && page.value !== null ? page.value.messages : null,
    reactions: reactions.status === "fulfilled" ? reactions.value : null,
    pins: pins.status === "fulfilled" ? pins.value : null,
  };
}

/**
 * 반응 지도를 다시 읽은 스냅샷에 맞춘다. 대화를 여는 길(`{...cold, ...live}`, 내 것이 이김)과 달리 **스냅샷이 이긴다** — 끊긴 사이에 빠진
 * 반응이 지워져야 한다. 스냅샷에 없는 글은 반응이 없는 글이다(채널 전체 스냅샷이다).
 * - 읽는 동안 바뀐 글(`skip`)은 지금 것을 둔다.
 * - 같은 반응은 지금의 차례(이모지 · 사람)를 지킨다 — 칩이 누르는 손 아래서 자리를 바꾸지 않는다. 새로 생긴 것만 뒤에 붙는다.
 * - 바뀐 것이 없으면 **같은 객체**를 돌려준다.
 */
export function resyncReactionMap(
  current: ReactionMap,
  wire: ReactionSnapshotWire,
  skip: ReadonlySet<string> = new Set()
): ReactionMap {
  const snapshot = normalizeReactionSnapshot(wire);
  let changed = false;
  const next: ReactionMap = {};
  for (const [messageId, bucket] of Object.entries(current)) {
    const fresh = snapshot[messageId];
    if (skip.has(messageId)) {
      next[messageId] = bucket;
      continue;
    }
    if (fresh === undefined) {
      changed = true;
      continue;
    }
    const merged = mergeReactionBucket(bucket, fresh);
    if (merged !== bucket) changed = true;
    next[messageId] = merged;
  }
  for (const [messageId, fresh] of Object.entries(snapshot)) {
    if (messageId in current || skip.has(messageId)) continue;
    next[messageId] = fresh;
    changed = true;
  }
  return changed ? next : current;
}

function mergeReactionBucket(
  local: Record<string, string[]>,
  fresh: Record<string, string[]>
): Record<string, string[]> {
  let changed = false;
  const out: Record<string, string[]> = {};
  for (const [emoji, members] of Object.entries(local)) {
    const now = fresh[emoji];
    if (now === undefined) {
      changed = true;
      continue;
    }
    const kept = members.filter((member) => now.includes(member));
    const added = now.filter((member) => !members.includes(member));
    if (kept.length === members.length && added.length === 0) {
      out[emoji] = members;
    } else {
      out[emoji] = [...kept, ...added];
      changed = true;
    }
  }
  for (const [emoji, members] of Object.entries(fresh)) {
    if (emoji in local) continue;
    out[emoji] = members;
    changed = true;
  }
  return changed ? out : local;
}

/**
 * 고정 지도를 다시 읽은 목록에 맞춘다. 반응과 같은 규칙: 목록이 이기고(끊긴 사이에 풀린 고정이 걷힌다), 읽는 동안 바뀐 글은 지금 것을 두고,
 * 같은 항목은 같은 객체를, 바뀐 것이 없으면 같은 지도를 돌려준다.
 */
export function resyncPinMap(
  current: PinMap,
  wire: readonly PinnedMessageWire[],
  skip: ReadonlySet<string> = new Set()
): PinMap {
  const snapshot = normalizePinList(wire);
  let changed = false;
  const next: PinMap = {};
  for (const [messageId, entry] of Object.entries(current)) {
    const fresh = snapshot[messageId];
    if (skip.has(messageId)) {
      next[messageId] = entry;
      continue;
    }
    if (fresh === undefined) {
      changed = true;
      continue;
    }
    if (sameProjection(entry, fresh)) {
      next[messageId] = entry;
    } else {
      next[messageId] = fresh;
      changed = true;
    }
  }
  for (const [messageId, fresh] of Object.entries(snapshot)) {
    if (messageId in current || skip.has(messageId)) continue;
    next[messageId] = fresh;
    changed = true;
  }
  return changed ? next : current;
}
