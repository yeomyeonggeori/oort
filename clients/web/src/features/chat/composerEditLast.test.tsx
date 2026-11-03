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
// 빈 입력칸의 ↑ = 이 대화에서 내 마지막 메시지 고치기 (#5191, Slack식).
//
// 메시지 고치기는 `⋯` 메뉴 맨 아래에 있어 사람들이 찾지 못했다. 이 시험은 입력칸이 그 길을 **언제 열고 언제 열지 않는지**를
// 못 박는다. 어느 메시지가 열리는지(대상 판정)는 코어 `lastEditableMessage` 시험이, 열린 뒤의 흐름(편집기·저장·초점 복귀)은
// `scripts/capture-5191.mjs` 가 실제 브라우저(Chromium·WebKit)에서 잰다.
//
//   · 빈 입력칸 + 맨 ↑            → 부른다. 열었으면(true) 키를 먹고, 고칠 글이 없으면(false) 키는 textarea 의 것으로 남는다.
//   · 글이 든 입력칸의 ↑          → 부르지 않는다(커서 이동). 공백뿐인 글도 글이다.
//   · 수식키 · 한글 조합 중의 ↑    → 부르지 않는다.
//   · 이 키를 모르는 입력칸        → `onEditLast` 가 없으면 동작이 예전과 한 글자도 다르지 않다(스레드 입력칸).
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
  onlineManager.setOnline(true);
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
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

async function mount(onEditLast?: () => boolean): Promise<HTMLElement> {
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
                onSend: () => undefined,
                ...(onEditLast ? { onEditLast } : {}),
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

describe("빈 입력칸의 ↑", () => {
  it("맨 ↑ 는 「마지막 메시지 고치기」를 부르고, 열었으면 키를 먹는다", async () => {
    const onEditLast = vi.fn(() => true);
    const root = await mount(onEditLast);
    const prevented = await press(root, { key: "ArrowUp" });
    expect(onEditLast).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it("고칠 글이 없어 아무것도 열지 못했으면 키는 textarea 의 것으로 남는다", async () => {
    const onEditLast = vi.fn(() => false);
    const root = await mount(onEditLast);
    const prevented = await press(root, { key: "ArrowUp" });
    expect(onEditLast).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(false);
  });

  it("글이 한 글자라도 있으면 ↑ 는 커서의 것이다(부르지 않는다)", async () => {
    const onEditLast = vi.fn(() => true);
    const root = await mount(onEditLast);
    await type(root, "쓰던 글");
    const prevented = await press(root, { key: "ArrowUp" });
    expect(onEditLast).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it("공백뿐인 글도 글이다: 그 입력칸의 ↑ 는 여전히 커서의 것이다", async () => {
    const onEditLast = vi.fn(() => true);
    const root = await mount(onEditLast);
    await type(root, " ");
    await press(root, { key: "ArrowUp" });
    expect(onEditLast).not.toHaveBeenCalled();
  });

  it("글을 지워 다시 비면 ↑ 가 다시 열린다", async () => {
    const onEditLast = vi.fn(() => true);
    const root = await mount(onEditLast);
    await type(root, "가");
    await press(root, { key: "ArrowUp" });
    expect(onEditLast).not.toHaveBeenCalled();
    await type(root, "");
    await press(root, { key: "ArrowUp" });
    expect(onEditLast).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
  ])("%s+↑ 는 운영체제·브라우저의 것이다(부르지 않는다)", async (_name, modifier) => {
    const onEditLast = vi.fn(() => true);
    const root = await mount(onEditLast);
    const prevented = await press(root, { key: "ArrowUp", ...modifier });
    expect(onEditLast).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it("한글 조합 중의 ↑ 는 IME 의 후보 창 것이다(부르지 않는다)", async () => {
    const onEditLast = vi.fn(() => true);
    const root = await mount(onEditLast);
    const prevented = await press(root, { key: "ArrowUp", isComposing: true });
    expect(onEditLast).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it("↓ 와 다른 키는 부르지 않는다", async () => {
    const onEditLast = vi.fn(() => true);
    const root = await mount(onEditLast);
    await press(root, { key: "ArrowDown" });
    await press(root, { key: "ArrowLeft" });
    await press(root, { key: "a" });
    expect(onEditLast).not.toHaveBeenCalled();
  });

  it("이 키를 모르는 입력칸(onEditLast 없음)은 예전과 같다: 막지도 않는다", async () => {
    const root = await mount();
    const prevented = await press(root, { key: "ArrowUp" });
    expect(prevented).toBe(false);
  });
});
