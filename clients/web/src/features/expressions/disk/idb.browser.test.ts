import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { browserLaunchBlocked } from "@/testing/agentSandbox";
import type { ExpressionDiskApi } from "./idb.browser.entry";
import { EXPRESSION_DISK_LIFETIME_MS, expressionDiskKey, expressionDiskName } from "@momo/core/features/expressions/diskCache";

// =============================================================================
// 이모티콘 그림의 기기 캐시: **진짜 IndexedDB**(ADR-0218 §14 M5, #5455 B-1). 앱의 `idb.ts` 를 Vite 로 한 덩어리로 묶어 Playwright 의 Chromium·WebKit 에 올린다.
// 노드·jsdom 에는 IndexedDB 가 없어서 저장소 수준 시험(`ExpressionStore.disk.test.tsx`)은 메모리 가짜를 쓰고, 진짜 구현은 여기서만 잰다:
//   · 쓰고 읽은 바이트가 같고(왕복), 새로고침(새 문서·새 연결) 뒤에도 남는다 — 앱을 다시 켠 뒤에도 남는다는 것의 엔진 수준 증거다.
//   · 색인(keys)·키 지우기·id 별 지우기(키 범위 삭제)·수명 청소·바이트 상한 청소(오래 읽지 않은 것부터)가 진짜 저장소에서 돈다.
//   · 칸 지우기(`deleteDatabase`)가 칸을 통째로 없애고 칸 목록(`databases()`·장부)이 그것을 따른다. 다른 칸은 그대로다.
// 엔진: Chromium 과 WebKit 중 설치된 것 전부(데스크탑 앱은 macOS 의 WKWebView 라 WebKit 이 더 중요하다 — 단 Playwright WebKit 은 앱의 WKWebView 가 아니다, runtime-unverified).
// =============================================================================

const require_ = createRequire(import.meta.url);
const WEB_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ENTRY = fileURLToPath(new URL("./idb.browser.entry.ts", import.meta.url));
type EngineName = "webkit" | "chromium";
type Playwright = typeof import("playwright");

function engineMissing(name: EngineName): string | null {
  const blocked = browserLaunchBlocked();
  if (blocked !== null) return blocked;
  try {
    const playwright = require_("playwright") as Playwright;
    return existsSync(playwright[name].executablePath()) ? null : playwright[name].executablePath();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
const ENGINES: EngineName[] = (["webkit", "chromium"] as const).filter((name) => {
  const missing = engineMissing(name);
  if (missing !== null) console.warn(`expression disk idb: Playwright ${name} missing (${missing})`);
  return missing === null;
});

async function bundle(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: WEB_ROOT,
    resolve: { alias: { "@": fileURLToPath(new URL("../../../", import.meta.url)), "@momo/core": fileURLToPath(new URL("../../../../../../packages/momo-core/src", import.meta.url)) } },
    build: { write: false, minify: false, lib: { entry: ENTRY, formats: ["iife"], name: "ExpressionDiskEntry" } },
  });
  const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string }[] };
  const chunk = output.output.find((item) => item.type === "chunk");
  if (!chunk?.code) throw new Error("bundle produced no chunk");
  return chunk.code;
}

const WS = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-0000000000aa";
const ID_A = "00000000-0000-4000-8000-000000000011";
const ID_B = "00000000-0000-4000-8000-000000000012";
const SHA = "ab".repeat(32);
const NAME = expressionDiskName(WS, ME)!;
const OTHER_NAME = expressionDiskName(WS, OTHER)!;
const ORIGIN = "http://expression-disk.test/";

describe.skipIf(ENGINES.length === 0)("이모티콘 그림의 기기 캐시: 진짜 IndexedDB", () => {
  describe.each(ENGINES)("%s", (name) => {
    let script = "";
    const withPage = async <T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> => {
      const playwright = require_("playwright") as Playwright;
      const browser = await playwright[name].launch();
      try {
        const context = await browser.newContext();
        await context.route(`${ORIGIN}**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>expression disk</title>" }));
        const page = await context.newPage();
        await page.goto(ORIGIN);
        await page.addScriptTag({ content: script });
        return await fn(page);
      } finally {
        await browser.close();
      }
    };
    const call = <K extends keyof ExpressionDiskApi>(page: import("playwright").Page, method: K, ...args: Parameters<ExpressionDiskApi[K]>) =>
      page.evaluate(([m, a]) => (globalThis as unknown as { __expressionDisk: Record<string, (...rest: unknown[]) => unknown> }).__expressionDisk[m as string](...(a as unknown[])), [method, args] as const) as Promise<Awaited<ReturnType<ExpressionDiskApi[K]>>>;
    const setClock = (page: import("playwright").Page, ms: number) => page.evaluate((value) => { (globalThis as unknown as { __expressionDiskClock: number }).__expressionDiskClock = value; }, ms);

    it("번들을 만든다", async () => {
      script = await bundle();
      expect(script).toContain("__expressionDisk");
    }, 60_000);

    it("쓴 바이트가 그대로 읽히고(왕복), 새로고침(새 문서·새 연결) 뒤에도 남는다 — 없는 키는 null 이다", async () => {
      await withPage(async (page) => {
        const entryKey = expressionDiskKey(ID_A, "large", SHA);
        expect(await call(page, "read", NAME, entryKey), "전제: 처음에는 비어 있다").toBeNull();
        await call(page, "write", NAME, entryKey, [1, 2, 3, 4, 5], "image/png");
        expect(await call(page, "read", NAME, entryKey)).toEqual({ bytes: [1, 2, 3, 4, 5], mime: "image/png" });
        await call(page, "write", NAME, entryKey, [9, 8], "image/gif"); // 같은 키는 덮어쓴다
        expect(await call(page, "read", NAME, entryKey)).toEqual({ bytes: [9, 8], mime: "image/gif" });
        await page.reload();
        await page.addScriptTag({ content: script });
        expect(await call(page, "read", NAME, entryKey), "앱을 다시 켠 뒤(새 문서)에도 같은 바이트다").toEqual({ bytes: [9, 8], mime: "image/gif" });
        expect(await call(page, "read", NAME, expressionDiskKey(ID_A, "thumb", SHA))).toBeNull();
      });
    }, 90_000);

    it("색인·키 지우기·id 별 지우기: 한 표현의 모든 크기·sha 가 지워지고 다른 표현은 남는다", async () => {
      await withPage(async (page) => {
        const aLarge = expressionDiskKey(ID_A, "large", SHA);
        const aThumb = expressionDiskKey(ID_A, "thumb", "cd".repeat(32));
        const bLarge = expressionDiskKey(ID_B, "large", SHA);
        for (const entryKey of [aLarge, aThumb, bLarge]) await call(page, "write", NAME, entryKey, [1, 2, 3], "image/png");
        expect((await call(page, "keys", NAME))!.sort()).toEqual([aLarge, aThumb, bLarge].sort());
        await call(page, "remove", NAME, [bLarge]);
        expect((await call(page, "keys", NAME))!.sort()).toEqual([aLarge, aThumb].sort());
        await call(page, "write", NAME, bLarge, [4], "image/png");
        await call(page, "removeIds", NAME, [ID_A]);
        expect(await call(page, "keys", NAME)).toEqual([bLarge]);
        expect(await call(page, "read", NAME, aLarge)).toBeNull(); // 바이트도 함께 지워졌다
      });
    }, 90_000);

    it("수명 청소(7일)와 바이트 상한 청소(오래 읽지 않은 것부터): 진짜 저장소에서 돈다", async () => {
      await withPage(async (page) => {
        const old = expressionDiskKey(ID_A, "small", SHA);
        const keepA = expressionDiskKey(ID_A, "large", SHA);
        const keepB = expressionDiskKey(ID_B, "large", SHA);
        const keepC = expressionDiskKey(ID_B, "thumb", SHA);
        const day = EXPRESSION_DISK_LIFETIME_MS / 7;
        const base = 100 * day;
        await setClock(page, base - 8 * day);
        await call(page, "write", NAME, old, [1], "image/png"); // 8일 전
        await setClock(page, base - 3000);
        await call(page, "write", NAME, keepA, new Array(10).fill(1), "image/png");
        await setClock(page, base - 2000);
        await call(page, "write", NAME, keepB, new Array(10).fill(2), "image/png");
        await setClock(page, base - 1000);
        await call(page, "write", NAME, keepC, new Array(10).fill(3), "image/png");
        await setClock(page, base);
        await call(page, "trim", NAME);
        expect((await call(page, "keys", NAME))!.sort(), "8일 지난 항목만 지워진다").toEqual([keepA, keepB, keepC].sort());
        // 바이트 상한 25: 합 30 → 오래 읽지 않은 keepA 하나를 버려 20 이 된다(개수로 세면 아무것도 안 버린다).
        await call(page, "trim", NAME, { budgetBytes: 25 });
        expect((await call(page, "keys", NAME))!.sort()).toEqual([keepB, keepC].sort());
      });
    }, 90_000);

    it("칸 지우기(deleteDatabase)가 칸을 통째로 없애고 칸 목록이 그것을 따른다. 다른 칸은 그대로다", async () => {
      await withPage(async (page) => {
        const entryKey = expressionDiskKey(ID_A, "large", SHA);
        await call(page, "write", NAME, entryKey, [1, 2], "image/png");
        await call(page, "write", OTHER_NAME, entryKey, [3, 4], "image/png");
        expect((await call(page, "list")).sort()).toEqual([NAME, OTHER_NAME].sort());
        expect(await call(page, "registry")).toEqual(expect.arrayContaining([NAME, OTHER_NAME]));
        await call(page, "destroy", NAME);
        expect(await call(page, "list")).toEqual([OTHER_NAME]);
        expect(await call(page, "read", NAME, entryKey), "지운 칸은 비어 있다").toBeNull();
        expect(await call(page, "read", OTHER_NAME, entryKey), "다른 칸은 그대로다").toEqual({ bytes: [3, 4], mime: "image/png" });
        await page.reload();
        await page.addScriptTag({ content: script });
        expect(await call(page, "list"), "새로고침 뒤에도 지운 칸은 없다").toEqual([OTHER_NAME]);
      });
    }, 90_000);
  });
});
