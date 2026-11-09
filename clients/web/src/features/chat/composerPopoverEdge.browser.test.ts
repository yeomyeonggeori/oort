// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 컴포저 후보 목록(`@`·`#`·`:`)과 `/` 명령 목록은 **그릇 카드의 가장자리에** 선다 (#5094, #5048 D6).
//
// 목록은 폼 안에 절대 위치로 서고 가로는 `left-3`(12)이다. 폰 폭의 폼 여백(`p-3`)이 12라서 카드와 맞았고, 넓은 창(≥600)의 폼 여백은
// 24(`composer-dock > form`)라서 목록이 카드보다 12 왼쪽으로 튀어나왔다. 이 시험은 **진짜 `Composer`가 그린 마크업**(목록이 열린 채)을
// 실제 엔진(WebKit·Chromium)에 `tokens.css` 컴파일 결과와 함께 올려 두 가장자리를 값으로 잰다:
//
//   · 폰 390 (폼 여백 12): 목록 왼쪽 = 카드 왼쪽, 명령 목록은 오른쪽도 카드 오른쪽(카드가 440보다 좁아 양쪽을 채운다)
//   · 넓은 창 1280 (폼 여백 24): 목록 왼쪽 = 카드 왼쪽
//   · 넓은 창 900 + 좁은 칼럼 420 (스레드가 열려 컴포저 칼럼이 좁아진 경우): 명령 목록이 양쪽 모두 카드 안쪽 선에 맞는다
//
// 값이 0이어야 하는 이유는 목록이 입력 글자가 아니라 **카드의 가장자리**에 서도록 계약했기 때문이다(캡처 `assertMentionTrigger`의
// `frameLeftDelta`). 사보타주: `tokens.css` `composer-dock`의 ≥600 블록에서 `data-composer-popover` 규칙을 지우면 넓은 창 두 칸이 −12로
// 붉고 폰 칸은 0으로 남는다(폰 경로가 그대로라는 증거).
// =============================================================================

const scheduledApi = vi.hoisted(() => ({
  listAllScheduledMessages: vi.fn(),
  createScheduledMessage: vi.fn(),
  updateScheduledMessage: vi.fn(),
  sendScheduledMessageNow: vi.fn(),
  deleteScheduledMessage: vi.fn(),
}));
vi.mock("@momo/core/features/scheduled/api", () => scheduledApi);

const api = vi.hoisted(() => ({
  listChannels: vi.fn(),
  fetchRoster: vi.fn(),
  fetchWorkHosts: vi.fn(),
  fetchAgentLiveness: vi.fn(),
  fetchApprovals: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { resetAgentWorking } from "@/features/agents/agentWorkingSignal";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { clearDraft } from "@/features/chat/draftStore";
import { Composer } from "./Composer";

// jsdom 환경에서 `import.meta.url`은 file URL이 아닐 수 있어 경로로 푼다.
const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = readFileSync(join(HERE, "..", "..", "design", "tokens.css"), "utf8");
const LIST_SRC = readFileSync(join(HERE, "ComposerAutocompleteList.tsx"), "utf8");

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEOYEON = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000201";

const CHANNELS: Channel[] = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false } as Channel];
const member = (id: string, name: string): RosterMember =>
  ({
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: name,
    handle: name,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  }) as unknown as RosterMember;
const HUMANS = [member(ME, "정하윤"), member(SEOYEON, "박서연")];

let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue([]);
  api.fetchWorkHosts.mockResolvedValue([]);
  api.fetchApprovals.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  resetSchedulerDisabledForTest();
  clearDraft(WS, CH);
  resetAgentWorking();
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  resetAgentWorking();
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** React 의 onChange 는 네이티브 value 세터를 거친 `input` 이벤트에만 반응한다. */
async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("textarea value setter missing");
  await act(async () => {
    setter.call(textarea, value);
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(2);
}

/** 진짜 컴포저를 그리고 `typed`를 쳐서 목록을 연 채의 마크업을 얻는다. */
async function composerHtmlWithList(typed: string, listTestId: string): Promise<string> {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [`/c/${CH}`] },
          createElement(
            OpenAgentProfileContext.Provider,
            { value: () => undefined },
            createElement(
              SessionProvider,
              { value: session() },
              createElement(Composer, {
                workspaceId: WS,
                channelId: CH,
                directory: makeDirectory(HUMANS),
                channels: CHANNELS,
                channelLabel: "일반",
                recipient: "place",
                dmAgent: null,
                quote: null,
                onCancelQuote: () => undefined,
                onSend: () => undefined,
              })
            )
          )
        )
      )
    );
  });
  await settle();
  const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
  if (!textarea) throw new Error("composer-input missing");
  await typeInto(textarea, typed);
  if (!host.querySelector(`[data-testid="${listTestId}"]`)) {
    throw new Error(`「${typed}」를 쳤는데 ${listTestId} 가 열리지 않았다`);
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

function pageHtml(css: string, composer: string, columnWidth: number): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#column { width: ${columnWidth}px; padding-top: 320px; box-sizing: border-box; }
</style></head><body class="bg-surface text-ink"><div id="column">${composer}</div></body></html>`;
}

interface Edges {
  /** 목록 왼쪽 가장자리 − 카드 왼쪽 가장자리. 0이면 카드 선에 맞는다. */
  left: number;
  /** 카드 오른쪽 가장자리 − 목록 오른쪽 가장자리. 양쪽을 채우는 명령 목록에서만 뜻이 있다. */
  right: number;
  listWidth: number;
  cardWidth: number;
  formPaddingLeft: number;
}

async function measure(p: import("playwright").Page, root: string): Promise<Edges> {
  return p.evaluate((selector) => {
    const list = document.querySelector<HTMLElement>(selector);
    const card = document.querySelector<HTMLElement>('[data-testid="composer-frame"]');
    if (!list || !card) throw new Error(`missing ${selector} or composer-frame`);
    const l = list.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return {
      left: Math.round((l.left - c.left) * 100) / 100,
      right: Math.round((c.right - l.right) * 100) / 100,
      listWidth: Math.round(l.width * 100) / 100,
      cardWidth: Math.round(c.width * 100) / 100,
      formPaddingLeft: Number.parseFloat(getComputedStyle(card.closest("form")!).paddingLeft),
    };
  }, root);
}

describe("컴포저 후보 목록은 그릇 카드의 가장자리에 선다 (#5094, #5048 D6)", () => {
  it.skipIf(ENGINES.length === 0)(
    "폰 390 · 넓은 창 1280 · 좁은 칼럼 420(창 900)에서 후보 목록·명령 목록의 가장자리가 카드 선과 0",
    async () => {
      const scenes = {
        mention: {
          html: await composerHtmlWithList("@", "composer-mention-list"),
          root: '[data-testid="composer-mention-list"]',
        },
        command: {
          html: await composerHtmlWithList("/", "composer-command-list"),
          root: '[data-testid="composer-command-list-panel"]',
        },
      } as const;
      const css = await compileTokensCss(Object.values(scenes).flatMap((scene) => classesOf(scene.html)));
      const playwright = await import("playwright");
      const problems: string[] = [];

      // 목록 루트 표지가 마크업에 정말 있다: 규칙이 이 표지를 보므로, 표지가 지워지면 이 칸이 아무것도 못 재고 초록이 된다.
      expect(scenes.mention.html).toContain('data-composer-popover="list"');
      expect(scenes.command.html).toContain('data-composer-popover="menu"');

      const CASES = [
        { name: "폰 390", viewport: 390, column: 390, formPad: 12, commandRight: true },
        { name: "넓은 창 1280", viewport: 1280, column: 1280, formPad: 24, commandRight: false },
        // 창은 넓은데(≥600 규칙이 켜진다) 컴포저 칼럼이 좁다: 카드(372)가 명령 목록의 상한(440)보다 좁아 양쪽을 채운다.
        { name: "창 900 · 칼럼 420", viewport: 900, column: 420, formPad: 24, commandRight: true },
      ] as const;

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const c of CASES) {
            const ctx = await browser.newContext({ viewport: { width: c.viewport, height: 900 }, colorScheme: "light" });
            try {
              const page = await ctx.newPage();
              for (const [kind, scene] of Object.entries(scenes)) {
                await page.setContent(pageHtml(css, scene.html, c.column));
                const edges = await measure(page, scene.root);
                const at = `${engine} ${c.name} ${kind}`;
                // 측정이 의미 있으려면 폼 여백이 계약한 값(폰 12 · 넓은 창 24)이어야 한다.
                if (edges.formPaddingLeft !== c.formPad) problems.push(`${at}: 폼 왼쪽 여백 ${edges.formPaddingLeft}, 기대 ${c.formPad}`);
                if (Math.abs(edges.left) > 0.5) problems.push(`${at}: 왼쪽 ${edges.left}px (기대 0, 카드 선)`);
                if (kind === "command" && c.commandRight && Math.abs(edges.right) > 0.5) {
                  problems.push(`${at}: 오른쪽 ${edges.right}px (기대 0, 양쪽을 채우는 명령 목록)`);
                }
                if (kind === "command" && c.commandRight && !(edges.listWidth < 440 && edges.listWidth > 0)) {
                  problems.push(`${at}: 명령 목록 폭 ${edges.listWidth} — 상한 440보다 좁아야 양쪽을 채운다는 측정이 선다`);
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
    240_000
  );
});

// 브라우저가 없는 곳(엔진 없는 CI 유닛 레인 · 에이전트 격리)에서도 도는 절반. 위 시험은 `skipIf`라 엔진이 없으면 아무것도 못 재므로,
// 규칙이 **그 자리에 있다**는 것만은 글자로 잠근다(`desktopShell.ds2.test.ts`가 `composer-dock`의 여백 줄을 글자로 잠그는 것과 같은 방식).
// 값은 위의 엔진 시험이 잰다. 사보타주: ≥600 블록에서 규칙을 지우거나 표지를 지우면 붉다.
describe("컴포저 후보 목록 가장자리 규칙은 브라우저 없이도 잠겨 있다 (#5094, #5048 D6)", () => {
  it("composer-dock ≥600 블록이 폼 여백과 같은 값으로 목록 가장자리를 옮기고, 세 뿌리가 표지를 단다", () => {
    const dockAt = TOKENS_CSS.indexOf("@utility composer-dock {");
    expect(dockAt).toBeGreaterThan(-1);
    const dockEnd = TOKENS_CSS.indexOf("\n@utility ", dockAt + 1);
    const dock = TOKENS_CSS.slice(dockAt, dockEnd);
    const wideAt = dock.indexOf("@media (width >= 600px)");
    expect(wideAt).toBeGreaterThan(-1);
    const wide = dock.slice(wideAt);
    // 폼 여백의 가로 값(24 = --spacing-6)과 목록 가장자리가 **같은 블록의 같은 토큰**이다. 아래 여백은 0이다: 카드 아래 18은
    // 「작성 중」 줄(`typing-line`)이 맡는다(#5567).
    expect(/& > form \{\s*padding: var\(--spacing-2\) var\(--spacing-(\d+)\) 0;/.exec(wide)?.[1]).toBe("6");
    expect(wide).toMatch(/& > form > \[data-composer-popover\] \{\s*left: var\(--spacing-6\);\s*\}/);
    expect(wide).toMatch(/& > form > \[data-composer-popover="menu"\] \{\s*right: var\(--spacing-6\);\s*\}/);
    // 폰 폭(블록 밖)은 목록 규칙이 없다: `left-3`·`right-3` 그대로.
    expect(dock.slice(0, wideAt)).not.toContain("data-composer-popover");
    // 세 뿌리(후보 `ul` · 상태 상자는 `list`, 명령 패널은 `menu`): 표지가 지워지면 규칙이 아무것도 못 옮긴다.
    expect(LIST_SRC.match(/data-composer-popover="list"/g)).toHaveLength(2);
    expect(LIST_SRC.match(/data-composer-popover="menu"/g)).toHaveLength(1);
  });
});
