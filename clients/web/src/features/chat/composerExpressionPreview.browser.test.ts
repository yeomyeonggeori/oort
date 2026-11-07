// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import { createLocaleService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import { ExpressionsContext } from "@/features/expressions/context";
import type { ExpressionTransport } from "@/features/expressions/transport";
import { ComposerExpressionPreview } from "@/features/expressions/ComposerExpressionPreview";

// =============================================================================
// 입력창 위 이모티콘 미리 보기의 **크기** (#5487 M2, owner 11-07 웹 목업 `.w-preview`). 채널 입력창과 스레드 입력창이 같은 부품을 쓰므로 한 번만 잰다.
//
// 처음 판은 타임라인의 큰 그림과 같은 200×200 에 ✕ 를 모서리에 얹어서 데스크탑 최소 창(720×480)에서 대화가 80px 만 남았다. 목업은 옅은 테두리 카드 안에
// 56px 그림이 서고 ✕ 가 옆에 있다. jsdom 은 레이아웃을 못 재므로 진짜 `ComposerExpressionPreview` 를 jsdom 에서 한 번 그려 마크업을 얻고, `tokens.css` 를
// Tailwind 로 컴파일한 CSS 와 `expressions.css` 를 실제 엔진에 먹여 「브라우저가 계산한 값」을 잰다(`composerRailReservation.browser.test.ts` 와 같은 방법).
// 사보타주: `expressions.css` 의 `.expression-preview-card` 그림 규칙을 걷거나 ✕ 를 다시 그림 위에 얹으면 이 시험이 붉다.
// =============================================================================

const STYLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "expressions");
const EXPRESSIONS_CSS = readFileSync(join(STYLES_DIR, "expressions.css"), "utf8");

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
});

const STILL = { small: { ...FIXTURE_MEDIA.png.image }, large: { ...FIXTURE_MEDIA.png.image }, thumb: { ...FIXTURE_MEDIA.png.image } };
const CHEERS = { ...FIXTURE_EXPRESSIONS[1], id: "00000000-0000-4000-8000-000000000051", name: "cheers_still", displayName: "건배", tags: ["축하"], media: STILL };

function transport(): ExpressionTransport {
  return {
    async json() {
      return { workspaceId: FIXTURE_WORKSPACE_ID, version: "9", baseVersion: null, reset: true, addPolicy: "members", items: [CHEERS] };
    },
    async image() {
      return `data:image/png;base64,${FIXTURE_MEDIA.png.bodyBase64}`;
    },
  };
}

async function koLocale(): Promise<AppLocale> {
  const context = resolveLocaleContext("ko-KR", { languages: ["ko-KR"], timeZone: "Asia/Seoul" });
  const service = createLocaleService({ ...context, catalog: await loadMessageCatalog("ko-KR") });
  return { service, getSnapshot: () => service.context, subscribe: () => () => undefined } as unknown as AppLocale;
}

/** 미리 보기를 한 번 그려 마크업을 얻는다. 그림이 도착(디코드)한 뒤의 모습이다. */
async function previewHtml(gone: boolean): Promise<string> {
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport());
  await store.refresh();
  const locale = await koLocale();
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(
      createElement(
        LocaleContext.Provider,
        { value: locale },
        createElement(
          ExpressionsContext.Provider,
          { value: store },
          createElement(ComposerExpressionPreview, { expression: CHEERS, gone, onCancel: () => undefined })
        )
      )
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const html = host.innerHTML;
  act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host.remove();
  host = null;
  return html;
}

const classesOf = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

/** 입력창 독의 넓은 창 폭(600 이상)에서 미리 보기 줄이 서는 자리와 같은 폭의 한 칸. */
function page(css: string, markup: string, width: number): string {
  return `<!doctype html><html lang="ko"><head><style>${css}\n${EXPRESSIONS_CSS}\nhtml, body { margin: 0; }\n#slot { width: ${width}px; box-sizing: border-box; }</style></head><body class="bg-surface text-ink"><div id="slot">${markup}</div></body></html>`;
}

interface Measured {
  group: { w: number; h: number };
  card: { x: number; y: number; w: number; h: number };
  image: { x: number; y: number; w: number; h: number } | null;
  cancel: { x: number; y: number; w: number; h: number };
  cancelPosition: string;
  border: string;
  background: string;
  /** 같은 면 토큰(`bg-surface-muted`)을 입힌 빈 상자가 계산한 바탕. 카드의 바탕이 이것과 같아야 한다. */
  tokenBackground: string;
}

async function measure(p: import("playwright").Page): Promise<Measured> {
  return p.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const group = document.querySelector<HTMLElement>('[data-testid="composer-expression-preview"]')!;
    const card = group.querySelector<HTMLElement>(".expression-preview-card")!;
    const image = card.querySelector("img");
    const cancel = group.querySelector<HTMLElement>('[data-testid="composer-expression-preview-cancel"]')!;
    const cs = getComputedStyle(card);
    const probe = document.createElement("div");
    probe.className = "bg-surface-muted";
    document.body.append(probe);
    const tokenBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      group: { w: rect(group).w, h: rect(group).h },
      card: rect(card),
      image: image ? rect(image) : null,
      cancel: rect(cancel),
      cancelPosition: getComputedStyle(cancel).position,
      border: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
      background: cs.backgroundColor,
      tokenBackground,
    };
  });
}

const VIEWPORTS = [
  { width: 900, cancelSize: 28, groupMax: 96 },
  { width: 500, cancelSize: 44, groupMax: 100 },
];

describe("입력창 위 미리 보기는 owner 목업 크기다: 옅은 테두리 카드 안 56px 그림, ✕ 는 옆 (#5487 M2)", () => {
  it.skipIf(ENGINES.length === 0)("실제 엔진에서 그림 56×56 · ✕ 가 그림 오른쪽(28, 폰 폭 44) · 카드 80 이하 · 줄 100 이하다 (전: 200×200 위에 ✕, 줄 216)", async () => {
    const ready = await previewHtml(false);
    const css = await compileTokensCss(classesOf(ready));
    const playwright = await import("playwright");
    const problems: string[] = [];
    for (const engine of ENGINES) {
      const browser = await playwright[engine].launch();
      try {
        for (const colorScheme of ["light", "dark"] as const) {
          // 600 이상(웹·데스크탑)은 ✕ 28, 폰 폭(<600)은 손가락 크기(`tap-target`, 44)로 서고 줄에 띠의 위아래 여백과 아래 경계선 1이 더해진다.
          for (const { width, cancelSize, groupMax } of VIEWPORTS) {
            const ctx = await browser.newContext({ viewport: { width, height: 700 }, colorScheme });
            try {
              const p = await ctx.newPage();
              await p.setContent(page(css, ready, width));
              const m = await measure(p);
              const at = `${engine} ${colorScheme} ${width}`;
              if (m.image === null) problems.push(`${at}: 그림(<img>)이 없다`);
              else {
                if (Math.abs(m.image.w - 56) > 0.51 || Math.abs(m.image.h - 56) > 0.51) problems.push(`${at}: 그림 ${m.image.w}×${m.image.h}, 기대 56×56`);
                // ✕ 는 그림 옆이다: 그림 위에 얹히지 않는다(겹침 0, 오른쪽에 선다).
                if (m.cancel.x < m.image.x + m.image.w - 0.01) problems.push(`${at}: ✕ 가 그림 위에 겹쳤다(그림 오른쪽 ${m.image.x + m.image.w}, ✕ 왼쪽 ${m.cancel.x})`);
              }
              if (m.cancelPosition === "absolute") problems.push(`${at}: ✕ 가 그림 위에 얹혀(absolute) 있다`);
              if (Math.abs(m.cancel.w - cancelSize) > 0.51 || Math.abs(m.cancel.h - cancelSize) > 0.51) problems.push(`${at}: ✕ ${m.cancel.w}×${m.cancel.h}, 기대 ${cancelSize}×${cancelSize}`);
              if (m.card.h > 80) problems.push(`${at}: 카드 높이 ${m.card.h}, 기대 80 이하(전 판 200+)`);
              if (m.group.h > groupMax) problems.push(`${at}: 미리 보기 줄 높이 ${m.group.h}, 기대 ${groupMax} 이하(전 판 216)`);
              if (m.border !== "1px solid") problems.push(`${at}: 카드 테두리 ${m.border}, 기대 1px solid`);
              if (m.background !== m.tokenBackground) problems.push(`${at}: 카드 바탕 ${m.background}이 면 토큰(bg-surface-muted) ${m.tokenBackground}과 다르다`);
            } finally {
              await ctx.close();
            }
          }
        }
      } finally {
        await browser.close();
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it.skipIf(ENGINES.length === 0)("그림이 더는 쓸 수 없을 때(`gone`)도 줄은 낮고 ✕ 가 문장 옆에 선다", async () => {
    const gone = await previewHtml(true);
    const css = await compileTokensCss(classesOf(gone));
    const playwright = await import("playwright");
    const problems: string[] = [];
    for (const engine of ENGINES) {
      const browser = await playwright[engine].launch();
      try {
        const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
        try {
          const p = await ctx.newPage();
          await p.setContent(page(css, gone, 900));
          const m = await measure(p);
          const at = `${engine} gone`;
          if (m.cancelPosition === "absolute") problems.push(`${at}: ✕ 가 얹혀(absolute) 있다`);
          if (m.group.h > 96) problems.push(`${at}: 줄 높이 ${m.group.h}, 기대 96 이하`);
        } finally {
          await ctx.close();
        }
      } finally {
        await browser.close();
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
