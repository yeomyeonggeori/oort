import { describe, expect, it } from "vitest";
import { DENSITY, DENSITY_IDS, type DensityId } from "@momo/core/design/density";
import { compileTokensCss, ENGINES } from "./compileTokensTestKit";

/**
 * 대화 밀도가 **브라우저가 계산한 값**으로 코어 표를 따른다 (AP-2a #4189, 이슈 AC 2).
 *
 * `densityTokens.test.ts`는 CSS의 문자열을 코어 `DENSITY`와 대조한다. 이 시험은 `tokens.css`를 Tailwind로 진짜
 * 컴파일해 WebKit·Chromium에 먹이고 `getComputedStyle`로 잰다: 같은 클래스가 단계(`data-density`)마다 코어가 말하는
 * 값이 되는지, 그리고 밀도를 **따르지 않아야 하는** 쌍둥이 `py-row-fixed`가 세 단계에서 6px로 서 있는지.
 *
 * 마지막 단정은 이름 충돌이다: Tailwind 내장 `max-w-prose`(65ch)를 새 간격 이름 `--spacing-prose`가 가로채지 않는다.
 */

const CLASSES = [
  "py-row",
  "pb-row",
  "pt-row-head",
  "size-message-avatar",
  "w-message-avatar",
  "gap-prose",
  "mt-list-item",
  "py-row-fixed",
  "pt-row-fixed",
] as const;

function pageHtml(css: string, tier: DensityId): string {
  const probes = CLASSES.map((cls) => `<div data-probe="${cls}" class="${cls}"></div>`).join("\n");
  return `<!doctype html><html lang="ko" data-density="${tier}"><head><style>${css}
[data-probe] { box-sizing: border-box; }
#gap-box { display: flex; flex-direction: column; }
</style></head><body>${probes}
<div id="gap-box" class="gap-prose"><span>a</span><span>b</span></div></body></html>`;
}

interface Measure {
  rowPaddingTop: number;
  rowPaddingBottom: number;
  rowHeadPaddingTop: number;
  avatarSize: [number, number];
  gutterWidth: number;
  proseGap: number;
  listItemMarginTop: number;
  fixedPaddingTop: number;
  fixedPaddingBottom: number;
  fixedHeadPaddingTop: number;
}

async function measure(page: import("playwright").Page): Promise<Measure> {
  return page.evaluate(() => {
    const px = (v: string) => Number.parseFloat(v);
    const el = (cls: string) => document.querySelector<HTMLElement>(`[data-probe="${cls}"]`)!;
    const style = (cls: string) => getComputedStyle(el(cls));
    const avatar = el("size-message-avatar").getBoundingClientRect();
    return {
      rowPaddingTop: px(style("py-row").paddingTop),
      rowPaddingBottom: px(style("pb-row").paddingBottom),
      rowHeadPaddingTop: px(style("pt-row-head").paddingTop),
      avatarSize: [avatar.width, avatar.height],
      gutterWidth: el("w-message-avatar").getBoundingClientRect().width,
      proseGap: px(getComputedStyle(document.getElementById("gap-box")!).rowGap),
      listItemMarginTop: px(style("mt-list-item").marginTop),
      fixedPaddingTop: px(style("py-row-fixed").paddingTop),
      fixedPaddingBottom: px(style("py-row-fixed").paddingBottom),
      fixedHeadPaddingTop: px(style("pt-row-fixed").paddingTop),
    };
  }) as Promise<Measure>;
}

describe("대화 밀도의 계산된 값 (AC 2)", () => {
  it.skipIf(ENGINES.length === 0)(
    "같은 클래스가 단계마다 코어 표의 값이 되고, 밀도를 따르지 않는 쌍둥이는 세 단계 모두 6px이다",
    async () => {
      const css = await compileTokensCss([...CLASSES, "gap-prose"]);
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
          try {
            const page = await ctx.newPage();
            for (const tier of DENSITY_IDS) {
              await page.setContent(pageHtml(css, tier));
              const m = await measure(page);
              const v = DENSITY[tier];
              const check = (label: string, actual: number, want: number) => {
                if (Math.abs(actual - want) > 0.01) problems.push(`${engine} ${tier} ${label}: ${actual}px, 코어 ${want}px`);
              };
              // 행 사이 거리는 위 행의 아래 패딩 + 아래 행의 위 패딩(둘 다 --spacing-row)이다.
              check("py-row 위", m.rowPaddingTop, v.messageGap / 2);
              check("pb-row 아래", m.rowPaddingBottom, v.messageGap / 2);
              // 묶음 사이 = 위 행 아래 패딩(row) + 머리 행 위 패딩(row-head).
              check("pb-row + pt-row-head", m.rowPaddingBottom + m.rowHeadPaddingTop, v.messageGroupGap);
              check("size-message-avatar 너비", m.avatarSize[0], v.messageAvatar);
              check("size-message-avatar 높이", m.avatarSize[1], v.messageAvatar);
              check("w-message-avatar", m.gutterWidth, v.messageAvatar);
              check("gap-prose", m.proseGap, v.proseGap);
              check("mt-list-item", m.listItemMarginTop, v.listItemGap);
              // 밀도를 따르지 않는 쌍둥이: 채널 머리·명령 목록이 읽는 6px.
              check("py-row-fixed 위", m.fixedPaddingTop, 6);
              check("py-row-fixed 아래", m.fixedPaddingBottom, 6);
              check("pt-row-fixed", m.fixedHeadPaddingTop, 6);
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    60_000
  );

  it("Tailwind 내장 max-w-prose(65ch)를 새 간격 이름 --spacing-prose가 가로채지 않는다", async () => {
    const css = await compileTokensCss(["max-w-prose", "gap-prose"]);
    expect(css).toMatch(/\.max-w-prose\s*\{\s*max-width:\s*65ch;?\s*\}/);
    expect(css).not.toMatch(/\.max-w-prose\s*\{[^}]*var\(--spacing-prose\)/);
    // 대조: 같은 컴파일에서 gap-prose는 밀도 변수를 읽는다(점검이 아무것도 안 재는 상태가 아니다).
    expect(css).toMatch(/\.gap-prose\s*\{[^}]*var\(--spacing-prose\)/);
  });
});
