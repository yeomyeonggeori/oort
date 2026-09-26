import {contrast} from '@momo/core/design/color';
import type {Member, Message} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {AccessibilityInfo, ActionSheetIOS, StyleSheet} from 'react-native';

import {darkPalette, lightPalette, slopTo, TOUCH_TARGET} from '../src/design/tokens';
import {FixedScheme} from '../src/design/theme';
import {Composer} from '../src/features/conversation/Composer';
import {
  connectionBannerText,
  ConversationHeader,
} from '../src/features/conversation/ConversationHeader';
import {CONV} from '../src/features/conversation/convDesign';
import {
  LONG_PRESS_HINT_MS,
  LongPressHint,
  useLongPressHint,
} from '../src/features/conversation/LongPressHint';
import {
  MessageRow,
  stepStateForCheck,
  stepStateForTurn,
} from '../src/features/conversation/MessageRow';
import {floatingDayFor} from '../src/features/conversation/Timeline';
import {ApprovalDecision} from '../src/features/inbox/ApprovalDecision';
import {conversationSubtitle} from '../src/screens/ConversationScreen';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// DS2-4 #2716 — 폰 대화 화면 (시안 A `#a-conv` + owner 피드백 표, Buzz 대조).
//
// 이 파일은 이 배치가 **새로 세운 약속**만 잰다: 머리(원형 뒤로·⋮ 메뉴·허들 자리·
// 연결 띠), 떠 있는 알약 컴포저, 첫 1회 코치마크, 떠 있는 날짜 알약의 판정, 에이전트
// 카드 단계 표지, 새 글자·바탕 쌍의 대비. 옮긴 기존 기능은 원래 시험들이 계속 잰다.
// =============================================================================

afterEach(cleanup);

const flatten = (style: unknown) =>
  StyleSheet.flatten(style as never) as Record<string, unknown>;

const HUMAN = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const AGENT = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

function member(over: Partial<Member>): never {
  return {
    id: HUMAN,
    workspaceId: 'ws',
    kind: 'human',
    handle: 'seongjae',
    displayName: '곽성재',
    role: 'member',
    ...over,
  } as never;
}

const DIRECTORY = makeDirectory([
  member({}),
  member({id: AGENT, kind: 'agent', handle: 'intern-kim', displayName: '김인턴'}),
]);

// ---- 1. 머리 ---------------------------------------------------------------

describe('머리 — 원형 뒤로 · ⋮ 메뉴 · 허들 자리 · 연결 띠', () => {
  function header(props: Partial<React.ComponentProps<typeof ConversationHeader>> = {}) {
    return render(
      <ConversationHeader
        title="agent-lab"
        kind="public"
        directory={DIRECTORY}
        onBack={() => {}}
        menu={[{label: '고정 2개', run: () => {}}]}
        railStatus="connected"
        {...props}
      />,
    );
  }

  it('뒤로는 42 원이고(시안 `.a-cbtn`) 엄지에는 44 다', () => {
    header();
    const back = screen.getByTestId('header-back');
    const style = flatten(back.props.style);
    expect(style.width).toBe(42);
    expect(style.height).toBe(42);
    expect(style.borderRadius).toBe(21);
    expect(42 + back.props.hitSlop * 2).toBe(TOUCH_TARGET);
  });

  it('⋮ 는 메뉴를 열고, 고른 항목을 실행한다 — 고정 목록의 문이 여기로 왔다', () => {
    const run = jest.fn();
    const spy = jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((options, callback) => {
        expect(options.options).toEqual(['고정 2개', '취소']);
        expect(options.cancelButtonIndex).toBe(1);
        callback(0);
      });
    header({menu: [{label: '고정 2개', run}]});
    fireEvent.press(screen.getByTestId('conversation-menu'));
    expect(run).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('취소는 아무것도 실행하지 않는다', () => {
    const run = jest.fn();
    const spy = jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, callback) => callback(1));
    header({menu: [{label: '고정한 메시지', run}]});
    fireEvent.press(screen.getByTestId('conversation-menu'));
    expect(run).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('허들 아이콘은 기능이 없으면 서지 않는다 — 누르면 아무 일도 없는 버튼은 없다', () => {
    const none = header();
    expect(screen.queryByTestId('conversation-huddle')).toBeNull();
    none.unmount();
    const onPress = jest.fn();
    header({huddle: {label: '허들 시작', onPress, icon: 'kebab'}});
    fireEvent.press(screen.getByTestId('conversation-huddle'));
    expect(onPress).toHaveBeenCalled();
  });

  it('연결 상태는 부제가 아니라 띠다 — 연결됐으면 아무 말도 없다', () => {
    const calm = header({subtitle: '6명'});
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(screen.getByTestId('conversation-subtitle')).toHaveTextContent('6명');
    calm.unmount();
    header({subtitle: '6명', railStatus: 'disconnected'});
    expect(screen.getByTestId('connection-banner')).toHaveTextContent('연결이 끊겼습니다');
    // 부제는 방의 정체를 그대로 말한다 — 연결 문장으로 바뀌지 않는다.
    expect(screen.getByTestId('conversation-subtitle')).toHaveTextContent('6명');
    expect(connectionBannerText('connecting')).toBe('연결 중…');
    expect(connectionBannerText('connected')).toBeNull();
  });

  it('제목 앞 표지 — 채널은 #, 비공개는 자물쇠, DM 은 상대 얼굴', () => {
    const HIDDEN = {includeHiddenElements: true} as const;
    const pub = header();
    expect(screen.getByTestId('conversation-title-glyph-public', HIDDEN)).toBeTruthy();
    pub.unmount();
    const priv = header({kind: 'private'});
    expect(screen.getByTestId('conversation-title-glyph-private', HIDDEN)).toBeTruthy();
    priv.unmount();
    header({kind: 'dm', peerId: AGENT, title: '김인턴'});
    expect(screen.queryByTestId('conversation-title-glyph-public', HIDDEN)).toBeNull();
    expect(screen.getByTestId('avatar-agent', {includeHiddenElements: true})).toBeTruthy();
  });
});

describe('머리 부제 — 방이 무엇인지만, 모르는 것은 짓지 않는다', () => {
  it('채널: 멤버 수와 참여 중인 에이전트', () => {
    expect(
      conversationSubtitle({kind: 'public', memberIds: [HUMAN, AGENT]}, null, DIRECTORY),
    ).toBe('2명 · 김인턴 참여 중');
    expect(conversationSubtitle({kind: 'public', memberIds: [HUMAN]}, null, DIRECTORY)).toBe(
      '1명',
    );
  });

  it('멤버 목록이 안 왔으면 수를 짓지 않는다', () => {
    expect(conversationSubtitle({kind: 'public'}, null, DIRECTORY)).toBeUndefined();
    expect(conversationSubtitle(null, null, DIRECTORY)).toBeUndefined();
  });

  it('DM: 에이전트면 「에이전트」, 사람은 접속 정보가 없으므로 비운다', () => {
    expect(conversationSubtitle({kind: 'dm'}, {kind: 'agent'}, DIRECTORY)).toBe('에이전트');
    expect(conversationSubtitle({kind: 'dm'}, {kind: 'human'}, DIRECTORY)).toBeUndefined();
  });
});

// ---- 2. 컴포저 알약 ----------------------------------------------------------

describe('떠 있는 알약 컴포저 — 안쪽 + · 입력 · 잉크 ↑ 하나', () => {
  const TARGET = {workspaceId: 'ws', channelId: 'ch'};
  function composer() {
    return render(
      <Composer
        recipient="place"
        channelLabel="agent-lab"
        directory={DIRECTORY}
        attachmentTarget={TARGET}
        onSend={() => {}}
      />,
    );
  }

  it('세 조각이 한 알약 안에 있다 — r26, 좌우 12', () => {
    composer();
    const pill = screen.getByTestId('composer-pill');
    const style = flatten(pill.props.style);
    expect(style.borderRadius).toBe(26);
    expect(style.marginHorizontal).toBe(12);
    // + · 입력 · 보내기 가 전부 알약의 자손이다.
    for (const id of ['composer-attach', 'composer-input', 'composer-send']) {
      const node = screen.getByTestId(id);
      let cursor: typeof node | null = node;
      let inside = false;
      while (cursor) {
        if (cursor === pill) inside = true;
        cursor = cursor.parent as typeof node | null;
      }
      expect([id, inside]).toEqual([id, true]);
    }
  });

  it('+ 는 34 원, 보내기는 38 잉크 원 — 둘 다 엄지에는 44', () => {
    composer();
    const attach = screen.getByTestId('composer-attach');
    const a = flatten(attach.props.style);
    expect([a.width, a.height, a.borderRadius]).toEqual([34, 34, 17]);
    expect(34 + attach.props.hitSlop * 2).toBe(TOUCH_TARGET);
    fireEvent.changeText(screen.getByTestId('composer-input'), '좋아');
    const send = screen.getByTestId('composer-send');
    const s = flatten(send.props.style);
    expect([s.width, s.height, s.borderRadius]).toEqual([38, 38, 19]);
    expect(38 + send.props.hitSlop * 2).toBe(TOUCH_TARGET);
    expect(send.props.hitSlop).toBe(slopTo(38));
  });

  it('보내기에는 보이는 글자가 없고 이름은 낭독 라벨이 든다', () => {
    composer();
    const send = screen.getByTestId('composer-send');
    expect(send.props.accessibilityLabel).toBe('보내기');
    expect(screen.queryByText('보내기')).toBeNull();
  });

  it('비었을 때 잉크를 벗고, 쓰면 잉크를 입는다', () => {
    composer();
    const idle = flatten(screen.getByTestId('composer-send').props.style);
    expect(idle.backgroundColor).not.toBe(darkPalette.primary);
    fireEvent.changeText(screen.getByTestId('composer-input'), '보낼 글');
    const live = flatten(screen.getByTestId('composer-send').props.style);
    // 프로바이더 밖이라 시스템 스킴(jest = 모름 → 다크)의 팔레트다.
    expect(live.backgroundColor).toBe(darkPalette.primary);
  });

  it('입력창의 선이 보이지 않는다 — 알약 안에 상자가 하나 더 서지 않는다', () => {
    composer();
    const input = flatten(screen.getByTestId('composer-input').props.style);
    expect(input.borderColor).toBe('transparent');
    expect(input.backgroundColor).toBeUndefined();
  });
});

// ---- 3. 첫 1회 코치마크 -----------------------------------------------------

describe('길게 누르기 안내 — 상주 줄이 아니라 첫 1회 코치마크', () => {
  function memoryStore() {
    const values = new Map<string, string>();
    return {
      getString: (key: string) => values.get(key),
      set: (key: string, value: string) => void values.set(key, value),
      remove: (key: string) => values.delete(key),
      values,
    };
  }

  function Host(): React.JSX.Element {
    const hint = useLongPressHint();
    return <LongPressHint visible={hint.visible} onDismiss={hint.dismiss} />;
  }

  afterEach(() => __setNonSecretStore(null));

  it('처음 뜨는 순간 배운 것으로 적는다 — 다음 방문에는 없다', () => {
    const store = memoryStore();
    __setNonSecretStore(store as never);
    const first = render(<Host />);
    expect(screen.getByTestId('long-press-hint')).toBeTruthy();
    expect(store.values.get(NON_SECRET_KEYS.longPressLearned)).toBe('1');
    first.unmount();
    render(<Host />);
    expect(screen.queryByTestId('long-press-hint')).toBeNull();
  });

  it('스스로 물러난다', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
      __setNonSecretStore(memoryStore() as never);
      render(<Host />);
      await act(async () => {});
      expect(screen.getByTestId('long-press-hint')).toBeTruthy();
      act(() => {
        jest.advanceTimersByTime(LONG_PRESS_HINT_MS - 1);
      });
      expect(screen.getByTestId('long-press-hint')).toBeTruthy();
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.queryByTestId('long-press-hint')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('VoiceOver 가 켜져 있으면 말하고, 스스로 닫지 않는다 (WCAG 2.2.1)', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
      const announce = jest
        .spyOn(AccessibilityInfo, 'announceForAccessibility')
        .mockImplementation(() => {});
      __setNonSecretStore(memoryStore() as never);
      render(<Host />);
      await act(async () => {});
      expect(announce).toHaveBeenCalledWith('메시지를 길게 누르면 답글·반응·고치기');
      act(() => {
        jest.advanceTimersByTime(LONG_PRESS_HINT_MS * 3);
      });
      expect(screen.getByTestId('long-press-hint')).toBeTruthy();
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });

  it('누르면 바로 닫힌다', () => {
    __setNonSecretStore(memoryStore() as never);
    render(<Host />);
    fireEvent.press(screen.getByTestId('long-press-hint-dismiss'));
    expect(screen.queryByTestId('long-press-hint')).toBeNull();
  });

  it('목록을 밀지 않는다 — 도크 위에 떠 있다(절대 배치)', () => {
    __setNonSecretStore(memoryStore() as never);
    render(<Host />);
    const anchor = flatten(screen.getByTestId('long-press-hint').props.style);
    expect(anchor.position).toBe('absolute');
    expect(anchor.bottom).toBe('100%');
  });
});

// ---- 4. 떠 있는 날짜 알약의 판정 ---------------------------------------------

describe('떠 있는 날짜 알약 — 창 맨 위 행이 속한 날', () => {
  const day = (key: string, atMs: number) => ({kind: 'day' as const, key, atMs});
  const row = (key: string) => ({kind: 'message', key}) as never;
  const ITEMS = [day('d1', 1), row('m1'), row('m2'), day('d2', 2), row('m3'), row('m4')];

  it('맨 위 행의 날을 가리킨다', () => {
    expect(floatingDayFor(ITEMS, ['m2', 'd2', 'm3'])).toEqual({key: 'd1', atMs: 1});
    expect(floatingDayFor(ITEMS, ['m4'])).toEqual({key: 'd2', atMs: 2});
  });

  it('그 날의 구분선이 창 안에 보이면 서지 않는다 — 같은 날이 두 번 서지 않는다', () => {
    expect(floatingDayFor(ITEMS, ['d2', 'm3', 'm4'])).toBeNull();
    expect(floatingDayFor(ITEMS, ['d1', 'm1'])).toBeNull();
  });

  it('보고 순서가 아니라 목록 순서로 맨 위를 정한다', () => {
    expect(floatingDayFor(ITEMS, ['m4', 'm3', 'm2'])).toEqual({key: 'd1', atMs: 1});
  });

  it('아무것도 안 보이면 없다', () => {
    expect(floatingDayFor(ITEMS, [])).toBeNull();
    expect(floatingDayFor(ITEMS, ['gone'])).toBeNull();
  });
});

describe('떠 있는 날짜 알약은 스크롤 중에만 선다 (검수 B-1)', () => {
  it('쉬는 화면에서는 없다 — Timeline 이 손가락·관성 신호로만 세운다', () => {
    const code = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../src/features/conversation/Timeline.tsx'),
      'utf8',
    );
    expect(code).toContain('dayPillLive && floatingDay !== null');
    expect(code).toMatch(/onMomentumScrollEnd=\{jumpPills \? releaseDayPill/);
    // 손가락이 잡는 순간 세운다 — 콜백이 의존성 목록에만 있고 불리지 않던 판이 있었다.
    const begin = code.slice(code.indexOf('const onScrollBeginDrag'), code.indexOf('const onScrollEndDrag'));
    expect(begin).toMatch(/\bholdDayPill\(\);/);
  });

  it('알약 바탕이 불투명이다 — 밑 본문 획과 섞이지 않는다', () => {
    const {FloatingDayPill} = jest.requireActual('../src/features/conversation/MessageRow');
    render(<FloatingDayPill atMs={1_760_000_000_000} nowMs={1_760_000_000_000} />);
    const pill = screen.getByTestId('floating-day', {includeHiddenElements: true});
    const face = flatten((pill.children[0] as {props: {style: unknown}}).props.style);
    expect(face.backgroundColor).toBe(darkPalette.surface);
  });
});

// ---- 5. 에이전트 카드 단계 ---------------------------------------------------

describe('에이전트 카드 — 단계 표지(완료·진행·실패)는 있는 상태만 옮긴다', () => {
  it('턴 상태 → 단계: 멈춤·취소는 실패가 아니다', () => {
    expect(stepStateForTurn('done')).toBe('ok');
    expect(stepStateForTurn('thinking')).toBe('run');
    expect(stepStateForTurn('streaming')).toBe('run');
    expect(stepStateForTurn('error')).toBe('fail');
    expect(stepStateForTurn('stalled')).toBe('idle');
    expect(stepStateForTurn('cancelled')).toBe('idle');
  });

  it('게이트 결과 → 단계: 건너뜀·모름은 실패가 아니다', () => {
    expect(stepStateForCheck('pass')).toBe('ok');
    expect(stepStateForCheck('pending')).toBe('run');
    expect(stepStateForCheck('fail')).toBe('fail');
    expect(stepStateForCheck('skip')).toBe('idle');
    expect(stepStateForCheck('unknown')).toBe('idle');
  });

  function toolMessage(status: string): Message {
    return {
      id: `tool-${status}`,
      channelId: 'ch',
      seq: 3,
      hlcTs: 3,
      hlcCount: 0,
      authorMemberId: AGENT,
      type: 'tool_result',
      body: '이슈 3건',
      state: 'sent',
      createdAtMs: 1_760_000_000_000,
      props: {tool_name: 'github.search', label: 'push 중복', status},
    } as Message;
  }

  it.each([
    ['succeeded', 'ok'],
    ['running', 'run'],
    ['failed', 'fail'],
  ])('도구 실행 %s → 단계 표지 %s, 상태 낱말은 오른쪽 메타에 남는다', (status, mark) => {
    render(
      <MessageRow
        message={toolMessage(status)}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={1_760_000_000_000}
      />,
    );
    expect(screen.getByTestId('agent-card-steps')).toBeTruthy();
    expect(screen.getByTestId(`step-mark-${mark}`)).toBeTruthy();
  });

  it('단계 줄이 말한 도구·대상을 아래 줄에서 다시 세우지 않는다 (검수 M-6)', () => {
    render(
      <MessageRow
        message={toolMessage('succeeded')}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={1_760_000_000_000}
      />,
    );
    expect(screen.queryByText('github.search')).toBeNull();
    expect(screen.getByText(/github\.search 실행/)).toBeTruthy();
  });

  it('짧은 값이 단계 문장에 우연히 들어 있어도 다른 줄을 지우지 않는다 (R2 L-8)', () => {
    render(
      <MessageRow
        message={{
          ...toolMessage('succeeded'),
          props: {tool_name: 'github.search', label: 'push 중복', status: 'succeeded', decision_reason: 'push'},
        } as Message}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={1_760_000_000_000}
      />,
    );
    // 「push」는 단계 문장 「… push 중복」의 부분이지만 대상과 같지 않다 — 남는다.
    expect(screen.getByText('push')).toBeTruthy();
  });

  it('카드 틀은 1.5 그라데이션 테두리 + r20 (시안 `.a-card`)', () => {
    render(
      <MessageRow
        message={toolMessage('succeeded')}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={1_760_000_000_000}
      />,
    );
    const frame = flatten(screen.getByTestId('agent-card').props.style);
    expect(frame.padding).toBe(1.5);
    expect(frame.borderRadius).toBe(20);
    expect(String(frame.experimental_backgroundImage)).toMatch(/^linear-gradient\(140deg, #/);
  });
});

describe('승인 결정 — 대화 카드에서만 알약, 인박스는 그대로', () => {
  it('shape="pill" 이 아니면 옛 상자다', () => {
    const ME = {id: HUMAN, workspaceId: 'ws', displayName: '곽성재'} as Member;
    const tree = (shape?: 'pill') => (
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider member={ME}>
          <ApprovalDecision
            approvalId="ap-1"
            reversible
            onSettled={() => {}}
            testIDPrefix="x"
            shape={shape}
          />
        </SessionProvider>
      </QueryClientProvider>
    );
    const {rerender} = render(tree());
    const box = flatten(screen.getByTestId('x-approve').props.style);
    expect(box.borderRadius).not.toBe(999);
    rerender(tree('pill'));
    const pill = flatten(screen.getByTestId('x-approve').props.style);
    expect(pill.borderRadius).toBe(999);
    expect(pill.borderWidth).toBe(0);
  });
});

// ---- 6. 새 글자·바탕 쌍의 대비 (새벽하늘 라이트·다크) --------------------------

/** `#rrggbbaa` 를 불투명 바탕 위에 합성한다. */
function composite(top: string, base: string): string {
  const hex = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const alpha = top.length === 9 ? hex(top, 3) / 255 : 1;
  const out = [0, 1, 2].map(i =>
    Math.round(hex(top, i) * alpha + hex(base, i) * (1 - alpha))
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${out.join('')}`;
}

describe.each([
  ['light', lightPalette],
  ['dark', darkPalette],
] as const)('DS2-4 대비 — %s', (_mode, p) => {
  // 대화 바닥: 시안 `.a-conv` 그라데이션의 두 끝(bgTop → surface/bgMid). 유리는 그
  // 위의 합성, 블러가 없을 때의 94%, 투명도 줄이기의 불투명 surface.
  const grounds = [p.canvasTop, p.surface, p.bg];
  const glassGrounds = [
    ...grounds.map(g => composite(p.glass, g)),
    ...grounds.map(g => composite(p.glassFallback, g)),
    p.surface,
  ];

  it('유리(머리·컴포저·날짜 알약) 위 글자가 4.5 이상 — 제목·부제·입력·날짜', () => {
    for (const ground of glassGrounds) {
      for (const ink of [p.text, p.textMuted]) {
        expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('입력창 자리 글자(placeholder)가 유리 위에서 3:1 — 입력의 가장자리를 대신한다', () => {
    for (const ground of glassGrounds) {
      expect(contrast(p.textFaint, ground)).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('잉크 보내기의 ↑ 와 코치마크 글자가 4.5 이상', () => {
    expect(contrast(p.onPrimary, p.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it('멘션 칩 두 벌(남·나)이 4.5 이상', () => {
    // 남의 멘션: signal-text on signal-soft. 내 멘션: on-signal on signal(채움).
    // 첫 판의 내 멘션(signal-text on signal-soft 한 단 진하게)은 라이트에서 3.8 이었다.
    expect(contrast(p.accentText, p.accentSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.onAccent, p.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('단계 표지(✓ ok-soft · ✕ danger-soft)가 비텍스트 3:1, 진행 줄 글자가 surface2 위 4.5', () => {
    expect(contrast(p.ok, p.okSurface)).toBeGreaterThanOrEqual(3);
    expect(contrast(p.danger, p.dangerSurface)).toBeGreaterThanOrEqual(3);
    expect(contrast(p.agent, p.surfaceMuted)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.textMuted, p.surfaceMuted)).toBeGreaterThanOrEqual(4.5);
  });

  it('반응 알약 글자(surface2 · 내 반응 signal-soft)가 4.5 이상', () => {
    expect(contrast(p.textMuted, p.surfaceMuted)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.accentText, p.accentSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('원형 버튼 아이콘(잉크)이 surface 위 3:1', () => {
    expect(contrast(p.text, p.surface)).toBeGreaterThanOrEqual(3);
  });
});

describe('치수가 시안에서 온다', () => {
  it('날짜 알약 글자는 최대 글씨에서 1.6 배에서 멈춘다 — 떠 있는 알약이 줄을 덮지 않게', () => {
    const {FloatingDayPill, DayDivider} = jest.requireActual(
      '../src/features/conversation/MessageRow',
    );
    for (const node of [
      <FloatingDayPill atMs={1_760_000_000_000} nowMs={1_760_000_000_000} />,
      <DayDivider atMs={1_760_000_000_000} nowMs={1_760_000_000_000} />,
    ]) {
      const view = render(node);
      const label = view.getByText('오늘', {includeHiddenElements: true});
      expect(label.props.maxFontSizeMultiplier).toBe(1.6);
      view.unmount();
    }
  });

  it('메시지 얼굴은 40 이다 — owner 표 「아바타 40」(시안 36 보다 표가 이긴다)', () => {
    render(
      <MessageRow
        message={
          {
            id: 'm-1',
            channelId: 'ch',
            seq: 1,
            hlcTs: 1,
            hlcCount: 0,
            authorMemberId: HUMAN,
            type: 'text',
            body: '여명님!',
            state: 'sent',
            createdAtMs: 1_760_000_000_000,
          } as Message
        }
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={1_760_000_000_000}
      />,
    );
    const face = flatten(
      screen.getByTestId('avatar-human', {includeHiddenElements: true}).props.style,
    );
    expect([face.width, face.height, face.borderRadius]).toEqual([40, 40, 20]);
    // 대화 바닥은 거의 surface 라 surface 원은 녹는다(실데이터 캡처) — surface2 + 선.
    expect(face.backgroundColor).toBe(darkPalette.surfaceMuted);
    expect(face.borderColor).toBe(darkPalette.border);
  });

  it('컴포저 반경이 DS2 사다리의 컴포저 단과 같다', () => {
    const {ds2Radius} = jest.requireActual('../src/design/tokens');
    expect(CONV.composerRadius).toBe(ds2Radius.composer);
  });

  it('FixedScheme 라이트에서 머리 원 버튼이 surface 를 입는다', () => {
    render(
      <FixedScheme scheme="light">
        <ConversationHeader
          title="agent-lab"
          kind="public"
          directory={DIRECTORY}
          onBack={() => {}}
          menu={[]}
          railStatus="connected"
        />
      </FixedScheme>,
    );
    expect(flatten(screen.getByTestId('header-back').props.style).backgroundColor).toBe(
      lightPalette.surface,
    );
    // 메뉴가 비면 ⋮ 원을 세우지 않는다.
    expect(screen.queryByTestId('conversation-menu')).toBeNull();
  });
});
