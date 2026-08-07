import {useSyncExternalStore} from 'react';
import {isTerminalProgressFrame} from '@momo/core/features/agents/agentRail';
import type {AgentProgressEvent} from '@momo/core/lib/realtimeEvents';

// =============================================================================
// endedRuns: run 들이 **끝났다는 것을 본** 기록 (ADR-0155 결정 3 방어 렌더링).
//
// ## 왜 「없음」으로는 못 푸는가
//
// 레일(`AgentWorkingRail`)은 살아 있는 run 만 들고 있고, 끝난 run 은 트랙에서
// **지운다**. 그래서 「이 run 이 트랙에 없다」는 「끝났다」가 아니다 — 새로고침
// 직후에도, 다른 탭에서 시작된 턴에도 똑같이 없다. 없음을 종결로 읽으면 지금
// 도착 중인 답에 「응답이 끊김」을 붙이게 되는데, 그것은 우리가 막으려는 거짓말의
// 거울상이다.
//
// 그래서 **본 것만 적는다.** 터미널 `agent.status` 프레임이 실제로 도착한 run 만
// 여기 들어온다. 모르면 아무 말도 하지 않는다.
//
// ## 왜 이것이 필요한가 (닫는 PATCH 가 best effort 라서)
//
// 정상 경로에서는 워커가 닫는 PATCH 로 메시지에 `outcome` 을 찍고, 그러면 이
// 스토어는 필요 없다 — 메시지가 자기서술적이다. 그 한 번의 쓰기가 실패한 run 만
// 여기서 구제된다: run 은 끝났는데(터미널 프레임을 봤다) 메시지는 아직
// `streaming: true` 인 경우. ADR-0155 는 서버 sweeper 대신 이 한 줄을 골랐다.
//
// ## 왜 웹과 같은 파일이 두 벌인가
//
// `workingSignal.ts` 가 두 벌인 것과 같은 이유다: **규칙**은 코어에 하나뿐이고
// (`isTerminalProgressFrame`), 여기 남는 것은 모듈 가변 상태와
// `useSyncExternalStore` 뿐이다. 그 둘은 React 라 코어 순수성 게이트가 거절한다.
// =============================================================================

/**
 * 기억하는 run 의 최대 개수.
 *
 * 무제한이면 오래 열어 둔 탭에서 단조 증가하는 집합이 된다. 이 집합의 유일한
 * 독자는 「지금 화면에 있는 메시지가 끊긴 것인가」이므로, 최근 것만 있으면 된다 —
 * 아주 오래된 run 의 메시지는 이미 `outcome` 이 찍혀 있거나(정상 경로), 영영
 * 안 찍힌 채로 남는다. 후자를 위해 무한한 메모리를 쓰지는 않는다.
 */
const MAX_REMEMBERED = 256;

/** 삽입 순서를 유지하는 `Set` — 넘치면 가장 오래된 것부터 버린다. */
let ended: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * 터미널 프레임을 본다. 터미널이 아니거나 이미 아는 run 이면 아무 일도 없다
 * (같은 집합을 그대로 두므로 구독자도 깨우지 않는다).
 */
export function observeAgentProgress(event: AgentProgressEvent): void {
  if (!isTerminalProgressFrame(event)) return;
  const runId = event.payload.run_id;
  if (typeof runId !== "string" || runId === "") return;
  const key = runId.toLowerCase();
  if (ended.has(key)) return;
  const next = new Set(ended);
  next.add(key);
  while (next.size > MAX_REMEMBERED) {
    const oldest = next.values().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  ended = next;
  emit();
}

/** 세션이 바뀌면 아무것도 물려받지 않는다 — 다른 워크스페이스의 run id 다. */
export function resetEndedRuns(): void {
  if (ended.size === 0) return;
  ended = new Set();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ReadonlySet<string> {
  return ended;
}

/**
 * 훅이 아닌 독자. React 밖에서(테스트, 명령형 코드) 같은 사실을 읽는다 — 두 번째
 * 사본을 만들지 않기 위해서다.
 */
export function endedRunIds(): ReadonlySet<string> {
  return ended;
}

/**
 * 끝난 것을 본 run 들. 신원이 바뀔 때만 새 참조라, 이것을 읽는 컴포넌트는 실제로
 * 무언가 끝났을 때만 다시 그린다.
 */
export function useEndedRuns(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
