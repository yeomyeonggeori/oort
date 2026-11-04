// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { AgentChannelsSection } from "./AgentChannelsSection";

// 「채널에 추가」 칸은 앱이 그린 listbox 다(#4127): 단추 + 목록, 라벨이 칸과 목록의 이름.

const WS = "00000000-0000-7000-8000-000000000001";
const AGENT_ID = "00000000-0000-7000-8000-000000000102";
const CH_IN = "00000000-0000-7000-8000-000000000201";
const CH_PUBLIC = "00000000-0000-7000-8000-000000000202";
const CH_PRIVATE = "00000000-0000-7000-8000-000000000203";

const h = vi.hoisted(() => ({
  addChannelMember: vi.fn(),
  channels: [] as unknown[],
  /** 채널 목록 질의의 실패(#5242). */
  query: { isError: false, error: null as unknown, refetch: vi.fn() },
}));

vi.mock("@/app/session", () => ({ useSession: () => ({ workspaceId: "00000000-0000-7000-8000-000000000001" }) }));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useChannels: () => ({
    isPending: false,
    isError: h.query.isError,
    error: h.query.error,
    refetch: h.query.refetch,
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
let ko: AppLocale;

beforeAll(async () => {
  ko = await koreanLocale();
  act_.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  h.query.isError = false;
  h.query.error = null;
  h.query.refetch.mockReset();
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

function mount(offline = false, korean = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = createElement(QueryClientProvider, { client }, createElement(AgentChannelsSection, { agent, offline }));
  act(() => {
    root?.render(korean ? createElement(LocaleProvider, { locale: ko, children: page }) : page);
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

// #5242: 채널 목록을 못 읽으면 「어디에 들어가 있는지 확인할 수 없어요」라는 결과를 그대로 말하고, 그 뒤에 원인과 다시 시도가 붙는다.
describe("에이전트 채널 배치: 채널 목록 불러오기 실패 (#5242)", () => {
  // 지키는 것: 결과 문장은 남고(정보를 버리지 않는다) 이유가 오류 객체의 원인을 따라가며, 다시 시도가 목록을 다시 읽는다.
  it("결과 문장 뒤에 원인이 붙고 다시 시도가 목록을 다시 읽는다", () => {
    vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(false);
    h.query.isError = true;
    h.query.error = new NetworkError("unreachable", 15_000);
    mount(false, true);
    const note = document.querySelector<HTMLElement>('[data-testid="agent-hub-channels-list-error"]');
    expect(note?.getAttribute("role")).toBe("alert");
    expect(note?.textContent).toContain(
      "채널 목록을 불러오지 못해 어디에 들어가 있는지 확인할 수 없어요. 오프라인이에요. 연결되면 다시 불러올 수 있어요."
    );
    act(() => note?.querySelector("button")?.click());
    expect(h.query.refetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
