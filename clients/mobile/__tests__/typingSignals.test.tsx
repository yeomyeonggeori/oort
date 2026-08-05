import type {Centrifuge} from 'centrifuge';
import type {RosterMember} from '@momo/core/lib/api';
import {
  centrifugoChannelName,
  centrifugoTypingChannelName,
} from '@momo/core/lib/realtimeEvents';
import {
  typingSentence,
  TYPING_AGGREGATE_THRESHOLD_FALLBACK,
} from '@momo/core/features/chat/typing';
import {
  makeDirectory,
  memberFor,
} from '@momo/core/features/workspace/directory';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import {createChannelRail} from '../src/realtime/channelRail';
import {TypingBar} from '../src/features/conversation/TypingBar';
import {
  markTyping,
  resetTyping,
  sweepTyping,
  typingSnapshot,
  useTypists,
} from '../src/features/conversation/typingSignals';

// =============================================================================
// 「작성 중」 — 사람만, 그리고 스스로 잊는가 (ADR-0149, goal B3 M2).
//
// 패킷이 이 goal 에 요구한 red proof 세 개가 이 파일의 골격이다:
//
//   1. **에이전트 비표시.** 서버는 발행을 403 으로 막지만(`require_human`) 그것은
//      서버의 방어다. 어떤 경로로든 에이전트 id 를 실은 신호가 도착해 그려지는
//      순간 「사람은 작성 중, 에이전트는 작업 중」이 화면에서 깨지고, 그 순간
//      momo 는 봇을 사람 어포던스에 분장시킨 것이 된다(ADR-0101 이 거부한 것).
//   2. **TTL 소멸.** 서버에 「아직 치고 있나」를 묻는 길이 없다 — 신호가 자기
//      만료를 들고 오고 잊는 것은 구독자의 몫이다(가드 4).
//   3. **같은 tick 목 금지(#839).** 구독이 붙은 그 tick 에 프레임이 오면 「아직
//      아무 표시도 없다」를 단정해도 헛초록이다. 그래서 프레임은 언제나 **나중
//      tick** 에 오고, 프레임 전 상태를 먼저 확인한 뒤에 온 뒤를 확인한다.
//
// 네 번째는 이 클라이언트 고유의 하드 규칙이다: **새 소켓 금지.** 두 번째 소켓은
// `centrifugeTransport` 의 백그라운드 유예도 네트워크 재연결도 토큰 갱신도 하나도
// 물려받지 못한다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const SELF = '11111111-1111-4111-8111-111111111111';
const HUMAN = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const HUMAN2 = 'dddddddd-1111-4111-8111-dddddddddddd';
const HUMAN3 = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const NOW = 1_785_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: HUMAN, displayName: '김민수', handle: 'minsu'}),
  member({id: HUMAN2, displayName: '이하늘', handle: 'haneul'}),
  member({id: HUMAN3, displayName: '박도윤', handle: 'doyun'}),
  member({id: AGENT, kind: 'agent', displayName: '김인턴', handle: 'intern-kim'}),
]);

function frame(memberId: string, atMs = NOW, ttlMs = 6_000) {
  return {
    type: 'ephemeral.typing' as const,
    v: 1,
    ts: atMs,
    payload: {
      workspace_id: WS,
      channel_id: CH,
      member_id: memberId,
      expires_at: atMs + ttlMs,
    },
  };
}

/** 이 화면이 실제로 그리는 트리의 축소판: 명부 → 이름 → 코어의 문장 → 줄. */
function Line({nowMs}: {nowMs: number}): React.JSX.Element {
  const typists = useTypists({
    channelId: CH,
    nowMs,
    myMemberId: SELF,
    isEligible: id => memberFor(DIRECTORY, id)?.kind === 'human',
  });
  const names = typists.map(
    id => memberFor(DIRECTORY, id)?.displayName ?? '',
  );
  return (
    <TypingBar
      sentence={typingSentence(names, TYPING_AGGREGATE_THRESHOLD_FALLBACK)}
    />
  );
}

beforeEach(() => resetTyping());
afterEach(cleanup);

describe('에이전트는 작성 중이 아니다', () => {
  it('에이전트의 신호가 도착해도 그리지 않는다', () => {
    render(<Line nowMs={NOW} />);
    // #839: 구독이 붙은 tick 에 프레임이 오면 이 단정은 헛초록이다. 먼저 없음을
    // 확인하고, 그 다음에 보낸다.
    expect(screen.queryByTestId('composer-typing')).toBeNull();

    act(() => markTyping(frame(AGENT)));

    // 명부에는 들어왔다 — 화면이 거르는 것이지 레일이 거르는 것이 아니다.
    expect(typingSnapshot()).toHaveLength(1);
    expect(screen.queryByTestId('composer-typing')).toBeNull();
  });

  it('사람과 에이전트가 함께 와도 사람만 센다', () => {
    render(<Line nowMs={NOW} />);
    act(() => {
      markTyping(frame(AGENT));
      markTyping(frame(HUMAN));
    });
    // 「2명이」가 아니라 이름 하나다. 에이전트를 세면 여기서 걸린다.
    expect(screen.getByTestId('composer-typing').props.children).toBe(
      '김민수님이 작성 중…',
    );
  });

  it('화면에 나가는 문장에 「작업」이라는 글자가 없다', () => {
    render(<Line nowMs={NOW} />);
    act(() => markTyping(frame(HUMAN)));
    const line: string = screen.getByTestId('composer-typing').props.children;
    expect(line).toContain('작성 중');
    expect(line).not.toContain('작업');
  });

  it('명부에 없는 id 는 그리지 않는다', () => {
    // 이름 없는 「누군가 작성 중」은 나르는 정보가 0이다.
    render(<Line nowMs={NOW} />);
    act(() => markTyping(frame('99999999-9999-4999-8999-999999999999')));
    expect(screen.queryByTestId('composer-typing')).toBeNull();
  });

  it('자기 자신은 절대 그리지 않는다', () => {
    render(<Line nowMs={NOW} />);
    act(() => markTyping(frame(SELF)));
    expect(screen.queryByTestId('composer-typing')).toBeNull();
  });
});

describe('스스로 잊는다 — 서버는 상태를 안 들고 있다', () => {
  it('만료가 지나면 줄이 사라진다', () => {
    const view = render(<Line nowMs={NOW} />);
    act(() => markTyping(frame(HUMAN, NOW, 6_000)));
    expect(screen.getByTestId('composer-typing')).toBeTruthy();

    // 「정지」 신호는 오지 않는다. 그것이 계약이다 — 시계만 흐른다.
    view.rerender(<Line nowMs={NOW + 6_001} />);
    expect(screen.queryByTestId('composer-typing')).toBeNull();
  });

  it('만료 직전에는 아직 살아 있다 — 일찍 지우지 않는다', () => {
    const view = render(<Line nowMs={NOW} />);
    act(() => markTyping(frame(HUMAN, NOW, 6_000)));
    view.rerender(<Line nowMs={NOW + 5_999} />);
    expect(screen.getByTestId('composer-typing')).toBeTruthy();
  });

  it('sweep 은 버릴 것이 없으면 아무것도 흔들지 않는다', () => {
    // 이 함수는 1Hz 로 돈다. 버릴 것이 없을 때 새 배열을 만들면 그것만으로 화면이
    // 초당 한 번 다시 그려지고, goal RN-P2a 가 산 것이 조용히 풀린다.
    act(() => markTyping(frame(HUMAN, NOW, 6_000)));
    const before = typingSnapshot();
    sweepTyping(NOW + 1_000);
    expect(typingSnapshot()).toBe(before);
    sweepTyping(NOW + 6_001);
    expect(typingSnapshot()).not.toBe(before);
    expect(typingSnapshot()).toHaveLength(0);
  });

  it('재발행이 순서를 바꿔 도착해도 표시가 과거로 돌아가지 않는다', () => {
    // 휘발 네임스페이스에는 seq 가 없으므로 순서 보장도 없다. 늦게 도착한
    // **오래된** 신호가 이기면 살아 있는 표시가 먼저 꺼진다.
    const view = render(<Line nowMs={NOW} />);
    act(() => {
      markTyping(frame(HUMAN, NOW + 3_000, 6_000)); // 만료 NOW+9000
      markTyping(frame(HUMAN, NOW, 6_000)); // 늦게 온 옛 신호, 만료 NOW+6000
    });
    view.rerender(<Line nowMs={NOW + 6_500} />);
    expect(screen.getByTestId('composer-typing')).toBeTruthy();
    expect(typingSnapshot()).toHaveLength(1);
  });
});

describe('이름 순서는 시작 순서다', () => {
  it('재발행이 이름 순서를 뒤집지 않는다', () => {
    // #1059 design-review H-1. 정렬 키가 **재발행** 시각이면, 두 사람이 치는 동안
    // 먼저 시작한 사람이 재발행할 때마다 맨 뒤로 밀린다 — 이름이 3초마다 자리를
    // 바꾸고, 화면에서 그것은 「누가 들어왔다」로 읽힌다.
    //
    // 수리 전 코어에서 실측한 값(2026-08-05):
    //   BEFORE: 김민수, 이하늘님이 작성 중…
    //   AFTER : 이하늘, 김민수님이 작성 중…
    const view = render(<Line nowMs={NOW + 2_000} />);
    act(() => {
      markTyping(frame(HUMAN, NOW)); // 김민수가 먼저 시작
      markTyping(frame(HUMAN2, NOW + 1_500)); // 이하늘이 1.5초 뒤
    });
    const before = screen.getByTestId('composer-typing').props.children;
    expect(before).toBe('김민수, 이하늘님이 작성 중…');

    // 먼저 시작한 사람이 재발행한다. 여기서 뒤집히면 결함이 돌아온 것이다.
    act(() => markTyping(frame(HUMAN, NOW + 3_000)));
    view.rerender(<Line nowMs={NOW + 3_500} />);
    expect(screen.getByTestId('composer-typing').props.children).toBe(before);
  });

  it('시작 시각은 재발행에 덮이지 않는다 — 명부 수준에서도', () => {
    act(() => {
      markTyping(frame(HUMAN, NOW));
      markTyping(frame(HUMAN, NOW + 3_000));
    });
    const [entry] = typingSnapshot();
    expect(entry.startedAtMs).toBe(NOW);
    // 갱신되는 것은 만료와 최근 발행 시각뿐이다.
    expect(entry.sentAtMs).toBe(NOW + 3_000);
    expect(entry.expiresAtMs).toBe(NOW + 3_000 + 6_000);
  });
});

describe('뭉치는 규칙은 코어의 것', () => {
  it('임계를 넘으면 이름 대신 수를 말한다', () => {
    render(<Line nowMs={NOW} />);
    act(() => {
      markTyping(frame(HUMAN));
      markTyping(frame(HUMAN2));
    });
    expect(screen.getByTestId('composer-typing').props.children).toBe(
      '김민수, 이하늘님이 작성 중…',
    );

    act(() => markTyping(frame(HUMAN3)));
    expect(screen.getByTestId('composer-typing').props.children).toBe(
      '3명이 작성 중…',
    );
  });
});

describe('레일 — 새 소켓을 열지 않는다', () => {
  function fakeClient(): Centrifuge {
    const {Centrifuge: Fake} = jest.requireMock('centrifuge') as {
      Centrifuge: new (url: string, options: unknown) => Centrifuge;
    };
    return new Fake('wss://example.test/connection/websocket', {});
  }

  it('메시지 레일과 **같은 클라이언트**에 채널 하나를 더 붙인다', () => {
    const client = fakeClient() as Centrifuge & {
      subs: Map<string, {channel: string; options: unknown}>;
    };
    const rail = createChannelRail(() => client);

    const offMessages = rail.subscribeChannel(WS, CH, {
      onSubscribed: () => {},
      onMessage: () => {},
    });
    const offTyping = rail.subscribeTyping(WS, CH, {onTyping: () => {}});

    // 두 채널, 한 클라이언트. 이름만으로 영속과 휘발이 갈린다(가드 1).
    expect([...client.subs.keys()].sort()).toEqual(
      [centrifugoChannelName(WS, CH), centrifugoTypingChannelName(WS, CH)].sort(),
    );
    const typingSub = client.subs.get(centrifugoTypingChannelName(WS, CH));
    // 되살릴 과거가 없다(`history_size: 0`) — 복구를 요구하지도 않는다.
    expect(typingSub?.options).toEqual({recoverable: false, positioned: false});

    offTyping();
    offMessages();
    expect(client.subs.size).toBe(0);
  });

  it('이미 만료된 프레임은 명부에 넣지 않는다', () => {
    const client = fakeClient() as Centrifuge & {
      subs: Map<string, {__emit: (event: string, ctx: unknown) => void}>;
    };
    const rail = createChannelRail(() => client);
    const seen: string[] = [];
    const off = rail.subscribeTyping(WS, CH, {
      onTyping: f => seen.push(f.payload.member_id),
    });
    const sub = client.subs.get(centrifugoTypingChannelName(WS, CH));

    // 지연돼 도착한 신호. 넣으면 다음 sweep 까지 한 번 깜박인다.
    sub?.__emit('publication', {data: frame(HUMAN, Date.now() - 60_000)});
    expect(seen).toEqual([]);

    sub?.__emit('publication', {data: frame(HUMAN, Date.now())});
    expect(seen).toEqual([HUMAN]);
    off();
  });

  it('typing 아닌 프레임은 이 레일을 지나가지 않는다', () => {
    const client = fakeClient() as Centrifuge & {
      subs: Map<string, {__emit: (event: string, ctx: unknown) => void}>;
    };
    const rail = createChannelRail(() => client);
    const seen: unknown[] = [];
    const off = rail.subscribeTyping(WS, CH, {onTyping: f => seen.push(f)});
    const sub = client.subs.get(centrifugoTypingChannelName(WS, CH));
    sub?.__emit('publication', {data: {type: 'message.new', payload: {}}});
    sub?.__emit('publication', {data: {type: 'ephemeral.typing'}});
    expect(seen).toEqual([]);
    off();
  });
});
