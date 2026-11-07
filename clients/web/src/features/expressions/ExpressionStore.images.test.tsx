// @vitest-environment jsdom
// #5468: 웹 이모티콘 그림 기억 칸이 96칸 FIFO 에서 바이트 예산 LRU(메모리만)로 바뀌었다.
// 이 시험이 재는 것: ① 같은 항목을 다시 읽으면 요청이 0이고 읽으면 가장 최근으로 올라간다(FIFO 가 아니다), ② 예산을 넘으면 오래 안 쓴 것부터
// 예산 안이 될 때까지 내보내고 센 바이트가 실제로 쥔 것의 합과 같다, ③ 항목 수 안전장치, ④ 받는 중에 비워진 항목은 늦게 와도 예산에 들지 않는다,
// ⑤ 비우는 길(비우기·오프라인·폐기)은 항목도 바이트도 0으로 만든다, ⑥ 실제 상수로 큰 이모티콘 200개 채널에 다시 들어가도 요청이 0이다,
// ⑦ ExpressionImage 가 쥔 바이트를 저장소가 두 번 세지 않는다.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { EXPRESSION_LIMITS } from "@momo/core/features/expressions/types";
import type { Expression } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "./ExpressionStore";
import { ExpressionsContext } from "./context";
import { ExpressionImage } from "./ExpressionImage";
import { IMAGE_CACHE_BUDGET_BYTES, IMAGE_CACHE_MAX_ENTRIES, ImageCache, type ImageCacheLimits } from "./ImageCache";
import type { ExpressionTransport } from "./transport";

// 예산의 단위는 데이터 URL 글자 수라서 글자 N개짜리 문자열이 곧 N바이트짜리 그림이다.
const picture = (chars: number) => "A".repeat(chars);
const KIB = 1024;

function build(limits?: ImageCacheLimits, sizeOf: (path: string) => number = () => 100) {
  const image = vi.fn(async (path: string) => picture(sizeOf(path)));
  const transport: ExpressionTransport = { json: vi.fn(), image };
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport, limits);
  return { store, image };
}
/** 읽고 나서 이 읽기가 요청을 냈는지(true)를 돌려준다. */
async function read(ctx: ReturnType<typeof build>, path: string) {
  const before = ctx.image.mock.calls.length;
  await ctx.store.image(path);
  return ctx.image.mock.calls.length > before;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ExpressionStore 그림 기억 칸: 바이트 예산 LRU (#5468)", () => {
  it("같은 항목을 다시 읽으면 요청이 0이고, 읽으면 가장 최근으로 올라가서 내보낼 때 먼저 나가지 않는다", async () => {
    const ctx = build({ budgetBytes: 300, maxEntries: 100 }); // 100바이트짜리 셋이 꼭 맞는다
    expect(await read(ctx, "/a")).toBe(true);
    expect(await read(ctx, "/b")).toBe(true);
    expect(await read(ctx, "/c")).toBe(true);
    expect(await read(ctx, "/a")).toBe(false); // 같은 항목 다시 읽기 = 요청 0 (그리고 a 가 가장 최근이 된다)
    expect(await read(ctx, "/d")).toBe(true); // 400 > 300: 가장 오래 안 쓴 b 가 나간다(FIFO 라면 먼저 넣은 a 가 나간다)
    expect(ctx.store.imageCacheStats()).toMatchObject({ entries: 3, bytes: 300 });
    expect(await read(ctx, "/a")).toBe(false);
    expect(await read(ctx, "/c")).toBe(false);
    expect(await read(ctx, "/d")).toBe(false);
    expect(await read(ctx, "/b")).toBe(true); // 나간 것만 다시 받는다
    expect(ctx.image).toHaveBeenCalledTimes(5);
  });

  it("예산을 넘으면 예산 안이 될 때까지 오래 안 쓴 것부터 내보내고, 센 바이트는 실제로 쥔 것의 합과 같다", async () => {
    const ctx = build({ budgetBytes: 300, maxEntries: 100 }, (path) => path === "/big" ? 250 : 100);
    for (const path of ["/a", "/b", "/c"]) await read(ctx, path);
    await read(ctx, "/big"); // 550: a(450) → b(350) → c(250) 까지 나가야 300 이하가 된다
    expect(ctx.store.imageCacheStats()).toMatchObject({ entries: 1, bytes: 250 });
    expect(await read(ctx, "/a")).toBe(true); // 나갔다
    // 센 값 대 실제 합: 크기가 제각각인 열린 순서를 되풀이해도 항상 예산 이하이고, 센 값이 남아 있는 항목의 크기 합과 같다.
    const sizes = new Map<string, number>();
    const cache = new ImageCache({ budgetBytes: 1000, maxEntries: 50 });
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let step = 0; step < 400; step += 1) {
      const key = `/k${next() % 40}`;
      if (cache.get(key) !== undefined) continue;
      const size = 40 + (next() % 260);
      sizes.set(key, size);
      await cache.add(key, Promise.resolve(picture(size)));
      const present = [...sizes].filter(([k]) => cache.has(k)).reduce((sum, [, n]) => sum + n, 0);
      expect(cache.bytes).toBe(present);
      expect(cache.bytes).toBeLessThanOrEqual(1000);
      expect(cache.size).toBeLessThanOrEqual(50);
    }
  });

  it("항목 수 안전장치: 바이트가 남아도 칸 수 상한을 넘으면 오래 안 쓴 것부터 나가고, 기본 상한은 워크스페이스 한도의 모든 variant 를 담는다", async () => {
    const ctx = build({ budgetBytes: 1_000_000, maxEntries: 2 });
    await read(ctx, "/a"); await read(ctx, "/b"); await read(ctx, "/c");
    expect(ctx.store.imageCacheStats()).toMatchObject({ entries: 2, bytes: 200 });
    expect(await read(ctx, "/c")).toBe(false);
    expect(await read(ctx, "/a")).toBe(true);
    // 앞 판의 절벽은 칸 수에서 났다: 기본 상한이 한 워크스페이스의 전 등록 × 3 variant 보다 낮으면 같은 절벽이 칸 수로 되돌아온다.
    expect(IMAGE_CACHE_MAX_ENTRIES).toBeGreaterThan(3 * EXPRESSION_LIMITS.workspace);
  });

  it("받는 중에 비워지거나 밀려난 항목은 늦게 도착해도 예산에 들지 않고, 같은 키의 새 항목을 건드리지 않는다", async () => {
    const cache = new ImageCache({ budgetBytes: 1000, maxEntries: 2 });
    let finishOld!: (src: string) => void;
    const old = cache.add("/x", new Promise<string>((resolve) => { finishOld = resolve; }));
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 0 }); // 받는 동안은 0바이트
    cache.clear();
    await cache.add("/x", Promise.resolve(picture(100))); // 비운 뒤 같은 키로 새 항목이 선다
    finishOld(picture(400));
    await old;
    expect(cache.bytes).toBe(100); // 늦게 온 400 은 세지 않는다
    expect(cache.size).toBe(1);
    // 칸 수 때문에 받는 중에 밀려난 것도 마찬가지
    let finishSlow!: (src: string) => void;
    const slow = cache.add("/slow", new Promise<string>((resolve) => { finishSlow = resolve; }));
    await cache.add("/y", Promise.resolve(picture(10))); // 이제 /x, /slow, /y: 상한 2 라 가장 오래된 /x 가 나간다
    await cache.add("/z", Promise.resolve(picture(10))); // /slow 도 나간다
    expect(cache.has("/slow")).toBe(false);
    finishSlow(picture(500));
    await slow;
    expect(cache.has("/slow")).toBe(false);
    expect(cache.bytes).toBe(20);
  });

  it("비우기·오프라인·폐기는 항목도 바이트도 0으로 만들고 다음 읽기는 다시 받는다", async () => {
    const clears: Array<[string, (store: ExpressionStore) => void]> = [
      ["clearImages", (store) => store.clearImages()],
      ["setOffline(true)", (store) => store.setOffline(true)],
      ["dispose", (store) => store.dispose()],
    ];
    for (const [name, clear] of clears) {
      const ctx = build({ budgetBytes: 1000, maxEntries: 10 });
      await read(ctx, "/a"); await read(ctx, "/b");
      expect(ctx.store.imageCacheStats(), name).toMatchObject({ entries: 2, bytes: 200 });
      const epoch = ctx.store.getSnapshot().epoch;
      clear(ctx.store);
      expect(ctx.store.imageCacheStats(), name).toMatchObject({ entries: 0, bytes: 0 });
      expect(ctx.store.getSnapshot().epoch, name).toBeGreaterThan(epoch);
      ctx.store.setOffline(false);
      expect(await read(ctx, "/a"), name).toBe(true); // 비운 뒤에는 다시 받는다
      expect(ctx.store.imageCacheStats(), name).toMatchObject({ entries: 1, bytes: 100 });
    }
  });

  it("실제 예산으로 큰 이모티콘 200개 채널(thumb·large 400칸)에 다시 들어가도 그림 요청이 0이다 (앞 판 FIFO 96칸은 400요청)", async () => {
    // #5455 실측 평균(정지 32 + GIF 8, 지금 운영 인코더): thumb ≈ 26 KiB, large ≈ 412 KiB (데이터 URL 글자 수) → 한 개 438 KiB, 200개 85.5 MiB.
    const ctx = build(undefined, (path) => path.includes("size=thumb") ? 26 * KIB : 412 * KIB);
    const walk = async () => {
      let requests = 0;
      for (const size of ["thumb", "large"]) for (let i = 0; i < 200; i += 1) if (await read(ctx, `/sticker/${i}/image?size=${size}`)) requests += 1;
      return requests;
    };
    expect(await walk()).toBe(400); // 처음 들어감
    const { bytes, entries } = ctx.store.imageCacheStats();
    expect(entries).toBe(400);
    expect(bytes).toBeGreaterThan(80 * 1024 * KIB);
    expect(bytes).toBeLessThanOrEqual(IMAGE_CACHE_BUDGET_BYTES);
    expect(await walk()).toBe(0); // 같은 세션에서 다시 들어감
  });

  it("ExpressionImage 가 쥔 바이트와 겹쳐 두 번 세지 않는다: 같은 그림 두 칸이 한 번 받고 저장소는 한 번만 센다", async () => {
    const item: Expression = { ...FIXTURE_EXPRESSIONS[0], media: {
      small: { mime: "image/png", sha256: "a".repeat(64), bytes: 100, width: 64, height: 64, frameCount: 1, durationMs: 0 },
      large: { mime: "image/png", sha256: "b".repeat(64), bytes: 100, width: 128, height: 128, frameCount: 1, durationMs: 0 },
      thumb: { mime: "image/png", sha256: "c".repeat(64), bytes: 100, width: 64, height: 64, frameCount: 1, durationMs: 0 },
    } };
    const thumb = `data:image/png;base64,${"T".repeat(480)}`;
    const large = `data:image/png;base64,${"L".repeat(960)}`;
    const image = vi.fn(async (path: string) => path.includes("size=thumb") ? thumb : large);
    const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, { json: vi.fn(), image });
    render(<ExpressionsContext.Provider value={store}><ExpressionImage item={item} size="large" /><ExpressionImage item={item} size="large" /></ExpressionsContext.Provider>);
    // 두 칸 모두 두 variant(thumb → 보이면 large)를 썼지만, 센 바이트는 서로 다른 두 문자열의 합이다(칸이 쥔 사본은 같은 문자열을 가리킬 뿐이다).
    await waitFor(() => expect(store.imageCacheStats().bytes).toBe(thumb.length + large.length));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(store.imageCacheStats()).toMatchObject({ entries: 2, bytes: thumb.length + large.length });
    expect(image).toHaveBeenCalledTimes(2); // 요청도 variant 마다 한 번
  });
});
