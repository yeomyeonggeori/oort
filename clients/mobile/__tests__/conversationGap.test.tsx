import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {typingSegments} from '@momo/core/features/chat/typing';
import {QueryClientProvider, QueryClient} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {Keyboard, StyleSheet, Text, View} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {space} from '../src/design/tokens';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {AiConnectCard} from '../src/features/aiConnect/AiConnectCard';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import {Timeline} from '../src/features/conversation/Timeline';
import {
  TYPING_OVERHANG,
  TYPING_RESERVE,
  TypingBar,
} from '../src/features/conversation/TypingBar';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {
  installAppClock,
  SHELL_WAIT_TEST_TIMEOUT_MS,
} from './fixtures/fakeClock';

// =============================================================================
// 「마지막 행 아래 → 알약 위」 (#4264, 성재 실기 2026-10-23: 「타이핑하면서 채팅바랑 마지막 채팅
// 사이의 거리가 조금 과한 느낌」, Buzz 대조 약 20pt).
//
// ## 무엇을 재고, 무엇을 못 재는가
//
// 제스트에는 레이아웃이 없다. 여기서 재는 것은 **화면이 실제로 세우는 렌더 트리에서 읽은 스타일의 합**이다 —
// `ConversationScreen` 을 셸째로 마운트해서(`conversationRenders.test.tsx` 와 같은 방식) 목록 꼬리, 목록 판,
// 도크 판, 「작성 중」 줄, 컴포저 루트의 **실제 스타일 값**을 읽는다. 상수 하나를 다시 단정하는 시험이 아니다:
// 어느 한 조각이든(어느 파일에서든) 바뀌면 합이 바뀐다. 시뮬레이터가 재는 진짜 레이아웃(`measure/dockGap.tsx` 가
// `measureInWindow` 로 읽는 값)과 같은 합이어야 하고, 그 대조는 PR 본문의 표에 있다.
//
// ## 이 간격이 틀렸던 이유 — 안전 영역이 아니었다
//
// 이슈의 추정은 「키보드가 올라왔는데 홈 인디케이터 여백(34)이 목록 아래에 남아 있다」였다. 아니다:
// 올라간 동안 패널은 `insets.bottom - bottomInset` 만큼만 (= `KEYBOARD_GAP` 4) 지고, 목록은 판 안에서 도크
// 바로 위에 선다(`conversationLayout.test.tsx` 「올라온 키보드와 컴포저 사이의 틈…」이 그 쪽을 잰다). 틀린 것은
// 세 조각의 **합**이었다 — 목록 꼬리 8 + 「작성 중」 줄의 예약 20(줄 16 + 아래 4) + 컴포저 위 여백 8 = 36.
// 각자 다른 때 다른 이유로 정해졌고 합은 아무도 안 정했다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '박서연',
  handle: 'seoyeon',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

function rosterMember(over: Record<string, unknown>) {
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
  };
}

const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '박서연', handle: 'seoyeon'}),
  rosterMember({
    id: KIM_AGENT,
    kind: 'agent',
    displayName: '김인턴',
    handle: 'kim-intern',
    channelCount: 1,
    channelIds: [GENERAL],
  }),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

function restMessage(seq: number) {
  return {
    id: `msg-${seq}`,
    channelId: GENERAL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: KIM_AGENT,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}

const HISTORY = Array.from({length: 6}, (_, i) => restMessage(i + 1));

/** 스레드·활동 줄 시험이 쓰는 진짜 디렉터리(이름 조회가 비어 있으면 줄이 이름을 못 그린다). */
const DIRECTORY = makeDirectory(
  ROSTER.map(entry => ({...entry}) as unknown as RosterMember),
);
const ONE_REPLY = restMessage(1) as unknown as Message;

/** 이 이슈 **이전** 스레드 패널의 간격(꼬리 기본 8 + 컴포저 위 8). 이 이슈는 그것을 바꾸지 않는다. */
const THREAD_LIST_PILL_GAP = 16;

/** 이 이슈 **이전** AI 카드 위의 공기: 목록 꼬리 8 + 카드 `wrap` 의 위 4. 줄이 꼬리를 대신 지므로 이 합은 그대로다. */
const AI_CARD_AIR_ABOVE = 12;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/messages')) return jsonResponse(200, {messages: HISTORY});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    if (url.includes('/profile')) {
      return jsonResponse(403, {error: {message: 'agent owner required'}});
    }
    if (url.includes('/allowed-models')) {
      return jsonResponse(200, {allowedAgentModels: []});
    }
    if (url.includes('/inbox') || url.includes('/approvals')) {
      return jsonResponse(200, {mentions: [], approvals: [], items: []});
    }
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const centrifugeMock = jest.requireMock('centrifuge') as {__reset: () => void};
const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

let queryClient: QueryClient | null = null;

/**
 * Mount the signed-in tree and open #general, settled.
 *
 * `insetBottom` 은 홈 인디케이터가 있는 기기(34)를 흉내 낸다. 제스트의 안전 영역은 기본 0 이라, 0 에서만 재면
 * 「목록 아래에 안전 영역을 다시 더한」 결함은 더한 값이 0 이어서 못 잡는다(이슈의 첫 추정이 바로 그것이었다).
 */
async function openConversation(insetBottom = 0) {
  const safeArea = require('react-native-safe-area-context');
  jest.spyOn(safeArea, 'useSafeAreaInsets').mockReturnValue({
    top: insetBottom > 0 ? 47 : 20,
    left: 0,
    right: 0,
    bottom: insetBottom,
  });
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  await waitFor(() => expect(screen.getByTestId('timeline-list')).toBeTruthy());
  await waitFor(() =>
    expect(screen.getAllByTestId('message-row').length).toBeGreaterThan(0),
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(25);
  });
}

jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

beforeEach(() => {
  installAppClock();
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  sessionPort.applyLogin(LOGIN_BODY);
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ---- 렌더 트리에서 읽는 것 ----------------------------------------------------

type Flat = Record<string, unknown>;

const flat = (style: unknown): Flat => (StyleSheet.flatten(style as never) ?? {}) as Flat;
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const styleOf = (id: string, hidden = false): Flat =>
  flat(screen.getByTestId(id, {includeHiddenElements: hidden}).props.style);

/** 노드가 흐름에서 위에·아래에 먹는 세로(여백 + 안쪽 여백 + 테두리). */
const above = (s: Flat) => num(s.marginTop) + num(s.paddingTop) + num(s.borderTopWidth);
const below = (s: Flat) => num(s.marginBottom) + num(s.paddingBottom) + num(s.borderBottomWidth);

/**
 * 「작성 중」 줄이 흐름에서 차지하는 높이. 빈 줄은 `minHeight` 가 지키고(H-3), 아래 여백이 음수면 그만큼
 * 다음 형제가 올라와 걸친다.
 */
function typingFlowHeight(s: Flat): number {
  const own = Math.max(num(s.minHeight), num(s.paddingTop) + num(s.paddingBottom));
  return num(s.marginTop) + own + num(s.marginBottom);
}

type TestNode = ReturnType<typeof screen.getByTestId>;

/** 호스트 자식만 — 합성 컴포넌트(`TypingBar`·`Composer`)는 건너 들어간다. */
function hostChildren(node: TestNode): TestNode[] {
  const out: TestNode[] = [];
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (typeof child.type === 'string') out.push(child);
    else out.push(...hostChildren(child));
  }
  return out;
}

/** 마지막 행 아래(= 목록 꼬리 위 끝)에서 알약 위 끝까지, 흐름에서 먹는 조각들. */
function gapPieces() {
  const pieces = {
    /** 목록 꼬리 — 마지막 행 바로 아래의 이음매. */
    tail: num(styleOf('timeline-tail').height),
    /** 목록 판(`ConversationLayout`)이 꼬리 아래에 더하는 것. 없어야 한다. */
    listAfter: below(styleOf('conversation-list')),
    /** 도크 판이 자기 위에 더하는 것. 없어야 한다. */
    dockBefore: above(styleOf('composer-dock')),
    /** 「작성 중」 줄 — 쉬는 상태에서도 서 있는 예약 줄. */
    typing: typingFlowHeight(styleOf('composer-typing', true)),
    /** 컴포저가 자기 위에 늘 비워 두는 여백. */
    composerTop: above(styleOf('composer-root')),
    /** 알약이 자기 위에 더하는 것. 없어야 한다. */
    pillBefore: above(styleOf('composer-pill')),
  };
  return {...pieces, sum: Object.values(pieces).reduce((a, b) => a + b, 0)};
}

type Emitter = {emit: (event: string, payload: unknown) => void};
const emitter = (): Emitter => (Keyboard as unknown as {_emitter: Emitter})._emitter;
const keyboardFrame = (height: number) => ({
  endCoordinates: {height, screenX: 0, screenY: 0, width: 390},
  duration: 250,
  easing: 'keyboard',
});

describe('마지막 행 아래 → 알약 위 — 대화 화면 (#4264)', () => {
  it.each([0, 34])('쉬는 상태에서 CONV.listPillGap(Buzz 실측 ≈ 20pt)이다 — 화면이 실제로 세우는 조각들의 합 (하단 인셋 %i)', async inset => {
    await openConversation(inset);
    const g = gapPieces();
    // 합이 목표다. 조각 하나가 바뀌면(꼬리 8 을 되돌림 · 예약 줄에 아래 여백 4 를 되돌림 · 컴포저 위 여백을
    // 바꿈 · 목록 판/도크 판에 여백(안전 영역 같은 것)을 얹음) 이 줄이 빨개진다.
    expect(g.sum).toBe(CONV.listPillGap);
    // 이름이 있는 조각의 값도 따로 단정한다 — 합만 맞고 조각이 서로 상쇄한 채 맞는 것을 막는다.
    expect(g.tail).toBe(CONV.conversationTail);
    expect(g.typing).toBe(TYPING_RESERVE);
    expect(g.composerTop).toBe(CONV.composerTopAir);
    expect(g.listAfter).toBe(0);
    expect(g.dockBefore).toBe(0);
    expect(g.pillBefore).toBe(0);
  });

  it.each([0, 34])('키보드가 올라와도 내려가도 같은 값이다 — 조각들이 키보드를 모른다 (열림·닫힘 같은 간격, 하단 인셋 %i)', async inset => {
    await openConversation(inset);
    const closed = gapPieces();
    expect(closed.sum).toBe(CONV.listPillGap);
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(336));
    });
    act(() => {
      emitter().emit('keyboardDidShow', keyboardFrame(336));
    });
    // 리프트는 네이티브 판 통째의 변환이다. 어느 조각도 키보드 때문에 다시 계산되지 않는다.
    expect(gapPieces()).toEqual(closed);
    act(() => {
      emitter().emit('keyboardWillHide', keyboardFrame(0));
    });
    act(() => {
      emitter().emit('keyboardDidHide', keyboardFrame(0));
    });
    expect(gapPieces()).toEqual(closed);
  });

  it.each([0, 34])('코치마크는 마지막 행의 아래 가장자리 위에 선다 — 꼬리가 줄어든 만큼 코치의 아래 여백도 줄었다 (H-1a, 하단 인셋 %i)', async inset => {
    await openConversation(inset);
    const tail = num(styleOf('timeline-tail').height);
    const coachAir = num(styleOf('long-press-hint').paddingBottom);
    // 코치 아래 끝 = 도크 윗면 − 코치 아래 여백, 도크 윗면 = 마지막 행 상자 아래 + 목록 꼬리. 그래서 코치 아래 끝이 마지막 행
    // 상자 아래에서 얼마나 떨어졌는가 = 꼬리 − 코치 아래 여백이다. 전에는 8 − 8 = 0 이었다(코치가 마지막 글줄을 덮되 글줄의 아래
    // 끝보다 아래에서 끝났다). 같은 0 이어야 코치 밑으로 마지막 글줄의 아래 조각이 삐져나오지 않는다 — 꼬리만 줄이고 코치를 8 로
    // 두면 -8 이 되어 글줄 아래 0.67pt(16 Pro 실측)가 코치 밑에 보인다.
    expect(tail - coachAir).toBe(0);
  });

  it('도크의 쉬는 상태에서 흐름 안의 줄은 「작성 중」 예약 줄과 컴포저뿐이다 — 새 상시 줄이 생기면 합을 다시 정해야 한다', async () => {
    await openConversation();
    const children = hostChildren(screen.getByTestId('composer-dock'));
    // 첫 1회 코치마크(`long-press-hint`)처럼 도크 위에 **뜨는** 것은 절대 배치라 흐름의 높이를 안 먹는다 —
    // 이 단정은 흐름 안의 줄만 센다. 뜨는 것이 흐름에 들어오면(`position` 이 사라지면) 여기가 빨개진다.
    const inFlow = children.filter(node => flat(node.props.style).position !== 'absolute');
    expect(inFlow.map(node => node.props.testID)).toEqual(['composer-typing', 'composer-root']);
    // 뜨는 것이 실제로 절대 배치임을 같은 노드에서 읽는다(걸러 낸 것이 빈 껍데기가 아니다).
    const floating = children.filter(node => flat(node.props.style).position === 'absolute');
    expect(floating.length).toBeGreaterThan(0);
  });

  it('「작성 중」 줄은 나타나고 사라져도 흐름 높이가 같다 — H-3(남의 박자로 아래가 안 움직인다)이 산다', () => {
    const {rerender} = render(<TypingBar segments={[]} />);
    const idle = typingFlowHeight(flat(screen.getByTestId('composer-typing', {includeHiddenElements: true}).props.style));
    rerender(<TypingBar segments={typingSegments(['김민수'])} />);
    const shown = typingFlowHeight(flat(screen.getByTestId('composer-typing').props.style));
    expect(shown).toBe(idle);
    expect(idle).toBe(TYPING_RESERVE);
  });

  it('줄 상자가 예약보다 큰 만큼은 컴포저의 위 여백 안에서 끝난다 — 알약에 닿지 않고 후보 시트에 온전히 덮인다', () => {
    // 걸치는 몫(`TYPING_OVERHANG`)은 컴포저가 늘 비워 두는 위 여백 위에 앉는다. 그 여백보다 크면 줄 상자가
    // 알약 위로 내려앉는다. 엄격히 작아야 줄 글자 아래에 알약까지 빈 자리가 남는다.
    //
    // 후보 시트(`bottom: '100%'`)는 루트의 위 여백을 지나 **내용 상자 윗면**에 선다(시뮬레이터 실측, 16 Pro
    // `GAP-TYPING+SHEET`: 시트 아래 끝이 알약 위 끝에서 0.7pt(SE 1.0pt) 위). 그래서 걸침이 위 여백보다 작은 한 걸친 줄 상자는 시트
    // 아래 끝 위에 있고, 시트가 열리면 「작성 중」 줄은 전처럼 온전히 덮인다 — 글자 조각이 시트 밑으로 삐져나오지 않는다.
    expect(TYPING_OVERHANG).toBeGreaterThan(0);
    expect(TYPING_OVERHANG).toBeLessThan(CONV.composerTopAir);
  });

  it('작업 중 줄은 목록 꼬리가 사라진 만큼 자기 위 여백을 진다 — 마지막 행에 붙지 않는다', () => {
    render(
      <AgentActivityBar
        turns={[
          {
            memberId: KIM_AGENT,
            channelId: GENERAL,
            state: 'working',
            source: 'run',
            runId: 'A1111111-1111-4111-8111-A11111111111',
            startedAtMs: BASE_MS,
            headlines: [],
            lastActivityAtMs: BASE_MS,
          },
        ]}
        directory={DIRECTORY}
        nowMs={BASE_MS + 3000}
        live
      />,
    );
    // 꼬리 8 이 지키던 자리다. 대화 화면은 꼬리를 0 으로 줬으므로(`CONV.conversationTail`) 이 줄이 8 을 진다.
    expect(num(styleOf('composer-working').paddingTop)).toBe(
      space.sm - CONV.conversationTail,
    );
  });
});

describe('마지막 행 아래 → 알약 위 — 목록 꼬리가 사라진 만큼 위 여백을 지는 줄 (#4264)', () => {
  it('AI 카드는 12 를 그대로 지킨다 — 목록 꼬리 8 + 카드 위 4 였다', () => {
    const client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: Infinity}},
    });
    render(
      <QueryClientProvider client={client}>
        <AiConnectCard line={null} offline={false} onClose={() => {}} />
      </QueryClientProvider>,
    );
    // 카드가 대화 화면의 도크 맨 위에 서면 마지막 행 바로 아래다. 꼬리를 0 으로 준 만큼 카드가 위 여백을 져야
    // 카드(테두리가 있는 상자)가 마지막 행에 붙지 않는다.
    expect(num(styleOf('ai-connect-card-wrap').paddingTop) + CONV.conversationTail).toBe(
      AI_CARD_AIR_ABOVE,
    );
    client.clear();
  });
});

describe('「작성 중」 줄이 걸친 몫을 다음 줄이 받는다 (#4264)', () => {
  it('중단 영수증·개인 호출 알림(`stopOutcome`)은 위 여백 TYPING_OVERHANG 를 진다 — 두 글줄이 겹치지 않는다', () => {
    // 이 스타일은 화면 파일 안에 비공개로 있어(영수증은 취소 흐름을 거쳐야 서므로 마운트로는 닿기 어렵다) 소스의 스타일
    // 블록을 읽는다. 블록을 못 찾으면 통과가 아니라 실패다 — 못 찾은 채 초록인 가드는 없는 것과 같다.
    const source = fs
      .readFileSync(path.resolve(__dirname, '../src/screens/ConversationScreen.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(?<!:)\/\/.*$/gm, '');
    const block = /\n  stopOutcome:\s*\{([\s\S]*?)\n  \},/.exec(source);
    expect(block).not.toBeNull();
    expect(block?.[1]).toMatch(/paddingTop:\s*TYPING_OVERHANG\b/);
    // 걸침이 0 이 되면 이 단정은 할 일을 잃는다 — 그때 이 시험을 지울 것(양수여야 의미가 있다).
    expect(TYPING_OVERHANG).toBeGreaterThan(0);
  });
});

describe('마지막 행이 알약에 가려지지 않는다 (#4264)', () => {
  it('목록과 도크는 한 열의 형제다 — 도크가 목록 위로 올라타지 않는다', () => {
    render(
      <ConversationLayout
        list={<Text testID="list-slot">목록</Text>}
        composer={<View testID="composer-slot" />}
      />,
    );
    const list = styleOf('conversation-list');
    const dock = styleOf('composer-dock');
    // 목록이 남는 높이를 먹고(`flex: 1`), 도크는 흐름 안에 자기 높이로 선다. 도크가 절대 배치이거나
    // 음수 위 여백으로 목록 쪽으로 끌려 올라가면(꼬리 0 + 겹침) 마지막 행이 가려질 수 있다.
    expect(list.flex).toBe(1);
    expect(dock.position).toBeUndefined();
    expect(num(dock.marginTop)).toBeGreaterThanOrEqual(0);
    expect(num(list.marginBottom) + num(list.paddingBottom)).toBe(0);
  });

  it('스레드 패널의 간격은 이 이슈가 건드리지 않는다 — 꼬리 기본 8 + 컴포저 위 8 = 16', () => {
    // 스레드는 도크에 「작성 중」 줄이 없다. 공유 기본값(꼬리 8, 컴포저 위 8)을 대화 화면만 위해 줄이면
    // 스레드는 0 이 되어 알약이 마지막 답에 붙는다 — 그래서 대화 화면만 `tailGap` 으로 따로 받는다.
    // `ThreadPanel` 이 세우는 구성 그대로: `Timeline`(꼬리 기본) + `View` 안의 `Composer`.
    render(
      <ConversationLayout
        list={
          <Timeline
            messages={[ONE_REPLY]}
            directory={DIRECTORY}
            status="ready"
            myMemberId={SELF_ID}
            nowMs={BASE_MS + 5000}
          />
        }
        composer={
          <View>
            <Composer
              channelLabel="스레드"
              recipient="place"
              directory={DIRECTORY}
              draftKey="thread-gap"
              onSend={() => {}}
            />
          </View>
        }
      />,
    );
    const tail = num(styleOf('timeline-tail').height);
    const composerTop = above(styleOf('composer-root'));
    expect(tail).toBe(space.sm);
    expect(composerTop).toBe(CONV.composerTopAir);
    expect(tail + composerTop).toBe(THREAD_LIST_PILL_GAP);
  });
});
