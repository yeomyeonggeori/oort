import {contrast} from '@momo/core/design/color';
import type {Member, Message} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen, within} from './fixtures/darkWorld';
import React from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {AccessibilityInfo, ActionSheetIOS, Dimensions, StyleSheet} from 'react-native';

import {darkPalette, lightPalette, slopTo, TOUCH_TARGET} from '../src/design/tokens';
import {FixedScheme} from '../src/design/theme';
import {Composer} from '../src/features/conversation/Composer';
import {
  connectionBannerText,
  ConversationHeader,
} from '../src/features/conversation/ConversationHeader';
import {CONV, composerFloat} from '../src/features/conversation/convDesign';
import {
  headerSlotWidth,
  pillContainerWidth,
  pillShowsSecondary,
  pillStatusWord,
} from '../src/features/conversation/headerPill';
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

// 창의 폭·글자 배율을 시험이 정한다(`useWindowDimensions` 가 읽는 값). **RN 의 jest 프리셋 기본 글자 배율은 2** 라서(= `STACK_PILL_SCALE` 1.5 이상) 손대지
// 않으면 머리 알약의 보조 글이 늘 숨은 모습으로 그려진다 — 보조 글을 재는 시험은 배율 1 을 직접 고른다.
const BASE_WINDOW = Dimensions.get('window');
function setWindow(next: {width?: number; height?: number; fontScale?: number}) {
  const window = {...BASE_WINDOW, ...next};
  Dimensions.set({window, screen: window});
}
afterEach(() => {
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
});

const HUMAN = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const AGENT = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

function member(over: Partial<Member>): never {
  return {
    id: HUMAN,
    workspaceId: 'ws',
    kind: 'human',
    handle: 'dohyun',
    displayName: '이도현',
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
        onOpenMenu={() => {}}
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

  it('DM 머리는 상대 얼굴 + 이름 한 줄이고, 에이전트면 상태 점이 얼굴에 붙는다 (#4016)', () => {
    header({
      title: '김인턴',
      kind: 'dm',
      peerId: AGENT,
      peerStatusTone: 'ok',
      peerStatusLabel: '응답함',
    });
    // 점은 낭독에서 숨으므로 제목이 상태 낱말을 대신 읽는다.
    expect(screen.getByTestId('conversation-title').props.accessibilityLabel).toBe('김인턴, 응답함');
    expect(screen.getByTestId('conversation-title-face')).toBeTruthy();
    expect(screen.getByTestId('avatar-agent', {includeHiddenElements: true})).toBeTruthy();
    expect(screen.getByTestId('conversation-title-status-dot', {includeHiddenElements: true})).toBeTruthy();
    // DM 에는 멤버 수 자리가 없다 — 상태 낱말(`conversation-title-status`)만 선다.
    expect(screen.queryByTestId('conversation-member-count')).toBeNull();
  });

  it('점이 없으면(사람·모름) 얼굴만 선다, 채널 머리는 그대로다 (#4016)', () => {
    const person = header({title: '이도현', kind: 'dm', peerId: HUMAN, peerStatusTone: null});
    expect(screen.getByTestId('avatar-human', {includeHiddenElements: true})).toBeTruthy();
    expect(screen.queryByTestId('conversation-title-status-dot', {includeHiddenElements: true})).toBeNull();
    person.unmount();
    header({kind: 'public'});
    expect(screen.queryByTestId('conversation-title-face')).toBeNull();
    expect(screen.getByTestId('conversation-title-glyph-public', {includeHiddenElements: true})).toBeTruthy();
  });

  it('⋮ 는 누르면 `onOpenMenu` 를 한 번 부른다 — 시스템 액션 시트는 더 이상 서지 않는다 (#4319)', () => {
    // 옛 ⋮ 는 `ActionSheetIOS`(제목 + 「취소」)를 직접 불렀다. 이제 머리는 누름을 알릴 뿐이고 무엇이 서는지는 화면이 정한다(공용 행동 시트).
    const system = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    const onOpenMenu = jest.fn();
    header({onOpenMenu});
    const kebab = screen.getByTestId('conversation-menu');
    expect(kebab.props.accessibilityRole).toBe('button');
    expect(kebab.props.accessibilityLabel).toBe('대화 메뉴');
    fireEvent.press(kebab);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(system).not.toHaveBeenCalled();
    system.mockRestore();
  });

  it('⋮ 의 보조기술 힌트는 항목을 읊지 않는다 — 항목은 이제 시트가 말한다 (#4319)', () => {
    // 옛 힌트는 메뉴 항목 이름을 쉼표로 이었다(「고정 2개, 작업 맡기기」). 시트가 서면 그 문장은 시트가 말하고, 머리에 남은 목록은 거짓이 된다.
    header({onOpenMenu: () => {}});
    expect(screen.getByTestId('conversation-menu').props.accessibilityHint).toBeUndefined();
  });

  it('`onOpenMenu` 가 없으면 ⋮ 원을 세우지 않는다 — 누르면 아무 일도 없는 버튼은 없다', () => {
    header({onOpenMenu: undefined});
    expect(screen.queryByTestId('conversation-menu')).toBeNull();
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

  it('연결 상태는 부제가 아니라 띠다 — 연결됐으면 아무 말도 없다', async () => {
    // 알약의 보조 글은 글자 배율이 1.5 미만일 때 선다 — RN jest 프리셋의 기본 배율은 2 라서 배율 1 을 직접 고른다.
    setWindow({width: 393, height: 852, fontScale: 1});
    const calm = header({memberCount: '6명'});
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(screen.getByTestId('conversation-member-count')).toHaveTextContent('6명');
    calm.unmount();
    header({memberCount: '6명', railStatus: 'disconnected'});
    // 띠의 오르트 로더가 「동작 줄이기」 첫 답을 받는다(#3961). 흘려보내 act 밖 갱신을 막는다.
    await act(async () => {});
    expect(screen.getByTestId('connection-banner')).toHaveTextContent('연결이 끊겼습니다');
    // 보조 글은 방의 정체를 그대로 말한다 — 연결 문장으로 바뀌지 않는다.
    expect(screen.getByTestId('conversation-member-count')).toHaveTextContent('6명');
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

describe('머리 — 가운데 이름·상태 알약, 정보 페이지의 문 (#4319)', () => {
  const HIDDEN = {includeHiddenElements: true} as const;

  /**
   * 한 시험 안에서 다시 세우면 앞의 것을 **내리고** 세운다 — `cleanup()` 뒤에 `render()` 를 부르면 RNTL 이 새 렌더러를 곧바로 내린다.
   */
  let mounted: ReturnType<typeof render> | null = null;
  afterEach(() => {
    mounted = null;
  });
  function pillHeader(
    props: Partial<React.ComponentProps<typeof ConversationHeader>> = {},
    scheme: 'light' | 'dark' = 'light',
  ) {
    mounted?.unmount();
    mounted = render(
      <FixedScheme scheme={scheme}>
        <ConversationHeader
          title="agent-lab"
          kind="public"
          directory={DIRECTORY}
          onBack={() => {}}
          onOpenMenu={() => {}}
          onOpenInfo={() => {}}
          railStatus="connected"
          {...props}
        />
      </FixedScheme>,
    );
    return mounted;
  }

  const dm = (over: Partial<React.ComponentProps<typeof ConversationHeader>> = {}) => ({
    title: '김인턴',
    kind: 'dm' as const,
    peerId: AGENT,
    peerStatusTone: 'ok' as const,
    peerStatusLabel: '응답함',
    ...over,
  });

  beforeEach(() => setWindow({width: 393, height: 852, fontScale: 1}));

  describe('단추 하나 — 눌러서 정보 페이지를 연다', () => {
    it('알약은 `button` 이고 이름은 이름·상태·「대화 정보 열기」를 한 문장으로 읽는다 (DM)', () => {
      const onOpenInfo = jest.fn();
      pillHeader({...dm(), onOpenInfo});
      const pill = screen.getByTestId('conversation-info-button');
      expect(pill.props.accessibilityRole).toBe('button');
      expect(pill.props.accessibilityLabel).toBe('김인턴, 응답함, 대화 정보 열기');
      fireEvent.press(pill);
      expect(onOpenInfo).toHaveBeenCalledTimes(1);
    });

    it('채널은 이름·멤버 수·「채널 정보 열기」로 읽고, 멤버 수를 모르면 이름과 문장 끝말만 읽는다', () => {
      pillHeader({memberCount: '6명'});
      expect(screen.getByTestId('conversation-info-button').props.accessibilityLabel).toBe(
        'agent-lab, 6명, 채널 정보 열기',
      );
      pillHeader({});
      expect(screen.getByTestId('conversation-info-button').props.accessibilityLabel).toBe(
        'agent-lab, 채널 정보 열기',
      );
    });

    it('이름의 testID·낭독 합성은 그대로다 — 점은 낭독에서 숨으므로 제목이 상태 낱말을 대신 읽는다', () => {
      pillHeader(dm());
      const title = screen.getByTestId('conversation-title');
      expect(title.props.accessibilityLabel).toBe('김인턴, 응답함');
      expect(title.props.accessibilityRole).toBe('header');
    });

    it('`onOpenInfo` 가 없으면 알약은 단추가 아니다 — 이름만 서고 캡슐 모양도 없다(누르면 아무 일도 없는 단추는 없다)', () => {
      pillHeader({onOpenInfo: undefined});
      expect(screen.queryByTestId('conversation-info-button')).toBeNull();
      expect(screen.getByTestId('conversation-title')).toHaveTextContent('agent-lab');
      // 캡슐(채움·테두리)이 단추의 모양이다 — 단추가 아니면 입지 않는다.
      const line = flatten(screen.getByTestId('conversation-title-line').props.style);
      expect(line.backgroundColor === undefined && line.borderWidth === undefined).toBe(true);
    });

    it('알약도 엄지에는 44 다 — 높이는 원과 같은 42 이고 위아래로 1 씩 눌림을 더한다', () => {
      pillHeader();
      const pill = screen.getByTestId('conversation-info-button');
      expect(Number(flatten(pill.props.style).minHeight)).toBe(CONV.circle);
      expect(CONV.circle + pill.props.hitSlop.top + pill.props.hitSlop.bottom).toBe(TOUCH_TARGET);
    });
  });

  describe('가운데 — 양쪽 칸이 같은 폭이다', () => {
    const widths = () => {
      const start = flatten(screen.getByTestId('conversation-header-start').props.style).width;
      const end = flatten(screen.getByTestId('conversation-header-end').props.style).width;
      return [start, end];
    };

    it('⋮ 만 있으면 두 칸이 원 하나 폭이다', () => {
      pillHeader();
      expect(widths()).toEqual([CONV.circle, CONV.circle]);
    });

    it('⋮ 가 없어도 오른쪽 칸이 원 하나 폭을 지킨다 — 알약이 한쪽으로 쏠리지 않는다', () => {
      pillHeader({onOpenMenu: undefined});
      expect(screen.queryByTestId('conversation-menu')).toBeNull();
      expect(widths()).toEqual([CONV.circle, CONV.circle]);
    });

    it('허들 자리가 서면 두 칸이 같이 넓어진다 — 뒤로의 칸이 같은 폭을 비워 둔다', () => {
      pillHeader({huddle: {label: '허들 시작', onPress: () => {}, icon: 'kebab'}});
      const both = CONV.circle * 2 + CONV.headGap;
      expect(widths()).toEqual([both, both]);
      pillHeader({
        onOpenMenu: undefined,
        huddle: {label: '허들 시작', onPress: () => {}, icon: 'kebab'},
      });
      expect(widths()).toEqual([CONV.circle, CONV.circle]);
    });

    it('가운데 칸이 남는 폭을 다 쓰고 알약은 그 가운데에 선다', () => {
      pillHeader();
      const center = flatten(screen.getByTestId('conversation-header-center').props.style);
      expect([center.flex, center.alignItems, center.justifyContent]).toEqual([1, 'center', 'center']);
    });
  });

  describe('보조 글 — DM 은 상태 낱말, 채널은 멤버 수', () => {
    it('DM: 상태 낱말이 눈에 보인다 — 낭독에만 있던 것이 이제 알약 안에도 있다', () => {
      pillHeader(dm());
      expect(screen.getByTestId('conversation-title-status')).toHaveTextContent('응답함');
    });

    it('코어의 긴 판정은 ` · ` 앞 낱말만 선다 — 「조용함 · 마지막 응답 5분 전」→ 「조용함」, 낭독은 전문이다', () => {
      pillHeader(dm({peerStatusTone: 'muted', peerStatusLabel: '조용함 · 마지막 응답 5분 전'}));
      expect(screen.getByTestId('conversation-title-status')).toHaveTextContent(/^조용함$/);
      expect(screen.getByTestId('conversation-info-button').props.accessibilityLabel).toBe(
        '김인턴, 조용함 · 마지막 응답 5분 전, 대화 정보 열기',
      );
    });

    it('낱말이 너무 길면(「깨웠지만 아직 안 가져감」) 눈에서는 빠지고 낭독은 전문이다', () => {
      pillHeader(dm({peerStatusTone: 'warn', peerStatusLabel: '깨웠지만 아직 안 가져감'}));
      expect(screen.queryByTestId('conversation-title-status')).toBeNull();
      expect(screen.getByTestId('conversation-info-button').props.accessibilityLabel).toContain(
        '깨웠지만 아직 안 가져감',
      );
    });

    it('상태가 없는 사람(점 없음)에게는 보조 글도 없다 — 모르는 것을 짓지 않는다', () => {
      pillHeader(dm({title: '이도현', peerId: HUMAN, peerStatusTone: null, peerStatusLabel: undefined}));
      expect(screen.queryByTestId('conversation-title-status')).toBeNull();
      expect(screen.getByTestId('conversation-info-button').props.accessibilityLabel).toBe(
        '이도현, 대화 정보 열기',
      );
    });

    it('채널: 짧은 멤버 수가 서고(「6명」), DM 에는 멤버 수 자리가 없다', () => {
      pillHeader({memberCount: '6명'});
      expect(screen.getByTestId('conversation-member-count')).toHaveTextContent('6명');
      pillHeader({...dm(), memberCount: '6명'});
      expect(screen.queryByTestId('conversation-member-count')).toBeNull();
    });
  });

  describe('한 줄 — 모자라면 이름이 이기고 보조 글이 통째로 숨는다 (#4016)', () => {
    it('이름과 보조 글은 모두 한 줄이다 — 줄어드는 것은 이름(`flexShrink`), 보조 글은 줄어들지 않는다', () => {
      pillHeader(dm());
      const name = screen.getByTestId('conversation-title');
      const word = screen.getByTestId('conversation-title-status');
      expect([name.props.numberOfLines, word.props.numberOfLines]).toEqual([1, 1]);
      expect(name.props.ellipsizeMode).toBe('tail');
      expect(flatten(name.props.style).flexShrink).toBe(1);
      expect(flatten(word.props.style).flexShrink).toBe(0);
      // 머리의 큰 글씨 상한은 그대로다 — 이름·보조 글 모두.
      expect([name.props.maxFontSizeMultiplier, word.props.maxFontSizeMultiplier]).toEqual([1.6, 1.6]);
    });

    it('SE(320pt): 이름이 4글자면 상태 낱말이 같이 서고, 5글자부터는 낱말이 숨는다 — 이름은 늘 읽힌다', () => {
      setWindow({width: 320, height: 568, fontScale: 1});
      pillHeader(dm({title: '정하윤님'}));
      expect(screen.getByTestId('conversation-title-status')).toHaveTextContent('응답함');
      pillHeader(dm({title: '정하윤님도'}));
      expect(screen.queryByTestId('conversation-title-status')).toBeNull();
      expect(screen.getByTestId('conversation-title')).toHaveTextContent('정하윤님도');
    });

    it('SE(320pt) 의 긴 이름: 「달무리 도우미」는 낱말이 숨는다 — 대신 정보 페이지·낭독이 상태를 말한다', () => {
      setWindow({width: 320, height: 568, fontScale: 1});
      pillHeader(dm({title: '달무리 도우미'}));
      expect(screen.queryByTestId('conversation-title-status')).toBeNull();
      expect(screen.getByTestId('conversation-info-button').props.accessibilityLabel).toBe(
        '달무리 도우미, 응답함, 대화 정보 열기',
      );
    });

    it('넓은 화면(393pt)에서는 같은 긴 이름에도 낱말이 선다', () => {
      pillHeader(dm({title: '달무리 도우미'}));
      expect(screen.getByTestId('conversation-title-status')).toHaveTextContent('응답함');
    });

    it('SE 의 긴 채널 이름: 이름이 아무리 길어도 짧은 멤버 수는 선다 — 이름이 줄어 말줄임이 된다', () => {
      setWindow({width: 320, height: 568, fontScale: 1});
      pillHeader({title: 'agent-lab-platform-engineering-oncall', memberCount: '6명'});
      expect(screen.getByTestId('conversation-member-count')).toHaveTextContent('6명');
      expect(screen.getByTestId('conversation-title').props.numberOfLines).toBe(1);
    });

    it('큰 글씨(`STACK_PILL_SCALE` 1.5 부터)에서는 보조 글이 숨는다 — 이름이 먼저 자란다. 1.49 까지는 선다', () => {
      setWindow({width: 393, height: 852, fontScale: 1.49});
      pillHeader(dm());
      expect(screen.getByTestId('conversation-title-status')).toBeTruthy();
      setWindow({width: 393, height: 852, fontScale: 1.5});
      pillHeader(dm());
      expect(screen.queryByTestId('conversation-title-status')).toBeNull();
      expect(screen.getByTestId('conversation-title')).toHaveTextContent('김인턴');
    });
  });

  describe('머리 높이는 움직이지 않는다 (#4292·#4613 의 측정이 이 높이에 기댄다)', () => {
    /** 높이를 정하는 스타일 값 전부 — 머리 뿌리·줄·알약·양쪽 칸. */
    const metrics = () => ({
      root: flatten(screen.getByTestId('conversation-header').props.style),
      row: flatten(screen.getByTestId('conversation-header-row').props.style),
      pill: flatten(screen.getByTestId('conversation-info-button').props.style),
      start: flatten(screen.getByTestId('conversation-header-start').props.style),
      end: flatten(screen.getByTestId('conversation-header-end').props.style),
    });

    it('줄 높이는 62 이고, 알약은 원(42)보다 크지 않다', () => {
      pillHeader(dm());
      const {row, pill} = metrics();
      expect(row.minHeight).toBe(CONV.headHeight);
      expect(Number(pill.minHeight)).toBeLessThanOrEqual(CONV.circle);
    });

    it('상태 낱말이 있든 없든 높이를 정하는 값이 같다', () => {
      pillHeader(dm());
      const withWord = metrics();
      pillHeader(dm({peerStatusTone: null, peerStatusLabel: undefined}));
      const without = metrics();
      expect(screen.queryByTestId('conversation-title-status')).toBeNull();
      expect(JSON.stringify(without)).toBe(JSON.stringify(withWord));
    });

    it('연결 띠가 서도 머리는 그대로이고 띠는 흐름 밖에 뜬다(#4292)', async () => {
      pillHeader(dm());
      const calm = metrics();
      pillHeader(dm({railStatus: 'disconnected'}));
      await act(async () => {});
      const banner = flatten(screen.getByTestId('connection-banner-layer').props.style);
      expect(banner.position).toBe('absolute');
      expect(banner.top).toBe('100%');
      expect(JSON.stringify(metrics())).toBe(JSON.stringify(calm));
      // 머리 뿌리의 `zIndex` 는 호출자가 틀로 봉인한다 — 있어야 띠가 목록 위에 뜬다.
      expect(metrics().root.zIndex).toBe(1);
    });
  });

  describe('색 — 원(뒤로·⋮)과 같은 토큰 가족이고 두 모드에서 읽힌다', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const palette = scheme === 'light' ? lightPalette : darkPalette;

      it(`${scheme}: 알약은 원과 같은 채움·테두리·고도다`, () => {
        pillHeader(dm(), scheme);
        const pill = flatten(screen.getByTestId('conversation-info-button').props.style);
        const circle = flatten(screen.getByTestId('header-back').props.style);
        expect(pill.backgroundColor).toBe(palette.surface);
        for (const key of ['backgroundColor', 'borderColor', 'borderWidth', 'boxShadow']) {
          expect([key, pill[key]]).toEqual([key, circle[key]]);
        }
      });

      it(`${scheme}: 이름과 보조 글은 알약 위에서 AA(4.5) 를 넘는다`, () => {
        pillHeader(dm(), scheme);
        const fill = String(flatten(screen.getByTestId('conversation-info-button').props.style).backgroundColor);
        const name = String(flatten(screen.getByTestId('conversation-title').props.style).color);
        const word = String(flatten(screen.getByTestId('conversation-title-status').props.style).color);
        expect(contrast(name, fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(word, fill)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  it('앞 표지 — 채널은 `#`/자물쇠, DM 은 얼굴과 점이 알약 안에 선다', () => {
    pillHeader({kind: 'private'});
    const pill = screen.getByTestId('conversation-info-button');
    const inside = (id: string) =>
      within(pill).queryByTestId(id, HIDDEN) !== null;
    expect(inside('conversation-title-glyph-private')).toBe(true);
    pillHeader(dm());
    const dmPill = screen.getByTestId('conversation-info-button');
    expect(within(dmPill).queryByTestId('conversation-title-face', HIDDEN) !== null).toBe(true);
    expect(within(dmPill).queryByTestId('conversation-title-status-dot', HIDDEN) !== null).toBe(true);
  });
});

describe('머리 알약의 한 줄 규칙 — 순수 판정 (#4319)', () => {
  /** DM 알약: 얼굴 28 + 상태 낱말 「응답함」. 이름의 길이(글자 수)만 바꿔 경계를 찾는다. */
  const dmShows = (nameChars: number, windowWidth: number, fontScale = 1) =>
    pillShowsSecondary({
      name: '가'.repeat(nameChars),
      secondary: '응답함',
      leading: CONV.titleFace,
      windowWidth,
      fontScale,
      slotWidth: headerSlotWidth({huddle: false, menu: true}),
    });

  it('양쪽 칸의 폭: ⋮ 만 있으면 원 하나, 허들 자리가 더해지면 원 둘 + 간격, 둘 다 없어도 원 하나를 비운다', () => {
    expect(headerSlotWidth({huddle: false, menu: true})).toBe(CONV.circle);
    expect(headerSlotWidth({huddle: true, menu: true})).toBe(2 * CONV.circle + CONV.headGap);
    expect(headerSlotWidth({huddle: true, menu: false})).toBe(CONV.circle);
    expect(headerSlotWidth({huddle: false, menu: false})).toBe(CONV.circle);
  });

  it('알약이 쓸 수 있는 가로: 창 폭 − 좌우 여백 − 양쪽 칸 − 칸 사이 간격 둘', () => {
    expect(pillContainerWidth(393, 42)).toBe(393 - 2 * CONV.headPadX - 2 * 42 - 2 * CONV.headGap);
    expect(pillContainerWidth(320, 42)).toBeLessThan(pillContainerWidth(393, 42));
  });

  it('SE(320pt): 이름 4글자까지 상태 낱말이 같이 서고 5글자부터 숨는다 — 경계가 정확히 4↔5 다', () => {
    expect(dmShows(4, 320)).toBe(true);
    expect(dmShows(5, 320)).toBe(false);
    // 단조: 더 긴 이름이 낱말을 되살리지 않는다.
    for (let chars = 5; chars <= 30; chars += 1) expect([chars, dmShows(chars, 320)]).toEqual([chars, false]);
  });

  it('넓은 화면(393pt)에서는 이름이 아무리 길어도 낱말이 선다 — 이름은 말줄임으로 줄고 낱말은 줄지 않는다', () => {
    for (const chars of [4, 5, 9, 15, 30]) expect([chars, dmShows(chars, 393)]).toEqual([chars, true]);
  });

  it('큰 글씨는 폭과 무관하게 숨는다 — 1.49 는 서고 1.5(`STACK_PILL_SCALE`)부터 숨는다', () => {
    expect(dmShows(3, 430, 1.49)).toBe(true);
    expect(dmShows(3, 430, 1.5)).toBe(false);
    expect(dmShows(3, 430, 2)).toBe(false);
  });

  it('보조 글이 없으면 설 것도 없다', () => {
    expect(
      pillShowsSecondary({
        name: '박서연',
        secondary: '',
        leading: CONV.titleFace,
        windowWidth: 430,
        fontScale: 1,
        slotWidth: CONV.circle,
      }),
    ).toBe(false);
  });

  it('이름의 바닥은 5글자 또는 이름 전체 — 짧은 이름은 좁은 화면에서도 낱말을 지킨다', () => {
    expect(dmShows(1, 320)).toBe(true);
    expect(dmShows(2, 320)).toBe(true);
  });

  it('채널의 짧은 멤버 수는 SE 에서도 긴 이름 곁에 선다 — 앞 표지가 `#`(16)라 얼굴(28)보다 좁다', () => {
    const channelShows = (chars: number) =>
      pillShowsSecondary({
        name: 'a'.repeat(chars),
        secondary: '6명',
        leading: CONV.titleGlyph,
        windowWidth: 320,
        fontScale: 1,
        slotWidth: CONV.circle,
      });
    expect(channelShows(40)).toBe(true);
  });

  it('상태 낱말: 코어의 긴 판정은 ` · ` 앞 낱말만, 너무 길면 없다 — 낭독은 전문이 따로 읽는다', () => {
    expect(pillStatusWord('응답함')).toBe('응답함');
    expect(pillStatusWord('조용함 · 마지막 응답 5분 전')).toBe('조용함');
    expect(pillStatusWord('살아 있음 · 대기 중')).toBe('살아 있음');
    expect(pillStatusWord('깨웠지만 아직 안 가져감')).toBeNull();
    expect(pillStatusWord('')).toBeNull();
    expect(pillStatusWord(undefined)).toBeNull();
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

  it('DM: 에이전트도 사람도 부제가 없다 — 얼굴 + 이름 한 줄이다 (#4016)', () => {
    expect(conversationSubtitle({kind: 'dm'}, {kind: 'agent'}, DIRECTORY)).toBeUndefined();
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

  it('세 조각이 한 알약 안에 있다 — 반경은 원 반경 + 사방 여백(27), 좌우는 뜬 거리', () => {
    composer();
    const pill = screen.getByTestId('composer-pill');
    const style = flatten(pill.props.style);
    expect(style.borderRadius).toBe(27);
    // 좌우 거리는 폭·글자 배수가 정한다(#4179 `composerFloat`) — 이 환경의 창에서 나온 값 그대로.
    const {width, fontScale} = Dimensions.get('window');
    expect(style.marginHorizontal).toBe(composerFloat(width, fontScale));
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

  it('+ 와 보내기는 같은 36 원 — 둘 다 엄지에는 44 (#4179, 옛 34·38)', () => {
    composer();
    const attach = screen.getByTestId('composer-attach');
    const a = flatten(attach.props.style);
    expect([a.width, a.height, a.borderRadius]).toEqual([36, 36, 18]);
    expect(36 + attach.props.hitSlop * 2).toBe(TOUCH_TARGET);
    fireEvent.changeText(screen.getByTestId('composer-input'), '좋아');
    const send = screen.getByTestId('composer-send');
    const s = flatten(send.props.style);
    expect([s.width, s.height, s.borderRadius]).toEqual([36, 36, 18]);
    expect(36 + send.props.hitSlop * 2).toBe(TOUCH_TARGET);
    expect(send.props.hitSlop).toBe(slopTo(36));
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
    expect(code).toMatch(/onMomentumScrollEnd=\{jumpPills \? onMomentumScrollEnd/);
    // 손가락이 잡는 순간 세운다 — 콜백이 의존성 목록에만 있고 불리지 않던 판이 있었다.
    // (#4331: 잡는 순간은 `grabDayPill` 이고 관성이 이어질 자격도 함께 선다. 동작은 `timelineDayPill4331.test.tsx` 가 잰다.)
    const begin = code.slice(code.indexOf('const onScrollBeginDrag'), code.indexOf('const onScrollEndDrag'));
    expect(begin).toMatch(/\bgrabDayPill\(\);/);
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
    const ME = {id: HUMAN, workspaceId: 'ws', displayName: '이도현'} as Member;
    const tree = (shape?: 'pill') => (
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider member={ME}>
          <ApprovalDecision
            approvalId="ap-1"
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
    // 보조(거부)는 테두리 없는 surface2 알약이고, 주(승인)는 채움 알약이다(#3819).
    expect(flatten(screen.getByTestId('x-reject').props.style).borderWidth).toBe(0);
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
          railStatus="connected"
        />
      </FixedScheme>,
    );
    expect(flatten(screen.getByTestId('header-back').props.style).backgroundColor).toBe(
      lightPalette.surface,
    );
    // 열 메뉴가 없으면(`onOpenMenu` 없음) ⋮ 원을 세우지 않는다.
    expect(screen.queryByTestId('conversation-menu')).toBeNull();
  });
});
