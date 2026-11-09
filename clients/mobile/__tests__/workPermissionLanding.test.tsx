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

function installFetch(): void {
  const mock = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/signing-context')) {
      if (signing === 'fail') return jsonResponse(500, {error: {message: 'boom'}});
      return jsonResponse(200, signingContext(signing === 'required'));
    }
    if (url.includes('/device-keys')) return jsonResponse(200, {deviceKeys: []});
    if (url.includes('/permission-requests/')) {
      return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
    }
    if (url.includes('/replies')) return jsonResponse(200, {messages: [PERMISSION_REQUESTED]});
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: [SESSION]});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: HOSTS});
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

function renderLanding() {
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
            permissionLanding={{requestEventId: REQUEST, token: 1}}
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
