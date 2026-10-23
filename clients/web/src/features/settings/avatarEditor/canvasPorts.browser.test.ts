import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { AVATAR_PRESET_IDS, type AvatarDraft } from "@momo/core/features/workspace/avatarEditor";
import { inspectPng } from "@momo/core/features/workspace/avatarPng";
import { avatarBackgroundById } from "@momo/core/features/workspace/avatarPalette";
import type { ComposeResult } from "./canvasPorts.browser.entry";

// =============================================================================
// 아바타 그리기: **진짜 브라우저**에서 앱이 쓰는 그 포트와 모델을 돌린다 (#4261).
//
// 노드에는 캔버스도 이모지 글꼴도 PNG 인코더도 없어서 「그려 올린 PNG가 정본」이라는 약속을 거기서 잴 수 없다. 이 시험은
// 앱의 실제 코드(`canvasAvatarPorts` + core `composeAvatarPng`)를 Vite 로 한 덩어리로 묶어 Playwright 브라우저에 올리고
// 출력 바이트를 **다시 디코드해서** 픽셀을 읽는다.
//
//   · 출력은 구조가 온전한 512×512 PNG 이고(시그니처·IHDR·IEND), 서버 상한 안이다.
//   · 네 모서리가 배경색과 **정확히** 같다(불투명, 색 관리로 값이 밀리지 않는다).
//   · 글리프가 그려졌고 가운데에 서며, 사람 아바타의 원(`rounded-full`) 밖으로 나가지 않는다.
//   · 같은 초안은 같은 바이트다(이 엔진 안에서). 기기마다 다른 것은 이모지 그림이고, 그래서 PNG 가 정본이다.
//   · 코메토 출력은 정본 컷을 `AVATAR_PRESET_CROP` 으로 자르고 단색 바탕에 한 번 그린 **기준 그림과 픽셀 단위로 같다**(아무것도 더 얹지 않았다).
//   · 판정이 진짜 그림에서 동작한다: 🌕 은 진한 배경에서 서고 노란 배경에서 묻힌다. 코메토는 진한 배경에서만 선다.
//
// 엔진: Chromium 과 WebKit 중 설치된 것 전부(데스크탑 앱은 macOS 의 WKWebView 라 WebKit 이 더 중요하다). 둘 다 없으면
// 경고를 남기고 건너뛴다(다른 브라우저 시험과 같은 규약).
// =============================================================================

const require_ = createRequire(import.meta.url);
const WEB_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ENTRY = fileURLToPath(new URL("./canvasPorts.browser.entry.ts", import.meta.url));

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
  if (missing !== null) console.warn(`avatar canvas: Playwright ${name} missing (${missing})`);
  return missing === null;
});

async function bundle(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: WEB_ROOT,
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("../../../", import.meta.url)),
        "@momo/core": fileURLToPath(new URL("../../../../../../packages/momo-core/src", import.meta.url)),
      },
    },
    // 라이브러리 모드는 import 한 자산(코메토 PNG)을 data: 주소로 넣는다: 같은 오리진이라 캔버스가 오염되지 않는다.
    build: { write: false, minify: false, lib: { entry: ENTRY, formats: ["iife"], name: "AvatarPortsEntry" } },
  });
  const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string }[] };
  const chunk = output.output.find((item) => item.type === "chunk");
  if (!chunk?.code) throw new Error("bundle produced no chunk");
  return chunk.code;
}

interface Page {
  addScriptTag(options: { content: string }): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  close(): Promise<void>;
  goto(url: string): Promise<unknown>;
}

type Rgb = [number, number, number];

const NAVY = avatarBackgroundById("navy")!;
const BUTTER = avatarBackgroundById("butter")!;

/**
 * 출력 PNG 를 브라우저가 다시 디코드한 픽셀: 모서리, 배경과 다른 픽셀의 경계·반경.
 * `strong` 은 배경과 채널 차이 합이 30을 넘는 픽셀(글리프의 몸통)이고, `any` 는 한 단계라도 다른 픽셀(번짐·그림자 포함)이다.
 * 가운데 맞춤은 몸통(`strong`)으로 재고(🕴️ 의 발밑 그림자 같은 아주 옅은 번짐은 가운데에 서야 하는 것이 아니다),
 * 원 안에 드는지는 번짐까지(`any`) 잰다.
 */
interface Box {
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  maxRadius: number;
}
interface Decoded {
  size: number[];
  corners: number[][];
  any: Box | null;
  strong: Box | null;
}

async function decode(page: Page, bytes: number[], bg: Rgb): Promise<Decoded> {
  return page.evaluate(
    async ({ data, color }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const g = canvas.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(bitmap, 0, 0);
      const { data: px } = g.getImageData(0, 0, bitmap.width, bitmap.height);
      const w = bitmap.width;
      const at = (x: number, y: number) => Array.from(px.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
      const boxes = { any: { count: 0, minX: w, minY: w, maxX: -1, maxY: -1, maxRadius: 0 }, strong: { count: 0, minX: w, minY: w, maxX: -1, maxY: -1, maxRadius: 0 } };
      const half = w / 2;
      for (let y = 0; y < w; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          const diff = Math.abs(px[i] - color[0]) + Math.abs(px[i + 1] - color[1]) + Math.abs(px[i + 2] - color[2]);
          if (diff === 0) continue;
          const radius = Math.hypot(x + 0.5 - half, y + 0.5 - half);
          for (const [key, box] of Object.entries(boxes)) {
            if (key === "strong" && diff <= 30) continue;
            box.count += 1;
            box.minX = Math.min(box.minX, x);
            box.minY = Math.min(box.minY, y);
            box.maxX = Math.max(box.maxX, x);
            box.maxY = Math.max(box.maxY, y);
            box.maxRadius = Math.max(box.maxRadius, radius);
          }
        }
      }
      return {
        size: [bitmap.width, bitmap.height],
        corners: [at(0, 0), at(w - 1, 0), at(0, w - 1), at(w - 1, w - 1)],
        any: boxes.any.count === 0 ? null : boxes.any,
        strong: boxes.strong.count === 0 ? null : boxes.strong,
      };
    },
    { data: bytes, color: bg }
  );
}

const channelsOf = (hex: string): Rgb => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb;

describe.skipIf(ENGINES.length === 0)("아바타 그리기: 진짜 브라우저에서", () => {
  describe.each(ENGINES)("%s", (name) => {
    let script = "";
    const withPage = async <T>(fn: (page: Page) => Promise<T>): Promise<T> => {
      const playwright = require_("playwright") as Playwright;
      const browser = await playwright[name].launch();
      try {
        const page = (await browser.newPage()) as unknown as Page;
        await page.goto("about:blank");
        await page.addScriptTag({ content: script });
        return await fn(page);
      } finally {
        await browser.close();
      }
    };
    const run = (page: Page, method: "compose" | "render" | "judge", draft: AvatarDraft) =>
      page.evaluate(
        async ([m, d]) => {
          const api = (globalThis as unknown as Record<string, Record<string, (x: unknown) => Promise<unknown>>>).__avatarPorts;
          return api[m as string](d);
        },
        [method, draft] as [string, AvatarDraft]
      ) as Promise<ComposeResult & { share: number }>;

    it("번들을 만든다", async () => {
      script = await bundle();
      expect(script).toContain("__avatarPorts");
    }, 60_000);

    it("이모지 아바타는 온전한 512×512 PNG 이고 네 모서리가 배경색과 정확히 같다", async () => {
      await withPage(async (page) => {
        const out = await run(page, "compose", { kind: "emoji", emoji: "🎉", bg: NAVY.hex });
        expect(out.ok, JSON.stringify(out)).toBe(true);
        const bytes = Uint8Array.from(out.bytes!);
        expect(inspectPng(bytes)).toMatchObject({ width: 512, height: 512 });
        expect(bytes.length).toBeLessThan(5 * 1024 * 1024);
        const decoded = await decode(page, out.bytes!, channelsOf(NAVY.hex));
        expect(decoded.size).toEqual([512, 512]);
        // 모서리 = 배경(불투명). 색 관리·알파로 값이 밀렸다면 여기서 드러난다.
        for (const corner of decoded.corners) expect(corner).toEqual([...channelsOf(NAVY.hex), 255]);
        // 글리프가 실제로 그려졌다(배경이 전부가 아니다).
        expect(decoded.strong).not.toBeNull();
        expect(decoded.strong!.count).toBeGreaterThan(512 * 512 * 0.05);
      });
    }, 60_000);

    it("글리프는 가운데에 서고 사람 아바타의 원 밖으로 나가지 않는다 (이모지 스무 종, 깃발·ZWJ·피부색 포함)", async () => {
      const emoji = ["🎉", "😀", "🔥", "🌕", "🖤", "🤍", "🐝", "🚀", "☁️", "🏳️‍🌈", "👨‍👩‍👧‍👦", "🇰🇷", "👍🏽", "🕴️", "🍉", "🦄", "🛠️", "💡", "⭐", "❤️"];
      await withPage(async (page) => {
        for (const glyph of emoji) {
          const out = await run(page, "render", { kind: "emoji", emoji: glyph, bg: NAVY.hex });
          expect(out.ok, `${glyph} ${JSON.stringify(out)}`).toBe(true);
          const { strong, any } = await decode(page, out.bytes!, channelsOf(NAVY.hex));
          expect(strong, glyph).not.toBeNull();
          const centerX = (strong!.minX + strong!.maxX + 1) / 2;
          const centerY = (strong!.minY + strong!.maxY + 1) / 2;
          // 글리프 몸통의 상자 중심이 층의 중심(256)에 선다(옮겨 그릴 때의 반올림 한 칸 이내).
          expect(Math.abs(centerX - 256), `${glyph} x`).toBeLessThanOrEqual(2);
          expect(Math.abs(centerY - 256), `${glyph} y`).toBeLessThanOrEqual(2);
          // 번짐까지 포함해 반경 256(원)에 들어온다: `rounded-full` 로 잘려도 글리프가 남는다.
          expect(any!.maxRadius, `${glyph} radius`).toBeLessThan(256);
        }
      });
    }, 120_000);

    it("같은 초안은 같은 바이트다 (이 엔진 안에서): 판정과 그리기에 숨은 무작위가 없다", async () => {
      await withPage(async (page) => {
        const draft: AvatarDraft = { kind: "emoji", emoji: "🎉", bg: NAVY.hex };
        const a = await run(page, "compose", draft);
        const b = await run(page, "compose", draft);
        expect(a.bytes).toEqual(b.bytes);
      });
    }, 60_000);

    it("판정이 진짜 그림에서 동작한다: 🌕 은 진한 배경에서 서고 노란 배경에 묻힌다 (저장 경로도 같다)", async () => {
      await withPage(async (page) => {
        const moonOnNavy = await run(page, "compose", { kind: "emoji", emoji: "🌕", bg: NAVY.hex });
        expect(moonOnNavy.ok, JSON.stringify(moonOnNavy)).toBe(true);
        // 자유 색 한 점(팔레트 밖): 노란 배경 위 노란 달. 소스에 색 글자를 적지 않고 채널 값으로 만든다.
        const yellow = `#${[255, 231, 92].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
        const judged = await run(page, "judge", { kind: "emoji", emoji: "🌕", bg: yellow });
        expect(judged).toMatchObject({ ok: false, reason: "low-contrast" });
        const moonOnYellow = await run(page, "compose", { kind: "emoji", emoji: "🌕", bg: yellow });
        expect(moonOnYellow).toEqual({ ok: false, reason: "low-contrast" });
        // 미리보기 길은 같은 조합도 그린다(왜 안 되는지가 보이게).
        expect((await run(page, "render", { kind: "emoji", emoji: "🌕", bg: yellow })).ok).toBe(true);
      });
    }, 60_000);

    it("코메토 여섯 표정은 진한 배경에서 서고 연한 배경에서 막힌다, 출력은 정본 컷을 자른 PNG 다", async () => {
      await withPage(async (page) => {
        for (const preset of AVATAR_PRESET_IDS) {
          const dark = await run(page, "compose", { kind: "preset", preset, bg: NAVY.hex });
          expect(dark.ok, `${preset} ${JSON.stringify(dark)}`).toBe(true);
          expect(dark.share).toBeGreaterThanOrEqual(0.5);
          const decoded = await decode(page, dark.bytes!, channelsOf(NAVY.hex));
          // 코메토는 자른 그림이 캔버스를 거의 채운다. 왼쪽 위만 투명한 자리라 배경색이 보이고(배경을 고르는 뜻이 남는다),
          // 나머지 모서리는 후드·몸통이 덮는다.
          expect(decoded.corners[0], preset).toEqual([...channelsOf(NAVY.hex), 255]);
          expect(decoded.strong!.count, preset).toBeGreaterThan(512 * 512 * 0.5);
          const light = await run(page, "compose", { kind: "preset", preset, bg: BUTTER.hex });
          expect(light, preset).toEqual({ ok: false, reason: "low-contrast" });
        }
      });
    }, 120_000);

    it("코메토는 정본 컷의 자르기와 배경색 조합뿐이다: 기준 그림과 픽셀 하나도 다르지 않다 (새 그림·외곽선·그림자 금지)", async () => {
      await withPage(async (page) => {
        for (const preset of AVATAR_PRESET_IDS) {
          for (const bg of [NAVY.hex, avatarBackgroundById("forest")!.hex]) {
            const out = await run(page, "render", { kind: "preset", preset, bg });
            expect(out.ok, `${preset} ${JSON.stringify(out)}`).toBe(true);
            const different = await page.evaluate(
              async ([bytes, input]) =>
                (globalThis as unknown as { __avatarPorts: { differencesFromPlainCrop(b: number[], i: unknown): Promise<number> } }).__avatarPorts.differencesFromPlainCrop(
                  bytes as number[],
                  input
                ),
              [out.bytes!, { preset, bg }] as [number[], { preset: string; bg: string }]
            );
            expect(different, `${preset} on ${bg}: ${different} channel values differ from the plain crop`).toBe(0);
          }
        }
      });
    }, 120_000);

    it("글꼴에 없는 글자는 막힌다: 아무것도 그려지지 않으면 그림이 없다", async () => {
      await withPage(async (page) => {
        // U+0378 은 배정되지 않은 코드포인트다. 엔진에 따라 빈칸이거나 대체 글리프일 수 있어 둘 중 하나의 계약만 단정한다:
        // 그려지지 않았다면 blank 로 막히고, 그려졌다면 올바른 PNG 이거나 판정 사유가 있다.
        const out = await run(page, "compose", { kind: "emoji", emoji: "͸", bg: NAVY.hex });
        if (out.ok) expect(inspectPng(Uint8Array.from(out.bytes!))).toMatchObject({ width: 512, height: 512 });
        else expect(["blank", "low-contrast"]).toContain(out.reason);
      });
    }, 60_000);
  });
});
