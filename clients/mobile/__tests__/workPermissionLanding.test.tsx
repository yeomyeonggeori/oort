import type {Member} from '@momo/core/lib/api';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
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
import {AccessibilityInfo} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  SIGNING_OFF_NOTICE,
  SIGNING_UNKNOWN_NOTICE,
} from '../src/features/work/WorkConversation';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import WorkSessionDetailScreen from '../src/screens/WorkSessionDetailScreen';
import {SessionProvider} from '../src/session/useSession';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 권한 요청 알림이 착지하는 세션 화면 (#5593 수리 1회차 — design-review H1·M2·M3).
//
//   H1  서버가 기기 서명을 요구하지 않거나(서버 기본값) 그 설정을 읽지 못하면 카드를 그릴 수 없다. 그때도 착지한 상세
//       보기가 이유(대화 보기와 같은 문장)와 지금 답할 곳(그 세션의 맥)을 말한다. 읽지 못했으면 「다시 확인」이 있다.
//   M2  주인에게 열린 요청이 있는 세션의 머리·배지는 「응답 필요」다(목록 칩과 같은 코어 낱말).
//   M3  착지가 있으면 낭독 초점의 주인은 착지 자리 하나다 — 머리가 함께 초점을 청하지 않는다.
//
// 화면 하나를 세운다. 가짜는 서버의 답(`fetch`)과 네이티브 핸들(낭독 초점이 **어느 원소**로 갔는지 읽으려고 핸들 자리에
// 그 원소의 testID 를 돌려준다)이다.
// =============================================================================

jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...jest.requireActual('react-native/Libraries/ReactNative/RendererProxy'),
  findNodeHandle: jest.fn(
    (instance: {props?: {testID?: string}} | null) => instance?.props?.testID ?? null,
  ),
}));

const formatMessage = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog}).formatMessage;

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const CH = '33333333-3333-4333-8333-333333333333';
const HOST = '77777777-7777-4777-8777-777777777777';
const SID = 'aaaa0002-0000-4000-8000-000000000002';
const ROOT = 'bbbb0002-0000-4000-8000-000000000002';
const REQUEST = 'cccc0002-0000-4000-8000-000000000002';
const BASE = 'https://api.example.com';
const NOW = Date.now();

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

const SESSION = {
  id: SID,
  workspaceId: WS,
  channelId: CH,
  memberId: SELF_ID,
  hostId: HOST,
  rootMessageId: ROOT,
  tool: 'claude',
  label: '배포 스크립트 정리',
  status: 'running',
  observation: 'open',
  observerGrantCount: 0,
  remoteAttachAvailable: false,
  remoteDisplayAvailable: false,
  startedAtMs: NOW - 20 * 60_000,
};

const HOSTS = [
  {
    id: HOST,
    workspaceId: WS,
    scope: 'member',
    ownerMemberId: SELF_ID,
    type: 'app',
    displayName: '성재 맥북',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
];

const PERMISSION_REQUESTED = {
  id: REQUEST,
  channelId: CH,
  rootId: ROOT,
  seq: 30,
  hlcTs: NOW - 60_000,
  hlcCount: 0,
  authorMemberId: SELF_ID,
  type: 'system',
  body: 'DO_NOT_RENDER_MESSAGE_BODY',
  state: 'sent',
  createdAtMs: NOW - 60_000,
  props: {
    kind: 'work_session_event',
    schema: 'momo.work_session.acp_event.v1',
    event_type: 'approval.requested',
    event_id: REQUEST,
    event_ts: NOW - 60_000,
    event: {
      work_session_id: SID,
      event_id: REQUEST,
      options: [
        {option_id: 'allow-once', kind: 'allow_once', name: 'Allow once'},
        {option_id: 'reject-once', kind: 'reject_once', name: 'Reject'},
      ],
    },
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 서버가 서명 요구를 어떻게 답하는가. `fail` 은 읽기 실패(5xx)다 — 폰은 그것을 「모름」으로 읽는다. */
type Signing = 'required' | 'off' | 'fail';
let signing: Signing = 'required';
/** 서명 설정 읽기를 붙잡아 둔다(「다시 확인」이 도는 동안을 보려고). null 이면 바로 답한다. */
let signingHold: Promise<void> | null = null;

function signingContext(required: boolean) {
  return {
    instanceId: 'instance-1',
    serverTimeMs: NOW,
    maxLifetimeMs: 60_000,
    maxClockSkewMs: 5_000,
    humanControlSignatureRequired: required,
    hostRegisterSignatureRequired: false,
  };
}

function installFetch(hosts: typeof HOSTS = HOSTS): void {
  const mock = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/signing-context')) {
      if (signingHold !== null) await signingHold;
      if (signing === 'fail') return jsonResponse(500, {error: {message: 'boom'}});
      return jsonResponse(200, signingContext(signing === 'required'));
    }
    if (url.includes('/device-keys')) return jsonResponse(200, {deviceKeys: []});
    if (url.includes('/permission-requests/')) {
      return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
    }
    if (url.includes('/replies')) return jsonResponse(200, {messages: [PERMISSION_REQUESTED]});
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: [SESSION]});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: hosts});
    if (url.includes('/channels')) {
      return jsonResponse(200, {
        channels: [{id: CH, workspaceId: WS, kind: 'public', name: 'general', muted: false}],
      });
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: []});
    return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
}

let queryClient: QueryClient | null = null;

/** `landing: null` 은 목록 줄로 들어간 길이다 — 셸의 `openWorkSession` 은 `{sessionId}` 만 넘긴다(알림 착지 없음). */
function renderLanding({
  landing = {requestEventId: REQUEST, token: 1},
}: {landing?: {requestEventId: string; token: number} | null} = {}) {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider member={SELF}>
        <RealtimeContext.Provider value={{rail: null, status: 'connecting', subscriptionsWanted: false}}>
          <WorkSessionDetailScreen
            active
            sessionId={SID}
            permissionLanding={landing ?? undefined}
            onBack={() => {}}
            onOpenConversation={() => {}}
          />
        </RealtimeContext.Provider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

const SETTLE = {timeout: 10_000};
jest.setTimeout(30_000);

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  signing = 'required';
  signingHold = null;
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

describe('H1 카드를 그릴 수 없는 착지도 이유와 답할 곳을 말한다', () => {
  it('서버가 서명을 요구하지 않으면(기본값) 카드 자리에 그 이유와 「지금은 그 맥에서 답해 주세요」가 선다', async () => {
    signing = 'off';
    installFetch();
    renderLanding();

    const elsewhere = await waitFor(
      () => screen.getByTestId('work-detail-permission-elsewhere'),
      SETTLE,
    );
    expect(within(elsewhere).getByText(formatMessage('mobile.workPermission.elsewhereTitle'))).toBeTruthy();
    expect(
      within(elsewhere).getByText(
        `${SIGNING_OFF_NOTICE} ${formatMessage('mobile.workPermission.elsewhereOnHost', {host: '성재 맥북'})}`,
      ),
    ).toBeTruthy();
    // 꺼짐은 서버의 정해진 답이라 다시 물을 단추가 없다. 카드도, 「이미 닫혔어요」도 없다.
    expect(screen.queryByTestId('work-detail-permission-recheck')).toBeNull();
    expect(screen.queryByTestId('work-permission-card')).toBeNull();
    expect(screen.queryByTestId('work-detail-permission-gone')).toBeNull();
  });

  it('서명 설정을 읽지 못하면 같은 안내에 「다시 확인」이 서고, 다시 읽어 요구함이면 카드가 선다', async () => {
    signing = 'fail';
    installFetch();
    renderLanding();

    const elsewhere = await waitFor(
      () => screen.getByTestId('work-detail-permission-elsewhere'),
      SETTLE,
    );
    expect(
      within(elsewhere).getByText(
        `${SIGNING_UNKNOWN_NOTICE} ${formatMessage('mobile.workPermission.elsewhereOnHost', {host: '성재 맥북'})}`,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('work-permission-card')).toBeNull();

    // 서버가 돌아왔다. 5분 캐시를 건너 다시 묻는 길은 이 단추다.
    signing = 'required';
    fireEvent.press(within(elsewhere).getByTestId('work-detail-permission-recheck'));
    await waitFor(() => expect(screen.getByTestId('work-permission-card')).toBeTruthy(), SETTLE);
    expect(screen.queryByTestId('work-detail-permission-elsewhere')).toBeNull();
  });
});

describe('수리 3회차 — 「다시 확인」은 읽는 동안을 보이고, 다시 읽어도 모르면 그 사실을 말한다(M1)', () => {
  it('누르면 단추가 「다시 확인 중」(바쁨)이 되고, 또 못 읽으면 안내 문장이 그 사실과 답할 곳을 말한다', async () => {
    signing = 'fail';
    installFetch();
    renderLanding();
    const answerWhere = formatMessage('mobile.workPermission.elsewhereOnHost', {host: '성재 맥북'});

    const elsewhere = await waitFor(
      () => screen.getByTestId('work-detail-permission-elsewhere'),
      SETTLE,
    );
    // 문장이 권하는 행동이 바로 아래 단추와 같다(「다시 열어 주세요」가 아니다).
    expect(within(elsewhere).getByText(`${SIGNING_UNKNOWN_NOTICE} ${answerWhere}`)).toBeTruthy();
    expect(SIGNING_UNKNOWN_NOTICE).toMatch(/다시 확인해 주세요\.$/);
    expect(within(elsewhere).getByTestId('work-detail-permission-recheck')).toHaveTextContent(
      formatMessage('mobile.workPermission.recheck'),
    );

    // 서버는 아직 답하지 못한다. 읽기를 붙잡아 두고 누른다 — 도는 동안 단추가 그것을 말한다.
    let release: () => void = () => {};
    signingHold = new Promise<void>(resolve => {
      release = resolve;
    });
    fireEvent.press(within(elsewhere).getByTestId('work-detail-permission-recheck'));
    await waitFor(
      () =>
        expect(screen.getByTestId('work-detail-permission-recheck').props.accessibilityState).toMatchObject({
          busy: true,
          disabled: true,
        }),
      SETTLE,
    );
    expect(screen.getByTestId('work-detail-permission-recheck')).toHaveTextContent(
      formatMessage('mobile.workPermission.rechecking'),
    );

    // 또 못 읽었다: 화면이 그대로가 아니라 「다시 확인했지만 …」과 답할 곳을 말하고, 단추는 다시 누를 수 있다.
    signingHold = null;
    await act(async () => {
      release();
    });
    await waitFor(
      () =>
        expect(
          screen.getByText(`${formatMessage('mobile.workPermission.recheckMissed')} ${answerWhere}`),
        ).toBeTruthy(),
      SETTLE,
    );
    const button = screen.getByTestId('work-detail-permission-recheck');
    expect(button.props.accessibilityState?.busy).not.toBe(true);
    expect(button.props.accessibilityState?.disabled).not.toBe(true);
    expect(button).toHaveTextContent(formatMessage('mobile.workPermission.recheck'));
    expect(screen.queryByTestId('work-permission-card')).toBeNull();
  });
});

describe('M2 주인에게 열린 요청이 있는 세션의 머리는 「응답 필요」다', () => {
  it('부제와 배지가 같은 코어 낱말을 쓴다 — 「실행 중」이 아니다', async () => {
    installFetch();
    renderLanding();
    await waitFor(() => expect(screen.getByTestId('work-permission-card')).toBeTruthy(), SETTLE);
    expect(screen.getByTestId('work-detail-status')).toHaveTextContent('응답 필요');
    expect(screen.getByTestId('work-detail-status')).not.toHaveTextContent('실행 중');
  });
});

describe('M3 착지가 있으면 낭독 초점의 주인은 착지 자리 하나다', () => {
  it('카드의 질문이 초점을 받고, 머리는 초점을 청하지 않는다', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation(() => {});
    installFetch();
    renderLanding();
    await waitFor(() => expect(screen.getByTestId('work-permission-card')).toBeTruthy(), SETTLE);
    await waitFor(
      () => expect(focus).toHaveBeenCalledWith('work-permission-ask'),
      SETTLE,
    );
    // 머리 초점이 뒤따라 오지 않는다(따뜻한 길에서는 부모 효과가 늦게 돌아 머리가 이겼다).
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(focus).not.toHaveBeenCalledWith('work-detail-focus');
  });

  it('카드를 그릴 수 없는 착지는 그 안내 상자가 초점을 받는다', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation(() => {});
    signing = 'off';
    installFetch();
    renderLanding();
    await waitFor(
      () => expect(screen.getByTestId('work-detail-permission-elsewhere')).toBeTruthy(),
      SETTLE,
    );
    await waitFor(
      () => expect(focus).toHaveBeenCalledWith('work-detail-landing-focus'),
      SETTLE,
    );
    expect(focus).not.toHaveBeenCalledWith('work-detail-focus');
  });
});

describe('수리 2회차 owner 낱말(2026-11-09) — 세션 화면의 쉬운 말과 「연결 안 됨」', () => {
  it('정보 칸은 「실행하는 컴퓨터」·「데스크탑 앱」이고 대화로 가는 줄은 「시작한 대화로 가기」다', async () => {
    installFetch();
    renderLanding();
    await waitFor(() => expect(screen.getByTestId('work-permission-card')).toBeTruthy(), SETTLE);
    expect(screen.getByText('실행하는 컴퓨터')).toBeTruthy();
    expect(screen.getByText('성재 맥북 · 연결됨')).toBeTruthy();
    expect(screen.getAllByText('데스크탑 앱').length).toBeGreaterThan(0);
    expect(screen.getByText('시작한 대화로 가기')).toBeTruthy();
    expect(screen.queryByText('호스트')).toBeNull();
    expect(screen.queryByText(/발원|T1 ·/)).toBeNull();
  });

  it('맥이 연결돼 있지 않으면 머리·배지와 정보 칸이 같은 낱말 「연결 안 됨」을 쓴다 — 머리·배지는 주어를 붙여 「맥 연결 안 됨」(수리 3회차 L3)', async () => {
    installFetch(HOSTS.map(h => ({...h, online: false})));
    renderLanding();
    await waitFor(
      () => expect(screen.getByTestId('work-detail-status')).toHaveTextContent('맥 연결 안 됨'),
      SETTLE,
    );
    // 부제(머리)와 배지 둘 다 주어가 있다 — 폰 자신의 「오프라인입니다.」와 헷갈리지 않게.
    expect(screen.getAllByText('맥 연결 안 됨')).toHaveLength(2);
    expect(screen.queryByText('연결 안 됨')).toBeNull();
    expect(screen.getByText('성재 맥북 · 연결 안 됨')).toBeTruthy();
    expect(screen.queryByText(/호스트 응답 없음|오프라인/)).toBeNull();
  });
});

describe('수리 3회차 L1 — 목록 줄로 들어간 길도 카드 없는 착지와 같은 안내를 받는다', () => {
  it('알림 착지 없이 연 세션 화면에서도 서명 요구가 꺼져 있으면 이유와 「지금은 그 맥에서 답해 주세요」가 선다', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation(() => {});
    signing = 'off';
    installFetch();
    renderLanding({landing: null});

    const elsewhere = await waitFor(
      () => screen.getByTestId('work-detail-permission-elsewhere'),
      SETTLE,
    );
    expect(
      within(elsewhere).getByText(
        `${SIGNING_OFF_NOTICE} ${formatMessage('mobile.workPermission.elsewhereOnHost', {host: '성재 맥북'})}`,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('work-permission-card')).toBeNull();
    // 착지가 없으니 「이미 닫혔어요」도 없고, 낭독 초점은 예전처럼 머리가 받는다. (이 시험은 파일 맨 끝에 둔다: 머리 초점은
    // `InteractionManager` 로 미뤄져 뒤 시험의 초점 단정에 섞일 수 있다.)
    expect(screen.queryByTestId('work-detail-permission-gone')).toBeNull();
    await waitFor(() => expect(focus).toHaveBeenCalledWith('work-detail-focus'), SETTLE);
  });
});
