// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import { fetchRoster, listChannels } from "@momo/core/lib/api";
import { firstMentionDraft } from "@momo/core/features/hostedAgents/firstMention";
import { fetchProviderLink, fetchWorkspace } from "@momo/core/features/settings/api";
import {
  createHostedConnection,
  getHostedConnection,
  listHostedConnections,
  regenerateHostedPairing,
} from "@momo/core/features/hostedAgents/api";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import {
  AI_CONNECT_BOUNDARY_NOTE,
  AI_CONNECT_DESKTOP_ONLY_NOTE,
  AI_CONNECT_QUESTION,
  AI_CONNECT_SERVER_OFF_NOTE,
  AI_CONNECT_SKIPPED_LINE,
  JOIN_CAP_LINE,
  JOIN_OFF_LINE,
  LOGIN_ACTION_LABEL,
  LOGIN_POLL_WINDOW_MS,
} from "@momo/core/features/onboarding/aiConnect";
import { clearAllDrafts, draftKey, readDraft } from "@/features/chat/draftStore";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { detectLocalHarnesses, openTerminalApp } from "@/lib/tauri";
import {
  DETECT_CAP_MS,
  FIRST_AGENT_CHANNEL_PENDING,
  FIRST_AGENT_CONNECTED_CLAIM,
  FIRST_AGENT_RECHECKING,
  FIRST_AGENT_RETRY_LABEL,
  FIRST_AGENT_CAPTURE_POSES,
} from "./firstAgent";
import {
  applyFirstAgentFocus,
  clearAllFirstAgentMarkers,
  readFirstAgentMarker,
} from "./firstAgentStore";
import { FirstAgentStage } from "./FirstAgentStage";

const poseSlot = vi.hoisted(() => ({ current: null as string | null }));
const envSlot = vi.hoisted(() => ({ tauri: false, flag: false }));

vi.mock("./firstAgent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./firstAgent")>();
  return {
    ...actual,
    readFirstAgentCapturePoseFromLocation: () =>
      actual.parseFirstAgentCapturePose(poseSlot.current),
  };
});

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return envSlot.tauri;
    },
    get SUBSCRIPTION_AGENTS_BUILD_FLAG() {
      return envSlot.flag;
    },
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isDesktop: () => envSlot.tauri,
    detectLocalHarnesses: vi.fn(),
    detectHostedAgents: vi.fn(async () => []),
    openTerminalApp: vi.fn(async () => true),
    openExternalUrl: vi.fn(async () => true),
  };
});

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

const offlineSlot = vi.hoisted(() => ({ current: false }));

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => offlineSlot.current,
}));

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "019f9a01-0000-7000-8000-000000000404";
const CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c1";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const PRODUCT_SECRET = "momo_pair_v1.issued-from-create-response";

const human: RosterMember = {
  id: MEMBER_ID,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "곽성재",
  handle: "seongjae",
  role: "owner",
  channelCount: 1,
  channelIds: [GENERAL_ID],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
};

const agent: RosterMember = {
  id: AGENT_ID,
  workspaceId: WS,
  kind: "agent",
  status: "active",
  displayName: "김인턴",
  handle: "intern",
  role: "member",
  channelCount: 1,
  channelIds: [GENERAL_ID],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
};

const unconfiguredLink = {
  schema: "momo.provider_link.v0",
  configured: false,
  source: "none",
  mode: "external-hermes",
  baseUrl: "",
  endpointLabel: "",
  bearerConfigured: false,
  availability: "unknown",
  keyConfigured: false,
  diagnostics: [] as string[],
};

const CLAUDE_READY: LocalHarnessProbe = { id: "claude", installed: true, auth: "logged_in" };
const CODEX_LOGIN: LocalHarnessProbe = { id: "codex", installed: true, auth: "needs_login" };

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchRoster: vi.fn(),
    listChannels: vi.fn(),
  };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchProviderLink: vi.fn(),
    fetchWorkspace: vi.fn(),
  };
});

vi.mock("@/features/hostedAgents/HostedAgentWizard", async () => {
  const { createElement } = await import("react");
  const { OneTimeSecretCard } = await import("../hostedAgents/OneTimeSecretCard");
  const {
    PAIRING_REVEAL_HEADLINE,
    PAIRING_REVEAL_SCOPE_NOTE,
    PAIRING_REVEAL_WARNING,
  } = await import("@momo/core/features/hostedAgents/presets");
  const secret = "momo_pair_v1.issued-from-create-response";
  return {
    HostedAgentWizard: (props: {
      open: boolean;
      entry?: string;
      launch: { presetId: string } | null;
      onPairingSaved?: (id: string) => void;
    }) =>
      props.open
        ? createElement(
            "div",
            {
              "data-testid": "hosted-pairing-saved",
              "data-entry": props.entry,
              "data-preset": props.launch?.presetId,
            },
            createElement(OneTimeSecretCard, {
              headline: PAIRING_REVEAL_HEADLINE,
              warning: PAIRING_REVEAL_WARNING,
              notes: [PAIRING_REVEAL_SCOPE_NOTE],
              secretLabel: "연결 값",
              secret,
              copyLabel: "연결 값 복사",
              onDone: () => props.onPairingSaved?.(CONNECTION_ID),
              testId: "hosted-pairing-card",
            })
          )
        : null,
  };
});

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

function workspaceIdentity(subscriptionAgentsEnabled: boolean) {
  return {
    id: WS,
    slug: "team",
    name: "우리 팀",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled,
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

function countNeedle(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let queryClient: QueryClient | null = null;
let continued = 0;
let clipboard: string[] = [];

function source(): string {
  return readFileSync(
    resolve(process.cwd(), "src/features/welcome/FirstAgentStage.tsx"),
    "utf8"
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const assertHeld = () => {
    if (!check()) throw new Error(`waitFor ${label}`);
  };
  // RTL 의 fake-timer 분기는 `jest` 를 본다. vitest 는 `vi` 만 있다.
  const previousJest = (globalThis as { jest?: unknown }).jest;
  const patchedJest = vi.isFakeTimers();
  if (patchedJest) {
    (globalThis as { jest?: unknown }).jest = vi;
  }
  try {
    await rtlWaitFor(assertHeld, { timeout: 5000 });
  } finally {
    if (patchedJest) {
      if (previousJest === undefined) {
        delete (globalThis as { jest?: unknown }).jest;
      } else {
        (globalThis as { jest?: unknown }).jest = previousJest;
      }
    }
  }
}

function q<T extends Element = HTMLElement>(host: ParentNode, testId: string): T | null {
  return host.querySelector<T>(`[data-testid="${testId}"]`);
}

function click(el: Element | null): void {
  if (!el) throw new Error("missing element");
  act(() => {
    (el as HTMLElement).click();
  });
}

/** 줄을 고르고 주 행동을 누른다(시안: 라디오 선택 → 「…를 내 에이전트로」). */
function pick(host: HTMLElement, id: string): void {
  const radio = host.querySelector<HTMLInputElement>(`#ai-connect-${id}`);
  if (!radio) throw new Error(`missing row ${id}`);
  click(radio);
  click(q(host, "first-agent-continue"));
}

function rowIds(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-testid="ai-connect-row"]')].map(
    (node) => node.getAttribute("data-row-id") ?? ""
  );
}

function mountStage(): HTMLElement {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(HashRouter, null, createElement(FirstAgentStage, {
        onContinue: () => {
          continued += 1;
        },
      }))
    )
  );
  act(() => {
    mountedRoot?.render(tree);
  });
  return host;
}

/** 데스크탑 + 빌드 플래그 + 서버 켬: 구독 줄이 서는 조건. */
function subscriptionOn(probes: LocalHarnessProbe[] = [CLAUDE_READY, CODEX_LOGIN]): void {
  envSlot.tauri = true;
  envSlot.flag = true;
  vi.mocked(fetchWorkspace).mockResolvedValue(workspaceIdentity(true));
  vi.mocked(detectLocalHarnesses).mockResolvedValue(probes);
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
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
  poseSlot.current = null;
  offlineSlot.current = false;
  envSlot.tauri = false;
  envSlot.flag = false;
  continued = 0;
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        clipboard.push(text);
      }),
    },
  });
  window.history.replaceState(null, "", "/");
  vi.mocked(fetchRoster).mockReset();
  vi.mocked(listChannels).mockReset();
  vi.mocked(fetchProviderLink).mockReset();
  vi.mocked(fetchWorkspace).mockReset();
  vi.mocked(fetchWorkspace).mockResolvedValue(workspaceIdentity(false));
  vi.mocked(detectLocalHarnesses).mockReset();
  vi.mocked(detectLocalHarnesses).mockResolvedValue([
    { id: "claude", installed: false, auth: "unknown" },
    { id: "codex", installed: false, auth: "unknown" },
  ]);
  vi.mocked(openTerminalApp).mockClear();
  let rosterCalls = 0;
  vi.mocked(fetchRoster).mockImplementation(async () => {
    rosterCalls += 1;
    return rosterCalls === 1 ? [human] : [human, agent];
  });
  vi.mocked(listChannels).mockResolvedValue([
    {
      id: GENERAL_ID,
      workspaceId: WS,
      name: "general",
      kind: "public",
      muted: false,
    },
  ]);
  vi.mocked(fetchProviderLink).mockResolvedValue(unconfiguredLink);
  clearAllFirstAgentMarkers();
  vi.mocked(listHostedConnections).mockReset();
  vi.mocked(getHostedConnection).mockReset();
  vi.mocked(createHostedConnection).mockReset();
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
  vi.mocked(getHostedConnection).mockResolvedValue({
    connection: wireConnection(),
    cleanupArtifacts: [],
  });
  vi.mocked(createHostedConnection).mockResolvedValue({
    connection: wireConnection({
      invocationScope: "owner_only",
      subscriptionHarness: "claude_code",
    }),
    pairingCredential: PRODUCT_SECRET,
    pairingExpiresAtMs: Date.now() + 600_000,
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  queryClient?.clear();
  queryClient = null;
  clearAllDrafts();
});

// ---- 목록 --------------------------------------------------------------------

describe("구독 줄 노출 (ADR-0193 D6, #2814)", () => {
  it("빌드 플래그가 꺼진 빌드는 구독 줄도, 그 이유도 그리지 않는다", async () => {
    envSlot.tauri = true;
    vi.mocked(fetchWorkspace).mockResolvedValue(workspaceIdentity(true));
    const host = mountStage();
    await waitFor(() => rowIds(host).length > 0, "rows");
    expect(rowIds(host)).toEqual(["api-key", "grok"]);
    expect(q(host, "first-agent-server-off")).toBeNull();
    expect(q(host, "first-agent-desktop-only")).toBeNull();
    expect(vi.mocked(detectLocalHarnesses)).not.toHaveBeenCalled();
    expect(q(host, "first-agent-heading")?.textContent).toBe(AI_CONNECT_QUESTION);
  });

  it("데스크탑 + 플래그 + 서버 켬이면 구독 두 줄이 맨 위다", async () => {
    subscriptionOn();
    const host = mountStage();
    await waitFor(() => rowIds(host).length === 4, "four rows");
    expect(rowIds(host)).toEqual(["claude", "codex", "api-key", "grok"]);
    expect(host.textContent).toContain(AI_CONNECT_BOUNDARY_NOTE);
  });

  it("서버 킬 스위치가 꺼지면 구독 줄을 숨기고 API 키 줄이 맨 위, 이유 한 줄", async () => {
    subscriptionOn();
    vi.mocked(fetchWorkspace).mockResolvedValue(workspaceIdentity(false));
    const host = mountStage();
    await waitFor(() => q(host, "first-agent-server-off") !== null, "server-off");
    expect(rowIds(host)).toEqual(["api-key", "grok"]);
    expect(q(host, "first-agent-server-off")?.textContent).toBe(AI_CONNECT_SERVER_OFF_NOTE);
    expect(host.querySelector("#ai-connect-claude")).toBeNull();
  });

  it("그 값을 모르는 서버(#2815 이전)도 꺼짐으로 읽는다", async () => {
    subscriptionOn();
    const { subscriptionAgentsEnabled: _omit, ...legacy } = workspaceIdentity(true);
    vi.mocked(fetchWorkspace).mockResolvedValue(legacy as never);
    const host = mountStage();
    await waitFor(() => rowIds(host).length > 0, "rows");
    await flush();
    expect(rowIds(host)).toEqual(["api-key", "grok"]);
  });

  it("웹에서는 구독 줄 대신 데스크탑 안내 한 줄", async () => {
    envSlot.flag = true;
    vi.mocked(fetchWorkspace).mockResolvedValue(workspaceIdentity(true));
    const host = mountStage();
    await waitFor(() => q(host, "first-agent-desktop-only") !== null, "desktop-only");
    expect(q(host, "first-agent-desktop-only")?.textContent).toBe(AI_CONNECT_DESKTOP_ONLY_NOTE);
    expect(rowIds(host)).toEqual(["api-key", "grok"]);
    expect(vi.mocked(detectLocalHarnesses)).not.toHaveBeenCalled();
  });
});

describe("알약과 선택", () => {
  it("준비됨 줄은 미리 골라지고, 로그인 필요 줄은 고를 수 없다", async () => {
    subscriptionOn();
    const host = mountStage();
    await waitFor(
      () => q(host, "ai-connect-pill-claude")?.getAttribute("data-pill") === "ready",
      "claude ready"
    );
    expect(q(host, "ai-connect-pill-claude")?.textContent).toBe("준비됨");
    expect(q(host, "ai-connect-pill-codex")?.textContent).toBe("로그인 필요");
    expect(host.querySelector<HTMLInputElement>("#ai-connect-claude")?.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>("#ai-connect-codex")?.disabled).toBe(true);
    expect(q(host, "first-agent-continue")?.textContent).toBe("Claude Code를 내 에이전트로");
    expect(q(host, "first-agent-heading")?.textContent).toBe("이 맥에서 Claude Code를 찾았어요.");
    expect(q(host, "kometto-guide")?.getAttribute("data-expression")).toBe("happy");
  });

  it("설치 안 된 CLI는 설치 필요 알약이고 줄은 잠긴다", async () => {
    subscriptionOn([
      { id: "claude", installed: false, auth: "unknown" },
      { id: "codex", installed: false, auth: "unknown" },
    ]);
    const host = mountStage();
    await waitFor(
      () => q(host, "ai-connect-pill-claude")?.getAttribute("data-pill") === "install",
      "install"
    );
    expect(q(host, "ai-connect-pill-claude")?.textContent).toBe("설치 필요");
    expect(host.querySelector<HTMLInputElement>("#ai-connect-claude")?.disabled).toBe(true);
    expect(q(host, "first-agent-heading")?.textContent).toBe(AI_CONNECT_QUESTION);
  });

  it("감지가 끝나기 전에는 확인 중… 이고 코메토는 생각하며, 로그인 명령 줄은 없다", async () => {
    subscriptionOn();
    vi.mocked(detectLocalHarnesses).mockImplementation(() => new Promise(() => undefined));
    const host = mountStage();
    await waitFor(() => q(host, "ai-connect-pill-claude") !== null, "pill");
    expect(q(host, "ai-connect-pill-claude")?.textContent).toBe("확인 중…");
    expect(q(host, "kometto-guide")?.getAttribute("data-expression")).toBe("thinking");
    expect(q(host, "ai-connect-login-claude")).toBeNull();
    expect(q(host, "ai-connect-login-codex")).toBeNull();
  });

  it("다시 확인 알약은 오렌지(신호색)가 아니다 (D11)", async () => {
    subscriptionOn([CLAUDE_READY, { id: "codex", installed: true, auth: "unknown" }]);
    const host = mountStage();
    await waitFor(
      () => q(host, "ai-connect-pill-codex")?.getAttribute("data-pill") === "recheck",
      "recheck"
    );
    expect(q(host, "ai-connect-pill-codex")?.getAttribute("data-tone")).not.toBe("sig");
  });
});

describe("「Claude로 로그인」 버튼이 없다 (ADR-0193 D2)", () => {
  it("로그인 필요 줄의 행동은 「터미널에서 로그인」과 복사뿐이다", async () => {
    subscriptionOn();
    const host = mountStage();
    await waitFor(() => q(host, "ai-connect-login-codex") !== null, "login row");
    const labels = [...host.querySelectorAll("button, a")].map(
      (node) => `${node.textContent ?? ""} ${node.getAttribute("aria-label") ?? ""}`
    );
    const offenders = labels.filter((text) =>
      /(Claude|ChatGPT|OpenAI|Anthropic|Codex)\s*(로|으로)\s*로그인/.test(text)
    );
    expect(offenders).toEqual([]);
    expect(q(host, "ai-connect-login-open-codex")?.textContent).toBe(LOGIN_ACTION_LABEL);
    expect(q(host, "ai-connect-login-command-codex")?.textContent).toBe("$ codex login");
    expect(q(host, "ai-connect-login-claude")).toBeNull();
  });
});

describe("터미널에서 로그인 → 2초 재확인 → 120초 뒤 다시 확인", () => {
  it("명령을 복사하고 터미널을 연 뒤, 로그인됨이 오면 준비됨이 된다", async () => {
    subscriptionOn();
    const host = mountStage();
    await waitFor(() => q(host, "ai-connect-login-open-codex") !== null, "login row");
    vi.useFakeTimers();
    const calls = vi.mocked(detectLocalHarnesses).mock.calls.length;
    vi.mocked(detectLocalHarnesses).mockResolvedValue([CLAUDE_READY, CODEX_LOGIN]);
    click(q(host, "ai-connect-login-open-codex"));
    await flush();
    await flush();
    expect(clipboard).toContain("codex login");
    expect(vi.mocked(openTerminalApp)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openTerminalApp).mock.calls[0]).toEqual([]);
    await waitFor(
      () => vi.mocked(detectLocalHarnesses).mock.calls.length > calls,
      "first recheck"
    );
    expect(q(host, "ai-connect-pill-codex")?.textContent).toBe("확인 중…");
    const afterFirst = vi.mocked(detectLocalHarnesses).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(vi.mocked(detectLocalHarnesses).mock.calls.length).toBe(afterFirst + 1);
    vi.mocked(detectLocalHarnesses).mockResolvedValue([
      CLAUDE_READY,
      { id: "codex", installed: true, auth: "logged_in" },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(
      () => q(host, "ai-connect-pill-codex")?.getAttribute("data-pill") === "ready",
      "codex ready"
    );
    const settled = vi.mocked(detectLocalHarnesses).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(vi.mocked(detectLocalHarnesses).mock.calls.length).toBe(settled);
  });

  it("120초 동안 로그인이 없으면 재확인을 멈추고 다시 확인 알약이 된다", async () => {
    subscriptionOn();
    const host = mountStage();
    await waitFor(() => q(host, "ai-connect-login-open-codex") !== null, "login row");
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    click(q(host, "ai-connect-login-open-codex"));
    await flush();
    await flush();
    await act(async () => {
      vi.setSystemTime(5_000_000 + LOGIN_POLL_WINDOW_MS);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(
      () => q(host, "ai-connect-pill-codex")?.getAttribute("data-pill") === "recheck",
      "recheck pill"
    );
    expect(q(host, "ai-connect-pill-codex")?.textContent).toBe("다시 확인");
    expect(q(host, "ai-connect-pill-codex")?.tagName).toBe("BUTTON");
    const stopped = vi.mocked(detectLocalHarnesses).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(vi.mocked(detectLocalHarnesses).mock.calls.length).toBe(stopped);
    click(q(host, "ai-connect-pill-codex"));
    await flush();
    expect(vi.mocked(detectLocalHarnesses).mock.calls.length).toBe(stopped + 1);
  });
});

// ---- 구독 합류 세 상태 ------------------------------------------------------

describe("구독 합류: 연결 명령 → 감지 대기 → 합류 (같은 화면)", () => {
  it("합류 요청은 owner_only + claude_code 를 싣고 이름은 「{나}의 Claude」다", async () => {
    subscriptionOn();
    const host = mountStage();
    await waitFor(
      () => host.querySelector<HTMLInputElement>("#ai-connect-claude")?.checked === true,
      "preselected"
    );
    click(q(host, "first-agent-continue"));
    await waitFor(() => q(host, "first-agent-connect-command") !== null, "command");
    expect(vi.mocked(createHostedConnection)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createHostedConnection).mock.calls[0]).toEqual([
      WS,
      {
        displayName: "곽성재의 Claude",
        handle: "seongjae-claude",
        authMode: "static_bearer",
        invocationScope: "owner_only",
        subscriptionHarness: "claude_code",
      },
    ]);
    const command = q(host, "first-agent-connect-command-text")?.textContent ?? "";
    expect(command).toContain("claude mcp add --scope user --transport http oort");
    expect(command).toContain("/v1/mcp/agent-port");
    expect(command).toContain(`Authorization: Bearer ${PRODUCT_SECRET}`);
    expect(countNeedle(document.body.textContent ?? "", PRODUCT_SECRET)).toBe(1);
    expect(q(host, "first-agent-heading")?.textContent).toBe(
      "터미널에서 이 명령을 한 번 실행해 주세요."
    );
    expect(q(host, "kometto-guide")?.getAttribute("data-expression")).toBe("idle");
    expect(q(host, "first-agent-stage")?.getAttribute("data-step")).toBe("connect");
  });

  it("터미널에서 열기 → 복사 + 인자 없는 터미널 열기 → 감지 대기(생각) → 합류(기쁨)", async () => {
    subscriptionOn();
    let status = "pairing_pending";
    vi.mocked(getHostedConnection).mockImplementation(async () => ({
      connection: wireConnection({ status }),
      cleanupArtifacts: [],
    }));
    const host = mountStage();
    await waitFor(
      () => host.querySelector<HTMLInputElement>("#ai-connect-claude")?.checked === true,
      "preselected"
    );
    click(q(host, "first-agent-continue"));
    await waitFor(() => q(host, "first-agent-connect-open") !== null, "open button");
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    click(q(host, "first-agent-connect-open"));
    await flush();
    await flush();
    expect(clipboard.some((text) => text.includes(PRODUCT_SECRET))).toBe(true);
    expect(vi.mocked(openTerminalApp).mock.calls).toEqual([[]]);
    await waitFor(() => q(host, "first-agent-detecting") !== null, "waiting");
    expect(q(host, "first-agent-heading")?.textContent).toBe(
      "Claude Code가 oort에 들어오기를 기다리고 있어요."
    );
    expect(q(host, "kometto-guide")?.getAttribute("data-expression")).toBe("thinking");
    expect(host.textContent).not.toContain(FIRST_AGENT_CONNECTED_CLAIM);
    status = "detected";
    await act(async () => {
      vi.setSystemTime(1_000_000 + 10_000);
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await waitFor(() => q(host, "first-agent-mention") !== null, "joined");
    expect(q(host, "first-agent-heading")?.textContent).toBe("곽성재의 Claude가 들어왔어요.");
    expect(q(host, "kometto-guide")?.getAttribute("data-expression")).toBe("happy");
    expect(q(host, "first-agent-mention-action")?.textContent).toBe("계속");
  });

  it("터미널을 열지 못하면 그 문장이 감지 대기 화면에 남는다", async () => {
    subscriptionOn();
    vi.mocked(openTerminalApp).mockResolvedValueOnce(false);
    const host = mountStage();
    await waitFor(
      () => host.querySelector<HTMLInputElement>("#ai-connect-claude")?.checked === true,
      "preselected"
    );
    click(q(host, "first-agent-continue"));
    await waitFor(() => q(host, "first-agent-connect-open") !== null, "open");
    const open = q(host, "first-agent-connect-open");
    open?.focus();
    click(open);
    await waitFor(() => q(host, "first-agent-detecting") !== null, "waiting");
    await waitFor(
      () => q(host, "first-agent-connect-status")?.textContent === "터미널을 열지 못했습니다. 명령을 복사해 직접 여세요.",
      "failure sentence"
    );
    expect(q(host, "first-agent-connect-status")?.getAttribute("role")).toBe("status");
    expect(document.activeElement?.id).not.toBe("first-agent-heading");
  });

  it("[다른 AI 고르기] 뒤 같은 CLI를 다시 고르면 새 에이전트 대신 값만 다시 받는다", async () => {
    subscriptionOn();
    vi.mocked(regenerateHostedPairing).mockResolvedValue({
      connection: wireConnection(),
      pairingCredential: "momo_pair_v1.regenerated-value",
      pairingExpiresAtMs: Date.now() + 600_000,
    });
    const host = mountStage();
    await waitFor(
      () => host.querySelector<HTMLInputElement>("#ai-connect-claude")?.checked === true,
      "preselected"
    );
    click(q(host, "first-agent-continue"));
    await waitFor(() => q(host, "first-agent-back") !== null, "back");
    click(q(host, "first-agent-back"));
    await waitFor(() => rowIds(host).length === 4, "list again");
    click(host.querySelector("#ai-connect-claude"));
    click(q(host, "first-agent-continue"));
    await waitFor(
      () => (q(host, "first-agent-connect-command-text")?.textContent ?? "").includes("regenerated-value"),
      "regenerated"
    );
    expect(vi.mocked(createHostedConnection)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(regenerateHostedPairing)).toHaveBeenCalledWith(WS, CONNECTION_ID);
  });

  it("5분 상한이면 당황 + 다시 확인", async () => {
    subscriptionOn();
    const host = mountStage();
    await waitFor(
      () => host.querySelector<HTMLInputElement>("#ai-connect-claude")?.checked === true,
      "preselected"
    );
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    click(q(host, "first-agent-continue"));
    await waitFor(() => q(host, "first-agent-connect-copy") !== null, "copy");
    click(q(host, "first-agent-connect-copy"));
    await waitFor(() => q(host, "first-agent-detecting") !== null, "waiting");
    await act(async () => {
      vi.setSystemTime(1_000_000 + DETECT_CAP_MS);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => q(host, "first-agent-cap-exceeded") !== null, "cap");
    expect(q(host, "first-agent-heading")?.textContent).toBe(JOIN_CAP_LINE);
    expect(q(host, "kometto-guide")?.getAttribute("data-expression")).toBe("flustered");
    expect(q(host, "first-agent-recheck")?.textContent).toBe("다시 확인");
  });

  it("서버가 409(킬 스위치)로 거절하면 구독 줄을 걷고 API 키 줄이 맨 위다", async () => {
    subscriptionOn();
    vi.mocked(createHostedConnection).mockRejectedValue(
      new ApiError(409, "subscription agents are disabled on this server")
    );
    const host = mountStage();
    await waitFor(
      () => host.querySelector<HTMLInputElement>("#ai-connect-claude")?.checked === true,
      "preselected"
    );
    click(q(host, "first-agent-continue"));
    await waitFor(() => q(host, "first-agent-server-off") !== null, "off");
    expect(rowIds(host)).toEqual(["api-key", "grok"]);
    expect(q(host, "first-agent-heading")?.textContent).toBe(JOIN_OFF_LINE);
    expect(q(host, "kometto-guide")?.getAttribute("data-expression")).toBe("flustered");
    expect(host.textContent).not.toContain("subscription agents are disabled");
  });

  it("핸들 409 는 다음 핸들로 한 번 다시 요청한다", async () => {
    subscriptionOn();
    vi.mocked(createHostedConnection)
      .mockRejectedValueOnce(new ApiError(409, "agent handle already exists"))
      .mockResolvedValueOnce({
        connection: wireConnection(),
        pairingCredential: PRODUCT_SECRET,
        pairingExpiresAtMs: Date.now() + 600_000,
      });
    const host = mountStage();
    await waitFor(
      () => host.querySelector<HTMLInputElement>("#ai-connect-claude")?.checked === true,
      "preselected"
    );
    click(q(host, "first-agent-continue"));
    await waitFor(() => q(host, "first-agent-connect-command") !== null, "command");
    const handles = vi
      .mocked(createHostedConnection)
      .mock.calls.map((call) => (call[1] as { handle: string }).handle);
    expect(handles).toEqual(["seongjae-claude", "seongjae-claude-2"]);
  });
});

// ---- 팀 에이전트·그록봇 -----------------------------------------------------

describe("API 키 줄은 설정 › AI 연결로 (보류 마커)", () => {
  it("설정으로 넘기기 전에 deferred 를 쓰고 done 은 쓰지 않는다", async () => {
    const host = mountStage();
    await waitFor(() => host.querySelector("#ai-connect-api-key") !== null, "rows");
    pick(host, "api-key");
    await flush();
    expect(window.location.hash).toContain("/settings?section=ai");
    expect(readFirstAgentMarker(WS)).toBe("deferred");
    expect(continued).toBe(1);
    expect(vi.mocked(createHostedConnection)).not.toHaveBeenCalled();
  });
});

async function grokToDetecting(host: HTMLElement): Promise<void> {
  await waitFor(() => host.querySelector("#ai-connect-grok") !== null, "rows");
  pick(host, "grok");
  await waitFor(
    () => document.querySelector('[data-testid="hosted-secret-done"]') !== null,
    "wizard"
  );
  expect(q(document, "hosted-pairing-saved")?.getAttribute("data-preset")).toBe("grok");
  click(document.querySelector('[data-testid="hosted-secret-done"]'));
  await waitFor(() => q(host, "first-agent-detecting") !== null, "detecting");
}

describe("그록봇 줄은 기존 위저드로 (팀 에이전트, owner_only 아님)", () => {
  it("위저드 뒤 감지 대기 → 감지되면 이름과 채널 승인 대기와 [계속]", async () => {
    let status = "pairing_pending";
    vi.mocked(getHostedConnection).mockImplementation(async () => ({
      connection: wireConnection({ status }),
      cleanupArtifacts: [],
    }));
    const host = mountStage();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await grokToDetecting(host);
    expect(q(host, "first-agent-heading")?.textContent).toBe(
      "그록봇이 oort에 들어오기를 기다리고 있어요."
    );
    await waitFor(() => vi.mocked(fetchRoster).mock.calls.length >= 2, "roster refresh");
    status = "detected";
    await act(async () => {
      vi.setSystemTime(1_000_000 + DETECT_CAP_MS - 1);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => q(host, "first-agent-mention") !== null, "mention");
    expect(q(host, "first-agent-mention-name")?.textContent).toBe("김인턴");
    expect(q(host, "first-agent-heading")?.textContent).toBe("김인턴이 들어왔어요.");
    expect(host.textContent).toContain(FIRST_AGENT_CHANNEL_PENDING);
    expect(q(host, "first-agent-mention-action")?.getAttribute("data-href")).toBe(
      `#/c/${GENERAL_ID}`
    );
    expect(vi.mocked(createHostedConnection)).not.toHaveBeenCalled();
  });

  it("위저드 응답의 비밀은 DOM 에 한 번, 콘솔에 0번", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined)
    );
    const host = mountStage();
    await waitFor(() => host.querySelector("#ai-connect-grok") !== null, "rows");
    pick(host, "grok");
    await waitFor(
      () => document.querySelector('[data-testid="hosted-pairing-card"]') !== null,
      "one-time"
    );
    expect(countNeedle(document.body.textContent ?? "", PRODUCT_SECRET)).toBe(1);
    expect(source()).not.toContain(PRODUCT_SECRET);
    const joined = spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(joined).not.toContain(PRODUCT_SECRET);
    for (const spy of spies) spy.mockRestore();
  });

  it("상한 뒤 다시 확인: get 이 하나 늘고 다시 확인 중, 그 뒤 폴링이 이어진다", async () => {
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection: wireConnection({ status: "pairing_pending" }),
      cleanupArtifacts: [],
    });
    const host = mountStage();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await grokToDetecting(host);
    await act(async () => {
      vi.setSystemTime(1_000_000 + DETECT_CAP_MS);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => q(host, "first-agent-cap-exceeded") !== null, "cap");
    const status = q(host, "first-agent-recheck-status");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toBe("");
    const before = vi.mocked(getHostedConnection).mock.calls.length;
    let settle: ((value: {
      connection: Record<string, unknown>;
      cleanupArtifacts: unknown[];
    }) => void) | undefined;
    vi.mocked(getHostedConnection).mockImplementation(
      () =>
        new Promise((resolveFn) => {
          settle = resolveFn;
        })
    );
    click(q(host, "first-agent-recheck"));
    await waitFor(
      () => q(host, "first-agent-recheck-status")?.textContent === FIRST_AGENT_RECHECKING,
      "rechecking"
    );
    expect(vi.mocked(getHostedConnection).mock.calls.length).toBe(before + 1);
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection: wireConnection({ status: "pairing_pending" }),
      cleanupArtifacts: [],
    });
    await act(async () => {
      settle?.({ connection: wireConnection({ status: "pairing_pending" }), cleanupArtifacts: [] });
      await Promise.resolve();
    });
    await waitFor(() => q(host, "first-agent-detecting") !== null, "detecting again");
    await flush();
    const afterSettle = vi.mocked(getHostedConnection).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(vi.mocked(getHostedConnection).mock.calls.length).toBeGreaterThan(afterSettle);
  });

  it("[계속]은 초안 @handle 을 심고 컴포저에 초점을 둔다", async () => {
    let status = "pairing_pending";
    vi.mocked(getHostedConnection).mockImplementation(async () => ({
      connection: wireConnection({ status }),
      cleanupArtifacts: [],
    }));
    const composer = document.createElement("textarea");
    composer.id = "composer-input";
    document.body.append(composer);
    const host = mountStage();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await grokToDetecting(host);
    await waitFor(() => vi.mocked(fetchRoster).mock.calls.length >= 2, "roster refresh");
    status = "detected";
    await act(async () => {
      vi.setSystemTime(1_000_000 + DETECT_CAP_MS - 1);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => q(host, "first-agent-mention-action") !== null, "mention");
    expect(q(host, "first-agent-reentry")?.className.split(/\s+/)).toContain("tap-target");
    expect(readDraft(WS, GENERAL_ID)).toBe("");
    click(q(host, "first-agent-mention-action"));
    const expected = firstMentionDraft(agent.handle);
    expect(readDraft(WS, GENERAL_ID)).toBe(expected);
    expect(localStorage.getItem(draftKey(WS, GENERAL_ID)) ?? "").toContain(expected);
    expect(readFirstAgentMarker(WS)).toBe("done");
    applyFirstAgentFocus();
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });
});

// ---- 건너뛰기·자동 통과·오프라인 --------------------------------------------

describe("[지금은 건너뛰기] → 코메토 졸림 + 재진입 위치", () => {
  it("졸림 한 화면을 보이고 [계속]에서 skipped 를 남긴다", async () => {
    const host = mountStage();
    await waitFor(() => q(host, "first-agent-skip") !== null, "skip");
    expect(q(host, "first-agent-skip")?.textContent).toBe("지금은 건너뛰기");
    click(q(host, "first-agent-skip"));
    await waitFor(() => q(host, "first-agent-skipped") !== null, "skipped");
    expect(q(host, "first-agent-heading")?.textContent).toBe(AI_CONNECT_SKIPPED_LINE);
    expect(q(host, "kometto-guide")?.getAttribute("data-expression")).toBe("sleepy");
    expect(readFirstAgentMarker(WS)).toBeNull();
    expect(continued).toBe(0);
    click(q(host, "first-agent-skipped-continue"));
    expect(readFirstAgentMarker(WS)).toBe("skipped");
    expect(continued).toBe(1);
  });

  it("재진입 문장이 목록 아래에 있다", async () => {
    const host = mountStage();
    await waitFor(() => q(host, "first-agent-reentry-line") !== null, "reentry");
    expect(q(host, "first-agent-reentry-line")?.textContent).toContain("설정 › AI 연결");
  });
});

describe("자동 통과", () => {
  it("연결이 하나 있으면 목록을 그리지 않고 완료 마커를 남긴다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({
      connections: [wireConnection({ status: "detected" })],
    });
    const host = mountStage();
    await waitFor(() => continued === 1, "auto-pass");
    expect(readFirstAgentMarker(WS)).toBe("done");
    expect(q(host, "ai-connect-row")).toBeNull();
  });

  it("pairing_pending 은 자동 통과가 아니다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({
      connections: [wireConnection({ status: "pairing_pending" })],
    });
    const host = mountStage();
    await waitFor(() => rowIds(host).length > 0, "rows");
    expect(continued).toBe(0);
  });

  it("provider 가 붙어 있어도 자동 통과다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue({
      ...unconfiguredLink,
      configured: true,
      source: "database",
    });
    mountStage();
    await waitFor(() => continued === 1, "provider auto-pass");
    expect(readFirstAgentMarker(WS)).toBe("done");
  });
});

describe("오프라인·목록 오류는 줄을 잠그고 주 행동을 잠근다", () => {
  function assertLockedContinue(host: HTMLElement) {
    const cont = q(host, "first-agent-continue");
    expect(cont?.getAttribute("aria-disabled")).toBe("true");
    expect(cont?.className.split(/\s+/)).toContain("opacity-50");
    expect(cont?.className.split(/\s+/)).toContain("pointer-events-none");
  }

  it("선택이 없으면 잠긴다", async () => {
    const host = mountStage();
    await waitFor(() => q(host, "first-agent-continue") !== null, "continue");
    assertLockedContinue(host);
  });

  it("오프라인이면 사유가 목록을 설명하고 줄은 고를 수 없다", async () => {
    offlineSlot.current = true;
    const host = mountStage();
    await waitFor(() => q(host, "ai-connect-list") !== null, "list");
    assertLockedContinue(host);
    expect(q(host, "ai-connect-list")?.getAttribute("aria-describedby")).toBe(
      "first-agent-offline-reason"
    );
    expect(host.querySelector<HTMLInputElement>("#ai-connect-api-key")?.disabled).toBe(true);
  });

  it("목록 오류는 다시 시도 배너와 당황 표정이다", async () => {
    vi.mocked(listHostedConnections).mockRejectedValue(new Error("boom"));
    const host = mountStage();
    await waitFor(() => q(host, "first-agent-error") !== null, "error");
    expect(q(host, "first-agent-error")?.textContent).toContain(FIRST_AGENT_RETRY_LABEL);
    expect(q(host, "kometto-guide")?.getAttribute("data-expression")).toBe("flustered");
  });
});

describe("틀 (ADR-0193 D10·D11)", () => {
  it("새벽하늘 바닥 위 코메토 머리 + 진행 점(claim 경로 4단계 중 4단계)", async () => {
    const host = mountStage();
    await waitFor(
      () => q(host, "onboarding-dots-label")?.textContent === "4단계 중 4단계",
      "dots"
    );
    expect(q(host, "onboarding-frame")).not.toBeNull();
    expect(q(host, "kometto-face")?.getAttribute("data-size")).toBe("head");
    expect(q(host, "onboarding-dots-label")?.textContent).toBe("4단계 중 4단계");
    expect(q(host, "first-agent-stage")?.getAttribute("aria-labelledby")).toBe(
      "first-agent-heading"
    );
    expect(q(host, "first-agent-heading")?.tagName).toBe("H1");
    expect(host.querySelector("#first-agent-heading")).toBe(q(host, "first-agent-heading"));
  });

  it("모든 캡처 자세가 한 문장과 함께 선다", async () => {
    for (const pose of FIRST_AGENT_CAPTURE_POSES) {
      poseSlot.current = pose;
      const host = mountStage();
      await waitFor(() => q(host, "first-agent-stage") !== null, pose);
      expect((q(host, "first-agent-heading")?.textContent ?? "").length, pose).toBeGreaterThan(0);
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
      host.remove();
    }
  });
});

describe("긴 이름은 합류 카드 안에서 자른다", () => {
  it("60자 이름·핸들은 truncate + min-w-0 이고 title 은 측정에 맡긴다", async () => {
    const LONG = "김인턴-데이터플랫폼-온콜 Agent Runtime Operations Assistant 김인턴-온콜대기열용자";
    expect(LONG.length).toBeGreaterThanOrEqual(60);
    let rosterCalls = 0;
    vi.mocked(fetchRoster).mockImplementation(async () => {
      rosterCalls += 1;
      return rosterCalls === 1 ? [human] : [human, { ...agent, displayName: LONG }];
    });
    let status = "pairing_pending";
    vi.mocked(getHostedConnection).mockImplementation(async () => ({
      connection: wireConnection({ status }),
      cleanupArtifacts: [],
    }));
    const host = mountStage();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await grokToDetecting(host);
    await waitFor(() => vi.mocked(fetchRoster).mock.calls.length >= 2, "roster");
    status = "detected";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => q(host, "first-agent-mention-name")?.textContent === LONG, "name");
    for (const id of ["first-agent-mention-name", "first-agent-mention-handle"]) {
      const cls = q(host, id)?.className.split(/\s+/) ?? [];
      expect(cls, id).toContain("truncate");
      expect(cls, id).toContain("min-w-0");
    }
    expect(q(host, "first-agent-mention-column")?.className.split(/\s+/)).toContain("min-w-0");
  });
});

describe("소스 규율", () => {
  it("위저드·1회용 카드·첫 멘션 조각을 복제하지 않고 틀을 쓴다", () => {
    const text = source();
    expect(text).toContain("HostedAgentWizard");
    expect(text).toContain('entry="settings"');
    expect(text).toContain("OneTimeSecretCard");
    expect(text).toContain("firstMentionDraft");
    expect(text).toContain("previewHintedAgent");
    expect(text).toContain("KomettoGuide");
    expect(text).toContain("OnboardingFrame");
    expect(text).toContain("OnboardingSlideTransition");
    expect(text).not.toMatch(/function OneTimeSecretCard/);
    expect(text).not.toMatch(/function HostedAgentWizard/);
    expect(text).not.toContain(PRODUCT_SECRET);
  });

  it("연결 값을 저장소·로그로 보내지 않는다", () => {
    for (const file of [
      "src/features/welcome/FirstAgentStage.tsx",
      "src/features/welcome/SubscriptionConnectBlock.tsx",
      "src/features/welcome/AiConnectList.tsx",
    ]) {
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(text, file).not.toMatch(/localStorage|sessionStorage|console\./);
    }
  });
});
