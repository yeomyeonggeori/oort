// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRoster, type RosterMember } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import { listHostedConnections } from "@momo/core/features/hostedAgents/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiAgentsPane } from "./AiAgentsPane";

// AIH-7 (#3428): 에이전트 표와 만들기 3종.
// - 칸의 문장은 서버 값 → core 라벨. 개인 키는 「개인 키 · 나만」, Claude 구독 대행이 꺼진 에이전트는 회색 「문의 중」.
// - 웹에서 내 구독 만들기는 숨지 않고 「데스크탑에서」 사유로 잠긴다.

const envSlot = vi.hoisted(() => ({ tauri: false }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return envSlot.tauri;
    },
    get SUBSCRIPTION_AGENTS_BUILD_FLAG() {
      return true;
    },
  };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn() };
});
vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return { ...actual, fetchWorkspace: vi.fn() };
});
vi.mock("@momo/core/features/hostedAgents/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/hostedAgents/api")>();
  return { ...actual, listHostedConnections: vi.fn() };
});
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000102";

const person = (id: string, name: string, role: RosterMember["role"]): RosterMember => ({
  id, workspaceId: WS, kind: "human", status: "active", displayName: name, handle: name, role,
  channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
});
const bot = (id: string, name: string, extra: Partial<RosterMember>): RosterMember => ({
  ...person(id, name, undefined), kind: "agent", paused: false, ...extra,
});
const owned = (id: string, name: string) => ({ ownerHumanId: id, owner: { id, displayName: name } });

const ROSTER = (role: RosterMember["role"]): RosterMember[] => [
  person(ME, "곽성재", role),
  person(OTHER, "서연", "member"),
  bot("a1", "김인턴", { brain: "team_key", callableBy: "everyone" }),
  bot("a2", "성재-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: true, ...owned(ME, "성재") }),
  bot("a3", "서연-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: false, ...owned(OTHER, "서연") }),
  bot("a4", "성재-키", { brain: "personal_key", callableBy: "owner_only", ...owned(ME, "성재") }),
  bot("a5", "성재-claude", {
    brain: "subscription", callableBy: "owner_only", hostOnline: true, brainUnavailableReason: "claude_subscription_agent_paused", ...owned(ME, "성재"),
  }),
  bot("a6", "hermes", { brain: "external", callableBy: "everyone" }),
];

const session: SessionContextValue = {
  session: {
    accessToken: "access", refreshToken: "refresh",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
};

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(path = "/ai/agents") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(QueryClientProvider, { client }, createElement(SessionProvider, { value: session }, createElement(AiAgentsPane)))
      )
    );
  });
}
const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
async function until(testId: string) {
  return waitFor(() => {
    const el = q(testId);
    if (!el) throw new Error(`missing ${testId}`);
    return el;
  });
}
// 좁은 폭에서만 보이는 칸 이름(aria-hidden)은 칸의 값이 아니다.
const cell = (kind: string, handle: string) => {
  const td = q(`ai-agent-${kind}-${handle}`)?.cloneNode(true) as HTMLElement | undefined;
  td?.querySelectorAll("[data-cell-label]").forEach((el) => el.remove());
  return td?.textContent?.replace(/\s+/g, " ").trim();
};

beforeAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => {
  envSlot.tauri = false;
  vi.mocked(fetchRoster).mockResolvedValue(ROSTER("owner"));
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] } as never);
  vi.mocked(fetchWorkspace).mockResolvedValue({
    id: WS, slug: "team", name: "우리 팀", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "",
    subscriptionAgentsEnabled: true,
  });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("표", () => {
  it("네 열 머리와 여섯 줄: 쓰는 AI · 부를 수 있는 사람 · 비용 · 상태가 core 라벨 그대로 나온다", async () => {
    mount();
    await until("ai-agents-table");
    const heads = [...document.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads).toEqual(["에이전트", "쓰는 AI", "부를 수 있는 사람", "비용", "상태"]);
    expect(document.querySelectorAll("tbody tr")).toHaveLength(6);
    expect([cell("brain", "김인턴"), cell("callable", "김인턴"), cell("cost", "김인턴")]).toEqual(["팀 AI 키", "누구나", "팀"]);
    expect([cell("brain", "성재-codex"), cell("callable", "성재-codex"), cell("status", "성재-codex")]).toEqual(["내 구독", "나만", "내 맥 켜짐"]);
    expect([cell("brain", "hermes"), cell("cost", "hermes")]).toEqual(["외부 (직접 운영)", "외부 운영자"]);
  });

  it("개인 키는 「개인 키 · 나만」이지 구독이 아니다", async () => {
    mount();
    await until("ai-agents-table");
    expect(cell("brain", "성재-키")).toBe("개인 키");
    expect(cell("callable", "성재-키")).toBe("나만");
    expect(cell("cost", "성재-키")).toBe("개인 키");
    expect(cell("brain", "성재-키")).not.toContain("구독");
  });

  it("Claude 구독 대행이 꺼진 에이전트는 「문의 중」 + 설명이고 맥 켜짐을 말하지 않는다", async () => {
    mount();
    await until("ai-agents-table");
    const status = cell("status", "성재-claude") ?? "";
    expect(status).toContain("문의 중");
    expect(status).toContain("Anthropic 약관 확인 전까지");
    expect(status).not.toContain("맥 켜짐");
    expect(q("ai-agent-status-성재-claude")?.querySelector("[data-tone='mute']")?.textContent).toBe("문의 중");
  });

  it("남의 구독은 잠금으로 표시하고 스크린리더에도 「내가 부를 수 없어요」를 읽어 준다", async () => {
    mount();
    await until("ai-agents-table");
    expect(q("ai-agent-row-서연-codex")?.getAttribute("data-locked")).toBe("true");
    expect(cell("callable", "서연-codex")).toBe("서연 님만 · 내가 부를 수 없어요");
    expect(q("ai-agent-callable-서연-codex")?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(cell("status", "서연-codex")).toContain("맥 꺼짐");
    expect(cell("status", "서연-codex")).toContain("팀 키로 대신하지 않아요");
    expect(q("ai-agent-row-성재-codex")?.getAttribute("data-locked")).toBeNull();
  });

  it("행 머리가 th scope=row 이고 표에 이름이 있다 (보조기기)", async () => {
    mount();
    await until("ai-agents-table");
    expect(document.querySelectorAll("tbody th[scope='row']")).toHaveLength(6);
    expect(document.querySelector("caption")?.textContent).toContain("쓰는 AI");
    expect(document.querySelector("[role='region']")?.getAttribute("tabindex")).toBe("0");
  });
});

describe("네 가지 상태", () => {
  it("불러오는 중", () => {
    vi.mocked(fetchRoster).mockReturnValue(new Promise(() => undefined));
    mount();
    expect(q("ai-agents-loading")?.getAttribute("role")).toBe("status");
    expect(q("ai-agents-table")).toBeNull();
    expect(q("ai-agents-empty")).toBeNull();
  });

  it("못 읽음: 없다고 말하지 않고 다시 불러오기를 낸다", async () => {
    vi.mocked(fetchRoster).mockRejectedValue(new Error("boom"));
    mount();
    const banner = await until("ai-agents-error");
    expect(banner.textContent).toContain("에이전트를 불러오지 못했어요");
    expect(banner.textContent).toContain("다시 불러오기");
    expect(q("ai-agents-empty")).toBeNull();
  });

  it("비어 있음: 만들 수 있는 사람에게는 만들기를, 없는 사람에게는 누가 만드는지를", async () => {
    vi.mocked(fetchRoster).mockResolvedValue([person(ME, "곽성재", "owner")]);
    mount();
    expect((await until("ai-agents-empty")).textContent).toContain("만들면 채널에서 @로 부를 수 있어요");
  });

  it("비어 있음, 일반 멤버", async () => {
    vi.mocked(fetchRoster).mockResolvedValue([person(ME, "곽성재", "member")]);
    mount();
    const empty = await until("ai-agents-empty");
    expect(empty.textContent).toContain("소유자나 관리자가 만들 수 있어요");
    expect(q("ai-agents-create")).toBeNull();
  });
});

describe("에이전트 만들기 3종", () => {
  it("일반 멤버에게는 만들기 단추가 없다", async () => {
    vi.mocked(fetchRoster).mockResolvedValue(ROSTER("member"));
    mount();
    await until("ai-agents-table");
    expect(q("ai-agents-create")).toBeNull();
  });

  it("웹: 팀·내 구독·외부 셋을 보이고, 내 구독은 「데스크탑에서 해요」로 잠겨 사유를 든다", async () => {
    mount();
    await until("ai-agents-table");
    act(() => fireEvent.click(q("ai-agents-create") as HTMLElement));
    await until("create-agent-chooser");
    expect(["team", "mySubscription", "external"].map((k) => q(`create-kind-${k}`)?.getAttribute("data-state"))).toEqual([
      "available", "locked", "available",
    ]);
    expect(q("create-kind-team")?.textContent).toContain("팀 AI 키로 답해요");
    expect(q("create-kind-team-audience")?.textContent).toBe("운영자");
    expect(q("create-kind-external-audience")?.textContent).toBe("소유자·관리자");
    expect(q("create-kind-mySubscription-audience")?.textContent).toBe("데스크탑에서 해요");
    const sub = q("create-kind-mySubscription") as HTMLElement;
    expect(sub.getAttribute("aria-disabled")).toBe("true");
    expect(sub.hasAttribute("disabled")).toBe(false); // 포커스를 받아 사유를 읽어야 한다
    expect(q("create-kind-mySubscription-reason")?.id).toBe(sub.getAttribute("aria-describedby"));
    expect(q("create-kind-mySubscription-reason")?.textContent).toContain("데스크탑 앱에서");
    // 잠긴 줄을 눌러도 아무 창도 열리지 않는다.
    act(() => fireEvent.click(sub));
    expect(q("create-agent-chooser")).not.toBeNull();
  });

  it("데스크탑: 내 구독도 열리고, 누르면 로그인 → 에이전트로 만들기 첫 창이 뜬다", async () => {
    envSlot.tauri = true;
    mount();
    await until("ai-agents-table");
    act(() => fireEvent.click(q("ai-agents-create") as HTMLElement));
    await until("create-agent-chooser");
    await waitFor(() => expect(q("create-kind-mySubscription")?.getAttribute("data-state")).toBe("available"));
    act(() => fireEvent.click(q("create-kind-mySubscription") as HTMLElement));
    await until("subscription-start-dialog");
    expect(q("create-agent-chooser")).toBeNull();
  });

  it("팀 에이전트를 고르면 기존 만들기 창이 열린다", async () => {
    mount();
    await until("ai-agents-table");
    act(() => fireEvent.click(q("ai-agents-create") as HTMLElement));
    await until("create-agent-chooser");
    act(() => fireEvent.click(q("create-kind-team") as HTMLElement));
    await waitFor(() => expect(document.querySelector("form#create-agent-form")).not.toBeNull());
    expect(q("create-agent-chooser")).toBeNull();
  });

  it("개요의 「에이전트 만들기」가 ?create=1 로 오면 고르는 창이 바로 열린다", async () => {
    mount("/ai/agents?create=1");
    await until("create-agent-chooser");
  });
});
