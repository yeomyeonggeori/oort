// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkHost } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { SurfaceRoute } from "./SurfaceGate";

// =============================================================================
// #2780: `/work` 라우트의 세 답. 호스트 목록을 **읽지 못한 것**을 「호스트가
// 없다」로 말하면 화면이 거짓을 말한다(design-review H-1). 세 경우를 모두 그려
// 서로 다른 문장이 서는지 센다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const hostsAnswer: { run: () => Promise<WorkHost[]> } = {
  run: async () => [],
};

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchWorkHosts: () => hostsAnswer.run() };
});

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: {
        id: "00000000-0000-7000-8000-000000000101",
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

async function mount(): Promise<{ el: HTMLElement; client: QueryClient }> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: session() },
      createElement(
        SurfaceRoute,
        {
          surface: "workConsole",
          children: createElement("div", { "data-testid": "console-body" }),
        }
      )
    )
  );
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
  return { el: host, client };
}

async function settled(client: QueryClient): Promise<void> {
  await vi.waitFor(() => {
    const status = client.getQueryState(["work-hosts", WS])?.status;
    expect(status === "success" || status === "error").toBe(true);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function onlineHost(): WorkHost {
  return {
    id: "00000000-0000-7000-8000-000000000301",
    workspaceId: WS,
    scope: "workspace",
    ownerMemberId: "00000000-0000-7000-8000-000000000101",
    type: "workd",
    displayName: "팀 맥 미니",
    capabilities: {},
    createdAtMs: 1_800_000_000_000,
    online: true,
  };
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("SurfaceRoute (#2780)", () => {
  it("목록을 읽지 못하면 「호스트가 없다」가 아니라 읽지 못했다고 말하고 다시 시도를 준다", async () => {
    hostsAnswer.run = async () => {
      throw new Error("503");
    };
    const { el, client } = await mount();
    await settled(client);
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="surface-route-error-banner"]')).not.toBeNull();
    });
    expect(el.querySelector('[data-testid="surface-unavailable-route"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-body"]')).toBeNull();
    expect(el.querySelector("h1")?.textContent).toBe("작업 콘솔");
  });

  it("목록을 읽었고 온라인 호스트가 없으면 이유를 말하는 빈 상태다", async () => {
    hostsAnswer.run = async () => [{ ...onlineHost(), online: false }];
    const { el, client } = await mount();
    await settled(client);
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="surface-unavailable-route"]')).not.toBeNull();
    });
    expect(el.querySelector('[data-testid="surface-route-error-banner"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-body"]')).toBeNull();
  });

  it("온라인 호스트가 있으면 화면 자체가 선다", async () => {
    hostsAnswer.run = async () => [onlineHost()];
    const { el, client } = await mount();
    await settled(client);
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="console-body"]')).not.toBeNull();
    });
  });

  it("답이 오기 전에는 머리만 서고 「없다」를 먼저 말하지 않는다", async () => {
    hostsAnswer.run = () => new Promise<WorkHost[]>(() => undefined);
    const { el } = await mount();
    expect(el.querySelector('[data-testid="surface-route-pending"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="surface-unavailable-route"]')).toBeNull();
    expect(el.querySelector("h1")?.textContent).toBe("작업 콘솔");
  });
});
