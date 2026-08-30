// @vitest-environment jsdom

import { act, createElement, useEffect, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresenceWrite, RosterMember } from "@momo/core/lib/api";
import {
  CUSTOM_STATUS_PRESETS,
  CUSTOM_STATUS_SAVING_LABEL,
  CUSTOM_STATUS_TEXT_PLACEHOLDER,
  customStatusFailureMessage,
} from "@momo/core/features/presence/customStatus";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { SetStatusDialog } from "./SetStatusDialog";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const NOW = 1_800_000_000_000;

const setPresenceStatus = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    setPresenceStatus: (workspaceId: string, write: PresenceWrite) =>
      setPresenceStatus(workspaceId, write) as Promise<unknown>,
  };
});

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  setPresenceStatus.mockReset();
  setPresenceStatus.mockResolvedValue({ status: "auto" });
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

function rosterMember(over: Partial<RosterMember> = {}): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "owner",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    presenceStatus: "auto",
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
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

function BoundDialog({ nowMs = NOW }: { nowMs?: number }) {
  const client = useQueryClient();
  const [, setTick] = useState(0);
  useEffect(() => {
    return client.getQueryCache().subscribe(() => {
      setTick((n) => n + 1);
    });
  }, [client]);
  const rows = client.getQueryData<RosterMember[]>(["roster", WS]);
  const selfMember = rows?.find((row) => row.id === MEMBER_ID) ?? null;
  return createElement(SetStatusDialog, {
    open: true,
    onOpenChange: () => undefined,
    workspaceId: WS,
    selfMemberId: MEMBER_ID,
    selfMember,
    opener: null,
    nowMs,
  });
}

function mountDialog(selfMember: RosterMember = rosterMember()): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["roster", WS], [selfMember]);
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
      createElement(BoundDialog)
    )
  );
  act(() => mountedRoot?.render(tree));
  return client;
}

describe("SetStatusDialog (#1889)", () => {
  it("lists the five A-42 preset copies", () => {
    mountDialog();
    const labels = CUSTOM_STATUS_PRESETS.map((preset) => preset.label);
    expect(labels).toEqual(["회의 중", "이동 중", "병가", "휴가", "재택"]);
    for (const preset of CUSTOM_STATUS_PRESETS) {
      const chip = document.querySelector(
        `[data-testid="set-status-preset-${preset.id}"]`
      );
      expect(chip).not.toBeNull();
      expect(chip?.textContent).toContain(preset.label);
    }
  });

  it("caps the text input at 80 characters", () => {
    mountDialog();
    const field = document.querySelector(
      '[data-testid="set-status-text"]'
    ) as HTMLTextAreaElement | null;
    expect(field).not.toBeNull();
    expect(field?.maxLength).toBe(80);
  });

  it("saves a preset as a full custom patch and keeps declared status", async () => {
    const client = mountDialog(rosterMember({ presenceStatus: "dnd" }));
    await act(async () => {
      document
        .querySelector('[data-testid="set-status-preset-meeting"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('[data-testid="set-status-save"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(setPresenceStatus).toHaveBeenCalledTimes(1);
    });
    expect(setPresenceStatus).toHaveBeenCalledWith(WS, {
      status: "dnd",
      statusEmoji: "📅",
      statusText: "회의 중",
      statusExpiresAtMs: null,
    });
    const roster = client.getQueryData<RosterMember[]>(["roster", WS]);
    expect(roster?.[0]?.presenceStatus).toBe("dnd");
    expect(roster?.[0]?.statusText).toBe("회의 중");
    expect(roster?.[0]?.statusEmoji).toBe("📅");
  });

  it("clears with JSON-null fields and leaves declared presence", async () => {
    const client = mountDialog(
      rosterMember({
        presenceStatus: "away",
        statusEmoji: "🏠",
        statusText: "재택",
      })
    );
    await act(async () => {
      document
        .querySelector('[data-testid="set-status-clear"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(setPresenceStatus).toHaveBeenCalledTimes(1);
    });
    expect(setPresenceStatus).toHaveBeenCalledWith(WS, {
      status: "away",
      statusEmoji: null,
      statusText: null,
      statusExpiresAtMs: null,
    });
    const roster = client.getQueryData<RosterMember[]>(["roster", WS]);
    expect(roster?.[0]?.presenceStatus).toBe("away");
    expect(roster?.[0]?.statusEmoji).toBeUndefined();
    expect(roster?.[0]?.statusText).toBeUndefined();
  });

  it("keeps the error banner and the draft after a PUT 500 rollback", async () => {
    setPresenceStatus.mockRejectedValue(new Error("presence write failed"));
    mountDialog(
      rosterMember({
        presenceStatus: "away",
        statusEmoji: "🏠",
        statusText: "재택",
      })
    );
    const field = document.querySelector(
      '[data-testid="set-status-text"]'
    ) as HTMLTextAreaElement | null;
    expect(field).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setter?.call(field, "초안");
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('[data-testid="set-status-save"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="set-status-error"]')
      ).not.toBeNull();
    });
    expect(
      document.querySelector('[data-testid="set-status-error"]')?.textContent
    ).toContain(customStatusFailureMessage());
    expect(
      (document.querySelector('[data-testid="set-status-text"]') as HTMLTextAreaElement)
        .value
    ).toBe("초안");
    expect(document.querySelector('[data-testid="set-status-dialog"]')).not.toBeNull();
  });

  it("does not revive an expired status into the form", () => {
    mountDialog(
      rosterMember({
        statusEmoji: "📅",
        statusText: "회의 중",
        statusExpiresAtMs: NOW - 3 * 60 * 60_000,
      })
    );
    const field = document.querySelector(
      '[data-testid="set-status-text"]'
    ) as HTMLTextAreaElement | null;
    expect(field?.value).toBe("");
    const emoji = document.querySelector('[data-testid="set-status-emoji"]');
    expect(emoji?.textContent).not.toContain("📅");
    const expiry = document.querySelector(
      '[data-testid="set-status-expiry"]'
    ) as HTMLSelectElement | null;
    expect(expiry?.value).toBe("none");
  });

  it("disables clear when there is nothing stored to clear", () => {
    mountDialog();
    const clear = document.querySelector(
      '[data-testid="set-status-clear"]'
    ) as HTMLButtonElement | null;
    expect(clear?.disabled).toBe(true);
  });

  it("marks the text field as optional and shows a placeholder", () => {
    mountDialog();
    const label = document.querySelector(`label[for]`);
    const field = document.querySelector(
      '[data-testid="set-status-text"]'
    ) as HTMLTextAreaElement | null;
    expect(document.body.textContent).toContain("선택");
    expect(field?.placeholder).toBe(CUSTOM_STATUS_TEXT_PLACEHOLDER);
    expect(label).not.toBeNull();
  });

  it("names the save button as in progress while the write is in flight", async () => {
    let release: ((value: unknown) => void) | undefined;
    setPresenceStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    mountDialog();
    await act(async () => {
      document
        .querySelector('[data-testid="set-status-preset-meeting"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('[data-testid="set-status-save"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="set-status-save"]')?.textContent
      ).toBe(CUSTOM_STATUS_SAVING_LABEL);
    });
    await act(async () => {
      release?.({ status: "auto" });
    });
  });
});
