import { describe, expect, it } from "vitest";
import { compileTokensCss, ENGINES } from "./compileTokensTestKit";

/**
 * 글자 크기 세 단계가 **브라우저가 계산한 글자 크기**로 14 / 15 / 16px다 (AP-2a #4189, 이슈 AC 1).
 *
 * 문자열 시험(`typographyScale.test.ts`)은 CSS에 식이 있다는 것만 말한다. 이 시험은 `tokens.css`를 Tailwind
 * 컴파일러로 진짜 컴파일해 WebKit·Chromium에 먹이고 `getComputedStyle`로 잰다. 잰 것:
 *
 *   - 메시지 본문(`text-body`)이 작게 14 · 기본 15 · 크게 16px(±0.1).
 *   - 여덟 역할 전부가 기본 크기 × 배율이다(「다른 텍스트 역할도 비례」). 줄 높이도 같은 비율이다.
 *   - 브라우저 확대와 직교한다: 사용자가 루트 글자를 16 → 20px로 키우면(브라우저 기본 글자 크기·웹뷰의
 *     rem 확대) 세 단계 모두 같은 1.25배로 따라가고 단계 사이의 비율은 그대로다. CSS px는 브라우저 확대에
 *     영향을 받지 않으므로 이 길이 「확대 위에 얹힌다」의 실체다.
 *   - 틀(rem으로 쓴 레이아웃 폭)은 단계가 바뀌어도 움직이지 않는다: 글자만 커지고 틀은 그대로다.
 *   - 속성이 없거나 모르는 값이면 기본이다.
 *
 * 입력 칸의 16px 바닥이 세 단계에서 지켜지는지는 `fieldTextFloor.browser.test.ts`가 잰다.
 */

const ROLES = ["timestamp", "meta", "code", "label", "body", "heading", "title", "display"] as const;
type Role = (typeof ROLES)[number];

/** 「기본」 단계의 역할별 px(디자인 시스템 §2.5). 본문 15는 2026-10-13 owner 결정이다. */
const DEFAULT_PX: Record<Role, number> = {
  timestamp: 11,
  meta: 12,
  code: 13,
  label: 14,
  body: 15,
  heading: 16,
  title: 17,
  display: 22,
};

const STEPS = [
  { step: "smaller", scale: 14 / 15, bodyPx: 14 },
  { step: "default", scale: 1, bodyPx: 15 },
  { step: "larger", scale: 16 / 15, bodyPx: 16 },
] as const;

/**
 * `rootPx`는 사용자가 브라우저의 기본 글자 크기를 키운 상황이다(루트 글자). 런타임에 `element.style`을
 * 쓰지 않고(`designSystem.test.ts`의 잔량 목록이 늘지 않게) 문서의 `<style>`에 담아 둔다.
 */
function pageHtml(css: string, step: string | null, rootPx?: number): string {
  const rows = ROLES.map((role) => `<p data-role="${role}" class="text-${role}">가나다 Abc</p>`).join("\n");
  const attr = step === null ? "" : ` data-font-size="${step}"`;
  const root = rootPx === undefined ? "" : `html { font-size: ${rootPx}px; }`;
  return `<!doctype html><html lang="ko"${attr}><head><style>${css}\n${root}\n#layout { width: 10rem; height: 5rem; }</style></head><body>${rows}
<div id="layout"></div></body></html>`;
}

interface Measure {
  size: Record<Role, number>;
  line: Record<Role, number>;
  layoutWidth: number;
}

async function measure(page: import("playwright").Page): Promise<Measure> {
  return page.evaluate((roles) => {
    const size = {} as Record<string, number>;
    const line = {} as Record<string, number>;
    for (const role of roles) {
      const el = document.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
      const style = getComputedStyle(el);
      size[role] = Number.parseFloat(style.fontSize);
      line[role] = Number.parseFloat(style.lineHeight);
    }
    const layoutWidth = document.getElementById("layout")!.getBoundingClientRect().width;
    return { size, line, layoutWidth };
  }, ROLES) as Promise<Measure>;
}

describe("글자 크기 세 단계의 계산된 크기 (AC 1)", () => {
  it.skipIf(ENGINES.length === 0)(
    "본문이 14 / 15 / 16px이고, 여덟 역할이 같은 비율로 따라가며, 브라우저 확대 위에 얹히고, 틀은 움직이지 않는다",
    async () => {
      const css = await compileTokensCss(ROLES.map((role) => `text-${role}`));
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
          try {
            const page = await ctx.newPage();
            const at = async (step: string | null, rootPx?: number) => {
              await page.setContent(pageHtml(css, step, rootPx));
              return measure(page);
            };

            const base = await at("default");
            // 기본 단계가 디자인 시스템의 역할 표와 같다(배율이 1일 때 식이 원래 rem 값으로 돌아간다).
            for (const role of ROLES) {
              if (Math.abs(base.size[role] - DEFAULT_PX[role]) > 0.05) {
                problems.push(`${engine} 기본 ${role}: ${base.size[role]}px, 기대 ${DEFAULT_PX[role]}px`);
              }
            }

            for (const { step, scale, bodyPx } of STEPS) {
              const m = await at(step);
              // AC 1: 메시지 본문 computed font-size = 14 / 15 / 16px (±0.1).
              if (Math.abs(m.size.body - bodyPx) > 0.1) {
                problems.push(`${engine} ${step} 본문: ${m.size.body}px, 기대 ${bodyPx}px`);
              }
              // 다른 역할도 비례: 크기와 줄 높이 모두 기본 × 배율.
              for (const role of ROLES) {
                const sizeRatio = m.size[role] / base.size[role];
                const lineRatio = m.line[role] / base.line[role];
                if (Math.abs(sizeRatio - scale) > 0.003) {
                  problems.push(`${engine} ${step} ${role} 크기 비율 ${sizeRatio.toFixed(4)}, 기대 ${scale.toFixed(4)}`);
                }
                if (Math.abs(lineRatio - scale) > 0.003) {
                  problems.push(`${engine} ${step} ${role} 줄 높이 비율 ${lineRatio.toFixed(4)}, 기대 ${scale.toFixed(4)}`);
                }
                // 줄 상자는 언제나 자기 글자보다 크다(글자가 위아래로 잘리지 않는다).
                if (!(m.line[role] > m.size[role])) {
                  problems.push(`${engine} ${step} ${role}: 줄 높이 ${m.line[role]}px ≤ 글자 ${m.size[role]}px`);
                }
              }
              // 틀(rem 레이아웃)은 단계가 바뀌어도 그대로다.
              if (Math.abs(m.layoutWidth - base.layoutWidth) > 0.01) {
                problems.push(`${engine} ${step} 레이아웃 폭 ${m.layoutWidth}px, 기본 ${base.layoutWidth}px — 틀이 움직였다`);
              }

              // 브라우저 확대와 직교: 루트 글자 16 → 20px(×1.25)에서 모든 역할이 같은 배로 따라가고, 단계 비율은 그대로다.
              const zoomed = await at(step, 20);
              for (const role of ROLES) {
                const ratio = zoomed.size[role] / m.size[role];
                if (Math.abs(ratio - 1.25) > 0.003) {
                  problems.push(`${engine} ${step} ${role}: 루트 20px에서 ${ratio.toFixed(4)}배, 기대 1.25배`);
                }
              }
              if (Math.abs(zoomed.size.body - bodyPx * 1.25) > 0.1) {
                problems.push(`${engine} ${step} 본문 @루트 20px: ${zoomed.size.body}px, 기대 ${bodyPx * 1.25}px`);
              }
              if (Math.abs(zoomed.layoutWidth - 200) > 0.01) {
                problems.push(`${engine} ${step} 레이아웃 폭 @루트 20px: ${zoomed.layoutWidth}px, 기대 200px`);
              }
            }

            // 속성이 없거나 모르는 값이면 「기본」이다.
            for (const step of [null, "huge"]) {
              const m = await at(step);
              for (const role of ROLES) {
                if (Math.abs(m.size[role] - base.size[role]) > 0.01) {
                  problems.push(`${engine} data-font-size=${String(step)} ${role}: ${m.size[role]}px, 기본 ${base.size[role]}px`);
                }
              }
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
});
