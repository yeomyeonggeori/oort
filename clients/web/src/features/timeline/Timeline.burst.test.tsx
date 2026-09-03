// @vitest-environment jsdom
// Same-tick live burst through the REAL virtualized Timeline (react-virtuoso,
// not a mock, not rows mapped straight off state). The R3 probe showed the
// product plays 1 of 3 because virtuoso mounts appended rows in a later
// commit than the state update; a test that skips that commit is not evidence.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import {
  ENTER_CONVERSATION_ANIMATION_NAME,
  ENTER_CONVERSATION_CLASS,
} from "@/design/motion";
import { useTimeline } from "./useTimeline";
import { Timeline } from "./Timeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const BURST_IDS = [
  "0199eeee-0000-7000-8000-000000000411",
  "0199eeee-0000-7000-8000-000000000412",
  "0199eeee-0000-7000-8000-000000000413",
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

vi.mock("@/features/reminders/RemindDialog", () => ({
  RemindDialog: () => null,
}));

vi.mock("@/features/emoji/EmojiPickerDialog", () => ({
  EmojiPickerDialog: () => null,
}));

const restPage = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(async () => ({
      messages: restPage.messages,
      nextBefore: undefined,
    })),
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
  };
});

type Handlers = Parameters<RealtimeHandle["subscribeChannel"]>[2];
const rail: { handlers: Handlers | null } = { handlers: null };

const realtime = {
  subscribeChannel: (_ws: string, _ch: string, handlers: Handlers) => {
    rail.handlers = handlers;
    return () => {
      rail.handlers = null;
    };
  },
  subscribeAgent: () => () => undefined,
  subscribeTyping: () => () => undefined,
  subscribeWorkSession: () => () => undefined,
  subscribeCascade: () => () => undefined,
  subscribeHuddle: () => () => undefined,
  reconnect: () => undefined,
  dispose: () => undefined,
} as unknown as RealtimeHandle;

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type RafCallback = FrameRequestCallback;
const rafQueue: RafCallback[] = [];
let rafId = 0;

let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

function scrollerHeight(target: Element): number {
  if (target === host) return 800;
  if (target instanceof HTMLElement && target.dataset.testid === "timeline-virtuoso") {
    return 800;
  }
  return 48;
}

function detectChromium(): { ok: true } | { ok: false; path: string } {
  try {
    const { chromium } = require_("playwright") as typeof import("playwright");
    const exe = chromium.executablePath();
    if (!existsSync(exe)) return { ok: false, path: exe };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      path: err instanceof Error ? err.message : String(err),
    };
  }
}

const chromiumAvailability = detectChromium();
const chromiumAvailable = chromiumAvailability.ok;
if (!chromiumAvailable) {
  console.warn(
    `Timeline burst animation probe skipped: Playwright Chromium executable missing (${chromiumAvailability.path})`
  );
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      const height = scrollerHeight(this);
      const width = 640;
      return {
        x: 0,
        y: 0,
        width,
        height,
        top: 0,
        left: 0,
        bottom: height,
        right: width,
        toJSON: () => ({}),
      };
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return scrollerHeight(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return scrollerHeight(this);
    },
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.scrollTo = function scrollTo(
    this: HTMLElement,
    arg?: ScrollToOptions | number,
    y?: number
  ) {
    if (typeof arg === "number") {
      this.scrollTop = y ?? 0;
      return;
    }
    if (arg && typeof arg === "object" && typeof arg.top === "number") {
      this.scrollTop = arg.top;
    }
  };
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  globalThis.ResizeObserver = class ResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      const height = scrollerHeight(target);
      const width = 640;
      this.callback(
        [
          {
            target,
            contentRect: {
              x: 0,
              y: 0,
              width,
              height,
              top: 0,
              left: 0,
              bottom: height,
              right: width,
              toJSON: () => ({}),
            },
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as ResizeObserverEntry,
        ],
        this
      );
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  };
  if (typeof globalThis.IntersectionObserver === "undefined") {
    globalThis.IntersectionObserver = class IntersectionObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "0px";
      thresholds = [0];
    };
  }
  vi.stubGlobal("requestAnimationFrame", (cb: RafCallback) => {
    rafQueue.push(cb);
    rafId += 1;
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    void id;
  });
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

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  rail.handlers = null;
  restPage.messages = [];
  rafQueue.length = 0;
});

function member(): RosterMember {
  return {
    id: OTHER,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "김인턴",
    handle: "intern-kim",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: ME,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function wrap(node: ReactElement, client: QueryClient): ReactElement {
  return createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      OpenMemberProfileContext.Provider,
      { value: () => undefined },
      createElement(QueryClientProvider, { client }, node)
    )
  );
}

function restMessage(seq: number): Message {
  return {
    id: `0199aaaa-0000-7000-8000-0000000001${String(seq).padStart(2, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: `히스토리 행 ${seq}`,
    state: "sent",
    createdAtMs: seq,
  };
}

function frame(id: string, seq: number, body: string) {
  return {
    type: "message.new",
    v: 1,
    ts: Date.now(),
    seq,
    payload: {
      id,
      channel_id: CH,
      seq,
      hlc_ts: Date.now(),
      hlc_count: 0,
      author_member_id: OTHER,
      type: "text",
      body,
      state: "sent",
      created_at_ms: Date.now(),
    },
  } as unknown as Parameters<NonNullable<Handlers["onMessage"]>>[0];
}

function BurstTimeline(): ReactElement {
  const timeline = useTimeline(realtime, WS, CH, ME);
  const directory = makeDirectory([member()]);
  return createElement(Timeline, {
    messages: timeline.state.messages,
    directory,
    status: timeline.status === "error" ? "error" : "ready",
    reachedStart: true,
    isPlayEntrance: timeline.isPlayEntrance,
    onEntranceConsumed: timeline.consumeEntrance,
    capUnmountedArrivals: timeline.capUnmountedArrivals,
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushVirtuosoMount(): Promise<void> {
  await act(async () => {
    const queued = rafQueue.splice(0);
    for (const cb of queued) cb(0);
  });
}

function burstRows(): HTMLElement[] {
  if (!host) return [];
  return BURST_IDS.map((id) =>
    host!.querySelector(`[data-testid="timeline-message"][data-message-id="${id}"]`)
  ).filter((node): node is HTMLElement => node instanceof HTMLElement);
}

function playingBurstRows(): HTMLElement[] {
  return burstRows().filter(
    (node) =>
      node.getAttribute("data-entrance-play") === "1" &&
      node.classList.contains(ENTER_CONVERSATION_CLASS)
  );
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function buildArrivalCss(): Promise<string> {
  const tokensPath = join(HERE, "../../design/tokens.css");
  const tokensCss = readFileSync(tokensPath, "utf8");
  const compiler = await compile(tokensCss, {
    base: dirname(tokensPath),
    loadStylesheet,
  });
  return compiler.build([ENTER_CONVERSATION_CLASS]);
}

describe("virtualized Timeline same-tick live burst", () => {
  it("같은 틱 라이브 3건은 virtuoso 가 마운트한 행 3개가 모두 재생한다", async () => {
    restPage.messages = [1, 2, 3, 4, 5, 6, 7, 8].map(restMessage);
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      mountedRoot?.render(wrap(createElement(BurstTimeline), client));
    });
    await settle();
    await flushVirtuosoMount();
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
    });
    await act(async () => {
      rail.handlers?.onMessage(frame(BURST_IDS[0], 21, "같은 틱 첫 번째 arrival 도착"));
      rail.handlers?.onMessage(frame(BURST_IDS[1], 22, "같은 틱 두 번째 arrival 도착"));
      rail.handlers?.onMessage(frame(BURST_IDS[2], 23, "같은 틱 세 번째 arrival 도착"));
    });
    await flushVirtuosoMount();
    const playing = playingBurstRows();
    expect(playing.length).toBe(3);
    expect(host.querySelector("[data-testid='timeline-virtuoso']")).not.toBeNull();
  });

  it.skipIf(!chromiumAvailable)(
    "브라우저가 motion-enter-conversation 을 3회 시작한다 (virtuoso 경로의 스냅샷)",
    async () => {
      restPage.messages = [1, 2, 3, 4, 5, 6, 7, 8].map(restMessage);
      host = document.createElement("div");
      document.body.append(host);
      mountedRoot = createRoot(host);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      await act(async () => {
        mountedRoot?.render(wrap(createElement(BurstTimeline), client));
      });
      await settle();
      await flushVirtuosoMount();
      await act(async () => {
        rail.handlers?.onSubscribed({ recovered: false });
      });
      await act(async () => {
        rail.handlers?.onMessage(
          frame(BURST_IDS[0], 21, "같은 틱 첫 번째 arrival 도착")
        );
        rail.handlers?.onMessage(
          frame(BURST_IDS[1], 22, "같은 틱 두 번째 arrival 도착")
        );
        rail.handlers?.onMessage(
          frame(BURST_IDS[2], 23, "같은 틱 세 번째 arrival 도착")
        );
      });
      await flushVirtuosoMount();
      await flushVirtuosoMount();
      const css = await buildArrivalCss();
      const markup = host.innerHTML;
      let chromium: typeof import("playwright").chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch (err) {
        throw new Error(
          `playwright import failed after skipIf: ${err instanceof Error ? err.message : err}`
        );
      }
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`
        );
        const measured = await page.evaluate((animationName: string) => {
          const rows = [...document.querySelectorAll('[data-testid="timeline-message"]')].filter(
            (el) => (el.textContent ?? "").includes("arrival")
          );
          const animations = document.getAnimations().filter((animation) => {
            const named = animation as unknown as { animationName?: string };
            return named.animationName === animationName;
          });
          return {
            arrivalRows: rows.length,
            animated: animations.length,
          };
        }, ENTER_CONVERSATION_ANIMATION_NAME);
        expect(measured.arrivalRows).toBe(3);
        expect(measured.animated).toBe(3);
      } finally {
        await browser.close();
      }
    },
    20_000
  );
});
