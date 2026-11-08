// #5491 보안 검수 1회차(H-5491-1)의 재현 시험을 가지로 옮긴 것이다.
// 장면: 폰 캐시가 남의 숨김 version 을 알지 못한 채 앞서 간다. 내 변경의 응답은 「이전 version → 그 응답의 version」 델타 하나로 캐시에 얹히는데
// 그 사이에 남의 숨김(version +1)이 끼어 있었다면 캐시는 그 숨김을 건너뛰고, 숨긴 등록은 캐시에 `active` 로 남는다. 그 숨김의 알림이 상세 없이(옛 서버·유실·
// v1 이 상세보다 먼저) 오면 폰은 파일을 두고 목록이 알려 주는 id 만 걷는데(ADR-0218 §15 P5-4), 목록은 건너뛴 숨김을 다시 알리지 않는다 —
// 그래서 문이 열릴 때 숨긴 그림이 남긴 파일로 다시 그려진다(D3). 고친 것: ① 내 응답이 캐시 version 의 바로 다음일 때만 델타로 얹고 아니면 목록을 다시
// 읽는다(`mutate`), ② 늦게 온 숨김·삭제 상세는 같은 version 을 이미 처리했어도 건너뛰지 않는다(코어 `decideExpressionDetail`).
import 'react-native-url-polyfill/auto';
import {act, waitFor} from '@testing-library/react-native';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
  type ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import type {
  ExpressionChangedDetail,
  ExpressionMutation,
} from '@momo/core/features/expressions/types';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const parrot = FIXTURE_EXPRESSIONS[0];
const other = FIXTURE_EXPRESSIONS[1];
const stores: PhoneExpressionStore[] = [];

function setup(
  requestOverride?: (
    request: ExpressionFixtureRequest,
  ) => Promise<ExpressionFixtureResponse>,
) {
  const server = createExpressionFixtureServer();
  const request = jest.fn(
    requestOverride ??
      (async (input: ExpressionFixtureRequest) => server.request(input)),
  );
  const files = {
    write: jest.fn(
      (name: string, _bytes: Uint8Array) => `file:///fixture/${name}`,
    ),
    remove: jest.fn(),
  };
  const storage = {read: () => null, write: jest.fn()};
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    files,
    storage,
  );
  stores.push(store);
  return {server, request, files, store};
}

afterEach(async () => {
  await act(async () => {});
  stores.splice(0).forEach(store => store.dispose());
});

const report = (id: string) => ({
  method: 'POST' as const,
  path: `${base}/${id}/report`,
  body: {reason: 'other'},
});
const hiddenDetail = (version: string): ExpressionChangedDetail => ({
  type: 'expression.changed.detail',
  workspaceId: FIXTURE_WORKSPACE_ID,
  version,
  action: 'hidden',
  expressionIds: [parrot.id],
});
const listsParrot = (store: PhoneExpressionStore) =>
  store.snapshot().items.some(item => item.id === parrot.id);
const listReads = (request: jest.Mock) =>
  request.mock.calls.filter(
    ([input]) => input.method === 'GET' && input.path.startsWith(base) && !input.path.includes('/image?'),
  ).length;

/**
 * 폰이 그림 하나(`parrot`)의 파일을 가진 상태에서: 다른 멤버가 `parrot` 을 숨기고(version +1, 알림은 아직 안 왔다) 이 폰의 변경(`other` 신고,
 * version +2)이 응답을 먼저 받는다.
 */
async function raceToMyMutation() {
  const s = setup();
  await s.store.refresh(true);
  const parrotUri = await s.store.image(parrot, 'thumb');
  expect(parrotUri).not.toBeNull();
  const hidden = s.server.request(report(parrot.id));
  const hideVersion = (hidden.json as ExpressionMutation).version;
  await s.store.mutate(report(other.id));
  return {...s, parrotUri, hideVersion};
}

it('REPRO-1 상세 없는 숨김 알림(v1 만): 내 응답이 남의 숨김 version 을 건너뛰었어도 숨긴 그림은 문이 열릴 때 내주지 않고 그 파일은 걷힌다', async () => {
  const {store, files, parrotUri, hideVersion} = await raceToMyMutation();
  act(() => store.changed(hideVersion));
  await waitFor(() => expect(store.snapshot().changePending).toBeFalsy());
  expect(await store.image(parrot, 'thumb')).toBeNull();
  expect(files.remove).toHaveBeenCalledWith(parrotUri);
  expect(listsParrot(store)).toBe(false);
});

it('REPRO-2 v1 이 먼저 오고 숨김 상세가 늦게 와도(같은 version): 숨긴 그림은 내주지 않고 그 파일은 걷힌다', async () => {
  const {store, files, parrotUri, hideVersion} = await raceToMyMutation();
  act(() => store.changed(hideVersion));
  act(() => store.detailed(hiddenDetail(hideVersion)));
  await waitFor(() => expect(store.snapshot().changePending).toBeFalsy());
  expect(await store.image(parrot, 'thumb')).toBeNull();
  expect(files.remove).toHaveBeenCalledWith(parrotUri);
});

it('CONTROL 상세가 먼저 오는 정상 순서: 숨김 상세가 그 그림의 파일을 걷는다', async () => {
  const {store, files, parrotUri, hideVersion} = await raceToMyMutation();
  act(() => store.detailed(hiddenDetail(hideVersion)));
  act(() => store.changed(hideVersion));
  await act(async () => {});
  expect(await store.image(parrot, 'thumb')).toBeNull();
  expect(files.remove).toHaveBeenCalledWith(parrotUri);
});

it('REPRO-2b 늦게 온 숨김 상세는 목록 읽기를 기다리지 않고 그 id 의 파일을 그 자리에서 걷는다(내 응답이 끼지 않아도: v1 이 같은 version 을 이미 처리했다)', async () => {
  const server = createExpressionFixtureServer();
  const {store, files} = setup(async input =>
    // 알림이 시작한 목록 읽기는 답이 없다 — 상세가 걷지 않으면 파일은 목록이 올 때까지 남는다.
    input.path.includes('since=')
      ? new Promise<ExpressionFixtureResponse>(() => {})
      : server.request(input),
  );
  await store.refresh(true);
  const parrotUri = await store.image(parrot, 'thumb');
  const hidden = server.request(report(parrot.id));
  const hideVersion = (hidden.json as ExpressionMutation).version;
  act(() => store.changed(hideVersion)); // v1 먼저: 그리기만 멈추고 파일은 둔다
  expect(files.remove).not.toHaveBeenCalled();
  act(() => store.detailed(hiddenDetail(hideVersion))); // 뒤늦은 상세
  expect(files.remove.mock.calls).toEqual([[parrotUri]]);
  expect(listsParrot(store)).toBe(false);
  expect(store.snapshot().shelf.some(item => item.id === parrot.id)).toBe(false);
});

it('내 변경의 응답이 캐시 version 의 바로 다음이면 델타로 얹는다: 목록을 다시 읽지 않고 그 그림의 파일만 걷는다', async () => {
  const {store, request, files} = setup();
  await store.refresh(true);
  const parrotUri = await store.image(parrot, 'thumb');
  const otherUri = await store.image(other, 'thumb');
  const reads = listReads(request);
  await store.mutate(report(parrot.id)); // 캐시 3 → 응답 4: 사이에 낀 변경이 없다
  expect(listReads(request)).toBe(reads);
  expect(listsParrot(store)).toBe(false);
  expect(files.remove.mock.calls).toEqual([[parrotUri]]);
  expect(await store.image(other, 'thumb')).toBe(otherUri);
});

it('내 변경의 응답이 캐시 version 의 바로 다음이 아니면 델타로 건너뛰지 않고 목록을 다시 읽는다: 사이에 낀 남의 숨김이 캐시에 들어온다', async () => {
  const {store, request, server, files} = setup();
  await store.refresh(true);
  const parrotUri = await store.image(parrot, 'thumb');
  const reads = listReads(request);
  server.request(report(parrot.id)); // 남의 숨김(4) — 알림은 아직 안 왔다
  await store.mutate(report(other.id)); // 내 응답(5): 캐시 3 의 바로 다음이 아니다
  expect(listReads(request)).toBe(reads + 1);
  expect(listsParrot(store)).toBe(false); // 건너뛴 숨김이 목록에서 빠졌다
  expect(store.snapshot().items.map(item => item.id)).toEqual([
    FIXTURE_EXPRESSIONS[2].id,
  ]);
  expect(files.remove.mock.calls).toEqual([[parrotUri]]); // 그 파일도 이 읽기가 걷었다
});
