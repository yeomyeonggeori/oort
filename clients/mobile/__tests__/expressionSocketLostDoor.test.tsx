import 'react-native-url-polyfill/auto';
import {
  boot,
  createMemoryDiskBackend,
  uuid,
  World,
  type Booted,
  type MemoryDiskBackend,
} from './fixtures/expressionDiskWorld';

// =============================================================================
// #5585 보안 검수 1회차 M2·H1 — 소켓만 끊긴 동안의 디스크 읽기 문(진짜 저장소 + 보관 칸 가짜, ADR-0218 §17).
//
// 소켓만 끊기면(`disconnected`, 보낼 수는 있다) 저장소는 오프라인이 아니다: 그린 그림은 그대로다. 그 대신 알림을 못 받는 동안이라
//   1. `socketLost()` 가 디스크 읽기 문을 올린다 — 디스크에 있는 그림도 새 칸은 네트워크로 받는다(숨긴 것은 서버가 404).
//   2. 끊긴 동안에는 **어떤 목록 읽기도** 문을 내리지 않는다(고르는 순간의 확인·세트 승인·30초 주기 읽기). 앞 판(검수 탐침 B1)은 이 읽기 한 번 뒤
//      문이 끊긴 채로 내려가, 그 뒤 숨긴 그림이 새 칸에 디스크로 섰다.
//   3. 다시 이어지면(`reconnected()` → 전체 읽기) 문이 내려가 디스크에서 다시 읽는다 — 위 둘이 「문이 늘 닫혀 있어서」 초록인 것이 아님을 붙든다.
// =============================================================================

const booted: Booted[] = [];
const start = (world: World, backend: MemoryDiskBackend) => {
  const made = boot(world, backend);
  booted.push(made);
  return made;
};
afterEach(() => {
  for (const made of booted.splice(0)) made.store.dispose();
});
async function settle(made?: Booted) {
  for (let round = 0; round < 3; round += 1) {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await made?.store.settleDisk();
  }
}
/** 앞 세션이 그림을 보관 칸에 받아 두었다(같은 디스크로 다시 켠 앱). */
async function warmDisk(world: World, backend: MemoryDiskBackend, numbers: number[]) {
  const first = start(world, backend);
  await first.store.refresh(true);
  await Promise.all(
    numbers.flatMap(n => (['thumb', 'large'] as const).map(size => first.store.image(world.item(n), size))),
  );
  await first.store.settleDisk();
  world.resetCounts();
  backend.stats.reads = 0;
  backend.stats.writes = 0;
}
/** 다시 켠 앱: 목록을 읽고 첫 `connected`(문을 올리지 않는 첫 연결 예외)를 받았다. */
async function relaunched(world: World, backend: MemoryDiskBackend) {
  const made = start(world, backend);
  await made.store.refresh(true);
  made.store.reconnected();
  return made;
}

describe('소켓만 끊긴 동안의 디스크 읽기 문 (#5585 보안 검수 r1)', () => {
  it('socketLost() 는 문을 올린다: 그 전에는 디스크에서 읽던 그림도, 그 뒤 새 칸은 네트워크로 받는다', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    const second = await relaunched(world, backend);
    // 문이 열려 있다(대조): 디스크에서 읽고 네트워크는 쓰지 않는다.
    expect(await second.store.image(world.item(2), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect({reads: backend.stats.reads, network: world.imageCalls.length}).toEqual({reads: 1, network: 0});
    second.store.socketLost(); // 표시 유예 10초 뒤 `disconnected` && 보낼 수 있음
    backend.stats.reads = 0;
    world.resetCounts();
    expect(await second.store.image(world.item(1), 'large')).toMatch(/^file:\/\/\/session\//);
    expect({reads: backend.stats.reads, network: world.imageCalls.length}).toEqual({reads: 0, network: 1});
  });

  it('끊긴 동안 앱 안의 목록 읽기 뒤에도 문은 내려가지 않는다: 그 뒤 숨긴 그림은 디스크에서 서지 않는다(네트워크 404 → null)', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    const second = await relaunched(world, backend);
    second.store.socketLost();
    // 고르는 순간의 확인(`resolveActiveExpression`)·세트 승인이 부르는 모양(인자 없음)과 30초 주기 읽기(전체).
    await second.store.refresh();
    await second.store.refresh(true);
    await settle(second);
    expect(world.listCalls.slice(-2)).toEqual(['', '']); // 문이 올라가 있어 증분 대신 전체로 읽었다
    world.hide(3); // 끊긴 동안 숨김 — 이 기기에 알림은 오지 않는다
    world.resetCounts();
    backend.stats.reads = 0;
    expect(await second.store.image({id: uuid(3), name: 'expr_3'}, 'large')).toBeNull();
    expect({reads: backend.stats.reads, network: world.imageCalls.length}).toEqual({reads: 0, network: 1});
  });

  it('다시 이어지면(reconnected → 전체 읽기) 문이 내려가 디스크에서 다시 읽는다', async () => {
    const world = new World();
    for (let n = 1; n <= 4; n += 1) world.add(n);
    const backend = createMemoryDiskBackend();
    await warmDisk(world, backend, [1, 2, 3, 4]);
    const second = await relaunched(world, backend);
    second.store.socketLost();
    await second.store.refresh(true);
    await settle(second);
    second.store.reconnected(); // 두 번째 `connected`: 문을 올리고, 아래 전체 읽기가 내린다
    await second.store.refresh(true);
    await settle(second);
    backend.stats.reads = 0;
    world.resetCounts();
    expect(await second.store.image(world.item(4), 'large')).toMatch(/^file:\/\/\/fake\//);
    expect({reads: backend.stats.reads, network: world.imageCalls.length}).toEqual({reads: 1, network: 0});
  });
});
