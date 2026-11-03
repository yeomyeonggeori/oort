import 'react-native-url-polyfill/auto';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {RECOVERED_FLASH_MS} from '@momo/core/features/connection/thresholds';

import {FLAP_BACK_AT_MS, FLAP_OFFLINE_AT_MS} from '../measure/connectionStrip';
import SurfacesHarness from '../measure/surfaces';

// =============================================================================
// 폰 셸 띠 캡처·Maestro 표면 (#5222): `measure/connectionStrip.tsx` 와 `send-failed-all`.
//
// 이 표면이 보여 주는 것은 시험이 따로 재는 규칙(`connectionProvider.test.tsx` · `shellStrip.test.ts`)이다. 여기서 잰 것은 **표면이 그 장면을 실제로
// 세우는가** - 검증 줄이 시뮬레이터에서 찍을 때(그리고 Maestro `5222-shell-connection-strip` 이 기다릴 때) 같은 시각표가 나오는지다.
// flap 의 시각표는 하네스가 내보낸 `FLAP_OFFLINE_AT_MS`·`FLAP_BACK_AT_MS` 를 가져와 잰다(하네스가 그 상수를 쓰지 않으면 실패한다). 글자 그대로 두는 숫자는
// Maestro 가 기다리는 오프라인 구간의 길이(느린 기계에서 흐름의 첫 단계가 몇 초를 쓰므로 8초 이상)뿐이다.
// =============================================================================

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const strip = () => screen.queryByTestId('shell-connection-strip');
const banner = () => screen.queryByTestId('connection-banner');
const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

describe('CONN-STRIP 표면', () => {
  it('offline: 첫 순간엔 띠가 없고, 기기가 꺼지면 홈 띠와 대화 화면 띠가 같은 원인을 말한다', async () => {
    render(<SurfacesHarness name="conn-strip-offline" scheme="light" />);
    expect(screen.getByTestId('conn-strip-scene')).toBeTruthy();
    expect(strip()).toBeNull();
    await advance(300);
    expect(strip()).toHaveTextContent('오프라인이에요', {exact: false});
    expect(banner()).toHaveTextContent('오프라인이에요', {exact: false});
    expect(strip()!.props.accessibilityRole).toBe('text');
  });

  it('unreachable: 서로 다른 요청 셋이 실패하면 홈 띠가 서고 「지금 다시 연결」이 있다', async () => {
    render(<SurfacesHarness name="conn-strip-unreachable" scheme="light" />);
    await advance(500);
    expect(strip()).toHaveTextContent('서버에 닿지 못했어요', {exact: false});
    expect(strip()!.props.accessibilityLabel).toBe('지금 다시 연결');
  });

  it('realtime: 실시간만 끊기면 대화 화면 띠만 있고 홈 띠는 없다 (결정 ②)', async () => {
    render(<SurfacesHarness name="conn-strip-realtime" scheme="light" />);
    await advance(5_500);
    expect(banner()).toHaveTextContent('실시간 연결이 끊겼어요', {exact: false});
    expect(strip()).toBeNull();
  });

  it('flap: 하네스의 시각표대로 서고(FLAP_OFFLINE_AT_MS), 돌아와 확인 표시 2초(FLAP_BACK_AT_MS), 그 뒤 걷힌다 (Maestro 가 기다리는 시각표)', async () => {
    render(<SurfacesHarness name="conn-strip-flap" scheme="dark" />);
    let at = 0; // 장면이 시작한 뒤 흐른 시각(ms)
    const to = async (ms: number) => {
      await advance(ms - at);
      at = ms;
    };
    await to(FLAP_OFFLINE_AT_MS - 1_000);
    expect(strip()).toBeNull(); // 건강한 연결은 말하지 않는다(Maestro 흐름은 이 침묵을 단정하지 않으니 여기서 잰다)
    await to(FLAP_OFFLINE_AT_MS + 200);
    expect(strip()).toHaveTextContent('오프라인이에요', {exact: false});
    await to(FLAP_BACK_AT_MS - 1_000); // 돌아오기 직전: 아직 꺼져 있다
    expect(strip()).toHaveTextContent('오프라인이에요', {exact: false});
    await to(FLAP_BACK_AT_MS + 500); // 돌아왔고 소켓이 붙었다
    expect(strip()).toHaveTextContent('다시 연결됐어요', {exact: false});
    expect(screen.getByTestId('shell-connection-strip-check')).toBeTruthy();
    await to(FLAP_BACK_AT_MS + RECOVERED_FLASH_MS + 500); // 확인 표시 2초가 지났다
    expect(strip()).toBeNull();
  });

  it('flap 의 오프라인 구간은 Maestro 가 느린 기계에서도 볼 만큼 길다(8초 이상) - 흐름의 첫 단계가 몇 초를 쓴 뒤에도 「오프라인이에요」가 아직 서 있다', () => {
    expect(FLAP_BACK_AT_MS - FLAP_OFFLINE_AT_MS).toBeGreaterThanOrEqual(8_000);
  });
});

describe('SEND-FAILED-ALL 표면', () => {
  it('첫 실패 줄 위에 단추 하나, 줄마다 이유 한 줄과 두 아이콘이 선다', () => {
    render(<SurfacesHarness name="send-failed-all" scheme="light" />);
    expect(screen.getAllByTestId('resend-all')).toHaveLength(1);
    expect(screen.getByTestId('resend-all').props.accessibilityLabel).toBe('3개 모두 다시 보내기');
    const reasons = screen.getAllByTestId('pending-failed-reason').map(node => node.props.children);
    expect(reasons).toEqual([
      '오프라인이라 보내지 못했어요',
      '서버에 닿지 못해 보내지 못했어요',
      '서버가 받지 못했어요',
    ]);
    expect(screen.getAllByTestId('pending-resend')).toHaveLength(3);
    expect(screen.getAllByTestId('pending-discard')).toHaveLength(3);
  });
});
