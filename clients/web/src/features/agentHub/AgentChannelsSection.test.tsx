// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { AgentChannelsSection } from "./AgentChannelsSection";

// 「채널에 추가」 칸은 앱이 그린 listbox 다(#4127): 단추 + 목록, 라벨이 칸과 목록의 이름.

const WS = "00000000-0000-7000-8000-000000000001";
const AGENT_ID = "00000000-0000-7000-8000-000000000102";
const CH_IN = "00000000-0000-7000-8000-000000000201";
const CH_PUBLIC = "00000000-0000-7000-8000-000000000202";
const CH_PRIVATE = "00000000-0000-7000-8000-000000000203";

const h = vi.hoisted(() => ({ addChannelMember: vi.fn(), channels: [] as unknown[] }));

vi.mock("@/app/session", () => ({ useSession: () => ({ workspaceId: "00000000-0000-7000-8000-000000000001" }) }));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useChannels: () => ({
    isPending: false,
    isError: false,
    groups: { channels: h.channels, dms: [] },
  }),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    addChannelMember: (...a: unknown[]) => h.addChannelMember(...a) as unknown,
    removeChannelMember: vi.fn(),
  };
});

const channel = (id: string, name: string, kind: Channel["kind"]): Channel => ({
  id,
  workspaceId: WS,
  kind,
  name,
  muted: false,
});

const agent: RosterMember = {
  id: AGENT_ID,
  workspaceId: WS,
  kind: "agent",
  status: "active",
  displayName: "김인턴",
  handle: "intern",
  channelCount: 1,
  channelIds: [CH_IN],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
};

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  h.addChannelMember.mockReset().mockResolvedValue(undefined);
  h.channels = [
    channel(CH_IN, "workbench", "public"),
    channel(CH_PUBLIC, "general", "public"),
    channel(CH_PRIVATE, "비밀", "private"),
  ];
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

function mount(offline = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(AgentChannelsSection, { agent, offline }))
    );
  });
}

const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="agent-hub-channel-add"]')!;
const optionEls = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const open = () =>
  act(() => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

describe("에이전트 채널 배치: 채널에 추가 칸", () => {
  it("라벨이 이름인 combobox 이고, 아직 안 들어간 채널만 항목으로 보인다(비공개는 글로 표시)", () => {
    mount();
    expect(trigger().tagName).toBe("BUTTON");
    expect(trigger().getAttribute("role")).toBe("combobox");
    const labelId = trigger().getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)?.textContent).toBe("채널에 추가");
    expect(trigger().textContent).toContain("채널 고르기");
    open();
    expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-labelledby")).toBe(labelId);
    expect(optionEls().map((o) => o.textContent)).toEqual(["#general", "#비밀 (비공개)"]);
  });

  it("항목을 고르면 단추에 보이고, 추가를 누르면 그 채널로 요청한다", async () => {
    mount();
    open();
    act(() => {
      optionEls()
        .find((o) => o.dataset.value === CH_PRIVATE)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(trigger().textContent).toContain("#비밀 (비공개)");
    expect(trigger().dataset.value).toBe(CH_PRIVATE);
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="agent-hub-channel-add-submit"]')!
        .click();
    });
    expect(h.addChannelMember).toHaveBeenCalledWith(WS, CH_PRIVATE, AGENT_ID);
  });

  it("오프라인이면 칸이 잠겨 열리지 않는다", () => {
    mount(true);
    expect(trigger().disabled).toBe(true);
    open();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe("에이전트 채널 배치: 내보내기 확인 (#4252)", () => {
  it("내보내기는 채널 멤버십만 지운다는 것과 에이전트·다이렉트 메시지가 남는다는 것을 말한다 (사이드바에 대화가 계속 보이는 이유)", () => {
    mount();
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="agent-hub-channel-remove"]')!
        .click();
    });
    const confirmText = [...document.querySelectorAll<HTMLElement>('[data-testid="agent-hub-channel-row"] .text-meta')]
      .map((el) => el.textContent)
      .join(" ");
    expect(confirmText).toContain("내보내면 이 채널의 멘션이 더 이상 전달되지 않아요.");
    expect(confirmText).toContain("에이전트 자체와 다이렉트 메시지는 그대로 남아요.");
    expect(document.querySelector('[data-testid="agent-hub-channel-remove-confirm"]')).not.toBeNull();
  });
});
