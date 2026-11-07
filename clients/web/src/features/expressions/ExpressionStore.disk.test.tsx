// @vitest-environment jsdom
// ADR-0218 §14·증보 8 (#5455 B-1): 이모티콘 그림의 기기 캐시(웹·데스크탑) — **저장소 수준** 시험.
//
// R2-M2: MA2·MA3·MA4 는 저장소의 읽기 함수(`store.image`)를 직접 부르고 **저장소 포트의 디스크 읽기 횟수**(`backend.stats.reads`)를 센다. 화면(`ExpressionImage`)을 그려서
// 재면 화면 부품의 문이 저장소의 문을 가려 저장소의 문을 꺼도 붉지 않다. 화면 시험은 맨 아래 덧붙임이다.
// 「앱을 다시 켠다」 = 같은 메모리 백엔드(디스크)를 새 `ExpressionStore` 에 주는 것이다(저장소 인스턴스는 죽고 디스크는 남는다).
// 그림 바이트는 실제 sha256 을 가진다(`disk/world.testkit.ts`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExpressionChanged, ExpressionChangedDetail } from "@momo/core/features/expressions/types";
import { ExpressionHttpError } from "./transport";
import { ExpressionStore } from "./ExpressionStore";
import { expressionNoticeHandlers } from "./notices";
import { bumpSessionGeneration } from "./disk/generation";
import { startExpressionDiskBoot, sweepExpressionDiskOutside } from "./disk/boot";
import { openExpressionDisk } from "./disk/open";
import { EXPRESSION_DISK_LIFETIME_MS, expressionDiskKey } from "./disk/port";
import { boot, createMemoryDiskBackend, diskName, ME, OTHER_ME, OTHER_WS, pic, uuid, WS, World, type Pic } from "./disk/world.testkit";
import type { MemoryDiskBackend } from "./disk/memory";

type Size = "small" | "large" | "thumb";
const plain = (version: string): ExpressionChanged => ({ type: "expression.changed", workspaceId: WS, version });
const created = (version: string, ids: string[]): ExpressionChangedDetail => ({ type: "expression.changed.detail", workspaceId: WS, version, action: "created", expressionIds: ids });
const hidden = (version: string, ids: string[]): ExpressionChangedDetail => ({ type: "expression.changed.detail", workspaceId: WS, version, action: "hidden", expressionIds: ids });

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

/** 큰 이모티콘 n 개를 만든 세계. */
function worldOf(count: number, mime = "image/png"): World {
  const world = new World();
  for (let n = 1; n <= count; n += 1) world.add(n, mime);
  return world;
}
async function readAll(store: ExpressionStore, world: World, ns: number[], sizes: Size[] = ["thumb", "large"]) {
  for (const n of ns) for (const size of sizes) await store.image(world.pathOf(store, n, size));
}
/** 첫 앱: 목록을 받고 그림을 보고 디스크에 남긴다. 그 저장소 인스턴스는 그대로 버려진다(앱이 꺼진다). */
async function firstRun(world: World, backend: MemoryDiskBackend, ns: number[], member = ME) {
  const first = boot(world, backend, member);
  await first.refresh();
  await readAll(first, world, ns);
  await first.settleDisk();
  return first;
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const keysOfCompartment = (backend: MemoryDiskBackend, name = diskName()) => backend.keysOf(name);
const hasId = (keys: string[], n: number) => keys.some((entryKey) => entryKey.startsWith(`${uuid(n)}:`));

describe("MA1 앱을 다시 켠 뒤 첫 진입: 이미 본 큰 이모티콘 40개의 그림 요청이 0이다 (처음은 80)", () => {
  it("처음 들어가면 thumb 40 + large 40 = 80 요청이고, 같은 디스크로 다시 켜면 요청 0·디스크 읽기 80이다", async () => {
    const world = worldOf(40);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, Array.from({ length: 40 }, (_, index) => index + 1));
    expect(world.imageCalls).toHaveLength(80); // 처음 = 80
    expect(keysOfCompartment(backend)).toHaveLength(80); // 모두 디스크에 남았다
    // ---- 앱을 다시 켠다: 새 저장소 인스턴스, 같은 디스크, 확인된 목록이 적용된 뒤.
    world.resetCounts();
    backend.stats.reads = 0;
    const second = boot(world, backend);
    await second.refresh();
    for (let n = 1; n <= 40; n += 1) for (const size of ["thumb", "large"] as const) expect(await second.image(world.pathOf(second, n, size))).toBe(world.srcOf(n, size));
    expect(world.imageCalls).toHaveLength(0); // 그림 요청 0
    expect(backend.stats.reads).toBe(80); // 80 장 모두 디스크에서 섰다
  });
});

describe("MA2 읽기 문, 알림 뒤 (R2-M1·R2-M2: 저장소 읽기 함수를 직접 부르고 디스크 읽기 횟수를 센다)", () => {
  /** 6 개를 디스크에 남긴 뒤 다시 켠 저장소. 캐시 version 은 6이고 문은 열려 있다. */
  async function restarted() {
    const world = worldOf(6);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3, 4, 5, 6]);
    const store = boot(world, backend);
    await store.refresh();
    world.resetCounts();
    backend.stats.reads = 0;
    expect(store.getSnapshot().cache.version).toBe("6");
    expect(store.diskDoorDown()).toBe(false);
    return { world, backend, store };
  }

  it("알림만 오고 델타가 멈춘 동안 새로 서는 칸은 디스크를 읽지 않고(적중 0), 알림 version 을 담은 목록이 적용돼 문이 내려가면 읽는다", async () => {
    const { world, backend, store } = await restarted();
    world.add(7); // 다른 사람이 7번을 등록했다
    const release = world.holdLists(); // 델타가 멈춘다
    store.noticed(WS, "7");
    const reading = store.refresh(false); // since=6 으로 시작한 읽기(알림 뒤에 시작)
    expect(store.diskDoorDown()).toBe(true);
    await store.image(world.pathOf(store, 3, "large")); // 다른 채널·스크롤로 새로 서는 칸
    expect(backend.stats.reads).toBe(0); // 문이 닫혀 있다: 디스크 적중 0
    expect(world.imageCalls).toHaveLength(1); // 그림은 네트워크로 간다
    release();
    await reading;
    expect(store.diskDoorDown()).toBe(false);
    expect(await store.image(world.pathOf(store, 4, "large"))).toBe(world.srcOf(4, "large"));
    expect(backend.stats.reads).toBe(1); // 문이 내려가자 디스크에서 선다
    expect(world.imageCalls).toHaveLength(1); // 네트워크는 늘지 않았다
  });

  it("변형 (a) 알림 직후 내 mutate 가 version 을 올려도 그 응답은 문을 열지 못한다 — 알림 version 을 담은 전체 읽기가 와야 연다", async () => {
    const { world, backend, store } = await restarted();
    store.noticed(WS, "7"); // 내 변경(7)의 알림이 먼저 왔다
    await store.mutate({ method: "POST", path: `${store.base}/expressions/${uuid(2)}/report`, body: { reason: "other" } }); // 응답 version 7 = 바로 다음이라 델타로 얹힌다
    expect(store.getSnapshot().cache.version).toBe("7");
    expect(store.diskDoorDown()).toBe(true); // 내 쓰기 응답은 알림을 확인한 것이 아니다
    await store.image(world.pathOf(store, 3, "large"));
    expect(backend.stats.reads).toBe(0);
    expect(world.imageCalls).toHaveLength(1);
    // 캐시 version(7)이 이미 알림(7) 이상이라 증분 읽기의 since 는 알림보다 작을 수 없다: 문은 전체 읽기 한 번으로 열린다.
    world.listCalls.length = 0;
    store.openDoor();
    await vi.waitFor(() => expect(store.diskDoorDown()).toBe(false));
    expect(world.listCalls).toEqual([""]); // since 없는 전체 읽기
    await store.image(world.pathOf(store, 4, "large"));
    expect(backend.stats.reads).toBe(1);
    expect(world.imageCalls).toHaveLength(1);
  });

  it("변형 (b) 알림보다 먼저 시작한 읽기는 알림 version 에 닿아도 알림을 확인하지 못한다", async () => {
    const { world, store } = await restarted();
    world.add(7);
    const release = world.holdLists();
    const early = store.refresh(false); // 알림이 오기 전에 시작한 증분 읽기
    store.noticed(WS, "7");
    release();
    await early;
    expect(store.getSnapshot().cache.version).toBe("7"); // 목록은 7까지 왔지만
    expect(store.diskDoorDown()).toBe(true); // 알림 뒤에 시작한 읽기가 아니라서 문은 그대로 닫혀 있다
  });

  it("변형 (c) 재연결·오프라인 복귀는 전체 목록이 적용돼야 문이 열린다 (첫 구독은 재연결이 아니다)", async () => {
    const { world, backend, store } = await restarted();
    store.reconnected(); // 첫 구독
    expect(store.diskDoorDown()).toBe(false);
    store.reconnected(); // 끊겼다 돌아온 구독
    expect(store.diskDoorDown()).toBe(true);
    await store.image(world.pathOf(store, 3, "large"));
    expect(backend.stats.reads).toBe(0);
    world.add(7);
    world.listCalls.length = 0;
    await store.refresh(false); // 증분을 시도해도 문을 열려면 전체가 필요해 전체로 올려 읽는다
    expect(world.listCalls).toEqual([""]);
    expect(store.diskDoorDown()).toBe(false);
    await store.image(world.pathOf(store, 4, "large"));
    expect(backend.stats.reads).toBe(1);
    // 오프라인 복귀도 같다.
    store.setOffline(true);
    store.setOffline(false);
    expect(store.diskDoorDown()).toBe(true);
    await store.refresh(true);
    expect(store.diskDoorDown()).toBe(false);
  });

  it("변형 (d) 모든 알림 프레임이 조기 반환보다 먼저 기록된다: 이미 가진 version 의 알림도, 같은 version 의 둘째 프레임도", async () => {
    const { world, backend, store } = await restarted();
    await store.mutate({ method: "POST", path: `${store.base}/expressions/${uuid(2)}/report`, body: { reason: "other" } }); // 캐시 version 7(내 응답)
    const handlers = expressionNoticeHandlers(store);
    handlers.changed(plain("7")); // 이미 가진 version 이라 목록을 읽지 않고 돌아오던 프레임
    expect(store.diskDoorDown()).toBe(true);
    await store.image(world.pathOf(store, 3, "large"));
    expect(backend.stats.reads).toBe(0);
    await vi.waitFor(() => expect(store.diskDoorDown()).toBe(false)); // 문을 열 읽기가 알아서 돈다
    // 상세(등록·그림 그대로) → 옛 알림(같은 version, 건너뜀): 둘째 프레임이 읽기를 건너뛰어도 기록은 되고, 확인되면 늦은 같은 프레임이 문을 다시 닫지 않는다.
    world.add(8);
    handlers.detail(created("8", [uuid(8)]));
    handlers.changed(plain("8"));
    expect(store.diskDoorDown()).toBe(true);
    await vi.waitFor(() => expect(store.diskDoorDown()).toBe(false));
    handlers.changed(plain("8")); // 확인된 version 의 늦은 중복
    expect(store.diskDoorDown()).toBe(false);
  });
});

describe("MA3 읽기 문, 미확인: 확인된 목록이 아니면 디스크를 읽지 않는다 (웹에는 shelf 가 없다 — 폰 몫)", () => {
  it("상태가 error 이면(목록 읽기가 실패했다) 캐시가 남아 있어도 디스크를 읽지 않는다", async () => {
    const world = worldOf(4);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3, 4]);
    const store = boot(world, backend);
    await store.refresh();
    world.failList = new Error("network");
    await store.refresh(); // 읽기 실패: 상태 error, 이미 읽은 목록은 남는다
    expect(store.getSnapshot().status).toBe("error");
    expect(store.getSnapshot().cache.items.length).toBe(4);
    world.resetCounts();
    backend.stats.reads = 0;
    expect(await store.image(world.pathOf(store, 2, "large"))).toBe(world.srcOf(2, "large"));
    expect(backend.stats.reads).toBe(0);
    expect(world.imageCalls).toHaveLength(1);
  });

  it("상태가 loading 이거나 목록을 읽는 중이면 디스크 적중 0이고, 오프라인이면 아예 받지 않으며 복귀 뒤에도 새 목록 전에는 읽지 않는다", async () => {
    const world = worldOf(4);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3, 4]);
    backend.stats.reads = 0;
    world.resetCounts();
    const store = boot(world, backend);
    const release = world.holdLists();
    const reading = store.refresh(); // 첫 목록을 읽는 중
    expect(store.getSnapshot().status).toBe("loading");
    await store.image(`${store.base}/expressions/${uuid(1)}/image?size=large&v=${world.shaOf(1, "large")}`);
    expect(backend.stats.reads).toBe(0); // 아직 확인된 목록이 없다
    release();
    await reading;
    store.setOffline(true);
    await expect(store.image(world.pathOf(store, 2, "large"))).rejects.toThrow("offline");
    store.setOffline(false);
    expect(store.diskDoorDown()).toBe(true);
    await store.image(world.pathOf(store, 3, "large"));
    expect(backend.stats.reads).toBe(0);
  });
});

describe("MA4 읽기 문, 목록에 없는 키: 숨긴 표현은 디스크에 바이트가 남아 있어도 대조 청소가 아직 돌지 않은 때에도 디스크를 읽지 않는다", () => {
  it("앱이 꺼져 있는 동안 숨긴 표현 X: 청소가 멈춰 있어도 X 의 디스크 읽기 요청은 0이고 그려지지 않는다(네트워크는 서버가 404로 막는다)", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3]);
    const hiddenPath = world.pathOf(boot(world, createMemoryDiskBackend()), 2, "large");
    world.hide(2); // 앱이 꺼져 있는 동안 서버에서 숨겼다
    // 대조 청소를 멈춘다: 색인 읽기를 붙든다.
    let releaseKeys!: () => void;
    const keysGate = new Promise<void>((resolve) => { releaseKeys = resolve; });
    const open = backend.open.bind(backend);
    backend.open = (name) => { const inner = open(name)!; return { ...inner, keys: async () => { await keysGate; return inner.keys(); } }; };
    const store = boot(world, backend);
    await store.refresh();
    expect(hasId(keysOfCompartment(backend), 2)).toBe(true); // 바이트는 아직 디스크에 있다(청소가 아직 돌지 않았다)
    backend.stats.reads = 0;
    await expect(store.image(hiddenPath)).rejects.toBeInstanceOf(ExpressionHttpError); // 서버가 404 로 막는다
    expect(backend.stats.reads).toBe(0); // 목록에 없는 키라 디스크를 읽지 않았다
    releaseKeys();
    await store.settleDisk();
    expect(hasId(keysOfCompartment(backend), 2)).toBe(false); // 청소가 돌자 지워졌다(MA5)
    expect(hasId(keysOfCompartment(backend), 3)).toBe(true);
  });
});

describe("MA5 대조 청소: 목록에 active 로 없는 디스크 키를 지운다 (기준은 디스크 색인 — evictImageIds 가 아니다)", () => {
  it("콜드 스타트: 꺼져 있는 동안 숨긴 X 의 키가 첫 전체 목록을 적용하면 디스크 색인에서 없고, 다른 표현은 남는다", async () => {
    const world = worldOf(5);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3, 4, 5]);
    world.hide(2);
    const store = boot(world, backend);
    await store.refresh();
    await store.settleDisk();
    const keys = keysOfCompartment(backend);
    expect(hasId(keys, 2)).toBe(false);
    for (const n of [1, 3, 4, 5]) expect(hasId(keys, n)).toBe(true);
  });

  it("증분(숨김 행)도 같고, 그림이 바뀐(sha 가 다른) 항목의 옛 키도 지운다", async () => {
    const world = worldOf(4);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3, 4]);
    const store = boot(world, backend);
    await store.refresh();
    world.hide(3);
    await store.refresh(false);
    await store.settleDisk();
    expect(hasId(keysOfCompartment(backend), 3)).toBe(false);
    expect(hasId(keysOfCompartment(backend), 4)).toBe(true);
    // 같은 id 로 그림이 바뀌어 다시 active 가 되면(시험용: 새 sha) 옛 sha 의 키는 목록에 없어 지워진다.
    const oldKeys = keysOfCompartment(backend).filter((entryKey) => entryKey.startsWith(`${uuid(4)}:`));
    expect(oldKeys.length).toBeGreaterThan(0);
    world.add(4); // 같은 id, 새 그림
    await store.refresh(false);
    await store.settleDisk();
    expect(keysOfCompartment(backend).some((entryKey) => oldKeys.includes(entryKey))).toBe(false);
  });

  it("목록 읽기가 실패하면 청소는 돌지 않는다(남은 항목은 읽히지도 지워지지도 않는다)", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3]);
    world.hide(2);
    world.failList = new Error("network");
    const store = boot(world, backend);
    backend.stats.keyScans = 0;
    await store.refresh();
    await store.settleDisk();
    expect(backend.stats.keyScans).toBe(0);
    expect(hasId(keysOfCompartment(backend), 2)).toBe(true);
  });

  it("숨김·삭제 상세는 그 id 의 디스크 항목을 그 자리에서 지운다(목록을 기다리지 않는다). 이름 없는 알림은 지우지 않는다", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3]);
    const store = boot(world, backend);
    await store.refresh();
    const handlers = expressionNoticeHandlers(store);
    const before = keysOfCompartment(backend).length;
    world.hide(2);
    const release = world.holdLists(); // 목록이 아직 안 왔다
    handlers.detail(hidden("4", [uuid(2)]));
    await store.settleDisk();
    expect(hasId(keysOfCompartment(backend), 2)).toBe(false); // 이름이 붙은 알림: 그 id 만
    expect(hasId(keysOfCompartment(backend), 1)).toBe(true);
    expect(keysOfCompartment(backend).length).toBeLessThan(before);
    release();
    // 이름 없는 알림(v1 만, 등록 상세)은 디스크를 지우지 않는다.
    await store.settleDisk();
    const after = keysOfCompartment(backend).length;
    world.add(5);
    handlers.changed(plain("5"));
    handlers.detail(created("5", [uuid(5)]));
    await vi.waitFor(() => expect(store.diskDoorDown()).toBe(false));
    await store.settleDisk();
    expect(keysOfCompartment(backend).length).toBe(after);
  });
});

describe("MA6 알림은 그리기만 막는다", () => {
  it("알림 순간 메모리·전송 중인 그림은 버려지고, 늦게 온 바이트는 디스크에 쓰이지 않으며, 디스크 항목 수는 그대로다. 문이 내려가면 남은 표현이 요청 0으로 다시 선다", async () => {
    const world = worldOf(4);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3]);
    const store = boot(world, backend);
    await store.refresh();
    await readAll(store, world, [1, 2, 3], ["large"]); // 디스크에서 서서 메모리에 쥔다
    const before = keysOfCompartment(backend).length;
    expect(store.imageCacheStats().entries).toBe(3);
    const release = world.holdImages();
    const inflight = store.image(world.pathOf(store, 4, "large")); // 아직 디스크에 없는 그림이 받는 중이다
    inflight.catch(() => undefined);
    world.add(5);
    const handlers = expressionNoticeHandlers(store);
    handlers.changed(plain("5")); // 상세 없는 옛 알림: 메모리 전부 폐기 + 목록 읽기
    expect(store.imageCacheStats().entries).toBe(0); // (ii) 메모리를 버린다(D3)
    release();
    await expect(inflight).rejects.toThrow("evicted expression");
    await store.settleDisk();
    expect(keysOfCompartment(backend)).toHaveLength(before); // (iii) 늦게 온 바이트를 쓰지 않았고 (i) 알림이 디스크를 지우지도 않았다
    await vi.waitFor(() => expect(store.diskDoorDown()).toBe(false));
    world.resetCounts();
    await readAll(store, world, [1, 2, 3], ["large"]);
    expect(world.imageCalls).toHaveLength(0); // 문이 내려가자 남은 표현이 요청 0으로 다시 선다
  });
});

describe("MA7 시작 청소", () => {
  const entry = { bytes: new ArrayBuffer(8), mime: "image/png" };
  const sha = "a".repeat(64);
  function planted() {
    const backend = createMemoryDiskBackend();
    const now = backend.now();
    const old = { writtenAt: now - EXPRESSION_DISK_LIFETIME_MS - 1000, lastReadAt: now - EXPRESSION_DISK_LIFETIME_MS - 1000 };
    const fresh = expressionDiskKey(uuid(1), "large", sha);
    const stale = expressionDiskKey(uuid(2), "large", sha);
    backend.plant(diskName(), fresh, entry);
    backend.plant(diskName(), stale, entry, old);
    backend.plant(diskName(WS, OTHER_ME), fresh, entry);
    backend.plant(diskName(OTHER_WS, ME), fresh, entry);
    return { backend, fresh, stale };
  }

  it("세션 복원 전에 시작한다: 세션 저장소가 자리를 잡기 전에 수명이 지난 항목을 지우고, 저장된 자격이 없으면 그 뒤에 모든 칸을 지운다", async () => {
    const { backend, fresh, stale } = planted();
    let ready!: () => void;
    const settled = new Promise<void>((resolve) => { ready = resolve; });
    const started = startExpressionDiskBoot({ ready: settled, hasCredentials: () => false, backend });
    await tick();
    await tick();
    expect(keysOfCompartment(backend)).toEqual([fresh]); // 복원(ready)보다 먼저: 수명이 지난 것은 이미 지워졌다
    expect(backend.names()).toHaveLength(3); // 칸은 아직 지우지 않았다(자격이 있는지 모른다)
    ready();
    await started;
    expect(backend.names()).toEqual([]); // 자격이 없다: 모든 칸이 지워졌다
    expect(keysOfCompartment(backend)).not.toContain(stale);
  });

  it("저장된 자격이 있으면 칸은 남기고, 복원된 세션의 현재 칸 밖(다른 멤버·다른 워크스페이스)만 지운다. 수명이 지난 항목도 지운다", async () => {
    const { backend, fresh } = planted();
    await startExpressionDiskBoot({ ready: Promise.resolve(), hasCredentials: () => true, backend });
    expect(backend.names()).toHaveLength(3); // 복원이 끝나기 전에는 어느 칸이 현재인지 모른다
    expect(keysOfCompartment(backend)).toEqual([fresh]);
    await sweepExpressionDiskOutside(WS, ME, backend);
    expect(backend.names()).toEqual([diskName()]);
    expect(keysOfCompartment(backend)).toEqual([fresh]);
  });
});

describe("MA8 세션 경계", () => {
  it("계정·워크스페이스 전환: 저장소를 놓으면(dispose) 앞 보관 칸이 통째로 지워지고 다른 칸은 그대로다", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    const first = await firstRun(world, backend, [1, 2, 3]);
    backend.plant(diskName(WS, OTHER_ME), expressionDiskKey(uuid(1), "large", "b".repeat(64)), { bytes: new ArrayBuffer(4), mime: "image/png" });
    first.dispose();
    await first.settleDisk();
    expect(backend.names()).toEqual([diskName(WS, OTHER_ME)]);
  });

  it("목록 읽기가 401·403·404 로 끝나면 그 칸을 지운다. 그 밖의 실패(500·네트워크)는 지우지 않는다", async () => {
    for (const status of [401, 403, 404]) {
      const world = worldOf(3);
      const backend = createMemoryDiskBackend();
      await firstRun(world, backend, [1, 2, 3]);
      world.failList = Object.assign(new Error("refused"), { status });
      const store = boot(world, backend);
      await store.refresh();
      await store.settleDisk();
      expect(backend.names(), `status ${status}`).toEqual([]);
    }
    for (const failure of [Object.assign(new Error("server"), { status: 500 }), new Error("network")]) {
      const world = worldOf(3);
      const backend = createMemoryDiskBackend();
      await firstRun(world, backend, [1, 2, 3]);
      world.failList = failure;
      const store = boot(world, backend);
      await store.refresh();
      await store.settleDisk();
      expect(backend.names()).toEqual([diskName()]);
    }
  });

  it("그림 하나가 404 를 받아도 칸의 항목 수는 그대로다 (R2-L1: 숨김·틀린 sha 에 대한 설계된 응답)", async () => {
    const world = worldOf(4);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2]);
    const store = boot(world, backend);
    await store.refresh();
    const before = keysOfCompartment(backend).length;
    expect(before).toBeGreaterThan(0);
    world.failImage = new ExpressionHttpError(404, undefined);
    await expect(store.image(world.pathOf(store, 3, "large"))).rejects.toBeInstanceOf(ExpressionHttpError);
    await expect(store.image(world.pathOf(store, 4, "thumb"))).rejects.toBeInstanceOf(ExpressionHttpError);
    await store.settleDisk();
    expect(backend.names()).toEqual([diskName()]); // 칸은 그대로 있고
    expect(keysOfCompartment(backend)).toHaveLength(before); // 항목 수도 그대로다
  });

  it("다른 탭의 늦은 쓰기: 로그아웃(세대가 올랐다)이 지운 뒤 받던 다운로드가 칸을 되살려 쓰지 못한다 — 쓰기 직전", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    const store = boot(world, backend);
    await store.refresh();
    const release = world.holdImages();
    const pending = store.image(world.pathOf(store, 2, "large")); // 받는 중
    bumpSessionGeneration(); // 다른 탭이 로그아웃했다
    release();
    expect(await pending).toBe(world.srcOf(2, "large")); // 그림은 그대로 그려지고
    await store.settleDisk();
    expect(keysOfCompartment(backend)).toEqual([]); // 디스크에는 쓰이지 않았다
  });

  it("다른 탭의 늦은 쓰기: 쓰는 사이에 세대가 올랐다면(쓴 직후) 되살린 항목을 그 자리에서 다시 지운다", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    const open = backend.open.bind(backend);
    backend.open = (name) => { const inner = open(name)!; return { ...inner, write: async (entryKey, image) => { await inner.write(entryKey, image); bumpSessionGeneration(); } }; };
    const store = boot(world, backend);
    await store.refresh();
    await store.image(world.pathOf(store, 2, "large"));
    await store.settleDisk();
    expect(keysOfCompartment(backend)).toEqual([]);
  });
});

describe("MA9 키에 워크스페이스·멤버가 들어 있다", () => {
  it("같은 기기에 다른 멤버가 로그인하면 앞 멤버의 칸에서는 적중하지 못한다(칸 이름이 다르다)", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    await firstRun(world, backend, [1, 2, 3]);
    const other = boot(world, backend, OTHER_ME);
    await other.refresh();
    world.resetCounts();
    backend.stats.reads = 0;
    await readAll(other, world, [1, 2, 3]);
    expect(world.imageCalls).toHaveLength(6); // 모두 네트워크로 갔다
    expect(diskName(WS, ME)).not.toBe(diskName(WS, OTHER_ME));
    expect(diskName(WS, ME)).not.toBe(diskName(OTHER_WS, ME));
    await other.settleDisk();
    expect(backend.names().sort()).toEqual([diskName(WS, ME), diskName(WS, OTHER_ME)].sort()); // 칸이 따로 선다
  });
});

describe("MA10 무결성: 정확한 길이·MIME·sha256", () => {
  /** 이 요청에 대해 서버가 이 그림을 주는 것으로 바꾼다. */
  const serving = (world: World, replacement: Pic) => world.image.mockImplementationOnce(async (path: string) => { world.imageCalls.push(path); return replacement.src; });

  it("쓸 때: 길이가 다르거나 MIME 이 다르거나 sha 가 다른 바이트는 디스크에 쓰지 않는다(그림은 그대로 그려진다)", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    const store = boot(world, backend);
    await store.refresh();
    const genuine = world.pics.get(`${uuid(1)}:large`)!;
    const wrongLength = pic("short", genuine.bytes.length - 5);
    const wrongSha = pic("same-length-other-bytes", genuine.bytes.length); // 길이·MIME 은 맞고 sha 만 다르다
    const wrongMime = { ...genuine, mime: "image/gif", src: genuine.src.replace("image/png", "image/gif") };
    for (const [index, bad] of [wrongLength, wrongSha, wrongMime].entries()) {
      serving(world, bad);
      expect(await store.image(world.pathOf(store, 1, "large"))).toBe(bad.src);
      await store.settleDisk();
      expect(keysOfCompartment(backend), `사례 ${index}`).toEqual([]);
      // 같은 경로를 다시 받을 수 있도록 메모리 칸을 비운다.
      store.clearImages();
    }
    // 대조군: 맞는 바이트는 쓰인다.
    expect(await store.image(world.pathOf(store, 1, "large"))).toBe(genuine.src);
    await store.settleDisk();
    expect(keysOfCompartment(backend)).toHaveLength(1);
  });

  it("읽을 때: 저장된 항목이 오염됐거나(같은 길이·다른 sha) 길이가 다르거나 MIME 이 다르면 그리지 않고 지운 뒤 네트워크로 받는다", async () => {
    for (const mutate of ["sha", "length", "mime"] as const) {
      const world = worldOf(3);
      const backend = createMemoryDiskBackend();
      await firstRun(world, backend, [1, 2]);
      const target = expressionDiskKey(uuid(1), "large", world.shaOf(1, "large"));
      const genuine = world.pics.get(`${uuid(1)}:large`)!;
      if (mutate === "sha") backend.corrupt(diskName(), target, pic("tampered", genuine.bytes.length).bytes.buffer as ArrayBuffer);
      else if (mutate === "length") backend.corrupt(diskName(), target, genuine.bytes.slice(0, genuine.bytes.length - 3).buffer as ArrayBuffer);
      else backend.plant(diskName(), target, { bytes: genuine.bytes.slice().buffer as ArrayBuffer, mime: "image/gif" });
      const store = boot(world, backend);
      await store.refresh();
      world.resetCounts();
      expect(await store.image(world.pathOf(store, 1, "large")), mutate).toBe(genuine.src); // 오염된 바이트가 아니라 서버의 그림
      expect(world.imageCalls, mutate).toHaveLength(1); // 네트워크로 받았다
      await store.settleDisk();
      // 지운 뒤 맞는 바이트로 다시 쓰였다: 다시 켜면 이번에는 디스크에서 선다.
      const again = boot(world, backend);
      await again.refresh();
      world.resetCounts();
      expect(await again.image(world.pathOf(again, 1, "large")), mutate).toBe(genuine.src);
      expect(world.imageCalls, mutate).toHaveLength(0);
    }
  });
});

describe("MA11 쓰기 실패·상한·수명", () => {
  it("쓰기가 던져도 그림은 그려지고 그 세션은 쓰기를 쉰다(풀려도 다시 시도하지 않는다)", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    const store = boot(world, backend);
    await store.refresh();
    backend.failWrites = new Error("QuotaExceededError");
    expect(await store.image(world.pathOf(store, 1, "large"))).toBe(world.srcOf(1, "large")); // 그림은 그대로
    await store.settleDisk();
    expect(backend.stats.writes).toBe(1);
    backend.failWrites = null;
    expect(await store.image(world.pathOf(store, 2, "large"))).toBe(world.srcOf(2, "large"));
    await store.settleDisk();
    expect(backend.stats.writes).toBe(1); // 이 세션은 쓰기를 쉰다
    expect(keysOfCompartment(backend)).toEqual([]);
  });

  it("첫 쓰기에 수명 청소가 돈다: 7일 지난 항목은 지워지고 새 항목은 남는다", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    const now = backend.now();
    const expired = expressionDiskKey(uuid(3), "small", world.shaOf(3, "small")); // 목록에 있는(대조 청소가 지우지 않는) 키
    backend.plant(diskName(), expired, { bytes: new ArrayBuffer(8), mime: "image/png" }, { writtenAt: now - EXPRESSION_DISK_LIFETIME_MS - 1, lastReadAt: now - EXPRESSION_DISK_LIFETIME_MS - 1 });
    const store = boot(world, backend);
    await store.refresh();
    await store.settleDisk();
    expect(keysOfCompartment(backend)).toContain(expired); // 대조 청소는 목록에 있는 키를 지우지 않는다
    await store.image(world.pathOf(store, 1, "large"));
    await store.settleDisk();
    expect(keysOfCompartment(backend)).not.toContain(expired);
    expect(hasId(keysOfCompartment(backend), 1)).toBe(true);
  });
});

describe("MA12 초안·후보 그림은 디스크에 두지 않는다", () => {
  it("`/expression-drafts/…` 의 200 은 디스크를 읽지도 쓰지도 않고, 활성 그림의 404 도 항목을 남기지 않는다", async () => {
    const world = worldOf(3);
    const backend = createMemoryDiskBackend();
    const store = boot(world, backend);
    await store.refresh();
    // 초안 id 가 활성 표현의 id 와 같아도(경로 검사만이 가르는 경우), 같은 바이트를 주어도 쓰지 않는다.
    world.image.mockImplementation(async (path: string) => { world.imageCalls.push(path); return world.srcOf(1, "large"); });
    const draftLike = `${store.base}/expression-drafts/${uuid(1)}/image?size=large&v=${world.shaOf(1, "large")}`;
    expect(await store.image(draftLike)).toBe(world.srcOf(1, "large"));
    await store.image(world.draftPathOf(store, "thumb"));
    await store.settleDisk();
    expect(backend.stats.writes).toBe(0);
    expect(backend.stats.reads).toBe(0);
    expect(keysOfCompartment(backend)).toEqual([]);
    // 오류·404 도 마찬가지다.
    world.image.mockImplementation(async () => { throw new ExpressionHttpError(404, undefined); });
    await expect(store.image(world.pathOf(store, 2, "large"))).rejects.toBeInstanceOf(ExpressionHttpError);
    await store.settleDisk();
    expect(keysOfCompartment(backend)).toEqual([]);
  });
});

describe("디스크 칸을 못 열면 메모리만 쓰는 모양으로 떨어진다 (R1-L4)", () => {
  it("칸이 없으면 openExpressionDisk 가 null 이고, 그 저장소는 예전처럼 네트워크·메모리만으로 그림을 준다", async () => {
    const backend = createMemoryDiskBackend();
    expect(openExpressionDisk("not-a-uuid", ME, backend)).toBeNull(); // id 가 uuid 가 아니다
    const world = worldOf(2);
    const store = new ExpressionStore(WS, ME, world.transport(), undefined, null);
    await store.refresh();
    expect(await store.image(world.pathOf(store, 1, "large"))).toBe(world.srcOf(1, "large"));
    expect(await store.image(world.pathOf(store, 1, "large"))).toBe(world.srcOf(1, "large")); // 같은 세션 재진입은 메모리
    expect(world.imageCalls).toHaveLength(1);
    expect(store.diskDoorDown()).toBe(false);
    store.noticed(WS, "9"); // 디스크가 없으면 알림 기록도 아무 일도 하지 않는다(예전 동작 그대로)
    expect(store.diskDoorDown()).toBe(false);
  });
});

describe("ExpressionStore.mutate: 응답은 캐시 version 의 바로 다음일 때만 델타로 얹는다 (R1-L5, 폰 #5491 과 같은 규칙)", () => {
  it("바로 다음 version 이면 목록을 다시 읽지 않고, 사이에 남의 변경이 끼었으면 목록을 다시 읽어 건너뛴 숨김을 놓치지 않는다", async () => {
    const world = worldOf(5);
    const store = boot(world, createMemoryDiskBackend());
    await store.refresh(); // version 5
    world.listCalls.length = 0;
    await store.mutate({ method: "POST", path: `${store.base}/expressions/${uuid(1)}/report`, body: { reason: "other" } }); // version 6 = 바로 다음
    expect(world.listCalls).toEqual([]); // 델타로 얹었다
    expect(store.getSnapshot().cache.items.some((item) => item.id === uuid(1))).toBe(false);
    world.hide(2); // 다른 사람의 숨김(version 7)을 이 클라이언트는 아직 모른다
    await store.mutate({ method: "POST", path: `${store.base}/expressions/${uuid(3)}/report`, body: { reason: "other" } }); // version 8: 7 을 건너뛴다
    expect(world.listCalls).toHaveLength(1); // 델타로 얹지 않고 목록을 다시 읽었다
    const ids = store.getSnapshot().cache.items.map((item) => item.id);
    expect(ids).not.toContain(uuid(2)); // 건너뛴 version 의 숨김이 목록에 반영됐다
    expect(ids).not.toContain(uuid(3));
    expect(store.getSnapshot().cache.version).toBe("8");
  });
});
