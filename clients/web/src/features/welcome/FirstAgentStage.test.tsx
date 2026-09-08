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
import {
  DETECT_CAP_MS,
  FIRST_AGENT_CAP_COPY,
  FIRST_AGENT_CARDS,
  FIRST_AGENT_CHANNEL_PENDING,
  FIRST_AGENT_CONNECTED_CLAIM,
  FIRST_AGENT_LEAD_CARDS,
  FIRST_AGENT_LEAD_DETECTING,
  FIRST_AGENT_MENTION_ACTION,
  FIRST_AGENT_RECHECK_LABEL,
  FIRST_AGENT_RETRY_LABEL,
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
const PRODUCT_SECRET = "momo_pair_v1.issued-from-create-response";

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
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await flush();
  }
  throw new Error(`waitFor ${label}`);
}

function pressKey(el: Element, key: string): void {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });
}

function commitCard(host: HTMLElement, id: string): void {
  const radio = host.querySelector<HTMLInputElement>(`#first-agent-harness-${id}`);
  if (!radio) throw new Error(`missing card ${id}`);
  radio.focus();
  pressKey(radio, "Enter");
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
  window.history.replaceState(null, "", "/");
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
  vi.useRealTimers();
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  queryClient?.clear();
  queryClient = null;
});

describe("소스 규율", () => {
  it("위저드·1회용 카드·첫 멘션 조각·ChoiceList 를 복제하지 않는다", () => {
    const text = source();
    expect(text).toContain("HostedAgentWizard");
    expect(text).toContain('entry="settings"');
    expect(text).toContain("OneTimeSecretCard");
    expect(text).toContain("firstMentionDraft");
    expect(text).toContain("previewHintedAgent");
    expect(text).toContain("FIRST_MENTION_AGENT_BADGE");
    expect(text).toContain("elapsedLabel");
    expect(text).toContain("ChoiceList");
    expect(text).toContain("OnboardingSlideTransition");
    expect(text).not.toContain("FirstMentionOnboarding");
    expect(text).not.toContain("focusComposer");
    expect(text).not.toMatch(/function OneTimeSecretCard/);
    expect(text).not.toMatch(/function HostedAgentWizard/);
    expect(text).not.toContain(FIRST_AGENT_CONNECTED_CLAIM);
    expect(text).not.toContain(PRODUCT_SECRET);
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
    expect(host.textContent).toContain(FIRST_AGENT_LEAD_CARDS);
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

describe("B-1 화살표는 선택만", () => {
  it("ArrowDown 세 번은 카드에 머물고 마커를 쓰지 않는다", async () => {
    const host = mountStage();
    await waitFor(
      () => host.querySelector("#first-agent-harness-claude-code") !== null,
      "cards"
    );
    const first = host.querySelector<HTMLInputElement>(
      "#first-agent-harness-claude-code"
    );
    if (!first) throw new Error("first card");
    first.focus();
    pressKey(document.activeElement ?? first, "ArrowDown");
    pressKey(document.activeElement ?? first, "ArrowDown");
    pressKey(document.activeElement ?? first, "ArrowDown");
    expect(host.querySelector('[data-testid="first-agent-stage"]')?.getAttribute("data-step")).toBe(
      "cards"
    );
    expect(readFirstAgentMarker(WS)).toBeNull();
    expect(document.activeElement?.id).toBe("first-agent-harness-openai-compat");
    expect(continued).toBe(0);
  });
});

describe("B-2 감지 멘션은 보이는 문장과 핸드오프", () => {
  it("detected 경로에 이름·승인 대기·채널 액션이 있다", async () => {
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
    commitCard(host, "claude-code");
    await waitFor(
      () => document.querySelector('[data-testid="hosted-pairing-card"]') !== null,
      "wizard"
    );
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="hosted-secret-done"]')
        ?.click();
    });
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-detecting"]') !== null,
      "detecting"
    );
    expect(host.textContent).toContain(FIRST_AGENT_LEAD_DETECTING);
    expect(host.textContent).not.toContain(FIRST_AGENT_LEAD_CARDS);
    status = "detected";
    await act(async () => {
      vi.setSystemTime(1_000_000 + DETECT_CAP_MS - 1);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-mention"]') !== null,
      "mention"
    );
    expect(host.textContent).toContain("김인턴");
    expect(host.textContent).toContain(FIRST_AGENT_CHANNEL_PENDING);
    expect(host.textContent).toContain(FIRST_AGENT_MENTION_ACTION);
    expect(
      host.querySelector('[data-testid="first-agent-mention-action"]')?.getAttribute("data-href")
    ).toBe(`#/c/${GENERAL_ID}`);
    expect(host.querySelector("#composer-input")).toBeNull();
    expect(host.querySelector('[data-testid="first-agent-continue"]')).toBeNull();
  });
});

describe("H-2 상한은 다시 확인이 주 액션", () => {
  it("상한 스텝에 다시 확인이 있고 계속은 없다", async () => {
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection: wireConnection({ status: "pairing_pending" }),
      cleanupArtifacts: [],
    });
    const host = mountStage();
    await waitFor(
      () => host.querySelector("[data-choice-id='codex']") !== null,
      "cards"
    );
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    commitCard(host, "codex");
    await waitFor(
      () => document.querySelector('[data-testid="hosted-secret-done"]') !== null,
      "wizard"
    );
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="hosted-secret-done"]')
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
    expect(host.textContent).toContain(FIRST_AGENT_RECHECK_LABEL);
    expect(host.querySelector('[data-testid="first-agent-recheck"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="first-agent-continue"]')).toBeNull();
    expect(host.textContent).not.toContain(FIRST_AGENT_CONNECTED_CLAIM);
  });
});

describe("H-4 오프라인은 라디오를 탭 순서에 둔다", () => {
  it("fieldset 은 native disabled 가 아니고 사유를 가리킨다", async () => {
    offlineSlot.current = true;
    const host = mountStage();
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-choice"]') !== null,
      "choice"
    );
    const fieldset = host.querySelector("fieldset");
    const radio = host.querySelector<HTMLInputElement>("#first-agent-harness-claude-code");
    expect(fieldset?.hasAttribute("disabled")).toBe(false);
    expect(fieldset?.getAttribute("aria-disabled")).toBe("true");
    expect(fieldset?.getAttribute("aria-describedby") ?? "").toContain(
      "first-agent-offline-reason"
    );
    expect(radio?.disabled).toBe(false);
    expect(radio?.getAttribute("aria-disabled")).toBe("true");
    expect(radio?.getAttribute("aria-describedby") ?? "").toContain(
      "first-agent-offline-reason"
    );
  });
});

describe("M-1 목록 오류는 다시 시도이고 카드는 잠긴다", () => {
  it("오류 배너에 다시 시도가 있고 카드는 aria-disabled 다", async () => {
    vi.mocked(listHostedConnections).mockRejectedValue(new Error("boom"));
    const host = mountStage();
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-error"]') !== null,
      "error"
    );
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-choice"]') !== null,
      "choice"
    );
    expect(host.querySelector('[data-testid="first-agent-error"]')?.textContent).toContain(
      FIRST_AGENT_RETRY_LABEL
    );
    expect(host.querySelector("fieldset")?.getAttribute("aria-disabled")).toBe("true");
    expect(host.querySelector("[data-choice-id]")).not.toBeNull();
  });
});

describe("M-5 OpenAI 호환은 보류 마커", () => {
  it("설정으로 넘기기 전에 deferred 를 쓰고 done 은 쓰지 않는다", async () => {
    const host = mountStage();
    await waitFor(
      () => host.querySelector("#first-agent-harness-openai-compat") !== null,
      "cards"
    );
    commitCard(host, "openai-compat");
    await flush();
    expect(window.location.hash).toContain("/settings?section=ai");
    expect(readFirstAgentMarker(WS)).toBe("deferred");
    expect(continued).toBe(1);
  });
});

describe("M-6 pairing_pending 은 자동 통과가 아니다", () => {
  it("자격만 발급된 연결은 카드를 그대로 둔다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({
      connections: [wireConnection({ status: "pairing_pending" })],
    });
    const host = mountStage();
    await waitFor(
      () => host.querySelector("[data-choice-id]") !== null,
      "cards"
    );
    expect(continued).toBe(0);
    expect(readFirstAgentMarker(WS)).toBeNull();
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

describe("N-4 live region 은 컨트롤을 감싸지 않는다", () => {
  it("감지 status 안에 나중에 가 없고 스테이지는 heading 을 가리킨다", async () => {
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection: wireConnection({ status: "pairing_pending" }),
      cleanupArtifacts: [],
    });
    const host = mountStage();
    await waitFor(
      () => host.querySelector("[data-choice-id='grok']") !== null,
      "cards"
    );
    commitCard(host, "grok");
    await waitFor(
      () => document.querySelector('[data-testid="hosted-secret-done"]') !== null,
      "wizard"
    );
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="hosted-secret-done"]')
        ?.click();
    });
    await waitFor(
      () => host.querySelector('[data-testid="first-agent-detecting"]') !== null,
      "detecting"
    );
    const status = host.querySelector(
      '[data-testid="first-agent-detecting"] [role="status"]'
    );
    expect(status?.querySelector('[data-testid="first-agent-skip"]')).toBeNull();
    expect(host.querySelector('[data-testid="first-agent-skip"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="first-agent-stage"]')?.getAttribute("aria-labelledby")
    ).toBe("first-agent-heading");
  });
});

describe("사보타주 ① 1회용 값은 한 번만 (M-7)", () => {
  it("위저드 응답의 비밀 원소 텍스트가 한 번이다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const host = mountStage();
    await waitFor(
      () => host.querySelector("[data-choice-id='claude-code']") !== null,
      "cards"
    );
    commitCard(host, "claude-code");
    await waitFor(
      () => document.querySelector('[data-testid="hosted-pairing-card"]') !== null,
      "one-time"
    );
    const secretEls = [...document.querySelectorAll("dd")].filter(
      (node) => node.textContent === PRODUCT_SECRET
    );
    expect(secretEls).toHaveLength(1);
    expect(countNeedle(document.body.textContent ?? "", PRODUCT_SECRET)).toBe(1);
    expect(source()).not.toContain(PRODUCT_SECRET);
    const joined = [log, warn, error, info, debug]
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(joined).not.toContain(PRODUCT_SECRET);
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    info.mockRestore();
    debug.mockRestore();
  });
});
