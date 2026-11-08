// #5455 B-2 — 이모티콘 그림의 기기 캐시(폰): ADR-0218 §14(증보 8) M5 수용 기준 MA1~MA12의 폰 칸.
//
// **MA2·MA3·MA4는 저장소 `image()`를 직접 부르고 포트(보관 칸 가짜)의 디스크 읽기 횟수를 센다**(R2-M2: 화면을 그려서 재면 화면 부품의 문이 저장소의 문을 가려 저장소의 문을 꺼도
// 붉지 않다). 화면 시험은 덧붙임이다. 「앱을 다시 켠다」는 같은 보관 칸 가짜를 새 저장소에 넘기는 것이다(저장소 인스턴스가 죽어도 디스크는 남는다). 줄마다 「끄면 RED」는 사보타주 하네스가
// 확인했고 인계 문서의 표에 있다. MA13·무결성의 파일 수준·시작 청소·세션 경계는 `expressionDiskBackend.test.ts`·`expressionDiskSession.test.tsx`.
import 'react-native-url-polyfill/auto';
import {
  FIXTURE_READY_DRAFT,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {expressionDiskKey} from '@momo/core/features/expressions/diskCache';
import type {
  ExpressionChangedDetail,
  ExpressionDraft,
} from '@momo/core/features/expressions/types';
import {bumpSessionGeneration} from '../src/features/expressions/disk/generation';
import {openPhoneExpressionDisk} from '../src/features/expressions/disk/open';
import {
  createPhoneExpressionStore,
  type PersistedShelf,
} from '../src/features/expressions/store';
import {
  boot,
  createMemoryDiskBackend,
  diskName,
  makeFiles,
  ME,
  OTHER_ME,
  uuid,
  World,
  WS,
  type Booted,
  type MemoryDiskBackend,
  type Size,
} from './fixtures/expressionDiskWorld';

const booted: Booted[] = [];
const start = (world: World, backend: MemoryDiskBackend, options = {}) => {
  const made = boot(world, backend, options);
  booted.push(made);
  return made;
};
afterEach(() => {
  for (const made of booted.splice(0)) made.store.dispose();
});

/** 붙든 읽기·마이크로태스크·디스크 일이 모두 끝나게 한다(알림이 시작한 읽기는 저장소가 추적하지 않는다). */
async function settle(made?: Booted) {
  for (let round = 0; round < 3; round += 1) {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await made?.store.settleDisk();
  }
}
const ready = async (made: Booted) => {
  await made.store.refresh(true);
  expect(made.store.snapshot().state).toBe('ready');
};
const draw = (made: Booted, world: World, numbers: number[], sizes: Size[] = ['thumb', 'large']) =>
  Promise.all(numbers.flatMap(n => sizes.map(size => made.store.image(world.item(n), size))));
const detail = (world: World, action: ExpressionChangedDetail['action'], ids: number[]): ExpressionChangedDetail => ({
  type: 'expression.changed.detail',
  workspaceId: FIXTURE_WORKSPACE_ID,
  version: String(world.version),
  action,
  expressionIds: ids.map(uuid),
});
const keyOf = (world: World, n: number, size: Size) => expressionDiskKey(uuid(n), size, world.shaOf(n, size));
const reads = (backend: MemoryDiskBackend) => backend.stats.reads;

/** 앞서 한 번 켠 앱이 이 번호들의 그림을 받아 보관 칸에 남겼다(저장소는 놓지 않는다 — 앱이 죽었다). */
async function warmDisk(world: World, backend: MemoryDiskBackend, numbers: number[], sizes: Size[] = ['thumb', 'large']) {
  const first = start(world, backend);
  await ready(first);
  await draw(first, world, numbers, sizes);
  await first.store.settleDisk();
  world.resetCounts();
  backend.stats.reads = 0;
  backend.stats.writes = 0;
  return first;
}

describe('MA1 — 앱을 다시 켠 뒤 첫 진입', () => {
  it('큰 이모티콘 40개: 처음은 그림 요청 80(thumb 40 + large 40), 같은 디스크로 다시 켜면 0 — 디스크 읽기 80', async () => {
    const world = new World();
    for (let n = 1; n <= 40; n += 1) world.add(n, n % 5 === 0 ? 'image/gif' : 'image/png');
    const backend = createMemoryDiskBackend();
    const first = start(world, backend);
    await ready(first);
    const firstPass = await draw(first, world, Array.from({length: 40}, (_, index) => index + 1));
    await first.store.settleDisk();
    expect(firstPass.every(uri => typeof uri === 'string')).toBe(true);
    expect(world.imageCalls).toHaveLength(80);
    expect(backend.stats.writes).toBe(80);
    expect(backend.keysOf(diskName())).toHaveLength(80);
    expect(first.files.write).not.toHaveBeenCalled(); // 보관 칸에 쓴 그림은 세션 임시 파일을 만들지 않는다

    world.resetCounts();
    backend.stats.reads = 0;
    const second = start(world, backend);
    await ready(second);
    const secondPass = await draw(second, world, Array.from({length: 40}, (_, index) => index + 1));
    expect(secondPass.every(uri => typeof uri === 'string')).toBe(true);
    expect(world.imageCalls).toHaveLength(0); // 80 → 0
    expect(reads(backend)).toBe(80);
    expect(second.files.write).not.toHaveBeenCalled();
    // 돌려준 주소가 보관 칸 파일의 주소다(파일 주소로 그린다).
    expect(secondPass[0]).toBe(
      `file:///fake/${diskName()}/${keyOf(world, 1, 'thumb').replace(/:/g, '_')}.png`,
    );
    console.info(`MA1 measured: first run image requests=${firstPass.length}, cold restart image requests=${world.imageCalls.length}, disk reads=${reads(backend)}`);
  });

  it('디스크 읽기를 끄면(저장소 없이) 다시 켠 뒤에도 요청이 80이다', async () => {
    const world = new World();
    for (let n = 1; n <= 40; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    const first = start(world, backend, {disk: false});
    await ready(first);
    await draw(first, world, Array.from({length: 40}, (_, index) => index + 1));
    expect(world.imageCalls).toHaveLength(80);
    world.resetCounts();
    const second = start(world, backend, {disk: false});
    await ready(second);
    await draw(second, world, Array.from({length: 40}, (_, index) => index + 1));
    expect(world.imageCalls).toHaveLength(80);
  });
});

describe('MA2 — 읽기 문, 알림 뒤', () => {
  it('알림만 오고 델타가 멈춘 상태에서 새로 서는 칸의 디스크 적중이 0이고, 목록이 적용돼 문이 내려가면 적중한다 (등록·고치기 알림: 그림은 그대로)', async () => {
    const world = new World();
    for (let n = 1; n <= 6; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4, 5, 6]);
    const second = start(world, backend);
    await ready(second);
    expect(await second.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/fake\//);
    backend.stats.reads = 0;
    const held = world.holdLists();
    world.add(7);
    second.store.detailed(detail(world, 'created', [7]));
    await settle();
    expect(held.waiting()).toBe(1);
    // 문이 닫혀 있다: 새로 서는 칸은 디스크가 아니라 네트워크로 간다(쓰지도 않는다).
    const before = world.imageCalls.length;
    expect(await second.store.image(world.item(2), 'large')).toMatch(/^file:\/\/\/session\//);
    expect(reads(backend)).toBe(0);
    expect(backend.stats.writes).toBe(0);
    expect(world.imageCalls.length).toBe(before + 1);
    // 이미 그려진 그림은 그대로다(깜빡임 0).
    expect(await second.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/fake\//);
    held.all();
    await settle(second);
    world.resetCounts();
    expect(await second.store.image(world.item(3), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(1); // 문이 내려가면 적중한다
    expect(world.imageCalls).toHaveLength(0);
  });

  it('(a) 알림 직후 내 mutate 가 version 을 앞질러 올려도 그 응답은 문을 열지 못한다 — 전체 읽기가 와야 연다', async () => {
    const world = new World();
    for (let n = 1; n <= 5; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4, 5]);
    const second = start(world, backend);
    await ready(second);
    backend.stats.reads = 0;
    // 내가 3번을 신고했다 → 서버 version 이 한 칸 오른다. 알림(내 변경의 것)이 내 응답보다 먼저 온다.
    const held = world.holdLists();
    const mutating = second.store.mutate({
      method: 'POST',
      path: `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions/${uuid(3)}/report`,
      body: {reason: 'other'},
    });
    await mutating; // 응답이 캐시 version 의 바로 다음이라 델타로 얹힌다(목록 읽기 없음)
    expect(held.waiting()).toBe(0);
    second.store.detailed(detail(world, 'hidden', [3])); // 알림 version = 지금 캐시 version
    await settle();
    // 증분으로는 알림 version 을 담을 수 없다(`since` 가 알림보다 작을 수 없다): 전체 읽기가 시작됐다.
    expect(world.listCalls[world.listCalls.length - 1]).toBe('');
    expect(await second.store.image(world.item(4), 'large')).toMatch(/^file:\/\/\/session\//); // 문이 닫혀 있다
    expect(reads(backend)).toBe(0);
    held.all();
    await settle(second);
    expect(await second.store.image(world.item(5), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(1);
  });

  it('(a′) 알림이 먼저 오고 내 응답이 그 version 으로 델타를 얹어도 문은 닫힌 채다 — 붙든 증분 읽기는 전체 읽기로 이어진다', async () => {
    const world = new World();
    for (let n = 1; n <= 5; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4, 5]);
    const second = start(world, backend);
    await ready(second);
    backend.stats.reads = 0;
    const releaseReport = world.holdReports();
    const held = world.holdLists();
    // 내가 4번을 신고했다: 서버는 바로 처리했고(version +1) 응답은 아직 오는 중인데, 그 변경의 알림이 먼저 온다.
    const mutating = second.store.mutate({
      method: 'POST',
      path: `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions/${uuid(4)}/report`,
      body: {reason: 'other'},
    });
    await settle();
    second.store.detailed(detail(world, 'hidden', [4]));
    await settle();
    expect(held.waiting()).toBe(1); // 알림이 시작한 증분 읽기(`?since=`)가 붙들려 있다
    releaseReport(); // 내 응답이 도착한다: 캐시 version 의 바로 다음이라 델타로 얹힌다(알림 version 과 같다)
    await mutating;
    await settle();
    expect(await second.store.image(world.item(5), 'large')).toMatch(/^file:\/\/\/session\//); // mutate 는 문을 열지 못했다
    expect(reads(backend)).toBe(0);
    held.all(); // 붙든 증분 읽기의 답은 이미 가진 version 이라 거절되고 전체 읽기가 이어진다
    await settle(second);
    expect(world.listCalls).toContain('');
    expect(await second.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(1);
  });

  it('(b) 알림보다 먼저 시작한 읽기는 알림을 확인하지 못한다 — 알림 뒤 시작한 읽기가 적용돼야 연다', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    const second = start(world, backend);
    await ready(second);
    backend.stats.reads = 0;
    const held = world.holdLists();
    const early = second.store.refresh(false); // 알림보다 먼저 시작한 읽기
    await settle();
    world.add(5);
    second.store.detailed(detail(world, 'created', [5]));
    await settle();
    expect(held.waiting()).toBe(2);
    held.next(); // 먼저 시작한 읽기의 답이 먼저 적용된다 — 서버는 이미 그 version 을 가졌다
    await early;
    await settle(second);
    expect(await second.store.image(world.item(2), 'large')).toMatch(/^file:\/\/\/session\//); // 아직 닫혀 있다
    expect(reads(backend)).toBe(0);
    held.all();
    await settle(second);
    expect(await second.store.image(world.item(3), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(1);
  });

  it('(c) 재연결·오프라인 복귀는 전체 목록이 적용돼야 연다 — 증분 읽기는 열지 못한다', async () => {
    const world = new World();
    for (let n = 1; n <= 5; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4, 5]);
    const second = start(world, backend);
    await ready(second);
    second.store.reconnected(); // 첫 연결은 재연결이 아니다(문이 그대로)
    second.store.reconnected(); // 끊겼다 돌아온 연결
    backend.stats.reads = 0;
    const held = world.holdLists();
    const reading = second.store.refresh(false); // 증분을 부탁해도 재연결 뒤에는 전체로 읽는다
    await settle();
    expect(world.listCalls[world.listCalls.length - 1]).toBe('');
    expect(await second.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/session\//);
    expect(reads(backend)).toBe(0);
    held.all();
    await reading;
    await settle(second);
    expect(await second.store.image(world.item(2), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(1);
  });

  it('(c′) 오프라인에서 돌아와도 전체 목록이 적용돼야 연다(디스크는 지우지 않는다)', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    const second = start(world, backend);
    await ready(second);
    second.store.setOnline(false);
    expect(await second.store.image(world.item(1), 'large')).toBeNull(); // 오프라인: 글자
    expect(backend.keysOf(diskName())).toHaveLength(8); // 디스크는 그대로다
    const held = world.holdLists();
    second.store.setOnline(true);
    await settle();
    expect(await second.store.image(world.item(1), 'large')).toBeNull(); // 목록을 읽는 중(loading)
    expect(reads(backend)).toBe(0);
    held.all();
    await settle(second);
    expect(await second.store.image(world.item(2), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBeGreaterThan(0);
  });

  it('(d) 그림을 그대로 두는 등록·고치기 상세도 기록된다 — 이름 없는 옛 알림은 전체 읽기만 연다', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    const second = start(world, backend);
    await ready(second);
    backend.stats.reads = 0;
    const held = world.holdLists();
    world.add(5);
    second.store.changed(String(world.version)); // version 을 읽을 수 없는 알림이 아니다 — 그래도 상세가 없는 옛 알림이다(전부 내림)
    second.store.changed(null); // 읽을 수 없는 version: 재연결처럼 전체 목록만 문을 연다
    await settle();
    held.all();
    await settle(second);
    // 마지막 읽기가 증분이면 null-version 알림을 확인하지 못했을 것이다 — 전체 읽기가 한 번 있었다.
    expect(world.listCalls).toContain('');
    expect(await second.store.image(world.item(3), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(1);
    // 같은 version 의 둘째 프레임은 이미 확인된 알림이라 문을 다시 닫지 않는다.
    second.store.changed(String(world.version));
    await settle(second);
    backend.stats.reads = 0;
    expect(await second.store.image(world.item(4), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(1);
  });
});

describe('MA2 변형 — 첫 연결 예외 (planner 결정 2026-11-08)', () => {
  it('저장소가 만들어진 뒤 처음 받는 connected 는 문을 올리지 않고, 두 번째부터는 전체 목록이 적용될 때까지 올려 둔다', async () => {
    const world = new World();
    for (let n = 1; n <= 6; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4, 5, 6]);
    const second = start(world, backend);
    await ready(second);
    backend.stats.reads = 0;
    second.store.reconnected(); // 첫 connected
    expect(await second.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(1); // 문이 그대로다
    second.store.reconnected(); // 끊겼다 돌아온 두 번째 connected
    const held = world.holdLists();
    const reading = second.store.refresh(true);
    await settle();
    expect(await second.store.image(world.item(2), 'large')).toMatch(/^file:\/\/\/session\//);
    expect(reads(backend)).toBe(1); // 전체 목록이 적용되기 전에는 문이 올라가 있다
    held.all();
    await reading;
    await settle(second);
    expect(await second.store.image(world.item(3), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(2);
  });
});

describe('MA3 — 읽기 문, 미확인', () => {
  const persistedShelf = (world: World, numbers: number[]): PersistedShelf => ({
    v: 2,
    memberId: '00000000-0000-4000-8000-000000000002',
    workspaceId: FIXTURE_WORKSPACE_ID,
    items: numbers.map(n => {
      const item = world.item(n);
      return {id: item.id, name: item.name, displayName: item.displayName, status: item.status, kind: item.kind, media: item.media!};
    }),
  });

  it('상태가 loading 이거나 읽는 중일 때, 그리고 shelf 에 (id, size, sha)가 있어도 디스크 적중이 0이다', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    const shelf = {read: () => persistedShelf(world, [1, 2, 3, 4]), write: jest.fn(), clear: jest.fn()};
    const held = world.holdLists();
    const second = start(world, backend, {shelf});
    // 처음 읽는 동안: shelf 가 칸을 세우지만(그리기 힌트) 문은 shelf 로 열리지 않는다.
    expect(second.store.snapshot().state).toBe('loading');
    expect(second.store.snapshot().shelf).toHaveLength(4);
    const reading = second.store.refresh(true);
    await settle();
    expect(await second.store.image(world.item(1), 'large')).toBeNull();
    expect(reads(backend)).toBe(0);
    expect(world.imageCalls).toHaveLength(0);
    held.all();
    await reading;
    expect(await second.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(reads(backend)).toBe(1);
  });

  it('목록 읽기가 실패해 error 이면(디스크에 그림이 남아 있어도) 디스크 적중이 0이고, 칸은 지워지지 않는다', async () => {
    const world = new World();
    for (let n = 1; n <= 3; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3]);
    const second = start(world, backend);
    world.failList = 500;
    await second.store.refresh(true);
    expect(second.store.snapshot().state).toBe('error');
    expect(await second.store.image(world.item(1), 'large')).toBeNull();
    expect(reads(backend)).toBe(0);
    expect(backend.keysOf(diskName())).toHaveLength(6); // 읽기 실패는 청소를 돌리지 않는다
    expect(backend.names()).toEqual([diskName()]);
  });
});

describe('MA4 — 읽기 문, 목록에 없는 키', () => {
  it('꺼져 있던 동안 숨긴 표현은 디스크에 바이트가 남아 있어도(대조 청소가 아직 돌지 않아도) 읽기 요청이 0이고 그려지지도 않으며 요청도 가지 않는다', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    const shelfWrites: unknown[] = [];
    const warm = start(world, backend, {shelf: {read: () => null, write: (value: unknown) => shelfWrites.push(value), clear: jest.fn()}});
    await ready(warm);
    await draw(warm, world, [1, 2, 3, 4]);
    await warm.store.settleDisk();
    world.hide(2); // 앱이 꺼져 있던 동안 신고돼 숨겨졌다
    world.resetCounts();
    backend.stats.reads = 0;
    const releaseKeys = backend.holdKeys(); // 대조 청소를 멈춘다
    // 옛 shelf 에는 숨긴 2번이 아직 있다(그리기 힌트일 뿐이다).
    const second = start(world, backend, {shelf: {read: () => shelfWrites[0], write: jest.fn(), clear: jest.fn()}});
    expect(second.store.snapshot().shelf.map(item => item.id)).toContain(uuid(2));
    await ready(second);
    const hiddenItem = {id: uuid(2), name: 'expr_2'};
    expect(await second.store.image(hiddenItem, 'large')).toBeNull();
    expect(await second.store.image(hiddenItem, 'thumb')).toBeNull();
    expect(reads(backend)).toBe(0);
    expect(world.imageCalls).toHaveLength(0);
    // 바이트는 디스크에 아직 있다 — 읽히지 않을 뿐이다.
    expect(backend.keysOf(diskName())).toContain(keyOf(world, 2, 'large'));
    releaseKeys();
    await second.store.settleDisk();
    expect(backend.keysOf(diskName())).not.toContain(keyOf(world, 2, 'large'));
  });
});

describe('MA5 — 대조 청소', () => {
  it('콜드 스타트: 앱이 꺼져 있던 동안 숨긴 X 의 키가 전체 목록이 적용된 뒤 디스크 색인에서 없다(남은 표현은 그대로)', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    world.hide(3);
    const second = start(world, backend);
    await ready(second);
    await second.store.settleDisk();
    const keys = backend.keysOf(diskName());
    expect(keys.some(key => key.startsWith(uuid(3)))).toBe(false);
    expect(keys).toHaveLength(6);
  });

  it('증분: 이름 없는 알림은 디스크를 지우지 않고, 델타가 숨김 행을 알리면 대조 청소가 지운다. 그림 교체의 옛 sha 키도 지운다', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    const second = start(world, backend);
    await ready(second);
    const before = backend.keysOf(diskName()).length;
    world.hide(1);
    const held = world.holdLists();
    second.store.changed(String(world.version)); // 상세 없는 옛 알림
    await settle();
    expect(backend.keysOf(diskName())).toHaveLength(before); // 이름 없는 알림은 디스크를 지우지 않는다
    held.all();
    await settle(second);
    expect(backend.keysOf(diskName()).some(key => key.startsWith(uuid(1)))).toBe(false);
    // 같은 id 의 그림 교체: 새 sha 가 목록에 오면 옛 sha 의 키는 목록에 없는 키다.
    const oldKeys = [keyOf(world, 4, 'large')];
    world.add(4); // 같은 id, 새 그림
    await second.store.refresh(true);
    await second.store.settleDisk();
    expect(backend.keysOf(diskName())).not.toContain(oldKeys[0]);
  });

  it('숨김·삭제 상세는 목록을 기다리지 않고 그 id 의 보관 칸 항목을 그 자리에서 지운다', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    const second = start(world, backend);
    await ready(second);
    expect(backend.keysOf(diskName())).toHaveLength(8);
    const held = world.holdLists();
    world.hide(2);
    second.store.detailed(detail(world, 'hidden', [2]));
    await second.store.settleDisk();
    // 목록은 아직 안 왔다(붙들려 있다) — 그래도 2번의 키는 이미 없다.
    expect(held.waiting()).toBe(1);
    const keys = backend.keysOf(diskName());
    expect(keys.some(key => key.startsWith(uuid(2)))).toBe(false);
    expect(keys).toHaveLength(6);
    held.all();
  });

  it('목록 읽기가 실패하면 청소가 돌지 않는다(다음 전체 목록이 지운다)', async () => {
    const world = new World();
    for (let n = 1; n <= 3; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3]);
    world.hide(3);
    world.failList = 500;
    const second = start(world, backend);
    const scans = backend.stats.keyScans;
    await second.store.refresh(true);
    await second.store.settleDisk();
    expect(backend.stats.keyScans).toBe(scans); // 색인을 읽지도 않았다(청소가 돌지 않았다)
    expect(backend.keysOf(diskName()).some(key => key.startsWith(uuid(3)))).toBe(true);
    world.failList = null;
    await second.store.refresh(true);
    await second.store.settleDisk();
    expect(backend.keysOf(diskName()).some(key => key.startsWith(uuid(3)))).toBe(false);
  });
});

describe('MA6 — 알림은 그리기만 막는다', () => {
  it('상세 없는 알림: 그리기가 그 자리에서 멈추고 전송 중인 그림은 버려지며 늦게 온 바이트는 쓰지 않고 디스크 항목 수는 그대로다 — 목록이 적용되면 요청 0으로 다시 선다', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3]);
    const second = start(world, backend);
    await ready(second);
    const loaded = await second.store.image(world.item(1), 'large');
    expect(loaded).toMatch(/^file:\/\/\/fake\//);
    const countBefore = backend.keysOf(diskName()).length;
    // 4번은 디스크에 없다: 받는 중에 알림이 온다.
    const releaseImages = world.holdImages();
    const inFlight = second.store.image(world.item(4), 'large');
    await settle();
    const held = world.holdLists();
    world.add(5); // 서버에서 일어난 변경(알림의 version)
    second.store.changed(String(world.version));
    expect(second.store.snapshot().changePending).toBe(true); // 그리기는 그 자리에서 멈춘다
    expect(await second.store.image(world.item(1), 'large')).toBeNull(); // 닫힌 동안은 두었던 파일도 내주지 않는다
    releaseImages();
    expect(await inFlight).toBeNull(); // 전송 중인 그림은 버려진다
    expect(backend.stats.writes).toBe(0); // 늦게 온 바이트는 디스크에 쓰이지 않았다(앞 앱의 쓰기는 `warmDisk` 가 센 뒤 지웠다)
    expect(backend.keysOf(diskName())).toHaveLength(countBefore); // 알림은 디스크를 지우지 않는다
    expect(backend.stats.removed).toBe(0);
    world.resetCounts();
    held.all();
    await settle(second);
    expect(second.store.snapshot().changePending).toBe(false);
    expect(await second.store.image(world.item(1), 'large')).toBe(loaded); // 다시 서는 데 요청 0
    expect(world.imageCalls).toHaveLength(0);
  });
});

describe('MA8 — 세션 경계', () => {
  it('dispose 가 앞 보관 칸을 폴더째 지운다', async () => {
    const world = new World();
    world.add(1);
    const backend = createMemoryDiskBackend();
    const made = start(world, backend);
    await ready(made);
    await draw(made, world, [1]);
    await made.store.settleDisk();
    expect(backend.names()).toEqual([diskName()]);
    made.store.dispose();
    expect(backend.names()).toEqual([]);
  });

  it.each([401, 403, 404])('목록 읽기가 %i 로 끝나면 그 칸을 지운다', async status => {
    const world = new World();
    for (let n = 1; n <= 2; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2]);
    expect(backend.names()).toEqual([diskName()]);
    const second = start(world, backend);
    world.failList = status;
    await second.store.refresh(true);
    await second.store.settleDisk();
    expect(backend.names()).toEqual([]);
  });

  it('목록 읽기가 500 이거나 서버에 닿지 못한 채 끝나도 칸은 그대로다', async () => {
    const world = new World();
    world.add(1);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1]);
    const second = start(world, backend);
    world.failList = 500;
    await second.store.refresh(true);
    world.request.mockRejectedValueOnce(new Error('network down'));
    world.failList = null;
    await second.store.refresh(true);
    await second.store.settleDisk();
    expect(backend.names()).toEqual([diskName()]);
  });

  it('그림 하나의 404(숨김·틀린 sha 에 대한 설계된 응답)는 칸을 지우지 않고 항목 수가 그대로다 (R2-L1)', async () => {
    const world = new World();
    for (let n = 1; n <= 3; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2]);
    const second = start(world, backend);
    await ready(second);
    const before = backend.keysOf(diskName()).length;
    world.failImage = 404; // 목록에는 아직 있는데 서버가 그 그림을 404 로 답한다
    expect(await second.store.image(world.item(3), 'large')).toBeNull();
    await second.store.settleDisk();
    expect(backend.names()).toEqual([diskName()]);
    expect(backend.keysOf(diskName())).toHaveLength(before);
  });

  it('로그아웃(세대를 올리고 모든 칸을 지움)이 쓰기 사이에 끼어도, 늦게 닿은 저장이 칸 이름을 되살리지 않는다 — 칸째 다시 지운다', async () => {
    const world = new World();
    for (let n = 1; n <= 2; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    const made = start(world, backend);
    await ready(made);
    await draw(made, world, [1], ['large']);
    await made.store.settleDisk();
    expect(backend.names()).toEqual([diskName()]); // 이미 칸이 있다
    backend.beforeWrite = async () => {
      backend.beforeWrite = null;
      bumpSessionGeneration();
      for (const name of await backend.list()) await backend.destroy(name);
    };
    expect(await made.store.image(world.item(2), 'large')).toBeNull(); // 로그아웃 뒤 늦게 닿은 그림: 그리지도 않는다
    await made.store.settleDisk();
    expect(backend.names()).toEqual([]); // 쓰기가 칸을 다시 만들었어도 칸째 지워졌다
    expect(backend.keysOf(diskName())).toEqual([]);
  });

  it('dispose(계정·워크스페이스 전환)가 쓰기 사이에 끼어도 늦게 닿은 저장이 칸 이름을 되살리지 않는다', async () => {
    const world = new World();
    for (let n = 1; n <= 2; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    const made = start(world, backend);
    await ready(made);
    await draw(made, world, [1], ['large']);
    await made.store.settleDisk();
    expect(backend.names()).toEqual([diskName()]);
    backend.beforeWrite = () => {
      backend.beforeWrite = null;
      made.store.dispose();
    };
    expect(await made.store.image(world.item(2), 'large')).toBeNull();
    await made.store.settleDisk();
    expect(backend.names()).toEqual([]);
  });

  it('앞 세션의 정리(세대를 올림)가 새 저장소가 만들어진 뒤 start() 앞에 돌아도, start() 가 세대를 다시 잡아 새 저장소를 막지 않는다 (계정 교체의 효과 순서)', async () => {
    const world = new World();
    world.add(1);
    const backend = createMemoryDiskBackend();
    const disk = openPhoneExpressionDisk(WS, ME, backend)!;
    const files = makeFiles();
    const store = createPhoneExpressionStore(WS, ME, world.transport(), files, undefined, undefined, disk);
    booted.push({store, files});
    bumpSessionGeneration(); // 앞 사람의 `SessionProvider` 정리가 새 저장소를 만든 렌더 뒤, 새 효과(`start`) 앞에서 돈다
    store.start();
    await ready({store, files});
    expect(await store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(backend.stats.writes).toBe(1);
    // `start()` 뒤의 로그아웃은 여전히 막는다.
    bumpSessionGeneration();
    expect(await store.image(world.item(1), 'thumb')).toBeNull();
    expect(backend.stats.writes).toBe(1);
  });

  it('쓰기 직전의 쓰기 문: 로그아웃이 받는 도중에 있었다면(세대가 달라졌다) 쓰지도 않는다', async () => {
    const world = new World();
    world.add(1);
    const backend = createMemoryDiskBackend();
    const made = start(world, backend);
    await ready(made);
    const releaseImages = world.holdImages();
    const loading = made.store.image(world.item(1), 'large');
    await settle();
    bumpSessionGeneration();
    for (const name of await backend.list()) await backend.destroy(name);
    releaseImages();
    expect(await loading).toBeNull();
    await made.store.settleDisk();
    expect(backend.stats.writes).toBe(0);
    expect(backend.names()).toEqual([]);
  });
});

describe('MA9 — 키', () => {
  it('다른 멤버의 키로는 적중하지 않는다(칸 이름에 멤버가 든다)', async () => {
    const world = new World();
    for (let n = 1; n <= 3; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3]);
    const other = start(world, backend, {member: OTHER_ME});
    await ready(other);
    await draw(other, world, [1, 2, 3]);
    expect(world.imageCalls).toHaveLength(6); // 앞 멤버의 칸에서 하나도 적중하지 못했다
    expect(backend.names().sort()).toEqual([diskName(), diskName(undefined, OTHER_ME)].sort());
  });
});

describe('MA10 — 무결성', () => {
  it('쓸 때: 길이가 목록의 media.bytes 와 정확히 같지 않거나 형식이 다르면 쓰지 않는다 — 그림은 그려진다', async () => {
    const world = new World();
    world.add(1);
    world.add(2, 'image/gif');
    const backend = createMemoryDiskBackend();
    // 1번 large 는 서버가 목록의 길이보다 짧은 바이트를 준다.
    const p1 = world.pics.get(`${uuid(1)}:large`)!;
    p1.bytes = p1.bytes.slice(0, p1.bytes.length - 3);
    // 2번 large 는 목록이 gif 라고 하는데 PNG 머리의 바이트가 온다(길이는 같다).
    const p2 = world.pics.get(`${uuid(2)}:large`)!;
    p2.bytes = Uint8Array.from(p2.bytes);
    p2.bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const made = start(world, backend);
    await ready(made);
    expect(await made.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/session\//);
    expect(await made.store.image(world.item(2), 'large')).toMatch(/^file:\/\/\/session\//);
    await made.store.settleDisk();
    expect(backend.stats.writes).toBe(0);
    expect(backend.keysOf(diskName())).toEqual([]);
    // 맞는 바이트(2번 thumb)는 쓰인다.
    expect(await made.store.image(world.item(2), 'thumb')).toMatch(/^file:\/\/\/fake\//);
    expect(backend.stats.writes).toBe(1);
  });

  it('읽을 때: 저장된 항목의 길이가 틀리면 그리지 않고 지운 뒤 네트워크로 받아 다시 쓴다', async () => {
    const world = new World();
    world.add(1);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1], ['large']);
    const key = keyOf(world, 1, 'large');
    backend.corrupt(diskName(), key, new ArrayBuffer(world.bytesOf(1, 'large').length - 1));
    const second = start(world, backend);
    await ready(second);
    const uri = await second.store.image(world.item(1), 'large');
    await second.store.settleDisk();
    expect(world.imageCalls).toHaveLength(1); // 오염된 항목은 쓰지 않고 네트워크로 받았다
    expect(uri).toMatch(/^file:\/\/\/fake\//);
    expect(backend.metaOf(diskName(), key)?.size).toBe(world.bytesOf(1, 'large').length); // 바른 바이트로 다시 썼다
    // 다음엔 디스크에서 선다.
    world.resetCounts();
    const third = start(world, backend);
    await ready(third);
    expect(await third.store.image(world.item(1), 'large')).toBe(uri);
    expect(world.imageCalls).toHaveLength(0);
  });
});

describe('MA11 — 쓰기 실패·상한·수명', () => {
  it('쓰기가 던져도 그림은 받은 바이트로 그려지고(세션 임시 파일) 그 세션은 쓰기를 쉰다', async () => {
    const world = new World();
    for (let n = 1; n <= 3; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    const made = start(world, backend);
    await ready(made);
    backend.failWrites = new Error('ENOSPC');
    const first = await made.store.image(world.item(1), 'large');
    expect(first).toMatch(/^file:\/\/\/session\//); // 글자로 내려가지 않고 그려진다
    expect(made.files.live.get(first!)).toEqual(world.bytesOf(1, 'large')); // 받은 바이트 그대로
    expect(backend.stats.writes).toBe(1);
    backend.failWrites = null; // 디스크가 다시 비었어도 이 세션은 쉰다(재시도 폭주 방지)
    expect(await made.store.image(world.item(2), 'large')).toMatch(/^file:\/\/\/session\//);
    expect(await made.store.image(world.item(3), 'large')).toMatch(/^file:\/\/\/session\//);
    expect(backend.stats.writes).toBe(1);
    expect(backend.keysOf(diskName())).toEqual([]);
    // 새 세션(저장소)은 다시 쓴다.
    const next = start(world, backend);
    await ready(next);
    expect(await next.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect(backend.stats.writes).toBe(2);
  });

  it('첫 쓰기가 수명 청소를 돌린다: 마지막으로 읽거나 쓴 뒤 7일이 지난 옛 항목은 (목록에 아직 있어도) 지워진다', async () => {
    const world = new World();
    for (let n = 1; n <= 2; n += 1) world.add(n);
    const clock = {now: 1_700_000_000_000};
    const backend = createMemoryDiskBackend({now: () => clock.now});
    // 2번 large 가 8일 전에 쓰였고 그 뒤 읽히지 않았다(목록에는 아직 active 라 대조 청소는 지우지 않는다).
    const expiredKey = keyOf(world, 2, 'large');
    const old = clock.now - 8 * 86_400_000;
    backend.plant(diskName(), expiredKey, {bytes: world.bytesOf(2, 'large').slice().buffer, mime: 'image/png'}, {writtenAt: old, lastReadAt: old});
    const made = start(world, backend);
    await ready(made);
    await made.store.settleDisk();
    expect(backend.keysOf(diskName())).toContain(expiredKey); // 읽기 쓰기가 없어 아직 청소가 돌지 않았다
    await made.store.image(world.item(1), 'large'); // 첫 쓰기
    await made.store.settleDisk();
    expect(backend.keysOf(diskName())).not.toContain(expiredKey);
    expect(backend.keysOf(diskName())).toContain(keyOf(world, 1, 'large'));
  });

  it('쓰기 32번째마다 도는 청소는 지금 화면이 쥔 그림의 키를 pinned 로 넘긴다', async () => {
    const world = new World();
    for (let n = 1; n <= 33; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    const trims: Array<ReadonlySet<string> | undefined> = [];
    const opened = backend.open.bind(backend);
    backend.open = name => {
      const compartment = opened(name);
      if (compartment) {
        const original = compartment.trim.bind(compartment);
        compartment.trim = async pinned => {
          trims.push(pinned === undefined ? undefined : new Set(pinned));
          await original(pinned);
        };
      }
      return compartment;
    };
    const made = start(world, backend);
    await ready(made);
    for (let n = 1; n <= 32; n += 1) await made.store.image(world.item(n), 'large');
    await made.store.settleDisk();
    expect(trims).toHaveLength(2); // 첫 쓰기와 32번째 쓰기
    expect(trims[0]?.size).toBe(0);
    expect(trims[1]?.size).toBe(31); // 32번째 쓰기 때 이미 화면이 쥐고 있던 31장
    expect(trims[1]?.has(keyOf(world, 1, 'large'))).toBe(true);
    expect(trims[1]?.has(keyOf(world, 31, 'large'))).toBe(true);
  });
});

describe('MA12 — 초안·후보 그림 제외', () => {
  it('초안 경로의 200·오류·404 어느 것도 보관 칸 항목 수를 바꾸지 않는다(활성 id·sha 와 같은 모양의 초안 주소여도)', async () => {
    const world = new World();
    for (let n = 1; n <= 3; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1]);
    const second = start(world, backend);
    await ready(second);
    const before = backend.keysOf(diskName());
    // 초안의 id·그림 해시가 활성 표현 2번과 같고, 서버가 그 활성 그림의 바이트를 그대로 준다 — 경로 검사가 없으면 보관 칸에 쓰일 모양이다.
    const draft = {
      ...FIXTURE_READY_DRAFT,
      draftId: uuid(2),
      media: world.item(2).media!,
    } as ExpressionDraft;
    world.draftBytes = () => world.bytesOf(2, 'large');
    const uri = await second.store.draftImage(draft, 'large');
    expect(uri).toMatch(/^file:\/\/\/session\//); // 초안 미리보기는 세션 임시 파일이다
    world.failDraft = 404;
    expect(await second.store.draftImage(draft, 'large')).toBeNull();
    world.failDraft = 500;
    expect(await second.store.draftImage(draft, 'large')).toBeNull();
    await second.store.settleDisk();
    expect(backend.keysOf(diskName())).toEqual(before); // 항목 수 그대로
    expect(backend.stats.writes).toBe(0);
    expect(reads(backend)).toBe(0);
  });
});

describe('보관 칸이 없는 저장소(예전 모양)', () => {
  it('disk 가 없으면 그림은 세션 임시 파일이고, 디스크 문·알림 기록·재연결은 아무 일도 하지 않는다', async () => {
    const world = new World();
    world.add(1);
    const backend = createMemoryDiskBackend();
    const files = makeFiles();
    const made = start(world, backend, {disk: false, files});
    await ready(made);
    made.store.reconnected();
    made.store.reconnected();
    made.store.changed('9');
    await settle();
    expect(await made.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/session\//);
    expect(files.write).toHaveBeenCalledTimes(1);
    expect(backend.names()).toEqual([]);
  });
});
