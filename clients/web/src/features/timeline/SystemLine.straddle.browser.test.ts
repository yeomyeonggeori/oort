// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import type { AgentRunProgress, Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { measureHoverToolbarOverlap } from "../../../scripts/lib/hoverToolbarOverlap.mjs";
import { MessageRow } from "./MessageRow";
import { MessageHoverToolbar, type MessageActionCallbacks } from "./MessageActions";
import { SystemLine } from "./SystemLine";
import { SYSTEM_LINE_STRADDLE_CLEAR_CLASS } from "./spacing";

// =============================================================================
// 호버 툴바 ↔ 중단 시스템 줄, 실제 마크업·실제 툴바·실제 엔진으로 잰 겹침 (#5173, 검증 줄 3회차 B2).
//
// 마크업은 jsdom에서 진짜 `MessageRow` 둘 · 진짜 `SystemLine` · 진짜 `MessageHoverToolbar`가 그린 것이다(툴바 폭 223은 손으로 만든
// 값이 아니라 그 컴포넌트가 정한 값이다). 그 마크업에 `tokens.css`를 컴파일해 먹인 실제 엔진(WebKit·Chromium)이 재고, 재는 자는
// 캡처 레인과 **같은 한 벌**(`scripts/lib/hoverToolbarOverlap.mjs`)이다 — 레인과 이 시험의 눈이 갈라지지 않는다.
//
// 두 자리: 줄 **아래** 행에 포인터(툴바가 그 행의 위 경계를 걸쳐 줄 바닥을 덮는 자리), 줄 **위** 행이 스크롤러 맨 위에 걸려 툴바가 행 아래로
// 뒤집힌 자리(줄 윗단을 덮는 자리). 검수 캡처 `5129-stop-line-live-390-*`가 뒤쪽이다.
//
// 여유가 **서야 할 곳에만** 서는지도 잰다: 넓은 열, 손가락 기기(`hover: none`, 툴바가 없다), 툴바가 없는 표면(받은 편지함 맥락 창,
// `clearsToolbarBand` 를 안 넘긴다)의 줄은 34 그대로다. 브라우저는 시험 전체가 한 번씩만 띄운다(전체 시험의 병렬 부하를 늘리지 않는다).
// =============================================================================

vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));
// 생각 줄 시험(마지막 `it`)만 쓴다: 진짜 `RequestThoughtLine`이 원장을 네트워크로 읽지 않게 한다.
vi.mock("@/features/agents/useRunLedger", () => ({ useRunLedger: () => ({ rows: [], report: null, isLoading: false, isError: false }) }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const T0 = new Date("2026-10-27T03:00:00Z").getTime();
const SERVER_LINE = "사람이 실행을 중단했어요.";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function member(id: string, name: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: name,
    handle: name,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
const agentMember: RosterMember = { ...member("00000000-0000-7000-8000-000000000301", "달무리봇"), kind: "agent" };
const directory = makeDirectory([member(ME, "정하윤"), member(OTHER, "김인턴"), agentMember]);

function message(id: string, seq: number, author: string, body: string): Message {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: T0 - 30 * 60_000 + seq,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

/** 진짜 컴포넌트를 한 번 그려 마크업을 얻는다. */
function html(node: ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(
          OpenMemberProfileContext.Provider,
          { value: () => undefined },
          createElement(QueryClientProvider, { client }, node)
        )
      )
    )
  );
  const out = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return out;
}

const callbacks: MessageActionCallbacks = {
  onReply: () => undefined,
  onQuote: () => undefined,
  onCopy: () => undefined,
  onCopyLink: () => undefined,
  onReact: () => undefined,
  onPin: () => undefined,
  onRemind: () => undefined,
  onEdit: () => undefined,
  onDelete: () => undefined,
};

/** 진짜 호버 툴바(반응 3 + 더 · 답글 · ⋯)의 마크업. 위 경계를 걸치는 기본 자리다. */
function toolbarMarkup(): string {
  return html(
    createElement(MessageHoverToolbar, {
      available: { reply: true, quote: true, react: true, pin: true, remind: true, edit: true, delete: true },
      copyState: { canCopy: true, copied: false, canCopyLink: true, copiedLink: false, pinned: false },
      callbacks,
      onOpenPicker: () => undefined,
      menuOpen: false,
      onMenuOpenChange: () => undefined,
      mineEmojis: new Set<string>(),
    })
  );
}

/** 스크롤러 맨 위에서 뒤집힌 자리(행 아래 경계를 걸침)로 바꾼 같은 툴바. */
function flipped(bar: string): string {
  const next = bar.replace('class="hover-toolbar-straddle ', 'class="hover-toolbar-straddle-below ').replace('data-straddle="top"', 'data-straddle="below"');
  expect(next, "뒤집힌 자리로 바뀌었다").not.toBe(bar);
  return next;
}

function rowMarkup(seq: number, author: string, body: string, bar?: string): string {
  const markup = html(
    createElement(MessageRow, {
      message: message(`0199aaaa-0000-7000-8000-0000000000${seq}`, seq, author, body),
      startsGroup: true,
      directory,
      showRollup: false,
    })
  );
  return bar === undefined ? markup : markup.replace(/^(<article[^>]*>)/, `$1${bar}`);
}

function lineMarkup(options: { clearsToolbarBand?: boolean } = {}): string {
  return html(
    createElement(SystemLine, {
      message: { id: "0199aaaa-0000-7000-8000-000000000099", seq: 99, body: SERVER_LINE },
      ...(options.clearsToolbarBand === false ? {} : { clearsToolbarBand: true }),
    })
  );
}

const classesOf = (markup: string) =>
  [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter(Boolean);

function page(css: string, width: number, body: string, rootStyle = ""): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#col { width: ${width}px; position: relative; ${rootStyle} }
</style></head><body class="bg-pane text-ink"><div id="col">${body}</div></body></html>`;
}

type Placement = "below-line" | "above-line";

/** 줄 위 행 · 줄 · 줄 아래 행. 툴바는 포인터가 선 행에만 있다. */
function column(placement: Placement, line: string): string {
  const bar = toolbarMarkup();
  const above = rowMarkup(21, OTHER, "알겠어요.", placement === "above-line" ? flipped(bar) : undefined);
  const below = rowMarkup(23, ME, "표지 문구 후보를 먼저 보내 주세요", placement === "below-line" ? bar : undefined);
  return `${above}${line}${below}`;
}

/** 이 파일이 쓰는 모든 마크업의 클래스로 한 번만 컴파일한다(컴파일은 한 번이면 되고, 규칙은 클래스가 있는 마크업에서만 쓰인다). */
let cssOnce: Promise<string> | undefined;
function sharedCss(): Promise<string> {
  cssOnce ??= compileTokensCss(
    ["below-line", "above-line"].flatMap((placement) =>
      [lineMarkup(), lineMarkup({ clearsToolbarBand: false })].flatMap((line) => classesOf(column(placement as Placement, line)))
    )
  );
  return cssOnce;
}

/** 엔진마다 브라우저를 한 번만 띄운다. */
const browsers = new Map<string, Browser>();
beforeAll(async () => {
  if (ENGINES.length === 0) return;
  const playwright = await import("playwright");
  for (const engine of ENGINES) browsers.set(engine, await playwright[engine].launch());
}, 60_000);
afterAll(async () => {
  await Promise.all([...browsers.values()].map((browser) => browser.close()));
  browsers.clear();
});

interface Measured {
  engine: string;
  chars: number;
  kind: string | null;
  looked: string[];
  barHeight: number;
  lineHeight: number;
  /** 글자 상자까지 줄 상자 위·아래 가장자리에서 얼마나 떨어져 있는가. */
  roomTop: number;
  roomBottom: number;
  hoverCapable: boolean;
}

async function measure(
  width: number,
  placement: Placement,
  options: { line?: string; rootStyle?: string; touch?: boolean } = {}
): Promise<Measured[]> {
  const body = column(placement, options.line ?? lineMarkup());
  const css = await sharedCss();
  const out: Measured[] = [];
  for (const engine of ENGINES) {
    const browser = browsers.get(engine);
    expect(browser, `${engine} 브라우저`).toBeDefined();
    const context = await browser!.newContext({
      viewport: { width: 1600, height: 900 },
      ...(options.touch ? { hasTouch: true, isMobile: true } : {}),
    });
    try {
      const p = await context.newPage();
      await p.setContent(page(css, width, body, options.rootStyle));
      const info = await measureHoverToolbarOverlap(p);
      const geo = await p.evaluate(() => {
        const bar = document.querySelector('[data-testid="message-hover-toolbar"]')!.getBoundingClientRect();
        const line = document.querySelector('[data-testid="system-line"]')!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('[data-testid="system-line"] p')!);
        const text = range.getBoundingClientRect();
        return {
          barHeight: bar.height,
          lineHeight: line.height,
          roomTop: text.top - line.top,
          roomBottom: line.bottom - text.bottom,
          hoverCapable: matchMedia("(hover: hover)").matches,
        };
      });
      expect(info, `${engine} 툴바가 하나`).toHaveLength(1);
      out.push({
        engine,
        chars: info[0].chars,
        kind: info[0].kind,
        looked: info[0].looked.map((item) => `${item.where}:${item.kind}`),
        ...geo,
      });
    } finally {
      await context.close();
    }
  }
  return out;
}

const skip = ENGINES.length === 0;
const PLACEMENTS = ["below-line", "above-line"] as const;

const AGENT = "00000000-0000-7000-8000-000000000301";
const succeededRun: AgentRunProgress = {
  id: "0199aa11-2222-7000-8000-000000000001",
  channelId: CH,
  agentMemberId: AGENT,
  triggerMessageId: "0199aaaa-0000-7000-8000-000000000031",
  phase: "succeeded",
  status: "succeeded",
  leaseState: "none",
  ahead: [],
  stepCount: 1,
  createdAtMs: T0 - 5 * 60_000,
  startedAtMs: T0 - 4 * 60_000,
  updatedAtMs: T0 - 60_000,
  finishedAtMs: T0 - 60_000,
};

describe("겹침 자의 이웃 범위: 생각 줄 (jsdom, 엔진 불필요)", () => {
  it("에이전트 DM 행의 생각 줄은 행의 [data-row-body] 안에 서고 글자는 진짜 글 노드다: 자가 이웃 행의 글자로 이미 센다 (s3-web L4)", () => {
    const markup = html(
      createElement(MessageRow, {
        message: message("0199aaaa-0000-7000-8000-000000000031", 31, ME, "@김인턴 이번 주 회의록 정리해 줘요"),
        startsGroup: true,
        directory,
        showRollup: false,
        showThought: true,
        runStatus: [succeededRun],
      })
    );
    const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
    const thought = doc.querySelector('[data-testid="request-thought-line"]');
    expect(thought, "생각 줄이 그려졌다").not.toBeNull();
    const body = thought!.closest("[data-row-body]");
    expect(body, "생각 줄이 행 글자 상자 안에 있다").not.toBeNull();
    expect(body!.closest('[data-testid="timeline-message"]'), "그 상자는 행 안이다").not.toBeNull();
    // 단추의 이름만이 아니라 화면에 그려지는 글 노드다(자는 글 노드의 Range 를 잰다).
    const label = thought!.querySelector("span[data-numeric]");
    expect(label?.textContent ?? "", "생각 줄 글").toContain("달무리봇");
    expect(label?.childNodes[0]?.nodeType, "글 노드").toBe(Node.TEXT_NODE);
  });
});

describe("호버 툴바 ↔ 중단 시스템 줄 (실제 엔진·실제 마크업)", () => {
  it.skipIf(skip)("좁은 열(390): 줄 아래 행의 툴바도, 줄 위 행의 뒤집힌 툴바도 줄 글자를 덮지 않는다", async () => {
    for (const placement of PLACEMENTS) {
      for (const m of await measure(390, placement)) {
        const at = `${m.engine} ${placement}`;
        expect(m.hoverCapable, `${at} 호버가 되는 입력`).toBe(true);
        // 양성 대조: 자가 이웃으로 시스템 줄을 실제로 봤다.
        expect(m.looked, `${at} 이웃`).toContain(placement === "below-line" ? "prev:system-line" : "next:system-line");
        expect(m.chars, `${at} 줄 글자 덮음(${m.kind})`).toBe(0);
        // 띠가 이웃 칸에 들어오는 깊이 = 툴바 키 − 이 행의 위(아래) 패딩 6. 글자 상자는 그보다 멀리 있어야 한다.
        const reach = m.barHeight - 6;
        expect(m.roomTop, `${at} 줄 위 여유`).toBeGreaterThanOrEqual(reach);
        expect(m.roomBottom, `${at} 줄 아래 여유`).toBeGreaterThanOrEqual(reach);
      }
    }
  }, 30_000);

  it.skipIf(skip)("여유를 뺀 같은 줄은 두 자리 모두에서 글자를 덮는다 (자가 눈이 있고, 여유가 일을 한다)", async () => {
    // 받은 편지함 맥락 창이 그리는 줄과 같은 마크업(여유 없음)이 툴바 밑에 서면 덮이는 줄이다 — 그래서 툴바가 서는 표면만 여유를 받는다.
    const bare = lineMarkup({ clearsToolbarBand: false });
    expect(lineMarkup(), "타임라인의 줄은 여유 클래스를 든다").toContain(SYSTEM_LINE_STRADDLE_CLEAR_CLASS);
    expect(bare, "여유 클래스가 실제로 빠졌다").not.toContain(SYSTEM_LINE_STRADDLE_CLEAR_CLASS);
    for (const placement of PLACEMENTS) {
      for (const m of await measure(390, placement, { line: bare })) {
        expect(m.chars, `${m.engine} ${placement} 여유 없는 줄`).toBeGreaterThan(0);
        expect(m.kind, `${m.engine} ${placement}`).toBe("system-line");
        expect(m.lineHeight, `${m.engine} ${placement} 여유 없는 줄 높이`).toBeCloseTo(34, 0);
      }
    }
  }, 30_000);

  it.skipIf(skip)("여유가 필요 없는 자리에서는 줄이 34 그대로다: 넓은 열(1440), 손가락 기기(hover: none)", async () => {
    for (const placement of PLACEMENTS) {
      for (const m of await measure(1092, placement)) {
        expect(m.lineHeight, `${m.engine} ${placement} 넓은 열 줄 높이`).toBeCloseTo(34, 0);
        expect(m.chars, `${m.engine} ${placement} 넓은 열`).toBe(0);
      }
      // 손가락 기기: 호버가 없어 툴바를 그리지 않으므로(JS) 좁은 열에서도 여유가 붙지 않는다.
      for (const m of await measure(390, placement, { touch: true })) {
        expect(m.hoverCapable, `${m.engine} ${placement} 손가락 기기는 호버가 없다(하네스 대조)`).toBe(false);
        expect(m.lineHeight, `${m.engine} ${placement} 손가락 기기 줄 높이`).toBeCloseTo(34, 0);
      }
    }
  }, 30_000);

  it.skipIf(skip)("대화 밀도 촘촘(--spacing-row 4 → 띠 깊이 38)에서도 좁은 열의 글자를 덮지 않는다", async () => {
    for (const placement of PLACEMENTS) {
      for (const m of await measure(390, placement, { rootStyle: "--spacing-row: 4px;" })) {
        const reach = m.barHeight - 4;
        expect(reach, "밀도 촘촘의 깊이").toBeGreaterThanOrEqual(38);
        expect(m.chars, `${m.engine} ${placement}`).toBe(0);
        expect(m.roomTop, `${m.engine} ${placement} 위`).toBeGreaterThanOrEqual(reach);
        expect(m.roomBottom, `${m.engine} ${placement} 아래`).toBeGreaterThanOrEqual(reach);
      }
    }
  }, 30_000);
});
