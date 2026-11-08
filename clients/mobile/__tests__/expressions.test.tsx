import {File} from 'expo-file-system';
import 'react-native-url-polyfill/auto';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import {AppState, Dimensions, StyleSheet, Text} from 'react-native';
import * as api from '@momo/core/lib/api';
import * as host from '@momo/core/runtime/host';
import {expressionTransport} from '../src/features/expressions/transport';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
  type ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_LIST,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import type {ExpressionList} from '@momo/core/features/expressions/types';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {TeamExpressionPicker} from '../src/features/expressions/TeamExpressionPicker';
import {ExpressionImage} from '../src/features/expressions/ExpressionImage';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {prepareExpressionBody} from '../src/features/expressions/ExpressionText';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {openPhoneExpressionDisk} from '../src/features/expressions/disk/open';
import {createMemoryDiskBackend, diskName} from './fixtures/expressionDiskWorld';

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const parrot = FIXTURE_EXPRESSIONS[0];
let release: (() => void) | undefined;
const stores: PhoneExpressionStore[] = [];
function setup(
  requestOverride?: (
    request: ExpressionFixtureRequest,
  ) => Promise<ExpressionFixtureResponse>,
  /** `disk: true` 면 보관 칸(가짜 포트)을 붙인다(#5455 B-2). 없으면 예전 모양: 세션 폴더의 임시 파일만 쓴다. */
  options: {disk?: boolean} = {},
) {
  const server = createExpressionFixtureServer();
  const request = jest.fn(
    requestOverride ?? (async input => server.request(input)),
  );
  const files = {
    write: jest.fn(
      (key: string, _bytes: Uint8Array) => `file:///fixture/${key}`,
    ),
    remove: jest.fn(),
  };
  const storage = {read: () => null, write: jest.fn()};
  const backend = createMemoryDiskBackend();
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    files,
    storage,
    undefined,
    options.disk
      ? openPhoneExpressionDisk(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, backend)
      : null,
  );
  store.start();
  stores.push(store);
  return {server, request, files, store, storage, backend};
}
function mount(store: PhoneExpressionStore, children: React.ReactNode) {
  return render(
    <PhoneExpressions.Provider value={store}>
      {children}
    </PhoneExpressions.Provider>,
  );
}
beforeEach(async () => {
  release = await pinReduceMotion(true);
  AppState.currentState = 'active';
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  release?.();
  release = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('uses the core fixture through the same transport port and deduplicates private image requests', async () => {
  const {store, files, request} = setup();
  await store.refresh(true);
  expect(store.snapshot().items).toHaveLength(3);
  const [first, second] = await Promise.all([
    store.image(parrot, 'thumb'),
    store.image(parrot, 'thumb'),
  ]);
  expect(first).toBe(second);
  expect(files.write).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenLastCalledWith({
    method: 'GET',
    path: `${base}/${parrot.id}/image?size=thumb&v=${
      parrot.media!.thumb.sha256
    }`,
  });
  expect(
    await store.image({...parrot, id: 'another-tenant'}, 'thumb'),
  ).toBeNull();
});

// #5330 계약 시험 하나(ADR-0218 §14 M2.4-3 폰 항목, #5455 B-2): 파일이 보관 칸으로 옮겨 갔다. 알림·재연결 쪽 단정은 「화면 참조 폐기 + 보관 칸 항목 수 불변 + 늦게 온 바이트 쓰지 않음」이고,
// 세션 끝(`dispose`)의 삭제 단정은 M2.5가 유지한다(칸을 폴더째 지운다). 숨겨진 등록의 항목은 알림이 아니라 그 뒤 목록이 적용될 때 대조 청소가 지운다.
it('revokes loaded and in-flight images on hide, reconnect and session disposal (the compartment keeps its items on a notice, is destroyed on disposal)', async () => {
  let complete!: (value: ExpressionFixtureResponse) => void;
  const server = createExpressionFixtureServer();
  const {store, files, backend} = setup(
    async input =>
      input.path.includes('size=small')
        ? new Promise(resolve => {
            complete = resolve;
          })
        : server.request(input),
    {disk: true},
  );
  await store.refresh(true);
  const loaded = await store.image(parrot, 'thumb');
  expect(loaded).toMatch(/^file:\/\/\/fake\//); // 보관 칸의 파일
  expect(backend.keysOf(diskName())).toHaveLength(1);
  expect(backend.stats.writes).toBe(1);
  const late = store.image(parrot, 'small');
  // 보관 칸을 먼저 본 뒤(없다) 네트워크로 간다: 받는 중이 되기를 기다린다.
  await waitFor(() => expect(typeof complete).toBe('function'));
  const response = server.request({
    method: 'GET',
    path: `${base}/${parrot.id}/image?size=small&v=${
      parrot.media!.small.sha256
    }`,
  });
  server.request({
    method: 'POST',
    path: `${base}/${parrot.id}/report`,
    body: {reason: 'other'},
  });
  act(() => store.changed());
  // 알림 순간: 화면 참조는 폐기되고(닫힌 문) 보관 칸의 항목 수는 그대로다.
  expect(store.snapshot().changePending).toBe(true);
  expect(await store.image(parrot, 'thumb')).toBeNull();
  expect(backend.keysOf(diskName())).toHaveLength(1);
  expect(backend.stats.removed).toBe(0);
  complete(response);
  expect(await late).toBeNull(); // 전송 중이던 그림은 버려진다
  expect(backend.stats.writes).toBe(1); // 늦게 온 바이트는 쓰지 않았다
  await waitFor(() => expect(store.snapshot().state).toBe('ready'));
  expect(store.snapshot().items.some(item => item.id === parrot.id)).toBe(false);
  // 목록이 적용되자 대조 청소가 숨겨진 등록의 항목을 지웠다(알림이 아니라 목록이 알려 준다).
  await store.settleDisk();
  expect(backend.keysOf(diskName())).toEqual([]);
  expect(files.remove).not.toHaveBeenCalled(); // 세션 임시 파일은 없었다
  store.dispose();
  expect(backend.names()).toEqual([]); // 세션 끝: 칸을 폴더째 지운다(M2.5)
  expect(await store.image(FIXTURE_EXPRESSIONS[1], 'thumb')).toBeNull();
});

it('without a compartment (session folder only): revokes loaded and in-flight images on hide, reconnect and session disposal', async () => {
  let complete!: (value: ExpressionFixtureResponse) => void;
  const server = createExpressionFixtureServer();
  const {store, files} = setup(async input =>
    input.path.includes('size=small')
      ? new Promise(resolve => {
          complete = resolve;
        })
      : server.request(input),
  );
  await store.refresh(true);
  await store.image(parrot, 'thumb');
  const late = store.image(parrot, 'small');
  const response = server.request({
    method: 'GET',
    path: `${base}/${parrot.id}/image?size=small&v=${
      parrot.media!.small.sha256
    }`,
  });
  server.request({
    method: 'POST',
    path: `${base}/${parrot.id}/report`,
    body: {reason: 'other'},
  });
  act(() => store.changed());
  complete(response);
  expect(await late).toBeNull();
  await waitFor(() => expect(store.snapshot().state).toBe('ready'));
  expect(store.snapshot().items.some(item => item.id === parrot.id)).toBe(
    false,
  );
  expect(files.remove).toHaveBeenCalledTimes(1);
  expect(files.write).toHaveBeenCalledTimes(1);
  store.dispose();
  expect(await store.image(FIXTURE_EXPRESSIONS[1], 'thumb')).toBeNull();
});

// #5330 owner 11-05 「자꾸 불러오는중이 뜨는데」 — 원인: 앱이 앞으로 돌아올 때(`focusManager`)·연결이 다시 이어질 때·변경 알림이 올 때마다 저장소가
// 읽은 목록을 **먼저 비우고 `loading` 을 내보내서**(옛 `refresh(true)`·`changed()`) 모든 탭이 「불러오는 중이에요」로 바뀌었다.
// 지금은 읽은 목록이 곧 캐시이고, 답이 오면 한 번에 바꿔 끼운다. 처음 읽을 때(비어 있을 때)만 `loading` 이다.
it('keeps the list and the ready state while a full read is in flight — no loading flash when the app returns to the foreground (#5330)', async () => {
  const {store, request, server} = setup();
  await store.refresh(true);
  expect(store.snapshot().items).toHaveLength(3);
  let reply!: () => void;
  request.mockImplementationOnce(async input => {
    await new Promise<void>(resolve => {
      reply = resolve;
    });
    return server.request(input);
  });
  let reading!: Promise<void>;
  act(() => {
    reading = store.refresh(true);
  });
  // 읽는 동안: 이미 읽은 목록이 그대로이고 상태는 ready 다(앞 판은 비우고 loading 이었다).
  expect(store.snapshot().state).toBe('ready');
  expect(store.snapshot().items).toHaveLength(3);
  // 전체 읽기는 `since` 없이 간다 — 서버가 `reset` 목록을 준다.
  expect(request.mock.calls[request.mock.calls.length - 1][0].path).toBe(base);
  await act(async () => {
    reply();
    await reading;
  });
  expect(store.snapshot().state).toBe('ready');
  expect(store.snapshot().items).toHaveLength(3);
});

// #5491 (ADR-0218 §15): 어느 등록이 바뀌었는지 모르는 알림(`changed()`, 상세 없음)은 그림을 **그리지 않게** 즉시 막지만(`changePending`) 그림 파일은 걷지 않는다.
// 앞 판(#5330)은 알림 순간 파일을 전부 걷고 목록이 오면 보이는 그림을 전부 다시 받았다. 지금은 목록이 알려 주는 id 의 파일만 걷는다. 목록을 못 받으면 전부 걷는다.
// #5330 계약 시험 둘째(ADR-0218 §14 M2.4-3 폰 항목, #5455 B-2): 이름 없는 알림은 그리기만 막고 보관 칸의 항목은 지우지 않는다. 델타가 아무것도 알리지 않으면 항목 수가 그대로고 다시 받지 않는다.
it('a change notice with no detail stops the drawing at once but keeps the list and the compartment\'s items; a delta that names nothing removes nothing (#5491, #5455)', async () => {
  const server = createExpressionFixtureServer();
  let reply!: (response: ExpressionFixtureResponse) => void;
  let held: ExpressionFixtureRequest | undefined;
  const {store, request, backend} = setup(
    async input => {
      if (input.path.includes('since=')) {
        held = input;
        return new Promise(resolve => {
          reply = resolve;
        });
      }
      return server.request(input);
    },
    {disk: true},
  );
  await store.refresh(true);
  const uri = await store.image(parrot, 'thumb');
  expect(backend.keysOf(diskName())).toHaveLength(1);
  const downloads = () =>
    request.mock.calls.filter(([input]) => input.path.includes('/image?')).length;
  act(() => store.changed('4')); // version 을 읽을 수 있는 이름 없는 알림: 증분 읽기가 시작된다
  expect(store.snapshot().changePending).toBe(true); // 그리기는 그 자리에서 멈춘다
  expect(await store.image(parrot, 'thumb')).toBeNull(); // 닫힌 동안은 두었던 파일도 내주지 않는다
  expect(backend.stats.removed).toBe(0); // 보관 칸의 항목은 지우지 않는다
  expect(backend.keysOf(diskName())).toHaveLength(1); // 항목 수 불변
  expect(store.snapshot().state).toBe('ready'); // 이름 목록은 그대로다
  expect(store.snapshot().items).toHaveLength(3);
  await act(async () => {
    reply(server.request(held!));
  });
  await waitFor(() => expect(store.snapshot().changePending).toBe(false));
  expect(store.snapshot().items).toHaveLength(3);
  await store.settleDisk();
  expect(backend.stats.removed).toBe(0); // 델타가 아무것도 걷지 않았다
  expect(backend.keysOf(diskName())).toHaveLength(1);
  expect(await store.image(parrot, 'thumb')).toBe(uri); // 같은 파일 — 다시 받지 않는다
  expect(downloads()).toBe(1);
});

it('without a compartment: a change notice with no detail stops the drawing at once but keeps the files and the list; a delta that names nothing removes nothing (#5491)', async () => {
  const server = createExpressionFixtureServer();
  let reply!: (response: ExpressionFixtureResponse) => void;
  let held: ExpressionFixtureRequest | undefined;
  const {store, files} = setup(async input => {
    if (input.path.includes('since=')) {
      held = input;
      return new Promise(resolve => {
        reply = resolve;
      });
    }
    return server.request(input);
  });
  await store.refresh(true);
  const uri = await store.image(parrot, 'thumb');
  act(() => store.changed());
  expect(store.snapshot().changePending).toBe(true); // 그리기는 그 자리에서 멈춘다
  expect(await store.image(parrot, 'thumb')).toBeNull(); // 닫힌 동안은 두었던 파일도 내주지 않는다
  expect(files.remove).not.toHaveBeenCalled(); // 파일은 걷지 않는다
  expect(store.snapshot().state).toBe('ready'); // 이름 목록은 그대로다
  expect(store.snapshot().items).toHaveLength(3);
  await act(async () => {
    reply(server.request(held!));
  });
  await waitFor(() => expect(store.snapshot().changePending).toBe(false));
  expect(store.snapshot().items).toHaveLength(3);
  expect(files.remove).not.toHaveBeenCalled(); // 델타가 아무것도 걷지 않았다
  expect(await store.image(parrot, 'thumb')).toBe(uri); // 같은 파일 — 다시 받지 않는다
  expect(files.write).toHaveBeenCalledTimes(1);
});

it('a change notice with no detail voids a download that is in flight: it writes no file while the list is still unknown (#5491)', async () => {
  const server = createExpressionFixtureServer();
  let imageReply!: (response: ExpressionFixtureResponse) => void;
  const {store, files} = setup(async input => {
    // 알림이 시작한 목록 읽기는 붙들어 둔다 — 어느 등록이 내려갔는지 모르는 때다.
    if (input.path.includes('since='))
      return new Promise<ExpressionFixtureResponse>(() => {});
    if (input.path.includes('/image?') && input.path.includes('size=small'))
      return new Promise(resolve => {
        imageReply = resolve;
      });
    return server.request(input);
  });
  await store.refresh(true);
  const late = store.image(parrot, 'small');
  const answer = await server.request({
    method: 'GET',
    path: `${base}/${parrot.id}/image?size=small&v=${parrot.media!.small.sha256}`,
  });
  act(() => store.changed());
  imageReply(answer); // 받기가 목록보다 먼저 답한다
  expect(await late).toBeNull(); // 받던 것은 버려진다(D3: 디코드 중인 것도 폐기)
  expect(files.write).not.toHaveBeenCalled(); // 목록을 모르는 동안에는 새 파일도 쓰지 않는다
});

it('a change notice with no detail: the delta that hides one removes only that one\'s files and the others come back without a download (#5491)', async () => {
  const {store, files, request, server} = setup();
  await store.refresh(true);
  const other = FIXTURE_EXPRESSIONS[1];
  const keptUri = await store.image(other, 'thumb');
  const goneUri = await store.image(parrot, 'thumb');
  const downloads = () =>
    request.mock.calls.filter(([input]) => input.path.includes('/image?')).length;
  const before = downloads();
  server.request({
    method: 'POST',
    path: `${base}/${parrot.id}/report`,
    body: {reason: 'other'},
  });
  act(() => store.changed());
  await waitFor(() => expect(store.snapshot().changePending).toBe(false));
  expect(store.snapshot().items.some(item => item.id === parrot.id)).toBe(false);
  expect(files.remove.mock.calls).toEqual([[goneUri]]); // 목록이 알려 준 그 id 의 파일뿐
  expect(await store.image(other, 'thumb')).toBe(keptUri);
  expect(downloads()).toBe(before); // 남은 그림은 다시 받지 않았다
});

it('a delta that cannot be read after a notice with no detail removes every file, as before (#5491)', async () => {
  const server = createExpressionFixtureServer();
  const {store, files} = setup(async input =>
    input.path.includes('since=') ? {status: 500} : server.request(input),
  );
  await store.refresh(true);
  await store.image(parrot, 'thumb');
  await store.image(FIXTURE_EXPRESSIONS[1], 'thumb');
  act(() => store.changed());
  await waitFor(() => expect(store.snapshot().state).toBe('error'));
  expect(files.remove).toHaveBeenCalledTimes(2);
  expect(store.snapshot().changePending).toBe(false);
});

it('a hide detail removes that one item at once, and a list read that started before it cannot bring it back (#5491)', async () => {
  const server = createExpressionFixtureServer();
  let staleReply!: (response: ExpressionFixtureResponse) => void;
  let deltaReply!: (response: ExpressionFixtureResponse) => void;
  let fullReads = 0;
  const {store, files} = setup(async input => {
    if (input.method === 'GET' && input.path === base) {
      fullReads += 1;
      // 알림보다 앞서 시작한 읽기: 숨기기 전 목록으로 늦게 답한다.
      if (fullReads === 2)
        return new Promise(resolve => {
          staleReply = resolve;
        });
    }
    // 알림이 시작한 읽기도 붙들어 둔다 — 낡은 답이 먼저 와야 「되살아남」을 잴 수 있다(읽기가 먼저 끝나면 판이 올라 낡은 답이 저절로 거절된다).
    if (input.path.includes('since='))
      return new Promise(resolve => {
        deltaReply = resolve;
      });
    return server.request(input);
  });
  await store.refresh(true);
  const loaded = await store.image(parrot, 'thumb');
  const preHide = await server.request({method: 'GET', path: base});
  let reading!: Promise<void>;
  act(() => {
    reading = store.refresh(true);
  });
  server.request({
    method: 'POST',
    path: `${base}/${parrot.id}/report`,
    body: {reason: 'other'},
  });
  const afterHide = await server.request({
    method: 'GET',
    path: `${base}?since=${(preHide.json as ExpressionList).version}`,
  });
  act(() =>
    store.detailed({
      type: 'expression.changed.detail',
      workspaceId: FIXTURE_WORKSPACE_ID,
      version: '4',
      action: 'hidden',
      expressionIds: [parrot.id],
    }),
  );
  // 그 자리에서: 보관함에서 빠지고 그 id 의 파일만 걷힌다. 읽기를 기다리지 않는다.
  expect(store.snapshot().items.some(item => item.id === parrot.id)).toBe(false);
  expect(store.snapshot().shelf.some(item => item.id === parrot.id)).toBe(false);
  expect(files.remove.mock.calls).toEqual([[loaded]]);
  expect(await store.image(parrot, 'small')).toBeNull();
  // 숨기기 전 목록이 알림이 시작한 읽기보다 **먼저** 늦게 온다 — 버려져야 한다. 버리지 않으면 숨긴 등록이 여기서 되살아난다.
  await act(async () => {
    staleReply(preHide);
    await reading;
  });
  expect(store.snapshot().items.some(item => item.id === parrot.id)).toBe(false);
  expect(store.snapshot().shelf.some(item => item.id === parrot.id)).toBe(false);
  // 알림이 시작한 읽기의 답이 오면 목록이 확인된다.
  await act(async () => {
    deltaReply(afterHide);
  });
  await waitFor(() => expect(store.snapshot().revision).toBeGreaterThan(0));
  expect(store.snapshot().items.some(item => item.id === parrot.id)).toBe(false);
  expect(store.snapshot().items).toHaveLength(2);
  expect(await store.image(parrot, 'thumb')).toBeNull();
});

it('the response to my own hide removes only that item\'s files, not every picture (#5491)', async () => {
  const {store, files} = setup();
  await store.refresh(true);
  const other = FIXTURE_EXPRESSIONS[1];
  const keptUri = await store.image(other, 'thumb');
  const goneUri = await store.image(parrot, 'thumb');
  await store.mutate({
    method: 'POST',
    path: `${base}/${parrot.id}/report`,
    body: {reason: 'other'},
  });
  expect(store.snapshot().items.some(item => item.id === parrot.id)).toBe(false);
  expect(files.remove.mock.calls).toEqual([[goneUri]]);
  expect(await store.image(other, 'thumb')).toBe(keptUri);
});

it('a hidden item is gone from the last-known shelf too: a later loading state does not draw it again (#5491)', async () => {
  const {store} = setup();
  await store.refresh(true);
  act(() =>
    store.detailed({
      type: 'expression.changed.detail',
      workspaceId: FIXTURE_WORKSPACE_ID,
      version: '4',
      action: 'hidden',
      expressionIds: [parrot.id],
    }),
  );
  // 끊겼다 이어지면 목록을 다시 읽는 동안(`loading`)은 마지막으로 읽은 보관함으로 그린다 — 거기에 숨긴 등록이 있으면 안 된다.
  act(() => store.setOnline(false));
  act(() => store.setOnline(true));
  expect(store.snapshot().state).toBe('loading');
  expect(store.snapshot().shelf.some(item => item.id === parrot.id)).toBe(false);
  expect(store.snapshot().shelf.length).toBeGreaterThan(0);
});

it('a hide detail voids the in-flight download of that id only; the others finish and are kept (#5491)', async () => {
  const server = createExpressionFixtureServer();
  const other = FIXTURE_EXPRESSIONS[1];
  const replies = new Map<string, (response: ExpressionFixtureResponse) => void>();
  const {store, files} = setup(async input => {
    if (input.path.includes('/image?')) {
      return new Promise(resolve => {
        replies.set(input.path, resolve);
      });
    }
    return server.request(input);
  });
  await store.refresh(true);
  const lateParrot = store.image(parrot, 'small');
  const lateOther = store.image(other, 'small');
  await waitFor(() => expect(replies.size).toBe(2));
  act(() =>
    store.detailed({
      type: 'expression.changed.detail',
      workspaceId: FIXTURE_WORKSPACE_ID,
      version: '4',
      action: 'hidden',
      expressionIds: [parrot.id],
    }),
  );
  for (const [path, reply] of replies) {
    reply(await server.request({method: 'GET', path}));
  }
  expect(await lateParrot).toBeNull(); // 숨겨진 id 의 받는 중 읽기는 파일이 되지 못한다
  expect(typeof (await lateOther)).toBe('string'); // 다른 그림의 받기는 이어진다
  expect(files.write).toHaveBeenCalledTimes(1);
});

it('a routine full read of an unchanged list keeps every loaded picture; a read whose list drops an item revokes them (#5330)', async () => {
  const {store, files, request, server} = setup();
  await store.refresh(true);
  const uri = await store.image(parrot, 'thumb');
  const revision = store.snapshot().revision;
  const imageGets = () =>
    request.mock.calls.filter(([input]) => input.path.includes('/image?'))
      .length;
  for (let round = 0; round < 3; round += 1) await store.refresh(true);
  expect(store.snapshot().revision).toBe(revision); // 그림의 판(epoch)이 그대로다
  expect(await store.image(parrot, 'thumb')).toBe(uri); // 같은 파일 — 다시 내려받지 않는다
  expect(imageGets()).toBe(1);
  expect(files.write).toHaveBeenCalledTimes(1);
  expect(files.remove).not.toHaveBeenCalled();
  // 서버가 한 등록을 숨긴 뒤의 전체 읽기: 그림이 걷히고 목록에서 빠진다.
  server.request({
    method: 'POST',
    path: `${base}/${parrot.id}/report`,
    body: {reason: 'other'},
  });
  await store.refresh(true);
  expect(store.snapshot().items.some(item => item.id === parrot.id)).toBe(false);
  expect(store.snapshot().revision).toBeGreaterThan(revision);
  expect(files.remove).toHaveBeenCalledTimes(1);
});

it('fails closed for malformed/foreign snapshots, errors, and offline, then recovers from the fixture', async () => {
  const {store, request, server} = setup();
  request.mockResolvedValueOnce({
    status: 200,
    json: {...FIXTURE_LIST, workspaceId: 'foreign'},
  });
  await store.refresh(true);
  expect(store.snapshot().state).toBe('error');
  expect(request).toHaveBeenCalledTimes(1);
  await store.refresh(true);
  expect(store.snapshot().state).toBe('ready');
  store.setOnline(false);
  expect(store.snapshot()).toMatchObject({state: 'offline', items: []});
  expect(await store.image(parrot, 'thumb')).toBeNull();
  request.mockResolvedValueOnce({status: 500});
  store.setOnline(true);
  await waitFor(() => expect(store.snapshot().state).toBe('error'));
  request.mockImplementation(async input => server.request(input));
  await store.refresh(true);
  expect(store.snapshot().items).toHaveLength(3);
});

it('records only confirmed receipts once and scopes persisted usage to the member/workspace', async () => {
  const {store, storage} = setup();
  await store.refresh(true);
  expect(storage.write).not.toHaveBeenCalled();
  store.recordSuccess('send:1', ':party_parrot: :party_parrot:');
  store.recordSuccess('send:1', ':party_parrot:');
  expect(store.snapshot().usage?.entries).toEqual([
    {id: parrot.id, count: 1, lastUsedAtMs: expect.any(Number)},
  ]);
  expect(storage.write).toHaveBeenCalledTimes(1);
  storage.write.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  expect(() => store.recordSuccess('send:2', ':party_parrot:')).not.toThrow();
  expect(store.snapshot().usage?.entries[0].count).toBe(2);
  const other = createPhoneExpressionStore(
    'other-workspace',
    FIXTURE_MEMBER_ID,
    {request: async () => ({status: 500})},
    {write: () => '', remove: () => {}},
    {read: () => store.snapshot().usage, write: () => {}},
  );
  await other.refresh(true);
  expect(other.snapshot().usage?.entries).toEqual([]);
  other.dispose();
});

it('searches Korean initials and presents the all/GIF filters over the same items using static thumbnails', async () => {
  const {store, request} = setup();
  await store.refresh(true);
  const onSelect = jest.fn();
  const ui = mount(
    store,
    <TeamExpressionPicker query="ㅍㅌ" onSelect={onSelect} />,
  );
  await screen.findByTestId('expression-pick-party_parrot');
  expect(screen.queryByTestId('expression-pick-ki_jeol')).toBeNull();
  // 「이모티콘」 하나로 모은 거르기 줄(owner 11-05): 앞 판의 「스티커」(거르지 않는 칸)는 「이모티콘」(전체)과 같아서 합쳤고 「우리 팀 GIF」는 「GIF」다.
  expect(screen.queryByLabelText('스티커')).toBeNull();
  expect(screen.queryByLabelText('이모지')).toBeNull();
  expect(screen.queryByLabelText('우리 팀 GIF')).toBeNull();
  fireEvent.press(screen.getByLabelText('GIF'));
  expect(screen.getByText('파티 앵무새')).toBeTruthy();
  expect(screen.getByTestId('expression-pick-party_parrot')).toBeTruthy();
  await waitFor(() =>
    expect(
      request.mock.calls.some(([input]) => input.path.includes('size=thumb')),
    ).toBe(true),
  );
  expect(
    request.mock.calls
      .filter(([input]) => input.path.includes('/image?'))
      .every(([input]) => input.path.includes('size=thumb')),
  ).toBe(true);
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  // 넘기는 것: 정본 본문 토큰과, 그 순간 서버가 확인한 등록(시트가 고른 뒤의 동작을 등록으로 가른다).
  await waitFor(() =>
    expect(onSelect).toHaveBeenCalledWith(
      ':party_parrot:',
      expect.objectContaining({id: parrot.id, name: 'party_parrot'}),
    ),
  );
  ui.unmount();
});

it('shows loading/error/retry/empty/offline states inside the picker', async () => {
  const {store, request} = setup();
  mount(store, <TeamExpressionPicker query="" onSelect={jest.fn()} />);
  expect(screen.getByTestId('expression-loading')).toBeTruthy();
  request.mockResolvedValueOnce({status: 500});
  await act(async () => store.refresh(true));
  expect(screen.getByTestId('expression-error')).toBeTruthy();
  fireEvent.press(screen.getByText('다시 시도'));
  await screen.findByTestId('expression-pick-party_parrot');
  fireEvent.press(screen.getByLabelText('최근'));
  expect(screen.getByTestId('emoji-team-empty')).toBeTruthy();
  act(() => store.setOnline(false));
  expect(screen.getByTestId('expression-offline')).toBeTruthy();
});

it('previews a large send first and refuses confirmation after the fixture deletes the selected item', async () => {
  const {store, server} = setup();
  await store.refresh(true);
  const send = jest.fn();
  mount(
    store,
    <TeamExpressionPicker query="" onSelect={send} mode="message" />,
  );
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  expect(screen.getByTestId('expression-send-preview')).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
  server.request({method: 'DELETE', path: `${base}/${parrot.id}`});
  fireEvent.press(screen.getByTestId('expression-confirm-send'));
  await screen.findByText('이 표현을 지금 쓸 수 없어요. 다시 골라 주세요.');
  expect(send).not.toHaveBeenCalled();
});

it('confirms an active preview once with only the canonical body token', async () => {
  const {store} = setup();
  await store.refresh(true);
  const send = jest.fn();
  mount(
    store,
    <TeamExpressionPicker query="" onSelect={send} mode="message" />,
  );
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  fireEvent.press(screen.getByTestId('expression-confirm-send'));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  // 본문은 정본 토큰 하나뿐이고(꾸밈 없음), 둘째로 확인된 등록이 따라간다.
  expect(send.mock.calls[0][0]).toBe(':party_parrot:');
  expect(send.mock.calls[0][1]).toMatchObject({id: parrot.id, name: 'party_parrot'});
});

it('uses large/medium/inline sizes, keeps large sends outside bubbles and returns to strings after hide', async () => {
  const {store, server} = setup();
  await store.refresh(true);
  const ui = mount(store, <MessageBody body=":party_parrot:" bubble="mine" />);
  expect(screen.getByTestId('expression-body-large')).toBeTruthy();
  expect(screen.queryByTestId('message-bubble')).toBeNull();
  ui.rerender(
    <PhoneExpressions.Provider value={store}>
      <MessageBody body={':party_parrot: '.repeat(2)} />
    </PhoneExpressions.Provider>,
  );
  expect(screen.getByTestId('expression-body-medium')).toBeTruthy();
  ui.rerender(
    <PhoneExpressions.Provider value={store}>
      <MessageBody body={':party_parrot: '.repeat(7)} />
    </PhoneExpressions.Provider>,
  );
  // 칸은 첫 프레임부터 서고(`expression-box-…`), 그림 층은 받은 뒤에 얹힌다(#5451) — 받는 동안 글자나 0x0 칸이 서지 않는다.
  expect(
    screen.getAllByTestId('expression-box-party_parrot-inline'),
  ).toHaveLength(7);
  await waitFor(() =>
    expect(
      screen.getAllByTestId('expression-image-party_parrot-inline'),
    ).toHaveLength(7),
  );
  server.request({
    method: 'POST',
    path: `${base}/${parrot.id}/report`,
    body: {reason: 'other'},
  });
  await act(async () => store.refresh());
  expect(
    screen.queryAllByTestId('expression-image-party_parrot-inline'),
  ).toHaveLength(0);
  expect(screen.getByText(':party_parrot: '.repeat(7))).toBeTruthy();
});

it('does not replace Markdown code, escaped tokens or URL destinations and never exposes internal markers', async () => {
  const {store} = setup();
  await store.refresh(true);
  const body =
    '글 *:party_parrot:* `:party_parrot:` \\:party_parrot: [링크](https://example.com/:party_parrot:)';
  expect(
    prepareExpressionBody(body, store.snapshot().items).replacements.size,
  ).toBe(1);
  const ui = mount(store, <MessageBody body={body} />);
  expect(
    screen.getAllByTestId('expression-box-party_parrot-inline'),
  ).toHaveLength(1);
  await waitFor(() =>
    expect(
      screen.getAllByTestId('expression-image-party_parrot-inline'),
    ).toHaveLength(1),
  );
  expect(screen.getByTestId('message-inline-code').props.children).toBe(
    ':party_parrot:',
  );
  expect(screen.queryByText(/\uE000/)).toBeNull();
  ui.rerender(
    <PhoneExpressions.Provider value={store}>
      <MessageBody body={'`:party_parrot:``'} />
    </PhoneExpressions.Provider>,
  );
  expect(screen.queryByText(/\uE000/)).toBeNull();
  expect(screen.getByTestId('message-inline-code').props.children).toBe(
    ':party_parrot:',
  );
  await act(async () => {});
});

it('uses thumb for reduced motion/offscreen/grid and stops animated large media after four cycles with tap replay', async () => {
  release?.();
  release = await pinReduceMotion(false);
  jest.useFakeTimers();
  const {store, request} = setup();
  await store.refresh(true);
  const ui = mount(
    store,
    <ExpressionImage expression={parrot} size="large" visible />,
  );
  await act(async () => {});
  const image = screen.getByTestId('expression-image-party_parrot-large');
  expect(image.props.source.uri).toMatch(/gif$/);
  fireEvent(image, 'load');
  await act(async () =>
    jest.advanceTimersByTime(parrot.media!.large.durationMs * 4 - 1),
  );
  expect(
    screen.getByTestId('expression-image-party_parrot-large').props.source.uri,
  ).toMatch(/gif$/);
  await act(async () => jest.advanceTimersByTime(1));
  expect(
    screen.getByTestId('expression-image-party_parrot-large').props.source.uri,
  ).toMatch(/png$/);
  expect(
    request.mock.calls.some(([input]) => input.path.includes('size=large')),
  ).toBe(true);
  expect(
    request.mock.calls.some(([input]) => input.path.includes('size=thumb')),
  ).toBe(true);
  fireEvent.press(screen.getByLabelText('파티 앵무새 · 축하'));
  await act(async () => {});
  expect(
    screen.getByTestId('expression-image-party_parrot-large').props.source.uri,
  ).toMatch(/gif$/);
  ui.rerender(
    <PhoneExpressions.Provider value={store}>
      <ExpressionImage expression={parrot} size="reaction" visible={false} />
    </PhoneExpressions.Provider>,
  );
  await act(async () => {});
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({path: expect.stringContaining('size=thumb')}),
  );
});

it('preserves aspect ratio, reaction size and VoiceOver name, with literal fallback for unavailable media', async () => {
  const {store} = setup();
  await store.refresh(true);
  mount(
    store,
    <Text>
      <ExpressionImage expression={parrot} size="reaction" visible />
    </Text>,
  );
  await waitFor(() =>
    expect(
      screen.getByTestId('expression-image-party_parrot-reaction').props.source
        ?.uri,
    ).toMatch(/^file:/),
  );
  const geometry = StyleSheet.flatten(
    screen.getByTestId('expression-image-party_parrot-reaction').props.style,
  );
  expect(Math.max(geometry.width, geometry.height)).toBe(20);
  expect(screen.getByLabelText('파티 앵무새 · 축하')).toBeTruthy();
  act(() => store.setOnline(false));
  expect(screen.getByText(':party_parrot:')).toBeTruthy();
});

it('uses authenticated live JSON and binary adapters through the fixture-compatible port', async () => {
  const json = jest
    .spyOn(api, 'authedResponse')
    .mockResolvedValue({status: 200, jsonOrNull: () => FIXTURE_LIST} as Awaited<
      ReturnType<typeof api.authedResponse>
    >);
  expect(
    (await expressionTransport.request({method: 'GET', path: base})).json,
  ).toBe(FIXTURE_LIST);
  expect(json).toHaveBeenCalledWith(base, {method: 'GET'});
  const session = host.coreSession();
  jest.spyOn(host, 'coreSession').mockReturnValue({
    ...session,
    getAccessToken: () => 'fixture-access-token',
    getRefreshToken: () => 'fixture-refresh-token',
  });
  jest.spyOn(host, 'apiBase').mockReturnValue('https://fixture.invalid');
  const rotate = jest
    .spyOn(api, 'rotateAfterUnauthorized')
    .mockResolvedValue(true);
  const nativeDownload = jest
    .spyOn(File, 'downloadFileAsync')
    .mockRejectedValueOnce(new Error('HTTP 401'))
    .mockResolvedValueOnce({
      size: 3,
      bytes: async () => Uint8Array.from([1, 2, 3]),
    } as File);
  const path = `${base}/${parrot.id}/image?size=thumb&v=${
    parrot.media!.thumb.sha256
  }`;
  const result = await expressionTransport.request({method: 'GET', path});
  expect(result.bytes).toEqual(Uint8Array.from([1, 2, 3]));
  expect(rotate).toHaveBeenCalledTimes(1);
  expect(nativeDownload).toHaveBeenLastCalledWith(
    `https://fixture.invalid${path}`,
    expect.any(File),
    expect.objectContaining({
      headers: {Authorization: 'Bearer fixture-access-token'},
      idempotent: true,
      signal: expect.any(AbortSignal),
    }),
  );
  await expect(
    expressionTransport.request({
      method: 'GET',
      path: 'https://outside.invalid/image',
    }),
  ).rejects.toThrow('Invalid expression path');
  expect(nativeDownload).toHaveBeenCalledTimes(2);
});

it('cancels pending confirmation when choosing again or closing the picker', async () => {
  const {store, request, server} = setup();
  await store.refresh(true);
  let complete!: () => void;
  request.mockImplementation(async input =>
    input.path.includes('?since=')
      ? new Promise(resolve => {
          complete = () => resolve(server.request(input));
        })
      : server.request(input),
  );
  const send = jest.fn();
  const ui = mount(
    store,
    <TeamExpressionPicker query="" onSelect={send} mode="message" />,
  );
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  fireEvent.press(screen.getByTestId('expression-confirm-send'));
  fireEvent.press(screen.getByText('다시 고르기'));
  await act(async () => complete());
  expect(send).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  fireEvent.press(screen.getByTestId('expression-confirm-send'));
  ui.unmount();
  await act(async () => complete());
  expect(send).not.toHaveBeenCalled();
});

it('scales inline expressions with large text while preserving the reaction/medium/large limits', async () => {
  const previous = Dimensions.get('window');
  const larger = {...previous, width: 390, height: 844, fontScale: 3};
  act(() => Dimensions.set({window: larger, screen: larger}));
  try {
    const {store} = setup();
    await store.refresh(true);
    mount(
      store,
      <>
        <ExpressionImage expression={parrot} size="inline" visible />
        <ExpressionImage expression={parrot} size="reaction" visible />
        <ExpressionImage expression={parrot} size="medium" visible />
        <ExpressionImage expression={parrot} size="large" visible />
      </>,
    );
    await act(async () => {});
    const maximum = (size: string) => {
      const style = StyleSheet.flatten(
        screen.getByTestId(`expression-image-party_parrot-${size}`).props.style,
      );
      return Math.max(style.width, style.height);
    };
    expect(maximum('inline')).toBe(48);
    expect(maximum('reaction')).toBe(20);
    expect(maximum('medium')).toBe(48);
    expect(maximum('large')).toBe(160);
  } finally {
    cleanup();
    act(() => Dimensions.set({window: previous, screen: previous}));
  }
});
