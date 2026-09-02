import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCatalog, resetCatalogForTests } from "./catalog";

// =============================================================================
// 「다시 시도」가 **참인가** (design-review #1930 H-3).
//
// R2 가 실브라우저에서 잰 사실: 청크를 끊은 세션에서 카탈로그 요청은 평생 1건
// 이었고, 피커의 「다시 시도」도 컴포저의 것도 아무 요청을 만들지 못했다. 실패한
// dynamic import 는 모듈 맵이 그 specifier 의 실패로 영구히 기억하기 때문이다.
// R1·R2 의 주석은 「다음 질의에서 조용히 낫는다」고 적었는데 그것이 틀렸다.
//
// 그래서 이 파일은 `loadCatalog` 를 모킹하지 않는다 — 그 함수 **자신**이 두 번째
// 적재에서 다른 문을 두드리는지 잰다. 상태 시험(`composerAutocompleteCatalog`)이
// 훅의 배선을 재는 동안 아무도 로더의 현실을 보지 않았고, 그 구멍이 죽은 버튼을
// 두 표면에 출하했다.
// =============================================================================

// 첫 적재의 `import()` 를 실패시킨다. 브라우저의 「청크 404」와 같은 자리다.
vi.mock("./emojiCatalog.json", () => {
  throw new Error("chunk 404");
});

const RAW = {
  v: 1,
  items: [["🎉", "party popper", ["tada"], ["celebrate"], 3]],
};

function stubFetch(response: { ok: boolean; json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCatalogForTests();
});

describe("카탈로그 재시도 (#1930 H-3)", () => {
  it("첫 적재는 import 이고, 실패 뒤 재시도는 자산을 다시 받는다", async () => {
    resetCatalogForTests();
    const fetchMock = stubFetch({ ok: true, json: async () => RAW });
    await expect(loadCatalog()).rejects.toThrow();
    // 첫 문은 번들러의 것이다 — 여기까지는 `fetch` 가 없다.
    expect(fetchMock).not.toHaveBeenCalled();

    const entries = await loadCatalog();
    expect(entries.map((entry) => entry.glyph)).toEqual(["🎉"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toContain("emojiCatalog");
    // HTTP 캐시까지 지나야 「다시 받았다」가 참이다.
    expect(init.cache).toBe("reload");
  });

  it("재시도가 또 실패하면 그 다음 클릭이 또 나간다", async () => {
    resetCatalogForTests();
    const failing = stubFetch({ ok: false });
    await expect(loadCatalog()).rejects.toThrow();
    await expect(loadCatalog()).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    await expect(loadCatalog()).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("성공한 뒤에는 다시 받지 않는다 (한 번 실린 카탈로그는 기억한다)", async () => {
    resetCatalogForTests();
    const fetchMock = stubFetch({ ok: true, json: async () => RAW });
    await expect(loadCatalog()).rejects.toThrow();
    await loadCatalog();
    await loadCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("로더는 한 곳이다 (#1930 H-3)", () => {
  it("카탈로그 파일을 직접 여는 소스가 `catalog.ts` 하나뿐이다", () => {
    // 문장을 `copy.ts` 한 자리에 모은 것과 같은 이유다: 피커와 컴포저가 같은
    // 「다시 시도」를 내미는데 로더가 둘이면 한쪽만 참이 된다. 두 표면이 부르는
    // 것은 이 파일의 `loadCatalog` 하나여야 한다.
    const src = fileURLToPath(new URL("../..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = `${dir}/${entry}`;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          files.push(path);
        }
      }
    };
    walk(src);
    const openers = files
      .filter((path) => readFileSync(path, "utf8").includes("emojiCatalog.json"))
      .map((path) => path.slice(src.length));
    expect(openers).toEqual(["/features/emoji/catalog.ts"]);
  });
});
