// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { TypingLine } from "./TypingLine";

// =============================================================================
// 「작성 중」 줄을 실제 엔진에서 잰다 (#5582 · #5567 design-review R2-M1 · R2-M2).
//
// R2-M1: 두 사람이 칠 때 첫 표시명이 길면 폰 폭에서 둘째 사람이 줄에서 통째로 사라졌다(두 이름이 한 말줄임 조각 안이라 뒤 이름부터
//   잘렸다). 이름마다 자기 칸에서 줄어들어 두 이름이 늘 남아야 한다. 짧은 이름은 다 보이고, 서술어 꼬리는 안 잘린다.
// R2-M2: 폰 폭(<600)에는 카드 그림자가 없는데 넓은 창의 칸 34를 그대로 써서, 자판이 올라온 화면에서 대화가 22px 줄었다.
//   폰 폭 칸은 글 한 줄 + 위아래 4(26)이고 넓은 창은 34 그대로다. 그 칸은 누가 치든 안 치든 같은 높이다(움직임 0).
//
// jsdom에서 진짜 `TypingLine`을 그려 마크업을 얻고, `tokens.css`를 Tailwind로 컴파일한 CSS와 함께 WebKit·Chromium에 올린다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const LONG_A = "00000000-0000-7000-8000-000000000301";
const SHORT_B = "00000000-0000-7000-8000-000000000302";
const LONG_C = "00000000-0000-7000-8000-000000000303";
const EN_LONG = "00000000-0000-7000-8000-000000000304";
const EN_SHORT = "00000000-0000-7000-8000-000000000305";

function human(id: string, displayName: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    role: "member",
    displayName,
    handle: id.slice(-4),
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

// 가상 인물. 첫 이름은 390 폭의 줄을 혼자서도 넘칠 만큼 길다(design-review R2-M1의 36자 꼴).
const directory = makeDirectory([
  human(LONG_A, "윤가람 프로덕트디자인 리드 겸 서비스기획 및 사용자경험 총괄"),
  human(SHORT_B, "오민재"),
  human(LONG_C, "백하린 플랫폼엔지니어링 테크리드 겸 인프라 운영 담당"),
  human(EN_LONG, "Alexandra Montgomery-Fitzgerald (Platform Engineering)"),
  human(EN_SHORT, "Bob"),
]);

let korean: AppLocale;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

/** 진짜 `TypingLine`의 마크업. 사전이 없으면 영어 사전으로 그린다. */
function lineHtml(memberIds: string[], locale: AppLocale | null): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const line = createElement(TypingLine, { memberIds, directory });
  act(() => root.render(locale === null ? line : createElement(LocaleProvider, { locale, children: line })));
  const html = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return html;
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

/** 앞 판(#5567)의 폰 폭 독: 폼 `p-3`(아래 12), 카드 98, 「작성 중」 칸 없음. 대화 높이를 비교하는 기준이다. */
const DOCK_CLASSES = "composer-dock safe-area-bottom shrink-0";

function page(css: string, line: string, { width, height }: { width: number; height: number }, formClass: string): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#chat { display: flex; flex-direction: column; width: ${width}px; height: ${height}px; }
#list { flex: 1 1 0; min-height: 0; }
#card { height: 98px; }
</style></head><body class="bg-surface text-ink">
<div id="chat"><div id="list"></div><div class="${DOCK_CLASSES}" data-composer-shell=""><form class="${formClass}"><div id="card" class="composer-card"></div>${line}</form></div></div>
</body></html>`;
}

interface Fit {
  names: { text: string; visible: number; overflow: number }[];
  tailClip: number;
  tailVisible: number;
  lineHeight: number;
  listHeight: number;
}

async function measure(p: import("playwright").Page): Promise<Fit> {
  return p.evaluate(() => {
    const lead = document.querySelector<HTMLElement>('[data-testid="composer-typing-lead"]');
    const tail = document.querySelector<HTMLElement>('[data-testid="composer-typing-tail"]');
    const line = document.querySelector<HTMLElement>('[data-testid="typing-line"]');
    const leadBox = lead?.getBoundingClientRect() ?? null;
    // 이름은 굵은 사람 잉크(`font-bold`)다. 보이는 폭 = 이름 상자 가운데, 줄어드는 조각까지 올라가며 만나는 잘림 상자(넘침
    // 숨김) 모두의 오른쪽 끝 안에 든 몫. 잘림 상자가 줄어드는 조각 하나든(앞 판) 이름 칸이든(이 판) 같은 식으로 잰다.
    const names = lead
      ? Array.from(lead.querySelectorAll<HTMLElement>(".font-bold")).map((el) => {
          const box = el.getBoundingClientRect();
          let right = Math.min(box.right, leadBox!.right);
          let clip: HTMLElement = lead;
          for (let up = el.parentElement; up !== null && up !== lead; up = up.parentElement) {
            if (getComputedStyle(up).overflowX !== "visible") {
              right = Math.min(right, up.getBoundingClientRect().right);
              if (clip === lead) clip = up;
            }
          }
          return {
            text: el.textContent ?? "",
            visible: Math.max(0, right - box.left),
            // 이 이름이 자기 잘림 상자 안에서 잘렸나(앞 판은 줄어드는 조각 전체가 하나의 상자다).
            overflow: clip === lead ? (box.right > leadBox!.right + 0.5 ? lead.scrollWidth - lead.clientWidth : 0) : clip.scrollWidth - clip.clientWidth,
          };
        })
      : [];
    const tailBox = tail?.getBoundingClientRect() ?? null;
    return {
      names,
      tailClip: tail ? tail.scrollWidth - tail.clientWidth : 0,
      tailVisible: tailBox && line ? Math.max(0, Math.min(tailBox.right, line.getBoundingClientRect().right) - tailBox.left) : 0,
      lineHeight: line?.getBoundingClientRect().height ?? 0,
      listHeight: document.getElementById("list")!.getBoundingClientRect().height,
    };
  });
}

describe("「작성 중」 줄을 실제 엔진에서 잰다 (#5582)", () => {
  it.skipIf(ENGINES.length === 0)(
    "R2-M1: 390 폭에서 첫 이름이 길어도 두 이름이 다 보이고(짧은 이름은 온전히), 서술어 꼬리는 안 잘린다",
    async () => {
      const scenes = {
        "ko 긴 이름 + 짧은 이름": { html: lineHtml([LONG_A, SHORT_B], korean), shortName: "오민재" },
        "ko 긴 이름 + 긴 이름": { html: lineHtml([LONG_A, LONG_C], korean), shortName: null },
        "ko 짧은 이름 + 긴 이름": { html: lineHtml([SHORT_B, LONG_A], korean), shortName: "오민재" },
        "en 긴 이름 + 짧은 이름": { html: lineHtml([EN_LONG, EN_SHORT], null), shortName: "Bob" },
      } as const;
      const css = await compileTokensCss(Object.values(scenes).flatMap((scene) => classesOf(scene.html)));
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
          const p = await ctx.newPage();
          for (const [name, scene] of Object.entries(scenes)) {
            await p.setContent(page(css, scene.html, { width: 390, height: 844 }, "relative p-3 pb-0"));
            const fit = await measure(p);
            const at = `${engine} 390 「${name}」`;
            if (fit.names.length !== 2) {
              problems.push(`${at}: 보이는 줄의 이름 조각이 ${fit.names.length}개다(둘이어야 한다)`);
              continue;
            }
            // 장면이 실제로 넘치는지부터 본다: 넘치지 않으면 이 시험은 아무것도 재지 않는다.
            if (!fit.names.some((n) => n.overflow > 0)) problems.push(`${at}: 아무 이름도 잘리지 않았다 — 장면이 넘치지 않는다`);
            for (const n of fit.names) {
              // 한 글자 반 이상(굵은 12px 한 글자 ≈ 12px)이 보여야 「그 사람이 있다」가 읽힌다.
              if (n.visible < 18) problems.push(`${at}: 「${n.text.slice(0, 6)}…」의 보이는 폭 ${n.visible.toFixed(1)}px`);
              if (n.text === scene.shortName && n.overflow > 0.5) {
                problems.push(`${at}: 짧은 이름 「${n.text}」이 ${n.overflow}px 잘렸다(온전히 보여야 한다)`);
              }
            }
            if (fit.tailClip > 0.5 || fit.tailVisible < 1) problems.push(`${at}: 서술어 꼬리가 잘렸다(${fit.tailClip}px)`);
          }
          await ctx.close();
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    120_000
  );

  it.skipIf(ENGINES.length === 0)(
    "R2-M2: 폰 폭 칸은 글 한 줄 + 위아래 4(26), 넓은 창은 34 — 누가 치든 안 치든 같은 높이이고, 자판이 올라온 폰 폭에서 대화가 22가 아니라 14만 내준다",
    async () => {
      const idle = lineHtml([], korean);
      const typing = lineHtml([LONG_A, SHORT_B], korean);
      const css = await compileTokensCss([...classesOf(idle), ...classesOf(typing), "relative", "p-3", "pb-0"]);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          // 390×508 = 자판이 올라온 폰 화면의 높이 근사(design-review R2-M2와 같은 값). 1280×800은 넓은 창.
          for (const vp of [
            { width: 390, height: 508, slot: 26 },
            { width: 390, height: 844, slot: 26 },
            { width: 1280, height: 800, slot: 34 },
          ]) {
            const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
            const p = await ctx.newPage();
            const at = `${engine} ${vp.width}x${vp.height}`;
            await p.setContent(page(css, idle, vp, "relative p-3 pb-0"));
            const off = await measure(p);
            await p.setContent(page(css, typing, vp, "relative p-3 pb-0"));
            const on = await measure(p);
            if (Math.abs(off.lineHeight - vp.slot) > 0.01) problems.push(`${at}: 빈 칸 ${off.lineHeight}px, 기대 ${vp.slot}`);
            if (Math.abs(on.lineHeight - off.lineHeight) > 0.01 || Math.abs(on.listHeight - off.listHeight) > 0.01) {
              problems.push(`${at}: 줄이 서자 칸 ${off.lineHeight}→${on.lineHeight}, 대화 ${off.listHeight}→${on.listHeight}`);
            }
            if (vp.width < 600) {
              // 앞 판(#5567 이전)의 폰 폭 독: 같은 카드, 폼 아래 여백 12, 칸 없음.
              await p.setContent(page(css, "", vp, "relative p-3"));
              const before = await measure(p);
              const given = before.listHeight - off.listHeight;
              if (Math.abs(given - 14) > 0.51) problems.push(`${at}: 대화가 앞 판보다 ${given}px 줄었다(기대 14 = 칸 26 - 폼 아래 여백 12)`);
            }
            await ctx.close();
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
