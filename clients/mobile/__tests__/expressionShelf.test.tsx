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

function persistedShelf(over: Partial<PersistedShelf> = {}): PersistedShelf {
  return {v: 1, memberId: FIXTURE_MEMBER_ID, list: {...FIXTURE_LIST, baseVersion: null, reset: true}, ...over};
}

function setup(persisted?: unknown, delayList = false) {
  const server = createExpressionFixtureServer();
  let openList: (() => void) | null = null;
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    if (delayList && input.method === 'GET' && input.path === base) {
      await new Promise<void>(resolve => {
        openList = resolve;
      });
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
  expect(written).toMatchObject({v: 1, memberId: FIXTURE_MEMBER_ID, list: {workspaceId: FIXTURE_WORKSPACE_ID, reset: true}});
  expect(names(written.list.items)).toEqual(names(FIXTURE_EXPRESSIONS));
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
  expect(written.list.items.some(item => item.id === parrot.id)).toBe(false);
});

it('다른 워크스페이스·멤버·모양이 틀린 값은 받지 않는다', () => {
  const cases: unknown[] = [
    persistedShelf({memberId: 'someone-else'}),
    persistedShelf({list: {...FIXTURE_LIST, workspaceId: 'foreign', baseVersion: null, reset: true}}),
    {...persistedShelf(), v: 2},
    {v: 1, memberId: FIXTURE_MEMBER_ID, list: {items: 'nope'}},
    'not a shelf',
    42,
  ];
  for (const bad of cases) {
    const {store} = setup(bad);
    expect(store.snapshot().shelf).toEqual([]);
  }
});

it('끊기면 닫히고(글자), 다시 읽는 동안에는 마지막 목록으로 칸이 선다', async () => {
  const {store} = setup();
  await act(async () => store.refresh(true));
  mount(store, <MessageBody body=":party_parrot:" />);
  expect(screen.getByTestId('expression-box-party_parrot-large')).toBeTruthy();
  act(() => store.setOnline(false));
  expect(store.snapshot()).toMatchObject({state: 'offline', items: [], shelf: []});
  expect(screen.getByText(':party_parrot:')).toBeTruthy();
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
