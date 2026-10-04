// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchRoster, listChannels, type RosterMember } from "@momo/core/lib/api";
import { listHostedConnections } from "@momo/core/features/hostedAgents/api";
import { fetchProviderChain, fetchProviderLink, fetchWorkspace } from "@momo/core/features/settings/api";
import { fetchProviderDefaultAi } from "@momo/core/features/settings/defaultAi";
import {
  createPersonalKeyAgent,
  issuePersonalKey,
  listMyPersonalKeys,
  listPersonalKeys,
  revokePersonalKey,
  type PersonalKey,
} from "@momo/core/features/ai/personalKeys";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiTeamKeysPane } from "./AiTeamKeysPane";
import { MyPersonalKeysSection } from "./MyPersonalKeysSection";

// =============================================================================
// 개인 API 키 UI (#3469): 운영자 발급·목록·회수, 본인 목록·에이전트 만들기·회수,
// 그리고 키 값이 입력 칸을 떠난 뒤 어디에도 남지 않는다는 것.
// =============================================================================

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, IS_TAURI: false };
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
  return { ...actual, fetchProviderLink: vi.fn(), fetchProviderChain: vi.fn(), fetchWorkspace: vi.fn() };
});
vi.mock("@momo/core/features/settings/defaultAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/defaultAi")>();
  return { ...actual, fetchProviderDefaultAi: vi.fn(), putProviderDefaultAi: vi.fn() };
});
vi.mock("@momo/core/features/ai/personalKeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/ai/personalKeys")>();
  return {
    ...actual,
    listPersonalKeys: vi.fn(),
    listMyPersonalKeys: vi.fn(),
    issuePersonalKey: vi.fn(),
    revokePersonalKey: vi.fn(),
    createPersonalKeyAgent: vi.fn(),
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEOYEON = "00000000-0000-7000-8000-000000000102";
const MINA = "00000000-0000-7000-8000-000000000103";
const SECRET = "sk-test-PERSONAL-9f3c1d7a2b4e6a8c0d";

function person(id: string, name: string, role: RosterMember["role"], handle = name): RosterMember {
  return {
    id, workspaceId: WS, kind: "human", status: "active", displayName: name, handle, role,
    channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  };
}

const LINK = {
  schema: "momo.provider_link.v0", configured: false, source: "environment", mode: "local-mock", baseUrl: "http://mock",
  endpointLabel: "mock", bearerConfigured: false, availability: "mock", keyConfigured: false, diagnostics: [] as string[],
  presets: [
    { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
    { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", format: "anthropic" },
  ],
};

const key = (over: Partial<PersonalKey> = {}): PersonalKey => ({
  id: "00000000-0000-7000-8000-0000000004a1",
  ownerMemberId: SEOYEON,
  format: "anthropic",
  endpointLabel: "api.anthropic.com",
  label: null,
  status: "active",
  issuedAtMs: 1_790_000_000_000,
  revokedAtMs: null,
  ...over,
});

function sessionFor(id: string): SessionContextValue {
  return {
    session: {
      accessToken: "a", refreshToken: "r",
      member: { id, workspaceId: WS, kind: "human", displayName: id === ME ? "곽성재" : "서연", handle: id === ME ? "seongjae" : "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
  };
}

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

function mount(node: "operator" | "mine", as = ME) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const body =
    node === "operator"
      ? createElement(AiTeamKeysPane, { offline: false, workspaceId: WS, memberId: as })
      : createElement(MyPersonalKeysSection, { offline: false });
  act(() => {
    root?.render(
      createElement(
        MemoryRouter, null,
        createElement(QueryClientProvider, { client }, createElement(SessionProvider, { value: sessionFor(as) }, body))
      )
    );
  });
}
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function until(id: string): Promise<HTMLElement> {
  await waitFor(() => {
    if (!byId(id)) throw new Error(id);
  });
  return byId(id) as HTMLElement;
}
const click = (id: string) => act(() => void fireEvent.click(byId(id) as HTMLElement));

beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.mocked(fetchRoster).mockReset().mockResolvedValue([
    person(ME, "곽성재", "owner", "seongjae"), person(SEOYEON, "서연", "member", "seoyeon"), person(MINA, "미나", "member", "mina"),
  ]);
  vi.mocked(listChannels).mockReset().mockResolvedValue([]);
  vi.mocked(listHostedConnections).mockReset().mockResolvedValue({ connections: [] });
  vi.mocked(fetchWorkspace).mockReset().mockResolvedValue({
    id: WS, slug: "team", name: "우리 팀", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "",
    subscriptionAgentsEnabled: true,
  });
  vi.mocked(fetchProviderLink).mockReset().mockResolvedValue(LINK);
  vi.mocked(fetchProviderChain).mockReset().mockRejectedValue(new ApiError(404, "nf"));
  vi.mocked(fetchProviderDefaultAi).mockReset().mockResolvedValue({ teamAgent: null, summary: null });
  vi.mocked(listPersonalKeys).mockReset().mockResolvedValue([]);
  vi.mocked(listMyPersonalKeys).mockReset().mockResolvedValue([]);
  vi.mocked(issuePersonalKey).mockReset();
  vi.mocked(revokePersonalKey).mockReset();
  vi.mocked(createPersonalKeyAgent).mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("운영자: 발급", () => {
  async function openIssue() {
    mount("operator");
    await until("ai-personal-keys-empty");
    click("ai-personal-issue");
    await until("ai-personal-issue-form");
  }
  const fill = () => {
    const holder = byId("ai-personal-issue-holder") as HTMLSelectElement;
    act(() => void fireEvent.change(holder, { target: { value: SEOYEON } }));
    click("ai-personal-issue-preset-anthropic");
    (byId("ai-personal-issue-key") as HTMLInputElement).value = SECRET;
  };

  it("받는 사람 목록에서 활성 사람 멤버이고 회사 칩은 서버 프리셋이다", async () => {
    await openIssue();
    const options = [...(byId("ai-personal-issue-holder") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["사람 고르기", "곽성재", "서연", "미나"]);
    expect(byId("ai-personal-issue-preset-openai")).not.toBeNull();
    expect(byId("ai-personal-issue-preset-anthropic")).not.toBeNull();
  });

  it("키 칸은 password이고 저장 제안·자동완성을 막는다", async () => {
    await openIssue();
    const input = byId("ai-personal-issue-key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    expect(input.getAttribute("data-1p-ignore")).not.toBeNull();
  });

  it("발급을 누르는 순간 칸이 비고, 키는 요청에 한 번 실리고, DOM·캐시·변수 어디에도 남지 않는다", async () => {
    let settle: (value: PersonalKey) => void = () => undefined;
    vi.mocked(issuePersonalKey).mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    await openIssue();
    fill();
    const input = byId("ai-personal-issue-key") as HTMLInputElement;
    expect(input.value).toBe(SECRET);
    click("ai-personal-issue-submit");
    await waitFor(() => expect(issuePersonalKey).toHaveBeenCalledTimes(1));

    // 요청 진행 중: 칸은 이미 비었고 화면에도 값이 없다.
    expect(input.value).toBe("");
    expect(document.body.innerHTML).not.toContain(SECRET);
    const [, sent] = vi.mocked(issuePersonalKey).mock.calls[0];
    expect(sent.apiKey).toBe(SECRET);
    expect(sent).toMatchObject({ ownerMemberId: SEOYEON, format: "anthropic", baseUrl: "https://api.anthropic.com" });

    // 뮤테이션 캐시의 변수·상태에도 없다.
    const mutations = client.getMutationCache().getAll();
    expect(mutations.length).toBeGreaterThan(0);
    for (const mutation of mutations) {
      expect(JSON.stringify(mutation.state.variables ?? null)).not.toContain(SECRET);
      expect(JSON.stringify(mutation.state)).not.toContain(SECRET);
    }

    await act(async () => settle(key({ id: "00000000-0000-7000-8000-0000000004a2" })));
    await waitFor(() => expect(byId("ai-personal-issue-dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const query of client.getQueryCache().getAll()) {
      expect(JSON.stringify(query.state.data ?? null)).not.toContain(SECRET);
    }
    for (const mutation of client.getMutationCache().getAll()) {
      expect(JSON.stringify(mutation.state)).not.toContain(SECRET);
    }
  });

  it("실패하면 칸은 비어 있고 키를 되보여 주지 않으며 사람 말로 안내한다", async () => {
    vi.mocked(issuePersonalKey).mockRejectedValue(new ApiError(409, "dup", "personal_key_owner_has_active_key"));
    await openIssue();
    fill();
    click("ai-personal-issue-submit");
    const error = await until("ai-personal-issue-error");
    expect(error.textContent).toContain("먼저 그 키를 회수");
    expect(error.textContent).toContain("다시 붙여 넣어");
    expect((byId("ai-personal-issue-key") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(JSON.stringify(client.getMutationCache().getAll().map((m) => m.state))).not.toContain(SECRET);
  });

  it("받는 사람·키를 안 넣으면 요청하지 않는다", async () => {
    await openIssue();
    click("ai-personal-issue-submit");
    expect(issuePersonalKey).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("받는 사람");
    act(() => void fireEvent.change(byId("ai-personal-issue-holder") as HTMLSelectElement, { target: { value: SEOYEON } }));
    click("ai-personal-issue-submit");
    expect(issuePersonalKey).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("키를 붙여 넣으세요");
  });

  it("사용 중인 키가 있는 사람은 받는 사람 목록에서 빠진다", async () => {
    vi.mocked(listPersonalKeys).mockResolvedValue([key()]);
    mount("operator");
    await until("ai-personal-keys-list");
    click("ai-personal-issue");
    await until("ai-personal-issue-form");
    const options = [...(byId("ai-personal-issue-holder") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["사람 고르기", "곽성재", "미나"]);
  });

  it("창을 닫으면 칸 값과 함께 사라진다", async () => {
    await openIssue();
    fill();
    click("ai-personal-issue-cancel");
    await waitFor(() => expect(byId("ai-personal-issue-dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
  });
});

describe("운영자: 목록과 회수", () => {
  it("받는 사람 · 회사 · 발급일 · 상태를 보이고 회수된 줄에는 회수 단추가 없다", async () => {
    vi.mocked(listPersonalKeys).mockResolvedValue([
      key(),
      key({ id: "00000000-0000-7000-8000-0000000004a9", ownerMemberId: MINA, format: "openai", status: "revoked", revokedAtMs: 1_790_100_000_000 }),
    ]);
    mount("operator");
    const list = await until("ai-personal-keys-list");
    const rows = list.querySelectorAll("[data-testid='ai-personal-key-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("서연");
    expect(rows[0].textContent).toContain("Anthropic");
    expect(rows[0].textContent).toContain("사용 중");
    expect(rows[1].textContent).toContain("미나");
    expect(rows[1].textContent).toContain("회수됨");
    expect(rows[1].querySelector("[data-testid='ai-personal-key-revoke']")).toBeNull();
    expect(list.textContent).not.toMatch(/sk-|apiKey|bearer/i);
  });

  it("회수는 확인 창을 거치고, 에이전트가 멈추고 팀 키로 넘어가지 않는다고 말한다", async () => {
    vi.mocked(listPersonalKeys).mockResolvedValue([key()]);
    vi.mocked(revokePersonalKey).mockResolvedValue(key({ status: "revoked", revokedAtMs: 1 }));
    mount("operator");
    await until("ai-personal-keys-list");
    click("ai-personal-key-revoke");
    const dialog = await until("ai-personal-revoke-dialog");
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain("서연 님의 Anthropic 키를 회수할까요?");
    expect(dialog.textContent).toContain("팀 키로 대신 대답하지 않아요");
    expect(revokePersonalKey).not.toHaveBeenCalled();
    click("ai-personal-revoke-confirm");
    await waitFor(() => expect(revokePersonalKey).toHaveBeenCalledWith(WS, "00000000-0000-7000-8000-0000000004a1"));
    await waitFor(() => expect(byId("ai-personal-revoke-dialog")).toBeNull());
  });

  it("목록을 못 읽으면 다시 시도를 준다", async () => {
    vi.mocked(listPersonalKeys).mockRejectedValueOnce(new ApiError(500, "boom"));
    mount("operator");
    const banner = await until("ai-personal-keys-error");
    expect(banner.textContent).toContain("불러오지 못했어요");
    expect(byId("ai-personal-issue")).not.toBeNull();
  });
});

describe("권한 어긋남(403)과 응답 없음", () => {
  it("운영자 구획의 목록이 403이면 일반 오류가 아니라 소유자·관리자 안내를 보이고 발급 단추를 숨긴다", async () => {
    vi.mocked(listPersonalKeys).mockRejectedValue(new ApiError(403, "forbidden"));
    mount("operator");
    const note = await until("ai-personal-keys-forbidden");
    expect(note.textContent).toContain("소유자·관리자만");
    expect(byId("ai-personal-keys-error")).toBeNull();
    expect(byId("ai-personal-issue")).toBeNull();
  });

  it("멤버 /mine 이 403이면 정확한 안내를 보인다", async () => {
    vi.mocked(listMyPersonalKeys).mockRejectedValue(new ApiError(403, "forbidden"));
    mount("mine", SEOYEON);
    const note = await until("ai-my-personal-keys-forbidden");
    expect(note.textContent).toContain("활성 멤버");
    expect(byId("ai-my-personal-keys-error")).toBeNull();
  });

  it("발급 중 응답을 못 받으면(네트워크) 목록을 다시 읽는다. 서버가 거절한 경우에는 읽지 않는다", async () => {
    vi.mocked(issuePersonalKey).mockRejectedValue(new TypeError("network"));
    mount("operator");
    await until("ai-personal-keys-empty");
    click("ai-personal-issue");
    await until("ai-personal-issue-form");
    act(() => void fireEvent.change(byId("ai-personal-issue-holder") as HTMLSelectElement, { target: { value: SEOYEON } }));
    (byId("ai-personal-issue-key") as HTMLInputElement).value = SECRET;
    const before = vi.mocked(listPersonalKeys).mock.calls.length;
    click("ai-personal-issue-submit");
    await until("ai-personal-issue-error");
    await waitFor(() => expect(vi.mocked(listPersonalKeys).mock.calls.length).toBeGreaterThan(before));
  });
});

describe("멤버: 받은 개인 키", () => {
  it("내 키만 /mine으로 읽고 운영자 목록은 부르지 않는다", async () => {
    vi.mocked(listMyPersonalKeys).mockResolvedValue([key()]);
    mount("mine", SEOYEON);
    const list = await until("ai-my-personal-keys-list");
    expect(list.textContent).toContain("Anthropic");
    expect(listPersonalKeys).not.toHaveBeenCalled();
    expect(byId("ai-personal-issue")).toBeNull();
  });

  it("빈 상태는 운영자에게 요청하라고 말한다", async () => {
    mount("mine", SEOYEON);
    const empty = await until("ai-my-personal-keys-empty");
    expect(empty.textContent).toContain("운영자에게 요청");
  });

  it("이 키로 에이전트 만들기: 이름 기본값 <이름>-<회사>, 합법 핸들, 모델은 사람이 넣는다", async () => {
    vi.mocked(listMyPersonalKeys).mockResolvedValue([key()]);
    vi.mocked(createPersonalKeyAgent).mockResolvedValue({ id: "a1", handle: "seoyeon-claude", displayName: "서연-Anthropic" });
    mount("mine", SEOYEON);
    await until("ai-my-personal-keys-list");
    click("ai-my-personal-key-create-agent");
    await until("ai-my-personal-agent-form");
    expect((byId("ai-my-personal-agent-name") as HTMLInputElement).value).toBe("서연-Anthropic");
    expect((byId("ai-my-personal-agent-handle") as HTMLInputElement).value).toBe("seoyeon-claude");
    click("ai-my-personal-agent-submit");
    expect(createPersonalKeyAgent).not.toHaveBeenCalled();
    const model = byId("ai-my-personal-agent-model") as HTMLInputElement;
    act(() => void fireEvent.change(model, { target: { value: "claude-sonnet-5" } }));
    click("ai-my-personal-agent-submit");
    await waitFor(() =>
      expect(createPersonalKeyAgent).toHaveBeenCalledWith(WS, "00000000-0000-7000-8000-0000000004a1", {
        displayName: "서연-Anthropic", handle: "seoyeon-claude", model: "claude-sonnet-5",
      })
    );
    const done = await until("ai-my-personal-keys-created");
    expect(done.textContent).toContain("@seoyeon-claude");
  });

  it("이미 내 개인 키 에이전트가 있으면 만들기 대신 그 이름을 보인다", async () => {
    vi.mocked(listMyPersonalKeys).mockResolvedValue([key()]);
    vi.mocked(fetchRoster).mockResolvedValue([
      person(SEOYEON, "서연", "member", "seoyeon"),
      { ...person("00000000-0000-7000-8000-000000000301", "서연-Anthropic", "member", "seoyeon-claude"), kind: "agent", role: undefined, ownerHumanId: SEOYEON, brain: "personal_key" },
    ]);
    mount("mine", SEOYEON);
    await until("ai-my-personal-keys-list");
    const line = await until("ai-my-personal-key-agent");
    expect(line.textContent).toContain("@seoyeon-claude");
    expect(byId("ai-my-personal-key-create-agent")).toBeNull();
  });

  it("에이전트 만들기 거절(이미 있음)은 사람 말로 보인다", async () => {
    vi.mocked(listMyPersonalKeys).mockResolvedValue([key()]);
    vi.mocked(createPersonalKeyAgent).mockRejectedValue(new ApiError(409, "x", "personal_agent_exists"));
    mount("mine", SEOYEON);
    await until("ai-my-personal-keys-list");
    click("ai-my-personal-key-create-agent");
    await until("ai-my-personal-agent-form");
    act(() => void fireEvent.change(byId("ai-my-personal-agent-model") as HTMLInputElement, { target: { value: "m" } }));
    click("ai-my-personal-agent-submit");
    const error = await until("ai-my-personal-agent-error");
    expect(error.textContent).toContain("이미 개인 키 에이전트가 있어요");
  });

  it("내 키는 내가 회수한다", async () => {
    vi.mocked(listMyPersonalKeys).mockResolvedValue([key()]);
    vi.mocked(revokePersonalKey).mockResolvedValue(key({ status: "revoked", revokedAtMs: 1 }));
    mount("mine", SEOYEON);
    await until("ai-my-personal-keys-list");
    click("ai-my-personal-key-revoke");
    await until("ai-personal-revoke-dialog");
    click("ai-personal-revoke-confirm");
    await waitFor(() => expect(revokePersonalKey).toHaveBeenCalledTimes(1));
  });
});
