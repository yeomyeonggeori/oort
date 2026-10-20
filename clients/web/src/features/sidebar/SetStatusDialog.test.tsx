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

vi.mock("@/features/common/useOffline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/common/useOffline")>()),
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
  HTMLElement.prototype.scrollIntoView = () => undefined;
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
    ) as HTMLInputElement | null;
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
      statusExpiresAtMs: NOW + 60 * 60_000,
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
    ) as HTMLInputElement | null;
    expect(field).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
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
      (document.querySelector('[data-testid="set-status-text"]') as HTMLInputElement)
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
    ) as HTMLInputElement | null;
    expect(field?.value).toBe("");
    const emoji = document.querySelector('[data-testid="set-status-emoji"]');
    expect(emoji?.textContent).not.toContain("📅");
    const expiry = document.querySelector(
      '[data-testid="set-status-expiry"]'
    ) as HTMLButtonElement | null;
    expect(expiry?.dataset.value).toBe("none");
    expect(expiry?.textContent).toBe("지우지 않음");
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
    ) as HTMLInputElement | null;
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

const expiryTrigger = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="set-status-expiry"]')!;
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const optionEls = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

function openExpiry() {
  if (listbox()) return;
  act(() => {
    expiryTrigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function chooseExpiry(value: string) {
  openExpiry();
  const option = optionEls().find((o) => o.dataset.value === value)!;
  act(() => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function pressKey(key: string) {
  const target = listbox() ?? expiryTrigger();
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

async function clickTestId(testId: string) {
  await act(async () => {
    document
      .querySelector(`[data-testid="${testId}"]`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("SetStatusDialog 만료 칸은 앱이 그린 listbox (#4123)", () => {
  it("네이티브 select 가 아니고 combobox·listbox·option 의미를 갖는다", () => {
    mountDialog();
    expect(expiryTrigger().tagName).toBe("BUTTON");
    expect(expiryTrigger().getAttribute("role")).toBe("combobox");
    expect(expiryTrigger().getAttribute("aria-haspopup")).toBe("listbox");
    // 「만료」 라벨이 칸과 목록의 이름이다.
    const labelId = expiryTrigger().getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)?.textContent).toBe("만료");
    openExpiry();
    expect(expiryTrigger().getAttribute("aria-expanded")).toBe("true");
    expect(listbox()!.getAttribute("aria-labelledby")).toBe(labelId);
    expect(optionEls().map((o) => o.dataset.value)).toEqual([
      "none",
      "30m",
      "1h",
      "today",
      "custom",
    ]);
    expect(optionEls().filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.dataset.value)).toEqual(["none"]);
  });

  it("30분을 고르면 저장이 지금+30분 만료로 나간다", async () => {
    mountDialog();
    await clickTestId("set-status-preset-meeting");
    chooseExpiry("30m");
    expect(listbox()).toBeNull();
    expect(expiryTrigger().textContent).toBe("30분");
    await clickTestId("set-status-save");
    await vi.waitFor(() => expect(setPresenceStatus).toHaveBeenCalledTimes(1));
    expect(setPresenceStatus).toHaveBeenCalledWith(WS, {
      status: "auto",
      statusEmoji: "📅",
      statusText: "회의 중",
      statusExpiresAtMs: NOW + 30 * 60_000,
    });
  });

  it("키보드: ↓ 로 열고 ↓ Enter 로 고르면 1시간이 된다", () => {
    mountDialog();
    pressKey("ArrowDown");
    expect(listbox()).not.toBeNull();
    pressKey("ArrowDown");
    pressKey("ArrowDown");
    pressKey("Enter");
    expect(listbox()).toBeNull();
    expect(expiryTrigger().dataset.value).toBe("1h");
  });

  it("Esc 는 목록만 닫고 선택은 그대로다", () => {
    mountDialog();
    openExpiry();
    pressKey("Escape");
    expect(listbox()).toBeNull();
    expect(expiryTrigger().dataset.value).toBe("none");
  });

  it("「시각 고르기」를 고르면 날짜·시간 칸이 나타난다", () => {
    mountDialog();
    expect(document.querySelector('[data-testid="set-status-custom-date"]')).toBeNull();
    chooseExpiry("custom");
    expect(document.querySelector('[data-testid="set-status-custom-date"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="set-status-custom-time"]')).not.toBeNull();
  });

  it("저장 중에는 칸이 잠기고 열리지 않는다", async () => {
    setPresenceStatus.mockImplementation(() => new Promise(() => undefined));
    mountDialog();
    await clickTestId("set-status-preset-meeting");
    await clickTestId("set-status-save");
    await vi.waitFor(() => expect(expiryTrigger().disabled).toBe(true));
    openExpiry();
    expect(listbox()).toBeNull();
  });
});

function typeText(value: string) {
  const field = document.querySelector<HTMLInputElement>('[data-testid="set-status-text"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const presetRows = () => document.querySelector('[data-testid="set-status-presets"]');

describe("SetStatusDialog 추천 상태는 이모지·글·만료를 함께 채운다 (#4140)", () => {
  it.each(CUSTOM_STATUS_PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s 를 고르면 emoji·text·expires 세 값이 저장 payload 에 실린다",
    async (_id, preset) => {
      mountDialog();
      await clickTestId(`set-status-preset-${preset.id}`);
      await clickTestId("set-status-save");
      await vi.waitFor(() => expect(setPresenceStatus).toHaveBeenCalledTimes(1));
      const expected =
        preset.expiry === "none"
          ? null
          : preset.expiry === "30m"
            ? NOW + 30 * 60_000
            : preset.expiry === "1h"
              ? NOW + 60 * 60_000
              : (() => {
                  const end = new Date(NOW);
                  end.setHours(23, 59, 59, 999);
                  return end.getTime();
                })();
      expect(setPresenceStatus).toHaveBeenCalledWith(WS, {
        status: "auto",
        statusEmoji: preset.emoji,
        statusText: preset.label,
        statusExpiresAtMs: expected,
      });
    }
  );

  it("행에 이모지·이름·기본 기한이 보이고 만료 칸이 같이 바뀐다", async () => {
    mountDialog();
    const row = document.querySelector('[data-testid="set-status-preset-meeting"]')!;
    expect(row.textContent).toContain("📅");
    expect(row.textContent).toContain("회의 중");
    expect(row.textContent).toContain("1시간");
    await clickTestId("set-status-preset-meeting");
    expect(expiryTrigger().dataset.value).toBe("1h");
  });

  it("고르면 포커스가 글 칸으로 간다", async () => {
    mountDialog();
    await clickTestId("set-status-preset-commute");
    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="set-status-text"]')
    );
  });

  it("글을 쓰기 시작하면 추천 목록이 접히고, 비우면 다시 펼쳐진다", () => {
    mountDialog();
    expect(presetRows()).not.toBeNull();
    typeText("집중");
    expect(presetRows()).toBeNull();
    typeText("");
    expect(presetRows()).not.toBeNull();
  });

  it("지우기 단추는 글·이모지를 비우고 목록을 펼치며 글 칸에 포커스를 둔다", async () => {
    mountDialog();
    expect(document.querySelector('[data-testid="set-status-text-clear"]')).toBeNull();
    await clickTestId("set-status-preset-sick");
    expect(presetRows()).toBeNull();
    await clickTestId("set-status-text-clear");
    const field = document.querySelector<HTMLInputElement>('[data-testid="set-status-text"]')!;
    expect(field.value).toBe("");
    expect(document.querySelector('[data-testid="set-status-emoji"]')?.textContent).toBe("");
    expect(presetRows()).not.toBeNull();
    expect(document.activeElement).toBe(field);
  });
});

describe("SetStatusDialog 이모지 칸은 글 칸 안 왼쪽의 팝오버다 (#4140)", () => {
  it("단추가 글 칸과 같은 그릇 안에 있다", () => {
    mountDialog();
    const button = document.querySelector('[data-testid="set-status-emoji"]')!;
    const field = document.querySelector('[data-testid="set-status-text"]')!;
    expect(button.parentElement).toBe(field.parentElement);
    expect(button.nextElementSibling).toBe(field);
  });

  it("다이얼로그 위에 다이얼로그를 겹치지 않고 팝오버로 열린다", async () => {
    mountDialog();
    await clickTestId("set-status-emoji");
    const picker = document.querySelector<HTMLElement>(
      '[data-testid="set-status-emoji-picker"]'
    );
    expect(picker).not.toBeNull();
    // 팝오버는 Radix popper 가 data-side 를 단다. 겹친 Dialog 라면 data-side 가 없고 스크림이 하나 더 생긴다.
    expect(picker!.dataset.side).toBe("bottom");
    expect(document.querySelectorAll('[data-overlay-layer="scrim"]')).toHaveLength(1);
    expect(picker!.closest('[data-testid="set-status-dialog"]')).toBeNull();
  });

  it("고른 이모지가 단추에 보이고 포커스는 글 칸으로 돌아간다", async () => {
    mountDialog();
    await clickTestId("set-status-emoji");
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid^="picker-status-"]')
      ).not.toBeNull(),
      { timeout: 5000 }
    );
    const item = document.querySelector<HTMLElement>('[data-testid^="picker-status-"]')!;
    const glyph = item.dataset.testid!.replace("picker-status-", "");
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      document.querySelector('[data-testid="set-status-emoji"]')?.textContent
    ).toBe(glyph);
    expect(document.querySelector('[data-testid="set-status-emoji-picker"]')).toBeNull();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector('[data-testid="set-status-text"]')
      )
    );
  });
});
