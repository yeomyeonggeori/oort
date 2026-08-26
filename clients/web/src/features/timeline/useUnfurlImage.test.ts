import { describe, expect, it } from "vitest";
import { UnfurlImageCache } from "./useUnfurlImage";

describe("UnfurlImageCache", () => {
  it("개수 상한에서 최근 읽은 항목을 남기는 LRU로 방출한다", () => {
    const cache = new UnfurlImageCache(2, 100);
    cache.remember("old", "aaaa");
    cache.remember("next", "bbbb");

    expect(cache.get("old")).toBe("aaaa");
    cache.remember("new", "cccc");

    expect(cache.get("next")).toBeUndefined();
    expect(cache.get("old")).toBe("aaaa");
    expect(cache.get("new")).toBe("cccc");
  });

  it("개수가 남아도 인코딩 바이트 예산을 넘으면 LRU를 방출한다", () => {
    const cache = new UnfurlImageCache(48, 10);
    cache.remember("old", "123456");
    cache.remember("new", "abcdef");

    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("new")).toBe("abcdef");
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(6);
  });

  it("예산보다 큰 단일 값은 현재 렌더만 허용하고 캐시에 붙잡지 않는다", () => {
    const cache = new UnfurlImageCache(48, 5);

    cache.remember("oversized", "123456");

    expect(cache.get("oversized")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
