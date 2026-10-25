import type {Member} from '@momo/core/lib/api';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Dimensions, SectionList, StyleSheet, View} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {CONFIRM_GUARD_MS} from '../src/features/inbox/ApprovalDecision';
import {
  markAgentWorking,
  resetAgentWorking,
} from '../src/features/agents/workingSignal';
import {space} from '../src/design/tokens';
import AppShell from '../src/shell/AppShell';
import {HOME} from '../src/screens/SidebarScreen';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 홈 「작업 중」 카드: 아무도 가져가지 않은 요청과 「취소」 (#4285, ADR-0200 증보 3 E6).
//
// 가짜인 것은 둘뿐이다: `fetch`가 무엇을 답했는가, 소켓. 그 아래는 전부 진짜다 — 코어의 낱말 규칙,
// 생존 판정 읽기, 카드 모델, 카드 화면, 취소 호출과 409·오류를 읽는 규칙, 한 겹의 확인과 그 가드.
// **취소 함수를 mock하지 않는다**: 「확인 없이 취소가 나가지 않는다」는 호출 여부가 아니라 와이어에서
// 세어야 한다(`stopTurn.test.tsx`와 같은 이유).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const BOT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const OTHER_BOT_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const RUN = 'a1111111-1111-4111-8111-a11111111111';
const WELCOME_RUN = 'b2222222-2222-4222-8222-b22222222222';
const BASE = 'https://api.example.com';
const HOUR = 3_600_000;

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '정하윤',
  handle: 'hayun',
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
  rosterMember({id: SELF_ID, displayName: '정하윤', handle: 'hayun'}),
  rosterMember({id: BOT_ID, kind: 'agent', displayName: '달무리봇', handle: 'dalmuri-bot'}),
  rosterMember({id: OTHER_BOT_ID, kind: 'agent', displayName: '모래시계봇', handle: 'sand-bot'}),
];

const CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: 'ch-design', workspaceId: WS, kind: 'public', name: 'design', muted: false},
];

function jsonResponse(status: number, body: unknown, message?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(status >= 400 ? {error: {message: message ?? 'error'}} : body),
  } as unknown as Response;
}

interface Routes {
  /** 생존 판정: 에이전트 id → 상태. 적지 않은 에이전트는 404(= 호스티드가 아님). */
  liveness?: Record<string, string>;
  /** 취소 POST의 답. 생략하면 200. */
  cancel?: () => Response | Promise<Response>;
}

interface FetchLog {
  mock: jest.Mock;
  cancelCalls: () => unknown[][];
}

function installFetch(routes: Routes = {}): FetchLog {
  const mock = jest.fn(async (url: string) => {
    const live = /\/agents\/([^/]+)\/liveness$/.exec(url);
    if (live) {
      const state = routes.liveness?.[live[1].toLowerCase()];
      if (state === undefined) return jsonResponse(404, {}, 'not found');
      return jsonResponse(200, {
        agentMemberId: live[1],
        state,
        lastSignalAtMs: Date.now() - 3 * HOUR,
      });
    }
    if (url.includes('/cancel')) {
      return routes.cancel
        ? routes.cancel()
        : jsonResponse(200, {
            runId: RUN,
            status: 'cancelled',
            linkedWorkSessionIds: [],
            workSessionsTerminated: false,
          });
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (/\/v1\/workspaces\/[^/]+$/.test(url)) {
      return jsonResponse(200, {
        workspace: {id: WS, slug: 'dalmuri', name: '달무리 스튜디오', updatedAtMs: 0},
      });
    }
    return jsonResponse(200, {});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return {
    mock,
    cancelCalls: () => mock.mock.calls.filter(([url]) => String(url).includes('/cancel')),
  };
}

let queryClient: QueryClient | null = null;

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  resetAgentWorking();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  resetAgentWorking();
  jest.restoreAllMocks();
});

/** 서버가 「아무도 가져가지 않았다」고 답한 run의 신호. */
function waiting(over: Partial<AgentWorkingSignal> = {}, waitedMs = 17 * HOUR): AgentWorkingSignal {
  const now = Date.now();
  return {
    memberId: BOT_ID,
    channelId: 'ch-general',
    state: 'queued',
    source: 'run',
    runId: RUN,
    headlines: [],
    lastActivityAtMs: now,
    server: {
      phase: 'queued',
      leaseState: 'none',
      queuePosition: 1,
      aheadTotal: 0,
      queuedAtMs: now - waitedMs,
    },
    ...over,
  };
}

async function mountHome(routes: Routes = {}): Promise<FetchLog> {
  const log = installFetch(routes);
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  return log;
}

/** 가드 창을 지나서 누른 탭. 시계를 쥐지 않으면 「읽고 나서 누른 탭」을 만들 수 없다. */
function pressAfterGuard(testID: string): void {
  const real = Date.now;
  jest.spyOn(Date, 'now').mockImplementation(() => real() + CONFIRM_GUARD_MS + 50);
  fireEvent.press(screen.getByTestId(testID));
  (Date.now as unknown as jest.Mock).mockRestore();
}

const ARM = 'home-working-stop-arm';
const COMMIT = 'home-working-stop-commit';
const DISMISS = 'home-working-stop-dismiss';

/**
 * 접근성 글자 크기를 이 케이스의 것으로 바꾼다. RN은 글자 크기가 바뀔 때 같은 문(`Dimensions.set`)으로
 * 새 `fontScale`을 내보내므로, 이것은 뒷문이 아니라 기기에서 실제로 일어나는 갱신이다
 * (`composerDraftOffline.test.tsx`의 `setWindow`와 같다). 시험 기본값은 2라서 모든 케이스가 「큰 글씨」였다.
 */
const BASE_WINDOW = Dimensions.get('window');
function setFontScale(fontScale: number): void {
  const window = {...BASE_WINDOW, fontScale};
  Dimensions.set({window, screen: window});
}
afterEach(() => {
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
});

describe('홈 카드: 아직 받지 않았어요', () => {
  it('5시간 넘게 가져가지 않은 요청: 낱말·경고 문구·경과 시간·이유·취소가 한 장에 선다', async () => {
    await mountHome({liveness: {[BOT_ID]: 'woken_not_collected'}});
    act(() => markAgentWorking(waiting()));
    await waitFor(() =>
      expect(screen.getByTestId('home-working-state')).toHaveTextContent('아직 받지 않았어요'),
    );
    // 생존 판정은 읽는 데 한 박자 걸린다: 근거 줄 맨 앞이 그것으로 채워진다.
    await waitFor(() =>
      expect(screen.getByTestId('home-working-line')).toHaveTextContent(
        '#general · 깨웠지만 아직 안 가져감 · 17시간째 기다려요',
      ),
    );
    expect(screen.getByTestId('home-working-reason')).toHaveTextContent(
      '연결이 꺼져 있을 수 있어요',
    );
    // 서버가 말한 순번 낱말은 더는 카드의 말이 아니다.
    expect(screen.queryByText('대기 1번째')).toBeNull();
    // 「취소」: 낱말·낭독 이름·힌트가 모두 취소이고, 첫 탭은 묻는다.
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    expect(screen.getByTestId(ARM)).toHaveTextContent('취소');
    expect(screen.getByTestId(ARM).props.accessibilityLabel).toBe('요청 취소, 확인 필요');
    expect(screen.getByTestId(ARM).props.accessibilityHint).toBe('누르면 취소할지 물어요.');
    expect(screen.queryByText('중단')).toBeNull();
  });

  it('호스티드가 아닌 에이전트(404)는 경고 문구도 이유도 없지만 낱말과 취소는 선다', async () => {
    await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() =>
      expect(screen.getByTestId('home-working-state')).toHaveTextContent('아직 받지 않았어요'),
    );
    expect(screen.getByTestId('home-working-line')).toHaveTextContent('#general · 17시간째 기다려요');
    expect(screen.queryByTestId('home-working-reason')).toBeNull();
    expect(screen.getByTestId(ARM)).toBeTruthy();
  });

  it('5분이 안 된 요청은 「대기 1번째」 그대로이고 취소가 없다', async () => {
    await mountHome();
    act(() => markAgentWorking(waiting({}, 2 * 60_000)));
    await waitFor(() =>
      expect(screen.getByTestId('home-working-state')).toHaveTextContent('대기 1번째'),
    );
    expect(screen.queryByTestId('home-working-stop')).toBeNull();
    expect(screen.queryByTestId('home-working-reason')).toBeNull();
  });

  it('부른 사람이 없는 시스템 작업(환영)은 카드도 「에이전트 작업 · 모두 보기」 머리도 없다', async () => {
    await mountHome({liveness: {[BOT_ID]: 'woken_not_collected'}});
    act(() =>
      markAgentWorking(
        waiting({runId: WELCOME_RUN, server: {...waiting().server!, system: true}}),
      ),
    );
    // 신호가 스토어에 들어간 뒤에도 카드는 서지 않는다.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(screen.queryByTestId('home-working-card')).toBeNull();
    expect(screen.queryByTestId('home-work-head')).toBeNull();
  });

  it('시스템 작업이 더 오래 기다려도 카드는 사람이 부른 요청이고 「그 밖에」가 숨은 일을 세지 않는다', async () => {
    await mountHome();
    act(() => {
      markAgentWorking(
        waiting(
          {memberId: OTHER_BOT_ID, channelId: 'ch-design', runId: WELCOME_RUN, server: {...waiting().server!, system: true}},
          30 * HOUR,
        ),
      );
      markAgentWorking(waiting({}, 6 * 60_000));
    });
    await waitFor(() => expect(screen.getByTestId('home-working-card')).toBeTruthy());
    expect(screen.getByTestId('home-working-card')).toHaveTextContent(/달무리봇/);
    expect(screen.getByTestId('home-working-card')).not.toHaveTextContent(/모래시계봇/);
    expect(screen.getByTestId('home-working-line')).not.toHaveTextContent('그 밖에');
  });
});

describe('홈 카드의 취소: 한 겹의 확인, 같은 호출, 같은 규칙', () => {
  it('RED PROOF — 확인 없이는 취소 요청이 네트워크에 나가지 않는다', async () => {
    const log = await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());

    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId('home-working-stop-confirm')).toBeTruthy());
    expect(screen.getByTestId('home-working-stop-confirm')).toHaveTextContent(
      '취소하면 이 요청은 여기서 끝나요. 같은 일은 다시 시킬 수 있어요.',
      {exact: false},
    );
    expect(screen.getByTestId(COMMIT)).toHaveTextContent('취소 확정');
    // 호출 여부가 아니라 **와이어**를 센다.
    expect(log.cancelCalls()).toHaveLength(0);
    // 이 탭은 카드를 누른 것이 아니다: 대화가 열리지 않는다.
    expect(screen.queryByTestId('conversation-title')).toBeNull();

    // 그대로 두기 — 여전히 아무것도 나가지 않았다.
    fireEvent.press(screen.getByTestId(DISMISS));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    expect(log.cancelCalls()).toHaveLength(0);
  });

  it('확정하면 그 run에 POST 한 번이 나가고, 영수증이 요청을 취소했다고 말한다', async () => {
    const log = await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());

    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    // 가드 창 안의 탭은 확인이 아니라 같은 한 번의 동작이다.
    fireEvent.press(screen.getByTestId(COMMIT));
    expect(log.cancelCalls()).toHaveLength(0);
    expect(screen.getByTestId('home-working-stop-too-fast')).toBeTruthy();

    pressAfterGuard(COMMIT);
    await waitFor(() => expect(log.cancelCalls()).toHaveLength(1));
    const [url, init] = log.cancelCalls()[0] as [string, {method?: string}];
    expect(url).toContain(`/agent-runs/${RUN}/cancel`);
    expect(init.method).toBe('POST');
    await waitFor(() =>
      expect(screen.getByTestId('home-working-stop-outcome-cancelled')).toHaveTextContent(
        '달무리봇의 요청을 취소했어요.',
      ),
    );
    // 「취소했어요」 바로 옆에 「취소」가 남지 않는다 — 답을 받았으면 더 권하지 않는다(웹의 `settled`와 같다).
    expect(screen.queryByTestId(ARM)).toBeNull();
    expect(screen.queryByTestId(COMMIT)).toBeNull();
  });

  it('409(이미 끝났다)는 오류가 아니라 답이다 — 어떻게 끝났는지 말하고 확인 단계를 접는다', async () => {
    const log = await mountHome({
      cancel: () => jsonResponse(409, {}, 'agent run is already succeeded'),
    });
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    pressAfterGuard(COMMIT);
    await waitFor(() => expect(log.cancelCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('home-working-stop-outcome-alreadyOver')).toHaveTextContent(
        '이 실행은 이미 끝났어요. 에이전트가 먼저 마쳤어요.',
      ),
    );
    // 이미 끝난 일을 다시 멈추라고 권하지 않는다.
    expect(screen.queryByTestId(COMMIT)).toBeNull();
    expect(screen.queryByTestId(ARM)).toBeNull();
  });

  it('서버 오류는 문장으로 말하고 확인 단계가 남아 다시 누를 수 있다', async () => {
    const log = await mountHome({cancel: () => jsonResponse(500, {}, 'boom')});
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    pressAfterGuard(COMMIT);
    await waitFor(() => expect(log.cancelCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('home-working-stop-outcome-error')).toHaveTextContent(
        '취소하지 못했어요. 서버가 오류로 답했어요.',
      ),
    );
    // 「취소」 버튼 뒤에 「중단하지 못했어요」가 서지 않는다 — 실패 문장도 낱말 한 벌을 따른다.
    expect(screen.getByTestId('home-working-stop-outcome-error')).not.toHaveTextContent('중단');
    expect(screen.getByTestId(COMMIT)).toBeTruthy();
  });

  it('「취소」 줄이 본문 글자 기둥에 선다 — 첫 탭의 글자도 확인 줄도 같은 x다 (캡처에서 8pt 어긋났던 것)', async () => {
    await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    const flat = (testID: string) =>
      StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<string, number>;
    // 본문 글자 기둥: 눌리는 면의 가로 여백 + 줄의 들여쓰기.
    const column = flat('home-working-card').paddingHorizontal + flat('home-working-line').marginLeft;
    expect(column).toBe(HOME.cardPadX + HOME.indent);
    // 컨트롤 줄은 기둥에서 시작한다 → 확인 문장과 두 단추가 기둥에 선다.
    expect(flat('home-working-card-stop').paddingLeft).toBe(column);
    // 첫 탭은 글자가 가로 여백 space.sm 를 가지므로 상자를 그만큼 밀어 글자가 같은 기둥에 선다.
    const arm = flat(ARM);
    expect(arm.paddingHorizontal).toBe(space.sm);
    expect(arm.marginLeft + arm.paddingHorizontal).toBe(0);
  });

  it('확인 문장은 어절에서 끊긴다 — 좁은 카드에서 「있어 / 요.」로 끊기지 않는다', async () => {
    await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    expect(screen.getByTestId('home-working-stop-consequence').props.lineBreakStrategyIOS).toBe(
      'hangul-word',
    );
  });

  it('카드 본문을 누르면 취소가 있어도 그 대화가 열린다 — 취소 컨트롤은 누르는 면 밖이다', async () => {
    await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    // 컨트롤의 조상 중에 대화를 여는 면(`home-working-card`)이 없다.
    let node: ReturnType<typeof screen.getByTestId> | null = screen.getByTestId(ARM);
    const ancestors: unknown[] = [];
    for (; node !== null; node = node.parent) {
      ancestors.push(node.props.testID);
    }
    expect(ancestors).not.toContain('home-working-card');
    fireEvent.press(screen.getByTestId('home-working-card'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent(/general/),
    );
  });
});

describe('대화 아래 활동 줄 (대화 화면의 배선)', () => {
  async function openGeneral(routes: Routes = {}): Promise<FetchLog> {
    const log = await mountHome(routes);
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    await waitFor(() => expect(screen.getByTestId('conversation-title')).toBeTruthy());
    return log;
  }

  it.each([[1, 1], [1.49, 1], [1.5, undefined], [3.1, undefined]] as const)(
    'H1 대화 아래 활동 줄(글자 배율 %s): 「이름: 상태 낱말」은 줄 수 %s — 큰 글씨에서는 줄을 바꿔 「아직 받지 않았어요」를 끝까지 말한다',
    async (scale, lines) => {
      setFontScale(scale);
      await openGeneral({liveness: {[BOT_ID]: 'woken_not_collected'}});
      act(() => markAgentWorking(waiting()));
      await waitFor(() => expect(screen.getByTestId('activity-lead')).toBeTruthy());
      expect(screen.getByTestId('activity-lead').props.numberOfLines).toBe(lines);
    },
  );

  it('H1 대화 아래 활동 줄의 컨트롤도 글자 배율 상한(1.6)을 지킨다 — 「취소 확 / 정」으로 꺾이지 않고, 확인 문장은 끝까지 자란다', async () => {
    await openGeneral();
    act(() => markAgentWorking(waiting()));
    const arm = await waitFor(() => screen.getByTestId(`turn-stop-${BOT_ID}-arm`));
    expect(within(arm).getByText('취소').props.maxFontSizeMultiplier).toBe(1.6);
    fireEvent.press(arm);
    const commit = await waitFor(() => screen.getByTestId(`turn-stop-${BOT_ID}-commit`));
    expect(within(commit).getByText('취소 확정').props.maxFontSizeMultiplier).toBe(1.6);
    expect(
      within(screen.getByTestId(`turn-stop-${BOT_ID}-dismiss`)).getByText('그대로 두기').props
        .maxFontSizeMultiplier,
    ).toBe(1.6);
    expect(
      screen.getByTestId(`turn-stop-${BOT_ID}-consequence`).props.maxFontSizeMultiplier,
    ).toBeUndefined();
  });

  it('아무도 가져가지 않은 요청: 낱말·경고 문구·이유가 서고, 멈추는 컨트롤은 「취소」 한 벌이다', async () => {
    await openGeneral({liveness: {[BOT_ID]: 'woken_not_collected'}});
    act(() => markAgentWorking(waiting()));
    await waitFor(() =>
      expect(screen.getByTestId('composer-working')).toHaveTextContent(
        /달무리봇: 아직 받지 않았어요/,
      ),
    );
    // 대화 화면이 생존 판정을 읽어 줄에 넘긴다(읽는 데 한 박자 걸린다).
    await waitFor(() =>
      expect(screen.getByTestId('activity-detail')).toHaveTextContent(
        '깨웠지만 아직 안 가져감 · 17시간째 기다려요 · 연결이 꺼져 있을 수 있어요',
      ),
    );
    expect(screen.getByTestId('composer-working')).not.toHaveTextContent(/대기 1번째/);
    // 근거 글이 세 토막(생존 문구 · 경과 · 이유)까지 길어지므로 어절에서 끊는다 — 좁은 폭에서 글자 단위로 꺾여
    // 한 음절이 홀로 남지 않게(design-review #4285 r1 M7).
    expect(screen.getByTestId('activity-detail').props.lineBreakStrategyIOS).toBe('hangul-word');
    const arm = await waitFor(() => screen.getByTestId(`turn-stop-${BOT_ID}-arm`));
    expect(arm).toHaveTextContent('취소');
    expect(arm.props.accessibilityLabel).toBe('요청 취소, 확인 필요');
  });

  it('가져간 run은 줄도 컨트롤도 기존 말이다 — 「중단」', async () => {
    await openGeneral({liveness: {[BOT_ID]: 'woken_not_collected'}});
    act(() =>
      markAgentWorking(
        waiting({
          server: {
            phase: 'claimed',
            leaseState: 'live',
            claimedAtMs: Date.now() - 20_000,
            queuedAtMs: Date.now() - 17 * HOUR,
          },
        }),
      ),
    );
    const arm = await waitFor(() => screen.getByTestId(`turn-stop-${BOT_ID}-arm`));
    expect(arm).toHaveTextContent('중단');
    expect(arm.props.accessibilityLabel).toBe('실행 중단, 확인 필요');
    expect(screen.getByTestId('composer-working')).not.toHaveTextContent(/아직 받지 않았어요/);
  });

  it('활동 줄에서 취소를 확정하면 같은 취소 호출이 나간다', async () => {
    const log = await openGeneral();
    act(() => markAgentWorking(waiting()));
    const arm = await waitFor(() => screen.getByTestId(`turn-stop-${BOT_ID}-arm`));
    fireEvent.press(arm);
    await waitFor(() => expect(screen.getByTestId(`turn-stop-${BOT_ID}-commit`)).toBeTruthy());
    pressAfterGuard(`turn-stop-${BOT_ID}-commit`);
    await waitFor(() => expect(log.cancelCalls()).toHaveLength(1));
    expect(String((log.cancelCalls()[0] as [string])[0])).toContain(`/agent-runs/${RUN}/cancel`);
    await waitFor(() =>
      expect(screen.getByTestId('turn-stop-outcome-cancelled')).toHaveTextContent(
        '달무리봇의 요청을 취소했어요.',
      ),
    );
  });
});

describe('design-review r1 수리: 큰 글씨 머리·낭독·run을 넘는 상태 (#4285)', () => {
  // 이름 아래로 내리는 문턱은 아이콘 알약과 같은 `STACK_PILL_SCALE`(1.5)이다. 아바타·이름·태그·낱말이 한 줄에 서면
  // 가장 큰 글씨(AX5)에서 이름이 「달…」 한 글자로 잘렸다(design-review #4285 r1 H1).
  it.each([[1], [1.3], [1.49]])('H1 글자 배율 %s: 상태 낱말이 이름 줄에 서고 내려가지 않는다', async scale => {
    setFontScale(scale);
    await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId('home-working-state')).toBeTruthy());
    expect(screen.queryByTestId('home-working-live-stack')).toBeNull();
  });

  it.each([[1.5], [2], [3.1]])('H1 글자 배율 %s: 상태 낱말이 이름 아래 제 줄로 내려가고 한 곳에만 선다', async scale => {
    setFontScale(scale);
    await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId('home-working-live-stack')).toBeTruthy());
    expect(
      within(screen.getByTestId('home-working-live-stack')).getByTestId('home-working-state'),
    ).toHaveTextContent('아직 받지 않았어요');
    // 머리 줄에 한 번 더 그리지 않는다.
    expect(screen.getAllByTestId('home-working-state')).toHaveLength(1);
  });

  it('H1 컨트롤의 글자 배율에만 상한이 걸린다 — 첫 탭·「그대로 두기」·「취소 확정」은 1.6배, 확인 문장은 끝까지 자란다', async () => {
    await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    const armLabel = within(screen.getByTestId(ARM)).getByText('취소');
    expect(armLabel.props.maxFontSizeMultiplier).toBe(1.6);
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    expect(within(screen.getByTestId(DISMISS)).getByText('그대로 두기').props.maxFontSizeMultiplier).toBe(1.6);
    expect(within(screen.getByTestId(COMMIT)).getByText('취소 확정').props.maxFontSizeMultiplier).toBe(1.6);
    // 읽는 글자(확인 문장)는 상한 밖이다: 큰 글씨를 쓰는 사람이 이 문장을 못 읽게 하지 않는다.
    expect(screen.getByTestId('home-working-stop-consequence').props.maxFontSizeMultiplier).toBeUndefined();
  });

  it('M1 「에이전트 작업 · 모두 보기」 머리의 글자는 컨트롤 줄이라 상한이 있다 — 가장 큰 글씨에서 「모두 보」로 잘리지 않는다', async () => {
    // AX5 캡처(`ax-home-dark-idle`)가 드러낸 기존 머리 줄의 잘림이다. 카드 위에 같이 서는 한 묶음이다.
    await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId('home-work-head')).toBeTruthy());
    expect(screen.getByTestId('home-work-head').props.maxFontSizeMultiplier).toBe(1.6);
    expect(
      within(screen.getByTestId('home-work-see-all')).getByText('모두 보기 ›').props.maxFontSizeMultiplier,
    ).toBe(1.6);
  });

  it('H2 결과를 말로 알린다 — iOS VoiceOver는 accessibilityLiveRegion을 읽지 않고, 성공하면 눌린 컨트롤이 사라진다', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    const log = await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    // 확인 문장은 첫 탭이 이미 낭독한다.
    expect(announce).toHaveBeenCalledWith(
      expect.stringContaining('취소하면 이 요청은 여기서 끝나요'),
    );
    announce.mockClear();
    pressAfterGuard(COMMIT);
    await waitFor(() => expect(log.cancelCalls()).toHaveLength(1));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('달무리봇의 요청을 취소했어요.'));
  });

  it('H2 실패도 말로 알린다 — 컨트롤이 남아 다시 누를 수 있고, 그 사실을 소리로도 안다', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    const log = await mountHome({cancel: () => jsonResponse(500, {}, 'boom')});
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    announce.mockClear();
    pressAfterGuard(COMMIT);
    await waitFor(() => expect(log.cancelCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith('취소하지 못했어요. 서버가 오류로 답했어요.'),
    );
  });

  it('H1 확인 줄이 열려 카드가 자라면 결정 단추까지 목록을 내린다 — 처음 그려질 때와 자라지 않을 때는 스스로 스크롤하지 않는다', async () => {
    // 목 `View`의 `measureInWindow`는 콜백을 부르지 않는다: 카드가 창 아래로 넘친 장면(아래 끝 y=1500)을 건넨다.
    const measure = jest
      .spyOn(
        View.prototype as unknown as {measureInWindow: (cb: (...n: number[]) => void) => void},
        'measureInWindow',
      )
      .mockImplementation(cb => cb(0, 700, 300, 800));
    const scrollTo = jest.fn();
    jest
      .spyOn(SectionList.prototype, 'getScrollResponder')
      .mockReturnValue({scrollTo} as unknown as ReturnType<SectionList['getScrollResponder']>);
    await mountHome();
    act(() => markAgentWorking(waiting()));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    const stop = screen.getByTestId('home-working-stop');
    const layout = (height: number) =>
      fireEvent(stop, 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 300, height}}});

    // 처음 그려질 때: 사람이 건드리지 않았다.
    layout(44);
    // 자라지 않음(같거나 줄어듦): 스크롤하지 않는다.
    layout(44);
    layout(30);
    expect(scrollTo).not.toHaveBeenCalled();

    // 확인 줄이 열려 컨트롤 줄이 자랐다.
    layout(400);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
    const arg = scrollTo.mock.calls[0][0] as {y: number; animated: boolean};
    expect(arg.y).toBeGreaterThan(0);
    // 넘친 만큼만 내린다: y = 카드 아래 끝(1500) + 숨(`space.md`) − 보이는 아래 끝(창 높이 − 탭바 자리).
    // 거꾸로 풀어 탭바 자리가 사리에 맞는 값(0 이상, 수십 pt)인지 본다.
    const tabBarClearance = Dimensions.get('window').height - (1500 + space.md - arg.y);
    expect(tabBarClearance).toBeGreaterThanOrEqual(0);
    expect(tabBarClearance).toBeLessThan(200);
    expect(measure).toHaveBeenCalled();
  });

  it('H4 같은 에이전트·같은 대화의 요청이 둘이면, 앞 run을 취소한 뒤 같은 카드가 다음 요청의 「취소」를 다시 낸다 — 앞 run의 영수증을 든 채 컨트롤이 숨지 않는다', async () => {
    const RUN2 = 'a3333333-3333-4333-8333-a33333333333';
    const log = await mountHome();
    // 같은 에이전트·같은 대화의 대기 요청은 진행 스토어가 앞 run 하나의 신호로 합친다(`runCount` 2, `runId`는 맨 앞).
    act(() => markAgentWorking(waiting({runId: RUN, runCount: 2}, 17 * HOUR)));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    // 둘이 한 카드로 합쳐졌고, 확인 문장이 그 사실을 미리 말한다(맨 앞의 하나만 취소한다).
    expect(screen.getByTestId('home-working-stop-consequence')).toHaveTextContent('맨 앞의 하나만', {exact: false});
    pressAfterGuard(COMMIT);
    await waitFor(() => expect(log.cancelCalls()).toHaveLength(1));
    expect(String(log.cancelCalls()[0][0])).toContain(`/agent-runs/${RUN}/cancel`);
    await waitFor(() =>
      expect(screen.getByTestId('home-working-stop-outcome-cancelled')).toBeTruthy(),
    );
    expect(screen.queryByTestId(ARM)).toBeNull();

    // 서버가 앞 run을 취소로 끝내서 알린다: 카드는 다음 요청(아직 받지 않았어요)으로 이어진다.
    act(() => {
      resetAgentWorking();
      markAgentWorking(waiting({runId: RUN2}, 16 * HOUR));
    });
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    // 앞 run의 영수증이 남지 않고, 남은 요청을 취소할 길이 있다.
    expect(screen.queryByTestId('home-working-stop-outcome-cancelled')).toBeNull();
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    pressAfterGuard(COMMIT);
    await waitFor(() => expect(log.cancelCalls()).toHaveLength(2));
    expect(String(log.cancelCalls()[1][0])).toContain(`/agent-runs/${RUN2}/cancel`);
  });

  it('H4 확인을 열어 둔 채 앵커가 바뀌어도 남은 확인 상태로 다음 run을 취소하지 않는다', async () => {
    const RUN2 = 'a3333333-3333-4333-8333-a33333333333';
    const log = await mountHome();
    act(() => markAgentWorking(waiting({runId: RUN, runCount: 2}, 17 * HOUR)));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    // 확인이 열려 있는 동안 앞 run이 다른 길로 끝났다(예: 다른 기기에서 취소).
    act(() => {
      resetAgentWorking();
      markAgentWorking(waiting({runId: RUN2}, 16 * HOUR));
    });
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    expect(screen.queryByTestId(COMMIT)).toBeNull();
    expect(log.cancelCalls()).toHaveLength(0);
  });
});
