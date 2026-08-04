import {ApiError} from '@momo/core/lib/api';
import {act, cleanup, render} from '@testing-library/react-native';
import React from 'react';

import {useTypingSender} from '../src/features/conversation/useTypingSender';

// =============================================================================
// 「작성 중」 송신 — 서버가 말한 박자를 지키고, **멈추면 멈추는가**.
//
// ## 이 파일이 지키는 계약은 「안 보내는 것」이다
//
// 「보내는가」는 쉽고 거의 틀리지 않는다. 틀리는 것은 반대쪽이다:
//
//   * 키를 누를 때마다 보내면 → 3초에 20번이 아니라 분당 수백 번이 되고, 그것은
//     서버의 rate limit(가드 5)이 아니라 **키스트로크 텔레메트리**다. ADR-0149 가
//     재발행 하한을 2초로 못박은 이유가 그것이고, 그 값은 grant 응답이 준다.
//   * 입력을 멈춘 뒤에도 계속 보내면 → 컴포저를 떠난 사람이 영원히 작성 중이다.
//     여기에는 타이머가 **없으므로** 그 결함이 구조적으로 불가능한데, 그 사실을
//     테스트가 확인한다: 아무것도 안 하면 요청도 0이다.
//   * 503(이 인스턴스는 휘발 신호를 안 한다)을 받고도 계속 물으면 → 서버가 「그만
//     물어라」라고 답한 자리에서 클라가 계속 두드린다.
//
// ## #839 — 목이 같은 tick 에 답하지 않는다
//
// grant 가 즉시 resolve 하면 「자격을 받기 전에는 발행하지 않는다」를 단정해도
// 아무것도 증명하지 못한다. 그래서 아래 목은 **손으로 푸는 promise** 다: 요청이
// 나간 것을 먼저 확인하고, 그 다음에 답을 준다.
// =============================================================================

const GRANT_WIRE = {
  grant: 'tok-1',
  channel: 'typing:wsWS.CH',
  expiresAtMs: 0, // 아래에서 now 기준으로 채운다
  ttlSeconds: 60,
  signalTtlMs: 6_000,
  republishIntervalMs: 3_000,
  aggregateThreshold: 3,
};

// 이름이 `mock` 으로 시작해야 한다 — `jest.mock` 은 파일 맨 위로 끌어올려지고,
// 그 팩토리 안에서 참조할 수 있는 바깥 변수는 이 접두사를 가진 것뿐이다.
const mockGrant = jest.fn();
const mockPublish = jest.fn();

jest.mock('@momo/core/lib/api', () => {
  const actual = jest.requireActual('@momo/core/lib/api');
  return {
    ...actual,
    requestTypingGrant: (...args: unknown[]) => mockGrant(...args),
    publishTyping: (...args: unknown[]) => mockPublish(...args),
  };
});

const WS = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';

/** 손으로 푸는 promise — 같은 tick 에 답하지 않기 위한 장치. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

let type: () => void;

function Host({enabled = true}: {enabled?: boolean}): React.JSX.Element | null {
  type = useTypingSender(WS, CH, enabled);
  return null;
}

let nowMs = 1_785_000_000_000;

beforeEach(() => {
  mockGrant.mockReset();
  mockPublish.mockReset();
  nowMs = 1_785_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
});

afterEach(() => {
  jest.restoreAllMocks();
  cleanup();
});

function grantOk() {
  return {...GRANT_WIRE, expiresAtMs: nowMs + 60_000};
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('첫 타 — 자격을 받고 바로 한 번 보낸다', () => {
  it('grant 가 아직 안 왔으면 발행하지 않는다', async () => {
    const gate = deferred<typeof GRANT_WIRE>();
    mockGrant.mockReturnValue(gate.promise);
    mockPublish.mockResolvedValue({});
    render(<Host />);

    act(() => type());
    // 요청은 나갔고, 답은 아직 없다. #839 가 요구하는 그 창이다.
    expect(mockGrant).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();

    gate.resolve(grantOk());
    await flush();
    // 자격이 오면 **그 자리에서** 한 번 나간다 — 안 그러면 첫 글자가 grant 만
    // 받고 끝나고, 보는 쪽에는 다음 키까지 아무 표시도 안 뜬다.
    expect(mockPublish).toHaveBeenCalledWith(WS, CH, 'tok-1');
  });

  it('자격을 기다리는 동안 더 쳐도 요청이 겹치지 않는다', async () => {
    const gate = deferred<typeof GRANT_WIRE>();
    mockGrant.mockReturnValue(gate.promise);
    mockPublish.mockResolvedValue({});
    render(<Host />);

    act(() => {
      type();
      type();
      type();
    });
    // grant 를 세 번 받으면 늦게 온 쪽이 먼저 온 쪽을 덮어 박자가 뒤로 간다.
    expect(mockGrant).toHaveBeenCalledTimes(1);
    gate.resolve(grantOk());
    await flush();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});

describe('박자 — 서버가 말한 간격을 지킨다', () => {
  it('간격 안의 키스트로크는 아무것도 보내지 않는다', async () => {
    mockGrant.mockResolvedValue(grantOk());
    mockPublish.mockResolvedValue({});
    render(<Host />);
    act(() => type());
    await flush();
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // 2.9초 동안 서른 번 친다. 한 번도 안 나가야 한다 — 여기가 새면 이 기능은
    // 프레즌스 힌트가 아니라 키스트로크 텔레메트리가 된다.
    for (let i = 0; i < 30; i += 1) {
      nowMs += 96;
      act(() => type());
    }
    await flush();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('간격을 넘긴 뒤의 첫 타에 한 번 더 나간다', async () => {
    mockGrant.mockResolvedValue(grantOk());
    mockPublish.mockResolvedValue({});
    render(<Host />);
    act(() => type());
    await flush();

    nowMs += 3_000;
    act(() => type());
    await flush();
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it('입력을 멈추면 아무것도 나가지 않는다 — 시계만 흘러도', async () => {
    mockGrant.mockResolvedValue(grantOk());
    mockPublish.mockResolvedValue({});
    render(<Host />);
    act(() => type());
    await flush();
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // 1분이 지난다. 타이머가 있었다면 스무 번 나갔을 시간이다.
    nowMs += 60_000;
    await flush();
    expect(mockPublish).toHaveBeenCalledTimes(1);
    // 「정지」 신호도 없다 — 그것이 계약이고, 소멸은 TTL 이 한다.
    expect(mockGrant).toHaveBeenCalledTimes(1);
  });
});

describe('거절 — 각각 다음 행동이 다르다', () => {
  it('503 이면 다시 묻지 않는다', async () => {
    mockGrant.mockRejectedValue(new ApiError(503, 'not configured'));
    render(<Host />);
    act(() => type());
    await flush();
    expect(mockGrant).toHaveBeenCalledTimes(1);

    // 「이 인스턴스는 휘발 신호를 하지 않는다」. 계속 두드릴 이유가 없다.
    for (let i = 0; i < 10; i += 1) {
      nowMs += 5_000;
      act(() => type());
      await flush();
    }
    expect(mockGrant).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('403 이면 자격을 버리고 새로 받는다', async () => {
    mockGrant.mockResolvedValue(grantOk());
    mockPublish.mockRejectedValueOnce(new ApiError(403, 'grant expired'));
    render(<Host />);
    act(() => type());
    await flush();
    expect(mockGrant).toHaveBeenCalledTimes(1);

    mockPublish.mockResolvedValue({});
    nowMs += 3_000;
    act(() => type());
    await flush();
    // 자격이 죽었으므로 다시 받는다 — 기다리는 것이 아니다.
    expect(mockGrant).toHaveBeenCalledTimes(2);
  });

  it('429 면 쉰다', async () => {
    mockGrant.mockResolvedValue(grantOk());
    mockPublish.mockRejectedValueOnce(new ApiError(429, 'rate limit exceeded'));
    render(<Host />);
    act(() => type());
    await flush();
    const afterFirst = mockPublish.mock.calls.length;

    mockPublish.mockResolvedValue({});
    // 백오프 창(재발행 간격) 안에서는 아무것도 안 나간다.
    nowMs += 2_000;
    act(() => type());
    await flush();
    expect(mockPublish).toHaveBeenCalledTimes(afterFirst);

    nowMs += 2_000;
    act(() => type());
    await flush();
    expect(mockPublish).toHaveBeenCalledTimes(afterFirst + 1);
  });
});

describe('레일이 죽어 있으면 신호도 없다', () => {
  it('아무도 못 받을 신호를 만들지 않는다', async () => {
    mockGrant.mockResolvedValue(grantOk());
    mockPublish.mockResolvedValue({});
    render(<Host enabled={false} />);
    act(() => type());
    await flush();
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
