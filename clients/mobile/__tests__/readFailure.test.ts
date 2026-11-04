import {ApiError} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';

import {readFailureOf} from '../src/features/connection/readFailure';
import {
  connectedScene,
  offlineScene,
  realtimeDownScene,
  serverUnreachableScene,
} from './fixtures/connectionBand';

// =============================================================================
// 읽기가 실패한 자리가 무엇을 말하나 - 순수 판정 (#5285).
//
// 두 가지를 정한다: 이 실패가 말하는 원인(코어 `causeOfFailure`: 실패 객체와 기기 온라인으로)과, 셸 띠가 **같은 원인**을 이미 말하고 있는가(`spoken`).
// `spoken` 이 참이면 실패한 자리는 이유 문장을 되풀이하지 않는다. 띠 장면은 손으로 짓지 않고 실제 코어 모델로 짓는다(`fixtures/connectionBand.ts`).
// =============================================================================

const unreachable = serverUnreachableScene().state.view;
const offline = offlineScene().state.view;
const realtimeOnly = realtimeDownScene().state.view;
const healthy = connectedScene().state.view;

describe('읽기 실패가 말하는 원인과 띠의 말', () => {
  it('응답 없음 + 띠가 「서버에 닿지 못함」: 같은 원인이라 되풀이하지 않는다', () => {
    expect(unreachable.cause).toBe('serverUnreachable');
    expect(readFailureOf(new NetworkError('unreachable', 15_000), true, unreachable)).toEqual({
      cause: 'serverUnreachable',
      spoken: true,
    });
    // 길 위의 장비가 낸 5xx(502·504)도 서버에 닿지 못함이다.
    expect(readFailureOf(new ApiError(502, 'bad gateway'), true, unreachable)).toEqual({
      cause: 'serverUnreachable',
      spoken: true,
    });
  });

  it('응답 없음 + 기기 오프라인 + 띠가 「오프라인」: 같은 원인이다', () => {
    expect(offline.cause).toBe('deviceOffline');
    expect(readFailureOf(new NetworkError('unreachable', 15_000), false, offline)).toEqual({
      cause: 'deviceOffline',
      spoken: true,
    });
  });

  it('띠가 다른 원인을 말하면 되풀이가 아니다: 서버가 직접 답한 오류는 띠(서버에 닿지 못함)와 다른 말이라 이유가 선다', () => {
    expect(readFailureOf(new ApiError(500, 'boom'), true, unreachable)).toEqual({cause: null, spoken: false});
    // 띠는 오프라인인데 이 실패는 서버에 닿지 못함(기기 온라인으로 읽은 순간의 어긋남)이면 서로 다른 말이다.
    expect(readFailureOf(new NetworkError('unreachable', 15_000), true, offline)).toEqual({
      cause: 'serverUnreachable',
      spoken: false,
    });
  });

  it('띠가 침묵이면(건강 · 실시간만 끊김 · 모델 없음) 같은 원인이어도 이 자리가 말한다', () => {
    const failure = new NetworkError('unreachable', 15_000);
    expect(healthy.phase).toBe('ok');
    expect(realtimeOnly.cause).toBe('realtimeDown');
    for (const view of [healthy, realtimeOnly, null]) {
      expect(readFailureOf(failure, true, view)).toEqual({cause: 'serverUnreachable', spoken: false});
    }
    // 서버가 직접 답한 오류는 어느 띠 아래에서도 원인이 없다.
    expect(readFailureOf(new ApiError(500, 'boom'), true, realtimeOnly)).toEqual({cause: null, spoken: false});
  });

  it('읽기가 멈춘 채(오류 객체 없음)면 기기가 아는 사실 하나만 안다: 꺼져 있으면 오프라인, 아니면 원인 없음', () => {
    expect(readFailureOf(null, false, offline)).toEqual({cause: 'deviceOffline', spoken: true});
    expect(readFailureOf(undefined, false, null)).toEqual({cause: 'deviceOffline', spoken: false});
    // 켜져 있거나 모르면 오프라인이라 하지 않는다.
    expect(readFailureOf(null, true, healthy)).toEqual({cause: null, spoken: false});
    expect(readFailureOf(null, null, offline)).toEqual({cause: null, spoken: false});
  });
});
