// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import {
  getHostedConnection,
  listHostedConnections,
} from "@momo/core/features/hostedAgents/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { hostedListQueryKey } from "@/features/hostedAgents/hostedCredentialScope";
import {
  DETECT_CAP_MS,
  FIRST_AGENT_CAP_COPY,
  FIRST_AGENT_CAPTURE_SECRET,
  FIRST_AGENT_CARDS,
  FIRST_AGENT_CONNECTED_CLAIM,
  parseFirstAgentCapturePose,
} from "./firstAgent";
import {
  clearAllFirstAgentMarkers,
  readFirstAgentMarker,
} from "./firstAgentStore";
import { FirstAgentStage } from "./FirstAgentStage";

const poseSlot = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("./firstAgent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./firstAgent")>();
  return {
    ...actual,
    readFirstAgentCapturePoseFromLocation: () =>
      actual.parseFirstAgentCapturePose(poseSlot.current),
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

const roster: RosterMember[] = [];

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useDirectory: () => ({
      directory: makeDirectory(roster),
      isPending: false,
      isError: false,
      data: roster,
      refetch: () => undefined,
    }),
    useChannels: () => ({
      isPending: false,
      isSuccess: true,
      isError: false,
      data: [
        {
          id: GENERAL_ID,
          workspaceId: WS,
          name: "general",
          kind: "public",
          muted: false,
          createdAtMs: 0,
          updatedAtMs: 0,
        },
      ],
      groups: {
        channels: [
          {
            id: GENERAL_ID,
            workspaceId: WS,
            name: "general",
            kind: "public",
            muted: false,
            createdAtMs: 0,
            updatedAtMs: 0,
          },
        ],
        dms: [],
      },
      refetch: () => undefined,
    }),
  };
});

vi.mock("@/features/hostedAgents/HostedAgentWizard", () => ({
  HostedAgentWizard: (props: {
    open: boolean;
    entry?: string;
    launch: { presetId: string } | null;
    onPairingSaved?: (id: string) => void;
  }) =>
    props.open
      ? createElement(
          "button",
          {
            type: "button",
            "data-testid": "hosted-pairing-saved",
            "data-entry": props.entry,
            "data-preset": props.launch?.presetId,
            onClick: () => props.onPairingSaved?.(CONNECTION_ID),
          },
          "pairing saved"
        )
      : null,
}));

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

function parsedActive() {
  return {
    id: CONNECTION_ID,
    agentMemberId: AGENT_ID,
    status: "active" as const,
    authMode: "static_bearer" as const,
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [GENERAL_ID],
    approvedScopes: ["messages:write"],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
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
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await flush();
  }
  throw new Error(`waitFor ${label}`);
}

function mountStage(): HTMLElement {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  poseSlot.current = null;
  offlineSlot.current = false;
  continued = 0;
  roster.splice(
    0,
    roster.length,
    {
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
    },
    {
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
    }
  );
  clearAllFirstAgentMarkers();
  vi.mocked(listHostedConnections).mockReset();
  vi.mocked(getHostedConnection).mockReset();
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
  vi.mocked(getHostedConnection).mockResolvedValue({
    connection: wireConnection(),
    cleanupArtifacts: [],
  });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  queryClient?.clear();
  queryClient = null;
  vi.useRealTimers();
});

describe("소스 규율", () => {
  it("위저드·1회용 카드·첫 멘션·ChoiceList 를 복제하지 않는다", () => {
    const text = source();
    expect(text).toContain("HostedAgentWizard");
    expect(text).toContain('entry="settings"');
    expect(text).toContain("OneTimeSecretCard");
    expect(text).toContain("FirstMentionOnboarding");
    expect(text).toContain("ChoiceList");
    expect(text).toContain("OnboardingSlideTransition");
    expect(text).not.toMatch(/function OneTimeSecretCard/);
    expect(text).not.toMatch(/function HostedAgentWizard/);
    expect(text).not.toContain(FIRST_AGENT_CONNECTED_CLAIM);
  });
});

describe("카드 4 · 건너뛰기", () => {
  it("카드가 넷이고 나중에 건너뛰기가 상시 있다", async () => {
    const host = mountStage();
    await waitFor(
      () => host.querySelectorAll("[data-choice-id]").length === 4,
      "cards"
    );
    const ids = [...host.querySelectorAll("[data-choice-id]")].map((node) =>
      node.getAttribute("data-choice-id")
    );
    expect(ids).toEqual(FIRST_AGENT_CARDS.map((card) => card.id));
    expect(host.querySelector('[data-testid="first-agent-skip"]')?.textContent).toBe(
      "나중에"
    );
    expect(host.textContent).toContain("Grok Bot");
    expect(host.querySelector('[data-testid="first-agent-stage"]')?.className).toMatch(
      /\bmax-w-sm\b/
    );
  });

  it("건너뛰기는 마커를 남기고 이어간다", async () => {
    const host = mountStage();
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-skip"]') !== null,
      "skip"
    );
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="first-agent-skip"]')?.click();
    });
    expect(readFirstAgentMarker(WS)).toBe("skipped");
    expect(continued).toBe(1);
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="first-agent-skip"]')?.click();
    });
    expect(readFirstAgentMarker(WS)).toBe("skipped");
    expect(continued).toBe(2);
  });
});

describe("자동 통과", () => {
  it("연결이 하나 있으면 카드를 그리지 않고 완료 마커를 남긴다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({
      connections: [wireConnection({ status: "detected" })],
    });
    const host = mountStage();
    await waitFor(() => continued === 1, "auto-pass");
    expect(readFirstAgentMarker(WS)).toBe("done");
    expect(host.querySelector("[data-choice-id]")).toBeNull();
  });
});

describe("네 상태", () => {
  it("목록 오류는 자리의 InlineBanner 다", async () => {
    vi.mocked(listHostedConnections).mockRejectedValue(new Error("boom"));
    const host = mountStage();
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-error"]') !== null,
      "error"
    );
    expect(host.querySelector("[data-choice-id]")).not.toBeNull();
  });

  it("오프라인은 자리의 배너다", async () => {
    offlineSlot.current = true;
    const host = mountStage();
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-offline"]') !== null,
      "offline"
    );
  });
});

describe("발급 → 감지 → 멘션 왕복", () => {
  it("서버가 pairing 이면 연결됨이 없고, detected 뒤에 멘션이 선다", async () => {
    let status = "pairing_pending";
    vi.mocked(getHostedConnection).mockImplementation(async () => ({
      connection: wireConnection({ status }),
      cleanupArtifacts: [],
    }));
    const host = mountStage();
    await waitFor(
      () => host.querySelector("[data-choice-id='claude-code']") !== null,
      "cards"
    );
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    act(() => {
      host
        .querySelector<HTMLInputElement>("#first-agent-harness-claude-code")
        ?.click();
    });
    await waitFor(
      () => document.querySelector('[data-testid="hosted-pairing-saved"]') !== null,
      "wizard"
    );
    expect(
      document.querySelector('[data-testid="hosted-pairing-saved"]')?.getAttribute("data-entry")
    ).toBe("settings");
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="hosted-pairing-saved"]')
        ?.click();
    });
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-detecting"]') !== null,
      "detecting"
    );
    expect(host.textContent).not.toContain(FIRST_AGENT_CONNECTED_CLAIM);
    status = "detected";
    await act(async () => {
      vi.setSystemTime(1_000_000 + DETECT_CAP_MS - 1);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-mention"]') !== null,
      "mention"
    );
    expect(host.querySelector('[data-testid="first-agent-continue"]')).not.toBeNull();
    queryClient?.setQueryData(hostedListQueryKey(WS), [parsedActive()]);
    await flush();
  });
});

describe("상한 초과 문장", () => {
  it("상한에 닿으면 그 문장이 선다", async () => {
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection: wireConnection({ status: "pairing_pending" }),
      cleanupArtifacts: [],
    });
    poseSlot.current = null;
    const host = mountStage();
    await waitFor(
      () => host.querySelector("[data-choice-id='codex']") !== null,
      "cards"
    );
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    act(() => {
      host.querySelector<HTMLInputElement>("#first-agent-harness-codex")?.click();
    });
    await waitFor(
      () => document.querySelector('[data-testid="hosted-pairing-saved"]') !== null,
      "wizard"
    );
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="hosted-pairing-saved"]')
        ?.click();
    });
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-detecting"]') !== null,
      "detecting"
    );
    await act(async () => {
      vi.setSystemTime(1_000_000 + DETECT_CAP_MS);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-cap-exceeded"]') !== null,
      "cap"
    );
    expect(host.textContent).toContain(FIRST_AGENT_CAP_COPY);
    expect(host.textContent).not.toContain(FIRST_AGENT_CONNECTED_CLAIM);
  });
});

describe("사보타주 ① 1회용 값은 한 번만", () => {
  it("캡처 포즈에서 DOM·로그에 값이 한 번이다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    poseSlot.current = "one-time";
    expect(parseFirstAgentCapturePose(poseSlot.current)).toBe("one-time");
    const host = mountStage();
    await waitFor(
      () => host.querySelector('[data-testid="hosted-pairing-card"]') !== null,
      "one-time"
    );
    const text = document.body.textContent ?? "";
    const html = document.body.innerHTML;
    expect(countNeedle(text, FIRST_AGENT_CAPTURE_SECRET)).toBe(1);
    expect(countNeedle(html, FIRST_AGENT_CAPTURE_SECRET)).toBe(1);
    const joined = [log, warn, error, info, debug]
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(joined).not.toContain(FIRST_AGENT_CAPTURE_SECRET);
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    info.mockRestore();
    debug.mockRestore();
  });
});
