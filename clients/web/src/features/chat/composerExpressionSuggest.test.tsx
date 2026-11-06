// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import { EXPRESSION_SUGGEST_DEBOUNCE_MS } from "@momo/core/features/expressions/suggest";
import { createLocaleService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import { ExpressionsContext } from "@/features/expressions/context";
import { resetSuggestMuteForTest } from "@/features/expressions/suggestMute";
import type { ExpressionTransport } from "@/features/expressions/transport";

// =============================================================================
// 입력창 위의 이모티콘 추천 줄 (#5476, #5454 2단계, owner 2026-11-07 「안내 글 없이 카카오톡처럼」).
//
//   · 글을 치다 0.3초 멈추면 마지막 낱말(짧은 글이면 글 전체)이 꼬리표·이름과 맞는 큰 이모티콘·GIF 가 입력창 바로 위에 뜬다. 안 맞으면 줄이 없다. 계속 치면 사라진다.
//   · 누르면 입력창 위 미리 보기에 올라간다. **저절로 보내지 않는다.** 입력칸의 Enter 는 줄이 떠 있어도 보내기 그대로이고 추천을 고르지 않는다.
//   · ✕ 는 이 대화에서 그 낱말(들)의 추천을 끈다. Esc 는 줄만 닫는다. ↑(첫 줄)로 줄에 들어가 ← → Home End 로 움직인다.
//   · 맞추기는 기기 안에서만 한다: 입력한 글은 어떤 요청에도 실리지 않는다.
// 맞추기 규칙(정리·끝말·순서)은 코어 `suggest.test.ts` 가 재고, 키 뜻은 코어 `composerKeys.test.ts` 가 잰다. 여기서는 진짜 `Composer` 를 올려 배선을 잰다.
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
  createAttachmentUpload: vi.fn(),
  completeAttachmentUpload: vi.fn(),
  fetchWorkHosts: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

const transport = vi.hoisted(() => ({ putAttachmentBytes: vi.fn() }));
vi.mock("@/features/attachments/uploadTransport", () => transport);

import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { resetAttachmentDraftsForTest } from "@/features/attachments/draftStore";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { clearDraft } from "@/features/chat/draftStore";
import { Composer } from "./Composer";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const CH_B = "00000000-0000-7000-8000-000000000202";
const CHANNELS: Channel[] = [
  { id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false } as Channel,
  { id: CH_B, workspaceId: WS, kind: "public", name: "잡담", muted: false } as Channel,
];

const STILL = { small: { ...FIXTURE_MEDIA.png.image }, large: { ...FIXTURE_MEDIA.png.image }, thumb: { ...FIXTURE_MEDIA.png.image } };
const MOVING = { small: { ...FIXTURE_MEDIA.gif.image }, large: { ...FIXTURE_MEDIA.gif.image }, thumb: { ...FIXTURE_MEDIA.png.image } };
const idOf = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const make = (n: number, name: string, displayName: string, tags: string[], extra: Record<string, unknown> = {}) =>
  ({ ...FIXTURE_EXPRESSIONS[1], id: idOf(n), name, displayName, tags, media: STILL, ...extra }) as (typeof FIXTURE_EXPRESSIONS)[number];

// 11-06 에 등록한 그림처럼 꼬리표가 여러 개다. 「빵터짐」은 꼬리표를 「ㅋㅋㅋ」로 달았어도(반복 줄이기) 「ㅋㅋ」에 맞고, GIF 이다.
const KEUK = make(61, "kk_giggle", "키득", ["ㅋㅋ", "웃음"]);
const PPANG = make(62, "kk_loud", "빵터짐", ["ㅋㅋㅋ"], { media: MOVING });
const TINY = make(63, "kk_tiny", "작은 웃음", ["ㅋㅋ"], { kind: "emoji" });
const SIGH = make(64, "sigh_cat", "한숨냥", ["한숨"]);
const HUNGRY = make(65, "hungry_bear", "배고픈 곰", ["배고픔"]);
const KING = make(66, "king_bat", "킹받네곰", ["킹받네"]);
const CHEERS = make(51, "cheers_still", "건배", ["축하"]);
const LIBRARY = [KEUK, PPANG, TINY, SIGH, HUNGRY, KING, CHEERS];
let library: typeof LIBRARY = LIBRARY;

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let store: ExpressionStore | null = null;
const onSend = vi.fn();
const jsonCalls: string[] = [];
const imageCalls: string[] = [];
let listFails = false;
let listNeverArrives = false;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue([]);
  api.fetchWorkHosts.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  transport.putAttachmentBytes.mockReset();
  onSend.mockReset();
  library = LIBRARY;
  jsonCalls.length = 0;
  imageCalls.length = 0;
  listFails = false;
  listNeverArrives = false;
  resetSuggestMuteForTest();
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  clearDraft(WS, CH);
  clearDraft(WS, CH_B);
  localStorage.clear();
  onlineManager.setOnline(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => {}, configurable: true, writable: true });
});
afterEach(() => {
  vi.useRealTimers();
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

function session(): SessionContextValue {
  return {
    session: { accessToken: "a", refreshToken: "r", member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" } },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function libraryTransport(): ExpressionTransport {
  return {
    async json(request) {
      jsonCalls.push(`${request.method} ${request.path}`);
      if (listNeverArrives) return new Promise(() => undefined);
      if (listFails) throw new Error("list failed");
      if (request.method === "GET" && /\/expressions(\?|$)/.test(request.path)) {
        return { workspaceId: FIXTURE_WORKSPACE_ID, version: String(library.length + 8), baseVersion: null, reset: true, addPolicy: "members", items: library };
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    },
    async image(path) {
      imageCalls.push(path);
      return `data:image/png;base64,${FIXTURE_MEDIA.png.bodyBase64}`;
    },
  };
}

async function koLocale(): Promise<AppLocale> {
  const context = resolveLocaleContext("ko-KR", { languages: ["ko-KR"], timeZone: "Asia/Seoul" });
  const service = createLocaleService({ ...context, catalog: await loadMessageCatalog("ko-KR") });
  return { service, getSnapshot: () => service.context, subscribe: () => () => undefined } as unknown as AppLocale;
}

function composer(channelId: string) {
  return createElement(Composer, {
    workspaceId: WS,
    channelId,
    directory: makeDirectory([]),
    channels: CHANNELS,
    channelLabel: "일반",
    recipient: "place",
    dmAgent: null,
    quote: null,
    onCancelQuote: () => undefined,
    onSend,
  });
}

/**
 * 입력창을 올린다. 보관함 읽기까지 끝난 **뒤에** 가짜 시계를 건다(`fake`): 0.3초 기다림을 시계로 정확히 잰다. 가짜 시계는 `setTimeout`·`clearTimeout` 만 건다 -
 * 약속(마이크로태스크)은 그대로 흘러서 그림 바이트 읽기가 `flush` 한 번에 끝난다.
 */
async function mount(options: { channelId?: string; fake?: boolean; seed?: () => void } = {}): Promise<void> {
  options.seed?.();
  store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, libraryTransport());
  void store.refresh();
  const locale = await koLocale();
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const tree = (id: string) =>
    createElement(
      LocaleContext.Provider,
      { value: locale },
      createElement(
        ExpressionsContext.Provider,
        { value: store },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            MemoryRouter,
            { initialEntries: [`/c/${id}`] },
            createElement(OpenAgentProfileContext.Provider, { value: () => undefined }, createElement(SessionProvider, { value: session() }, composer(id)))
          )
        )
      )
    );
  rerenderWith = async (id: string) => {
    await act(async () => {
      mountedRoot?.render(tree(id));
    });
  };
  await rerenderWith(options.channelId ?? CH);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  if (options.fake !== false) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}
let rerenderWith: (id: string) => Promise<void> = async () => undefined;

const q = <T extends HTMLElement = HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);
const qa = <T extends HTMLElement = HTMLElement>(testId: string): T[] => Array.from(document.querySelectorAll<T>(`[data-testid="${testId}"]`));
const row = () => q("composer-expression-suggest");
const items = () => qa<HTMLButtonElement>("composer-expression-suggest-item");
const muteButton = () => q<HTMLButtonElement>("composer-expression-suggest-mute");
const names = () => items().map((button) => button.getAttribute("aria-label"));
const sendButton = () => q<HTMLButtonElement>("composer-send");
function textarea(): HTMLTextAreaElement {
  return document.querySelector("textarea") as HTMLTextAreaElement;
}
async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(init: KeyboardEventInit, target: HTMLElement = textarea()): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}
async function click(element: Element | null) {
  await act(async () => {
    (element as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
/** 가짜 시계를 `ms` 만큼 흘린다(기다림이 끝나는 순간의 상태 갱신과 그림 바이트 읽기까지). */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const pause = () => wait(EXPRESSION_SUGGEST_DEBOUNCE_MS);
/** 글을 치고 0.3초 멈춘다. */
async function typeAndPause(value: string) {
  await type(value);
  await pause();
}
const realWait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe("글을 치다 멈추면 맞는 그림이 입력창 위에 뜬다", () => {
  it("「ㅋㅋㅋㅋ」: 0.3초가 차기 전에는 없고 차면 큰 이모티콘과 GIF 가 뜬다 - 작은 이모지는 뜨지 않는다", async () => {
    await mount();
    await type("ㅋㅋㅋㅋ");
    await wait(EXPRESSION_SUGGEST_DEBOUNCE_MS - 1);
    expect(row()).toBeNull();
    await wait(1);
    expect(row()).not.toBeNull();
    // 꼬리표가 정확히 맞은 둘(이름순): 키득(이모티콘), 빵터짐(GIF, 꼬리표 「ㅋㅋㅋ」도 같은 낱말). 작은 이모지 「작은 웃음」은 같은 꼬리표여도 없다.
    expect(names()).toEqual(["키득 미리 보기에 올리기", "빵터짐 미리 보기에 올리기"]);
    expect(muteButton()).not.toBeNull();
  });

  it.each([
    ["한숨", ["한숨냥 미리 보기에 올리기"]],
    ["배고파", ["배고픈 곰 미리 보기에 올리기"]],
  ])("「%s」: 맞는 그림이 뜬다 (「배고파」는 꼬리표 「배고픔」과 끝말 정리표로 맞는다)", async (input, expected) => {
    await mount();
    await typeAndPause(input);
    expect(names()).toEqual(expected);
  });

  it("안 맞는 입력에는 줄이 없다 - 맞지 않는 그림으로 채우지 않는다", async () => {
    await mount();
    await typeAndPause("점심 뭐 먹지");
    expect(row()).toBeNull();
    await typeAndPause("   ");
    expect(row()).toBeNull();
    await typeAndPause("ㅋ");
    expect(row()).toBeNull();
  });

  // 이름순으로는 키득 → 빵터짐이다. 즐겨찾기(빵터짐)는 같은 칸 안에서 앞서고, 최근 쓴 것(키득)은 그보다 더 앞선다. 둘 다 순서만 바꾼다: 맞지 않는 그림을 채우지 않는다.
  const seedFavorite = () =>
    localStorage.setItem(
      `oort.expressions.favorites:${FIXTURE_WORKSPACE_ID}:${FIXTURE_MEMBER_ID}`,
      JSON.stringify({ v: 1, workspaceId: FIXTURE_WORKSPACE_ID, memberId: FIXTURE_MEMBER_ID, ids: [PPANG.id, CHEERS.id] })
    );
  const seedRecent = () =>
    localStorage.setItem(
      `oort.expressions.usage:${FIXTURE_WORKSPACE_ID}:${FIXTURE_MEMBER_ID}`,
      JSON.stringify({ v: 1, workspaceId: FIXTURE_WORKSPACE_ID, memberId: FIXTURE_MEMBER_ID, entries: [{ id: KEUK.id, count: 1, lastUsedAtMs: 1793314800000 }] })
    );

  it("즐겨찾기한 그림이 같은 칸에서 앞서고, 즐겨찾기라도 맞지 않는 그림(건배)은 채우지 않는다", async () => {
    await mount({ seed: seedFavorite });
    await typeAndPause("ㅋㅋ");
    expect(names()).toEqual(["빵터짐 미리 보기에 올리기", "키득 미리 보기에 올리기"]);
  });

  it("최근 쓴 그림이 즐겨찾기보다도 앞선다", async () => {
    await mount({
      seed: () => {
        seedFavorite();
        seedRecent();
      },
    });
    await typeAndPause("ㅋㅋ");
    expect(names()).toEqual(["키득 미리 보기에 올리기", "빵터짐 미리 보기에 올리기"]);
  });

  it("계속 치면 줄이 그 순간 사라지고, 다시 멈추면 새 글로 다시 맞춘다", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    expect(row()).not.toBeNull();
    // 한 글자라도 더 치면 시계를 흘리지 않았는데도 사라진다.
    await type("ㅋㅋㅋ 오늘 점심은");
    expect(row()).toBeNull();
    await pause();
    expect(row()).toBeNull();
    await typeAndPause("ㅋㅋㅋ 오늘 점심은 한숨");
    expect(names()).toEqual(["한숨냥 미리 보기에 올리기"]);
  });

  it.each([
    ["보관함이 비어 있다", () => { library = []; }],
    ["보관함을 읽지 못했다", () => { listFails = true; }],
    ["보관함이 아직 오지 않았다", () => { listNeverArrives = true; }],
  ])("%s: 줄이 없다 (보일 그림이 없다)", async (_label, arrange) => {
    arrange();
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    expect(row()).toBeNull();
  });

  it("오프라인이면 줄이 없고, 돌아오면 이어서 맞춘다 (그림 바이트를 받을 수 없다)", async () => {
    await mount();
    act(() => store!.setOffline(true));
    await typeAndPause("ㅋㅋㅋ");
    expect(row()).toBeNull();
    act(() => store!.setOffline(false));
    await pause();
    expect(row()).not.toBeNull();
  });

  it("멘션·채널·`/` 명령을 치는 중에는 줄이 없다", async () => {
    await mount();
    await typeAndPause("@ㅋㅋㅋ");
    expect(row()).toBeNull();
    await typeAndPause("/ㅋㅋㅋ");
    expect(row()).toBeNull();
    await typeAndPause("#ㅋㅋㅋ");
    expect(row()).toBeNull();
  });

  it("이미 미리 보기에 그림이 올라가 있으면 줄이 서지 않는다 (보내기 한 번에 큰 그림은 하나)", async () => {
    await mount({ fake: false });
    await click(q("composer-emoji-trigger"));
    await realWait(30);
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[aria-label='표현 종류'] button"));
    await click(tabs.find((tab) => tab.textContent === "이모티콘") ?? null);
    await realWait(30);
    await click(document.querySelector("[aria-label='건배 메시지에 넣기']"));
    await realWait(30);
    expect(q("composer-expression-preview")).not.toBeNull();
    await type("ㅋㅋㅋ");
    await realWait(EXPRESSION_SUGGEST_DEBOUNCE_MS + 100);
    expect(row()).toBeNull();
  });
});

describe("누르면 미리 보기에 올라가고, 저절로 보내지 않는다", () => {
  it("그림을 누르면 입력창 위 미리 보기에 올라가고 줄이 닫히며 글과 포커스는 그대로다 - 시간이 지나도 보내지 않고, 보내기(Enter) 한 번에 글과 같이 간다", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    await click(items()[1] ?? null);
    const preview = q("composer-expression-preview");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector("[data-expression-name]")?.getAttribute("data-expression-name")).toBe("kk_loud");
    expect(row()).toBeNull();
    expect(textarea().value).toBe("ㅋㅋㅋ");
    expect(document.activeElement).toBe(textarea());
    // 저절로 보내지 않는다: 몇 초가 흘러도, 줄이 닫힌 글을 그대로 두어도 요청이 없다.
    await wait(5000);
    expect(onSend).not.toHaveBeenCalled();
    expect(row()).toBeNull();
    // 보내기는 글과 같이 한 번이다.
    expect(await press({ key: "Enter" })).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    const [body, options] = onSend.mock.calls[0] as [string, { expression?: { name: string } }];
    expect(body).toBe("ㅋㅋㅋ");
    expect(options.expression?.name).toBe("kk_loud");
    expect(q("composer-expression-preview")).toBeNull();
  });

  it("줄이 떠 있어도 Enter 는 보내기 그대로다 - 추천을 고르지 않는다 (글만 나가고 그림은 없다)", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    expect(row()).not.toBeNull();
    expect(await press({ key: "Enter" })).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("ㅋㅋㅋ");
    expect(onSend.mock.calls[0]?.[1]).not.toHaveProperty("expression");
    expect(q("composer-expression-preview")).toBeNull();
    // 보낸 글은 비워지고 줄도 함께 사라진다.
    expect(textarea().value).toBe("");
    expect(row()).toBeNull();
  });
});

describe("✕ 는 이 대화에서 그 낱말의 추천을 끈다", () => {
  it("끄면 줄이 사라지고, 같은 낱말(정리하면 같은 글)은 이 대화에서 다시 뜨지 않는다 - 다른 낱말과 다른 대화에서는 뜬다", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    await click(muteButton());
    expect(row()).toBeNull();
    expect(textarea().value).toBe("ㅋㅋㅋ");
    expect(document.activeElement).toBe(textarea());
    // 같은 낱말: 반복 수가 달라도(정리하면 「ㅋㅋ」) 다시 뜨지 않는다.
    await typeAndPause("ㅋㅋㅋㅋㅋ");
    expect(row()).toBeNull();
    // 다른 낱말은 뜬다.
    await typeAndPause("한숨");
    expect(names()).toEqual(["한숨냥 미리 보기에 올리기"]);
    // 다른 대화에서는 계속 뜬다. 돌아오면 이 대화는 여전히 꺼져 있다(대화를 옮겨도 기억한다).
    await rerenderWith(CH_B);
    await typeAndPause("ㅋㅋㅋ");
    expect(row()).not.toBeNull();
    await rerenderWith(CH);
    await typeAndPause("ㅋㅋㅋ");
    expect(row()).toBeNull();
  });

  it("줄이 글 전체 낱말로 떴을 때는 그 낱말까지 끈다 (「킹 받네」 → 꼬리표 「킹받네」: 나중에 「킹받네」만 쳐도 다시 뜨지 않는다)", async () => {
    await mount();
    await typeAndPause("킹 받네");
    expect(names()).toEqual(["킹받네곰 미리 보기에 올리기"]);
    await click(muteButton());
    expect(row()).toBeNull();
    await typeAndPause("킹받네");
    expect(row()).toBeNull();
  });
});

describe("키보드", () => {
  it("↑ 로 줄에 들어가 ← → Home End 로 움직이고, 탭 정거장은 하나다", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    const [first, second] = items();
    // 줄 밖에서는 첫 그림이 정거장이고 나머지(그림 하나와 ✕)는 -1 이다.
    expect([first, second, muteButton()].map((button) => button?.tabIndex)).toEqual([0, -1, -1]);
    expect(await press({ key: "ArrowUp" })).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(await press({ key: "ArrowRight" }, first)).toBe(true);
    expect(document.activeElement).toBe(second);
    expect([first, second, muteButton()].map((button) => button?.tabIndex)).toEqual([-1, 0, -1]);
    expect(await press({ key: "ArrowRight" }, second)).toBe(true);
    expect(document.activeElement).toBe(muteButton());
    // 끝에서 돌아 나가지 않는다.
    await press({ key: "ArrowRight" }, muteButton()!);
    expect(document.activeElement).toBe(muteButton());
    await press({ key: "Home" }, muteButton()!);
    expect(document.activeElement).toBe(first);
    await press({ key: "End" }, first);
    expect(document.activeElement).toBe(muteButton());
    // Enter 는 포커스가 놓인 단추의 것이다: 줄이 가로채지 않는다(브라우저가 누름으로 바꾼다).
    expect(await press({ key: "Enter" }, second)).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("줄 안의 Esc 는 줄만 닫고 입력칸으로 돌아온다 - 글도 낱말도 그대로라, 다시 치면 다시 뜬다. ↓ 는 줄을 닫지 않고 입력칸으로 돌아간다", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    await press({ key: "ArrowUp" });
    expect(await press({ key: "ArrowDown" }, document.activeElement as HTMLElement)).toBe(true);
    expect(document.activeElement).toBe(textarea());
    expect(row()).not.toBeNull();
    await press({ key: "ArrowUp" });
    expect(await press({ key: "Escape" }, document.activeElement as HTMLElement)).toBe(true);
    expect(row()).toBeNull();
    expect(document.activeElement).toBe(textarea());
    expect(textarea().value).toBe("ㅋㅋㅋ");
    // 같은 글에서는 닫힌 채이고, 글이 바뀌어 멈추면 다시 맞춘다(낱말을 끈 것이 아니다).
    await pause();
    expect(row()).toBeNull();
    await typeAndPause("ㅋㅋㅋㅋ");
    expect(row()).not.toBeNull();
  });

  it("입력칸의 Esc 도 줄만 닫는다 - 한 번 더 누르면 아래(링크 카드·미리 보기·인용)로 내려가 여기서는 키가 지나간다", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    expect(await press({ key: "Escape" })).toBe(true);
    expect(row()).toBeNull();
    expect(textarea().value).toBe("ㅋㅋㅋ");
    expect(await press({ key: "Escape" })).toBe(false);
  });

  it("여러 줄 글에서 캐럿이 첫 줄이 아니면 ↑ 는 줄로 가지 않는다 (글을 ↑ 로 오르는 손을 가로채지 않는다)", async () => {
    await mount();
    await typeAndPause("첫 줄은 이렇게\nㅋㅋㅋ");
    expect(row()).not.toBeNull();
    expect(await press({ key: "ArrowUp" })).toBe(false);
    expect(document.activeElement).not.toBe(items()[0]);
    // 수식키가 붙은 ↑ 도 우리 것이 아니다.
    await typeAndPause("ㅋㅋㅋ");
    expect(await press({ key: "ArrowUp", altKey: true })).toBe(false);
    expect(await press({ key: "ArrowUp", shiftKey: true })).toBe(false);
  });
});

describe("기기 안에서만 맞춘다", () => {
  it("글을 치고 줄이 뜨고 고르고 끄는 동안 보관함 읽기 밖의 요청이 0이다 - 입력한 글은 어떤 요청에도 실리지 않는다", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await mount();
    const afterMount = jsonCalls.length;
    // 보관함 읽기 한 번(`GET /expressions`)은 마운트 때 이미 끝났다.
    expect(jsonCalls).toHaveLength(1);
    for (const word of ["ㅋㅋㅋ", "한숨", "배고파", "배고파 ㅋㅋㅋ 한숨"]) await typeAndPause(word);
    // 끄기(✕)와 고르기도 기기 안의 일이다.
    await typeAndPause("한숨");
    await click(muteButton());
    await typeAndPause("ㅋㅋㅋ");
    await click(items()[0] ?? null);
    await wait(5000);
    expect(jsonCalls.length).toBe(afterMount);
    // 이 입력칸이 이 기능과 상관없이 하는 요청(「작성 중」 신호 `typing/grant`, 승인 목록 읽기)은 있어도 된다: 어느 것도 글을 싣지 않는다. 친 글은 어떤 요청의 주소에도
    // 본문에도 없고, 표현 보관함을 읽거나 검색하는 요청이 `fetch` 로 나간 적도 없다(보관함 읽기는 위 주입한 전송으로만 한 번 갔다).
    const typedFragments = ["ㅋㅋ", "한숨", "배고파", encodeURIComponent("ㅋㅋ"), encodeURIComponent("한숨"), encodeURIComponent("배고파")];
    const outgoing = fetchSpy.mock.calls.map(([url, init]) => ({ url: String(url), body: (init as RequestInit | undefined)?.body ?? null }));
    for (const call of outgoing) {
      expect(call.body).toBeNull();
      for (const fragment of typedFragments) expect(call.url).not.toContain(fragment);
    }
    expect(outgoing.filter((call) => call.url.includes("/expressions"))).toEqual([]);
    // 그림 바이트는 보이는 그림의 것이다(보관함의 자산): 어느 요청 경로에도 친 글이 없다.
    expect(imageCalls.length).toBeGreaterThan(0);
    for (const path of imageCalls) {
      expect(path).toMatch(/\/expressions\/[0-9a-f-]+\/image/);
      for (const fragment of ["ㅋㅋ", "한숨", "배고파", encodeURIComponent("ㅋㅋ"), encodeURIComponent("한숨"), encodeURIComponent("배고파")]) expect(path).not.toContain(fragment);
    }
  });
});

describe("그림과 ✕ 뿐이다 - 안내 글이 없고 이름은 낭독용으로만 있다", () => {
  it("보이는 글자가 0이고, 줄·그림·✕ 는 접근성 이름을 갖는다", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    expect(row()?.getAttribute("role")).toBe("toolbar");
    expect(row()?.getAttribute("aria-label")).toBe("이모티콘 추천");
    expect(muteButton()?.getAttribute("aria-label")).toBe("이 낱말 추천 끄기");
    expect(names()).toEqual(["키득 미리 보기에 올리기", "빵터짐 미리 보기에 올리기"]);
    // 그림이 닿은 뒤: 글자가 없다(그림 자리표시 `:이름:` 은 그림이 오기 전과 실패할 때만 서고 그때는 CSS 가 숨긴다).
    expect(row()?.querySelectorAll("img")).toHaveLength(2);
    expect(row()?.textContent).toBe("");
    // 단추 말고 누를 것이 없고, 글자 단추가 없다.
    for (const button of Array.from(row()?.querySelectorAll("button") ?? [])) expect(button.textContent).toBe("");
    expect(row()?.querySelectorAll("button")).toHaveLength(3);
    expect(sendButton()).not.toBeNull();
  });
});
