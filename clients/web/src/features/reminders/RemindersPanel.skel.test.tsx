// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageReminder } from "@momo/core/features/reminders/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@/features/workspace/useWorkspace";
import { RemindersPanel } from "./RemindersPanel";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const MSG = "00000000-0000-7000-8000-000000000301";
const NOW = 1_800_000_000_000;

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

vi.mock("@/features/emoji/useHoverNone", () => ({
  useHoverNone: () => true,
}));

const remindersState: {
  isLoading: boolean;
  isError: boolean;
  data: { reminders: MessageReminder[] } | undefined;
  dataUpdatedAt: number;
  refetch: () => void;
} = {
  isLoading: false,
  isError: false,
  data: { reminders: [] },
  dataUpdatedAt: NOW,
  refetch: () => undefined,
};

vi.mock("./useReminders", () => ({
  useReminders: () => remindersState,
  useReminderMutations: () => ({
    create: { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() },
    complete: { isPending: false, mutateAsync: vi.fn() },
    snooze: { isPending: false, mutateAsync: vi.fn() },
    remove: { isPending: false, mutateAsync: vi.fn() },
  }),
}));

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: {
        channels: [
          {
            id: CH,
            workspaceId: WS,
            kind: "public",
            name: "일반",
            muted: false,
          },
        ],
        dms: [],
      },
    }),
    useDirectory: () => ({
      directory: makeDirectory([]),
      isPending: false,
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function reminder(): MessageReminder {
  return {
    id: "r-1",
    workspaceId: WS,
    memberId: MEMBER_ID,
    channelId: CH,
    messageId: MSG,
    dueAtMs: NOW + 60_000,
    createdAtMs: NOW,
    messagePreview: "배포 점검 부탁드립니다",
    messageSeq: 12,
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

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      MemoryRouter,
      { initialEntries: ["/inbox?filter=reminders"] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/inbox",
          element: createElement(RemindersPanel),
        })
      )
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  remindersState.isLoading = false;
  remindersState.isError = false;
  remindersState.data = { reminders: [reminder()] };
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

describe("RemindersPanel skeleton host", () => {
  it("wraps the reminder list inside Skeleton (moving the list out turns this red)", async () => {
    const host = await mount();
    const list = host.querySelector('[data-testid="reminders-list"]');
    const skel = host.querySelector('[data-testid="skeleton"]');
    expect(list).not.toBeNull();
    expect(skel).not.toBeNull();
    expect(skel?.contains(list)).toBe(true);
    expect(skel?.getAttribute("data-ready")).toBe("true");
    expect(skel?.querySelector(".skel-content")).toBeTruthy();
  });

  it("stays data-ready=false while reminders are loading (ready={true} turns this red)", async () => {
    remindersState.isLoading = true;
    remindersState.data = undefined;
    const host = await mount();
    const skel = host.querySelector('[data-testid="skeleton"]');
    expect(skel).not.toBeNull();
    expect(skel?.getAttribute("data-ready")).toBe("false");
  });
});
