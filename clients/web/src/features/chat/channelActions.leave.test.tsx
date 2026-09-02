// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel } from "@momo/core/lib/api";
import {
  CHANNEL_LEAVE_LABEL,
  channelLeaveFailureMessage,
} from "@momo/core/features/channels/model";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { ChannelHeaderMenu } from "./ChannelHeaderMenu";
import { SidebarRowContextMenu } from "@/features/sidebar/SidebarRowContextMenu";

// =============================================================================
// design-review #1937 H-1 — 파괴 액션의 확인 다이얼로그가 왕복 내내 살아 있는가.
//
// 결함은 낙관 삭제였다: `onMutate` 가 사이드바 목록에서 채널을 지우면 그 행이
// 언마운트되고, 확인 다이얼로그가 행의 서브트리 안에 살아서 함께 죽었다. 실측
// 시간축은 「눌렀더니 사라졌다 → 1초 뒤 채널이 말없이 되돌아왔다」였고, 코드에
// 있는 「나가는 중」과 실패 배너는 한 표본도 화면에 오르지 못했다.
//
// 이 파일이 **두 표면을 같은 시나리오로** 돌리는 이유는 그것이 공용 정본의
// 존재 이유이기 때문이다. 결함은 헤더 ⋮ 에도 있었고(대조 실측
// `{deletes:1, dialogStillMounted:0, errorBanner:0}`), 수리는 `channelActions.tsx`
// 한 곳에 들어갔다. 두 표면이 함께 닫히지 않으면 정본이 정본이 아니다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";

const removeChannelMember = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    removeChannelMember: (ws: string, ch: string, member: string) =>
      removeChannelMember(ws, ch, member) as Promise<unknown>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let client: QueryClient | null = null;

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
  removeChannelMember.mockReset();
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
  client = null;
  resetEscapeLayers();
  vi.unstubAllGlobals();
});

function channelFixture(): Channel {
  return {
    id: CHANNEL_ID,
    workspaceId: WS,
    kind: "public",
    name: "general",
    muted: false,
  };
}

/** 서버가 아직 답하지 않은 왕복. 시험이 그 순간을 붙잡는다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

function mount(tree: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData<Channel[]>(["channels", WS], [channelFixture()]);
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/c/00000000-0000-7000-8000-000000000299"] },
        createElement(QueryClientProvider, { client: client! }, tree)
      )
    );
  });
}

function cachedChannels(): Channel[] {
  return client?.getQueryData<Channel[]>(["channels", WS]) ?? [];
}

function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function click(id: string) {
  const target = byId(id);
  if (!target) throw new Error(`없다: ${id}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * 두 표면. 열쇠(메뉴를 여는 손 · testid 접두사)만 다르고 시나리오는 같다.
 */
const SURFACES = [
  {
    name: "헤더 ⋮",
    confirm: "channel-leave-confirm",
    mount: () => {
      mount(
        createElement(ChannelHeaderMenu, {
          workspaceId: WS,
          channel: channelFixture(),
          title: "general",
          selfMemberId: ME,
          selfRole: "owner" as const,
        })
      );
      click("channel-title-menu");
    },
    leaveItem: "channel-leave",
  },
  {
    name: "사이드바 행 우클릭",
    confirm: "channel-row-leave-confirm",
    mount: () => {
      mount(
        createElement(
          "ul",
          null,
          createElement("li", null,
            createElement(SidebarRowContextMenu, {
              workspaceId: WS,
              channel: channelFixture(),
              title: "general",
              selfMemberId: ME,
              selfRole: "owner" as const,
              readState: null,
              children: createElement("a", {
                href: `/c/${CHANNEL_ID}`,
                "data-testid": "channel-item",
                "data-sidebar-row": "",
              }),
            })
          )
        )
      );
      const row = byId("channel-item");
      act(() => {
        row?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 12,
            clientY: 40,
          })
        );
      });
    },
    leaveItem: "channel-row-leave",
  },
] as const;

for (const surface of SURFACES) {
  describe(`나가기 왕복 — ${surface.name}`, () => {
    it("확인 뒤에도 다이얼로그가 서서 「나가는 중」이라 말한다", async () => {
      const pending = deferred<unknown>();
      removeChannelMember.mockReturnValue(pending.promise);
      surface.mount();
      click(surface.leaveItem);
      await flush();
      expect(byId(surface.confirm)).not.toBeNull();
      expect(removeChannelMember).not.toHaveBeenCalled();

      click(`${surface.confirm}-action`);
      await flush();

      // 이 세 줄이 결함이 삼켰던 것 전부다.
      expect(removeChannelMember).toHaveBeenCalledWith(WS, CHANNEL_ID, ME);
      expect(byId(surface.confirm)).not.toBeNull();
      const action = byId(`${surface.confirm}-action`);
      expect(action?.getAttribute("aria-busy")).toBe("true");
      expect(action?.textContent).toContain("나가는 중");
      // 서버가 답하기 전에는 목록을 건드리지 않는다 — 되돌릴 것을 만들지 않는다.
      expect(cachedChannels()).toHaveLength(1);

      pending.resolve({});
      await flush();
    });

    it("403 이면 그 자리에서 이유를 말하고 채널은 그대로 남는다", async () => {
      const pending = deferred<unknown>();
      removeChannelMember.mockReturnValue(pending.promise);
      surface.mount();
      click(surface.leaveItem);
      await flush();
      click(`${surface.confirm}-action`);
      await flush();

      const denied = new ApiError(403, "forbidden");
      await act(async () => {
        pending.reject(denied);
        await Promise.resolve();
      });
      await flush();

      const banner = byId(`${surface.confirm}-error`);
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toBe(channelLeaveFailureMessage(denied));
      expect(byId(surface.confirm)).not.toBeNull();
      // 실패했으니 채널은 그 자리에 있다. 사라졌다가 되돌아오지 않는다.
      expect(cachedChannels()).toHaveLength(1);
      // 다시 눌러 볼 수 있는 상태로 돌아온다.
      expect(
        byId(`${surface.confirm}-action`)?.getAttribute("aria-busy")
      ).toBeNull();
      expect(byId(`${surface.confirm}-action`)?.textContent).toContain(
        CHANNEL_LEAVE_LABEL
      );
    });

    it("성공하면 그때 목록에서 사라지고 다이얼로그가 닫힌다", async () => {
      const pending = deferred<unknown>();
      removeChannelMember.mockReturnValue(pending.promise);
      surface.mount();
      click(surface.leaveItem);
      await flush();
      click(`${surface.confirm}-action`);
      await flush();
      expect(cachedChannels()).toHaveLength(1);

      await act(async () => {
        pending.resolve({});
        await Promise.resolve();
      });
      await flush();

      expect(cachedChannels()).toHaveLength(0);
      expect(byId(surface.confirm)).toBeNull();
    });
  });
}
