// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchRoster, listChannels, type RosterMember } from "@momo/core/lib/api";
import { listHostedConnections } from "@momo/core/features/hostedAgents/api";
import {
  deleteProviderLink,
  fetchProviderChain,
  fetchProviderLink,
  fetchWorkspace,
  putProviderLink,
  testProviderLink,
} from "@momo/core/features/settings/api";
import { fetchProviderDefaultAi, putProviderDefaultAi } from "@momo/core/features/settings/defaultAi";
import { defaultAiUnsetSentence } from "@momo/core/features/ai/aiHubModel";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiTeamKeysPane } from "./AiTeamKeysPane";

// =============================================================================
// 「팀 AI 키」 구획 (AIH-6, #3400). 운영자 화면, 비운영자 읽기 전용, 비어 있는 서버, 추가 폼,
// 끊기 영향 문장, 기본 AI 표의 「고르지 않으면」, 개인 API 키 예약 자리.
// =============================================================================

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, IS_TAURI: true, SUBSCRIPTION_AGENTS_BUILD_FLAG: true };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn(), listChannels: vi.fn() };
});
vi.mock("@momo/core/features/hostedAgents/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/hostedAgents/api")>();
  return { ...actual, listHostedConnections: vi.fn() };
});
vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchProviderLink: vi.fn(),
    fetchProviderChain: vi.fn(),
    fetchWorkspace: vi.fn(),
    deleteProviderLink: vi.fn(),
    putProviderLink: vi.fn(),
    testProviderLink: vi.fn(),
  };
});
vi.mock("@momo/core/features/settings/defaultAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/defaultAi")>();
  return { ...actual, fetchProviderDefaultAi: vi.fn(), putProviderDefaultAi: vi.fn() };
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const BOSS = "00000000-0000-7000-8000-000000000102";
const AGENT = "00000000-0000-7000-8000-000000000301";

function human(id: string, name: string, role: RosterMember["role"]): RosterMember {
  return {
    id, workspaceId: WS, kind: "human", status: "active", displayName: name, handle: name, role,
    channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  };
}
const AGENT_MEMBER: RosterMember = {
  ...human(AGENT, "김인턴", "member"),
  kind: "agent",
};

const KEY_LINK = {
  schema: "momo.provider_link.v0",
  configured: true,
  source: "database",
  mode: "external-hermes",
  baseUrl: "https://api.anthropic.com/v1",
  endpointLabel: "https://api.anthropic.com/v1",
  bearerConfigured: true,
  bearerLast4: "7c1e",
  availability: "live",
  keyConfigured: true,
  updatedAtMs: 1_790_000_000_000,
  diagnostics: [] as string[],
  credentialKind: "bearer",
};
const EMPTY_LINK = {
  schema: "momo.provider_link.v0",
  configured: false,
  source: "environment",
  mode: "local-mock",
  baseUrl: "http://mock",
  endpointLabel: "mock",
  bearerConfigured: false,
  availability: "mock",
  keyConfigured: false,
  diagnostics: [] as string[],
};

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a", refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: session() },
            createElement(AiTeamKeysPane, { offline: false, workspaceId: WS, memberId: ME })
          )
        )
      )
    );
  });
  return host;
}
const q = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const dq = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function until(id: string): Promise<HTMLElement> {
  await rtlWaitFor(() => {
    if (!q(id)) throw new Error(id);
  });
  return q(id) as HTMLElement;
}

/** 운영자에게만 있어야 하는 컨트롤. 하나라도 비운영자 화면에 있으면 안 된다. */
const OPERATOR_ONLY = [
  "ai-team-add",
  "ai-link-edit",
  "ai-link-check",
  "ai-link-unlink",
  "ai-team-chain-toggle",
  "ai-default-teamAgent-select",
  "ai-default-summary-select",
  "ai-team-keys-form",
];

beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.mocked(fetchRoster).mockReset();
  vi.mocked(fetchRoster).mockResolvedValue([human(ME, "곽성재", "member"), human(BOSS, "박운영", "owner"), AGENT_MEMBER]);
  vi.mocked(listChannels).mockReset();
  vi.mocked(listChannels).mockResolvedValue([]);
  vi.mocked(listHostedConnections).mockReset();
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
  vi.mocked(fetchWorkspace).mockReset();
  vi.mocked(fetchWorkspace).mockResolvedValue({
    id: WS, slug: "team", name: "우리 팀", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null,
    welcomePrompt: "", subscriptionAgentsEnabled: true,
  });
  vi.mocked(fetchProviderLink).mockReset();
  vi.mocked(fetchProviderLink).mockResolvedValue(KEY_LINK);
  vi.mocked(fetchProviderChain).mockReset();
  vi.mocked(fetchProviderChain).mockRejectedValue(new ApiError(404, "not found"));
  vi.mocked(fetchProviderDefaultAi).mockReset();
  vi.mocked(fetchProviderDefaultAi).mockResolvedValue({ teamAgent: null, summary: null });
  vi.mocked(putProviderDefaultAi).mockReset();
  vi.mocked(deleteProviderLink).mockReset();
  vi.mocked(putProviderLink).mockReset();
  vi.mocked(testProviderLink).mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("운영자 화면", () => {
  it("키 표: 회사, 마스킹된 키, 쓰는 곳(기능과 에이전트), 확인 전 상태", async () => {
    mount();
    const row = await until("ai-link-row");
    expect(row.textContent).toContain("Anthropic");
    expect(row.textContent).toContain("Claude 모델");
    expect(row.textContent).toContain("7c1e");
    await rtlWaitFor(() => expect(q("ai-link-row-uses")?.textContent).toContain("@김인턴"));
    expect(q("ai-link-row-uses")?.textContent).toContain("말로 앱 설정 바꾸기 · 팀 에이전트의 답 · 첫 인사");
    expect(q("ai-team-keys-checked")?.textContent).toContain("아직 확인하지 않았어요");
    for (const id of ["ai-link-edit", "ai-link-check", "ai-link-unlink", "ai-team-chain-toggle"]) {
      expect(q(id), id).not.toBeNull();
    }
    // 운영자에게는 팀 줄이 잠긴 줄이 아니다(연결 확인 전이라 고르지 못할 뿐): 자물쇠가 없다.
    await until("ai-default-teamAgent");
    expect(q("ai-default-teamAgent-locked")).toBeNull();
    // 끊기 창 제목은 표와 같은 이름(회사)으로 부른다.
    act(() => q("ai-link-unlink")?.click());
    await rtlWaitFor(() => expect(dq("ai-link-unlink-dialog")?.textContent).toContain("Anthropic 연결을 끊을까요?"));
    expect(q("ai-team-add")).toBeNull();
  });

  it("끊기: 누르면 이 키로 대답하는 에이전트 이름이 든 확인 창이 뜬다", async () => {
    mount();
    await until("ai-link-unlink");
    await rtlWaitFor(() => expect(q("ai-link-row-uses")?.textContent).toContain("@김인턴"));
    act(() => q("ai-link-unlink")?.click());
    await rtlWaitFor(() => expect(dq("ai-link-unlink-impact")?.textContent).toContain("@김인턴"));
  });

  it("비어 있는 서버: 한 줄과 「API 키 추가」, 누르면 폼이 열린다(가짜 회사 행은 없다)", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    mount();
    const empty = await until("ai-link-empty");
    expect(empty.textContent).toContain("아직 팀 AI 키가 없어요");
    expect(empty.textContent).toContain("모의 응답");
    expect(q("ai-link-row")).toBeNull();
    expect(host?.textContent).not.toContain("추가 안 됨");
    act(() => q("ai-team-add")?.click());
    await until("ai-team-keys-form");
    expect(q("ai-team-add")).toBeNull();
  });
});

describe("비운영자 화면(읽기 전용)", () => {
  beforeEach(() => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
  });

  it("편집 컨트롤이 하나도 없다: 추가·확인·바꾸기·끊기·예비 순서·팀 줄 선택", async () => {
    mount();
    await until("operator-notice");
    await until("ai-default-teamAgent");
    for (const id of OPERATOR_ONLY) expect(q(id) ?? dq(id), id).toBeNull();
    // 서버는 이 사람에게 키를 보여 주지 않는다: 있다 없다를 말하지 않는다.
    expect(host?.textContent).not.toMatch(/연결됨|추가 안 됨|아직 팀 AI 키가 없어요/);
    expect(fetchProviderDefaultAi).not.toHaveBeenCalled();
    expect(fetchProviderChain).not.toHaveBeenCalled();
  });

  it("안내와 운영자에게 요청하는 길, 팀 줄은 읽기 전용이라고 말한다", async () => {
    mount();
    await until("operator-notice");
    expect(q("ai-team-keys-readonly")?.textContent).toBe("팀 키는 운영자만 보고 바꿀 수 있어요. 필요하면 박운영 님에게 요청하세요.");
    await rtlWaitFor(() => expect(q("ai-team-keys-request")?.textContent).toBe("박운영 님에게 메시지"));
    await until("ai-defaults-team-foot");
    expect(q("ai-defaults-team-foot")?.getAttribute("data-operator")).toBe("no");
    expect(q("ai-defaults-team-foot")?.textContent).toContain("볼 수만 있어요");
  });

  it("잠긴 줄은 잠겼다고 말한다: 팀 줄에 자물쇠, 잠긴 내 줄은 「내가 바꿔요」라고 하지 않는다", async () => {
    mount();
    await until("ai-default-teamAgent");
    await rtlWaitFor(() => expect(q("ai-default-teamAgent-locked")).not.toBeNull());
    // 팀 키를 읽을 수 없는 사람에게 앱 명령은 고를 수 없는 칸이다.
    expect(q("ai-default-appCommand")?.textContent).not.toContain("내가 바꿔요");
    expect(q("ai-default-appCommand")?.textContent).toContain("지금은 팀 키만 써요");
  });

  it("개인 줄은 내 것이라 그대로 고를 수 있다(팀 줄과 구별)", async () => {
    mount();
    await until("ai-default-localTerminal");
    expect(q("ai-default-localTerminal")?.getAttribute("data-audience")).toBe("me");
    expect(q("ai-default-teamAgent")?.getAttribute("data-audience")).toBe("team");
  });
});

describe("기본 AI 표: 평문 기능 이름, 누구를 위한지, 고르지 않으면", () => {
  it("줄마다 모델 문장 그대로의 「고르지 않으면」이 선다", async () => {
    mount();
    await until("ai-default-teamAgent-unset");
    const expectOne = (row: Parameters<typeof defaultAiUnsetSentence>[0], status: Parameters<typeof defaultAiUnsetSentence>[1]) =>
      expect(q(`ai-default-${row}-unset`)?.textContent).toBe(`고르지 않으면 ${defaultAiUnsetSentence(row, status)}`);
    await rtlWaitFor(() => expectOne("teamAgent", "present"));
    expectOne("summary", "present");
    expectOne("localTerminal", "present");
    expect(q("ai-default-summary-unset")?.textContent).toContain("채널 요약은 여기서 고를 때까지 만들지 않아요");
    expect(q("ai-default-teamAgent-serves")?.textContent).toBe("팀 모두");
    expect(q("ai-default-localTerminal-serves")?.textContent).toBe("나만");
  });

  it("팀 키가 모의 응답뿐인 서버에서는 문장도 모의 응답이라고 말한다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    mount();
    await until("ai-link-empty");
    await rtlWaitFor(() => expect(q("ai-default-teamAgent-unset")?.textContent).toContain("모의 응답"));
    expect(q("ai-default-summary-unset")?.textContent).toContain("요약은 쉬고");
  });
});

describe("개인 API 키 자리", () => {
  it("준비 중이라고 말하고 누를 것이 없다", async () => {
    mount();
    const area = await until("ai-personal-keys");
    expect(area.textContent).toContain("개인 API 키");
    expect(area.textContent).toContain("준비 중");
    expect(area.querySelectorAll("button, input, select, a, [role='button']")).toHaveLength(0);
    expect(area.textContent).not.toMatch(/#\d{3,}/);
  });
});
