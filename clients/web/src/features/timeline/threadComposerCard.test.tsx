// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";

// =============================================================================
// #5324: 웹·데스크탑 스레드 입력칸에서 「대화에도 보내기」를 뺐고, 본 입력창과 **같은 카드**(`ComposerCard`)로 맞췄다. 진짜 `ThreadComposer`를 올리고
// 서버 호출(`sendThreadReply`)만 손으로 연다. 지키는 것: 체크도 안내 글도 없다 · 보내기 요청에는 `alsoInChannel` 키가 없고 `rootId` 는 간다 ·
// 실패는 평소 문장으로 말한다(옛 서버 안내 문장은 없다) · 그릇은 채널 입력창과 같은 카드이고 도구 줄·보내기 알약도 같은 부품이다.
// (jsdom 은 CSS 를 계산하지 않는다 — 두 그릇이 **계산된 값**으로 같은지는 `scripts/capture-5324.mjs` 가 실제 엔진에서 잰다.)
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
import { ThreadComposer } from "./ThreadComposer";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT = "00000000-0000-7000-8000-000000000301";
const OTHER_ROOT = "00000000-0000-7000-8000-000000000302";
const CHANNELS = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false }] as unknown as Channel[];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

interface Sent {
  clientMsgId: string;
  rootId: string;
  body: string;
  options: Record<string, unknown> | undefined;
}
const sends: Sent[] = [];
/** 다음 `sendThreadReply` 가 거절할 오류. 없으면 성공한다. */
let nextFailure: unknown = null;

let korean: AppLocale;
beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-11-03T10:00:00+09:00"));
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  sends.length = 0;
  nextFailure = null;
  api.sendThreadReply.mockImplementation(
    async (_ws: string, _ch: string, rootId: string, clientMsgId: string, body: string, options?: Record<string, unknown>) => {
      sends.push({ clientMsgId, rootId, body, options });
      if (nextFailure !== null) throw nextFailure;
      return { id: `reply-${sends.length}` };
    }
  );
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  clearThreadDraft(WS, ROOT);
  clearThreadDraft(WS, OTHER_ROOT);
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

function tree(rootId: string) {
  return createElement(LocaleProvider, {
    locale: korean,
    children: createElement(
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
    ),
  });
}

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
const textarea = () => need("thread-composer-input") as HTMLTextAreaElement;

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function send() {
  await act(async () => {
    need("thread-composer-send").click();
  });
  await flush();
}

describe("스레드 입력칸에는 「대화에도 보내기」가 없다 (#5324)", () => {
  it("체크도 안내 글도 없다 — 보이는 이름도 낭독 이름도", async () => {
    await mount();
    expect(byId("thread-composer-also-in-channel")).toBeNull();
    expect(byId("thread-composer-also-in-channel-input")).toBeNull();
    expect(document.body.textContent ?? "").not.toContain("대화에도 보내기");
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  // 사보타주: `sendThreadReply` 호출에 `...(true ? { alsoInChannel: true } : {})` 를 되살리면 이 시험이 RED 여야 한다.
  it("보내기 요청에는 alsoInChannel 키가 없고, 답글의 rootId 는 간다", async () => {
    await mount();
    await type("스레드에만 가는 답글");
    await send();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ rootId: ROOT, body: "스레드에만 가는 답글" });
    expect(Object.keys(sends[0]!.options ?? {})).not.toContain("alsoInChannel");
  });

  it("글을 보내면 입력칸이 비고, 다음 답글의 요청에도 그 키는 없다", async () => {
    await mount();
    await type("첫 답글");
    await send();
    expect(textarea().value).toBe("");
    await type("둘째 답글");
    await send();
    expect(sends).toHaveLength(2);
    for (const sent of sends) expect(Object.keys(sent.options ?? {})).not.toContain("alsoInChannel");
  });

  it("거절(400)은 평소 문장으로 말한다 — 옛 서버 안내 문장은 없고, 글은 남는다", async () => {
    nextFailure = new ApiError(400, "bad request");
    await mount();
    await type("거절될 답글");
    await send();
    const message = need("thread-composer-error").textContent ?? "";
    expect(message).toContain("이 메시지에는 답글을 달 수 없습니다");
    expect(message).not.toContain("지원하지 않아요");
    expect(textarea().value).toBe("거절될 답글");
  });

  it("스레드를 옮겨도 체크 상태 같은 것이 새지 않는다 — 입력칸은 여전히 체크 없이 선다", async () => {
    await mount(ROOT);
    await showThread(OTHER_ROOT);
    expect(byId("thread-composer-also-in-channel")).toBeNull();
  });
});

describe("스레드 입력창은 채널 입력창과 같은 카드다 (#5324)", () => {
  const classes = (el: HTMLElement) => Array.from(el.classList);

  // 사보타주: 그릇을 `rounded-md border border-line-strong bg-surface-raised` 로 되돌리면 이 시험이 RED 여야 한다.
  it("그릇이 `composer-card` 이고, 예전 따로 그리던 상자의 클래스는 없다", async () => {
    await mount();
    const frame = need("thread-composer-frame");
    expect(frame.hasAttribute("data-composer-frame")).toBe(true);
    expect(classes(frame)).toEqual(expect.arrayContaining(["composer-card", "@container"]));
    for (const own of ["rounded-md", "border", "border-line-strong", "bg-surface-raised"]) {
      expect(classes(frame)).not.toContain(own);
    }
  });

  it("독이 채널 입력창과 같다: `composer-dock` 이고 항상 있는 위 경계선(`border-t`)이 없다", async () => {
    await mount();
    const shell = need("thread-composer");
    expect(classes(shell)).toContain("composer-dock");
    expect(classes(shell)).not.toContain("border-t");
  });

  it("글 칸이 채널 입력창과 같은 옷이다(안내 문구 색·줄 간격·인셋)", async () => {
    await mount();
    expect(classes(textarea())).toEqual(
      expect.arrayContaining(["composer-placeholder", "placeholder:text-ink-muted", "leading-relaxed", "px-3", "py-2", "focus-visible:outline-none"])
    );
  });

  it("도구 줄이 같은 묶음이다: +·@·이모지에 서식이 더해지고, 보내기는 `Button size=icon` 알약이다", async () => {
    await mount();
    const actions = need("thread-composer-actions");
    const labels = Array.from(actions.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(labels.slice(0, 3)).toEqual(["파일 첨부", "멘션 넣기", "이모티콘 넣기"]);
    // 서식 단추는 채널 입력창의 그것과 같은 부품이다(jsdom 은 터치 기기가 아니라 `useComposerFormat` 이 가능하다고 답한다). 이름이 같다.
    const format = need("thread-composer-format-trigger");
    expect(format.getAttribute("aria-label")).toBe("서식");
    expect(labels).toContain("서식");
    const sendButton = need("thread-composer-send");
    expect(sendButton.getAttribute("aria-label")).toBe("답글 보내기");
    expect(classes(sendButton)).toEqual(expect.arrayContaining(["size-icon-button", "rounded-full", "bg-primary"]));
  });

  it("보내는 중에는 그릇 전체가 흐려지고 단추는 더 흐려지지 않는다(이중 흐림 금지)", async () => {
    let finish: (value: unknown) => void = () => undefined;
    api.sendThreadReply.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    await type("느리게 가는 답글");
    await act(async () => {
      need("thread-composer-send").click();
    });
    const frame = need("thread-composer-frame");
    expect(classes(frame)).toContain("opacity-50");
    expect(frame.getAttribute("aria-busy")).toBe("true");
    expect(classes(need("thread-composer-send"))).toContain("disabled:opacity-100");
    await act(async () => {
      finish({ id: "reply-slow" });
    });
    await flush();
    expect(classes(need("thread-composer-frame"))).not.toContain("opacity-50");
  });
});
