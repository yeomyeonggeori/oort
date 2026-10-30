// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// 「가 ⏎ 나」: 웹·데스크탑 입력창의 줄바꿈 (#4321).
//
// 폰의 줄바꿈이 사라진다는 보고(owner 10-24)를 확인하며 같은 표로 웹·데스크탑도 본다. 이미 되는 쪽이라
// 이 시험은 **증거를 남기는 가드**다:
//
//   · 데스크탑 폭 — Enter 는 보내기, Shift+Enter 는 줄바꿈이다. 줄바꿈은 textarea 의 기본 동작에 맡기므로
//     Shift+Enter 의 keydown 은 **막히지 않아야** 한다(`defaultPrevented` 가 거짓).
//   · 폰 셸 폭 — Enter 도 줄바꿈이다(소프트 자판에는 Shift+Enter 가 없다).
//   · 어느 쪽이든 입력 값의 `\n` 은 보낸 본문에 그대로 남고, 양 끝의 공백·줄바꿈만 잘린다.
//
// jsdom 은 textarea 가 keydown 에서 `\n` 을 넣는 브라우저 기본 동작을 하지 않는다 — 그래서 「키 → `\n`」 칸은
// `composerKeyIntent`(코어 시험이 줄을 못 박는다)의 판정과 「막지 않았다」로 갈음하고, 값에 `\n` 이 든 채
// 보내는 칸은 값을 직접 심어 잰다. 실제 브라우저에서의 키 입력은 PR 본문의 실행 증거를 본다.
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
const CHANNELS: Channel[] = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false } as Channel];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
const sends: Array<{ body: string }> = [];
const realMatchMedia = window.matchMedia;

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
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  clearDraft(WS, CH);
  sends.length = 0;
  onlineManager.setOnline(true);
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  window.matchMedia = realMatchMedia;
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

/** 폰 셸 폭(`useIsMobileShell`)을 흉내 낸다 — jsdom 에는 `matchMedia` 가 없다. */
function pretendPhoneShell(): void {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function mount(): Promise<HTMLElement> {
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
            createElement(
              SessionProvider,
              { value: session() },
              createElement(Composer, {
                workspaceId: WS,
                channelId: CH,
                directory: makeDirectory([]),
                channels: CHANNELS,
                channelLabel: "일반",
                recipient: "place",
                dmAgent: null,
                quote: null,
                onCancelQuote: () => undefined,
                onSend: (body: string) => {
                  sends.push({ body });
                },
              })
            )
          )
        )
      )
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

function textarea(root: HTMLElement): HTMLTextAreaElement {
  return root.querySelector("textarea") as HTMLTextAreaElement;
}

async function type(root: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea(root), value);
    textarea(root).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** keydown 을 쏘고, 컴포저가 기본 동작을 막았는지(= 자기가 처리했는지)를 돌려준다. */
async function press(root: HTMLElement, init: KeyboardEventInit): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    textarea(root).dispatchEvent(event);
  });
  return event.defaultPrevented;
}

async function clickSend(root: HTMLElement) {
  const form = root.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("데스크탑 폭: Enter 는 보내기, Shift+Enter 는 줄바꿈", () => {
  it("Shift+Enter 는 막히지 않고 아무것도 보내지 않는다 — 줄바꿈은 textarea 의 기본 동작이다", async () => {
    const root = await mount();
    await type(root, "가");
    const prevented = await press(root, { key: "Enter", shiftKey: true });
    expect(prevented).toBe(false);
    expect(sends).toEqual([]);
  });

  it("줄바꿈이 든 글은 Enter 로 그대로 나간다", async () => {
    const root = await mount();
    await type(root, "가\n나");
    const prevented = await press(root, { key: "Enter" });
    expect(prevented).toBe(true);
    expect(sends).toEqual([{ body: "가\n나" }]);
  });

  it("보내기 단추(폼 제출)로 보내도 같다", async () => {
    const root = await mount();
    await type(root, "a\nb");
    await clickSend(root);
    expect(sends).toEqual([{ body: "a\nb" }]);
  });

  it("가운데 빈 줄은 남고 양 끝의 공백·줄바꿈만 잘린다", async () => {
    const root = await mount();
    await type(root, "\n  가\n\n나 \n");
    await clickSend(root);
    expect(sends).toEqual([{ body: "가\n\n나" }]);
  });
});

describe("폰 셸 폭: Enter 도 줄바꿈이다", () => {
  it("Enter 는 막히지 않고 보내지 않는다 — 소프트 자판에는 Shift+Enter 가 없다", async () => {
    pretendPhoneShell();
    const root = await mount();
    await type(root, "가");
    const prevented = await press(root, { key: "Enter" });
    expect(prevented).toBe(false);
    expect(sends).toEqual([]);
  });

  it("줄바꿈이 든 글은 단추로 그대로 나간다", async () => {
    pretendPhoneShell();
    const root = await mount();
    await type(root, "가\n나");
    await clickSend(root);
    expect(sends).toEqual([{ body: "가\n나" }]);
  });
});


it("#4790 입력창 호출부도 다섯 줄에서 멈추고 내부 스크롤한다", async () => {
  const height = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  try {
    await mount();
    const input = document.querySelector("textarea")!;
    // jsdom에서 CSS 없는 기본값은 16px × 1.5 = 24px다.
    const css = window.getComputedStyle(input);
    const row = Number.parseFloat(css.lineHeight) || (Number.parseFloat(css.fontSize) || 16) * 1.5;
    const frame = [css.paddingTop, css.paddingBottom, css.borderTopWidth, css.borderBottomWidth]
      .reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
    expect(Number.parseFloat(input.style.height)).toBe(Math.round(5 * row + frame));
    expect(input.style.overflowY).toBe("auto");
  } finally {
    height.mockRestore();
  }
});
