// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel } from "@momo/core/lib/api";
import { channelLeaveFailure } from "@momo/core/features/channels/model";
import enTimeline from "../../../../../packages/momo-core/src/i18n/catalogs/en-US/timeline.json";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { CONFIRM_ARM_MS } from "@/design/ui/confirm-dialog";
import { ChannelHeaderMenu } from "./ChannelHeaderMenu";
import { ChannelLeaveConfirmDialog, type ChannelActions } from "./channelActions";
import { ROUTE_REGION_DOM_ID } from "@/app/shellNav";
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

const EN = enTimeline as Record<string, string>;
const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";

const leaveChannel = vi.hoisted(() => vi.fn());
// 관리자 전용 길(`…/members/{id}`). 나가기가 이 길을 부르면 일반 멤버는 403 이다(#5778) — 불리면 시험이 붉다.
const removeChannelMember = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    leaveChannel: (ws: string, ch: string) => leaveChannel(ws, ch) as Promise<unknown>,
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
  leaveChannel.mockReset();
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

/** 확정은 서고 나서 `CONFIRM_ARM_MS` 동안 눌림을 받지 않는다(공용 확인 창). 시험은 사람이 읽고 누르는 것처럼 그 뒤에 누른다. */
async function armedClick(id: string) {
  await act(async () => {
    await new Promise((done) => setTimeout(done, CONFIRM_ARM_MS + 40));
  });
  expect(byId(id)?.getAttribute("data-armed")).toBe("true");
  click(id);
  await flush();
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
type SelfRole = "owner" | "member" | "guest";

const SURFACES = [
  {
    name: "헤더 ⋮",
    confirm: "channel-leave-confirm",
    mount: (selfRole: SelfRole = "owner") => {
      mount(
        createElement(ChannelHeaderMenu, {
          workspaceId: WS,
          channel: channelFixture(),
          title: "general",
          selfMemberId: ME,
          selfRole,
        })
      );
      click("channel-title-menu");
    },
    leaveItem: "channel-leave",
  },
  {
    name: "사이드바 행 우클릭",
    confirm: "channel-row-leave-confirm",
    mount: (selfRole: SelfRole = "owner") => {
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
              selfRole,
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
      leaveChannel.mockReturnValue(pending.promise);
      surface.mount();
      click(surface.leaveItem);
      await flush();
      expect(byId(surface.confirm)).not.toBeNull();
      expect(leaveChannel).not.toHaveBeenCalled();

      await armedClick(`${surface.confirm}-confirm`);

      // 이 세 줄이 결함이 삼켰던 것 전부다.
      expect(leaveChannel).toHaveBeenCalledWith(WS, CHANNEL_ID);
      expect(removeChannelMember).not.toHaveBeenCalled();
      expect(byId(surface.confirm)).not.toBeNull();
      const action = byId(`${surface.confirm}-confirm`);
      expect(action?.getAttribute("aria-busy")).toBe("true");
      // 사전 없이 띄운 시험이라 영어 사전이 말한다(`useFormatMessage` 의 대체). 확인 단계의 낱말은 모두 한 사전 묶음이다.
      expect(action?.textContent).toContain(EN["timeline.channelLeave.busy"]);
      // 서버가 답하기 전에는 목록을 건드리지 않는다 — 되돌릴 것을 만들지 않는다.
      expect(cachedChannels()).toHaveLength(1);

      pending.resolve({});
      await flush();
    });

    it("403 이면 그 자리에서 이유를 말하고 채널은 그대로 남는다", async () => {
      const pending = deferred<unknown>();
      leaveChannel.mockReturnValue(pending.promise);
      surface.mount();
      click(surface.leaveItem);
      await flush();
      await armedClick(`${surface.confirm}-confirm`);

      const denied = new ApiError(403, "forbidden");
      await act(async () => {
        pending.reject(denied);
        await Promise.resolve();
      });
      await flush();

      const banner = byId(`${surface.confirm}-error`);
      expect(banner).not.toBeNull();
      // 사전 없이 띄운 시험이라 영어 사전이 말한다(`useFormatMessage` 의 대체).
      expect(banner?.textContent).toBe(
        (enTimeline as Record<string, string>)[channelLeaveFailure(denied).key]
      );
      expect(byId(surface.confirm)).not.toBeNull();
      // 실패했으니 채널은 그 자리에 있다. 사라졌다가 되돌아오지 않는다.
      expect(cachedChannels()).toHaveLength(1);
      // 다시 눌러 볼 수 있는 상태로 돌아온다.
      expect(
        byId(`${surface.confirm}-confirm`)?.getAttribute("aria-busy")
      ).toBeNull();
      expect(byId(`${surface.confirm}-confirm`)?.textContent).toContain(
        EN["timeline.channelLeave.confirm"]
      );
    });

    it("성공하면 그때 목록에서 사라지고 다이얼로그가 닫힌다", async () => {
      const pending = deferred<unknown>();
      leaveChannel.mockReturnValue(pending.promise);
      surface.mount();
      click(surface.leaveItem);
      await flush();
      await armedClick(`${surface.confirm}-confirm`);
      expect(cachedChannels()).toHaveLength(1);

      await act(async () => {
        pending.resolve({});
        await Promise.resolve();
      });
      await flush();

      expect(cachedChannels()).toHaveLength(0);
      expect(byId(surface.confirm)).toBeNull();
    });

    it("확인이 선 직후의 확정 누름은 아무 일도 하지 않고, 읽을 시간이 지나면 받는다 (#5818 검수 High)", async () => {
      leaveChannel.mockResolvedValue({});
      surface.mount();
      click(surface.leaveItem);
      await flush();
      const confirmId = `${surface.confirm}-confirm`;
      // 메뉴 줄을 누른 자리에 확정이 서서 둘째 누름이 거기 떨어지는 장면: 서자마자의 누름은 받지 않는다.
      expect(byId(confirmId)?.getAttribute("data-armed")).toBe("false");
      click(confirmId);
      await flush();
      expect(leaveChannel).not.toHaveBeenCalled();
      expect(byId(surface.confirm)).not.toBeNull();
      await armedClick(confirmId);
      expect(leaveChannel).toHaveBeenCalledTimes(1);
    });

    it("나가기 확인 창은 「이 채널에서 나갈까요?」라는 이름으로 찾아진다 — 낭독 이름이 비지 않는다 (#5818 검수 r2)", async () => {
      surface.mount();
      click(surface.leaveItem);
      await flush();
      const dialog = byId(surface.confirm);
      expect(dialog?.getAttribute("role")).toBe("alertdialog");
      const target = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
      expect(target?.textContent).toBe(EN["timeline.channelLeave.title"]);
    });

    it("이미 나간 채널(404)을 낡은 화면에서 또 나가면 줄을 걷고 확인 창을 닫는다 (#5818 검수 M2)", async () => {
      const pending = deferred<unknown>();
      leaveChannel.mockReturnValue(pending.promise);
      surface.mount();
      click(surface.leaveItem);
      await flush();
      await armedClick(`${surface.confirm}-confirm`);
      expect(cachedChannels()).toHaveLength(1);
      await act(async () => {
        pending.reject(new ApiError(404, "not a member"));
        await Promise.resolve();
      });
      await flush();
      // 서버가 「이미 멤버가 아니다」라고 했다: 나간 것과 같게 목록에서 걷고 창은 남기지 않는다. 같은 404 를 사람이 다시 누르게 두지 않는다.
      expect(cachedChannels()).toHaveLength(0);
      expect(byId(surface.confirm)).toBeNull();
    });

    it("요청이 도는 동안 Esc·바깥 누름·취소는 확인 창을 닫지 않는다 (#5818 검수 M4)", async () => {
      const pending = deferred<unknown>();
      leaveChannel.mockReturnValue(pending.promise);
      surface.mount();
      click(surface.leaveItem);
      await flush();
      await armedClick(`${surface.confirm}-confirm`);
      expect(byId(`${surface.confirm}-confirm`)?.getAttribute("aria-busy")).toBe("true");

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await flush();
      expect(byId(surface.confirm)).not.toBeNull();

      await act(async () => {
        document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();
      expect(byId(surface.confirm)).not.toBeNull();

      click(`${surface.confirm}-cancel`);
      await flush();
      expect(byId(surface.confirm)).not.toBeNull();

      pending.resolve({});
      await flush();
    });

    it("요청이 돌지 않을 때는 Esc 가 확인 창을 닫는다 (위 잠금 시험이 실패할 수 있다는 대조)", async () => {
      surface.mount();
      click(surface.leaveItem);
      await flush();
      expect(byId(surface.confirm)).not.toBeNull();
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await flush();
      expect(byId(surface.confirm)).toBeNull();
      expect(leaveChannel).not.toHaveBeenCalled();
    });

    for (const role of ["member", "guest"] as const) {
      it(`${role} 도 나가기를 보고, 누르면 관리자 길이 아니라 본인 나가기 길을 부른다 (#5778)`, async () => {
        const pending = deferred<unknown>();
        leaveChannel.mockReturnValue(pending.promise);
        surface.mount(role);
        expect(byId(surface.leaveItem)).not.toBeNull();
        click(surface.leaveItem);
        await flush();
        await armedClick(`${surface.confirm}-confirm`);
        expect(leaveChannel).toHaveBeenCalledWith(WS, CHANNEL_ID);
        expect(removeChannelMember).not.toHaveBeenCalled();
        await act(async () => {
          pending.resolve({ channelId: CHANNEL_ID, memberId: ME, archived: false });
          await Promise.resolve();
        });
        await flush();
        expect(cachedChannels()).toHaveLength(0);
      });
    }
  });
}

// =============================================================================
// 나간 뒤 초점 (#5818 검수 M3): 연 단추·줄이 나가며 사라졌으면 문서 몸통(body)이 아니라 옮겨 간 화면의 본문 자리로 간다.
// 진짜 확인 창을 열고 닫으며, 돌려줄 곳(opener)이 붙어 있는 경우와 떨어진 경우를 모두 잰다.
// =============================================================================

describe("나간 뒤 초점", () => {
  function fakeActions(confirmOpen: boolean): ChannelActions {
    return {
      leave: {
        kind: "public",
        confirmOpen,
        open: () => undefined,
        close: () => undefined,
        error: null,
        pending: false,
        confirm: () => undefined,
      },
    } as unknown as ChannelActions;
  }

  function render(confirmOpen: boolean, opener: HTMLElement | null) {
    act(() => {
      mountedRoot?.render(
        createElement(ChannelLeaveConfirmDialog, {
          actions: fakeActions(confirmOpen),
          title: "general",
          testId: "focus-leave",
          opener,
        })
      );
    });
  }

  function setup(attachOpener: boolean) {
    const region = document.createElement("div");
    region.id = ROUTE_REGION_DOM_ID;
    region.tabIndex = -1;
    document.body.append(region);
    const opener = document.createElement("button");
    if (attachOpener) document.body.append(opener);
    const host = document.createElement("div");
    document.body.append(host);
    mountedHost = host;
    mountedRoot = createRoot(host);
    return { region, opener };
  }

  it("돌려줄 단추가 나가며 사라졌으면 본문 자리가 초점을 받는다 (body 로 떨어지지 않는다)", async () => {
    const { region, opener } = setup(false);
    render(true, opener);
    await flush();
    render(false, opener);
    await flush();
    await flush();
    expect(document.activeElement).toBe(region);
    expect(document.activeElement).not.toBe(document.body);
    region.remove();
  });

  it("본문 자리가 잠깐 `inert` 라 첫 시도를 거절해도(폰 폭 서랍) 풀리면 거기서 받는다 (#5818 검수 r2 N2)", async () => {
    const { region, opener } = setup(false);
    // 서랍이 열려 있는 동안 본문은 `inert` 라 `focus()` 가 조용히 거절된다. 몇 프레임 뒤 풀린다.
    let blocked = true;
    const realFocus = region.focus.bind(region);
    region.focus = (options?: FocusOptions) => {
      if (!blocked) realFocus(options);
    };
    render(true, opener);
    await flush();
    render(false, opener);
    await flush();
    expect(document.activeElement).not.toBe(region);
    blocked = false;
    await vi.waitFor(() => expect(document.activeElement).toBe(region));
    region.remove();
  });

  it("돌려줄 단추가 아직 있으면(나가지 못했을 때) 그 단추가 초점을 받는다", async () => {
    const { region, opener } = setup(true);
    render(true, opener);
    await flush();
    render(false, opener);
    await flush();
    await flush();
    expect(document.activeElement).toBe(opener);
    region.remove();
    opener.remove();
  });
});
