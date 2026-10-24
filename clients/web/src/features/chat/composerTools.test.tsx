// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import type { QuoteDraft } from "@momo/core/features/timeline/quote";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// 웹·데스크탑 입력창의 도구 줄과 맥락 띠 (#4317).
//
// 도구 줄의 순서는 **리터럴 배열**로 못 박는다(컴포넌트가 쓰는 상수를 가져다 비교하면 같이 틀려도 통과한다).
// 마이크는 #4306 이 붙기 전까지 DOM 에 없어야 하고(눌러도 아무 일 없는 단추 금지), 띠는 실을 것이 없으면 없다.
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

async function mount(
  props: { quote?: QuoteDraft | null; dmAgent?: RosterMember | null } = {}
): Promise<HTMLElement> {
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
                dmAgent: props.dmAgent ?? null,
                quote: props.quote ?? null,
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

async function clickSend(root: HTMLElement) {
  const form = root.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const QUOTE: QuoteDraft = {
  targetId: "00000000-0000-7000-8000-000000000301",
  targetSeq: 7,
  authorMemberId: ME,
  block: {
    kind: "ready",
    targetId: "00000000-0000-7000-8000-000000000301",
    targetSeq: 7,
    authorMemberId: ME,
    lines: ["배포 일정 확인했어요"],
    truncated: false,
    quotesAnother: false,
    edited: false,
  },
};

function agent(hostOnline: boolean | undefined): RosterMember {
  return {
    id: "00000000-0000-7000-8000-000000000501",
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "달무리 봇",
    handle: "dalmuri-bot",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...(hostOnline === undefined ? {} : { hostOnline }),
  };
}

/** 도구 줄 안의 단추를 DOM 순서대로. 보내기 쪽(▾ 포함)은 뒤에 따로 선다. */
function toolRowTestIds(root: HTMLElement): string[] {
  const left = root.querySelector('[data-testid="composer-actions"] > div') as HTMLElement;
  return [...left.querySelectorAll("button")].map((b) => b.getAttribute("data-testid") ?? "");
}

describe("도구 줄: 왼쪽 + · 멘션 · 이모지 · 서식, 오른쪽 보내기", () => {
  it("순서는 + 멘션 이모지 서식이고 마이크는 없다", async () => {
    const root = await mount();
    expect(toolRowTestIds(root)).toEqual([
      "composer-attach",
      "composer-mention-trigger",
      "composer-emoji-trigger",
      "composer-format-trigger",
    ]);
    expect(root.querySelector('[data-testid*="mic"], [aria-label*="받아쓰기"], [aria-label*="마이크"]')).toBeNull();
  });

  it("글 칸은 도구 줄 위(DOM 앞)에 서고 보내기는 도구 줄 안 맨 뒤다", async () => {
    const root = await mount();
    const input = root.querySelector('[data-testid="composer-input"]') as HTMLElement;
    const actions = root.querySelector('[data-testid="composer-actions"]') as HTMLElement;
    expect(input.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const send = root.querySelector('[data-testid="composer-send"]') as HTMLElement;
    expect(actions.contains(send)).toBe(true);
  });

  it("글이 비면 보내기는 흐리고(disabled) 글이 있으면 켜진다", async () => {
    const root = await mount();
    const send = root.querySelector('[data-testid="composer-send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await type(root, "안녕");
    expect(send.disabled).toBe(false);
  });

  it("도구 단추는 모두 Tab 으로 닿는다(tabindex 를 빼지 않았다)", async () => {
    const root = await mount();
    await type(root, "안녕");
    const left = root.querySelector('[data-testid="composer-actions"] > div') as HTMLElement;
    for (const button of left.querySelectorAll("button")) {
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("서식 단추", () => {
  it("글이 비었으면 흐리고(aria-disabled) 눌러도 트레이가 열리지 않는다", async () => {
    const root = await mount();
    const button = root.querySelector('[data-testid="composer-format-trigger"]') as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await act(async () => button.click());
    expect(document.querySelector('[data-testid="composer-format-tray"]')).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("선택이 없어도 캐럿의 낱말을 골라 서식 트레이를 연다", async () => {
    const root = await mount();
    await type(root, "배포 롤백 근거");
    const input = textarea(root);
    input.focus();
    input.setSelectionRange(4, 4);
    const button = root.querySelector('[data-testid="composer-format-trigger"]') as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled")).toBeNull();
    await act(async () => button.click());
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 5]);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[data-testid="composer-format-tray"]')).not.toBeNull();
  });

  it("터치 기기(OS 선택 콜아웃)에서는 단추가 없다", async () => {
    pretendPhoneShell();
    const root = await mount();
    expect(root.querySelector('[data-testid="composer-format-trigger"]')).toBeNull();
  });
});

describe("맥락 띠", () => {
  it("인용도 호스트 칩도 없으면 띠가 없다", async () => {
    const root = await mount();
    expect(root.querySelector('[data-testid="composer-context-band"]')).toBeNull();
  });

  it("인용 중이면 띠가 서고 인용 칩이 카드 안에 있다", async () => {
    const root = await mount({ quote: QUOTE });
    const band = root.querySelector('[data-testid="composer-context-band"]') as HTMLElement;
    const frame = root.querySelector('[data-testid="composer-frame"]') as HTMLElement;
    expect(band).not.toBeNull();
    expect(frame.contains(band)).toBe(true);
    expect(band.querySelector('[data-testid="composer-quote"]')).not.toBeNull();
    expect(band.querySelector('[data-testid="composer-context-host"]')).toBeNull();
  });

  it("에이전트 DM 은 연결 안 됨일 때만 호스트 칩을 띠에 싣는다 — 연결됨은 띠도 칩도 없다(#4044)", async () => {
    const on = await mount({ dmAgent: agent(true) });
    expect(on.querySelector('[data-testid="composer-context-host"]')).toBeNull();
    expect(on.querySelector('[data-testid="composer-context-band"]')).toBeNull();
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    host?.remove();
    const off = await mount({ dmAgent: agent(false) });
    expect(off.querySelector('[data-testid="composer-context-host"]')?.textContent).toBe("일하는 곳 · 연결 안 됨");
  });

  it("호스트 상태를 모르는 에이전트(필드 없음)는 칩도 띠도 없다", async () => {
    const root = await mount({ dmAgent: agent(undefined) });
    expect(root.querySelector('[data-testid="composer-context-band"]')).toBeNull();
  });
});

describe("보내면 한 줄 높이로 돌아온다", () => {
  it("여러 줄을 쓰면 글 칸만 자라고, 보내면 처음 높이로 돌아온다", async () => {
    // jsdom 의 scrollHeight 는 늘 0 이라 높이 시험이 헛돈다: 줄 수에 비례하는 값을 심어 자람을 눈에 보이게 한다.
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        // 브라우저의 scrollHeight 는 지금 높이보다 작아지지 않는다(그래서 훅이 먼저 height 를 놓아 준다).
        const current = this.style.height === "auto" ? 0 : Number.parseFloat(this.style.height) || 0;
        return Math.max(this.value.split("\n").length * 24, current);
      },
    });
    try {
      const root = await mount();
      const px = () => Number.parseFloat(textarea(root).style.height);
      const rest = px();
      await type(root, "가\n나\n다\n라");
      const grown = px();
      expect(grown).toBeGreaterThan(rest);
      const actions = root.querySelector('[data-testid="composer-actions"]') as HTMLElement;
      expect(actions).not.toBeNull();
      await clickSend(root);
      expect(sends).toEqual([{ body: "가\n나\n다\n라" }]);
      expect(px()).toBe(rest);
    } finally {
      if (desc) Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", desc);
      else delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });
});
