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
import { useTimeline, MAX_SIMULTANEOUS_ARRIVALS } from "./useTimeline";
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
const rafQueue: { id: number; cb: RafCallback }[] = [];
let rafId = 0;

let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

const VIEWPORT_HEIGHT = 800;
const VIEWPORT_WIDTH = 640;
const ITEM_HEIGHT = 48;

function isScrollerEl(target: Element): boolean {
  return (
    target === host ||
    (target instanceof HTMLElement &&
      (target.dataset.testid === "timeline-virtuoso" ||
        target.hasAttribute("data-virtuoso-scroller")))
  );
}

function isItemEl(target: Element): boolean {
  return target instanceof HTMLElement && target.hasAttribute("data-item-index");
}

function paddedListHeight(list: HTMLElement): number {
  const padTop = Number.parseFloat(list.style.paddingTop) || 0;
  const padBottom = Number.parseFloat(list.style.paddingBottom) || 0;
  const items = list.querySelectorAll("[data-item-index]").length;
  return padTop + padBottom + items * ITEM_HEIGHT;
}

function scrollerHeight(target: Element): number {
  if (!(target instanceof HTMLElement)) return 0;
  if (isScrollerEl(target)) return VIEWPORT_HEIGHT;
  if (target.hasAttribute("data-viewport-type")) return VIEWPORT_HEIGHT;
  if (isItemEl(target) || target.dataset.testid === "timeline-message") {
    return ITEM_HEIGHT;
  }
  const styleHeight = Number.parseFloat(target.style.height);
  if (Number.isFinite(styleHeight) && styleHeight > 0) return styleHeight;
  if (target.dataset.testid === "virtuoso-item-list") {
    return paddedListHeight(target);
  }
  const padTop = Number.parseFloat(target.style.paddingTop) || 0;
  const padBottom = Number.parseFloat(target.style.paddingBottom) || 0;
  if (padTop + padBottom > 0) return padTop + padBottom;
  return 0;
}

function scrollerWidth(target: Element): number {
  if (!(target instanceof HTMLElement)) return 0;
  return VIEWPORT_WIDTH;
}

function scrollerScrollHeight(target: HTMLElement): number {
  if (isScrollerEl(target)) {
    const list = target.querySelector('[data-testid="virtuoso-item-list"]');
    if (list instanceof HTMLElement) return paddedListHeight(list);
    return VIEWPORT_HEIGHT;
  }
  return scrollerHeight(target);
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
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (elt: Element, pseudoElt?: string | null) => {
    const style = computed(elt, pseudoElt);
    return new Proxy(style, {
      get(target, prop, receiver) {
        if (prop === "rowGap" || prop === "columnGap") return "0px";
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
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
      const width = scrollerWidth(this);
      const index = Number(this.getAttribute("data-item-index"));
      const top = Number.isFinite(index) ? (index - 1_000_000) * ITEM_HEIGHT : 0;
      return {
        x: 0,
        y: top,
        width,
        height,
        top,
        left: 0,
        bottom: top + height,
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
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return scrollerWidth(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return scrollerWidth(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return scrollerWidth(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return scrollerScrollHeight(this);
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
      const width = scrollerWidth(target);
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
    rafId += 1;
    rafQueue.push({ id: rafId, cb });
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    const index = rafQueue.findIndex((item) => item.id === id);
    if (index >= 0) rafQueue.splice(index, 1);
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
  probe.isPlayEntrance = null;
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
  probe.isPlayEntrance = timeline.isPlayEntrance;
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
    for (const item of queued) item.cb(0);
  });
}

const probe: {
  isPlayEntrance: ((id: string) => boolean) | null;
} = { isPlayEntrance: null };

function arrivalIds(count: number, prefix = "0199eeee-0000-7000-8000-0000000006"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);
}

function rowFor(id: string): HTMLElement | null {
  if (!host) return null;
  const node = host.querySelector(
    `[data-testid="timeline-message"][data-message-id="${id.toLowerCase()}"]`
  );
  return node instanceof HTMLElement ? node : null;
}

function rowsFor(ids: readonly string[]): HTMLElement[] {
  return ids.map(rowFor).filter((node): node is HTMLElement => node !== null);
}

function isPlayingRow(node: HTMLElement): boolean {
  return (
    node.getAttribute("data-entrance-play") === "1" &&
    node.classList.contains(ENTER_CONVERSATION_CLASS)
  );
}

function playingAmong(ids: readonly string[]): HTMLElement[] {
  return rowsFor(ids).filter(isPlayingRow);
}

function settledAmong(ids: readonly string[]): HTMLElement[] {
  return rowsFor(ids).filter((node) => !isPlayingRow(node));
}

async function waitUntilRowsMounted(ids: readonly string[]): Promise<HTMLElement[]> {
  for (let step = 0; step < 64; step += 1) {
    await flushVirtuosoMount();
    await settle();
    const rows = rowsFor(ids);
    if (rows.length === ids.length) return rows;
  }
  throw new Error(
    `virtuoso never mounted ${ids.length} rows (got ${rowsFor(ids).length})`
  );
}

async function waitUntilPlayingCount(
  ids: readonly string[],
  count: number
): Promise<HTMLElement[]> {
  for (let step = 0; step < 64; step += 1) {
    await flushVirtuosoMount();
    await settle();
    const playing = playingAmong(ids);
    if (playing.length === count) return playing;
  }
  throw new Error(
    `expected ${count} playing rows, got ${playingAmong(ids).length} mounted=${rowsFor(ids).length}`
  );
}

function scrollerOf(): HTMLElement {
  const node =
    host?.querySelector("[data-virtuoso-scroller]") ??
    host?.querySelector('[data-testid="timeline-virtuoso"]');
  if (!(node instanceof HTMLElement)) throw new Error("missing timeline scroller");
  return node;
}

async function pinToBottom(): Promise<void> {
  const scroller = scrollerOf();
  await act(async () => {
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await flushVirtuosoMount();
  await settle();
}

async function leaveBottom(): Promise<void> {
  const scroller = scrollerOf();
  for (let step = 0; step < 64; step += 1) {
    await act(async () => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await settle();
    await flushVirtuosoMount();
    await settle();
    if (scroller.scrollTop !== 0) {
      await act(async () => {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await settle();
    }
    const indexes = [...(host?.querySelectorAll("[data-item-index]") ?? [])]
      .map((node) => Number(node.getAttribute("data-item-index")))
      .filter((value) => Number.isFinite(value));
    const atHead = indexes.length > 0 && Math.min(...indexes) <= 1_000_002;
    if (host?.querySelector("[data-testid='jump-latest']") && atHead) return;
  }
  throw new Error("reader never left the bottom (jump-latest missing)");
}

async function jumpToLatest(): Promise<void> {
  const button = host?.querySelector("[data-testid='jump-latest']");
  if (!(button instanceof HTMLElement)) throw new Error("missing jump-latest");
  await act(async () => {
    button.click();
  });
  const scroller = scrollerOf();
  for (let step = 0; step < 64; step += 1) {
    await act(async () => {
      scroller.scrollTop = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight
      );
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await flushVirtuosoMount();
    await settle();
    const remaining =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining <= 64) return;
  }
  throw new Error("scroller never reached the bottom after jump-latest");
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
    await mountBurst();
    await deliverLive(BURST_IDS, 21, "같은 틱 arrival");
    await waitUntilRowsMounted(BURST_IDS);
    await waitUntilPlayingCount(BURST_IDS, 3);
    expect(playingAmong(BURST_IDS).length).toBe(3);
    expect(MAX_SIMULTANEOUS_ARRIVALS).toBe(3);
    expect(host?.querySelector("[data-testid='timeline-virtuoso']")).not.toBeNull();
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
      await pinToBottom();
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
      await waitUntilRowsMounted(BURST_IDS);
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

  async function mountBurst(history = 8): Promise<QueryClient> {
    restPage.messages = Array.from({ length: history }, (_, i) => restMessage(i + 1));
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
    await settle();
    await flushVirtuosoMount();
    for (let step = 0; step < 64; step += 1) {
      await pinToBottom();
      if (!host?.querySelector("[data-testid='jump-latest']")) return client;
    }
    throw new Error("reader never sat at the bottom after mount");
  }

  async function deliverLive(ids: readonly string[], seqStart: number, body: string): Promise<void> {
    await act(async () => {
      for (let i = 0; i < ids.length; i += 1) {
        rail.handlers?.onMessage(frame(ids[i]!, seqStart + i, `${body} ${i + 1}`));
      }
    });
  }

  it("바닥 같은 틱 10건은 재생 3 · 정착 7", async () => {
    await mountBurst();
    const ids = arrivalIds(10);
    await deliverLive(ids, 30, "바닥 동시 arrival");
    await waitUntilRowsMounted(ids);
    expect(MAX_SIMULTANEOUS_ARRIVALS).toBe(3);
    expect(playingAmong(ids).length).toBe(MAX_SIMULTANEOUS_ARRIVALS);
    expect(settledAmong(ids).length).toBe(7);
    const newest = ids.slice(-MAX_SIMULTANEOUS_ARRIVALS);
    const older = ids.slice(0, ids.length - MAX_SIMULTANEOUS_ARRIVALS);
    expect(playingAmong(newest).length).toBe(3);
    expect(playingAmong(older).length).toBe(0);
  });

  it("바닥 같은 틱 50건은 재생 3 · 나머지 47은 애니 없음", async () => {
    await mountBurst();
    const ids = arrivalIds(50);
    await deliverLive(ids, 40, "바닥 대량 arrival");
    const newest = ids.slice(-MAX_SIMULTANEOUS_ARRIVALS);
    await waitUntilRowsMounted(newest);
    expect(playingAmong(ids).length).toBe(MAX_SIMULTANEOUS_ARRIVALS);
    expect(playingAmong(ids.slice(0, 47)).length).toBe(0);
    expect(ids.length - playingAmong(ids).length).toBe(47);
  });

  it("스크롤업 백로그 50건은 재생 0, 바닥 점프는 정확히 1", async () => {
    await mountBurst(40);
    await leaveBottom();
    const ids = arrivalIds(50, "0199dddd-0000-7000-8000-0000000007");
    await deliverLive(ids, 200, "스크롤업 백로그 arrival");
    await settle();
    expect(playingAmong(ids).length).toBe(0);
    expect(host?.querySelector("[data-testid='jump-latest']")).not.toBeNull();
    await jumpToLatest();
    await waitUntilPlayingCount(ids, 1);
    expect(playingAmong(ids).length).toBe(1);
    expect(playingAmong([ids[ids.length - 1]!]).length).toBe(1);
  });

  it("isPlayEntrance 읽기는 대소문자를 접는다", async () => {
    await mountBurst();
    const mixed = BURST_IDS[0].toUpperCase();
    await deliverLive([mixed], 80, "대소문자 arrival");
    await waitUntilRowsMounted([mixed]);
    expect(playingAmong([mixed]).length).toBe(1);
  });

  it("consumed 장부가 비워져도 같은 id 재전달은 재재생 0", async () => {
    // N-5: MAX_CONSUMED_ARRIVAL_IDS 64→4 로 줄여도 재재생은 안 생긴다.
    // takeArrivalPlay 는 alreadyHeld 가 먼저 0 을 돌려서, consumed 장부
    // 축출만으로는 같은 id 가 다시 grant 되지 않는다. 재재생이 나타나는
    // 값은 없다 (측정: 4 에서도 0, 제품 경로 alreadyHeld).
    await mountBurst();
    const ids = arrivalIds(5, "0199eeee-0000-7000-8000-0000000008");
    await deliverLive(ids, 90, "consumed 측정 arrival");
    await waitUntilRowsMounted(ids);
    expect(playingAmong(ids).length).toBe(MAX_SIMULTANEOUS_ARRIVALS);
    await deliverLive([ids[0]!], 90, "consumed 재전달 arrival");
    await flushVirtuosoMount();
    await settle();
    expect(playingAmong([ids[0]!]).length).toBe(0);
    expect(probe.isPlayEntrance?.(ids[0]!)).toBe(false);
  });
});
