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
// #5005: 보내기 전 입력칸의 링크 미리보기. 진짜 `Composer`·진짜 훅·진짜 카드 컴포넌트를 올리고, 서버
// 호출(`fetchUnfurlPreview`·`fetchUnfurlImage`)만 손으로 여닫는다. 시계는 가짜다: 350ms 기다림과 429의
// `Retry-After`가 매번 같은 시각에 선다.
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
  fetchUnfurlPreview: vi.fn(),
  fetchUnfurlImage: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { resetAttachmentDraftsForTest } from "@/features/attachments/draftStore";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { clearDraft } from "@/features/chat/draftStore";
import { setLinkPreviewPreference } from "@/features/timeline/linkPreviewPreference";
import { resetUnfurlImagesForTest } from "@/features/timeline/useUnfurlImage";
import { Composer } from "./Composer";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const CHANNELS: Channel[] = [{ id: CH, workspaceId: WS, kind: "public", name: "general", muted: false } as Channel];

const A = "https://a.example/one";
const B = "https://b.example/two";
const C = "https://c.example/three";
const D = "https://d.example/four";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

interface Sent {
  body: string;
  options: Record<string, unknown> | undefined;
}
const sends: Sent[] = [];

/** 서버로 나간 미리보기 요청 한 건. 답은 시험이 정한다. */
interface Asked {
  url: string;
  signal: AbortSignal | undefined;
  resolve: (preview: UnfurlPreview) => void;
  reject: (error: unknown) => void;
  /** 이미 답했거나 거절했다. 같은 주소를 다시 물은 요청과 헷갈리지 않으려고 센다. */
  settled: boolean;
}
const asked: Asked[] = [];
const askedUrls = (): string[] => asked.map((request) => request.url);
/** 진짜 전송은 호출자가 끊으면 그 자리에서 AbortError로 거절한다. 켜면 가짜도 그렇게 한다. */
let rejectOnAbort = false;

let serial = 0;
function ok(url: string, over: Record<string, unknown> = {}): UnfurlPreview {
  serial += 1;
  const domain = new URL(url).hostname;
  return { id: `p-${serial}`, url, status: "ok", title: `Title of ${domain}`, domain, ...over } as UnfurlPreview;
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
  api.fetchWorkHosts.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  api.fetchUnfurlImage.mockResolvedValue(new Blob(["x"], { type: "image/png" }));
  asked.length = 0;
  rejectOnAbort = false;
  api.fetchUnfurlPreview.mockImplementation(
    (_ws: string, _ch: string, url: string, signal?: AbortSignal) =>
      new Promise<UnfurlPreview>((resolve, reject) => {
        const request: Asked = {
          url,
          signal,
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
        if (rejectOnAbort) {
          signal?.addEventListener("abort", () => request.reject(new DOMException("aborted", "AbortError")));
        }
        asked.push(request);
      })
  );
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  resetUnfurlImagesForTest();
  clearDraft(WS, CH);
  setLinkPreviewPreference("compact");
  sends.length = 0;
  onlineManager.setOnline(true);
  window.dispatchEvent(new Event("online"));
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
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "Seoyeon", handle: "seoyeon" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function ComposerHost() {
  return createElement(Composer, {
    workspaceId: WS,
    channelId: CH,
    directory: makeDirectory([]),
    channels: CHANNELS,
    channelLabel: "general",
    recipient: "place",
    dmAgent: null,
    quote: null,
    onCancelQuote: () => undefined,
    onSend: (body, options) => {
      sends.push({ body, options: options as Record<string, unknown> | undefined });
    },
  });
}

/** 시계를 `ms`만큼 밀고, 그 사이에 풀린 약속과 효과를 다 흘려보낸다. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount() {
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
            createElement(SessionProvider, { value: session() }, createElement(ComposerHost))
          )
        )
      )
    );
  });
  await flush();
}

const byId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function need(id: string): HTMLElement {
  const el = byId(id);
  if (!el) throw new Error(`missing: ${id}`);
  return el;
}
const input = () => need("composer-input") as HTMLTextAreaElement;
const groupTitles = (): string[] =>
  Array.from(document.querySelectorAll('[data-testid="composer-link-preview"] [data-testid="unfurl-title"]')).map(
    (el) => el.textContent ?? ""
  );
const status = () => (byId("composer-link-preview-status")?.textContent ?? "").trim();

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

describe("composer link preview (#5005)", () => {
  it("asks only after the typing stops, then draws the card above the input", async () => {
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
    expect(api.fetchUnfurlPreview).toHaveBeenCalledWith(WS, CH, A, expect.any(AbortSignal));
    // Nothing is drawn before the answer: a link that gets no card must never flash one.
    expect(byId("composer-link-preview")).toBeNull();

    await answer(A);
    const group = need("composer-link-preview");
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBeTruthy();
    expect(groupTitles()).toEqual(["Title of a.example"]);
    // The row stands above the form, not inside it (the ✕ must never submit the message).
    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    expect(group.compareDocumentPosition(form as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form?.contains(group)).toBe(false);
  });

  it("asks nothing for text with no link, or on a device that draws no cards", async () => {
    await mount();
    await type("just words, no address");
    await flush(2000);
    expect(asked).toHaveLength(0);

    act(() => setLinkPreviewPreference("off"));
    await type(`still ${A}`);
    await flush(2000);
    expect(asked).toHaveLength(0);
    expect(byId("composer-link-preview")).toBeNull();
    // A device that cannot see the card cannot turn it off either: the message goes out as it always did.
    await keydown(input(), "Enter");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.options).not.toHaveProperty("suppressUnfurl");
  });

  it("asks once per address and keeps the answer while the link stays in the draft", async () => {
    await mount();
    await showCard(A);
    expect(askedUrls()).toEqual([A]);
    // Rewriting the sentence around the link does not ask again.
    await type(`look ${A} now`);
    await flush(2000);
    // The same page written another way (host case, fragment, trailing slash) is the same address.
    await type(`look HTTPS://A.example/one#top and ${A}/ again`);
    await flush(2000);
    expect(askedUrls()).toEqual([A]);
    expect(groupTitles()).toEqual(["Title of a.example"]);
    // Taking the link out takes the card out at once; putting it back brings it back without asking.
    await type("no link now");
    expect(byId("composer-link-preview")).toBeNull();
    await type(A);
    await flush(2000);
    expect(askedUrls()).toEqual([A]);
    expect(groupTitles()).toEqual(["Title of a.example"]);
  });

  it("previews the first three distinct links only, one at a time and in order", async () => {
    await mount();
    await type(`${A} ${B} ${C} ${D} ${A}`);
    await flush(350);
    // One request at a time: the others wait for the answer to the one before.
    expect(askedUrls()).toEqual([A]);
    await answer(A);
    expect(askedUrls()).toEqual([A, B]);
    await answer(B);
    await answer(C);
    await flush(5000);
    expect(askedUrls()).toEqual([A, B, C]);
    expect(groupTitles()).toEqual(["Title of a.example", "Title of b.example", "Title of c.example"]);
    // One ✕ for the whole message, on the first card.
    expect(document.querySelectorAll('[data-testid="composer-link-preview-dismiss"]')).toHaveLength(1);
  });

  it("ignores a late answer: it neither draws an old link, nor asks the rest of the old links", async () => {
    await mount();
    await type(`${A} ${B}`);
    await flush(350);
    const first = asked[0];
    expect(first?.url).toBe(A);
    expect(first?.signal?.aborted).toBe(false);

    await type(C);
    // Changing the links cuts the request in flight, so the server's budget is not spent on it.
    expect(first?.signal?.aborted).toBe(true);
    await act(async () => {
      first?.resolve(ok(A));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(askedUrls()).toEqual([A]);
    expect(byId("composer-link-preview")).toBeNull();

    await flush(350);
    expect(askedUrls()).toEqual([A, C]);
    await answer(C);
    expect(groupTitles()).toEqual(["Title of c.example"]);
    // The late answer was not kept: writing the old link again asks again.
    await type(A);
    await flush(350);
    expect(askedUrls()).toEqual([A, C, A]);
  });

  it("counts a request it cut itself as nothing: no failure is kept and no other link is asked", async () => {
    rejectOnAbort = true;
    await mount();
    await type(`${A} ${B}`);
    await flush(350);
    expect(askedUrls()).toEqual([A]);

    await type(C);
    // The transport answers the cut with an abort. That is not a verdict on the address.
    await flush(0);
    expect(askedUrls()).toEqual([A]);
    await flush(350);
    expect(askedUrls()).toEqual([A, C]);
    await answer(C);
    expect(groupTitles()).toEqual(["Title of c.example"]);
    // Nothing was kept about A: asking for it again goes out.
    await type(A);
    await flush(350);
    expect(askedUrls()).toEqual([A, C, A]);
  });

  it("turns the preview off for this message with ✕, and the send says so once", async () => {
    await mount();
    await showCard(A);
    const dismiss = need("composer-link-preview-dismiss");
    expect(dismiss.tagName).toBe("BUTTON");
    expect(dismiss.getAttribute("type")).toBe("button");
    expect(dismiss.getAttribute("aria-label")).toBeTruthy();
    expect(dismiss.closest("form")).toBeNull();
    // Shift+Tab from the input lands on the ✕ first: it is the focusable thing just before the input.
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, [tabindex]'
      )
    ).filter((el) => el.getAttribute("tabindex") !== "-1");
    expect(focusable[focusable.indexOf(input()) - 1]).toBe(dismiss);

    await click(dismiss);
    expect(byId("composer-link-preview")).toBeNull();
    // The button is gone, so the focus goes back to the input; the change is read out.
    expect(document.activeElement).toBe(input());
    expect(status()).not.toBe("");

    await keydown(input(), "Enter");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toBe(A);
    expect(sends[0]?.options).toMatchObject({ suppressUnfurl: true });

    // The next message starts clean: the same link is previewed again and goes out as usual.
    await type(A);
    expect(groupTitles()).toEqual(["Title of a.example"]);
    expect(status()).toBe("");
    await keydown(input(), "Enter");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.options).not.toHaveProperty("suppressUnfurl");
  });

  it("brings the preview back when the link is changed or removed, but not when only the words change", async () => {
    await mount();
    await showCard(A);
    await click(need("composer-link-preview-dismiss"));

    // Only the sentence changes: the choice stands.
    await type(`${A} and some more words`);
    await flush(2000);
    expect(byId("composer-link-preview")).toBeNull();
    expect(status()).not.toBe("");

    // A different link is a different message to preview.
    await type(B);
    await flush(350);
    await answer(B);
    expect(groupTitles()).toEqual(["Title of b.example"]);
    expect(status()).toBe("");
    await keydown(input(), "Enter");
    expect(sends[0]?.options).not.toHaveProperty("suppressUnfurl");

    // Removing the link and writing the dismissed one again also starts over. The first link was
    // answered before, so its card comes straight back without a second request.
    await type(A);
    await flush(350);
    expect(groupTitles()).toEqual(["Title of a.example"]);
    await click(need("composer-link-preview-dismiss"));
    expect(byId("composer-link-preview")).toBeNull();
    await type("nothing here");
    await type(A);
    expect(groupTitles()).toEqual(["Title of a.example"]);
    expect(askedUrls()).toEqual([A, B]);
  });

  it("stays quiet on a 429, leaves the input alone, and asks once more after Retry-After", async () => {
    await mount();
    await type(A);
    await flush(350);
    await act(async () => {
      asked[0]?.reject(new ApiError(429, "slow down", undefined, 2));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(byId("composer-link-preview")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/slow down|429/);

    // The input is not held up: typing goes on, and nothing is asked while the server says wait.
    expect(input().disabled).toBe(false);
    await type(`${A} thanks`);
    expect(input().value).toBe(`${A} thanks`);
    await flush(1900);
    expect(askedUrls()).toEqual([A]);
    await flush(100);
    expect(askedUrls()).toEqual([A, A]);

    await answer(A, ok(A));
    expect(groupTitles()).toEqual(["Title of a.example"]);
    await keydown(input(), "Enter");
    expect(sends).toHaveLength(1);
  });

  it("gives up after a second 429 until the words around the link change the next time", async () => {
    await mount();
    await type(A);
    await flush(350);
    for (let round = 0; round < 2; round += 1) {
      await act(async () => {
        asked[round]?.reject(new ApiError(429, "slow down", undefined, 1));
        await vi.advanceTimersByTimeAsync(0);
      });
      await flush(1000);
    }
    await flush(120_000);
    expect(askedUrls()).toEqual([A, A]);
    expect(byId("composer-link-preview")).toBeNull();
    // The next edit of the draft, once the server's wait is long over, asks again.
    await type(`${A} one more word`);
    await flush(350);
    expect(askedUrls()).toEqual([A, A, A]);
  });

  it("closes the card with Esc, from the input and from the card, and never sends", async () => {
    await mount();
    await showCard(A);
    await keydown(input(), "Escape");
    expect(byId("composer-link-preview")).toBeNull();
    expect(sends).toHaveLength(0);
    expect(status()).not.toBe("");
    await keydown(input(), "Enter");
    expect(sends[0]?.options).toMatchObject({ suppressUnfurl: true });

    // Focus on the ✕: Esc closes the card and the focus goes back to the input.
    await showCard(B);
    const dismiss = need("composer-link-preview-dismiss");
    act(() => dismiss.focus());
    expect(document.activeElement).toBe(dismiss);
    await keydown(dismiss, "Escape");
    expect(byId("composer-link-preview")).toBeNull();
    expect(document.activeElement).toBe(input());
    expect(sends).toHaveLength(1);
  });

  it("does not ask while offline, keeps the ✕ through a lost connection, and asks after reconnecting", async () => {
    await mount();
    await showCard(A);
    await click(need("composer-link-preview-dismiss"));

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await flush(2000);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await flush(2000);
    // The connection came and went; the person's choice for this message did not.
    expect(byId("composer-link-preview")).toBeNull();
    expect(status()).not.toBe("");
    expect(askedUrls()).toEqual([A]);

    // A new link written offline waits for the connection, and nothing is asked until then.
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await type(B);
    await flush(2000);
    expect(askedUrls()).toEqual([A]);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await flush(350);
    expect(askedUrls()).toEqual([A, B]);
    await answer(B);
    expect(groupTitles()).toEqual(["Title of b.example"]);
  });

  it("sends no link to the server from a draft that holds an API key, and cuts a request already out", async () => {
    // Built at run time: a key-shaped literal in a fixture is read as a real key by secret scanners.
    const key = ["s", "k-", "proj-", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4"].join("");
    await mount();
    await type(A);
    await flush(350);
    const inFlight = asked[0];
    expect(inFlight?.signal?.aborted).toBe(false);

    // The key goes into the draft: the composer will not send or save it, and neither does the preview.
    await type(`${A} ${key}`);
    expect(inFlight?.signal?.aborted).toBe(true);
    await flush(5000);
    expect(askedUrls()).toEqual([A]);

    await type(B + " " + key);
    await flush(5000);
    expect(askedUrls()).toEqual([A]);
    expect(byId("composer-link-preview")).toBeNull();

    // Once the key is gone the link is asked as usual.
    await type(B);
    await flush(350);
    expect(askedUrls()).toEqual([A, B]);
  });

  it("follows this device's card size, and fetches the picture and the icon through the preview paths only", async () => {
    await mount();
    const image = `/v1/workspaces/${WS}/unfurl-previews/p-img/image`;
    const icon = `/v1/workspaces/${WS}/unfurl-previews/p-img/icon`;
    await type(A);
    await flush(350);
    await answer(A, ok(A, { id: "p-img", imageUrl: image, iconUrl: icon, imageWidth: 1200, imageHeight: 630 }));
    await flush();
    const fetched = api.fetchUnfurlImage.mock.calls.map((call) => call[0] as string).sort();
    expect(fetched).toEqual([icon, image].sort());
    expect(fetched.every((path) => path.startsWith(`/v1/workspaces/${WS}/unfurl-previews/`))).toBe(true);

    // The same card the timeline draws, in the size this device chose.
    expect(need("unfurl-card").getAttribute("data-layout")).toBe("compact");
    act(() => setLinkPreviewPreference("rich"));
    expect(need("unfurl-card").getAttribute("data-layout")).toBe("rich");
  });
});
