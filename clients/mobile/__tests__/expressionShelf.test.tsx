import 'react-native-url-polyfill/auto';
import React from 'react';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react-native';
import {AppState, StyleSheet} from 'react-native';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_LIST,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import type {
  ExpressionList,
  ExpressionMedia,
} from '@momo/core/features/expressions/types';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type ExpressionShelfStorage,
  type PersistedShelf,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// #5451 — 표현 보관함(이름 → 그림 크기)을 대화가 열리기 전에 쓸 수 있게 기기에 남긴다.
//
// 앞 판은 앱을 막 켰거나 보관함이 아직 안 온 때 본문의 `:이름:` 을 글로 먼저 그렸다가, 목록이 오면 160pt 그림으로 바꿨다(줄이 글자 한 줄 → 160pt).
// 지금은 마지막으로 읽은 목록을 기기에 남겨 두었다가 첫 프레임부터 칸을 세운다. 그림 파일은 목록이 확인된 뒤에야 받는다 — 숨김·삭제를 모르는
// 동안 낡은 그림을 보이지 않는다. 끊김·오류에서는 앞 판처럼 닫힌다(글자).
// =============================================================================

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const parrot = FIXTURE_EXPRESSIONS[0];
const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;

/** 기기에 남는 모양(형식 2): 그리는 데 필요한 것만(#5473). */
function persistedShelf(over: Partial<PersistedShelf> = {}): PersistedShelf {
  return {
    v: 2,
    memberId: FIXTURE_MEMBER_ID,
    workspaceId: FIXTURE_WORKSPACE_ID,
    items: FIXTURE_EXPRESSIONS.map(item => ({
      id: item.id,
      name: item.name,
      displayName: item.displayName,
      status: item.status,
      kind: item.kind,
      media: item.media as ExpressionMedia,
    })),
    ...over,
  };
}

function setup(persisted?: unknown, delayList = false, list?: ExpressionList) {
  const server = createExpressionFixtureServer();
  let openList: (() => void) | null = null;
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    if (delayList && input.method === 'GET' && input.path === base) {
      await new Promise<void>(resolve => {
        openList = resolve;
      });
    }
    if (list && input.method === 'GET' && input.path === base) {
      return {status: 200, json: list};
    }
    return server.request(input);
  });
  const files = {write: jest.fn((key: string) => `file:///fixture/${key}`), remove: jest.fn()};
  const shelfStorage: jest.Mocked<ExpressionShelfStorage> = {
    read: jest.fn(() => persisted ?? null),
    write: jest.fn(),
    clear: jest.fn(),
  };
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    files,
    {read: () => null, write: jest.fn()},
    shelfStorage,
  );
  stores.push(store);
  return {store, request, shelfStorage, server, openList: () => openList?.()};
}
const mount = (store: PhoneExpressionStore, children: React.ReactNode) =>
  render(<PhoneExpressions.Provider value={store}>{children}</PhoneExpressions.Provider>);
const names = (items: readonly {name: string}[]) => items.map(item => item.name).sort();
const imageCalls = (request: jest.Mock) =>
  request.mock.calls.filter(([input]) => String(input.path).includes('/image?'));

beforeEach(async () => {
  release = await pinReduceMotion(false);
  AppState.currentState = 'active';
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  release?.();
  release = undefined;
  jest.restoreAllMocks();
});

it('처음 읽는 동안에도 기기에 남긴 보관함으로 큰 이모티콘의 칸이 서고, 글자가 아니며, 그림은 목록이 확인된 뒤에 받는다', async () => {
  const {store, request, openList} = setup(persistedShelf(), true);
  expect(store.snapshot()).toMatchObject({state: 'loading', items: []});
  expect(names(store.snapshot().shelf)).toEqual(names(FIXTURE_EXPRESSIONS));
  mount(store, <MessageBody body=":party_parrot:" />);
  // 첫 프레임: 말풍선 없는 큰 칸이 이미 서 있고 `:party_parrot:` 글자는 없다.
  expect(screen.getByTestId('expression-body-large')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('expression-box-party_parrot-large').props.style)).toMatchObject({width: 160, height: 160});
  expect(screen.queryByText(':party_parrot:')).toBeNull();
  // 목록이 확인되기 전에는 그림 파일을 받지 않는다(숨김·삭제를 모르는 동안 낡은 그림을 보이지 않는다).
  await act(async () => {});
  expect(imageCalls(request)).toHaveLength(0);
  // 목록이 오면 같은 칸 그대로 그림이 채워진다.
  const refreshing = store.refresh(true);
  await act(async () => {
    openList();
    await refreshing;
  });
  expect(store.snapshot().state).toBe('ready');
  expect(StyleSheet.flatten(screen.getByTestId('expression-box-party_parrot-large').props.style)).toMatchObject({width: 160, height: 160});
  await waitFor(() => expect(imageCalls(request).length).toBeGreaterThan(0));
  expect(screen.queryByText(':party_parrot:')).toBeNull();
});

it('보관함이 없는 처음(기기에 남긴 것이 없다)에는 전처럼 글자다', async () => {
  const {store} = setup(undefined, true);
  expect(store.snapshot().shelf).toEqual([]);
  mount(store, <MessageBody body=":party_parrot:" />);
  expect(screen.getByText(':party_parrot:')).toBeTruthy();
  expect(screen.queryByTestId('expression-body-large')).toBeNull();
});

it('읽은 목록(보이는 것만)을 기기에 한 번만 남기고, 같은 버전이면 다시 쓰지 않는다', async () => {
  const {store, shelfStorage} = setup();
  await act(async () => store.refresh(true));
  expect(shelfStorage.write).toHaveBeenCalledTimes(1);
  const written = shelfStorage.write.mock.calls[0][0];
  expect(written).toMatchObject({v: 2, memberId: FIXTURE_MEMBER_ID, workspaceId: FIXTURE_WORKSPACE_ID});
  expect(names(written.items)).toEqual(names(FIXTURE_EXPRESSIONS));
  await act(async () => store.refresh(true));
  expect(shelfStorage.write).toHaveBeenCalledTimes(1);
});

it('숨겨진 등록은 보관함에서 빠지고 기기에 남는 목록에도 없다', async () => {
  const {store, server, shelfStorage} = setup();
  await act(async () => store.refresh(true));
  server.request({method: 'POST', path: `${base}/${parrot.id}/report`, body: {reason: 'other'}});
  await act(async () => store.refresh(true));
  expect(store.snapshot().shelf.some(item => item.id === parrot.id)).toBe(false);
  const written = shelfStorage.write.mock.calls[shelfStorage.write.mock.calls.length - 1][0];
  expect(written.items.some(item => item.id === parrot.id)).toBe(false);
});

it('다른 워크스페이스·멤버·모양이 틀린 값은 받지 않는다', () => {
  const [first] = persistedShelf().items;
  const cases: unknown[] = [
    persistedShelf({memberId: 'someone-else'}),
    persistedShelf({workspaceId: 'foreign'}),
    {...persistedShelf(), v: 3},
    {...persistedShelf(), items: 'nope'},
    // 그림 정보의 모양이 틀린 항목(해시가 아님)이 하나라도 있으면 보관함 전체를 받지 않는다.
    persistedShelf({items: [{...first, media: {...first.media, large: {...first.media.large, sha256: 'not-a-hash'}}}]}),
    'not a shelf',
    42,
  ];
  for (const bad of cases) {
    const {store} = setup(bad);
    expect(store.snapshot().shelf).toEqual([]);
  }
});

// L-5451-2 — 기기에는 그리는 데 필요한 것만 남긴다. 프롬프트·출처 주소·만든 사람·대상 멤버·태그는 나가지 않고, 옛 형식은 읽지 않고 지운다.
describe('기기에 남기는 보관함은 그리는 데 필요한 것만 든다 (#5473 L-5451-2)', () => {
  const secret = {
    prompt: '비공개 프롬프트 문장',
    sourceUrl: 'https://example.com/private/source.gif',
    subject: '00000000-0000-4000-8000-0000000000aa',
    creator: '00000000-0000-4000-8000-0000000000bb',
    tag: '비밀태그',
  };
  const richList: ExpressionList = {
    ...FIXTURE_LIST,
    items: FIXTURE_EXPRESSIONS.map((item, index) =>
      index === 0
        ? {
            ...item,
            origin: {
              kind: 'generated' as const,
              sourceUrl: secret.sourceUrl,
              prompt: secret.prompt,
              sourceAttachmentId: '00000000-0000-4000-8000-000000000031',
            },
            subjectMemberId: secret.subject,
            createdBy: secret.creator,
            tags: [secret.tag, '🎉'],
          }
        : item,
    ),
  };

  it('쓰는 값에는 그림 칸에 필요한 필드만 있고 민감한 필드는 값도 이름도 없다', async () => {
    // 대조: 서버가 준 목록에는 그 값들이 실제로 들어 있다(없으면 아래 「없다」는 아무것도 재지 못한다).
    const served = JSON.stringify(richList);
    for (const value of Object.values(secret)) expect(served).toContain(value);

    const {store, shelfStorage} = setup(undefined, false, richList);
    await act(async () => store.refresh(true));
    expect(shelfStorage.write).toHaveBeenCalledTimes(1);
    const written = shelfStorage.write.mock.calls[0][0];
    const text = JSON.stringify(written);
    for (const value of Object.values(secret)) expect(text).not.toContain(value);
    for (const field of ['origin', 'prompt', 'sourceUrl', 'createdBy', 'subjectMemberId', 'tags']) {
      expect(text).not.toContain(`"${field}"`);
    }
    // 그리는 데 필요한 것은 그대로 있다.
    expect(written.items).toHaveLength(3);
    for (const item of written.items) {
      expect(Object.keys(item).sort()).toEqual(['displayName', 'id', 'kind', 'media', 'name', 'status']);
    }
    expect(text).toContain(parrot.id);
    expect(text).toContain(parrot.media!.large.sha256);
  });

  it('쓴 값을 새 저장소(앱을 다시 켠 뒤)가 그대로 읽어 첫 프레임부터 칸을 세우고, 되살린 등록에도 민감한 값이 없다', async () => {
    const {store, shelfStorage} = setup(undefined, false, richList);
    await act(async () => store.refresh(true));
    const written = shelfStorage.write.mock.calls[0][0];

    const {store: reopened} = setup(JSON.parse(JSON.stringify(written)), true);
    expect(names(reopened.snapshot().shelf)).toEqual(names(FIXTURE_EXPRESSIONS));
    const revived = JSON.stringify(reopened.snapshot().shelf);
    for (const value of Object.values(secret)) expect(revived).not.toContain(value);
    expect(reopened.snapshot().shelf.every(item => item.tags.length === 0 && item.origin.prompt === null)).toBe(true);
    mount(reopened, <MessageBody body=":party_parrot:" />);
    expect(StyleSheet.flatten(screen.getByTestId('expression-box-party_parrot-large').props.style)).toMatchObject({width: 160, height: 160});
  });

  it('옛 형식(전체 등록 — 프롬프트·출처 주소가 든)은 읽지 않고 곧바로 지운다', () => {
    const oldShape = {v: 1, memberId: FIXTURE_MEMBER_ID, list: {...richList, baseVersion: null, reset: true}};
    const {store, shelfStorage} = setup(oldShape);
    expect(store.snapshot().shelf).toEqual([]);
    expect(shelfStorage.clear).toHaveBeenCalledTimes(1);
  });

  it('남은 값이 없으면(처음) 지울 것도 없다', () => {
    const {shelfStorage} = setup(undefined);
    expect(shelfStorage.clear).not.toHaveBeenCalled();
  });
});

// L-5451-1 — 읽는 동안(`state !== 'ready'`)은 그 사이 숨겨졌을 수 있는 표현의 표시 이름·태그를 읽어 주지 않고 토큰 글을 읽는다.
it('읽는 동안에는 읽기 도우미가 토큰 글을 읽고, 목록이 확인되면 표시 이름·태그를 읽는다 (#5473 L-5451-1)', async () => {
  const {store, openList} = setup(persistedShelf(), true);
  mount(store, <MessageBody body=":party_parrot:" />);
  const spoken = `${parrot.displayName} · ${parrot.tags[0]}`;
  expect(screen.getByTestId('expression-box-party_parrot-large')).toBeTruthy(); // 칸은 이미 서 있다(보관함)
  expect(screen.getByLabelText(':party_parrot:')).toBeTruthy();
  expect(screen.queryByLabelText(spoken)).toBeNull();
  expect(screen.queryByLabelText(parrot.displayName)).toBeNull();
  const refreshing = store.refresh(true);
  await act(async () => {
    openList();
    await refreshing;
  });
  expect(screen.getByLabelText(spoken)).toBeTruthy();
  expect(screen.queryByLabelText(':party_parrot:')).toBeNull();
});

it('끊기면 그림은 내리되 칸은 남고(같은 크기 정지 자리표시, #5585), 다시 읽는 동안에도 마지막 목록으로 칸이 선다', async () => {
  const {store} = setup();
  await act(async () => store.refresh(true));
  mount(store, <MessageBody body=":party_parrot:" />);
  expect(screen.getByTestId('expression-box-party_parrot-large')).toBeTruthy();
  act(() => store.setOnline(false));
  // 확인된 목록(`items`)은 비어 고르개·보내기는 닫힌 채이고, 보관함은 칸만 세운다 — 글자가 아니며 그림 층도 없다(D3).
  expect(store.snapshot()).toMatchObject({state: 'offline', items: []});
  expect(names(store.snapshot().shelf)).toEqual(names(FIXTURE_EXPRESSIONS));
  expect(screen.queryByText(':party_parrot:')).toBeNull();
  expect(StyleSheet.flatten(screen.getByTestId('expression-box-party_parrot-large').props.style)).toMatchObject({width: 160, height: 160});
  expect(screen.queryByTestId('expression-image-party_parrot-large')).toBeNull();
  // 다시 이어지면 읽는 동안(loading)은 마지막 목록으로 선다.
  act(() => store.setOnline(true));
  expect(store.snapshot().state).toBe('loading');
  expect(names(store.snapshot().shelf)).toEqual(names(FIXTURE_EXPRESSIONS));
  await waitFor(() => expect(store.snapshot().state).toBe('ready'));
});

it('세션이 끝나면 기기에 남긴 보관함을 지운다', async () => {
  const {store, shelfStorage} = setup(persistedShelf());
  expect(store.snapshot().shelf).toHaveLength(3);
  store.dispose();
  expect(shelfStorage.clear).toHaveBeenCalledTimes(1);
  expect(store.snapshot().shelf).toEqual([]);
});
