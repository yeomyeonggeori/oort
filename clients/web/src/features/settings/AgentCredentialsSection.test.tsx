// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, uuidEq, type RosterMember } from "@momo/core/lib/api";
import { TERMINAL_DONE_HEADLINE, TERMINAL_HEADLINE } from "@momo/core/features/hostedAgents/disconnect";
import {
  createHostedConnection,
  disconnectHostedConnection,
  getHostedConnection,
  listHostedConnections,
  regenerateHostedPairing,
} from "@momo/core/features/hostedAgents/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { SETTINGS_SECTIONS } from "./settingsNav";
import {
  AgentCredentialsSection,
  hostedRowByConnectionId,
  ledgerLandingFor,
  offersDisconnect,
  offersDoorbell,
  offersRecord,
} from "./AgentCredentialsSection";
import { formatMoment } from "./oauthGrant";

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

function hostedSectionSource(): string {
  return readFileSync(
    "src/features/hostedAgents/HostedConnectionSection.tsx",
    "utf8"
  );
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

  it("행 액션은 이름 붙은 버튼이고 선택은 연결 id 다", () => {
    const source = sectionSource();
    expect(source).not.toContain("KeyValueRows");
    expect(source).toContain('data-testid="agent-credentials-disconnect"');
    expect(source).toContain('data-testid="agent-credentials-doorbell"');
    expect(source).toContain("bg-accent-soft");
    expect(source).toContain("bg-surface");
    expect(source).toContain("credentials-row-grid");
    expect(source).toContain("(min-width: 1024px)");
    expect(source).not.toContain("(min-width: 768px)");
    expect(source).not.toContain("(min-width: 720px)");
    expect(source).not.toContain("grid-cols-[");
    expect(source).not.toContain("minmax(9rem");
    expect(source).not.toContain("11.5rem");
    expect(source).toContain("credentials-row-current");
    expect(source).toContain("ps-3");
    expect(source).toContain("contents");
    expect(source).toContain("col-span-full");
    expect(source).toMatch(
      /selectedRow &&\s+"credentials-row-current bg-accent-soft"/
    );
    expect(source).not.toMatch(
      /agent-credentials-row-body[\s\S]{0,220}bg-accent-soft/
    );
    expect(source).not.toContain("border-l-2");
    expect(source).toMatch(/<dt className="sr-only">마지막 활동<\/dt>/);
    expect(source).not.toMatch(
      /agent-credentials-row-actions[\s\S]{0,220}bg-accent-soft/
    );
    expect(source).toContain("border-line/50");
    expect(source).not.toContain("hidden sm:block");
    expect(source).toContain("mx-3");
    expect(source).toContain("기록 보기");
    expect(source).toContain("relativeLabel");
    expect(source).not.toContain("agent-credentials-row-select");
    expect(source).toContain("hostedPresetIdForMember");
    expect(source).not.toMatch(/presetId:\s*"generic"/);
    expect(source).toContain("lockReason");
    expect(source).toContain("aria-describedby={lockReason(writesLocked)}");
    expect(source).toContain("setSelectedConnectionId(row.id)");
    expect(source).not.toContain("setSelectedAgentId(row.agentMemberId)");
    expect(source).toContain('openLedger(row, "disconnect")');
    expect(source).toContain('openLedger(row, "doorbell")');
    expect(source).toContain('aria-current={selectedRow ? "true" : undefined}');
    expect(source).toContain('from "@/features/hostedAgents/TruncatingName"');
    expect(source).toContain("TruncatingName");
    expect(source).toContain("visualOnly");
    expect(source).not.toMatch(/aria-label=\{fullName\}/);
    expect(source).toContain('<span className="sr-only">{name}</span>');
    expect(source).toContain('data-testid="agent-credentials-row-name"');
    expect(source).toContain('className="min-w-0 flex-1"');
    expect(source).not.toContain("hover:bg-surface-hover");
    expect(source).toContain("도어벨 설정");
    expect(source).toContain("마지막 활동");
    expect(source).toContain("offersDoorbell");
    expect(source).toContain("offersRecord");
    expect(source).toContain('openLedger(row, "record")');
    expect(source).toContain('data-testid="agent-credentials-record"');
  });

  it("이름 상자는 min-w-0 으로 접힌다", () => {
    const source = sectionSource();
    expect(source).toMatch(
      /data-testid="agent-credentials-row-name"[\s\S]{0,40}min-w-0 flex-1|min-w-0 flex-1"[\s\S]{0,80}agent-credentials-row-name/
    );
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

  it("오프라인 잠금은 컨트롤 옆 사유를 가리킨다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
    const host = mountSection(true);
    await waitFor(
      () => host.querySelector('[data-testid="agent-credentials-issue"]') !== null,
      "issue"
    );
    const issue = host.querySelector(
      '[data-testid="agent-credentials-issue"]'
    ) as HTMLButtonElement;
    const note = host.querySelector(
      '[data-testid="agent-credentials-offline"]'
    ) as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.id).toBe("agent-credentials-offline-note");
    expect(issue.getAttribute("aria-describedby")).toBe(note.id);
    expect(issue.getAttribute("aria-disabled")).toBe("true");
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
    expect(host.textContent).toContain("마지막 활동");
    expect(host.textContent).not.toContain("마지막 상태 변화");
    expect(host.textContent).not.toContain(
      "자격증명 증명이 성공했고 승인한 채널에서 이 에이전트가 일할 수 있습니다."
    );
    expect(
      host.querySelector('[data-testid="agent-credentials-doorbell"]')
        ?.textContent
    ).toBe("도어벨 설정");
    const time = host.querySelector(
      '[data-testid="agent-credentials-row-time"]'
    ) as HTMLTimeElement;
    expect(time).not.toBeNull();
    expect(time.getAttribute("title")).toBe(
      `마지막 활동 ${formatMoment(1_700_000_000_000)}`
    );
    expect(time.dateTime).toBe(new Date(1_700_000_000_000).toISOString());
    expect(time.textContent).toMatch(/\d+일 전|방금|\d+분 전|\d+시간 전/);
    expect(host.textContent).not.toContain("detected_at");
    expect(host.textContent).not.toContain("proved_at");
  });

  it("목록 행은 상태 산문을 장부에 두고 시각만 한 줄로 든다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({
      connections: [
        wireConnection({
          status: "active",
          updatedAtMs: 1_700_000_360_000,
        }),
      ],
    });
    const host = mountSection();
    await waitFor(
      () => host.querySelector('[data-testid="agent-credentials-list"]') !== null,
      "list"
    );
    const list = host.querySelector(
      '[data-testid="agent-credentials-list"]'
    ) as HTMLElement;
    expect(list.querySelector('[data-testid="agent-credentials-row-time"]')
      ?.getAttribute("title")).toContain(formatMoment(1_700_000_360_000));
    expect(list.textContent).toMatch(/\d+일 전|방금|\d+분 전|\d+시간 전/);
    expect(list.textContent).not.toContain("마지막 상태 변화");
    expect(list.textContent).not.toContain("연결 만든 때");
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

  it("재발급은 그록 정체성 행의 preset 을 grok 으로 연다", async () => {
    roster.splice(0, roster.length, human(), {
      ...agent(),
      displayName: "그록봇",
      handle: "grokbot",
    });
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
      () =>
        document.querySelector('[data-testid="hosted-preset-unverified"]') !==
        null,
      "grok unverified"
    );
    expect(
      document.querySelector('[data-testid="hosted-preset-unverified"]')
        ?.textContent
    ).toContain("아직 확인되지 않았습니다");
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
});

describe("사보타주 ② 해제는 서버가 정한다", () => {
  it("disconnect 가 cleanup_pending 이면 완료 문장이 없고 정리 중이다", async () => {
    let current = wireConnection({ status: "active" });
    vi.mocked(listHostedConnections).mockImplementation(async () => ({
      connections: [current],
    }));
    vi.mocked(getHostedConnection).mockImplementation(async () => ({
      connection: current,
      cleanupArtifacts: [],
    }));
    vi.mocked(disconnectHostedConnection).mockImplementation(async () => {
      current = wireConnection({ status: "cleanup_pending" });
      return {
        connection: current,
        remainingRequired: 1,
        startedNow: true,
        cleanupArtifacts: [],
      };
    });
    const host = mountSection();
    await waitFor(
      () =>
        host.querySelector('[data-testid="agent-credentials-disconnect"]') !==
        null,
      "row"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="agent-credentials-disconnect"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => host.querySelector('[data-testid="hosted-connection-section"]') !== null,
      "connection section"
    );
    expect(
      host.querySelector('[data-testid="hosted-connection-section"] h3')
        ?.textContent
    ).toBe("김인턴 · 활성");
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
    await waitFor(
      () => (host.textContent ?? "").includes("정리 중"),
      "cleanup pending chip"
    );
    expect(host.textContent ?? "").toContain(TERMINAL_HEADLINE);
    expect(host.textContent ?? "").not.toContain(TERMINAL_DONE_HEADLINE);
  });
});

const LIVE_ID = "019f9a01-0000-7000-8000-0000000005b2";
const EXPIRED_ID = "019f9a01-0000-7000-8000-0000000005a1";

function mockListAndDetail(
  connections: ReturnType<typeof wireConnection>[]
) {
  vi.mocked(listHostedConnections).mockResolvedValue({ connections });
  vi.mocked(getHostedConnection).mockImplementation(async (_ws, id) => {
    const connection =
      connections.find((row) => row.id === id) ?? connections[0];
    return { connection, cleanupArtifacts: [] };
  });
}

describe("B-1 선택은 연결 id 다", () => {
  it("사보타주: 멤버 id 로 고르면 만료 행이 활성을 연다", () => {
    const active = wireConnection({
      id: LIVE_ID,
      status: "active",
      createdAtMs: 2_000,
    });
    const expired = wireConnection({
      id: EXPIRED_ID,
      status: "expired",
      createdAtMs: 1_000,
    });
    const rows = [active, expired];
    expect(hostedRowByConnectionId(rows, expired.id)?.id).toBe(EXPIRED_ID);
    const sabotaged = rows.find((row) =>
      uuidEq(row.agentMemberId, expired.agentMemberId)
    );
    expect(sabotaged?.id).toBe(LIVE_ID);
    expect(sabotaged?.id).not.toBe(EXPIRED_ID);
    expect(offersDisconnect("expired")).toBe(false);
    expect(offersDisconnect("disconnected")).toBe(false);
    expect(offersDisconnect("active")).toBe(true);
    expect(offersDoorbell("cleanup_pending")).toBe(false);
    expect(offersDoorbell("disconnected")).toBe(false);
    expect(offersDoorbell("active")).toBe(true);
    expect(offersDoorbell("expired")).toBe(true);
    expect(offersRecord("disconnected")).toBe(true);
    expect(offersRecord("cleanup_pending")).toBe(false);
    expect(offersRecord("active")).toBe(false);
  });

  it("같은 에이전트의 만료·활성 행에서 만료 액션은 만료 id 를 연다", async () => {
    const active = wireConnection({
      id: LIVE_ID,
      status: "active",
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    });
    const expired = wireConnection({
      id: EXPIRED_ID,
      status: "expired",
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    mockListAndDetail([active, expired]);
    const host = mountSection();
    await waitFor(
      () =>
        host.querySelectorAll('[data-testid="agent-credentials-row"]').length ===
        2,
      "two rows"
    );
    const rows = [
      ...host.querySelectorAll('[data-testid="agent-credentials-row"]'),
    ] as HTMLElement[];
    const expiredRow = rows.find(
      (row) => row.getAttribute("data-connection-id") === EXPIRED_ID
    );
    const activeRow = rows.find(
      (row) => row.getAttribute("data-connection-id") === LIVE_ID
    );
    expect(expiredRow).toBeDefined();
    expect(activeRow).toBeDefined();
    expect(
      expiredRow?.querySelector('[data-testid="agent-credentials-disconnect"]')
    ).toBeNull();
    expect(expiredRow?.textContent).toContain("만료됨");
    act(() => {
      (
        expiredRow?.querySelector(
          '[data-testid="agent-credentials-doorbell"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () =>
        host
          .querySelector('[data-testid="hosted-connection-section"]')
          ?.getAttribute("data-connection-id") === EXPIRED_ID,
      "expired ledger"
    );
    const section = host.querySelector(
      '[data-testid="hosted-connection-section"]'
    ) as HTMLElement;
    expect(section.getAttribute("data-connection-id")).toBe(EXPIRED_ID);
    expect(section.querySelector("h3")?.textContent).toBe("김인턴 · 만료됨");
    const selected = rows.filter(
      (row) => row.getAttribute("aria-current") === "true"
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-connection-id")).toBe(EXPIRED_ID);
    act(() => {
      (
        activeRow?.querySelector(
          '[data-testid="agent-credentials-disconnect"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () =>
        host
          .querySelector('[data-testid="hosted-connection-section"]')
          ?.getAttribute("data-connection-id") === LIVE_ID,
      "active ledger"
    );
    expect(
      host
        .querySelector('[data-testid="hosted-connection-section"]')
        ?.getAttribute("data-connection-id")
    ).toBe(LIVE_ID);
    expect(
      host.querySelector('[data-testid="hosted-connection-section"] h3')
        ?.textContent
    ).toBe("김인턴 · 활성");
    const selectedAfter = [
      ...host.querySelectorAll('[data-testid="agent-credentials-row"]'),
    ].filter((row) => row.getAttribute("aria-current") === "true");
    expect(selectedAfter).toHaveLength(1);
    expect(selectedAfter[0]?.getAttribute("data-connection-id")).toBe(LIVE_ID);
  });
});

describe("H-2 해제와 도어벨은 다른 착지다", () => {
  it("사보타주: 두 착지가 같으면 붉다", () => {
    expect(ledgerLandingFor("disconnect")).toBe("heading");
    expect(ledgerLandingFor("doorbell")).toBe("doorbell");
    expect(ledgerLandingFor("record")).toBe("heading");
    expect(ledgerLandingFor("disconnect")).not.toBe(
      ledgerLandingFor("doorbell")
    );
  });

  it("같은 행을 다시 눌러도 착지가 갈리고 초점이 움직인다", async () => {
    mockListAndDetail([
      wireConnection({
        status: "active",
        doorbellUrl: "https://hooks.example/a",
        doorbellSecretMasked: "••••abcd",
      }),
    ]);
    const host = mountSection();
    await waitFor(
      () =>
        host.querySelector('[data-testid="agent-credentials-disconnect"]') !==
        null,
      "row"
    );
    const disconnect = host.querySelector(
      '[data-testid="agent-credentials-disconnect"]'
    ) as HTMLButtonElement;
    const doorbell = host.querySelector(
      '[data-testid="agent-credentials-doorbell"]'
    ) as HTMLButtonElement;
    act(() => {
      disconnect.click();
    });
    await waitFor(
      () =>
        host
          .querySelector('[data-testid="hosted-connection-section"]')
          ?.getAttribute("data-landing-target") === "heading",
      "heading land"
    );
    expect(document.activeElement?.getAttribute("data-landing")).toBe(
      "heading"
    );
    act(() => {
      doorbell.click();
    });
    await waitFor(
      () =>
        host
          .querySelector('[data-testid="hosted-connection-section"]')
          ?.getAttribute("data-landing-target") === "doorbell",
      "doorbell land"
    );
    expect(
      host
        .querySelector('[data-testid="hosted-connection-section"]')
        ?.getAttribute("data-landing-target")
    ).toBe("doorbell");
    act(() => {
      disconnect.click();
    });
    await waitFor(
      () =>
        host
          .querySelector('[data-testid="hosted-connection-section"]')
          ?.getAttribute("data-landing-target") === "heading",
      "re-land heading"
    );
    expect(document.activeElement?.getAttribute("data-landing")).toBe(
      "heading"
    );
  });
});

describe("H-3 장부 착지는 화면 안으로 스크롤한다", () => {
  it("해제 클릭이 heading 착지 훅을 부른다", async () => {
    const scroll = HTMLElement.prototype.scrollIntoView as ReturnType<
      typeof vi.fn
    >;
    scroll.mockClear();
    mockListAndDetail([wireConnection({ status: "active" })]);
    const host = mountSection();
    await waitFor(
      () =>
        host.querySelector('[data-testid="agent-credentials-disconnect"]') !==
        null,
      "row"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="agent-credentials-disconnect"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => host.querySelector('[data-landing="heading"]') !== null,
      "heading"
    );
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(
      host.querySelector('[data-landing="heading"]')
    );
    expect(
      host
        .querySelector('[data-testid="hosted-connection-section"]')
        ?.getAttribute("data-landing-target")
    ).toBe("heading");
  });
});

describe("M-1 잠금 사유는 잠긴 컨트롤만 가리킨다", () => {
  it("오프라인에서 해제·도어벨은 describedby 가 없고 재발급만 옆 사유를 든다", async () => {
    mockListAndDetail([wireConnection()]);
    const host = mountSection(true);
    await waitFor(
      () =>
        host.querySelector('[data-testid="agent-credentials-regenerate"]') !==
        null,
      "regen"
    );
    const disconnect = host.querySelector(
      '[data-testid="agent-credentials-disconnect"]'
    ) as HTMLButtonElement;
    const doorbell = host.querySelector(
      '[data-testid="agent-credentials-doorbell"]'
    ) as HTMLButtonElement;
    const regen = host.querySelector(
      '[data-testid="agent-credentials-regenerate"]'
    ) as HTMLButtonElement;
    expect(disconnect.getAttribute("aria-describedby")).toBeNull();
    expect(doorbell.getAttribute("aria-describedby")).toBeNull();
    expect(regen.getAttribute("aria-disabled")).toBe("true");
    const reasonId = regen.getAttribute("aria-describedby");
    expect(reasonId).toBe(`agent-credentials-offline-${CONNECTION_ID}`);
    const note = document.getElementById(reasonId ?? "");
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("연결이 끊겨");
    expect(note?.closest("li")).toBe(regen.closest("li"));
    expect(
      regen.nextElementSibling === note ||
        regen.parentElement?.nextElementSibling === note
    ).toBe(true);
  });
});

describe("사보타주 ② 해제는 서버가 정한다 — HostedConnectionSection", () => {
  it("완료 분기는 서버 status 만 보고 응답을 다시 쓰지 않는다", () => {
    const source = hostedSectionSource();
    const terminal = source.slice(source.indexOf("function TerminalPanel"));
    expect(terminal).toMatch(
      /if \(connection\.status === "disconnected"\) \{/
    );
    expect(terminal).not.toMatch(
      /disconnected"\s*\|\|\s*connection\.status === "cleanup_pending"/
    );
    expect(source).toContain("writeDetail(started)");
    expect(source).toContain("writeDetail(completed)");
    expect(source).not.toMatch(/status:\s*"disconnected"/);
    expect(source).not.toMatch(/\.status\s*=\s*"disconnected"/);
  });

  it("착지 노드가 없으면 장부 제목으로 내린다", () => {
    const source = hostedSectionSource();
    expect(source).toContain("`[data-landing=\"${landOn}\"]`");
    expect(source).toContain('[data-landing="heading"]');
    const landEffect = source.slice(
      source.indexOf("if (landOn === undefined) return;")
    );
    const landOnQuery = landEffect.indexOf(
      '`[data-landing="${landOn}"]`'
    );
    const headingFallback = landEffect.indexOf(
      "'[data-landing=\"heading\"]'"
    );
    expect(landOnQuery).toBeGreaterThan(-1);
    expect(headingFallback).toBeGreaterThan(landOnQuery);
  });

  it("허브 region 은 에이전트 이름을 들고 설정은 labelledby 만 쓴다", () => {
    const source = hostedSectionSource();
    expect(source).toContain(
      "aria-labelledby={title ? headingId : undefined}"
    );
    expect(source).toContain(
      "aria-label={title ? undefined : `${agentLabel} 호스티드 연결`}"
    );
  });
});

describe("H-1 터미널 행은 도어벨을 두지 않는다", () => {
  it("정리 중·해제됨 행에는 도어벨이 없고 상태는 칩 한 번이다", async () => {
    const pendingId = "019f9a01-0000-7000-8000-0000000007c1";
    const doneId = "019f9a01-0000-7000-8000-0000000007c2";
    mockListAndDetail([
      wireConnection({ id: pendingId, status: "cleanup_pending" }),
      wireConnection({ id: doneId, status: "disconnected" }),
    ]);
    const host = mountSection();
    await waitFor(
      () =>
        host.querySelectorAll('[data-testid="agent-credentials-row"]').length ===
        2,
      "two terminal rows"
    );
    const pending = host.querySelector(
      `[data-connection-id="${pendingId}"]`
    ) as HTMLElement;
    const done = host.querySelector(
      `[data-connection-id="${doneId}"]`
    ) as HTMLElement;
    expect(
      pending.querySelector('[data-testid="agent-credentials-disconnect"]')
    ).not.toBeNull();
    expect(
      pending.querySelector('[data-testid="agent-credentials-doorbell"]')
    ).toBeNull();
    expect(
      done.querySelector('[data-testid="agent-credentials-disconnect"]')
    ).toBeNull();
    expect(
      done.querySelector('[data-testid="agent-credentials-doorbell"]')
    ).toBeNull();
    expect(
      done.querySelector('[data-testid="agent-credentials-record"]')
        ?.textContent
    ).toBe("기록 보기");
    expect(
      pending.querySelector('[data-testid="agent-credentials-record"]')
    ).toBeNull();
    expect(countNeedle(done.textContent ?? "", "연결 해제됨")).toBe(1);
    act(() => {
      (
        done.querySelector(
          '[data-testid="agent-credentials-record"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () =>
        host
          .querySelector('[data-testid="hosted-connection-section"]')
          ?.getAttribute("data-connection-id") === doneId,
      "record ledger"
    );
    expect(
      host
        .querySelector('[data-testid="hosted-connection-section"]')
        ?.getAttribute("data-landing-target")
    ).toBe("heading");
    act(() => {
      (
        pending.querySelector(
          '[data-testid="agent-credentials-disconnect"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () =>
        host
          .querySelector('[data-testid="hosted-connection-section"]')
          ?.getAttribute("data-connection-id") === pendingId,
      "cleanup heading land"
    );
    expect(document.activeElement?.getAttribute("data-landing")).toBe(
      "heading"
    );
    expect(
      host
        .querySelector('[data-testid="hosted-connection-section"]')
        ?.getAttribute("data-connection-id")
    ).toBe(pendingId);
  });
});

describe("여섯 상태는 빈 액션 칸이 없다", () => {
  it("disconnected 만 기록 보기를 두고 나머지는 각자 문이 있다", async () => {
    const statuses = [
      "pairing_pending",
      "detected",
      "active",
      "expired",
      "cleanup_pending",
      "disconnected",
    ] as const;
    mockListAndDetail(
      statuses.map((status, index) =>
        wireConnection({
          id: `019f9a01-0000-7000-8000-0000000008c${index + 1}`,
          status,
        })
      )
    );
    const host = mountSection();
    await waitFor(
      () =>
        host.querySelectorAll('[data-testid="agent-credentials-row"]').length ===
        6,
      "six rows"
    );
    const rows = [
      ...host.querySelectorAll('[data-testid="agent-credentials-row"]'),
    ] as HTMLElement[];
    for (const row of rows) {
      const actions = row.querySelector(
        '[data-testid="agent-credentials-row-actions"]'
      );
      expect(actions?.querySelectorAll("button").length ?? 0).toBeGreaterThan(0);
    }
    const done = rows[5];
    expect(
      done?.querySelector('[data-testid="agent-credentials-record"]')
        ?.textContent
    ).toBe("기록 보기");
    expect(
      done?.querySelector('[data-testid="agent-credentials-disconnect"]')
    ).toBeNull();
    expect(
      rows[4]?.querySelector('[data-testid="agent-credentials-doorbell"]')
    ).toBeNull();
  });
});

