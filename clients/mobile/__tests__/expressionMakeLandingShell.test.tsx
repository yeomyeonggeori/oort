import type {Channel, Member} from '@momo/core/lib/api';
import * as api from '@momo/core/lib/api';
import {FIXTURE_LIST, FIXTURE_WORKSPACE_ID} from '@momo/core/features/expressions/fixtures';
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

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {__resetBackgroundStoreForTests} from '../src/design/background/store';
import {ThemeProvider} from '../src/design/theme';
import * as uploadTransport from '../src/features/attachments/uploadTransport';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// 「AI와 만들기」 요청 뒤 DM 으로 — 셸 안에서 끝까지 (#4962). 호스트·길의 단위 시험(`expressionMakeLanding.test`)이 못 재는 것: 대화 화면이
// 길을 컨텍스트로 **실제로 내리는지**, 그 길이 셸의 `onOpenConversation` 으로 이어져 **대화가 바뀌는지**, DM 이 채널 목록에 먼저 들어가
// 첫 그림부터 DM 머리(상대 얼굴)로 서는지, 그리고 **스레드의 입력창**에서 만든 요청이 옛 방의 스레드 판을 새 DM 위에 남기지 않는지.
// 시작을 일부러 스레드 입력창으로 한다: 본류 입력창은 같은 컨텍스트를 같은 길로 읽으므로 호스트 시험이 재고, 스레드 쪽만 이 화면의
// 배선(컨텍스트가 스레드 판을 덮는가 · `closeThread`)에 기댄다. 서버 경계(`fetch` 하나)만 가짜고, 요청 보내는 순서의 api 만 가짜다.
//
// 「목록에 먼저 넣기」를 재려고 채널 목록의 **두 번째 읽기부터는 대답하지 않는다**: 서버 목록이 아직 새 DM 을 모르는 그 순간에도 머리가 DM 으로
// 서야 한다(#4016). 목록이 곧 따라와 고쳐 주는 판이면 이 줄을 빼도 초록이라 아무것도 못 잰다.
// =============================================================================

const WS = FIXTURE_WORKSPACE_ID;
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const HELPER = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DM_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
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
    role: 'member',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [GENERAL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '이도현', handle: 'dohyun', role: 'owner'}),
  rosterMember({
    id: HELPER,
    kind: 'agent',
    displayName: '달무리 도우미',
    handle: 'dalmuri-helper',
    ownerHumanId: SELF_ID,
  }),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

/** 루트 하나와 그 답글 하나 — 본류의 루트 행에 「스레드 열기」 롤업이 선다. */
const ROOT_ID = 'msg-root';
const BASE_MS = 1_700_000_000_000;
const HISTORY = [
  {id: ROOT_ID, seq: 1, authorMemberId: SELF_ID, body: '배포는 금요일 오전 10시예요.'},
  {id: 'msg-reply', seq: 2, authorMemberId: HELPER, body: '확인했어요.', rootId: ROOT_ID},
].map(entry => ({
  channelId: GENERAL,
  hlcTs: entry.seq,
  hlcCount: 0,
  type: 'text',
  state: 'sent',
  createdAtMs: BASE_MS + entry.seq * 1000,
  ...entry,
}));

/** `openDirectMessage` 가 돌려주는 DM — 채널 목록(서버)은 이 방을 아직 모른다. */
const DM = {
  id: DM_ID,
  workspaceId: WS,
  kind: 'dm',
  name: '',
  muted: false,
  memberIds: [SELF_ID, HELPER],
} as unknown as Channel;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let channelListReads = 0;
/** 대답하지 않고 붙들어 둔 읽기. 시험이 끝날 때 풀어 준다 — 안 풀면 요청 시간 제한 타이머가 남아 jest 종료가 늦는다. */
const heldReads: (() => void)[] = [];

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/channels')) {
      channelListReads += 1;
      // 첫 읽기만 답한다. 뒤따르는 읽기는 시험이 끝날 때까지 안 온다 — 서버 목록이 새 DM 을 따라오기 전의 순간에 머문다.
      return channelListReads === 1
        ? jsonResponse(200, {channels: CHANNELS})
        : new Promise<Response>(resolve => {
            heldReads.push(() => resolve(jsonResponse(200, {channels: CHANNELS})));
          });
    }
    if (path.endsWith('/expressions')) {
      // 보관함은 비어 있다(그림 내려받기가 없다) — 「＋ 추가하기」는 추가 정책이 `members` 라 선다.
      return jsonResponse(200, {...FIXTURE_LIST, items: []});
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (/\/inbox(\/|$)/.test(path)) {
      return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) {
      return jsonResponse(200, {messages: url.includes(DM_ID) ? [] : HISTORY});
    }
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
  }) as unknown as typeof fetch;
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
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AppShell member={SELF} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
const imagePicker = jest.requireMock('expo-image-picker') as {
  __state: {result: unknown};
  __reset: () => void;
};

let releaseMotion: (() => void) | null = null;

beforeEach(async () => {
  // 시트가 내려가는 슬라이드를 끈다 — 「닫은 뒤 하기」가 바로 불린다. 이 시험의 주제는 움직임이 아니다.
  releaseMotion = await pinReduceMotion(true);
  mmkvStore.clear();
  imagePicker.__reset();
  __resetBackgroundStoreForTests();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  channelListReads = 0;
  installFetch();
});

afterEach(() => {
  cleanup();
  releaseMotion?.();
  releaseMotion = null;
  queryClient?.clear();
  queryClient = null;
  heldReads.splice(0).forEach(release => release());
  jest.restoreAllMocks();
});

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
}

describe('「AI와 만들기」 요청 뒤 (#4962)', () => {
  it('스레드의 입력창에서 보낸 요청이 시트를 내리고 스레드 판을 접고 그 에이전트의 DM 을 연다 — 머리는 첫 그림부터 DM(상대 얼굴 + 이름)이다', async () => {
    const openDm = jest
      .spyOn(api, 'openDirectMessage')
      .mockImplementation(async () => ({channel: DM, created: true}));
    jest.spyOn(api, 'createAttachmentUpload').mockImplementation(async () => ({
      id: 'att-1',
      status: 'pending',
      uploadUrl: 'https://u.invalid/p',
    }));
    jest.spyOn(uploadTransport, 'putAttachmentBytes').mockImplementation(() => ({
      done: Promise.resolve({ok: true}),
      abort: jest.fn(),
    }));
    jest
      .spyOn(api, 'completeAttachmentUpload')
      .mockImplementation(
        async (_w, _c, id) =>
          ({id}) as Awaited<ReturnType<typeof api.completeAttachmentUpload>>,
      );
    const send = jest
      .spyOn(api, 'sendMessage')
      .mockResolvedValue({} as Awaited<ReturnType<typeof api.sendMessage>>);

    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
    // 루트 행의 롤업을 눌러 스레드 판을 연다 — 지금은 #general 이고 채널 머리(얼굴이 아니라 # 글리프)다.
    fireEvent.press(await screen.findByTestId('thread-rollup'));
    await screen.findByTestId('thread-title');
    expect(screen.queryByTestId('conversation-title-face')).toBeNull();

    // 입력창은 둘이다(본류 · 스레드). 스레드 판이 뒤에 그려지므로 마지막이 스레드의 것이다.
    const buttons = screen.getAllByTestId('composer-expression');
    expect(buttons).toHaveLength(2);
    fireEvent.press(buttons[buttons.length - 1]);
    fireEvent.press(await screen.findByTestId('expression-sheet-tab-team'));
    await screen.findByTestId('expression-add-menu');
    await press('expression-add-menu');
    await press('expression-add-make');
    // 사진 양식이 먼저 열린다(#4984): 에이전트에게 부탁하는 길은 그 안의 단추 하나다.
    await waitFor(() =>
      expect(screen.getByTestId('expression-photo-agent')).toBeTruthy(),
    );
    await press('expression-photo-agent');
    await waitFor(() =>
      expect(screen.getByTestId(`expression-make-agent-${HELPER}`)).toBeTruthy(),
    );
    await press('expression-make-chip-bounce');
    imagePicker.__state.result = {
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/ImagePicker/dance.png',
          fileName: 'dance.png',
          mimeType: 'image/png',
          fileSize: 120_000,
          width: 1024,
          height: 768,
        },
      ],
    };
    await press('expression-make-photo');
    await press('expression-make-submit');

    // 대화가 바뀌었다: 머리가 DM 이다(얼굴 + 이름) — 목록이 아직 새 DM 을 모르는데도(채널 목록 읽기가 더는 안 온다).
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title-face')).toBeTruthy(),
    );
    expect(
      within(screen.getByTestId('conversation-header')).getByText('달무리 도우미'),
    ).toBeTruthy();
    // 옛 방의 스레드 판은 새 DM 위에 남지 않는다.
    expect(screen.queryByTestId('thread-title')).toBeNull();
    // 시트는 걷혔고 「확인」으로 돌아오는 길은 서지 않았다.
    expect(screen.queryByTestId('expression-make')).toBeNull();
    expect(screen.queryByTestId('expression-sheet-close')).toBeNull();
    // 요청은 그 DM 으로 나갔다.
    expect(openDm).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe(DM_ID);
  });
});
