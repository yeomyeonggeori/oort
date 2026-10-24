import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  compileTokensCss,
  ENGINES,
} from "@/design/appearance/compileTokensTestKit";
import { readFileSync } from "node:fs";
import { TOOLTIP_CLASS, TOOLTIP_SIDE_CLASS } from "@/design/ui/tooltip";
import { TOOLTIP_MOTION } from "@/design/motion";
import {
  TOOLBAR_CLASS,
  toolbarDividerClass,
  toolbarItemClass,
  toolbarReactionClass,
} from "./MessageActions";

/** 줄 클래스는 컴포넌트의 JSX 문자열 그대로다(눌림 원장이 같은 문자열을 읽는다). 소스에서 꺼내 엔진에 먹인다. */
const ROW_SRC = readFileSync(new URL("./MessageRow.tsx", import.meta.url), "utf8");
const FEED_SRC = readFileSync(new URL("../inbox/FeedRow.tsx", import.meta.url), "utf8");
const MESSAGE_ROW_SURFACE_CLASS = /"(group relative flex gap-2[^"]*row-hover[^"]*)"/.exec(ROW_SRC)?.[1] ?? "";
const FEED_ROW_SURFACE_CLASS = /"(flex gap-3 py-2[^"]*row-hover[^"]*)"/.exec(FEED_SRC)?.[1] ?? "";
const TOOLBAR_BUTTON_CLASS = toolbarItemClass;
const TOOLBAR_REACTION_CLASS = toolbarReactionClass;
const TOOLBAR_DIVIDER_CLASS = toolbarDividerClass;
const TOOLBAR_ICON_CLASS = "size-4";

/**
 * 메시지 줄·줄 도구 막대·툴팁이 **엔진이 계산한 값**으로 계약을 지킨다 (#4324).
 *
 * 컴포넌트가 쓰는 클래스 상수를 그대로 `tokens.css` 컴파일 결과에 먹여 반경·크기·여백·불투명도를 잰다.
 * 스냅샷이 아니라 숫자다: 반경 14·바깥 4·안쪽 12(줄), 32px 원 단추·아이콘 16·반응 글리프 20·막대 안쪽 4·단추 사이 2·
 * 구분선 1×16(막대), 여백 12×6·반경 10·글자 12(툴팁), 호버 면 알파 0.5, 막대 테두리 알파 0.7.
 */

const split = (cls: string) => cls.split(/\s+/).filter(Boolean);
const CANDIDATES = [
  ...split(MESSAGE_ROW_SURFACE_CLASS),
  ...split(FEED_ROW_SURFACE_CLASS),
  ...split(TOOLBAR_CLASS),
  ...split(TOOLBAR_BUTTON_CLASS),
  ...split(TOOLBAR_REACTION_CLASS),
  ...split(TOOLBAR_DIVIDER_CLASS),
  ...split(TOOLBAR_ICON_CLASS),
  ...split(TOOLTIP_CLASS),
  ...split(TOOLTIP_SIDE_CLASS.top),
  ...split(TOOLTIP_SIDE_CLASS.bottom),
  ...split(TOOLTIP_MOTION),
  "flex",
  "bg-surface-hover",
  "bg-warn-soft",
  "landed-surface",
  "bg-surface-pressed",
  "bg-line",
  "relative",
];

function html(css: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
body { margin: 0; padding: 120px 40px; }
[data-probe] { box-sizing: border-box; }
</style></head><body>
<div id="row" tabindex="0" class="flex relative ${MESSAGE_ROW_SURFACE_CLASS}" style="height:48px">row</div>
<div id="landed" class="flex relative ${MESSAGE_ROW_SURFACE_CLASS} landed-surface" style="height:48px;margin-top:8px">landed</div>
<div id="warn-ref" class="bg-warn-soft" style="height:8px"></div>
<div id="hover-ref" class="bg-surface-hover" style="height:8px"></div>
<div id="pressed-ref" class="bg-surface-pressed" style="height:8px"></div>
<div id="line-ref" class="bg-line" style="height:8px"></div>
<div style="position:relative;height:160px">
  <div id="bar" class="${TOOLBAR_CLASS}" style="top:60px">
    <button id="react" class="${TOOLBAR_REACTION_CLASS}"><span>👍</span></button>
    <div id="divider" class="${TOOLBAR_DIVIDER_CLASS}"></div>
    <button id="more" class="${TOOLBAR_BUTTON_CLASS}"><svg id="icon" class="${TOOLBAR_ICON_CLASS}" viewBox="0 0 16 16"></svg></button>
  </div>
</div>
<div style="position:relative;margin:80px;width:100px">
  <span id="tip-top" data-side="top" class="${TOOLTIP_CLASS} ${TOOLTIP_SIDE_CLASS.top} ${TOOLTIP_MOTION}">답글 달기</span>
  <span id="tip-bottom" data-side="bottom" class="${TOOLTIP_CLASS} ${TOOLTIP_SIDE_CLASS.bottom} ${TOOLTIP_MOTION}">답글 달기</span>
</div>
</body></html>`;
}

/** 엔진이 계산한 색 문자열(함수 꼴 둘)을 [r,g,b,a](0–1)로. */
function parseColor(value: string): [number, number, number, number] {
  const nums = (value.match(/-?\d*\.?\d+(?:e-?\d+)?%?/g) ?? []).map((n) =>
    n.endsWith("%") ? Number.parseFloat(n) / 100 : Number.parseFloat(n)
  );
  if (value.startsWith("color(")) {
    return [nums[0], nums[1], nums[2], nums[3] ?? 1];
  }
  return [nums[0] / 255, nums[1] / 255, nums[2] / 255, nums[3] ?? 1];
}

interface Snap {
  rowRest: string;
  rowHover: string;
  rowFocus: string;
  rowPressed: string;
  landedRest: string;
  landedHover: string;
  landedShadow: string;
  landedBox: { h: number };
  warnRef: string;
  hoverRef: string;
  pressedRef: string;
  lineRef: string;
  row: Record<string, string>;
  bar: Record<string, string>;
  barBox: { h: number };
  react: { w: number; h: number; radius: string; fontSize: string };
  more: { w: number; h: number; radius: string; color: string };
  icon: { w: number; h: number };
  divider: { w: number; h: number };
  tips: Record<string, Record<string, string>>;
}

async function snap(page: Page): Promise<Snap> {
  const bg = () =>
    page.evaluate(
      () => getComputedStyle(document.getElementById("row")!).backgroundColor
    );
  const rowRest = await bg();
  await page.mouse.move(100, 140); // 줄 위
  await page.waitForTimeout(300); // 전이(--motion-instant 120ms)가 끝나도록
  const rowHover = await bg();
  await page.mouse.down();
  await page.waitForTimeout(300);
  const rowPressed = await bg();
  await page.mouse.up();
  await page.mouse.move(700, 580);
  await page.waitForTimeout(300);
  // 키보드 양식으로 초점을 준다(:focus-visible). WebKit은 Tab이 링크·폼만 돈다(Safari 설정)고 줄에 안 닿으므로
  // 키 입력 뒤 같은 요소에 focus()를 주는 길로 통일한다 — 마지막 입력이 키보드면 두 엔진 모두 :focus-visible이다.
  await page.keyboard.press("Shift");
  await page.evaluate(() => document.getElementById("row")!.focus());
  await page.waitForTimeout(300);
  const rowFocus = await bg();
  // 착지 줄: 가만히 있을 때와, 가리켰을 때(줄 호버 면이 덮지 못해야 한다).
  const landedBg = () =>
    page.evaluate(() => getComputedStyle(document.getElementById("landed")!).backgroundColor);
  const landedRest = await landedBg();
  const landedBox = await page.evaluate(() => ({ h: document.getElementById("landed")!.getBoundingClientRect().height }));
  const landedShadow = await page.evaluate(() => getComputedStyle(document.getElementById("landed")!).boxShadow);
  const lb = await page.evaluate(() => {
    const r = document.getElementById("landed")!.getBoundingClientRect();
    return { x: r.x + 100, y: r.y + r.height / 2 };
  });
  await page.mouse.move(lb.x, lb.y);
  await page.waitForTimeout(300);
  const landedHover = await landedBg();
  await page.mouse.move(700, 580);
  await page.waitForTimeout(100);
  const rest = await page.evaluate(() => {
    const g = (id: string) => getComputedStyle(document.getElementById(id)!);
    const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const pick = (id: string, props: string[]) =>
      Object.fromEntries(props.map((p) => [p, g(id).getPropertyValue(p)]));
    return {
      warnRef: g("warn-ref").backgroundColor,
      hoverRef: g("hover-ref").backgroundColor,
      pressedRef: g("pressed-ref").backgroundColor,
      lineRef: g("line-ref").backgroundColor,
      row: pick("row", [
        "margin-left",
        "margin-right",
        "padding-left",
        "padding-right",
        "border-top-left-radius",
        "transition-property",
      ]),
      bar: pick("bar", [
        "border-top-left-radius",
        "border-top-width",
        "border-top-color",
        "padding-top",
        "padding-left",
        "column-gap",
        "background-color",
        "backdrop-filter",
        "box-shadow",
        "animation-name",
        "right",
      ]),
      barBox: { h: r("bar").height },
      react: {
        w: r("react").width,
        h: r("react").height,
        radius: g("react").borderTopLeftRadius,
        fontSize: g("react").fontSize,
      },
      more: {
        w: r("more").width,
        h: r("more").height,
        radius: g("more").borderTopLeftRadius,
        color: g("more").color,
      },
      icon: { w: r("icon").width, h: r("icon").height },
      divider: { w: r("divider").width, h: r("divider").height },
      tips: Object.fromEntries(
        ["tip-top", "tip-bottom"].map((id) => [
          id,
          {
            ...pick(id, [
              "padding-top",
              "padding-bottom",
              "padding-left",
              "padding-right",
              "border-top-left-radius",
              "font-size",
              "animation-name",
              "animation-duration",
              "--tooltip-dy",
            ]),
            gap: String(
              id === "tip-top"
                ? r("tip-top").bottom
                : r("tip-bottom").top
            ),
          },
        ])
      ),
    };
  });
  return { ...rest, rowRest, rowHover, rowFocus, rowPressed, landedRest, landedHover, landedShadow, landedBox } as Snap;
}

/** `2px`와 `calc(2px * -1)` 둘 다 읽는다(미등록 사용자 속성은 쓰인 식 그대로 돌아온다). */
const px = (v: string) => {
  const calc = /^calc\(\s*(-?[\d.]+)px\s*\*\s*(-?[\d.]+)\s*\)$/.exec(v.trim());
  return calc ? Number.parseFloat(calc[1]) * Number.parseFloat(calc[2]) : Number.parseFloat(v);
};

describe("줄·도구 막대·툴팁의 계산된 값 (#4324)", () => {
  it.skipIf(ENGINES.length === 0)(
    "줄 14·4·12, 호버 알파 .5, 막대 알약·32 단추·20 이모지·16 아이콘·툴팁 12×6·반경 10",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      const eq = (label: string, actual: number, want: number, tol = 0.51) => {
        if (!(Math.abs(actual - want) <= tol)) {
          problems.push(`${label}: ${actual}, 기대 ${want}`);
        }
      };

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({
              viewport: { width: 800, height: 600 },
              colorScheme,
            });
            try {
              const page = await ctx.newPage();
              await page.setContent(html(css));
              const m = await snap(page);
              const at = `${engine} ${colorScheme}`;

              // 줄
              eq(`${at} 줄 바깥 왼쪽`, px(m.row["margin-left"]), 4);
              eq(`${at} 줄 바깥 오른쪽`, px(m.row["margin-right"]), 4);
              eq(`${at} 줄 안쪽 왼쪽`, px(m.row["padding-left"]), 12);
              eq(`${at} 줄 안쪽 오른쪽`, px(m.row["padding-right"]), 12);
              eq(`${at} 줄 반경`, px(m.row["border-top-left-radius"]), 14);
              if (m.row["transition-property"] !== "background-color") {
                problems.push(
                  `${at} 줄 전이 ${m.row["transition-property"]}`
                );
              }
              const hoverRef = parseColor(m.hoverRef);
              const pressedRef = parseColor(m.pressedRef);
              eq(`${at} 평소 줄 알파`, parseColor(m.rowRest)[3], 0, 0.001);
              // 키보드 초점 줄은 Chromium에서만 잰다: 헤드리스 WebKit은 프로그램이 준 초점을 `:focus-visible`로
              // 치지 않는다(키 입력 뒤에도). WebKit의 키보드 길은 실기기 캡처 몫이라 미검증으로 남긴다.
              for (const [name, value] of [
                ["호버", m.rowHover],
                ...(engine === "chromium" ? ([["키보드 초점", m.rowFocus]] as const) : []),
              ] as const) {
                const c = parseColor(value);
                eq(`${at} ${name} 알파`, c[3], 0.5, 0.01);
                // 색은 --surface-hover 그대로, 섞이는 것은 불투명도뿐이다.
                for (let i = 0; i < 3; i++) {
                  eq(`${at} ${name} 채널${i}`, c[i], hoverRef[i], 0.01);
                }
              }
              const pressed = parseColor(m.rowPressed);
              eq(`${at} 눌림 알파`, pressed[3], 1, 0.01);
              for (let i = 0; i < 3; i++) {
                eq(`${at} 눌림 채널${i}`, pressed[i], pressedRef[i], 0.01);
              }

              // 착지 줄: 바탕은 --warn-soft 불투명 그대로, 가리켜도 줄 호버 면이 덮지 못하고, 1px 안쪽 테두리(크기 불변)
              const warn = parseColor(m.warnRef);
              for (const [name, value] of [["가만", m.landedRest], ["호버", m.landedHover]] as const) {
                const c = parseColor(value);
                eq(`${at} 착지 ${name} 알파`, c[3], 1, 0.01);
                for (let i = 0; i < 3; i++) eq(`${at} 착지 ${name} 채널${i}`, c[i], warn[i], 0.01);
              }
              if (!/inset/.test(m.landedShadow) || !/\b1px\b/.test(m.landedShadow)) {
                problems.push(`${at} 착지 테두리(안쪽 1px 그림자) 아님: ${m.landedShadow}`);
              }
              eq(`${at} 착지 줄 높이(테두리가 크기를 안 민다)`, m.landedBox.h, 48);

              // 막대
              eq(
                `${at} 막대 반경(알약: 키의 절반 이상)`,
                Math.min(px(m.bar["border-top-left-radius"]), m.barBox.h / 2),
                m.barBox.h / 2
              );
              if (px(m.bar["border-top-left-radius"]) < m.barBox.h / 2) {
                problems.push(`${at} 막대가 알약이 아님`);
              }
              eq(`${at} 막대 테두리 두께`, px(m.bar["border-top-width"]), 1);
              eq(`${at} 막대 안쪽 위`, px(m.bar["padding-top"]), 4);
              eq(`${at} 막대 안쪽 왼쪽`, px(m.bar["padding-left"]), 4);
              eq(`${at} 막대 단추 사이`, px(m.bar["column-gap"]), 2);
              eq(`${at} 막대 높이 = 32 + 8 + 2`, m.barBox.h, 42);
              eq(`${at} 막대 오른쪽`, px(m.bar.right), 12);
              const border = parseColor(m.bar["border-top-color"]);
              const line = parseColor(m.lineRef);
              eq(`${at} 막대 테두리 알파 = --line 의 70%`, border[3], 0.7 * line[3], 0.01);
              if (m.bar["box-shadow"] === "none") {
                problems.push(`${at} 막대 그림자 없음`);
              }
              const barBg = parseColor(m.bar["background-color"]);
              const blurred = /blur\(4px\)/.test(m.bar["backdrop-filter"]);
              eq(`${at} 막대 면 알파`, barBg[3], blurred ? 0.85 : 0.95, 0.01);
              if (m.bar["animation-name"] !== "motion-fade-in") {
                problems.push(`${at} 막대 나타남 ${m.bar["animation-name"]}`);
              }

              // 단추
              eq(`${at} 반응 단추 너비`, m.react.w, 32);
              eq(`${at} 반응 단추 높이`, m.react.h, 32);
              eq(`${at} 반응 글리프`, px(m.react.fontSize), 20);
              eq(`${at} 단추 너비`, m.more.w, 32);
              eq(`${at} 단추 높이`, m.more.h, 32);
              if (px(m.more.radius) < 16 || px(m.react.radius) < 16) {
                problems.push(`${at} 단추가 원이 아님 ${m.more.radius}`);
              }
              eq(`${at} 아이콘`, m.icon.w, 16);
              eq(`${at} 아이콘 높이`, m.icon.h, 16);
              eq(`${at} 구분선 너비`, m.divider.w, 1);
              eq(`${at} 구분선 높이`, m.divider.h, 16);

              // 툴팁
              for (const id of ["tip-top", "tip-bottom"] as const) {
                const t = m.tips[id];
                eq(`${at} ${id} 위`, px(t["padding-top"]), 6);
                eq(`${at} ${id} 아래`, px(t["padding-bottom"]), 6);
                eq(`${at} ${id} 왼쪽`, px(t["padding-left"]), 12);
                eq(`${at} ${id} 오른쪽`, px(t["padding-right"]), 12);
                eq(`${at} ${id} 반경`, px(t["border-top-left-radius"]), 10);
                eq(`${at} ${id} 글자`, px(t["font-size"]), 12);
                if (t["animation-name"] !== "motion-tooltip-in") {
                  problems.push(`${at} ${id} 모션 ${t["animation-name"]}`);
                }
              }
              eq(`${at} 툴팁(위) 이동 2px`, px(m.tips["tip-top"]["--tooltip-dy"]), 2, 0);
              eq(`${at} 툴팁(아래) 이동 -2px`, px(m.tips["tip-bottom"]["--tooltip-dy"]), -2, 0);

              // 동작 줄이기: 막대와 툴팁은 애니메이션 없이 즉시 선다.
              await page.emulateMedia({ reducedMotion: "reduce", colorScheme });
              const still = await page.evaluate(() => ({
                bar: getComputedStyle(document.getElementById("bar")!).animationName,
                tip: getComputedStyle(document.getElementById("tip-top")!).animationName,
              }));
              if (still.bar !== "none") problems.push(`${at} 정지인데 막대 애니메이션 ${still.bar}`);
              if (still.tip !== "none") problems.push(`${at} 정지인데 툴팁 애니메이션 ${still.tip}`);
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

  it("컴포넌트 소스에서 줄 클래스를 실제로 꺼냈다(빈 문자열이면 위 단정이 헛돈다)", () => {
    expect(MESSAGE_ROW_SURFACE_CLASS).toContain("row-hover");
    expect(FEED_ROW_SURFACE_CLASS).toContain("row-hover");
  });
});
