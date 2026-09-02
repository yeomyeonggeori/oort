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

const hoverNone = vi.hoisted(() => ({ current: true }));

vi.mock("@/features/emoji/useHoverNone", () => ({
  useHoverNone: () => hoverNone.current,
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

const complete = vi.fn();
const snooze = vi.fn();
const remove = vi.fn();

vi.mock("./useReminders", () => ({
  useReminders: () => remindersState,
  useReminderMutations: () => ({
    create: { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() },
    complete: {
      isPending: false,
      mutateAsync: (...args: unknown[]) => complete(...args),
    },
    snooze: {
      isPending: false,
      mutateAsync: (...args: unknown[]) => snooze(...args),
    },
    remove: {
      isPending: false,
      mutateAsync: (...args: unknown[]) => remove(...args),
    },
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
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function reminder(overrides: Partial<MessageReminder> = {}): MessageReminder {
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
        }),
        createElement(Route, {
          path: "/c/:channelId",
          element: createElement("div", { "data-testid": "channel-probe" }),
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
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type: string, init?: MouseEventInit) {
        super(type, init);
      }
    } as unknown as typeof PointerEvent;
  }
});

function stubFocusVisible(el: HTMLElement, visible: boolean) {
  const proto = HTMLElement.prototype.matches;
  return vi.spyOn(el, "matches").mockImplementation(function (
    this: HTMLElement,
    selectors: string
  ) {
    if (selectors === ":focus-visible") {
      return visible && document.activeElement === this;
    }
    return proto.call(this, selectors);
  });
}

beforeEach(() => {
  hoverNone.current = true;
  remindersState.isLoading = false;
  remindersState.isError = false;
  remindersState.data = { reminders: [] };
  complete.mockReset().mockResolvedValue({});
  snooze.mockReset().mockResolvedValue({});
  remove.mockReset().mockResolvedValue(undefined);
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

describe("RemindersPanel", () => {
  it("invites a first reminder when the list is empty", async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="reminders-empty"]')?.textContent).toContain(
      "아직 나중에 볼 메시지가 없습니다"
    );
    expect(host.textContent).toContain("메시지 메뉴에서 나중에 알림을 누르면");
  });

  it("shows a height-preserving loading state", async () => {
    remindersState.isLoading = true;
    remindersState.data = undefined;
    const host = await mount();
    expect(host.querySelectorAll('[data-testid="skeleton-row"]').length).toBeGreaterThan(
      0
    );
  });

  it("says what happened and offers retry on error", async () => {
    remindersState.isError = true;
    remindersState.data = undefined;
    const host = await mount();
    expect(host.querySelector('[data-testid="reminders-error"]')?.textContent).toContain(
      "나중에 볼 메시지를 불러오지 못했습니다"
    );
  });

  it("jumps a row to the source message path", async () => {
    remindersState.data = { reminders: [reminder()] };
    const host = await mount();
    const link = host.querySelector(
      '[data-testid="reminder-row-link"]'
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toContain(`/c/${CH}`);
    expect(link?.getAttribute("href")).toContain(`msg=${MSG}`);
    expect(host.querySelector('[data-testid="reminder-row-preview"]')?.textContent).toBe(
      "배포 점검 부탁드립니다"
    );
    expect(host.querySelector('[data-testid="reminder-row-channel"]')?.textContent).toBe(
      "일반"
    );
  });

  it("highlights an overdue row and completes it from the row action", async () => {
    remindersState.data = {
      reminders: [reminder({ dueAtMs: NOW - 60_000 })],
    };
    const host = await mount();
    const row = host.querySelector('[data-testid="reminder-row"]');
    expect(row?.getAttribute("data-due")).toBe("overdue");
    expect(host.querySelector('[data-testid="reminder-row-due"]')?.textContent).toBe(
      "기한 지남"
    );
    expect(row?.className).not.toContain("bg-warn-soft");
    expect(
      host.querySelector('[data-testid="reminder-row-due"]')?.className
    ).toContain("bg-warn-soft");
    const completeButton = host.querySelector(
      '[data-testid="reminder-complete"]'
    ) as HTMLButtonElement;
    await act(async () => {
      completeButton.click();
    });
    expect(complete).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="reminder-complete-dialog"]')).not.toBeNull();
    const commit = document.querySelector(
      '[data-testid="reminder-complete-commit"]'
    ) as HTMLButtonElement;
    await act(async () => {
      commit.click();
    });
    expect(complete).toHaveBeenCalledWith("r-1");
  });

  it("keeps the delete dialog open and names the verb when DELETE fails", async () => {
    remove.mockRejectedValueOnce({ status: 500 });
    remindersState.data = { reminders: [reminder()] };
    const host = await mount();
    const menu = host.querySelector(
      '[data-testid="reminder-row-menu"]'
    ) as HTMLButtonElement;
    await act(async () => {
      menu.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      );
      menu.click();
    });
    const del = await vi.waitFor(() => {
      const item = document.querySelector(
        '[data-testid="reminder-row-delete"]'
      ) as HTMLElement | null;
      expect(item).not.toBeNull();
      return item!;
    });
    await act(async () => {
      del.click();
    });
    expect(document.querySelector('[data-testid="reminder-delete-dialog"]')).not.toBeNull();
    const commit = document.querySelector(
      '[data-testid="reminder-delete-commit"]'
    ) as HTMLButtonElement;
    await act(async () => {
      commit.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="reminder-delete-dialog"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="reminder-delete-error"]')?.textContent
    ).toContain("알림을 지우지 못했습니다");
    expect(
      document.querySelector('[data-testid="reminder-delete-error"]')?.textContent
    ).not.toContain("저장하지 못했습니다");
  });

  it("mounts ⋯ when the row is keyboard-focused so 지우기 is reachable", async () => {
    hoverNone.current = false;
    remindersState.data = { reminders: [reminder()] };
    const host = await mount();
    expect(host.querySelector('[data-testid="reminder-row-menu"]')).toBeNull();
    const link = host.querySelector(
      '[data-testid="reminder-row-link"]'
    ) as HTMLAnchorElement;
    const spy = stubFocusVisible(link, true);
    await act(async () => {
      link.focus();
      link.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="reminder-row-menu"]')).not.toBeNull();
    spy.mockRestore();
  });

  it("does not show a UUID fragment when the channel is unresolved", async () => {
    remindersState.data = {
      reminders: [
        reminder({ channelId: "00000000-0000-7000-8000-000000000999" }),
      ],
    };
    const host = await mount();
    expect(host.querySelector('[data-testid="reminder-row-channel"]')?.textContent).toBe(
      "알 수 없는 채널"
    );
  });
});
