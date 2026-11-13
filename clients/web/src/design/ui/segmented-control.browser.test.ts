// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Moon, Sun } from "lucide-react";
import { describe, expect, it } from "vitest";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { SegmentedControl } from "./segmented-control";

// =============================================================================
// 세그먼트 컨트롤의 라디오가 칸 전체를 투명하게 덮는다 (`radio-cover`, #5783 구조 수리). 이 부품은 설정·표현 화면 열세 곳이 같이 쓰므로,
// 바꾼 것(라디오의 상자)이 모양과 포인터를 건드리지 않았고, 바꾼 까닭(초점 따라가기)이 실제 엔진에서 일한다는 것을 부품 단위로 잰다.
// jsdom은 배치를 못 재므로 컴포넌트가 그린 진짜 마크업을 `tokens.css` 컴파일 결과와 함께 설치된 엔진(WebKit = WKWebView의 엔진,
// Chromium)에 올린다.
//
// 지키는 것:
//   (1) 모양 그대로: 수리 전 판(라벨 static + `sr-only` 라디오)과 같은 엔진·같은 상태(쉼 · 가리킴 · 눌림 · 키보드 초점 · 비활성,
//       라이트 · 다크)에서 찍은 픽셀이 같고, 칸의 자리·크기도 같다. 라디오의 상자는 칸과 같다.
//   (2) 포인터는 전처럼 라벨이 받는다: 칸 가운데에서 맞는 요소가 라디오가 아니라 라벨(또는 그 안)이고, 누르면 그 칸이 골라진다.
//   (3) 초점 따라가기: 스크롤 상자 아래 밖에 있는 세그먼트에 Tab으로 닿으면 상자가 움직여 고른 칸이 온전히 보이고, Shift+Tab으로
//       앞 단추에 갔다가 다시 Tab으로 와도 그렇다(설정 › 모양 검수 r3 B-1c의 부품 판).
// 사보타주: `radio-cover`의 라디오를 `sr-only` 기하로 바꾸면 (3)이 붉고, `pointer-events: none`을 걷으면 (2)가 붉고, 라벨의
// `position: relative`를 걷으면 (1)의 상자 단정과 (3)이 붉다.
// =============================================================================

const OPTIONS = [
  { value: "light", label: "라이트", Icon: Sun },
  { value: "dark", label: "다크", Icon: Moon },
  { value: "system", label: "시스템" },
] as const;

function markupOf(disabled: boolean): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() =>
    root.render(
      createElement(SegmentedControl<"light" | "dark" | "system">, {
        legend: "색 모드",
        options: OPTIONS,
        value: "dark",
        onValueChange: () => undefined,
        disabled,
        name: "seg",
        testId: "seg",
      })
    )
  );
  // React는 제어되는 라디오의 `checked`를 속성이 아니라 프로퍼티로 둔다: 옮겨 싣는 마크업에는 속성으로 적는다.
  host.querySelector('[data-testid="seg-dark"]')?.setAttribute("checked", "");
  const html = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return html;
}

/** 수리 전 판: 라벨에서 `radio-cover`를 빼고 라디오에 `sr-only`를 단다. */
function legacyOf(html: string): string {
  const out = html.replaceAll("radio-cover ", "").replaceAll('<input type="radio"', '<input class="sr-only" type="radio"');
  if (out === html || out.includes("radio-cover")) throw new Error("수리 전 판을 만들지 못했다: 마크업 모양이 바뀌었다");
  return out;
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

function page(css: string, body: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#host { width: 360px; padding: 16px; }
#scroller { height: 120px; overflow-y: auto; }
.spacer { height: 400px; }
</style></head><body class="bg-canvas text-ink">${body}</body></html>`;
}

describe("세그먼트 컨트롤의 라디오가 칸을 덮는다 (#5783 구조 수리)", () => {
  it.skipIf(ENGINES.length === 0)(
    "모양·자리가 수리 전과 같고, 포인터는 라벨이 받고, Tab으로 닿으면 스크롤 상자가 그 칸으로 따라간다",
    async () => {
      const enabled = markupOf(false);
      const disabled = markupOf(true);
      expect(enabled).toContain("radio-cover");
      expect(enabled).toContain("checked");
      const variants = { cover: { enabled, disabled }, legacy: { enabled: legacyOf(enabled), disabled: legacyOf(disabled) } };
      const css = await compileTokensCss(["bg-canvas", "text-ink", "sr-only", ...classesOf(enabled), ...classesOf(disabled)]);
      const playwright = await import("playwright");
      const problems: string[] = [];
      let compared = 0;

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({ viewport: { width: 420, height: 400 }, colorScheme, reducedMotion: "reduce" });
            try {
              const p = await ctx.newPage();
              const at = `${engine} ${colorScheme}`;
              // macOS WebKit(사파리·WKWebView)은 「모든 컨트롤로 키보드 이동」이 꺼진 기본값에서 Tab이 단추·라디오를 건너뛴다. Option+Tab이
              // 그 설정을 켠 사람의 Tab과 같은 길이다.
              const tab = engine === "webkit" ? "Alt+Tab" : "Tab";
              const backTab = engine === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";

              // (1) 같은 상태에서 두 판의 픽셀과 칸의 상자.
              const shots = async (html: string, focusable: boolean) => {
                await p.setContent(page(css, `<button id="before" type="button">앞</button><div id="host">${html}</div>`));
                const host = p.locator("#host");
                const label = (value: string) => p.locator(`label:has([data-testid="seg-${value}"])`);
                const boxes = await p.evaluate(() =>
                  [...document.querySelectorAll("#host label")].map((l) => {
                    const r = l.getBoundingClientRect();
                    const i = l.querySelector("input")!.getBoundingClientRect();
                    return { label: [r.x, r.y, r.width, r.height], input: [i.x, i.y, i.width, i.height] };
                  })
                );
                const rest = await host.screenshot({ animations: "disabled" });
                const lightBox = (await label("light").boundingBox())!;
                await p.mouse.move(lightBox.x + lightBox.width / 2, lightBox.y + lightBox.height / 2);
                const hover = await host.screenshot({ animations: "disabled" });
                await p.mouse.down();
                const pressed = await host.screenshot({ animations: "disabled" });
                await p.mouse.up();
                await p.mouse.move(0, 399);
                await p.setContent(page(css, `<button id="before" type="button">앞</button><div id="host">${html}</div>`));
                await p.locator("#before").focus();
                await p.keyboard.press(tab);
                if (focusable && !(await p.evaluate(() => document.activeElement?.matches(":focus-visible") && document.activeElement.tagName === "INPUT"))) {
                  problems.push(`${at}: 키보드 초점이 라디오에 닿지 않았다(초점 장면이 빈 비교가 된다)`);
                }
                const focus = await p.locator("#host").screenshot({ animations: "disabled" });
                return { boxes, rest, hover, pressed, focus };
              };
              for (const kind of ["enabled", "disabled"] as const) {
                const a = await shots(variants.cover[kind], kind === "enabled");
                const b = await shots(variants.legacy[kind], kind === "enabled");
                for (const state of ["rest", "hover", "pressed", "focus"] as const) {
                  if (kind === "disabled" && state === "focus") continue; // 비활성 묶음에는 초점이 가지 않는다
                  compared += 1;
                  if (!a[state].equals(b[state])) problems.push(`${at} ${kind} ${state}: 수리 전과 픽셀이 다르다`);
                }
                a.boxes.forEach((box, n) => {
                  const old = b.boxes[n]!;
                  if (box.label.some((v, k) => Math.abs(v - old.label[k]!) > 0.01)) problems.push(`${at} ${kind} 칸 ${n}: 자리·크기가 수리 전과 다르다 ${JSON.stringify(box.label)} ≠ ${JSON.stringify(old.label)}`);
                  if (box.input.some((v, k) => Math.abs(v - box.label[k]!) > 0.01)) problems.push(`${at} ${kind} 칸 ${n}: 라디오 상자 ${JSON.stringify(box.input)}가 칸 ${JSON.stringify(box.label)}과 다르다`);
                });
              }

              // (2) 포인터: 칸 가운데에서 맞는 요소는 라벨(또는 그 안)이고 라디오가 아니다. 누르면 그 칸이 골라진다.
              await p.setContent(page(css, `<div id="host">${variants.cover.enabled}</div>`));
              const hit = await p.evaluate(() =>
                [...document.querySelectorAll("#host label")].map((l) => {
                  const r = l.getBoundingClientRect();
                  const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                  return { tag: el?.tagName ?? null, inLabel: el !== null && l.contains(el) };
                })
              );
              hit.forEach((h, n) => {
                if (h.tag === "INPUT" || !h.inLabel) problems.push(`${at} 칸 ${n}: 가운데에서 맞는 요소가 ${h.tag}(라벨 안 ${h.inLabel})`);
              });
              await p.locator('label:has([data-testid="seg-system"])').click();
              if (!(await p.getByTestId("seg-system").isChecked())) problems.push(`${at} 라벨을 눌렀는데 「시스템」이 골라지지 않았다`);

              // (3) 초점 따라가기: 스크롤 상자(높이 120) 아래 밖의 세그먼트에 Tab으로 닿는다.
              const follow = async () => {
                const seen = await p.evaluate(() => {
                  const box = document.getElementById("scroller")!.getBoundingClientRect();
                  const label = document.activeElement?.closest("label");
                  const r = label?.getBoundingClientRect();
                  return {
                    focused: (document.activeElement as HTMLInputElement | null)?.value ?? null,
                    scrollTop: document.getElementById("scroller")!.scrollTop,
                    full: r !== undefined && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
                  };
                });
                return seen;
              };
              await p.setContent(page(css, `<button id="before" type="button">앞</button><div id="scroller"><div class="spacer"></div>${variants.cover.enabled}<div class="spacer"></div></div>`));
              await p.locator("#before").focus();
              await p.keyboard.press(tab);
              const first = await follow();
              if (first.focused !== "dark" || !first.full) problems.push(`${at} Tab으로 닿은 칸이 스크롤 상자 안에 온전하지 않다 ${JSON.stringify(first)}`);
              await p.evaluate(() => { document.getElementById("scroller")!.scrollTop = 0; });
              await p.keyboard.press(backTab);
              await p.keyboard.press(tab);
              const again = await follow();
              if (again.focused !== "dark" || !again.full) problems.push(`${at} 상자를 위로 올린 뒤 Shift+Tab → Tab으로 다시 닿은 칸이 온전하지 않다 ${JSON.stringify(again)}`);
            } finally {
              await ctx.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
      expect(compared).toBe(ENGINES.length * 2 * 7);
    },
    120_000
  );
});
