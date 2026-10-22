import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { exifSegment, injectExif, inspectJpeg } from "../../../scripts/lib/jpegExif.mjs";
import { stripJpegMetadata } from "@momo/core/design/jpegMetadata";
import { PHOTO_MAX_BYTES, PHOTO_MAX_LONG_SIDE, PHOTO_THUMB_LONG_SIDE } from "@momo/core/design/wallpaper";
import type { RunResult } from "./photo.browser.entry";

// =============================================================================
// 내 사진 → 상한 안의 JPEG: **진짜 브라우저**에서 앱이 쓰는 그 포트와 계단을 돌린다 (AP-4 #4191, 이슈 AC 3).
//
// 노드에는 캔버스도 이미지 디코더도 없어서 EXIF가 벗겨진다는 사실은 거기서 잴 수 없다. 이 시험은 앱의 실제 코드
// (`canvasPhotoPorts` + core `importPhoto`)를 Vite로 한 덩어리로 묶어 Playwright 브라우저에 올리고, 위치(GPS)와
// 회전 태그가 **실제로** 든 JPEG 픽스처를 넣어 출력 바이트를 바이트 단위로 읽는다.
//
//   · 입력에 EXIF가 있음을 먼저 단정한다(가드가 실패할 수 있어야 한다). 검사기가 EXIF 없는 JPEG를 없다고 읽는 것도 단정한다.
//   · 출력에 Exif 세그먼트·GPS 태그가 없다.
//   · 회전이 **픽셀에 구워졌다**: 가로로 저장된 세로 사진은 출력이 세로이고, 위쪽 표식이 올바른 모서리에 있다.
//   · 긴 변 ≤ 2560, 크기 ≤ 1.5MB. 큰 잡음 사진은 계단을 내려가 상한 안에 든다.
//   · 작은 사진은 키우지 않고, 투명 PNG는 흰 바탕 위에 구워지며, JPEG가 아닌 바이트는 읽지 못한 사진이다.
//
// 엔진: Chromium과 WebKit 중 설치된 것 전부. 데스크탑 앱은 macOS의 WKWebView(WebKit)이라 WebKit이 있는 레인에서는
// 그쪽이 더 중요하다(둘 다 없으면 경고를 남기고 건너뛴다, 다른 브라우저 시험과 같은 규약).
// =============================================================================

const require_ = createRequire(import.meta.url);
const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENTRY = fileURLToPath(new URL("./photo.browser.entry.ts", import.meta.url));

type EngineName = "webkit" | "chromium";
type Playwright = typeof import("playwright");

function engineMissing(name: EngineName): string | null {
  try {
    const playwright = require_("playwright") as Playwright;
    const exe = playwright[name].executablePath();
    return existsSync(exe) ? null : exe;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const ENGINES: EngineName[] = (["webkit", "chromium"] as const).filter((name) => {
  const missing = engineMissing(name);
  if (missing !== null) console.warn(`wallpaper photo: Playwright ${name} missing (${missing})`);
  return missing === null;
});

/** 앱의 사진 처리를 한 덩어리 스크립트로 묶는다(IIFE). */
async function bundle(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: WEB_ROOT,
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("../../", import.meta.url)),
        "@momo/core": fileURLToPath(new URL("../../../../../packages/momo-core/src", import.meta.url)),
      },
    },
    build: { write: false, minify: false, lib: { entry: ENTRY, formats: ["iife"], name: "WallpaperPhotoEntry" } },
  });
  const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string }[] };
  const chunk = output.output.find((item) => item.type === "chunk");
  if (!chunk?.code) throw new Error("bundle produced no chunk");
  return chunk.code;
}

interface Page {
  addScriptTag(options: { content: string }): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** 브라우저의 캔버스로 만든 JPEG/PNG 픽스처. 소스에 색 리터럴을 적지 않는다(채널 값으로 칠한다). */
async function makeImage(page: Page, spec: { kind: "arrow" | "noise" | "flat" | "alpha"; width: number; height: number; type: string; seed?: number }): Promise<Uint8Array> {
  const bytes = await page.evaluate(
    async (s) => {
      const canvas = document.createElement("canvas");
      canvas.width = s.width;
      canvas.height = s.height;
      const g = canvas.getContext("2d")!;
      // 채널 값으로 칠한다(색 리터럴을 소스에 적지 않는다).
      const fill = (r: number, gr: number, b: number) => {
        g.fillStyle = `#${[r, gr, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      };
      let seed = s.seed ?? 5;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      if (s.kind === "arrow") {
        // 가로로 저장된 그림: 파랗고, 왼쪽 위 모서리에 빨간 정사각형.
        fill(30, 110, 235);
        g.fillRect(0, 0, s.width, s.height);
        fill(255, 59, 48);
        g.fillRect(0, 0, s.width * 0.25, s.height * 0.25);
      } else if (s.kind === "flat") {
        fill(40, 160, 90);
        g.fillRect(0, 0, s.width, s.height);
      } else if (s.kind === "alpha") {
        // 왼쪽 절반은 투명이고 오른쪽 절반은 빨갛다.
        g.clearRect(0, 0, s.width, s.height);
        fill(255, 0, 0);
        g.fillRect(s.width / 2, 0, s.width / 2, s.height);
      } else {
        const image = g.createImageData(s.width, s.height);
        for (let i = 0; i < image.data.length; i += 4) {
          image.data[i] = (rand() * 256) | 0;
          image.data[i + 1] = (rand() * 256) | 0;
          image.data[i + 2] = (rand() * 256) | 0;
          image.data[i + 3] = 255;
        }
        g.putImageData(image, 0, 0);
      }
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), s.type, 0.92));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    spec
  );
  return Uint8Array.from(bytes);
}

async function runPipeline(page: Page, bytes: Uint8Array, type: string): Promise<RunResult> {
  return page.evaluate(
    async ([data, mime]) => {
      const api = (globalThis as unknown as { __wallpaperPhoto: { run(b: number[], t: string): Promise<RunResult> } }).__wallpaperPhoto;
      return api.run(data as number[], mime as string);
    },
    [Array.from(bytes), type] as [number[], string]
  );
}

/** 출력 JPEG의 네 모서리 근처 픽셀(브라우저가 디코드한 값). */
async function corners(page: Page, bytes: number[]): Promise<{ topLeft: number[]; topRight: number[]; bottomLeft: number[]; size: number[] }> {
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/jpeg" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0);
    const at = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
    const inset = 6;
    return {
      topLeft: at(inset, inset),
      topRight: at(bitmap.width - 1 - inset, inset),
      bottomLeft: at(inset, bitmap.height - 1 - inset),
      size: [bitmap.width, bitmap.height],
    };
  }, bytes);
}

const reddish = ([r, g, b]: number[]) => r > 170 && g < 110 && b < 110;
const bluish = ([r, , b]: number[]) => b > 150 && r < 90;

describe.skipIf(ENGINES.length === 0)("내 사진 처리: 진짜 브라우저에서", () => {
  describe.each(ENGINES)("%s", (name) => {
    let script = "";
    const withPage = async <T>(fn: (page: Page) => Promise<T>): Promise<T> => {
      const playwright = require_("playwright") as Playwright;
      const browser = await playwright[name].launch();
      try {
        const page = (await browser.newPage()) as unknown as Page;
        await (page as unknown as { goto(url: string): Promise<unknown> }).goto("about:blank");
        await page.addScriptTag({ content: script });
        return await fn(page);
      } finally {
        await browser.close();
      }
    };

    it("번들을 만든다", async () => {
      script = await bundle();
      expect(script).toContain("__wallpaperPhoto");
    }, 60_000);

    it("EXIF·GPS가 벗겨지고 회전이 픽셀에 구워진다 (가로로 저장된 세로 사진, Orientation 6)", async () => {
      await withPage(async (page) => {
        const base = await makeImage(page, { kind: "arrow", width: 1200, height: 800, type: "image/jpeg" });
        const withExif = injectExif(base, exifSegment({ orientation: 6, gps: { lat: [37, 34, 12], lon: [126, 58, 30] } }));
        // 전제: 입력에는 정말 EXIF·GPS·회전 태그가 있고, 검사기는 메타데이터 없는 JPEG를 없다고 읽는다 (그래서 이 시험은 실패할 수 있다).
        // 엔진이 캔버스 출력에 자기 Exif를 쓰기도 하므로(WebKit) 깨끗한 대조군은 `stripJpegMetadata`를 거친 같은 바이트다.
        const before = inspectJpeg(withExif);
        expect([before.exif, before.gps, before.orientation, before.width, before.height]).toEqual([true, true, 6, 1200, 800]);
        const control = stripJpegMetadata(base);
        expect(control).not.toBeNull();
        const clean = inspectJpeg(control!);
        expect([clean.isJpeg, clean.exif, clean.gps]).toEqual([true, false, false]);

        const out = await runPipeline(page, withExif, "image/jpeg");
        expect(out.ok, JSON.stringify(out)).toBe(true);
        const bytes = Uint8Array.from(out.bytes!);
        const after = inspectJpeg(bytes);
        expect(after.isJpeg).toBe(true);
        expect(after.exif).toBe(false);
        expect(after.gps).toBe(false);
        expect(after.markers).not.toContain("FFE1");
        // 회전: 가로 1200x800 + Orientation 6 → 세로 800x1200, 위쪽 표식(원래 왼쪽 위)은 오른쪽 위로 간다.
        expect([after.width, after.height]).toEqual([800, 1200]);
        expect([out.width, out.height]).toEqual([800, 1200]);
        const px = await corners(page, out.bytes!);
        expect(px.size).toEqual([800, 1200]);
        expect(reddish(px.topRight), `오른쪽 위가 빨갛다: ${px.topRight}`).toBe(true);
        expect(bluish(px.topLeft), `왼쪽 위가 파랗다: ${px.topLeft}`).toBe(true);
        expect(bluish(px.bottomLeft)).toBe(true);
        expect(bytes.length).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
        // 썸네일도 EXIF가 없고 긴 변이 상한 안이다.
        const thumb = inspectJpeg(Uint8Array.from(out.thumb!));
        expect([thumb.isJpeg, thumb.exif, thumb.gps]).toEqual([true, false, false]);
        expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(PHOTO_THUMB_LONG_SIDE);
      });
    }, 90_000);

    it("회전 태그가 없는 사진은 그대로 서 있다 (대조군: 모든 사진을 눕히지 않는다)", async () => {
      await withPage(async (page) => {
        const base = await makeImage(page, { kind: "arrow", width: 1200, height: 800, type: "image/jpeg" });
        const out = await runPipeline(page, base, "image/jpeg");
        expect(out.ok).toBe(true);
        expect([out.width, out.height]).toEqual([1200, 800]);
        // 엔진이 인코더 메타데이터를 쓰더라도(WebKit) 출력에는 Exif가 없다.
        expect(inspectJpeg(Uint8Array.from(out.bytes!)).exif).toBe(false);
        const px = await corners(page, out.bytes!);
        expect(reddish(px.topLeft), `왼쪽 위가 빨갛다: ${px.topLeft}`).toBe(true);
      });
    }, 90_000);

    it("큰 잡음 사진은 계단을 내려가 긴 변 2560, 1.5MB 안에 든다", async () => {
      await withPage(async (page) => {
        const noise = await makeImage(page, { kind: "noise", width: 4200, height: 2800, type: "image/jpeg", seed: 3 });
        expect(noise.length, "전제: 원본이 상한을 훨씬 넘는다").toBeGreaterThan(PHOTO_MAX_BYTES * 2);
        const out = await runPipeline(page, noise, "image/jpeg");
        expect(out.ok, JSON.stringify({ ok: out.ok, reason: out.reason })).toBe(true);
        const info = inspectJpeg(Uint8Array.from(out.bytes!));
        expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(PHOTO_MAX_LONG_SIDE);
        expect(out.bytes!.length).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
      });
    }, 150_000);

    it("작은 사진은 키우지 않는다", async () => {
      await withPage(async (page) => {
        const small = await makeImage(page, { kind: "flat", width: 320, height: 200, type: "image/jpeg" });
        const out = await runPipeline(page, small, "image/jpeg");
        expect(out.ok).toBe(true);
        expect([out.width, out.height]).toEqual([320, 200]);
      });
    }, 60_000);

    it("투명 PNG는 흰 바탕 위에 구워진다 (검게 저장되지 않는다)", async () => {
      await withPage(async (page) => {
        const png = await makeImage(page, { kind: "alpha", width: 400, height: 300, type: "image/png" });
        const out = await runPipeline(page, png, "image/png");
        expect(out.ok).toBe(true);
        const px = await corners(page, out.bytes!);
        // 왼쪽(원래 투명)은 흰색에 가깝고 오른쪽(빨강)은 빨갛다.
        expect(px.topLeft.every((c) => c > 235), `투명했던 자리: ${px.topLeft}`).toBe(true);
        expect(reddish(px.topRight), `빨간 자리: ${px.topRight}`).toBe(true);
      });
    }, 60_000);

    it("JPEG도 이미지도 아닌 바이트는 읽지 못한 사진이다 (던지지 않는다)", async () => {
      await withPage(async (page) => {
        const out = await runPipeline(page, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), "image/jpeg");
        expect(out).toEqual({ ok: false, reason: "unreadable" });
      });
    }, 60_000);
  });
});
