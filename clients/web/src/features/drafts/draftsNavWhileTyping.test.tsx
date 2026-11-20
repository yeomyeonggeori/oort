// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// 쓰는 동안 사이드바 「초안」 줄이 서지 않는다 (#6030).
//
// 입력창은 글자마다 초안을 저장한다. 그 신호로 「초안」 줄이 첫 글자에 서면 그 아래 목록 전체가 한 줄(36px)만큼
// 내려갔다. 지금 열어 둔 대화의 초안으로는 줄을 세우지 않고, 그 대화를 떠날 때 세운다. 실제 입력창과 실제 사이드바
// 줄을 한 나무에 올려 잰다(브라우저 실측은 PR 본문).
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
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { clearDraft, readDraft, writeDraft } from "@/features/chat/draftStore";
import { Composer } from "@/features/chat/Composer";
import { DraftsNavItem } from "./DraftsNavItem";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH_A = "00000000-0000-7000-8000-000000000201";
const CH_B = "00000000-0000-7000-8000-000000000202";
const CHANNELS: Channel[] = [
  { id: CH_A, workspaceId: WS, kind: "public", name: "일반", muted: false } as Channel,
  { id: CH_B, workspaceId: WS, kind: "public", name: "엔진", muted: false } as Channel,
];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let openChannel: (id: string) => void = () => undefined;

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
  resetSchedulerDisabledForTest();
  clearDraft(WS, CH_A);
  clearDraft(WS, CH_B);
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
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyun" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

/** 사이드바 줄과 입력창 하나. 대화를 옮기면 ChatShell처럼 같은 입력창이 다른 채널을 받는다. */
function Shell() {
  const [channelId, setChannelId] = useState(CH_A);
  openChannel = setChannelId;
  return createElement(
    "div",
    null,
    createElement("ul", null, createElement(DraftsNavItem)),
    createElement(Composer, {
      workspaceId: WS,
      channelId,
      directory: makeDirectory([]),
      channels: CHANNELS,
      channelLabel: channelId === CH_A ? "일반" : "엔진",
      recipient: "place",
      dmAgent: null,
      quote: null,
      onCancelQuote: () => undefined,
      onSend: () => undefined,
    })
  );
}

async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
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
          { initialEntries: [`/c/${CH_A}`] },
          createElement(
            OpenAgentProfileContext.Provider,
            { value: () => undefined },
            createElement(SessionProvider, { value: session() }, createElement(Shell))
          )
        )
      )
    );
  });
  await settle();
  return host;
}

async function type(root: HTMLElement, value: string) {
  const input = root.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function moveTo(channelId: string) {
  await act(async () => openChannel(channelId));
  await settle();
}

const navRow = (root: HTMLElement) => root.querySelector('[data-testid="nav-drafts"]');

describe("쓰는 동안 「초안」 줄이 서지 않는다 (#6030)", () => {
  it("초안 0개에서 치는 동안 줄이 없고, 떠나면 1개, 돌아와 다 지우고 떠나면 0개", async () => {
    const root = await mount();
    expect(navRow(root)).toBeNull();
    for (const prefix of ["배", "배포 ", "배포 전에 순서를 확인해요"]) {
      await type(root, prefix);
      expect(navRow(root)).toBeNull();
    }
    // 저장은 그대로 글자마다 한다 — 글을 잃지 않는다.
    expect(readDraft(WS, CH_A)).toBe("배포 전에 순서를 확인해요");

    await moveTo(CH_B);
    expect(navRow(root)).not.toBeNull();

    await moveTo(CH_A);
    await type(root, "");
    await moveTo(CH_B);
    expect(navRow(root)).toBeNull();
  });

  it("다른 대화에 초안이 이미 있으면 치기 전후 모두 줄이 서 있다", async () => {
    writeDraft(WS, CH_B, "엔진 채널에 남긴 글");
    const root = await mount();
    expect(navRow(root)).not.toBeNull();
    await type(root, "일반 채널에 쓰는 글");
    expect(navRow(root)).not.toBeNull();
  });
});
