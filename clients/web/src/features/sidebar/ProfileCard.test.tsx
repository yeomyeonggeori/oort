// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AddWorkspaceOpenContext } from "@/features/workspace/useAddWorkspace";
import { ProfileCard } from "./ProfileCard";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

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
  selfMember: RosterMember = rosterMember()
): HTMLElement {
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
            selfName: "곽성재",
            connected: true,
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

describe("ProfileCard 커스텀 상태 (#1889)", () => {
  it("shows the emoji on the card and the text on title plus menu head", async () => {
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
    expect(document.querySelector('[data-testid="custom-status-text"]')).toBeNull();
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

  it("keeps a quiet mark on the card when the status is text-only (#1889 R2-M2)", async () => {
    mountCard(
      () => undefined,
      rosterMember({
        presenceStatus: "auto",
        statusText: "고객사 미팅",
      })
    );
    const trigger = document.querySelector('[data-testid="profile-card"]');
    expect(document.querySelector('[data-testid="custom-status-glyph"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="custom-status-emoji"]')).toBeNull();
    expect(document.querySelector('[data-testid="custom-status-text"]')).toBeNull();
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
