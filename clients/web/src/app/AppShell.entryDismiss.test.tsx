// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { dismissTemporarySurfaces } from "@momo/core/features/notifications/entryDismiss";
import { AppShell } from "@/app/AppShell";
import { adeDrawerSnapshot, openAdeDrawer, resetAdeDrawer } from "@/features/ade/adeDrawerStore";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import type { SessionContextValue } from "@/app/session";

// 알림이 새 입구로 들어오면(#4667) 셸이 쥔 표면 — ⌘K 팔레트와 ADE 관제 서랍 — 이 걷힌다. 실제 AppShell 을 세우고 주변의 다이얼로그·
// 네트워크 수명만 격리한다(`MessageRow.decisionStage.test.tsx` 와 같은 격리). 대화상자(Dialog Root)는 `dialog.entryDismiss.test.tsx` 가,
// 알림 클릭이 방송을 올리는 순서는 `DesktopNotifications*.test.tsx` 가 잰다. 여기서는 **셸의 구독**이 실제로 닫는가 하나를 본다.

// 팔레트는 열림 상태만 드러내는 대역이다 — 닫는 길은 셸의 `setSwitcherOpen` 이고 그것이 이 시험의 대상이다.
vi.mock("@/app/QuickSwitcher", async () => {
  const { createElement: h } = await import("react");
  return {
    QuickSwitcher: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
      h(
        "div",
        { "data-testid": "switcher", "data-open": String(open) },
        h("button", { type: "button", "data-testid": "switcher-open", onClick: () => onOpenChange(true) }, "열기")
      ),
  };
});
vi.mock("@/features/channels/CreateChannelDialog", () => ({ CreateChannelProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/workspace/AddWorkspaceDialog", () => ({ AddWorkspaceProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/channels/AddChannelMemberDialog", () => ({ AddChannelMemberProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/directory/NewDmDialog", () => ({ NewDmProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/routing/AgentProfileDialog", () => ({ AgentProfileProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/features/directory/MemberProfileDialog", () => ({ MemberProfileProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock("@/app/AppTitlebar", () => ({ AppTitlebar: () => null }));
vi.mock("@/features/sidebar/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/features/inbox/InboxHotkeys", () => ({ InboxHotkeys: () => null }));
vi.mock("@/features/agents/AgentTurnFixture", () => ({ AgentTurnFixture: () => null }));
vi.mock("@/design/wallpaper/WallpaperLayer", () => ({ WallpaperLayer: () => null }));
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "entry-workspace";
const ME = "entry-human";
const session: SessionContextValue = {
  workspaceId: WS,
  connStatus: "connected",
  realtime: null,
  logout: () => undefined,
  replaceSessionMember: () => undefined,
  session: {
    accessToken: "fixture",
    refreshToken: "fixture",
    realtimeWebSocketUrl: "wss://example.test",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" },
  },
};

function mountShell(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpenMemberProfileContext.Provider value={() => undefined}>
        <MemoryRouter initialEntries={["/inbox"]}>
          <Routes>
            <Route
              element={
                <AppShell
                  session={session.session}
                  onLogout={session.logout}
                  replaceSessionMember={session.replaceSessionMember}
                />
              }
            >
              <Route path="*" element={<div data-testid="route-body" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </OpenMemberProfileContext.Provider>
    </QueryClientProvider>
  );
}

const switcherOpen = () => screen.getByTestId("switcher").getAttribute("data-open");

beforeEach(() => {
  // `?stress=1` 은 합성 행만 재는 게이트라 소켓을 열지 않는다 — 네트워크 없이 셸 틀만 선다.
  window.history.replaceState(null, "", "/?stress=1&agentwork=live");
  vi.stubGlobal(
    "matchMedia",
    (media: string) => ({ matches: media.includes("prefers-reduced-motion"), media, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  );
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  resetAdeDrawer();
});

afterEach(() => {
  cleanup();
  resetAdeDrawer();
  vi.unstubAllGlobals();
});

describe("실제 AppShell — 알림이 새 입구로 들어오면 셸이 쥔 표면을 걷는다 (#4667)", () => {
  it("열려 있던 ⌘K 팔레트는 닫힌다", () => {
    mountShell();
    expect(switcherOpen()).toBe("false");
    fireEvent.click(screen.getByTestId("switcher-open"));
    expect(switcherOpen()).toBe("true");

    act(() => {
      dismissTemporarySurfaces();
    });

    expect(switcherOpen()).toBe("false");
  });

  it("열려 있던 ADE 관제 서랍은 닫힌다 — 같은 채널의 다른 메시지로 오는 알림은 경로가 같아 라우트 효과가 서랍을 걷지 않는다", () => {
    mountShell();
    act(() => {
      openAdeDrawer();
    });
    expect(adeDrawerSnapshot()).toBe(true);

    act(() => {
      dismissTemporarySurfaces();
    });

    expect(adeDrawerSnapshot()).toBe(false);
  });
});
