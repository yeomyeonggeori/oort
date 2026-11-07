// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel } from "@momo/core/lib/api";
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
import type { UnfurlPreview } from "@momo/core/features/timeline/unfurl";

// =============================================================================
// 스레드 입력창도 이모티콘을 미리 보고 보내기 한 번에 보낸다 (#5487, 검증 7a H2). 채널 입력창(#5453, `composerExpressionPreview.test.tsx`)과 **같은 것을 같게**:
//
//   · 이모티콘 창에서 큰 그림을 고르면 입력창 위에 그림과 작은 ✕ 만 선다(글에 `:이름:`이 들어가지 않는다). 작은 이모지는 예전처럼 글 속 캐럿 자리에 들어간다.
//   · 보내기 한 번이 [큰 그림 답글, 글 답글]을 **같은 스레드로, 서로 다른 멱등 열쇠로, 그 순서로** 보낸다. 둘째는 첫째가 서버에 확정된 뒤에만 나간다.
//   · 첫째가 실패하면 둘째는 나가지 않는다: 미리 보기·글은 입력창에 남고 이유는 기존 실패 줄에 선다. 첫째는 되고 둘째만 실패하면 미리 보기는 비고 글은 남는다.
//   · 보이는 안내 문장은 없다(예전 「큰 그림으로 보내요 …」). 사람이 `:이름:`만 손으로 쳐도 같고, 그때 큰 그림으로 나가는 것은 그대로다.
//
// 진짜 `ThreadComposer`를 올리고 서버 호출(`sendThreadReply`)만 **손으로 여닫는다**: 약속을 시험이 풀어야 둘째가 나가므로 「첫째를 기다리지 않고 둘 다 쏘는」
// 구현은 `calls` 가 둘이 되어 붉다(곧바로 풀리는 가짜는 순서 규칙을 못 재서 통과해 버린다).
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
  sendThreadReply: vi.fn(),
  fetchUnfurlPreview: vi.fn(),
  fetchUnfurlImage: vi.fn(),
  createAttachmentUpload: vi.fn(),
  completeAttachmentUpload: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

const transport = vi.hoisted(() => ({ putAttachmentBytes: vi.fn() }));
vi.mock("@/features/attachments/uploadTransport", () => transport);

import { addFiles, resetAttachmentDraftsForTest, surfaceKey } from "@/features/attachments/draftStore";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { clearThreadDraft } from "@/features/chat/draftStore";
import { setLinkPreviewPreference } from "@/features/timeline/linkPreviewPreference";
import { resetUnfurlImagesForTest } from "@/features/timeline/useUnfurlImage";
import { ThreadComposer } from "./ThreadComposer";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT = "00000000-0000-7000-8000-000000000301";
const OTHER_ROOT = "00000000-0000-7000-8000-000000000302";
const CHANNELS = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false }] as unknown as Channel[];
const TRAY = surfaceKey(WS, CH, ROOT);

const STILL = { small: { ...FIXTURE_MEDIA.png.image }, large: { ...FIXTURE_MEDIA.png.image }, thumb: { ...FIXTURE_MEDIA.png.image } };
// 큰 그림(스티커) 하나와 작은 이모지(팀 이모지) 하나. 둘 다 움직이지 않는 그림이라 그림 받기가 곧바로 끝난다.
const CHEERS = { ...FIXTURE_EXPRESSIONS[1], id: "00000000-0000-4000-8000-000000000051", name: "cheers_still", displayName: "건배", tags: ["축하"], media: STILL };
const PARROT = { ...FIXTURE_EXPRESSIONS[0], id: "00000000-0000-4000-8000-000000000052", name: "party_parrot", displayName: "파티 앵무새", tags: ["축하"], media: STILL };
let library = [CHEERS, PARROT];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let store: ExpressionStore | null = null;
const onSent = vi.fn();

/** `sendThreadReply`가 받은 요청 한 건. 약속은 시험이 풀거나 거절한다. */
interface Call {
  channelId: string;
  rootId: string;
  clientMsgId: string;
  body: string;
  options: Record<string, unknown> | undefined;
  resolve: () => void;
  reject: (error: unknown) => void;
}
const calls: Call[] = [];

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue([]);
  api.fetchUnfurlImage.mockResolvedValue(new Blob(["x"], { type: "image/png" }));
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  transport.putAttachmentBytes.mockReset();
  calls.length = 0;
  api.sendThreadReply.mockImplementation(
    (_ws: string, channelId: string, rootId: string, clientMsgId: string, body: string, options?: Record<string, unknown>) =>
      new Promise((resolve, reject) => {
        const index = calls.length + 1;
        calls.push({ channelId, rootId, clientMsgId, body, options, resolve: () => resolve({ id: `reply-${index}` }), reject });
      })
  );
  api.fetchUnfurlPreview.mockImplementation(
    async (_ws: string, _ch: string, url: string) => ({ id: "p-1", url, status: "ok", title: "예시 페이지", domain: new URL(url).hostname }) as UnfurlPreview
  );
  setLinkPreviewPreference("compact");
  resetUnfurlImagesForTest();
  onSent.mockReset();
  library = [CHEERS, PARROT];
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  clearThreadDraft(WS, ROOT);
  clearThreadDraft(WS, OTHER_ROOT);
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

let client: QueryClient;
let locale: AppLocale;
function tree(rootId: string) {
  return createElement(
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
          { initialEntries: [`/c/${CH}`] },
          createElement(
            SessionProvider,
            { value: session() },
            createElement(ThreadComposer, {
              workspaceId: WS,
              channelId: CH,
              rootId,
              directory: makeDirectory([]),
              channels: CHANNELS,
              onSent,
            })
          )
        )
      )
    )
  );
}

async function mount(rootId = ROOT): Promise<void> {
  store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, libraryTransport());
  await store.refresh();
  locale = await koLocale();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(tree(rootId));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** 같은 인스턴스에 다른 `rootId`만 건네 다시 그린다(스레드 패널은 스레드를 옮겨도 입력창을 다시 올리지 않는다). */
async function showThread(rootId: string) {
  await act(async () => {
    mountedRoot?.render(tree(rootId));
  });
  await settle();
}

const q = <T extends HTMLElement = HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);
const textarea = () => q<HTMLTextAreaElement>("thread-composer-input") as HTMLTextAreaElement;
const sendButton = () => q<HTMLButtonElement>("thread-composer-send");
const PREVIEW = "thread-composer-expression-preview";
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

/** 이모티콘 창을 열어 이모티콘 탭의 「건배」를 고른다(진짜 길: 단추 → 고르개 → 탭 → 항목). */
async function pickCheers() {
  await click(q("thread-composer-emoji-trigger"));
  await settle();
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[aria-label='표현 종류'] button"));
  await click(tabs.find((tab) => tab.textContent === "이모티콘") ?? null);
  await settle();
  await click(document.querySelector("[aria-label='건배 메시지에 넣기']"));
  await settle();
}

/** 약속을 푼다(서버가 확정했다). 푼 뒤의 효과(둘째 요청)까지 흘려보낸다. */
async function accept(index: number) {
  await act(async () => {
    calls[index]?.resolve();
    await Promise.resolve();
  });
  await settle();
}
async function refuse(index: number, error: unknown) {
  await act(async () => {
    calls[index]?.reject(error);
    await Promise.resolve();
  });
  await settle();
}

/** 이 화면에서 사람이 읽을 수 있는 글(낭독 전용 `sr-only` 노드·`<textarea>`의 값은 뺀다). */
function visibleText(root: ParentNode = document.body): string {
  const clone = (root instanceof Element ? root : document.body).cloneNode(true) as Element;
  clone.querySelectorAll(".sr-only, textarea, script, style").forEach((node) => node.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}
const HINT = "큰 그림으로 보내요";

describe("고르면 입력창 위에 그림과 ✕ 만 서고, 글에는 `:이름:`이 들어가지 않는다", () => {
  it("미리 보기에는 그림과 작은 ✕ 뿐이다 - 보이는 글이 없고 이름은 낭독용으로만 있다", async () => {
    await mount();
    expect(q(PREVIEW)).toBeNull();
    await pickCheers();
    const preview = q(PREVIEW);
    expect(preview).not.toBeNull();
    expect(textarea().value).toBe("");
    expect(Array.from(preview!.querySelectorAll("button"))).toHaveLength(1);
    const cancel = q(`${PREVIEW}-cancel`);
    expect(cancel?.getAttribute("aria-label")).toBe("건배 미리 보기 지우기");
    expect(cancel?.textContent).toBe("");
    expect(preview!.getAttribute("aria-label")).toBe("보낼 이모티콘");
    // 그림이 오기 전 자리표시(`:이름:`) 말고는 글자가 없다.
    expect((preview!.textContent ?? "").replace(":cheers_still:", "")).toBe("");
    // 입력칸으로 포커스가 돌아온다.
    expect(document.activeElement).toBe(textarea());
  });

  it("그림만 있어도(글이 비어도) 보내기가 열리고, 한 통만 나간다", async () => {
    await mount();
    expect(sendButton()?.disabled).toBe(true);
    await pickCheers();
    expect(sendButton()?.disabled).toBe(false);
    await click(sendButton());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe(":cheers_still:");
    await accept(0);
    expect(calls).toHaveLength(1);
    expect(q(PREVIEW)).toBeNull();
    expect(onSent).toHaveBeenCalled();
  });

  it("작은 이모지는 예전처럼 글 속 캐럿 자리에 들어가고 미리 보기는 서지 않는다", async () => {
    await mount();
    await type("점심 ");
    await click(q("thread-composer-emoji-trigger"));
    await settle();
    // 이모지 탭: 표 위에 팀의 작은 이모지 한 줄이 선다(처음 열리는 탭은 이모티콘이라 탭을 옮긴다).
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[aria-label='표현 종류'] button"));
    await click(tabs.find((tab) => tab.textContent === "이모지") ?? null);
    await settle();
    await click(q("team-emoji-party_parrot"));
    await settle();
    expect(textarea().value).toBe("점심 :party_parrot:");
    expect(q(PREVIEW)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("보내기 한 번: [큰 그림, 글]이 같은 스레드로, 다른 멱등 열쇠로, 그 순서로", () => {
  it("둘째는 첫째가 확정된 뒤에만 나간다 - 첫째가 풀리기 전에는 요청이 하나뿐이다", async () => {
    await mount();
    await pickCheers();
    await type("  오늘 점심 같이 가요  ");
    await click(sendButton());
    // 그림만 나갔고 글은 기다린다(약속이 아직 안 풀렸다).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe(":cheers_still:");
    await settle();
    expect(calls).toHaveLength(1);
    // 그림이 확정되면 글이 이어서 나간다. 미리 보기는 이때 비고 글은 둘째가 끝날 때까지 입력창에 남는다.
    await accept(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toBe("오늘 점심 같이 가요");
    expect(q(PREVIEW)).toBeNull();
    expect(textarea().value).toBe("  오늘 점심 같이 가요  ");
    await accept(1);
    // 서버가 받은 차례 [표현, 글] · 같은 스레드 · 서로 다른 열쇠.
    expect(calls.map((call) => call.body)).toEqual([":cheers_still:", "오늘 점심 같이 가요"]);
    expect(calls.every((call) => call.rootId === ROOT && call.channelId === CH)).toBe(true);
    expect(new Set(calls.map((call) => call.clientMsgId)).size).toBe(2);
    // 끝나면 글도 비고 스레드가 새로 읽힌다.
    expect(textarea().value).toBe("");
    expect(q(PREVIEW)).toBeNull();
    expect(onSent).toHaveBeenCalled();
  });

  it("↵ 도 같다", async () => {
    await mount();
    await pickCheers();
    await type("회의 끝나고 봬요");
    expect(await press({ key: "Enter" })).toBe(true);
    expect(calls).toHaveLength(1);
    await accept(0);
    expect(calls.map((call) => call.body)).toEqual([":cheers_still:", "회의 끝나고 봬요"]);
  });

  it("그림 없이 글만 보내면 예전과 같은 요청 하나다", async () => {
    await mount();
    await type("그냥 글");
    await click(sendButton());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe("그냥 글");
    await accept(0);
    expect(textarea().value).toBe("");
  });

  it("첨부는 글 답글(둘째)에 실리고, 그림 답글에는 실리지 않는다", async () => {
    await mount();
    api.createAttachmentUpload.mockResolvedValueOnce({ id: "att-1", status: "pending", uploadUrl: "https://archive.invalid/1" });
    api.completeAttachmentUpload.mockResolvedValueOnce({ id: "att-1", channelId: CH, uploaderMemberId: ME, name: "로그.txt", mime: "text/plain", size: 8, status: "complete", createdAtMs: 0 });
    transport.putAttachmentBytes.mockImplementationOnce(() => ({ done: Promise.resolve({ ok: true }), abort: () => {} }));
    await act(async () => {
      addFiles(TRAY, { workspaceId: WS, channelId: CH }, [{ name: "로그.txt", size: 8, type: "text/plain" } as unknown as File]);
    });
    for (let i = 0; i < 5; i += 1) await settle();
    await pickCheers();
    await type("이 로그 보세요");
    await click(sendButton());
    await accept(0);
    await accept(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options?.attachmentIds ?? []).toEqual([]);
    expect(calls[1]?.options?.attachmentIds).toEqual(["att-1"]);
  });
});

describe("실패: 첫째가 실패하면 둘째는 나가지 않고, 둘째만 실패하면 미리 보기만 비는다", () => {
  it("첫째가 실패하면 둘째는 나가지 않는다 - 미리 보기와 글이 입력창에 남고 이유가 기존 실패 줄에 선다", async () => {
    await mount();
    await pickCheers();
    await type("글은 남아야 해요");
    await click(sendButton());
    await refuse(0, new ApiError(403, "forbidden"));
    expect(calls).toHaveLength(1);
    expect(q(PREVIEW)).not.toBeNull();
    expect(textarea().value).toBe("글은 남아야 해요");
    expect(textarea().disabled).toBe(false);
    expect(q("thread-composer-error")?.textContent).toContain("이 채널의 멤버만 답글을 달 수 있습니다.");
    expect(onSent).not.toHaveBeenCalled();
    // 다시 보내면 처음부터(그림 → 글)다: 앞 시도의 열쇠를 되살리지 않는다.
    await click(sendButton());
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toBe(":cheers_still:");
    expect(calls[1]?.clientMsgId).not.toBe(calls[0]?.clientMsgId);
  });

  it("첫째는 되고 둘째만 실패하면 미리 보기는 비고 글은 남는다 - 다시 보내면 글만 나간다(그림이 두 번 나가지 않는다)", async () => {
    await mount();
    await pickCheers();
    await type("글만 실패해요");
    await click(sendButton());
    await accept(0);
    expect(calls).toHaveLength(2);
    await refuse(1, new ApiError(500, "boom"));
    expect(q(PREVIEW)).toBeNull();
    expect(textarea().value).toBe("글만 실패해요");
    expect(q("thread-composer-error")?.textContent).toContain("답글을 보내지 못했습니다.");
    await click(sendButton());
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).toBe("글만 실패해요");
    await accept(2);
    expect(calls.map((call) => call.body)).toEqual([":cheers_still:", "글만 실패해요", "글만 실패해요"]);
    expect(textarea().value).toBe("");
  });
});

describe("보이는 안내 문장은 없다", () => {
  it("고른 미리 보기 곁에도, 손으로 `:이름:` 만 친 글 곁에도 「큰 그림으로 보내요 …」가 없다 - 큰 그림으로 나가는 것은 그대로다", async () => {
    await mount();
    await pickCheers();
    expect(visibleText()).not.toContain(HINT);
    expect(visibleText()).not.toContain("한 번 더 눌러");
    expect(q("expression-send-preview")).toBeNull();
    await click(q(`${PREVIEW}-cancel`));
    expect(q(PREVIEW)).toBeNull();
    // 사람이 `:이름:` 만 손으로 쳤다: 안내 문장도 옛 미리 보기 줄도 서지 않는다.
    await type(":cheers_still:");
    expect(visibleText()).not.toContain(HINT);
    expect(visibleText()).not.toContain("연결되면 보낼 수 있어요");
    expect(q("expression-send-preview")).toBeNull();
    expect(q(PREVIEW)).toBeNull();
    // 글 본문이 `:이름:` 하나로 나간다(서버·타임라인이 큰 그림으로 그린다).
    await click(sendButton());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe(":cheers_still:");
  });
});

describe("지우기와 키보드, 사라진 그림, 스레드 옮기기", () => {
  it("✕ 는 그림을 치우고 포커스를 입력칸에 돌려주며 쓴 글은 그대로다", async () => {
    await mount();
    await pickCheers();
    await type("쓰던 글");
    await click(q(`${PREVIEW}-cancel`));
    expect(q(PREVIEW)).toBeNull();
    expect(textarea().value).toBe("쓰던 글");
    expect(document.activeElement).toBe(textarea());
    expect(calls).toHaveLength(0);
  });

  it("입력칸에서 Esc 는 미리 보기를 치우고, 한 번 더 누르면 키가 지나간다", async () => {
    await mount();
    await pickCheers();
    expect(await press({ key: "Escape" })).toBe(true);
    expect(q(PREVIEW)).toBeNull();
    expect(await press({ key: "Escape" })).toBe(false);
  });

  it("✕ 에 초점이 있을 때의 Esc 도 같다", async () => {
    await mount();
    await pickCheers();
    const cancel = q<HTMLButtonElement>(`${PREVIEW}-cancel`)!;
    await act(async () => {
      cancel.focus();
      cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(q(PREVIEW)).toBeNull();
    expect(document.activeElement).toBe(textarea());
  });

  it("고른 뒤 그림이 숨겨졌거나 지워졌으면 보내기는 막히고 그림 자리에 한 문장이 선다 - 몰래 그림만 빼고 보내지 않는다", async () => {
    await mount();
    await pickCheers();
    await type("글은 있어요");
    expect(sendButton()?.disabled).toBe(false);
    library = [{ ...CHEERS, status: "hidden", media: null } as unknown as typeof CHEERS, PARROT];
    await act(async () => {
      await store!.refresh();
    });
    const gone = q(`${PREVIEW}-gone`);
    expect(gone?.textContent).toBe("이 표현을 지금 쓸 수 없어요. 다시 골라 주세요.");
    expect(gone?.getAttribute("role")).toBe("alert");
    expect(sendButton()?.disabled).toBe(true);
    expect(await press({ key: "Enter" })).toBe(true);
    expect(calls).toHaveLength(0);
    // ✕ 로 치우면 글만 보낼 수 있다.
    await click(q(`${PREVIEW}-cancel`));
    expect(sendButton()?.disabled).toBe(false);
    await press({ key: "Enter" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe("글은 있어요");
  });

  it("다른 스레드로 옮기면 미리 보기는 따라가지 않고, 되돌아와도 다시 서지 않는다", async () => {
    await mount(ROOT);
    await pickCheers();
    expect(q(PREVIEW)).not.toBeNull();
    await showThread(OTHER_ROOT);
    expect(q(PREVIEW)).toBeNull();
    await showThread(ROOT);
    expect(q(PREVIEW)).toBeNull();
  });

  it("Esc 차례: 링크 카드가 먼저, 그다음 미리 본 이모티콘이다 - 한 번에 하나씩 치운다", async () => {
    await mount();
    await pickCheers();
    await type("이 링크 봐 주세요 https://a.example/one");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(q("thread-composer-link-preview")).not.toBeNull();
    expect(q(PREVIEW)).not.toBeNull();
    expect(await press({ key: "Escape" })).toBe(true);
    expect(q("thread-composer-link-preview")).toBeNull();
    expect(q(PREVIEW)).not.toBeNull();
    expect(await press({ key: "Escape" })).toBe(true);
    expect(q(PREVIEW)).toBeNull();
    expect(await press({ key: "Escape" })).toBe(false);
  });

  it("오프라인이면 보내기는 막히지만 미리 보기는 그대로 서고 ✕ 로 지울 수 있다 - 안내 문장 대신 오프라인 줄 하나만 있다", async () => {
    await mount();
    await pickCheers();
    await type("연결이 끊겼어요");
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(q(PREVIEW)).not.toBeNull();
    expect(sendButton()?.disabled).toBe(true);
    expect(q("thread-composer-offline")).not.toBeNull();
    expect(await press({ key: "Enter" })).toBe(true);
    expect(calls).toHaveLength(0);
    expect(visibleText()).not.toContain(HINT);
    await click(q(`${PREVIEW}-cancel`));
    expect(q(PREVIEW)).toBeNull();
    expect(textarea().value).toBe("연결이 끊겼어요");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(sendButton()?.disabled).toBe(false);
  });
});
