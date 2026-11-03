import type {ConnectionEvent} from '@momo/core/features/connection/model';
import {
  endedSocketEvent,
  resumeEvent,
  socketEvent,
} from '@momo/core/features/connection/screenState';
import type {DisplayEvent} from '../../realtime/connectionDisplay';

// =============================================================================
// 전송이 밖에서 받은 소켓 사건 → 코어 연결 상태 모델의 사건 (#5222).
//
// 전송은 소켓이 **밖에서 받은** 사건만 알린다: 날것의 상태(`raw`), 다시 열기(`resume`: 앱 복귀·망 복귀·손으로 누른 「지금 다시
// 연결」이 모두 같은 길), 끝남(`terminal`: 서버가 다시 연결하지 말라고 했다). 10초 마감이 만든 `grace-expired` 는 전송 안의
// 읽는 쪽 시계의 결과라 알리지 않는다 — 모델은 자기 시계로(틈이 시작된 때부터) 판정한다.
//
// 표로 둔 까닭: 사건의 종류가 하나 더 생기면 이 표가 컴파일에서 멈춘다(`switch` 의 기본 가지가 조용히 삼키지 않는다).
// =============================================================================

type Translate<K extends DisplayEvent['kind']> = (
  event: Extract<DisplayEvent, {kind: K}>,
  at: number,
) => ConnectionEvent | null;

const TRANSLATE: {[K in DisplayEvent['kind']]: Translate<K>} = {
  raw: (event, at) => socketEvent(at, event.status),
  resume: (_event, at) => resumeEvent(at),
  terminal: (_event, at) => endedSocketEvent(at),
  'grace-expired': () => null,
};

export function connectionEventOf(
  event: DisplayEvent,
  at: number,
): ConnectionEvent | null {
  const translate = TRANSLATE[event.kind] as (
    event: DisplayEvent,
    at: number,
  ) => ConnectionEvent | null;
  return translate(event, at);
}
