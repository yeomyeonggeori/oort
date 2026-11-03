// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import {
  LOOPBACK_PROVIDER_HINT,
  LOOPBACK_REFUSAL_WIRE,
} from "@momo/core/features/settings/chainModel";
import { providerTestMessage } from "@momo/core/features/settings/model";
import {
  fetchProviderChain,
  fetchProviderLink,
  testProviderLink,
} from "@momo/core/features/settings/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiLinkSection } from "./AiLinkSection";

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchProviderLink: vi.fn(),
    testProviderLink: vi.fn(),
    fetchProviderChain: vi.fn(),
    putProviderLink: vi.fn(),
    deleteProviderLink: vi.fn(),
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

const roster: never[] = [];

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useDirectory: () => ({
      directory: actual.makeDirectory([]),
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

const LOOPBACK_LINK = {
  schema: "momo.provider_link.v0",
  configured: true,
  source: "database",
  mode: "external-hermes",
  baseUrl: "http://127.0.0.1:11434/v1",
  endpointLabel: "127.0.0.1:11434",
  bearerConfigured: true,
  bearerLast4: "8f21",
  availability: "live",
  keyConfigured: true,
  updatedAtMs: 1_700_000_000_000,
  diagnostics: [] as string[],
};

const LOOPBACK_PROBE = {
  schema: "momo.provider_link.test.v0",
  ok: false,
  reason: LOOPBACK_REFUSAL_WIRE,
  source: "database",
  mode: "external-hermes",
  endpointLabel: "127.0.0.1:11434",
  checkedAtMs: 1_700_000_000_000,
};

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
  vi.mocked(fetchProviderLink).mockReset();
  vi.mocked(testProviderLink).mockReset();
  vi.mocked(fetchProviderChain).mockReset();
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

function mountSection(): HTMLElement {
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
      createElement(MemoryRouter, null, createElement(AiLinkSection, { offline: false, workspaceId: "ws-1" }))
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
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

const source = readFileSync("src/features/settings/AiLinkSection.tsx", "utf8");

describe("AI 연결 loopback 안내 (#2204)", () => {
  it("서버 거부를 토스트가 아니라 자리의 배너로 연다", () => {
    expect(source).toContain("loopbackProviderGuidance");
    expect(source).toContain("isLoopbackProviderUrl");
    expect(source).toContain('testId="ai-link-loopback-hint"');
    expect(source).toContain("LoopbackRefusalBanner");
    expect(source).toContain("errorMessage(");
    expect(source).toContain("providerTestMessage(probe)");
    expect(source).not.toMatch(/toast/i);
  });

  it("프로브 거절은 사실 문장과 서버 원문을 함께 그린다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(LOOPBACK_LINK);
    vi.mocked(fetchProviderChain).mockRejectedValue(new ApiError(404, "not found"));
    vi.mocked(testProviderLink).mockResolvedValue(LOOPBACK_PROBE);
    const host = mountSection();
    // #2877: 확인은 줄의 곁판 안에 산다. 줄의 ⋯ 로 곁판을 연다.
    await waitFor(
      () => host.querySelector('[data-testid="ai-link-row-more"]') !== null,
      "row"
    );
    act(() => {
      (
        host.querySelector('[data-testid="ai-link-row-more"]') as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => host.querySelector('[data-testid="ai-link-check"]') !== null,
      "check"
    );
    act(() => {
      (
        host.querySelector('[data-testid="ai-link-check"]') as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => host.querySelector('[data-testid="ai-link-loopback-hint"]') !== null,
      "loopback banner"
    );
    const banner = host.querySelector(
      '[data-testid="ai-link-loopback-hint"]'
    ) as HTMLElement;
    expect(banner.textContent).toContain(LOOPBACK_PROVIDER_HINT);
    expect(banner.textContent).toContain(LOOPBACK_REFUSAL_WIRE);
    expect(banner.textContent).toContain(
      providerTestMessage({
        ok: false,
        reason: LOOPBACK_REFUSAL_WIRE,
        endpointLabel: LOOPBACK_PROBE.endpointLabel,
      })
    );
  });

  // #5221: `errorMessage` 는 서버 원문을 더는 돌려주지 않는다. 이 안내만은 서버의 사유 줄을 일부러 안내 아래에 붙이므로
  // 명시적인 `serverWireMessage` 를 쓴다: 요청 자체가 거절돼 던져진 경우(확인 요청이 loopback 을 거절했다)에도 그 줄이 남는다.
  it("확인 요청이 loopback 으로 거절돼 던져져도 서버의 사유 줄을 안내 아래에 붙인다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(LOOPBACK_LINK);
    vi.mocked(fetchProviderChain).mockRejectedValue(new ApiError(404, "not found"));
    vi.mocked(testProviderLink).mockRejectedValue(new ApiError(400, LOOPBACK_REFUSAL_WIRE));
    const host = mountSection();
    await waitFor(() => host.querySelector('[data-testid="ai-link-row-more"]') !== null, "row");
    act(() => {
      (host.querySelector('[data-testid="ai-link-row-more"]') as HTMLButtonElement).click();
    });
    await waitFor(() => host.querySelector('[data-testid="ai-link-check"]') !== null, "check");
    act(() => {
      (host.querySelector('[data-testid="ai-link-check"]') as HTMLButtonElement).click();
    });
    await waitFor(() => host.querySelector('[data-testid="ai-link-loopback-hint"]') !== null, "loopback banner");
    const banner = host.querySelector('[data-testid="ai-link-loopback-hint"]') as HTMLElement;
    expect(banner.textContent).toContain(LOOPBACK_PROVIDER_HINT);
    expect(banner.textContent).toContain(LOOPBACK_REFUSAL_WIRE);
  });
});
