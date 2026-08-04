import {
  liveTypists,
  mergeTypingSignal,
  pruneTypingSignals,
  type TypingSignal,
} from '@momo/core/features/chat/typing';
import type {TypingFrame} from '@momo/core/lib/realtimeEvents';
import {useSyncExternalStore} from 'react';

// =============================================================================
// 「누가 지금 작성 중인가」 — 폰의 절반 (ADR-0149, goal B3 M2).
//
// 규칙은 전부 코어의 것이다(`@momo/core/features/chat/typing`): 같은 (채널, 사람)이
// 하나뿐이라는 것, 만료가 늦은 쪽이 이긴다는 것, 만료된 것을 버린다는 것, 자기
// 자신과 에이전트를 뺀다는 것, 그리고 문장. 여기서 다시 판정하는 것은 하나도 없다.
//
// 여기 있는 것은 코어가 들 수 없는 것뿐이다: **모듈 수준의 가변 배열**과 그 위의
// `useSyncExternalStore`. 코어의 purity 게이트가 그 둘을 즉시 거절하고(ADR-0137 D3),
// 이 클라이언트는 `features/agents/workingSignal.ts` 에서 이미 같은 갈림을 한 번
// 지났다 — 그 파일의 머리말이 이 파일의 머리말이기도 하다.
//
// ## 왜 타이머가 없나
//
// `workingSignal` 은 좀비를 쓸어내는 `setInterval` 을 든다. 여기에는 없다.
//
// 그 차이는 두 신호의 성질에서 나온다. 「작업 중」은 **90초** 살아 있고 끝났다는
// 프레임이 따로 오므로, 그 프레임을 놓친 항목은 누군가 쓸어내야 한다. 「작성 중」은
// **6초** 살아 있고 끝났다는 신호가 **없는 것이 계약**이다(ADR-0149: stop 신호를
// 만들지 않는다). 즉 만료는 언제나 시각 비교 하나로 답이 나오고, 그 비교는 화면이
// 다시 그려질 때 어차피 한 번 일어난다.
//
// 그리고 이 화면에는 이미 1Hz 시계가 있다(`useNow`). 두 번째 인터벌을 세우는 것은
// 같은 박자를 두 번 사는 일이고, 폰에서 그것은 배터리다.
//
// ## 만료를 **읽을 때** 판정하고, 버리는 것은 덤이다
//
// `pruneTypingSignals` 는 버릴 것이 없으면 **같은 배열을 돌려준다**(코어가 그렇게
// 적어 두었다). 그래서 sweep 이 렌더마다 돌아도 동일성이 흔들리지 않고, 흔들리지
// 않으므로 구독자가 헛되이 깨어나지 않는다.
// =============================================================================

// `readonly` 를 붙이지 않는다. 코어의 세 함수가 `TypingSignal[]` 을 받고, 여기서
// `readonly` 로 들면 넘길 때마다 `[...]` 로 복사하게 된다 — 그리고 그 복사가
// **코어가 세운 동일성 계약을 통째로 무효화한다**(아래 sweep 주석). 이 배열을
// 밖에서 고치지 않는다는 약속은 타입이 아니라 이 파일의 크기로 지킨다.
let signals: TypingSignal[] = [];
const listeners = new Set<() => void>();

function emit(next: TypingSignal[]): void {
  if (next === signals) return;
  signals = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 현재 명부. `useSyncExternalStore` 의 스냅샷이므로 **동일성이 계약**이다. */
export function typingSnapshot(): TypingSignal[] {
  return signals;
}

/**
 * 레일이 프레임 하나를 봤다.
 *
 * 프레임의 소문자/대문자는 그대로 둔다 — 코어의 비교가 `uuidEq` 라 대소문자를
 * 접어서 본다. 여기서 정규화하면 그것이 두 번째 정규화 지점이 되고, 둘이 갈리는
 * 날 명부에 같은 사람이 두 번 앉는다.
 */
export function markTyping(frame: TypingFrame): void {
  emit(
    mergeTypingSignal(signals, {
      channelId: frame.payload.channel_id,
      memberId: frame.payload.member_id,
      sentAtMs: frame.ts,
      expiresAtMs: frame.payload.expires_at,
    }),
  );
}

/**
 * 만료된 것을 버린다. 버릴 것이 없으면 **아무 일도 일어나지 않는다.**
 *
 * 「아무 일도」가 문자 그대로다: `pruneTypingSignals` 는 버릴 것이 없으면 **같은
 * 배열**을 돌려주고, `emit` 은 같은 참조를 보면 구독자를 깨우지 않는다. 이 함수는
 * 1Hz 로 도는 자리이므로, 여기서 배열을 한 번 복사하면 그것만으로 화면이 초당 한
 * 번 다시 그려지고 goal RN-P2a 가 산 것이 조용히 풀린다 — 첫 판이 정확히 그
 * 복사(`[...signals]`)를 하고 있었고, `typingSignals.test.tsx` 가 그것을 잡았다.
 */
export function sweepTyping(nowMs: number): void {
  emit(pruneTypingSignals(signals, nowMs));
}

/**
 * 명부를 비운다.
 *
 * 테스트 격리가 첫 용도지만 앱에서도 쓰인다: 레일이 끊기거나 채널을 옮기면 남은
 * 신호가 거짓말이 된다 — 끊긴 동안 그 사람이 아직 치고 있는지 우리는 모르고,
 * 다른 방의 「작성 중」은 이 방에 대해 아무 말도 아니다. 통째로 비워도 되는 이유는
 * 구독이 **보이는 채널 하나뿐**이라 이 명부의 공급자가 하나이기 때문이다.
 */
export function resetTyping(): void {
  signals = [];
  for (const listener of listeners) listener();
}

/**
 * 이 채널에서 지금 작성 중인 **사람들의 id**, 도착한 순서대로.
 *
 * `isEligible` 로 에이전트를 떨구는 것은 코어의 몫이고, 그 판정에 쓸 명부를 주는
 * 것이 화면의 몫이다. 서버가 발행을 403 으로 막지만(`require_human`) 그것은 서버의
 * 방어이고 이것은 화면의 방어다 — 어떤 경로로든 에이전트 id 를 실은 신호가 도착해
 * 그려지는 순간 「사람은 작성 중, 에이전트는 작업 중」이 화면에서 깨진다.
 */
export function useTypists(options: {
  channelId: string;
  nowMs: number;
  myMemberId: string;
  isEligible: (memberId: string) => boolean;
}): string[] {
  const list = useSyncExternalStore(subscribe, typingSnapshot, typingSnapshot);
  // 만료 판정은 **읽을 때** 한다. 명부에서 지우는 것과 화면에서 빼는 것은 다른
  // 일이고, 뒤엣것만으로 화면은 언제나 정직하다.
  return liveTypists(list, {
    channelId: options.channelId,
    nowMs: options.nowMs,
    myMemberId: options.myMemberId,
    isEligible: options.isEligible,
  });
}
