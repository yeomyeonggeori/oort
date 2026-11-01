import 'react-native-url-polyfill/auto';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react-native';
import {AppState} from 'react-native';
import * as api from '@momo/core/lib/api';
import type {Message} from '@momo/core/lib/api';
import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {
  makeDirectory,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import * as uploadTransport from '../src/features/attachments/uploadTransport';
import {Composer} from '../src/features/conversation/Composer';
import {
  MakeLandingContext,
  useLandOnMadeDm,
  type OpenMadeConversation,
} from '../src/features/conversation/makeLanding';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {workspaceKeys} from '../src/features/workspace/queries';
import {pinReduceMotion} from './fixtures/reduceMotion';

jest.mock('../src/features/emoji/catalog', () => ({
  loadPhoneEmojiCatalog: jest.fn(),
}));
jest.mock('../src/lib/haptics', () => ({
  haptics: {event: jest.fn(), light: jest.fn()},
}));

// =============================================================================
// 「AI와 만들기」 요청을 보낸 뒤 에이전트 DM 으로 (#4962, #4891·#4942 후속).
//
// 두 호스트(입력창의 표현 시트 `Composer` · 메시지 액션 시트 `MessageActionSheet`)를 **진짜 부품으로** 세운다. 고르개(`TeamExpressionPicker`)에
// 직접 콜백을 쥐여 주는 시험(`expressionAdd.test`)은 호스트가 그 콜백을 안 넘겨도 초록이라 이 약속을 못 잰다 — 여기서는 대화 화면이
// 컨텍스트로 내리는 길(`MakeLandingContext`)만 주고, 호스트가 그것을 고르개까지 이어 주는지를 잰다. 서버는 코어 fixture 서버와 폰 저장소,
// 요청 보내는 순서(DM → 올리기 → 보내기)는 `expressionAdd.test` 와 같은 api 가짜다.
//
// 대화 화면이 그 길을 셸(`onOpenConversation(channelId, title)`)에 잇는 곳은 `useLandOnMadeDm` 의 시험(아래 마지막)과 셸 시험
// (`expressionMakeLandingShell.test`)이 잰다.
// =============================================================================

const ko = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog});
const imagePicker = jest.requireMock('expo-image-picker') as {
  __state: {result: unknown};
  __reset: () => void;
};
const stores: PhoneExpressionStore[] = [];
const clients: QueryClient[] = [];
let release: (() => void) | undefined;

const AGENT = {
  id: '00000000-0000-4000-8000-0000000000a1',
  workspaceId: FIXTURE_WORKSPACE_ID,
  kind: 'agent',
  status: 'active',
  displayName: '김인턴',
  handle: 'intern',
  channelCount: 0,
  channelIds: [],
  capabilities: [],
};
const DM = {id: 'dm-1', kind: 'dm'} as unknown as api.Channel;

const waving: CatalogEmoji = {
  glyph: '👋',
  name: 'waving hand',
  koreanName: '손 흔들기',
  shortcodes: ['wave'],
  keywords: ['hello'],
  category: 'people',
  version: 1,
};

function setup() {
  const server = createExpressionFixtureServer({nowMs: Date.now()});
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request: async (input: ExpressionFixtureRequest) => server.request(input)},
    {write: (key: string) => `file:///fixture/${key}`, remove: jest.fn()},
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  return store;
}

/** 요청 보내는 길의 api 가짜. `sendResults` 는 보내기 시도마다의 결과(`Error` 면 실패, 다 쓰면 마지막 것). */
function wire(sendResults: (Error | null)[] = [null]) {
  let sends = 0;
  jest
    .spyOn(api, 'openDirectMessage')
    .mockImplementation(async () => ({channel: DM, created: true}));
  jest.spyOn(api, 'createAttachmentUpload').mockImplementation(async () => ({
    id: 'att-1',
    status: 'pending',
    uploadUrl: 'https://u.invalid/p',
  }));
  jest
    .spyOn(uploadTransport, 'putAttachmentBytes')
    .mockImplementation(() => ({
      done: Promise.resolve({ok: true}),
      abort: jest.fn(),
    }));
  jest
    .spyOn(api, 'completeAttachmentUpload')
    .mockImplementation(
      async (_w, _c, id) =>
        ({id}) as Awaited<ReturnType<typeof api.completeAttachmentUpload>>,
    );
  const send = jest.spyOn(api, 'sendMessage').mockImplementation(async () => {
    sends += 1;
    const outcome = sendResults[Math.min(sends, sendResults.length) - 1];
    if (outcome) throw outcome;
    return {} as Awaited<ReturnType<typeof api.sendMessage>>;
  });
  jest
    .spyOn(api, 'fetchRoster')
    .mockResolvedValue([AGENT] as unknown as Awaited<
      ReturnType<typeof api.fetchRoster>
    >);
  return {send};
}

function album() {
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
}

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
}

/** 「＋」에서 「AI와 만들기」 장으로 들어가 사진·움직임을 고르고 요청을 보낸다(에이전트는 하나라 미리 골라진다). */
async function fillAndSend() {
  await press('expression-add-menu');
  await press('expression-add-make');
  // 사진 양식이 먼저 열린다(#4984): 에이전트에게 부탁하는 길은 그 안의 단추 하나다.
  await waitFor(() =>
    expect(screen.getByTestId('expression-photo-agent')).toBeTruthy(),
  );
  await press('expression-photo-agent');
  await waitFor(() =>
    expect(screen.getByTestId(`expression-make-agent-${AGENT.id}`)).toBeTruthy(),
  );
  await press('expression-make-chip-bounce');
  album();
  await press('expression-make-photo');
  await press('expression-make-submit');
}

async function loadedStore() {
  const store = setup();
  await store.refresh(true);
  return store;
}

function withLanding(
  store: PhoneExpressionStore,
  landing: OpenMadeConversation | undefined,
  node: React.ReactElement,
) {
  return render(
    <MakeLandingContext.Provider value={landing}>
      <PhoneExpressions.Provider value={store}>{node}</PhoneExpressions.Provider>
    </MakeLandingContext.Provider>,
  );
}

const DIRECTORY = makeDirectory([]);
function composer() {
  return (
    <Composer
      recipient="place"
      channelLabel="agent-lab"
      directory={DIRECTORY}
      attachmentTarget={{workspaceId: 'ws', channelId: 'ch'}}
      onSend={jest.fn()}
    />
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  release = await pinReduceMotion(true);
  AppState.currentState = 'active';
  imagePicker.__reset();
  (loadPhoneEmojiCatalog as jest.Mock).mockResolvedValue([waving]);
  emojiFrequency.reset();
  emojiSkinTone.reset();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  // 캐시 정리: 구독 없는 쿼리의 gc 타이머(5분)가 남으면 jest 가 끝나지 않는다.
  clients.splice(0).forEach(client => client.clear());
  release?.();
  release = undefined;
  jest.restoreAllMocks();
});

describe('입력창의 표현 시트 (호스트 1)', () => {
  it('요청을 보내면 시트를 내리고 그 DM 으로 간다 — 「확인」으로 목록에 돌아오지 않는다', async () => {
    wire();
    const store = await loadedStore();
    const landing = jest.fn();
    withLanding(store, landing, composer());
    fireEvent.press(screen.getByTestId('composer-expression'));
    fireEvent.press(await screen.findByTestId('expression-sheet-tab-team'));
    await screen.findByTestId('expression-add-menu');
    await fillAndSend();
    // 길에 나간 것은 openDirectMessage 가 돌려준 그 채널이다.
    await waitFor(() => expect(landing).toHaveBeenCalledTimes(1));
    expect(landing).toHaveBeenCalledWith(DM);
    // 시트가 걷혔다(이 호스트의 표현 시트도, 그 안의 만들기 장도).
    expect(screen.queryByTestId('expression-make')).toBeNull();
    expect(screen.queryByTestId('expression-sheet-close')).toBeNull();
    expect(screen.queryByTestId('expression-make-done')).toBeNull();
  });

  it('보내기가 실패하면 시트에 그대로 머문다 — 길은 부르지 않고, 다시 시도가 이어서 가면 그때 한 번 간다', async () => {
    const {send} = wire([new Error('network'), null]);
    const store = await loadedStore();
    const landing = jest.fn();
    withLanding(store, landing, composer());
    fireEvent.press(screen.getByTestId('composer-expression'));
    fireEvent.press(await screen.findByTestId('expression-sheet-tab-team'));
    await screen.findByTestId('expression-add-menu');
    await fillAndSend();
    await waitFor(() =>
      expect(screen.getByTestId('expression-make-error')).toBeTruthy(),
    );
    expect(screen.getByTestId('expression-make-error').props.children).toBe(
      ko.formatMessage('expressions.make.failSend'),
    );
    // 머문다: 만들기 장도 시트도 그대로이고, 다시 시도 단추가 서 있다.
    expect(landing).not.toHaveBeenCalled();
    expect(screen.getByTestId('expression-make')).toBeTruthy();
    expect(screen.getByTestId('expression-sheet-close')).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
    await press('expression-make-submit');
    await waitFor(() => expect(landing).toHaveBeenCalledTimes(1));
    expect(landing).toHaveBeenCalledWith(DM);
    expect(send).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('expression-make')).toBeNull();
  });
});

describe('메시지 액션 시트 (호스트 2)', () => {
  it('반응 고르개의 팀 탭에서 만든 요청도 시트를 먼저 내린 뒤 그 DM 으로 간다', async () => {
    wire();
    const store = await loadedStore();
    const order: string[] = [];
    const landing = jest.fn(() => {
      order.push('land');
    });
    const onClose = jest.fn(() => {
      order.push('close');
    });
    withLanding(
      store,
      landing,
      <MessageActionSheet
        message={
          {
            id: 'msg',
            authorMemberId: 'self',
            body: '금요일 배포',
            createdAtMs: 0,
          } as Message
        }
        chips={[]}
        availability={{
          react: true,
          reply: false,
          quote: false,
          pin: false,
          edit: false,
          delete: false,
        }}
        authorLabel="기획팀"
        onClose={onClose}
        onToggleReaction={jest.fn()}
        onReply={jest.fn()}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByTestId('all-reactions'));
    fireEvent.press(await screen.findByTestId('emoji-tab-team'));
    await screen.findByTestId('expression-add-menu');
    await fillAndSend();
    await waitFor(() => expect(landing).toHaveBeenCalledTimes(1));
    expect(landing).toHaveBeenCalledWith(DM);
    // 순서: 시트를 내리고(`onClose`) 나서 간다 — Modal 위에 Modal 을 쌓지 않는다.
    expect(order).toEqual(['close', 'land']);
  });
});

describe('대화 화면이 내리는 길 (`useLandOnMadeDm`)', () => {
  const AGENT_DM = {
    id: 'dm-agent',
    workspaceId: FIXTURE_WORKSPACE_ID,
    kind: 'dm',
    name: '',
    memberIds: ['self', AGENT.id],
  } as unknown as api.Channel;
  const roster = (...names: string[]): Directory =>
    makeDirectory([
      {...AGENT, id: 'self', kind: 'human', displayName: '나', handle: 'me'},
      ...names.map(name => ({...AGENT, displayName: name})),
    ] as unknown as api.RosterMember[]);

  type HookProps = Parameters<typeof useLandOnMadeDm>[0];
  function mountHook(over: Partial<HookProps> = {}) {
    const client = new QueryClient();
    clients.push(client);
    client.setQueryData(workspaceKeys.channels(FIXTURE_WORKSPACE_ID), []);
    jest.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const wrapper = ({children}: {children: React.ReactNode}) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const calls: string[] = [];
    const onOpenConversation = jest.fn((_id: string, _title: string) => {
      calls.push('open');
    });
    const closeThread = jest.fn(() => {
      calls.push('closeThread');
    });
    const initial: HookProps = {
      workspaceId: FIXTURE_WORKSPACE_ID,
      selfMemberId: 'self',
      directory: roster('김인턴'),
      onOpenConversation,
      closeThread,
      ...over,
    };
    const view = renderHook<OpenMadeConversation | undefined, HookProps>(
      props => useLandOnMadeDm(props),
      {wrapper, initialProps: initial},
    );
    return {client, calls, onOpenConversation, closeThread, view, initial};
  }

  it('DM 을 목록에 먼저 넣고 열려 있던 스레드를 접은 뒤 셸에 (채널 id, 상대 이름)으로 대화를 연다 — 셸 길이 없으면 값이 없고, 명부가 갱신돼도 값은 그대로다', () => {
    const {client, calls, onOpenConversation, closeThread, view, initial} =
      mountHook();
    const first = view.result.current;
    act(() => first?.(AGENT_DM));
    // 목록에 들어갔다(첫 그림부터 DM 머리로 서게) — 서버 목록은 뒤따라 다시 읽는다.
    expect(
      client.getQueryData<api.Channel[]>(
        workspaceKeys.channels(FIXTURE_WORKSPACE_ID),
      ),
    ).toEqual([AGENT_DM]);
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: workspaceKeys.channels(FIXTURE_WORKSPACE_ID),
    });
    expect(closeThread).toHaveBeenCalledTimes(1);
    // 이름은 다른 DM 입구와 같은 코어 함수로 푼다: 채널 id 도 「불러오는 중」도 아닌 에이전트의 이름.
    expect(onOpenConversation).toHaveBeenCalledTimes(1);
    expect(onOpenConversation).toHaveBeenLastCalledWith('dm-agent', '김인턴');
    expect(calls).toEqual(['closeThread', 'open']);

    // 명부가 새로 와도(30초마다) 입력창이 읽는 값은 새로 만들어지지 않는다 — 그런데 이름은 새 명부로 푼다.
    view.rerender({...initial, directory: roster('박인턴')});
    expect(view.result.current).toBe(first);
    act(() => view.result.current?.(AGENT_DM));
    expect(onOpenConversation).toHaveBeenLastCalledWith('dm-agent', '박인턴');

    // 셸이 대화를 열 길을 주지 않으면 갈 곳이 없다 — 값도 없다(고르개는 「확인」 길을 쓴다).
    expect(
      mountHook({onOpenConversation: undefined}).view.result.current,
    ).toBeUndefined();
  });
});
