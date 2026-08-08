import { useEffect, useState, useSyncExternalStore } from "react";
import {
  liveTypists,
  mergeTypingSignal,
  pruneTypingSignals,
  TYPING_AGGREGATE_THRESHOLD_FALLBACK,
  type TypingSignal,
} from "@momo/core/features/chat/typing";
import type { TypingFrame } from "@momo/core/lib/realtimeEvents";

// =============================================================================
// 「작성 중」 명부 — 웹 쪽 저장소 (ADR-0149 가드 4 · goal B3 W2).
//
// 규칙은 전부 `@momo/core/features/chat/typing`에 있고 여기 있는 것은 **저장소**뿐
// 이다. 코어에 두지 않는 이유는 purity 게이트다: `useSyncExternalStore`도 타이머도
// 코어에서 금지돼 있고, 그것이 옳다 — 무엇이 참인가는 두 클라가 공유하지만, 그것을
// 어디에 담는가는 각자의 플랫폼 사정이다. `agentWorkingSignal.ts`가 같은 이유로 같은
// 모양이다.
//
// **서버가 상태를 안 들고 있으므로 이 파일이 든다.** 그리고 그 상태는 자기 힘으로
// 늙는다: 각 신호가 `expires_at`을 갖고 오고, 아래 sweep은 그 값만 본다. 「아직
// 치고 있나」를 물을 곳은 없고 있어야 할 이유도 없다.
// =============================================================================

/**
 * 만료를 훑는 주기.
 *
 * 신호의 TTL(서버 기본 6s)보다 촘촘해야 표시가 늦게 사라지지 않고, 렌더 필터가
 * 이미 만료분을 걸러 주므로 이 sweep은 **메모리 회수**가 본업이다. 1초는 사람이
 * 「사라졌다」를 느끼는 해상도이자, 조용한 채널에서 아무 일도 하지 않는 주기다
 * (`pruneTypingSignals`가 버릴 것이 없으면 같은 배열을 돌려주므로 리스너가 깨지 않는다).
 */
const SWEEP_MS = 1_000;

let signals: readonly TypingSignal[] = [];
/**
 * 서버가 마지막으로 말한 뭉치기 임계.
 *
 * grant 응답에서만 온다(`aggregateThreshold`). 읽기만 하는 사람은 grant를 받을 이유가
 * 없으므로 미러가 기본값이고, 한 번이라도 발행해 본 뒤에는 서버 값이 이긴다. 갈려도
 * 무해한 유일한 숫자다 — 3명에서 뭉치는 대신 4명에서 뭉치는 화면은 틀린 말을 하지 않는다.
 */
let threshold = TYPING_AGGREGATE_THRESHOLD_FALLBACK;

const listeners = new Set<() => void>();

function emit(next: readonly TypingSignal[]): void {
  signals = next;
  for (const listener of listeners) listener();
}

/** 프레임 한 건을 명부에 넣는다. 이미 만료된 것은 들어오지 않는다. */
export function recordTyping(frame: TypingFrame, nowMs = Date.now()): void {
  if (frame.payload.expires_at <= nowMs) return;
  const next = mergeTypingSignal(signals as TypingSignal[], {
    channelId: frame.payload.channel_id,
    memberId: frame.payload.member_id,
    // 새 엔트리일 때만 시작 시각으로 쓰인다 — 이미 있는 사람이면 `mergeTypingSignal`이
    // 기존 시작 시각을 지킨다(H-1). 프레임에는 「언제부터」가 없고 「언제 발행했나」만
    // 있으므로(`frame.ts`), 첫 프레임의 발행 시각이 우리가 아는 가장 이른 시각이다.
    startedAtMs: frame.ts,
    sentAtMs: frame.ts,
    expiresAtMs: frame.payload.expires_at,
  });
  if (next === signals) return;
  emit(next);
}

/** 만료된 것을 버린다. 버릴 것이 없으면 아무도 깨우지 않는다. */
export function sweepTyping(nowMs = Date.now()): void {
  const next = pruneTypingSignals(signals as TypingSignal[], nowMs);
  if (next === signals) return;
  emit(next);
}

/** grant가 알려 준 서버 값을 기억한다. */
export function rememberTypingThreshold(value: number): void {
  if (!Number.isFinite(value) || value === threshold) return;
  threshold = value;
  for (const listener of listeners) listener();
}

export function typingThreshold(): number {
  return threshold;
}

/** 세션 해제 · 워크스페이스 전환 · 테스트. */
export function resetTyping(): void {
  threshold = TYPING_AGGREGATE_THRESHOLD_FALLBACK;
  if (signals.length === 0) return;
  emit([]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly TypingSignal[] {
  return signals;
}

/** 진단/테스트 이음새: React 구독 없이 원장을 본다. */
export const typingSnapshot = snapshot;

/**
 * 이 채널에서 지금 작성 중인 사람들의 member id.
 *
 * 1Hz 재렌더는 **누군가 치고 있을 때만** 돈다. 조용한 채널에서 초당 한 번 도는
 * 시계는 그 자체로 비용이고, 이 표면은 대개 조용하다.
 */
export function useTypists(options: {
  channelId: string | null;
  myMemberId: string;
  isEligible: (memberId: string) => boolean;
}): string[] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  const hasAny = all.length > 0;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasAny) return;
    const id = setInterval(() => {
      sweepTyping();
      setTick((t) => t + 1);
    }, SWEEP_MS);
    return () => clearInterval(id);
  }, [hasAny]);

  if (options.channelId === null) return [];
  // 렌더의 자기 시계를 읽는다. sweep이 잡은 값을 쓰면 sweep이 멈춘 순간(마지막
  // 신호가 사라진 직후)의 시각이 굳어 만료 판정이 무력해진다 —
  // `useTickingNow`가 같은 함정을 한 번 밟고 고친 자리다.
  return liveTypists(all as TypingSignal[], {
    channelId: options.channelId,
    nowMs: Date.now(),
    myMemberId: options.myMemberId,
    isEligible: options.isEligible,
  });
}

/** 저장소가 아는 임계를 구독한다 (grant가 도착하면 바뀐다). */
export function useTypingThreshold(): number {
  return useSyncExternalStore(subscribe, typingThreshold, typingThreshold);
}
