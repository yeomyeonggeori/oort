// @vitest-environment jsdom
// ADR-0218 §14 M2.6 (#5455 B-1): 그려지다 깨진(디코드에 실패한) 그림은 칸의 `kept`·저장소 메모리·디스크에서 **먼저** 지운 뒤 네트워크로 다시 받는다.
// 지금 웹은 「그림 다시 불러오기」가 칸이 쥔 같은 바이트를 다시 쓰므로 지우기가 먼저여야 한다. 화면 시험이라 저장소의 문은 재지 않는다(그것은 `ExpressionStore.disk.test.tsx`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ExpressionsContext } from "./context";
import { ExpressionImage } from "./ExpressionImage";
import { boot, createMemoryDiskBackend, diskName, uuid, World } from "./disk/testkit/world";

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("깨진 그림 지우기가 먼저다", () => {
  it("<img> 가 깨지면 그 그림이 디스크에서 지워지고, 「그림 다시 불러오기」는 칸이 쥔 옛 바이트가 아니라 네트워크의 그림을 받는다", async () => {
    const world = new World();
    world.add(1);
    const backend = createMemoryDiskBackend();
    const first = boot(world, backend);
    await first.refresh();
    await first.image(world.pathOf(first, 1, "thumb")); // 그림 칸은 정지 thumb 으로 서고 보이면 large 로 바뀐다: 둘 다 남긴다
    await first.image(world.pathOf(first, 1, "large"));
    await first.settleDisk();
    const store = boot(world, backend); // 앱을 다시 켠다
    await store.refresh();
    world.resetCounts();
    const item = world.active.get(uuid(1))!;
    const view = render(<ExpressionsContext.Provider value={store}><ExpressionImage item={item} size="large" /></ExpressionsContext.Provider>);
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    expect(world.imageCalls).toHaveLength(0); // 디스크에서 섰다
    const largeKey = backend.keysOf(diskName()).find((entryKey) => entryKey.includes(":large:"))!;
    expect(largeKey).toBeDefined();
    fireEvent.error(view.container.querySelector("img")!); // 디코드에 실패한 그림
    await store.settleDisk();
    expect(backend.keysOf(diskName())).not.toContain(largeKey); // 디스크에서 먼저 지웠다
    fireEvent.click(await view.findByText("그림 다시 불러오기"));
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    expect(world.imageCalls).toHaveLength(1); // 같은 바이트를 다시 쓰지 않고 네트워크로 받았다
    expect(view.container.querySelector("img")!.getAttribute("src")).toBe(world.srcOf(1, "large"));
    await store.settleDisk();
    expect(backend.keysOf(diskName())).toContain(largeKey); // 받은 바른 바이트가 다시 남았다
  });
});
