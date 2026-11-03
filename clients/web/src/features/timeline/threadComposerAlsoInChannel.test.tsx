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
// #4888: 웹·데스크탑 스레드 입력칸의 「대화에도 보내기」 체크. 진짜 `ThreadComposer`를 올리고 서버 호출(`sendThreadReply`)만 손으로 연다.
// 지키는 것: 기본 꺼짐 · 켠 때만 키가 간다 · 마지막 선택을 기억하지 않는다(성공하면 꺼지고 스레드를 옮겨도 꺼진다) · 실패하면 같은
// 선택이 남는다 · 옛 서버의 거절은 조용히 스레드로만 보내지 않고 이유를 말한다 · 키보드와 이름.
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
const check = () => need("thread-composer-also-in-channel-input") as HTMLInputElement;

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function toggle() {
  await act(async () => {
    check().click();
  });
}
async function send() {
  await act(async () => {
    need("thread-composer-send").click();
  });
  await flush();
}

describe("스레드 입력칸의 「대화에도 보내기」 (#4888)", () => {
  it("기본은 꺼져 있고, 보이는 글이 이름이다", async () => {
    await mount();
    expect(check().type).toBe("checkbox");
    expect(check().checked).toBe(false);
    // 이름은 보이는 글(label)에서 온다 — 별도 aria-label 이 아니라 label 안의 글이 곧 이름이다.
    expect(need("thread-composer-also-in-channel").textContent).toBe("대화에도 보내기");
    expect(check().closest("label")?.textContent).toBe("대화에도 보내기");
  });

  it("꺼진 채 보내면 이 칸 이전과 같은 요청이다: alsoInChannel 키가 없다", async () => {
    await mount();
    await type("꺼진 채로 보내요");
    await send();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.rootId).toBe(ROOT);
    expect(sends[0]?.options === undefined || !("alsoInChannel" in sends[0].options)).toBe(true);
  });

  it("켠 채 보내면 alsoInChannel: true 가 같은 요청에 실린다", async () => {
    await mount();
    await type("대화에도 보여 주세요");
    await toggle();
    expect(check().checked).toBe(true);
    await send();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.options?.alsoInChannel).toBe(true);
    expect(sends[0]?.body).toBe("대화에도 보여 주세요");
  });

  it("마지막 선택을 기억하지 않는다: 보내고 나면 꺼지고, 다음 답글은 키 없이 나간다", async () => {
    await mount();
    await type("첫 번째");
    await toggle();
    await send();
    expect(check().checked).toBe(false);
    await type("두 번째");
    await send();
    expect(sends).toHaveLength(2);
    expect(sends[0]?.options?.alsoInChannel).toBe(true);
    expect(sends[1]?.options === undefined || !("alsoInChannel" in sends[1].options)).toBe(true);
  });

  it("보내지 못하면 글과 함께 체크가 남아 다시 보내도 같은 선택이다", async () => {
    await mount();
    await type("실패할 답글");
    await toggle();
    nextFailure = new ApiError(503, "unavailable");
    await send();
    expect(check().checked).toBe(true);
    expect(textarea().value).toBe("실패할 답글");
    nextFailure = null;
    await send();
    expect(sends).toHaveLength(2);
    expect(sends[1]?.options?.alsoInChannel).toBe(true);
    expect(check().checked).toBe(false);
  });

  it("다른 스레드로 옮기면 꺼진다", async () => {
    await mount();
    await toggle();
    expect(check().checked).toBe(true);
    await showThread(OTHER_ROOT);
    expect(check().checked).toBe(false);
  });

  it("옛 서버가 모르는 키로 거절하면 이유를 말한다 — 조용히 스레드로만 보내지 않는다", async () => {
    await mount();
    await type("옛 서버에 보내요");
    await toggle();
    nextFailure = new ApiError(400, "unknown field");
    await send();
    expect(need("thread-composer-error").textContent).toContain("대화에도 보내기");
    expect(need("thread-composer-error").textContent).toContain("지원하지 않아요");
    expect(sends).toHaveLength(1);
  });

  it("체크를 끈 채의 400 은 평소 문장이다(지워진 원본 등) — 모르는 서버 탓으로 돌리지 않는다", async () => {
    await mount();
    await type("끈 채로 보내요");
    nextFailure = new ApiError(400, "thread root must be a top-level message");
    await send();
    expect(need("thread-composer-error").textContent).toContain("답글을 달 수 없습니다");
    expect(need("thread-composer-error").textContent).not.toContain("지원하지 않아요");
  });

  it("키보드: 글 칸 다음에, 첨부 단추 앞에 서고 Space 로 켠다(네이티브 체크)", async () => {
    await mount();
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(textarea(), check())).toBe(true);
    expect(follows(check(), need("thread-composer-mention-trigger"))).toBe(true);
    expect(check().tabIndex).toBe(0);
    expect(check().disabled).toBe(false);
  });
});
