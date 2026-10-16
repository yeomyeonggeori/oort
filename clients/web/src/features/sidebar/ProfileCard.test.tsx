// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresenceWrite, RosterMember } from "@momo/core/lib/api";
import { PRESENCE_WRITE_FAILED } from "@momo/core/features/presence/model";
import type { NotificationRulesPatch } from "@momo/core/features/settings/notificationRules";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AddWorkspaceOpenContext } from "@/features/workspace/useAddWorkspace";
import { ProfileCard } from "./ProfileCard";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

// 방해 금지 기한 시험(#2899)은 쓰기 두 길을 모두 감시한다: 프로필 메뉴는 `PUT /presence`
// 하나로만 쓰고, 알림 규칙(`notification-rules`)은 PUT 도 PATCH 도 보내지 않아야 한다.
// 서버가 방해 금지를 고를 때 같은 트랜잭션에서 일시 중지를 묶어 켜기 때문이다.
const setPresenceStatus = vi.hoisted(() => vi.fn());
const putNotificationRules = vi.hoisted(() => vi.fn());
const patchNotificationRules = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    setPresenceStatus: (workspaceId: string, write: PresenceWrite) =>
      setPresenceStatus(workspaceId, write) as Promise<unknown>,
  };
});

vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@momo/core/features/settings/notificationRules")
    >();
  return {
    ...actual,
    putNotificationRules: (...args: unknown[]) => putNotificationRules(...args),
    patchNotificationRules: (workspaceId: string, patch: NotificationRulesPatch) =>
      patchNotificationRules(workspaceId, patch),
  };
});

let lastClient: QueryClient | null = null;

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
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
  setPresenceStatus.mockReset();
  setPresenceStatus.mockResolvedValue({ status: "dnd" });
  putNotificationRules.mockReset();
  patchNotificationRules.mockReset();
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
  vi.useRealTimers();
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

function sessionValue(logout: () => void): SessionContextValue {
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
    logout,
    replaceSessionMember: () => undefined,
  };
}

function mountCard(
  logout: () => void = () => undefined,
  selfMember: RosterMember = rosterMember(),
  extra: { workspaceName?: string; compact?: boolean; selfName?: string } = {}
): HTMLElement {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  lastClient = client;
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue(logout) },
      createElement(
        MemoryRouter,
        null,
        createElement(
          AddWorkspaceOpenContext.Provider,
          { value: () => undefined },
          createElement(ProfileCard, {
            workspaceId: WS,
            selfMemberId: MEMBER_ID,
            selfMember,
            selfName: extra.selfName ?? "곽성재",
            connected: true,
            workspaceName: extra.workspaceName,
            compact: extra.compact,
          })
        )
      )
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

async function openMenu(): Promise<HTMLElement> {
  const trigger = document.querySelector(
    '[data-testid="profile-card"]'
  ) as HTMLButtonElement | null;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
    );
    trigger!.click();
  });
  return vi.waitFor(() => {
    const menu = document.querySelector('[data-testid="profile-card-menu"]');
    expect(menu).not.toBeNull();
    return menu as HTMLElement;
  });
}

function menuRowIds(): string[] {
  return [...document.querySelectorAll("[data-testid]")]
    .map((node) => node.getAttribute("data-testid"))
    .filter((id): id is string =>
      id === "presence-option-auto" ||
      id === "presence-option-away" ||
      id === "presence-option-dnd" ||
      id === "profile-set-status" ||
      id === "profile-add-workspace" ||
      id === "nav-settings" ||
      id === "profile-logout"
    );
}

async function pressKey(key: string) {
  const target = document.activeElement ?? document.body;
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ProfileCard 로그아웃 (#1858)", () => {
  it("메뉴를 열면 기존 항목 뒤에 profile-logout 이 선다", async () => {
    mountCard();
    const menu = await openMenu();
    expect(menu.querySelector('[data-testid="presence-option-auto"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="presence-option-away"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="presence-option-dnd"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="profile-add-workspace"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="nav-settings"]')).not.toBeNull();
    const logoutItem = menu.querySelector('[data-testid="profile-logout"]');
    expect(logoutItem).not.toBeNull();
    expect(logoutItem?.textContent).toContain("로그아웃");
    expect(menu.querySelector('[data-testid="profile-set-status"]')).not.toBeNull();
    expect(menuRowIds()).toEqual([
      "presence-option-auto",
      "presence-option-away",
      "presence-option-dnd",
      "profile-set-status",
      "profile-add-workspace",
      "nav-settings",
      "profile-logout",
    ]);
  });

  async function chooseLogout(): Promise<HTMLElement> {
    await openMenu();
    const logoutItem = document.querySelector(
      '[data-testid="profile-logout"]'
    ) as HTMLElement | null;
    expect(logoutItem).not.toBeNull();
    await act(async () => {
      logoutItem!.click();
    });
    return vi.waitFor(() => {
      const dialog = document.querySelector(
        '[data-testid="profile-logout-confirm"]'
      );
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain(
        "로그아웃하면 이 기기에 쓰다 만 초안이 지워집니다."
      );
      expect(dialog?.textContent).toContain("로그아웃할까요?");
      return dialog as HTMLElement;
    });
  }

  it("로그아웃을 고르면 확인만 서고 logout 은 부르지 않는다", async () => {
    const logout = vi.fn();
    mountCard(logout);
    await chooseLogout();
    expect(logout).toHaveBeenCalledTimes(0);
  });

  it("확인을 누르면 logout 을 한 번 부른다", async () => {
    const logout = vi.fn();
    mountCard(logout);
    await chooseLogout();
    const confirm = document.querySelector(
      '[data-testid="profile-logout-confirm-action"]'
    ) as HTMLElement | null;
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain("로그아웃");
    await act(async () => {
      confirm!.click();
    });
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("취소를 누르면 닫히고 logout 은 부르지 않는다", async () => {
    const logout = vi.fn();
    mountCard(logout);
    await chooseLogout();
    const cancel = document.querySelector(
      '[data-testid="profile-logout-cancel"]'
    ) as HTMLElement | null;
    expect(cancel).not.toBeNull();
    expect(cancel?.textContent).toContain("취소");
    await act(async () => {
      cancel!.click();
    });
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="profile-logout-confirm"]')
      ).toBeNull();
    });
    expect(logout).toHaveBeenCalledTimes(0);
  });

  it("Arrow 와 Enter 로 로그아웃에 도달해 확인을 연다", async () => {
    const logout = vi.fn();
    mountCard(logout);
    await openMenu();
    const seen: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      const id = document.activeElement?.getAttribute("data-testid");
      if (id) seen.push(id);
      if (id === "profile-logout") break;
      await pressKey("ArrowDown");
    }
    expect(seen).toContain("presence-option-auto");
    expect(seen).toContain("nav-settings");
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "profile-logout"
    );
    await pressKey("Enter");
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="profile-logout-confirm"]')
      ).not.toBeNull();
    });
    expect(logout).toHaveBeenCalledTimes(0);
    const confirm = document.querySelector(
      '[data-testid="profile-logout-confirm-action"]'
    ) as HTMLElement | null;
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm!.click();
    });
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

describe("ProfileCard 목록 끝 한 줄 (#3574)", () => {
  it("아바타·굵은 이름·둘째 줄(워크스페이스)이 한 단추 안에 선다", () => {
    mountCard(() => undefined, rosterMember(), { workspaceName: "여명거리" });
    const trigger = document.querySelector('[data-testid="profile-card"]');
    const name = trigger?.querySelector('[data-testid="self-name"]');
    expect(name?.textContent).toBe("곽성재");
    expect(name?.className).toContain("font-semibold");
    expect(trigger?.querySelector('[data-testid="presence-control"]')).not.toBeNull();
    expect(
      trigger?.querySelector('[data-testid="self-subline"]')?.textContent
    ).toBe("여명거리");
    expect(trigger?.querySelector('[data-testid="custom-status"]')).toBeNull();
  });

  it("상태 메시지가 있으면 워크스페이스 이름 대신 상태가 둘째 줄이다", () => {
    mountCard(
      () => undefined,
      rosterMember({ statusEmoji: "🏝️", statusText: "휴가 중" }),
      { workspaceName: "여명거리" }
    );
    const trigger = document.querySelector('[data-testid="profile-card"]');
    expect(trigger?.querySelector('[data-testid="custom-status-text"]')?.textContent).toBe(
      "휴가 중"
    );
    expect(trigger?.querySelector('[data-testid="self-subline"]')).toBeNull();
  });

  it("워크스페이스 이름이 아직 없으면 둘째 줄을 그리지 않는다", () => {
    mountCard(() => undefined, rosterMember());
    expect(document.querySelector('[data-testid="self-subline"]')).toBeNull();
  });

  it("긴 이름과 상태는 말줄임이고 단추 안에서 넘치지 않는다", () => {
    mountCard(
      () => undefined,
      rosterMember({ statusText: "아주 긴 상태 메시지 ".repeat(8) }),
      { selfName: "Alexandria Montgomery-Wellington", workspaceName: "여명거리" }
    );
    const trigger = document.querySelector('[data-testid="profile-card"]');
    expect(trigger?.className).toContain("min-w-0");
    expect(trigger?.querySelector('[data-testid="self-name"]')?.className).toContain(
      "truncate"
    );
    expect(
      trigger?.querySelector('[data-testid="custom-status-text"]')?.className
    ).toContain("truncate");
  });

  it("클릭하면 프로필·상태 메뉴가 열린다", async () => {
    mountCard(() => undefined, rosterMember(), { workspaceName: "여명거리" });
    const menu = await openMenu();
    expect(menu.querySelector('[data-testid="presence-option-dnd"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="profile-set-status"]')).not.toBeNull();
  });

  it("접힘(compact)은 아바타만 서고 이름·둘째 줄은 보이지 않는다", () => {
    mountCard(
      () => undefined,
      rosterMember({ statusEmoji: "🏝️", statusText: "휴가 중" }),
      { workspaceName: "여명거리", compact: true }
    );
    const trigger = document.querySelector('[data-testid="profile-card"]');
    expect(trigger?.querySelector('[data-testid="presence-control"]')).not.toBeNull();
    const textWrap = trigger?.querySelector('[data-testid="self-name"]')?.parentElement;
    expect(textWrap?.className).toContain("hidden");
    expect(trigger?.getAttribute("aria-label")).toContain("곽성재");
    expect(trigger?.getAttribute("aria-label")).toContain("휴가 중");
  });

  it("DND는 점으로 말한다(둘째 줄이 아니라 아바타 배지)", () => {
    mountCard(() => undefined, rosterMember({ presenceStatus: "dnd" }), {
      workspaceName: "여명거리",
    });
    expect(
      document
        .querySelector('[data-testid="presence-control"]')
        ?.getAttribute("data-effective")
    ).toBe("dnd");
  });
});

describe("ProfileCard 커스텀 상태 (#1889)", () => {
  it("shows the emoji and the text on the card's second line, plus title and menu head", async () => {
    mountCard(
      () => undefined,
      rosterMember({
        presenceStatus: "away",
        statusEmoji: "📅",
        statusText: "회의 중",
      })
    );
    expect(document.querySelector('[data-testid="presence-control"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="presence-control"]')?.getAttribute(
        "data-effective"
      )
    ).toBe("away");
    expect(document.querySelector('[data-testid="custom-status-emoji"]')?.textContent).toBe(
      "📅"
    );
    expect(document.querySelector('[data-testid="custom-status-text"]')?.textContent).toBe(
      "회의 중"
    );
    const trigger = document.querySelector('[data-testid="profile-card"]');
    expect(trigger?.getAttribute("aria-label")).toContain("자리 비움");
    expect(trigger?.getAttribute("aria-label")).toContain("회의 중");
    expect(trigger?.getAttribute("aria-label")).not.toContain("📅");
    const menu = await openMenu();
    expect(
      menu.querySelector('[data-testid="profile-card-status-head"]')?.textContent
    ).toContain("회의 중");
  });

  it("keeps an emoji-only status in the card's accessible name", () => {
    mountCard(
      () => undefined,
      rosterMember({
        presenceStatus: "auto",
        statusEmoji: "🤒",
      })
    );
    const trigger = document.querySelector('[data-testid="profile-card"]');
    expect(document.querySelector('[data-testid="custom-status-emoji"]')?.textContent).toBe(
      "🤒"
    );
    expect(trigger?.getAttribute("aria-label")).toContain("🤒");
  });

  it("shows a text-only status as the second line (#1889 R2-M2, #3574)", async () => {
    mountCard(
      () => undefined,
      rosterMember({
        presenceStatus: "auto",
        statusText: "고객사 미팅",
      })
    );
    const trigger = document.querySelector('[data-testid="profile-card"]');
    expect(document.querySelector('[data-testid="custom-status-emoji"]')).toBeNull();
    expect(document.querySelector('[data-testid="custom-status-text"]')?.textContent).toBe(
      "고객사 미팅"
    );
    expect(trigger?.getAttribute("aria-label")).toContain("고객사 미팅");
    const menu = await openMenu();
    expect(
      menu.querySelector('[data-testid="profile-card-status-head"]')?.textContent
    ).toContain("고객사 미팅");
  });

  it("caps the open menu so a long status cannot set its width (#1889 R2-B1)", async () => {
    mountCard(
      () => undefined,
      rosterMember({
        presenceStatus: "auto",
        statusEmoji: "📅",
        statusText:
          "3분기 게이트웨이 점검 중, 오후 6시 이후 응답이 늦습니다. 급하면 전화 주세요, 이 채널로만 남겨 주세요. urgent only 내일 6시",
      })
    );
    const menu = await openMenu();
    expect(menu.className).toContain("max-w-pane-sm");
    expect(
      menu.querySelector('[data-testid="profile-card-status-head"]')?.className
    ).toMatch(/break-words/);
  });

  it("hides a custom status when the clock crosses expiry while mounted", async () => {
    vi.useFakeTimers();
    const start = 1_800_000_000_000;
    vi.setSystemTime(start);
    mountCard(
      () => undefined,
      rosterMember({
        presenceStatus: "auto",
        statusEmoji: "📅",
        statusText: "회의 중",
        statusExpiresAtMs: start + 5_000,
      })
    );
    expect(document.querySelector('[data-testid="custom-status"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(document.querySelector('[data-testid="custom-status"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(document.querySelector('[data-testid="custom-status"]')).toBeNull();
  });

  it("does not draw an expired custom status", () => {
    mountCard(
      () => undefined,
      rosterMember({
        presenceStatus: "auto",
        statusEmoji: "📅",
        statusText: "회의 중",
        statusExpiresAtMs: 1,
      })
    );
    expect(document.querySelector('[data-testid="custom-status"]')).toBeNull();
    expect(document.querySelector('[data-testid="presence-control"]')).not.toBeNull();
  });

  it("opens the status dialog from the menu without dropping presence radios", async () => {
    mountCard();
    const menu = await openMenu();
    expect(menu.querySelector('[data-testid="presence-option-auto"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="presence-option-away"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="presence-option-dnd"]')).not.toBeNull();
    await act(async () => {
      menu
        .querySelector('[data-testid="profile-set-status"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="set-status-dialog"]')).not.toBeNull();
    });
  });
});

// ADR-0204 D2 (#2899): 방해 금지도 기한을 고르고 나서야 켜진다. 예전에는 항목 하나가 곧바로
// `PUT /presence {status: "dnd"}` 를 보냈고, 기한이 없는 그 켜짐이 서버에서 알림 일시 중지를
// 묶어 켠 채 15일 동안 풀리지 않았다. 지금은 항목이 쓰지 않고 기한 다이얼로그를 열며, 쓰기는
// 거기서 `{status: "dnd", dndUntilMs}` 하나로 난다.
describe("ProfileCard 방해 금지 기한 (#2899)", () => {
  const NOW = new Date(2026, 9, 16, 21, 7, 0, 0).getTime();
  const at = (day: number, hour: number, minute = 0) =>
    new Date(2026, 9, day, hour, minute, 0, 0).getTime();
  const RULES_KEY = ["settings", "notification-rules", WS];
  const ROSTER_KEY = ["roster", WS];

  const q = <T extends HTMLElement>(testId: string) =>
    document.querySelector(`[data-testid="${testId}"]`) as T | null;

  /** `Date.now()` 만 고정한다. 타이머는 진짜라 Radix·React 스케줄이 그대로 돈다. */
  function freezeClock() {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  }

  /** 가짜 시계 아래의 `vi.waitFor` 는 한 번 돌 때마다 시계를 50ms 밀므로 누르기 직전에 되돌린다. */
  async function confirmAtNow() {
    vi.setSystemTime(NOW);
    await clickTestId("pause-until-confirm");
  }

  async function clickTestId(testId: string) {
    await act(async () => {
      q(testId)!.click();
    });
  }

  function chooseUntil(value: string) {
    const select = q<HTMLSelectElement>("pause-until-select")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        select,
        value
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  /** 카드를 세우고 명부·규칙 캐시를 씨앗으로 심는다(무효화를 잴 수 있게 관찰자 없이). */
  function mountSeeded(selfMember: RosterMember) {
    mountCard(() => undefined, selfMember);
    lastClient!.setQueryData(ROSTER_KEY, [selfMember]);
    lastClient!.setQueryData(RULES_KEY, { dnd: false, mentionOverridesMute: false });
    expect(lastClient!.getQueryState(RULES_KEY)?.isInvalidated).toBe(false);
  }

  async function openDndDialog() {
    await openMenu();
    await clickTestId("presence-option-dnd");
    await vi.waitFor(() => expect(q("pause-until-dialog")).not.toBeNull());
  }

  it("항목을 누르면 쓰지 않고 메뉴가 닫히며 기한 다이얼로그가 열린다", async () => {
    freezeClock();
    mountSeeded(rosterMember());
    await openDndDialog();

    expect(setPresenceStatus).not.toHaveBeenCalled();
    expect(patchNotificationRules).not.toHaveBeenCalled();
    const dialog = q("pause-until-dialog")!;
    expect(dialog.textContent).toContain("방해 금지를 언제까지 켤까요?");
    expect(dialog.textContent).toContain("알림도 함께 멈춰요");
    await vi.waitFor(() => expect(q("profile-card-menu")).toBeNull());
    // 지금은 방해 금지가 아니므로 「지금은 …」 줄이 없다.
    expect(q("pause-until-current")).toBeNull();
  });

  it("기한을 고르고 확인하면 PUT presence 가 {status, dndUntilMs} 하나로 나가고 규칙은 쓰지 않는다", async () => {
    freezeClock();
    mountSeeded(rosterMember());
    await openDndDialog();

    chooseUntil("30m");
    await confirmAtNow();

    await vi.waitFor(() => expect(setPresenceStatus).toHaveBeenCalledTimes(1));
    expect(setPresenceStatus).toHaveBeenCalledWith(WS, {
      status: "dnd",
      dndUntilMs: NOW + 30 * 60_000,
    });
    // 서버가 같은 트랜잭션에서 일시 중지를 묶어 켠다. 클라이언트가 규칙을 쓰면 묶음이 끊긴다.
    expect(putNotificationRules).not.toHaveBeenCalled();
    expect(patchNotificationRules).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(q("pause-until-dialog")).toBeNull());
  });

  it("쓰고 나면 명부에 방해 금지와 기한이 칠해지고, 알림 규칙 질의는 다시 읽도록 무효화된다", async () => {
    freezeClock();
    mountSeeded(rosterMember());
    await openDndDialog();

    chooseUntil("2h");
    await confirmAtNow();

    await vi.waitFor(() => expect(q("pause-until-dialog")).toBeNull());
    const [painted] = lastClient!.getQueryData<RosterMember[]>(ROSTER_KEY)!;
    expect(painted.presenceStatus).toBe("dnd");
    expect(painted.dndUntilMs).toBe(NOW + 120 * 60_000);
    // 설정 › 알림의 스위치가 서버가 묶어 켠 실제 값을 그리게 하는 유일한 길이다.
    expect(lastClient!.getQueryState(RULES_KEY)?.isInvalidated).toBe(true);
  });

  it("방해 금지가 아닌 항목으로 나와도 규칙을 다시 읽는다(서버가 켜 둔 일시 중지를 되돌린다)", async () => {
    freezeClock();
    mountSeeded(rosterMember({ presenceStatus: "dnd", dndUntilMs: at(16, 21, 30) }));
    await openMenu();

    await clickTestId("presence-option-away");

    await vi.waitFor(() => expect(setPresenceStatus).toHaveBeenCalledTimes(1));
    expect(setPresenceStatus).toHaveBeenCalledWith(WS, { status: "away" });
    expect(putNotificationRules).not.toHaveBeenCalled();
    expect(patchNotificationRules).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(lastClient!.getQueryState(RULES_KEY)?.isInvalidated).toBe(true);
    });
    const [painted] = lastClient!.getQueryData<RosterMember[]>(ROSTER_KEY)!;
    expect(painted.presenceStatus).toBe("away");
    expect(painted.dndUntilMs).toBeUndefined();
  });

  it("이미 방해 금지인 항목은 끝나는 때를 둘째 줄에 말하고, 누르면 기한을 바꾸는 다이얼로그가 열린다", async () => {
    freezeClock();
    mountSeeded(rosterMember({ presenceStatus: "dnd", dndUntilMs: at(16, 21, 30) }));
    await openMenu();

    const note = q("presence-dnd-until")!;
    expect(note.textContent).toBe("오후 9:30까지");
    // 둘째 줄은 항목의 이름에 들어 있어 스크린리더가 기한을 함께 읽는다.
    expect(q("presence-option-dnd")!.textContent).toContain("방해 금지");
    expect(q("presence-option-dnd")!.textContent).toContain("오후 9:30까지");

    await clickTestId("presence-option-dnd");
    await vi.waitFor(() => expect(q("pause-until-dialog")).not.toBeNull());
    expect(q("pause-until-current")!.textContent).toBe("지금은 오후 9:30까지예요.");
    expect(setPresenceStatus).not.toHaveBeenCalled();
  });

  it("기한 없는 방해 금지는 「기한 없음 · 기한 정하기」로 보이고 다이얼로그가 그렇게 말한다", async () => {
    freezeClock();
    mountSeeded(rosterMember({ presenceStatus: "dnd" }));
    await openMenu();

    expect(q("presence-dnd-until")!.textContent).toBe("기한 없음 · 기한 정하기");

    await clickTestId("presence-option-dnd");
    await vi.waitFor(() => expect(q("pause-until-dialog")).not.toBeNull());
    expect(q("pause-until-current")!.textContent).toBe("지금은 기한이 없어요.");
  });

  it("방해 금지가 아닐 때 항목에는 둘째 줄이 없다", async () => {
    mountSeeded(rosterMember({ presenceStatus: "away" }));
    await openMenu();
    expect(q("presence-dnd-until")).toBeNull();
  });

  it("쓰기가 실패하면 다이얼로그가 열린 채 이유를 말하고 명부를 되돌린다", async () => {
    freezeClock();
    setPresenceStatus.mockRejectedValue(new Error("presence write failed"));
    mountSeeded(rosterMember());
    await openDndDialog();

    chooseUntil("1h");
    await confirmAtNow();

    await vi.waitFor(() => expect(q("pause-until-error")).not.toBeNull());
    expect(q("pause-until-error")!.textContent).toContain(PRESENCE_WRITE_FAILED);
    expect(q("pause-until-dialog")).not.toBeNull();
    const [row] = lastClient!.getQueryData<RosterMember[]>(ROSTER_KEY)!;
    expect(row.presenceStatus).toBe("auto");
    expect(row.dndUntilMs).toBeUndefined();
    // 실패해도 서버가 어디까지 적용했는지는 모르니 규칙은 다시 읽는다.
    expect(lastClient!.getQueryState(RULES_KEY)?.isInvalidated).toBe(true);
    expect(patchNotificationRules).not.toHaveBeenCalled();
  });

  it("키보드: 다이얼로그가 열리면 초점이 안으로 들어가고, Esc 로 닫으면 프로필 카드로 돌아온다", async () => {
    freezeClock();
    mountSeeded(rosterMember());
    await openDndDialog();

    await vi.waitFor(() => {
      expect(
        document.activeElement?.closest('[data-testid="pause-until-dialog"]')
      ).not.toBeNull();
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await vi.waitFor(() => expect(q("pause-until-dialog")).toBeNull());
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(q("profile-card"));
    });
    expect(setPresenceStatus).not.toHaveBeenCalled();
  });

  it("취소하면 아무것도 쓰지 않는다", async () => {
    freezeClock();
    mountSeeded(rosterMember());
    await openDndDialog();
    chooseUntil("30m");

    await clickTestId("pause-until-cancel");

    await vi.waitFor(() => expect(q("pause-until-dialog")).toBeNull());
    expect(setPresenceStatus).not.toHaveBeenCalled();
    expect(lastClient!.getQueryState(RULES_KEY)?.isInvalidated).toBe(false);
  });
});

// #3276: 프로필 행이 눌릴 때 아바타·이름이 흔들렸다. 원인은 `.press:active`의
// `transform: scale(0.98)`이었다(실측: 눌린 채 트리거 폭이 4.12px 줄고, 놓으며 메뉴가
// 열릴 때 되돌아온다. 호버·포커스 링·메뉴 열림/닫힘·상태 점은 모두 0px).
// 실제 상자는 scripts/capture-profile-jitter.mjs(Chromium)가 프레임마다 재고, 여기서는
// 그 원인이 되돌아오지 못하게 클래스와 유틸 정의를 고정한다. jsdom은 CSS를 계산하지
// 않으므로 계산값이 아니라 문자열 계약이다.
describe("ProfileCard 트리거는 눌러도 움직이지 않는다 (#3276)", () => {
  const tokens = readFileSync(resolve(__dirname, "../../design/tokens.css"), "utf8");

  function triggerClasses(): string[] {
    mountCard();
    const trigger = document.querySelector('[data-testid="profile-card"]');
    expect(trigger).not.toBeNull();
    return (trigger!.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }

  it("눌림은 채움(press-instant-fill)이고 `press`(scale)가 아니다", () => {
    const classes = triggerClasses();
    expect(classes).toContain("press-instant-fill");
    expect(classes).not.toContain("press");
  });

  it("크기·위치를 바꾸는 활성/열림 변형이 없다", () => {
    const classes = triggerClasses();
    const geometry = /^(?:[a-z-]+:|data-\[[^\]]+\]:)*(?:scale|translate|rotate|font|border|ring|outline-offset|p[xytblr]?|m[xytblr]?|w|h|size|gap|leading|text-(?:body|meta|title))-/;
    const stateful = classes.filter((c) => /^(?:active|data-\[state=open\]|aria-expanded|focus-visible|focus):/.test(c));
    for (const c of stateful) {
      const bare = c.replace(/^(?:active|data-\[state=open\]|aria-expanded|focus-visible|focus):/, "");
      // focus-visible:focus-ring은 inset 아웃라인(오프셋 -2px)이라 상자를 늘리지 않는다.
      if (bare === "focus-ring") continue;
      expect(`${c}`, `${c}는 상태에 따라 상자를 바꿀 수 있다`).not.toMatch(geometry);
      expect(bare.startsWith("bg-"), `${c}: 상태 변형은 채움만 바꾼다`).toBe(true);
    }
  });

  it("press-instant-fill 정의는 눌린 상태에서 transform을 없앤다", () => {
    const block = tokens.match(/@utility press-instant-fill \{([\s\S]*?)\n\}/);
    expect(block, "tokens.css의 press-instant-fill 유틸").not.toBeNull();
    const body = block![1];
    expect(body).toMatch(/&:active[^{]*\{[^}]*transform:\s*none/);
    expect(body).not.toMatch(/scale\(/);
    // 전이 목록에 transform이 들어 있으면 놓을 때 되돌아오는 움직임이 생긴다.
    const transition = body.match(/transition-property:([^;]*);/);
    expect(transition?.[1] ?? "").not.toMatch(/\btransform\b/);
  });

  it("메뉴를 열고 닫아도 트리거 클래스가 같다(크기 변형 없음)", async () => {
    const before = triggerClasses();
    await openMenu();
    const trigger = document.querySelector('[data-testid="profile-card"]')!;
    expect(trigger.getAttribute("data-state")).toBe("open");
    expect((trigger.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)).toEqual(before);
  });
});
