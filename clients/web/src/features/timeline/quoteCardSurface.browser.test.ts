import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { contrast, oklabDistance } from "@momo/core/design/color";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// #5421 (디자인 검수 6a 웹 M1) — 인용 카드의 그릇이 줄 가리킴·키보드 초점 면에 녹지 않는다, **엔진이 계산한 값**으로.
//
// `derivedCatalog.contract.test.ts` 는 CSS 가 말하는 토큰 이름과 57행의 색 산수를 잰다. 그 시험은 중첩 선택자
// (`.row-hover:hover:not(:active) &`)가 브라우저에서 실제로 걸리는지는 모른다 — 걸리지 않아도 초록이다. 이 시험은 컴포넌트가 실제로 쓰는
// 클래스 문자열(`QuoteBlock.tsx`·`MessageRow.tsx` 소스에서 꺼낸다)을 `tokens.css` 컴파일 결과에 먹여, 줄을 가리키고·키보드로 서고·누르는 동안
// 카드의 계산된 배경과 줄의 합성 면을 읽는다. 정본 §2.2 두 자: 대비 ≥ 1.05 그리고 OKLab ≥ 0.02.
//
// 키보드 초점은 Chromium 에서만 잰다: 헤드리스 WebKit 은 프로그램이 준 초점을 `:focus-visible` 로 치지 않는다(`rowSurface.browser.test.ts` 와 같은 사정).
// =============================================================================

const ROW_SRC = readFileSync(new URL("./MessageRow.tsx", import.meta.url), "utf8");
const CARD_SRC = readFileSync(new URL("./QuoteBlock.tsx", import.meta.url), "utf8");
const ROW_CLASS = /"(group relative flex gap-2[^"]*row-hover[^"]*)"/.exec(ROW_SRC)?.[1] ?? "";
const CARD_CLASS = /<div className="([^"]*\bquote-card\b[^"]*)">/.exec(CARD_SRC)?.[1] ?? "";

const split = (cls: string) => cls.split(/\s+/).filter(Boolean);
const CANDIDATES = [
  ...split(ROW_CLASS),
  ...split(CARD_CLASS),
  "flex",
  "relative",
  "bg-pane",
  "bg-surface-muted",
  "bg-muted-soft",
  "bg-surface-pressed",
];

function html(css: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
body { margin: 0; padding: 40px; }
</style></head><body>
<div id="pane" class="bg-pane" style="padding:20px;width:640px">
  <div id="row" tabindex="0" class="flex relative ${ROW_CLASS}" style="height:120px;align-items:flex-start">
    <div id="card" class="${CARD_CLASS}" style="width:240px;height:60px;margin-top:8px">card</div>
  </div>
</div>
<div id="ref-muted" class="bg-surface-muted" style="height:8px"></div>
<div id="ref-soft" class="bg-muted-soft" style="height:8px"></div>
<div id="ref-pressed" class="bg-surface-pressed" style="height:8px"></div>
</body></html>`;
}

type Rgba = [number, number, number, number];

/** 엔진이 계산한 색 문자열(`rgb()`·`color(srgb …)`)을 [r,g,b](0–255)와 알파로. */
function parseColor(value: string): Rgba {
  const nums = (value.match(/-?\d*\.?\d+(?:e-?\d+)?%?/g) ?? []).map((n) =>
    n.endsWith("%") ? Number.parseFloat(n) / 100 : Number.parseFloat(n)
  );
  if (value.startsWith("color(")) return [nums[0] * 255, nums[1] * 255, nums[2] * 255, nums[3] ?? 1];
  return [nums[0], nums[1], nums[2], nums[3] ?? 1];
}
const hex = (c: readonly number[]) => `#${[0, 1, 2].map((i) => Math.round(c[i]).toString(16).padStart(2, "0")).join("")}`;
/** 알파가 있는 줄 면을 불투명한 바닥 위에 합성한다. */
const over = (top: Rgba, base: Rgba): string =>
  hex([0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3])));

interface State {
  row: string;
  card: string;
}

async function read(page: Page): Promise<State & { pane: string }> {
  await page.waitForTimeout(350); // 전이(--motion-instant 120ms)가 끝나도록
  return page.evaluate(() => {
    const bg = (id: string) => getComputedStyle(document.getElementById(id)!).backgroundColor;
    return { row: bg("row"), card: bg("card"), pane: bg("pane") };
  });
}

const survives = (card: string, row: string): boolean => contrast(card, row) >= 1.05 && oklabDistance(card, row) >= 0.02;

describe("인용 카드 그릇의 계산된 값 (#5421)", () => {
  it("컴포넌트 소스에서 줄·카드 클래스를 실제로 꺼냈다(빈 문자열이면 아래 단정이 헛돈다)", () => {
    expect(ROW_CLASS).toContain("row-hover");
    expect(CARD_CLASS).toContain("quote-card");
    expect(CARD_CLASS).toContain("rounded-lg");
  });

  it.skipIf(ENGINES.length === 0)(
    "쉬는 카드는 --surface-muted, 가리키거나 키보드로 서면 --muted-soft 이고 줄 면과 두 자를 넘으며, 누르면 쉬는 면으로 돌아온다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, colorScheme });
            try {
              const page = await ctx.newPage();
              await page.setContent(html(css));
              const at = `${engine} ${colorScheme}`;
              const refs = await page.evaluate(() => {
                const bg = (id: string) => getComputedStyle(document.getElementById(id)!).backgroundColor;
                return { muted: bg("ref-muted"), soft: bg("ref-soft"), pressed: bg("ref-pressed") };
              });
              const same = (label: string, actual: string, want: string) => {
                const a = hex(parseColor(actual));
                const w = hex(parseColor(want));
                if (a !== w) problems.push(`${at} ${label}: 카드 ${a}, 기대 ${w}`);
              };
              const box = (await page.locator("#row").boundingBox())!;
              const outsideCard = { x: box.x + box.width - 40, y: box.y + box.height - 20 };

              // 쉬는 모양.
              await page.mouse.move(2, 2);
              const rest = await read(page);
              same("쉼", rest.card, refs.muted);

              // 가리킴: 줄 면이 서고(알파 .5), 카드는 한 단 짙어진다.
              await page.mouse.move(outsideCard.x, outsideCard.y);
              const hover = await read(page);
              same("가리킴", hover.card, refs.soft);
              // 합성의 재료가 진짜인지부터: 바닥(`bg-pane`)이 불투명하고 줄 호버 면이 알파 .5 여야 아래 두 자가 의미를 갖는다(바닥이 안 칠해지면 합성이 어두워져 두 자가 거저 통과한다).
              if (parseColor(hover.pane)[3] !== 1) problems.push(`${at} 바닥(bg-pane)이 불투명하지 않다: ${hover.pane}`);
              if (Math.abs(parseColor(hover.row)[3] - 0.5) > 0.01) problems.push(`${at} 가리킴 줄 면 알파가 .5 가 아니다: ${hover.row}`);
              const hoverRow = over(parseColor(hover.row), parseColor(hover.pane));
              if (!survives(hex(parseColor(hover.card)), hoverRow)) {
                problems.push(
                  `${at} 가리킴: 카드 ${hex(parseColor(hover.card))} ↔ 줄 ${hoverRow} 대비 ${contrast(hex(parseColor(hover.card)), hoverRow).toFixed(3)} OKLab ${oklabDistance(hex(parseColor(hover.card)), hoverRow).toFixed(4)}`
                );
              }

              // 누름: 줄은 `--surface-pressed` 를 칠하고 카드는 쉬는 면으로 돌아온다(`:not(:active)`).
              await page.mouse.down();
              const pressed = await read(page);
              await page.mouse.up();
              same("눌림", pressed.card, refs.muted);
              same("눌림 줄", pressed.row, refs.pressed);

              // 키보드 초점(Chromium 만).
              if (engine === "chromium") {
                await page.mouse.move(2, 2);
                await page.waitForTimeout(300);
                await page.keyboard.press("Shift");
                await page.evaluate(() => document.getElementById("row")!.focus());
                const focus = await read(page);
                same("키보드 초점", focus.card, refs.soft);
                if (Math.abs(parseColor(focus.row)[3] - 0.5) > 0.01) problems.push(`${at} 키보드 초점 줄 면 알파가 .5 가 아니다: ${focus.row}`);
                const focusRow = over(parseColor(focus.row), parseColor(focus.pane));
                if (!survives(hex(parseColor(focus.card)), focusRow)) {
                  problems.push(`${at} 키보드 초점: 카드 ↔ 줄 ${focusRow} 두 자 미달`);
                }
              }
            } finally {
              await ctx.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    120_000
  );
});
