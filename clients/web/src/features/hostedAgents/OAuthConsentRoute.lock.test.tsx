// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { previewHostedOauthConsent } from "@momo/core/features/hostedAgents/api";
import { OAuthConsentRoute } from "./OAuthConsentRoute";

const REQUEST = "signed.envelope.value";
const CONNECTION = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const GENERAL = "00000000-0000-7000-8000-000000000201";

vi.mock("@momo/core/features/hostedAgents/api", () => ({
  previewHostedOauthConsent: vi.fn(),
  approveHostedOauthConsent: vi.fn(() => new Promise(() => undefined)),
  denyHostedOauthConsent: vi.fn(),
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

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchRoster: vi.fn(async () => []),
    listChannels: vi.fn(async () => [
      {
        id: GENERAL,
        workspaceId: WS,
        name: "general",
        kind: "public",
        muted: false,
      },
    ]),
  };
});

vi.mock("@/features/common/useOffline", () => ({
  useBrowserOffline: () => false,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

const session: LoginResponse = {
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
};

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

function mountRoute(): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(OAuthConsentRoute, {
      status: "signed-in",
      session,
      onLoggedIn: () => undefined,
    })
  );
  act(() => {
    mountedRoot?.render(tree);
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    `/oauth/consent?request=${REQUEST}`
  );
  vi.mocked(previewHostedOauthConsent).mockResolvedValue({
    clientId: "grok-bot",
    redirectUri: "https://grok.example/callback",
    resource: "https://oort.example/v1/mcp/agent-port",
    issuer: "https://oort.example",
    requestedScopes: ["agent:port:connect", "messages:write"],
    expiresAtMs: Date.now() + 60_000,
    candidates: [
      {
        connectionId: CONNECTION,
        agentMemberId: AGENT,
        agentDisplayName: "Grok 리서치",
        createdAtMs: 10,
      },
    ],
  });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

describe("OAuthConsentRoute ChoiceList 잠금", () => {
  it("결정 중인 권한 목록은 native fieldset disabled 다", async () => {
    const host = mountRoute();
    await waitFor(
      () => host.querySelector('[data-testid="oauth-scopes"]') !== null,
      "scopes"
    );
    const unlocked = host.querySelector<HTMLFieldSetElement>(
      '[data-testid="oauth-scopes"]'
    );
    expect(unlocked?.disabled).toBe(false);
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="oauth-consent-approve"]')
        ?.click();
    });
    await waitFor(
      () =>
        host.querySelector<HTMLFieldSetElement>('[data-testid="oauth-scopes"]')
          ?.disabled === true,
      "busy lock"
    );
    const fieldset = host.querySelector<HTMLFieldSetElement>(
      '[data-testid="oauth-scopes"]'
    );
    expect(fieldset?.disabled).toBe(true);
    expect(fieldset?.hasAttribute("aria-disabled")).toBe(false);
  });
});
