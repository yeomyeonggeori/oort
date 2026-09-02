// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageReminder } from "@momo/core/features/reminders/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ReminderDueWatcher } from "./ReminderDueWatcher";
import { REMINDER_WATERMARK_STORAGE_KEY } from "./watermark";

const WS = "00000000-0000-7000-8000-000000000001";
const NOW = 1_800_000_000_000;

const fire = vi.hoisted(() =>
  vi.fn(async (_reminder: unknown, _announced: unknown) => true)
);
const fireBacklog = vi.hoisted(() =>
  vi.fn(async (_count: unknown, _announced: unknown, _ids: unknown) => true)
);

vi.mock("./dueNotify", () => ({
  fireReminderNotification: (reminder: MessageReminder, announced: Set<string>) =>
    fire(reminder, announced),
  fireReminderBacklogNotification: (
    count: number,
    announced: Set<string>,
    ids: readonly string[]
  ) => fireBacklog(count, announced, ids),
}));

const refetch = vi.fn(async () => undefined);

const remindersState: {
  data: { reminders: MessageReminder[] } | undefined;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
} = {
  data: { reminders: [] },
  dataUpdatedAt: 1,
  refetch,
};

vi.mock("./useReminders", () => ({
  useReminders: () => remindersState,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function reminder(overrides: Partial<MessageReminder> = {}): MessageReminder {
  return {
    id: "r-old",
    workspaceId: WS,
    memberId: "m",
    channelId: "ch",
    messageId: "msg",
    dueAtMs: NOW - 60_000,
    createdAtMs: NOW - 120_000,
    messagePreview: "이미 지난 알림",
    ...overrides,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: "m",
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

async function mount(): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(
      createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(ReminderDueWatcher)
      )
    );
    await Promise.resolve();
  });
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  fire.mockClear();
  fireBacklog.mockClear();
  refetch.mockClear();
  localStorage.clear();
  remindersState.data = { reminders: [] };
  remindersState.dataUpdatedAt = 1;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.restoreAllMocks();
});

describe("ReminderDueWatcher", () => {
  it("on first look badges past-due rows and fires no arrival notification", async () => {
    remindersState.data = { reminders: [reminder()] };
    await mount();
    expect(fire).not.toHaveBeenCalled();
    expect(localStorage.getItem(REMINDER_WATERMARK_STORAGE_KEY)).toContain(
      String(NOW)
    );
  });

  it("on a later poll fires only rows that became due after the watermark", async () => {
    localStorage.setItem(
      REMINDER_WATERMARK_STORAGE_KEY,
      JSON.stringify({ [WS]: NOW - 30_000 })
    );
    remindersState.data = {
      reminders: [
        reminder({ id: "old", dueAtMs: NOW - 60_000 }),
        reminder({
          id: "fresh",
          dueAtMs: NOW - 10_000,
          messagePreview: "방금 기한",
        }),
      ],
    };
    await mount();
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({ id: "fresh" }),
      expect.any(Set)
    );
  });

  it("refetches as soon as the window becomes visible again", async () => {
    remindersState.data = { reminders: [reminder()] };
    await mount();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refetch).toHaveBeenCalled();
  });
});
