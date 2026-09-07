// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { emptySidebarPrefs } from "@momo/core/features/sidebar/sidebarSections";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { WORK_SURFACE_IDS } from "@momo/core/features/capabilities/serverSurfaces";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { QuickSwitcher } from "@/app/QuickSwitcher";
import { SettingsRoute } from "@/features/settings/SettingsRoute";

// =============================================================================
// #2166 work-surface hide: count real entry points in the rendered tree.
//
// The flag under test is the existing SURFACES `provided` bit, reached through
// `isSurfaceProvided`. A constant-table assertion would stay green if a row
// were added and never wired; counting sidebar / ⌘K / settings nodes is the
// thing that can go red.
// =============================================================================

const workFlag = { provided: false };

vi.mock("@momo/core/features/capabilities/serverSurfaces", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/capabilities/serverSurfaces")>();
  const workIds = new Set<string>(actual.WORK_SURFACE_IDS);
  return {
    ...actual,
    isSurfaceProvided: (id: string) =>
      workIds.has(id)
        ? workFlag.provided
        : actual.isSurfaceProvided(
            id as import("@momo/core/features/capabilities/serverSurfaces").SurfaceId
          ),
  };
});

vi.mock("@/features/workspace/useAddWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useAddWorkspace")>();
  return {
    ...actual,
    useOpenAddWorkspace: () => () => undefined,
  };
});

vi.mock("@/features/channels/useCreateChannel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/channels/useCreateChannel")>();
  return {
    ...actual,
    useOpenCreateChannel: () => () => undefined,
    useCreateChannelOpen: () => false,
  };
});

vi.mock("@/features/routing/useAgentProfile", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/routing/useAgentProfile")>();
  return { ...actual, useOpenAgentProfile: () => () => undefined };
});

vi.mock("@/features/emoji/useHoverNone", () => ({
  useHoverNone: () => false,
}));

vi.mock("@/features/sidebar/ProfileCard", () => ({
  ProfileCard: () => null,
}));

vi.mock("@/features/sidebar/WorkspaceRail", () => ({
  WorkspaceRail: () => null,
}));

vi.mock("@/app/ShortcutHelpDialog", () => ({
  ShortcutHelpDialog: () => null,
}));

vi.mock("@/features/drafts/DraftsNavItem", () => ({
  DraftsNavItem: () => null,
}));

vi.mock("@/features/drafts/useDraftsPanel", () => ({
  useDraftsPanel: () => ({ showNav: false }),
}));

vi.mock("@/features/settings/AiLinkSection", () => ({
  AiLinkSection: () => createElement("div", { "data-testid": "section-ai" }),
}));
vi.mock("@/features/settings/AgentCredentialsSection", () => ({
  AgentCredentialsSection: () =>
    createElement("div", { "data-testid": "section-agents" }),
}));
vi.mock("@/features/settings/WorkHostSection", () => ({
  WorkHostSection: () => createElement("div", { "data-testid": "section-code" }),
}));
vi.mock("@/features/settings/WorkspaceSection", () => ({
  WorkspaceSection: () =>
    createElement("div", { "data-testid": "section-workspace" }),
}));
vi.mock("@/features/plugins/PluginSection", () => ({
  PluginSection: () =>
    createElement("div", { "data-testid": "section-plugins" }),
}));
vi.mock("@/features/settings/UsageSection", () => ({
  UsageSection: () => createElement("div", { "data-testid": "section-usage" }),
}));
vi.mock("@/features/settings/WebhookSection", () => ({
  WebhookSection: () =>
    createElement("div", { "data-testid": "section-webhooks" }),
}));
vi.mock("@/features/settings/InviteSection", () => ({
  InviteSection: () =>
    createElement("div", { "data-testid": "section-members" }),
}));
vi.mock("@/features/settings/EventSubscriptionSection", () => ({
  EventSubscriptionSection: () =>
    createElement("div", { "data-testid": "section-events" }),
}));
vi.mock("@/features/settings/NotificationRulesSection", () => ({
  NotificationRulesSection: () =>
    createElement("div", { "data-testid": "section-notifications" }),
}));
vi.mock("@/features/settings/AppearanceSection", () => ({
  AppearanceSection: () =>
    createElement("div", { "data-testid": "section-appearance" }),
}));
vi.mock("@/features/settings/LinkPreviewSection", () => ({
  LinkPreviewSection: () =>
    createElement("div", { "data-testid": "section-link-previews" }),
}));
vi.mock("@/features/updates/UpdateSection", () => ({
  UpdateSection: () =>
    createElement("div", { "data-testid": "section-updates" }),
}));

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";

const ENTRY_TEST_IDS = [
  "nav-work-console",
  "nav-workstreams",
  "switcher-work-console",
  "switcher-workstreams",
  "settings-nav-code",
] as const;

const engine: Channel = {
  id: CH,
  workspaceId: WS,
  kind: "public",
  name: "엔진",
  muted: false,
};

const self: RosterMember = {
  id: MEMBER_ID,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "곽성재",
  handle: "seongjae",
  role: "owner",
  channelCount: 1,
  channelIds: [CH],
  capabilities: [],
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
};

const channelsQuery = {
  isLoading: false,
  isPending: false,
  isSuccess: true,
  isError: false,
  error: null as Error | null,
  refetch: () => undefined,
  groups: { channels: [engine], dms: [] as Channel[] },
  data: [engine] as Channel[],
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsQuery,
    useDirectory: () => ({
      directory: makeDirectory([self]),
      isPending: false,
      isLoading: false,
      refetch: () => undefined,
    }),
    useReadStates: () => ({
      byChannel: new Map(),
      isPending: false,
      error: null,
    }),
  };
});

vi.mock("@momo/core/features/sidebar/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/sidebar/api")>();
  return {
    ...actual,
    fetchSidebarPrefs: async () => emptySidebarPrefs(),
    putSidebarPrefs: async (_ws: string, prefs: unknown) => prefs,
  };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchWorkspace: async () => ({
      id: WS,
      slug: "dawn",
      name: "새벽",
      updatedAtMs: 1_800_000_000_000,
      roleLabels: {},
      welcomeAgentMemberId: null,
      welcomePrompt: "",
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

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

async function mount(): Promise<HTMLElement> {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["roster", WS], [self]);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        ShellNavProvider,
        {
          value: {
            isMobile: false,
            drawerOpen: false,
            openDrawer: () => undefined,
            closeDrawer: () => undefined,
          },
        },
        createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          createElement(
            "div",
            null,
            createElement(Sidebar, {
              onOpenQuickSwitcher: () => undefined,
              channelPaneCollapsed: false,
              treeHidden: false,
            }),
            createElement(QuickSwitcher, {
              open: true,
              onOpenChange: () => undefined,
            }),
            createElement(SettingsRoute)
          )
        )
      )
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="nav-directory"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="settings-route"]')).not.toBeNull();
  });
  return host;
}

function countWorkEntries(root: ParentNode = document): number {
  return ENTRY_TEST_IDS.reduce(
    (sum, id) => sum + root.querySelectorAll(`[data-testid="${id}"]`).length,
    0
  );
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});

beforeEach(() => {
  workFlag.provided = false;
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
  vi.unstubAllGlobals();
});

describe("work 표면 진입점 (#2166)", () => {
  it("숨긴 표면 id는 workstreams · workConsole · work · ade 이다", () => {
    expect([...WORK_SURFACE_IDS]).toEqual([
      "workstreams",
      "workConsole",
      "work",
      "ade",
    ]);
  });

  it("provided:false 이면 사이드바·QuickSwitcher·설정 진입점이 0이다", async () => {
    workFlag.provided = false;
    const host = await mount();
    expect(host.querySelector('[data-testid="settings-route"]')).not.toBeNull();
    expect(countWorkEntries()).toBe(0);
  });

  it("provided:true 이면 같은 다섯 진입점이 복귀한다", async () => {
    workFlag.provided = true;
    const host = await mount();
    expect(host.querySelector('[data-testid="settings-route"]')).not.toBeNull();
    const counts = Object.fromEntries(
      ENTRY_TEST_IDS.map((id) => [
        id,
        document.querySelectorAll(`[data-testid="${id}"]`).length,
      ])
    );
    expect(counts).toEqual({
      "nav-work-console": 1,
      "nav-workstreams": 1,
      "switcher-work-console": 1,
      "switcher-workstreams": 1,
      "settings-nav-code": 1,
    });
    expect(countWorkEntries()).toBe(5);
  });
});
