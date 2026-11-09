// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, type ReactElement } from "react";
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
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import { ExpressionsContext } from "@/features/expressions/context";
import { mutedKeywords, resetSuggestMuteForTest } from "@momo/core/features/expressions/suggestMute";
import { readExpressionSuggestOn, resetExpressionSuggestOnForTest, writeExpressionSuggestOn } from "@/features/expressions/suggestSetting";
import { ExpressionSuggestRow } from "@/features/settings/appearance/ExpressionSuggestRow";
import type { ExpressionTransport } from "@/features/expressions/transport";

// =============================================================================
// 입력창 위의 이모티콘 추천 줄 (#5476, #5454 2단계, owner 2026-11-07 「안내 글 없이 카카오톡처럼」).
//
//   · 글을 치다 0.3초 멈추면 문구 안의 낱말(짧은 글이면 글 전체도)이 꼬리표·이름과 맞는 큰 이모티콘·GIF 가 입력창 바로 위에 뜬다. 여러 낱말이면 낱말이 나온 차례로 한 줄에 함께
//     선다(#5588). 안 맞으면 줄이 없다. 계속 치면 사라진다.
//   · 누르면 입력창 위 미리 보기에 올라간다. **저절로 보내지 않는다.** 글이 그 낱말뿐이면 글을 지워 그림으로 바꾸고(보내면 그림만), 문구면 글을 두고 그림을 더한다(#5588).
//     입력칸의 Enter 는 줄이 떠 있어도 보내기 그대로이고 추천을 고르지 않는다.
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
import { clearDraft, readDraft } from "@/features/chat/draftStore";
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
const JINSIM = make(67, "sincere_dog", "진심멍", ["진심"]);
const LIBRARY = [KEUK, PPANG, TINY, SIGH, HUNGRY, KING, CHEERS, JINSIM];
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
  resetExpressionSuggestOnForTest();
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
async function mount(options: { channelId?: string; fake?: boolean; seed?: () => void; extra?: ReactElement } = {}): Promise<void> {
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
            createElement(OpenAgentProfileContext.Provider, { value: () => undefined }, createElement(SessionProvider, { value: session() }, composer(id), options.extra))
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

  it("계속 치면 줄이 그 순간 사라지고, 다시 멈추면 새 글로 다시 맞춘다 - 문구 안의 낱말도 모두 맞춘다(#5588)", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    expect(row()).not.toBeNull();
    // 한 글자라도 더 치면 시계를 흘리지 않았는데도 사라진다.
    await type("ㅋㅋㅋ 오늘 점심은");
    expect(row()).toBeNull();
    // 멈추면 새 글로 다시 맞춘다: 「오늘」·「점심은」은 안 맞지만 문구 안의 「ㅋㅋㅋ」가 맞는다.
    await pause();
    expect(names()).toEqual(["키득 미리 보기에 올리기", "빵터짐 미리 보기에 올리기"]);
    await type("ㅋㅋㅋ 오늘 점심은 한숨");
    expect(row()).toBeNull();
    await pause();
    expect(names()).toEqual(["키득 미리 보기에 올리기", "빵터짐 미리 보기에 올리기", "한숨냥 미리 보기에 올리기"]);
  });

  it("「ㅋㅋ 개웃기네 진심」: ㅋㅋ 쪽과 진심 쪽이 낱말이 나온 차례로 한 줄에 함께 선다(맞지 않는 「개웃기네」는 자리가 없다)", async () => {
    await mount();
    await typeAndPause("ㅋㅋ 개웃기네 진심");
    expect(names()).toEqual(["키득 미리 보기에 올리기", "빵터짐 미리 보기에 올리기", "진심멍 미리 보기에 올리기"]);
    await typeAndPause("진심 개웃기네 ㅋㅋ");
    expect(names()).toEqual(["진심멍 미리 보기에 올리기", "키득 미리 보기에 올리기", "빵터짐 미리 보기에 올리기"]);
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
  const previewName = () => q("composer-expression-preview")?.querySelector("[data-expression-name]")?.getAttribute("data-expression-name") ?? null;

  it("글이 그 낱말뿐이면(「ㅋㅋㅋ!!」) 누르는 순간 글이 지워지고 그림이 미리 보기에 선다 - 저절로 보내지 않고, 보내기(Enter) 한 번에 글 없이 그림만 간다 (#5588)", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ!!");
    expect(readDraft(WS, CH)).toBe("ㅋㅋㅋ!!");
    await click(items()[1] ?? null);
    // 누른 바로 그 순간: 보내지 않았다(미리 보기 선택은 보내기가 아니다). 글은 그림으로 바뀌었다 - 입력칸도 초안도 비었다.
    expect(onSend).not.toHaveBeenCalled();
    expect(previewName()).toBe("kk_loud");
    expect(row()).toBeNull();
    expect(textarea().value).toBe("");
    expect(readDraft(WS, CH)).toBe("");
    expect(document.activeElement).toBe(textarea());
    // 저절로 보내지 않는다: 몇 초가 흘러도 요청이 없고 줄도 다시 서지 않는다.
    await wait(5000);
    expect(onSend).not.toHaveBeenCalled();
    expect(row()).toBeNull();
    // 보내기 한 번: 글은 비고 그림만 간다(표현 메시지 하나).
    expect(await press({ key: "Enter" })).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    const [body, options] = onSend.mock.calls[0] as [string, { expression?: { name: string } }];
    expect(body).toBe("");
    expect(options.expression?.name).toBe("kk_loud");
    expect(q("composer-expression-preview")).toBeNull();
  });

  it("낱말이 문구 안에 있으면(「ㅋㅋㅋ 개웃기네 진심」) 글은 그대로 두고 그림을 더한다 - 보내기 한 번에 글과 그림이 같이 간다 (#5588)", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ 개웃기네 진심");
    await click(items().find((button) => button.getAttribute("data-expression-id") === JINSIM.id) ?? null);
    expect(onSend).not.toHaveBeenCalled();
    expect(previewName()).toBe("sincere_dog");
    expect(row()).toBeNull();
    expect(textarea().value).toBe("ㅋㅋㅋ 개웃기네 진심");
    expect(readDraft(WS, CH)).toBe("ㅋㅋㅋ 개웃기네 진심");
    expect(document.activeElement).toBe(textarea());
    await wait(5000);
    expect(onSend).not.toHaveBeenCalled();
    expect(await press({ key: "Enter" })).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    const [body, options] = onSend.mock.calls[0] as [string, { expression?: { name: string } }];
    expect(body).toBe("ㅋㅋㅋ 개웃기네 진심");
    expect(options.expression?.name).toBe("sincere_dog");
    expect(q("composer-expression-preview")).toBeNull();
  });

  it("문구 줄의 ㅋㅋ 쪽 그림을 눌러도 문구는 그대로다 - 바꾸는 것은 글 전체가 그 그림의 낱말일 때뿐이다", async () => {
    await mount();
    await typeAndPause("ㅋㅋ 진심");
    await click(items()[0] ?? null);
    expect(previewName()).toBe("kk_giggle");
    expect(textarea().value).toBe("ㅋㅋ 진심");
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

  it("여러 낱말 줄의 ✕ 는 그림에 맞은 낱말들만 끈다 - 맞지 않은 「개웃기네」는 끄지 않는다 (#5588)", async () => {
    await mount();
    await typeAndPause("ㅋㅋ 개웃기네 진심");
    await click(muteButton());
    expect(row()).toBeNull();
    expect(mutedKeywords(`${WS}:${CH}`)).toEqual(["ㅋㅋ", "진심"]);
    // 같은 글도, 그 낱말 하나씩도 이 대화에서는 다시 뜨지 않는다. 다른 낱말은 뜬다.
    await typeAndPause("ㅋㅋ 개웃기네 진심!");
    expect(row()).toBeNull();
    await typeAndPause("진심");
    expect(row()).toBeNull();
    await typeAndPause("진심 한숨");
    expect(names()).toEqual(["한숨냥 미리 보기에 올리기"]);
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
    // 닫힘은 「이 글」에 대한 것이다: 닫은 뒤 글을 지웠다가 같은 낱말을 다시 치면 새로 맞춘다.
    await press({ key: "Escape" });
    expect(row()).toBeNull();
    await typeAndPause("");
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

describe("자리와 ↑ 의 첫 화면 줄 (#5489, 검증 7a-2 H1·M1)", () => {
  it("H1: 줄의 기준 상자는 독의 첫 자식이고 입력 폼 안에 있지 않다 - 폼 앞에 서는 레일·링크 카드·예약 배너를 덮지 않는 자리다", async () => {
    await mount();
    await typeAndPause("ㅋㅋㅋ");
    const dock = q("composer");
    const anchor = q("composer-expression-suggest-anchor");
    expect(anchor).not.toBeNull();
    expect(dock?.firstElementChild).toBe(anchor);
    expect(anchor?.parentElement).toBe(dock);
    expect(anchor?.contains(row())).toBe(true);
    // 폼 안이면 폼 앞의 줄들(레일·링크 카드·예약 배너) 위로 떨어진다.
    expect(row()?.closest("form")).toBeNull();
    // 기준 상자는 `relative`, 줄은 그 맨 위에서 위로 서는 절대 위치다(흐름에 자리를 먹지 않아 입력창이 움직이지 않는다).
    expect(anchor?.classList.contains("relative")).toBe(true);
    expect(row()?.classList.contains("absolute")).toBe(true);
    expect(row()?.classList.contains("bottom-full")).toBe(true);
    // 줄이 지면 기준 상자도 없다.
    await press({ key: "Escape" });
    expect(q("composer-expression-suggest-anchor")).toBeNull();
  });

  // 진짜 엔진: 위의 구조 단정은 「어디에 있는가」만 말한다. 줄 상자가 독 안의 줄들과 **겹치지 않는다**는 것은 배치가 말한다(jsdom 은 배치가 없다). 진짜 `Composer` 가 줄을 연 채
  // 그린 마크업과 `tokens.css` 컴파일 결과·`expressions.css` 를 Chromium·WebKit 에 올리고, 입력 폼 앞(독 안)에 레일(24)·링크 카드(88) 같은 높이의 줄을 세워 줄 상자와의 겹침 넓이를 잰다.
  // 사보타주: 줄을 다시 입력 폼 안으로 옮기면(옛 자리) 줄이 그 줄들 위로 떨어져 겹침이 0보다 커진다.
  it.skipIf(ENGINES.length === 0)(
    "H1: 독 안에 레일·링크 카드 높이의 줄이 서 있어도 줄 상자는 독 안 어느 줄과도 겹치지 않고, 줄이 서도 입력창·카드 자리가 그대로이며, 왼쪽이 카드 왼쪽과 같다 (1280 · 390)",
    async () => {
      await mount({ fake: false });
      await type("ㅋㅋㅋ");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, EXPRESSION_SUGGEST_DEBOUNCE_MS + 200));
      });
      expect(row()).not.toBeNull();
      const html = host?.innerHTML ?? "";
      const classes = [...(host?.querySelectorAll("[class]") ?? [])].flatMap((el) => [...el.classList]);
      const here = dirname(fileURLToPath(import.meta.url));
      const expressionsCss = readFileSync(join(here, "..", "expressions", "expressions.css"), "utf8");
      const css = await compileTokensCss(classes);
      const playwright = await import("playwright");
      const problems: string[] = [];
      const VIEWPORTS = [
        { name: "넓은 창 1280", width: 1280, leftExpected: 24 },
        { name: "폰 390", width: 390, leftExpected: 12 },
      ] as const;
      const FILLERS = [[], [24], [24, 88], [88]] as const;

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const viewport of VIEWPORTS) {
            const page = await browser.newPage({ viewport: { width: viewport.width, height: 900 } });
            try {
              for (const heights of FILLERS) {
                await page.setContent(`<!doctype html><html lang="ko"><head><style>${css}
${expressionsCss}
html, body { margin: 0; }
#column { width: ${viewport.width}px; padding-top: 320px; box-sizing: border-box; }
.filler-rail { height: 24px; }
.filler-card { height: 88px; }
</style></head><body class="bg-surface text-ink"><div id="column">${html}</div></body></html>`);
                // 입력칸에 포커스가 있어야 줄이 선다(밖이면 CSS 가 물린다).
                await page.focus('[data-testid="composer-input"]');
                await page.evaluate((list) => {
                  const dock = document.querySelector('[data-testid="composer"]');
                  const form = dock?.querySelector("form");
                  for (const height of list) {
                    const filler = document.createElement("div");
                    filler.className = height === 24 ? "filler-rail" : "filler-card";
                    dock?.insertBefore(filler, form ?? null);
                  }
                }, heights as readonly number[]);
                const measure = () =>
                  page.evaluate(() => {
                    const box = (el: Element | null) => {
                      const r = el?.getBoundingClientRect();
                      return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
                    };
                    const dock = document.querySelector('[data-testid="composer"]');
                    const anchor = document.querySelector('[data-testid="composer-expression-suggest-anchor"]');
                    return {
                      dock: box(dock),
                      card: box(document.querySelector('[data-testid="composer-frame"]')),
                      row: box(document.querySelector('[data-testid="composer-expression-suggest"]')),
                      children: [...(dock?.children ?? [])].filter((el) => el !== anchor).map((el) => box(el)).filter((b) => b !== null && b.h > 0),
                    };
                  });
                const withRow = await measure();
                const at = `${engine} ${viewport.name} 독 안 줄 ${JSON.stringify(heights)}`;
                const rowBox = withRow.row;
                if (rowBox === null || rowBox.w <= 0 || rowBox.h <= 0) {
                  problems.push(`${at}: 줄이 보이지 않는다(상자 ${JSON.stringify(rowBox)})`);
                  continue;
                }
                const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
                  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
                const worst = Math.max(0, ...withRow.children.map((child) => (child === null ? 0 : overlap(rowBox, child))));
                if (worst > 0) problems.push(`${at}: 줄 상자가 독 안 줄과 겹친다(넓이 ${worst}px²)`);
                const dockTop = withRow.dock?.y ?? 0;
                if (rowBox.y + rowBox.h > dockTop) problems.push(`${at}: 줄 아래(${rowBox.y + rowBox.h})가 독 맨 위(${dockTop})보다 아래다`);
                const cardLeft = withRow.card?.x ?? 0;
                if (Math.abs(rowBox.x - cardLeft) > 0.5 || Math.abs(rowBox.x - viewport.leftExpected) > 0.5) {
                  problems.push(`${at}: 줄 왼쪽 ${rowBox.x}, 카드 왼쪽 ${cardLeft}, 기대 ${viewport.leftExpected}`);
                }
                // 줄이 서도 입력창·카드가 움직이지 않는다: 기준 상자(와 줄)를 걷어 낸 배치와 같다.
                await page.evaluate(() => document.querySelector('[data-testid="composer-expression-suggest-anchor"]')?.remove());
                const withoutRow = await measure();
                if (JSON.stringify(withoutRow.dock) !== JSON.stringify(withRow.dock) || JSON.stringify(withoutRow.card) !== JSON.stringify(withRow.card)) {
                  problems.push(`${at}: 줄이 서자 독·카드 자리가 움직인다`);
                }
              }
            } finally {
              await page.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    180_000
  );

  it("M1: 줄바꿈 없이 길게 감긴 글의 아래 화면 줄에서 ↑ 는 줄로 가지 않고 글 안에서 움직이고, 첫 화면 줄에서만 줄로 들어간다", async () => {
    // jsdom 에는 배치가 없다: 거울의 표지만 앞 글 10자마다 한 줄(20px)로 내려가는 가짜 배치를 건다. 진짜 엔진의 감김은 `caretLine.browser.test.ts` 가 잰다.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const marked = this.parentElement?.hasAttribute("data-composer-format-mirror") === true;
      const top = marked ? Math.floor((this.previousSibling?.textContent ?? "").length / 10) * 20 : 0;
      return { x: 0, y: top, top, left: 0, right: 0, bottom: top + 16, width: 0, height: marked ? 16 : 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      await mount();
      const wrapped = "회의가 길어져서 오늘은 늦을 것 같아요 ㅋㅋㅋ"; // 줄바꿈이 없다(옛 판정은 이 글의 어느 줄에서도 ↑ 를 가로챘다)
      expect(wrapped.includes("\n")).toBe(false);
      await typeAndPause(wrapped);
      expect(row()).not.toBeNull();
      // 캐럿은 글 끝(가짜 배치로 셋째 화면 줄)이다: ↑ 는 우리 것이 아니라 textarea 의 것이다.
      expect(await press({ key: "ArrowUp" })).toBe(false);
      expect(document.activeElement).not.toBe(items()[0]);
      expect(row()).not.toBeNull();
      // 첫 화면 줄로 옮기면 줄로 들어간다.
      textarea().setSelectionRange(3, 3);
      expect(await press({ key: "ArrowUp" })).toBe(true);
      expect(document.activeElement).toBe(items()[0]);
    } finally {
      vi.restoreAllMocks();
    }
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

// 설정 › 모양 › 「이모티콘 추천」 (#5493, owner 2026-11-07 「설정에서 다 끌 수도 있어요」): 끄면 입력창에 줄이 서지 않고, 켜면 앱을 다시 켜지 않아도 바로 다시 선다.
// 값은 이 기기 · 이 워크스페이스 · 이 사람의 것이라 `oort.expressions.suggest:<워크스페이스>:<사람>` 에 있다. 설정 화면의 스위치와 입력창이 같은 모듈을 읽으므로 진짜 스위치를 눌러 잰다.
describe("설정에서 이모티콘 추천을 끄면 줄이 서지 않는다 (#5493)", () => {
  const SETTING_KEY = `oort.expressions.suggest:${FIXTURE_WORKSPACE_ID}:${FIXTURE_MEMBER_ID}`;
  const seedOff = () => localStorage.setItem(SETTING_KEY, JSON.stringify({ v: 1, workspaceId: FIXTURE_WORKSPACE_ID, memberId: FIXTURE_MEMBER_ID, on: false }));
  const switchControl = () => q<HTMLButtonElement>("expression-suggest-toggle");

  it("끈 채로 열면, 맞는 낱말을 쳐도 줄이 0이다 - 같은 글이 켜져 있으면 뜬다(대조)", async () => {
    await mount({ seed: seedOff });
    await typeAndPause("ㅋㅋㅋㅋ");
    expect(row()).toBeNull();
    expect(items()).toHaveLength(0);
    await pause();
    expect(row()).toBeNull(); // 기다림이 더 지나도 서지 않는다
    // 대조: 저장된 끔을 지우면(기본 켜짐) 같은 낱말에 줄이 선다. 위의 0이 「안 맞아서」가 아님을 보인다.
    await act(async () => {
      writeExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, true);
    });
    await pause();
    expect(names()).toEqual(["키득 미리 보기에 올리기", "빵터짐 미리 보기에 올리기"]);
  });

  it("설정 스위치를 누르면 떠 있던 줄이 그 순간 걷히고, 다시 누르면 이미 친 글에 0.3초 뒤 다시 선다 - 앱을 다시 켜지 않는다", async () => {
    await mount({ extra: createElement(ExpressionSuggestRow) });
    expect(switchControl()?.getAttribute("aria-checked")).toBe("true");
    await typeAndPause("ㅋㅋㅋㅋ");
    expect(row()).not.toBeNull();

    await click(switchControl());
    expect(switchControl()?.getAttribute("aria-checked")).toBe("false");
    expect(row()).toBeNull(); // 기다림 없이 바로
    expect(textarea().value).toBe("ㅋㅋㅋㅋ"); // 쓰던 글은 그대로
    await pause();
    expect(row()).toBeNull();
    // 끈 채로 글을 바꿔 쳐도 줄이 없다.
    await typeAndPause("한숨");
    expect(row()).toBeNull();
    expect(readExpressionSuggestOn(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID)).toBe(false);

    await click(switchControl());
    expect(switchControl()?.getAttribute("aria-checked")).toBe("true");
    expect(row()).toBeNull(); // 켜도 0.3초는 기다린다
    await pause();
    expect(names()).toEqual(["한숨냥 미리 보기에 올리기"]);
  });

  it("다른 사람이 끈 값은 이 입력창을 끄지 않는다 - 값은 이 사람의 것이다", async () => {
    await mount({
      seed: () => localStorage.setItem(`oort.expressions.suggest:${FIXTURE_WORKSPACE_ID}:someone-else`, JSON.stringify({ v: 1, workspaceId: FIXTURE_WORKSPACE_ID, memberId: "someone-else", on: false })),
    });
    await typeAndPause("한숨");
    expect(names()).toEqual(["한숨냥 미리 보기에 올리기"]);
  });
});
