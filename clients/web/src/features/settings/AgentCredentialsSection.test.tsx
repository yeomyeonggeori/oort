// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import { TERMINAL_DONE_HEADLINE } from "@momo/core/features/hostedAgents/disconnect";
import {
  createHostedConnection,
  disconnectHostedConnection,
  getHostedConnection,
  listHostedConnections,
  regenerateHostedPairing,
} from "@momo/core/features/hostedAgents/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { SETTINGS_SECTIONS } from "./settingsNav";
import { AgentCredentialsSection } from "./AgentCredentialsSection";

// =============================================================================
// #2204 설정 › 연결 › 에이전트 자격.
//
// 사보타주 두 줄은 제품이 그 규율을 깨면 이 파일이 붉어진다:
//   ① 1회용 연결 값이 DOM/로그에 두 번
//   ② 해제 시작 응답만으로 완료 문장
// =============================================================================

vi.mock("@momo/core/features/hostedAgents/api", () => ({
  listHostedConnections: vi.fn(),
  getHostedConnection: vi.fn(),
  createHostedConnection: vi.fn(),
  regenerateHostedPairing: vi.fn(),
  confirmHostedConnection: vi.fn(),
  disconnectHostedConnection: vi.fn(),
  acknowledgeHostedCleanupArtifact: vi.fn(),
  completeHostedDisconnect: vi.fn(),
  registerHostedDoorbell: vi.fn(),
  unregisterHostedDoorbell: vi.fn(),
}));

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchWorkspace: vi.fn(async () => ({
      id: WS,
      slug: "test",
      name: "테스트",
      updatedAtMs: 0,
      roleLabels: {},
      welcomeAgentMemberId: null,
      welcomePrompt: "",
    })),
  };
});

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

const roster: RosterMember[] = [];

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useDirectory: () => ({
      directory: actual.makeDirectory(roster),
      isPending: false,
      isError: false,
      data: roster,
      refetch: () => undefined,
    }),
    useChannels: () => ({
      isPending: false,
      isSuccess: true,
      isError: false,
      data: [],
      groups: { channels: [], dms: [] },
      refetch: () => undefined,
    }),
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "019f9a01-0000-7000-8000-000000000404";
const CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c1";
const SECRET =
  "momo_pair_v1.00000000-0000-7000-8000-000000000001.3xJ7pQ2mVdKcR9tYbN4sLwF6hZa1XeUgO8iPjM0nCvA";
const SECRET_2 =
  "momo_pair_v1.00000000-0000-7000-8000-000000000002.AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUu";

function countNeedle(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function sectionSource(): string {
  return readFileSync("src/features/settings/AgentCredentialsSection.tsx", "utf8");
}

function switcherSource(): string {
  return readFileSync("src/app/QuickSwitcher.tsx", "utf8");
}

function human(): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "owner",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function agent(): RosterMember {
  return {
    id: AGENT_ID,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "김인턴",
    handle: "intern",
    role: "member",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function wireConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    agentMemberId: AGENT_ID,
    status: "pairing_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: MEMBER_ID,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    }
  );
});

beforeEach(() => {
  roster.splice(0, roster.length, human(), agent());
  vi.mocked(listHostedConnections).mockReset();
  vi.mocked(getHostedConnection).mockReset();
  vi.mocked(createHostedConnection).mockReset();
  vi.mocked(regenerateHostedPairing).mockReset();
  vi.mocked(disconnectHostedConnection).mockReset();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

function mountSection(offline = false): HTMLElement {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        MemoryRouter,
        null,
        createElement(AgentCredentialsSection, { offline })
      )
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 4000) {
      throw new Error(label);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("진입점", () => {
  it("설정 내비에 「에이전트 자격」이 하나다", () => {
    const agents = SETTINGS_SECTIONS.filter((item) => item.id === "agents");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.label).toBe("에이전트 자격");
    expect(agents[0]?.group).toBe("연결");
  });

  it("⌘K 가 같은 이름으로 연다", () => {
    const source = switcherSource();
    expect(source).toContain('data-testid="switcher-settings-agents"');
    expect(source).toContain("/settings?section=agents");
    expect(countNeedle(source, "에이전트 자격")).toBeGreaterThanOrEqual(1);
  });
});

describe("소스 규율", () => {
  it("위저드와 해제 섹션을 복제하지 않고 연다", () => {
    const source = sectionSource();
    expect(source).toContain("HostedAgentWizard");
    expect(source).toContain("HostedConnectionSection");
    expect(source).toContain('entry="settings"');
    expect(source).not.toMatch(/function OneTimeSecretCard/);
    expect(source).not.toMatch(/function HostedAgentWizard/);
    expect(source).not.toMatch(/function DoorbellSection/);
  });

  it("목록 쿼리 함수를 렌더 스코프에서 짓지 않는다", () => {
    const source = sectionSource();
    expect(source).not.toMatch(/queryFn\s*:/);
    expect(source).toContain("hostedListQuery(workspaceId)");
  });

  it("1회용 값을 목록에 두지 않고 로그하지 않는다", () => {
    const source = sectionSource();
    expect(source).not.toMatch(/pairingCredential/);
    expect(source).not.toMatch(/console\.(log|warn|error|info|debug)/);
    expect(source).not.toMatch(/localStorage\s*\./);
  });

  it("해제 완료를 지역 상태로 선언하지 않는다", () => {
    const source = sectionSource();
    expect(source).not.toContain("TERMINAL_DONE_HEADLINE");
    expect(source).not.toContain("이 연결은 해제됐습니다");
    expect(source).not.toMatch(/status:\s*"disconnected"/);
  });
});

describe("목록 네 상태", () => {
  it("불러오는 중이면 스켈레톤이다", async () => {
    vi.mocked(listHostedConnections).mockReturnValue(new Promise(() => {}));
    const host = mountSection();
    await flush();
    expect(
      host.querySelector('[data-testid="agent-credentials-loading"]')
    ).not.toBeNull();
  });

  it("빈 목록은 발급 초대를 연다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
    const host = mountSection();
    await waitFor(
      () => host.querySelector('[data-testid="agent-credentials-empty"]') !== null,
      "empty"
    );
    expect(host.textContent).toContain("아직 연결된 에이전트가 없습니다");
    expect(
      host.querySelector('[data-testid="agent-credentials-issue"]')?.textContent
    ).toBe("새 자격 발급");
  });

  it("오류는 자리의 배너다", async () => {
    vi.mocked(listHostedConnections).mockRejectedValue(new ApiError(500, "boom"));
    const host = mountSection();
    await waitFor(
      () => host.querySelector('[data-testid="agent-credentials-error"]') !== null,
      "error"
    );
  });

  it("연결이 있으면 이름·상태·시각·도어벨을 그린다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({
      connections: [
        wireConnection({
          status: "active",
          doorbellUrl: "https://hooks.example/a",
          doorbellSecretMasked: "••••abcd",
        }),
      ],
    });
    const host = mountSection();
    await waitFor(
      () => host.querySelector('[data-testid="agent-credentials-list"]') !== null,
      "list"
    );
    expect(host.textContent).toContain("김인턴");
    expect(host.textContent).toContain("활성");
    expect(host.textContent).toContain("연결 만든 때");
    expect(host.textContent).toContain("마지막 상태 변화");
    expect(host.textContent).toContain("도어벨 있음");
    expect(host.textContent).not.toContain("detected_at");
    expect(host.textContent).not.toContain("proved_at");
  });
});

describe("발급 왕복", () => {
  it("create 응답의 카드가 뜨고 저장하면 목록으로 돌아온다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
    vi.mocked(createHostedConnection).mockResolvedValue({
      connection: wireConnection(),
      pairingCredential: SECRET,
      pairingExpiresAtMs: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection: wireConnection(),
      cleanupArtifacts: [],
    });
    const host = mountSection();
    await waitFor(
      () => host.querySelector('[data-testid="agent-credentials-issue"]') !== null,
      "issue"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="agent-credentials-issue"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => document.querySelector('[data-testid="hosted-display-name"]') !== null,
      "identity"
    );
    const name = document.querySelector(
      '[data-testid="hosted-display-name"]'
    ) as HTMLInputElement;
    const handle = document.querySelector(
      '[data-testid="hosted-handle"]'
    ) as HTMLInputElement;
    act(() => {
      setInputValue(name, "김인턴");
      setInputValue(handle, "intern");
    });
    await flush();
    act(() => {
      (
        document.querySelector('[data-testid="hosted-create"]') as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => document.querySelector('[data-testid="hosted-pairing-card"]') !== null,
      "card"
    );
    act(() => {
      (
        document.querySelector(
          '[data-testid="hosted-secret-done"]'
        ) as HTMLButtonElement
      ).click();
    });
    await flush();
    expect(vi.mocked(createHostedConnection)).toHaveBeenCalled();
  });
});

describe("재발급", () => {
  it("재발급 응답이 카드를 교체한다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({
      connections: [wireConnection()],
    });
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection: wireConnection(),
      cleanupArtifacts: [],
    });
    vi.mocked(regenerateHostedPairing).mockResolvedValue({
      connection: wireConnection(),
      pairingCredential: SECRET_2,
      pairingExpiresAtMs: Date.now() + 15 * 60 * 1000,
    });
    const host = mountSection();
    await waitFor(
      () =>
        host.querySelector('[data-testid="agent-credentials-regenerate"]') !==
        null,
      "regen"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="agent-credentials-regenerate"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => document.querySelector('[data-testid="hosted-pairing-card"]') !== null,
      "regen card"
    );
    expect(countNeedle(document.body.textContent ?? "", SECRET_2)).toBe(1);
    expect(document.body.textContent ?? "").not.toContain(SECRET);
  });
});

describe("사보타주 ① 1회용 값은 한 번만", () => {
  it("카드가 선 뒤 textContent·innerHTML·로그에 값이 한 번이다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
    vi.mocked(createHostedConnection).mockResolvedValue({
      connection: wireConnection(),
      pairingCredential: SECRET,
      pairingExpiresAtMs: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection: wireConnection(),
      cleanupArtifacts: [],
    });
    const host = mountSection();
    await waitFor(
      () => host.querySelector('[data-testid="agent-credentials-issue"]') !== null,
      "issue"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="agent-credentials-issue"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => document.querySelector('[data-testid="hosted-display-name"]') !== null,
      "identity"
    );
    const name = document.querySelector(
      '[data-testid="hosted-display-name"]'
    ) as HTMLInputElement;
    const handle = document.querySelector(
      '[data-testid="hosted-handle"]'
    ) as HTMLInputElement;
    act(() => {
      setInputValue(name, "김인턴");
      setInputValue(handle, "intern");
    });
    await flush();
    act(() => {
      (
        document.querySelector('[data-testid="hosted-create"]') as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => document.querySelector('[data-testid="hosted-pairing-card"]') !== null,
      "card"
    );
    const text = document.body.textContent ?? "";
    const html = document.body.innerHTML;
    expect(countNeedle(text, SECRET)).toBe(1);
    expect(countNeedle(html, SECRET)).toBe(1);
    const list = host.querySelector('[data-testid="agent-credentials-list"]');
    expect(list?.textContent ?? "").not.toContain(SECRET);
    const joined = [log, warn, error, info, debug]
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(joined).not.toContain(SECRET);
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    info.mockRestore();
    debug.mockRestore();
  });

  it("두 번 나타나면 이 단정이 거짓이다", () => {
    const sabotaged = `${SECRET} · ${SECRET}`;
    expect(countNeedle(sabotaged, SECRET) === 1).toBe(false);
  });
});

describe("사보타주 ② 해제는 서버가 정한다", () => {
  it("disconnect 가 cleanup_pending 이면 완료 문장이 없다", async () => {
    const active = wireConnection({ status: "active" });
    vi.mocked(listHostedConnections).mockResolvedValue({
      connections: [active],
    });
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection: active,
      cleanupArtifacts: [],
    });
    vi.mocked(disconnectHostedConnection).mockResolvedValue({
      connection: wireConnection({ status: "cleanup_pending" }),
      remainingRequired: 1,
      startedNow: true,
      cleanupArtifacts: [],
    });
    const host = mountSection();
    await waitFor(
      () =>
        host.querySelector('[data-testid="agent-credentials-row-select"]') !==
        null,
      "row"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="agent-credentials-row-select"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => host.querySelector('[data-testid="hosted-connection-section"]') !== null,
      "connection section"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="hosted-disconnect-start"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () =>
        host.querySelector(
          '[data-testid="hosted-disconnect-start-confirm"]'
        ) !== null,
      "confirm"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="hosted-disconnect-start-confirm"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => vi.mocked(disconnectHostedConnection).mock.calls.length > 0,
      "disconnect called"
    );
    await flush();
    expect(host.textContent ?? "").not.toContain(TERMINAL_DONE_HEADLINE);
  });
});
