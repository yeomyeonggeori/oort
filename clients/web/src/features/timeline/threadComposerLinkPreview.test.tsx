// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { UnfurlPreview } from "@momo/core/features/timeline/unfurl";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// #5016: 스레드 입력창의 보내기 전 링크 미리보기. 채널 입력창(#5005, `composerLinkPreview.test.tsx`)과 같은
// 훅·같은 카드이고, 이 파일이 지키는 것은 **스레드 호스트의 배선**이다: 물을 채널, 카드가 서는 자리, ✕·Esc,
// 답글 요청에 실리는 억제 필드, ✕가 다른 스레드로 따라가지 않는 것. 진짜 `ThreadComposer`를 올리고 서버
// 호출(`fetchUnfurlPreview`·`sendThreadReply`)만 손으로 여닫는다. 시계는 가짜다(350ms·429 대기가 같은 시각에 선다).
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
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { clearThreadDraft } from "@/features/chat/draftStore";
import { resetAttachmentDraftsForTest } from "@/features/attachments/draftStore";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { setLinkPreviewPreference } from "@/features/timeline/linkPreviewPreference";
import { resetUnfurlImagesForTest } from "@/features/timeline/useUnfurlImage";
import { ThreadComposer } from "./ThreadComposer";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT = "00000000-0000-7000-8000-000000000301";
const OTHER_ROOT = "00000000-0000-7000-8000-000000000302";
const CHANNELS = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false }] as unknown as Channel[];

const A = "https://a.example/one";
const B = "https://b.example/two";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

/** 서버로 나간 미리보기 요청 한 건. 답은 시험이 정한다. */
interface Asked {
  url: string;
  resolve: (preview: UnfurlPreview) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}
const asked: Asked[] = [];
const askedUrls = (): string[] => asked.map((request) => request.url);

/** `sendThreadReply`가 받은 인자 한 건. */
interface Sent {
  channelId: string;
  rootId: string;
  body: string;
  options: Record<string, unknown> | undefined;
}
const sends: Sent[] = [];

let serial = 0;
function ok(url: string): UnfurlPreview {
  serial += 1;
  const domain = new URL(url).hostname;
  return { id: `p-${serial}`, url, status: "ok", title: `Title of ${domain}`, domain } as UnfurlPreview;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-11-01T10:00:00+09:00"));
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  api.fetchUnfurlImage.mockResolvedValue(new Blob(["x"], { type: "image/png" }));
  asked.length = 0;
  sends.length = 0;
  api.fetchUnfurlPreview.mockImplementation(
    (_ws: string, _ch: string, url: string) =>
      new Promise<UnfurlPreview>((resolve, reject) => {
        const request: Asked = {
          url,
          settled: false,
          resolve: (preview) => {
            request.settled = true;
            resolve(preview);
          },
          reject: (error) => {
            request.settled = true;
            reject(error);
          },
        };
        asked.push(request);
      })
  );
  api.sendThreadReply.mockImplementation(
    async (_ws: string, channelId: string, rootId: string, _key: string, body: string, options?: Record<string, unknown>) => {
      sends.push({ channelId, rootId, body, options });
      return { id: `reply-${sends.length}` };
    }
  );
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  resetUnfurlImagesForTest();
  clearThreadDraft(WS, ROOT);
  clearThreadDraft(WS, OTHER_ROOT);
  setLinkPreviewPreference("compact");
  onlineManager.setOnline(true);
  window.dispatchEvent(new Event("online"));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

/** 같은 인스턴스에 다른 `rootId`만 건네 다시 그릴 수 있게 트리를 함수로 둔다. */
function tree(rootId: string) {
  return createElement(
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
          onSent: () => undefined,
        })
      )
    )
  );
}

/** 시계를 `ms`만큼 밀고, 그 사이에 풀린 약속과 효과를 다 흘려보낸다. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(rootId = ROOT) {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(tree(rootId));
  });
  await flush();
}

async function showThread(rootId: string) {
  await act(async () => {
    mountedRoot?.render(tree(rootId));
  });
  await flush();
}

const byId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function need(id: string): HTMLElement {
  const el = byId(id);
  if (!el) throw new Error(`missing: ${id}`);
  return el;
}
const input = () => need("thread-composer-input") as HTMLTextAreaElement;
const GROUP = "thread-composer-link-preview";
const groupTitles = (): string[] =>
  Array.from(document.querySelectorAll(`[data-testid="${GROUP}"] [data-testid="unfurl-title"]`)).map(
    (el) => el.textContent ?? ""
  );
const status = () => (byId(`${GROUP}-status`)?.textContent ?? "").trim();

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function keydown(target: HTMLElement, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** 가장 먼저 걸린(아직 답 없는) `url`의 요청에 답한다. */
async function answer(url: string, preview: UnfurlPreview = ok(url)) {
  const request = asked.find((one) => one.url === url && !one.settled);
  if (!request) throw new Error(`no request for ${url}`);
  await act(async () => {
    request.resolve(preview);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** 링크를 넣고 350ms 기다려 요청이 나가고, 답이 와서 카드가 서기까지. */
async function showCard(url: string, body = url) {
  await type(body);
  await flush(350);
  await answer(url);
}

describe("thread composer link preview (#5016)", () => {
  it("asks only after the typing stops, in this thread's channel, and draws the card above the input frame", async () => {
    await mount();
    await type(`see ${A}`);
    await flush(349);
    expect(asked).toHaveLength(0);
    // Another keystroke starts the wait again, even though the link did not change.
    await type(`see ${A} please`);
    await flush(349);
    expect(asked).toHaveLength(0);
    await flush(1);
    expect(askedUrls()).toEqual([A]);
    // The reply is posted into the thread's channel, so that is the channel the preview is asked in.
    expect(api.fetchUnfurlPreview).toHaveBeenCalledWith(WS, CH, A, expect.any(AbortSignal));
    expect(byId(GROUP)).toBeNull();

    await answer(A);
    const group = need(GROUP);
    expect(group.getAttribute("role")).toBe("group");
    expect(groupTitles()).toEqual(["Title of a.example"]);
    // Inside the thread composer, above the input frame and outside it (the ✕ must never send the reply).
    expect(need("thread-composer").contains(group)).toBe(true);
    const frame = need("thread-composer-frame");
    expect(frame.contains(group)).toBe(false);
    expect(group.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The channel composer's key is not reused: both composers are on screen at once.
    expect(byId("composer-link-preview")).toBeNull();
  });

  it("turns the preview off for this reply with ✕, and only that reply carries the field", async () => {
    await mount();
    await showCard(A);
    const dismiss = need(`${GROUP}-dismiss`);
    expect(dismiss.tagName).toBe("BUTTON");
    expect(dismiss.getAttribute("type")).toBe("button");
    expect(dismiss.getAttribute("aria-label")).toBeTruthy();

    await click(dismiss);
    expect(byId(GROUP)).toBeNull();
    // The button is gone, so the focus goes back to the input; the change is read out.
    expect(document.activeElement).toBe(input());
    expect(status()).not.toBe("");
    // The reply is not sent by the click.
    expect(sends).toHaveLength(0);

    await keydown(input(), "Enter");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ channelId: CH, rootId: ROOT, body: A });
    expect(sends[0]?.options).toMatchObject({ suppressUnfurl: true });

    // The next reply starts clean: the same link is previewed again and goes out as usual.
    await type(A);
    expect(groupTitles()).toEqual(["Title of a.example"]);
    expect(status()).toBe("");
    await keydown(input(), "Enter");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.options).not.toHaveProperty("suppressUnfurl");
  });

  it("brings the card back when the link changes or another thread opens, but not when only the words change", async () => {
    await mount();
    await showCard(A);
    await click(need(`${GROUP}-dismiss`));

    // Only the sentence changes: the choice stands.
    await type(`${A} and some more words`);
    await flush(2000);
    expect(byId(GROUP)).toBeNull();
    expect(status()).not.toBe("");

    // A different link is a different reply to preview.
    await type(B);
    await flush(350);
    await answer(B);
    expect(groupTitles()).toEqual(["Title of b.example"]);
    expect(status()).toBe("");

    // The dismissal belongs to this thread. Another thread of the same channel, with the same link in the
    // box, starts over (the answer for the link is shared, so the card comes back without a second request).
    await click(need(`${GROUP}-dismiss`));
    expect(byId(GROUP)).toBeNull();
    await showThread(OTHER_ROOT);
    expect(groupTitles()).toEqual(["Title of b.example"]);
    expect(status()).toBe("");
    expect(askedUrls()).toEqual([A, B]);
  });

  it("stays quiet on a 429, leaves the input alone, and the reply goes out without the field", async () => {
    await mount();
    await type(A);
    await flush(350);
    await act(async () => {
      asked[0]?.reject(new ApiError(429, "slow down", undefined, 2));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(byId(GROUP)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/slow down|429/);

    // The input is not held up and nothing is asked while the server says wait.
    expect(input().disabled).toBe(false);
    await type(`${A} thanks`);
    expect(input().value).toBe(`${A} thanks`);
    await flush(1900);
    expect(askedUrls()).toEqual([A]);

    await keydown(input(), "Enter");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toBe(`${A} thanks`);
    expect(sends[0]?.options).not.toHaveProperty("suppressUnfurl");
  });

  it("closes the card with Esc, from the input and from the card, and never sends", async () => {
    await mount();
    await showCard(A);
    await keydown(input(), "Escape");
    expect(byId(GROUP)).toBeNull();
    expect(sends).toHaveLength(0);
    expect(status()).not.toBe("");
    await keydown(input(), "Enter");
    expect(sends[0]?.options).toMatchObject({ suppressUnfurl: true });

    // Focus on the ✕: Esc closes the card and the focus goes back to the input.
    await showCard(B);
    const dismiss = need(`${GROUP}-dismiss`);
    act(() => dismiss.focus());
    expect(document.activeElement).toBe(dismiss);
    await keydown(dismiss, "Escape");
    expect(byId(GROUP)).toBeNull();
    expect(document.activeElement).toBe(input());
    expect(sends).toHaveLength(1);
  });
});
