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
import { createLocaleService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleContext } from "@/i18n/localeContext";
import type { AppLocale } from "@/i18n/localeStore";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import { ExpressionsContext } from "@/features/expressions/context";
import type { ExpressionTransport } from "@/features/expressions/transport";

// =============================================================================
// 입력창 위의 이모티콘 미리 보기 (#5453, owner 2026-11-07, 카카오톡 레퍼런스).
//
//   · 이모티콘 창에서 큰 그림을 고르면 입력창 **위에** 그림과 작은 ✕ 만 선다. 보이는 안내 글은 없다(낭독 이름만 있다).
//   · 보내기 단추 · ↵ 가 글과 함께 보낸다(`onSend(글, { expression })`). 글이 비어도 그림만 나간다. 그림도 글도 첨부도 없으면 보내기는 잠겨 있다.
//   · ✕ · Esc 는 미리 보기를 치우고 포커스를 입력칸에 돌려준다. 보낸 뒤에도 미리 보기가 사라진다.
//   · 고른 뒤 그 그림이 숨겨졌거나 지워졌으면 보내기는 막히고 그림 자리에 한 문장이 선다(몰래 그림만 빼고 보내지 않는다).
// 순서와 멱등(표현 메시지 → 글 메시지)은 코어 `sendBundle` 시험과 `useTimeline.expressionBundle.test.tsx` 가 잰다.
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
const CHEERS = { ...FIXTURE_EXPRESSIONS[1], id: "00000000-0000-4000-8000-000000000051", name: "cheers_still", displayName: "건배", tags: ["축하"], media: STILL };
let library = [CHEERS];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let store: ExpressionStore | null = null;
const onSend = vi.fn();

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
  library = [CHEERS];
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
      if (request.method === "GET" && /\/expressions(\?|$)/.test(request.path)) {
        return { workspaceId: FIXTURE_WORKSPACE_ID, version: String(library.length + 8), baseVersion: null, reset: true, addPolicy: "members", items: library };
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
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

async function mount(channelId = CH): Promise<HTMLElement> {
  store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, libraryTransport());
  await store.refresh();
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
  await rerenderWith(channelId);
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}
let rerenderWith: (id: string) => Promise<void> = async () => undefined;

const q = <T extends HTMLElement = HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);
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
async function press(init: KeyboardEventInit): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    textarea().dispatchEvent(event);
  });
  return event.defaultPrevented;
}
async function click(element: Element | null) {
  await act(async () => {
    (element as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** 이모티콘 창을 열어 이모티콘 탭의 「건배」를 고른다(진짜 길: 단추 → 고르개 → 탭 → 항목). */
async function pickCheers() {
  await click(q("composer-emoji-trigger"));
  await settle();
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[aria-label='표현 종류'] button"));
  await click(tabs.find((tab) => tab.textContent === "이모티콘") ?? null);
  await settle();
  await click(document.querySelector("[aria-label='건배 메시지에 넣기']"));
  await settle();
}
const sendButton = () => q<HTMLButtonElement>("composer-send");

describe("고르면 입력창 위에 그림과 ✕ 만 선다", () => {
  it("미리 보기에는 그림과 작은 ✕ 뿐이고 보이는 글이 없다 — 이름은 낭독용으로만 있다. 글에는 `:이름:`이 들어가지 않는다", async () => {
    await mount();
    expect(q("composer-expression-preview")).toBeNull();
    await pickCheers();
    const preview = q("composer-expression-preview");
    expect(preview).not.toBeNull();
    // 고른 그림은 글칸으로 들어가지 않는다.
    expect(textarea().value).toBe("");
    // 보이는 안내 글이 없다: 버튼 하나(✕)와 그림 상자뿐이고, 그림이 오기 전 자리표시(`:이름:`) 말고는 글자가 없다.
    expect(Array.from(preview!.querySelectorAll("button"))).toHaveLength(1);
    const cancel = q("composer-expression-preview-cancel");
    expect(cancel?.getAttribute("aria-label")).toBe("건배 미리 보기 지우기");
    expect(cancel?.textContent).toBe("");
    expect(preview!.getAttribute("aria-label")).toBe("보낼 이모티콘");
    const visible = (preview!.textContent ?? "").replace(":cheers_still:", "");
    expect(visible).toBe("");
    // 입력칸은 그대로 쓸 수 있고 포커스가 거기로 돌아온다.
    expect(document.activeElement).toBe(textarea());
  });

  it("그림이 있으면 글이 비어도 보내기가 열려 있고, 없으면 잠겨 있다", async () => {
    await mount();
    expect(sendButton()?.disabled).toBe(true);
    await pickCheers();
    expect(sendButton()?.disabled).toBe(false);
    await click(q("composer-expression-preview-cancel"));
    expect(q("composer-expression-preview")).toBeNull();
    expect(sendButton()?.disabled).toBe(true);
  });

  it("보내기 단추 한 번으로 글과 그림이 함께 간다 — 글을 다듬어 보내고, 입력창과 미리 보기가 함께 비워진다", async () => {
    await mount();
    await pickCheers();
    await type("  오늘 점심 같이 가요  ");
    await click(sendButton());
    expect(onSend).toHaveBeenCalledTimes(1);
    const [body, options] = onSend.mock.calls[0] as [string, { expression?: { name: string } }];
    expect(body).toBe("오늘 점심 같이 가요");
    expect(options.expression?.name).toBe("cheers_still");
    expect(q("composer-expression-preview")).toBeNull();
    expect(textarea().value).toBe("");
  });

  it("↵ 도 같다. 글이 비면 그림만 나간다(빈 글, 그림 하나)", async () => {
    await mount();
    await pickCheers();
    expect(await press({ key: "Enter" })).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    const [body, options] = onSend.mock.calls[0] as [string, { expression?: { name: string } }];
    expect(body).toBe("");
    expect(options.expression?.name).toBe("cheers_still");
    expect(q("composer-expression-preview")).toBeNull();
  });

  it("그림 없이 글만 보내면 예전과 같은 요청이다(`expression` 키가 없다)", async () => {
    await mount();
    await type("그냥 글");
    await press({ key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("그냥 글");
    expect(onSend.mock.calls[0]?.[1]).not.toHaveProperty("expression");
  });
});

describe("지우기와 키보드", () => {
  it("✕ 를 누르면 그림이 사라지고 포커스가 입력칸에 돌아오며, 쓴 글은 그대로다", async () => {
    await mount();
    await pickCheers();
    await type("쓰던 글");
    await click(q("composer-expression-preview-cancel"));
    expect(q("composer-expression-preview")).toBeNull();
    expect(textarea().value).toBe("쓰던 글");
    expect(document.activeElement).toBe(textarea());
    expect(onSend).not.toHaveBeenCalled();
  });

  it("입력칸에서 Esc 는 미리 보기를 치운다. 한 번 더 누르면 그 아래(인용 등)로 내려간다 - 여기서는 아무것도 없어 키가 지나간다", async () => {
    await mount();
    await pickCheers();
    expect(await press({ key: "Escape" })).toBe(true);
    expect(q("composer-expression-preview")).toBeNull();
    expect(await press({ key: "Escape" })).toBe(false);
  });

  it("✕ 에 초점이 있을 때의 Esc 도 같다", async () => {
    await mount();
    await pickCheers();
    const cancel = q<HTMLButtonElement>("composer-expression-preview-cancel")!;
    await act(async () => {
      cancel.focus();
      cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(q("composer-expression-preview")).toBeNull();
    expect(document.activeElement).toBe(textarea());
  });

  it("대화를 옮기면 미리 보기는 따라가지 않는다 - 고른 그림은 이 대화의 것이다", async () => {
    await mount(CH);
    await pickCheers();
    expect(q("composer-expression-preview")).not.toBeNull();
    await rerenderWith(CH_B);
    await settle();
    expect(q("composer-expression-preview")).toBeNull();
  });
});

describe("고른 그림이 그 사이 사라졌을 때", () => {
  it("숨겨졌거나 지워졌으면 보내기는 막히고 그림 자리에 한 문장이 선다 - 그림만 빼고 몰래 보내지 않는다", async () => {
    await mount();
    await pickCheers();
    await type("글은 있어요");
    expect(sendButton()?.disabled).toBe(false);
    // 관리자가 그림을 지웠다: 보관함의 새 목록에 그 등록이 숨겨진 채로 온다.
    library = [{ ...CHEERS, status: "hidden", media: null } as unknown as typeof CHEERS];
    await act(async () => {
      await store!.refresh();
    });
    const gone = q("composer-expression-preview-gone");
    expect(gone?.textContent).toBe("이 표현을 지금 쓸 수 없어요. 다시 골라 주세요.");
    expect(gone?.getAttribute("role")).toBe("alert");
    expect(sendButton()?.disabled).toBe(true);
    expect(await press({ key: "Enter" })).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    // ✕ 로 치우면 글만 보낼 수 있다.
    await click(q("composer-expression-preview-cancel"));
    expect(sendButton()?.disabled).toBe(false);
    await press({ key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[1]).not.toHaveProperty("expression");
  });
});
