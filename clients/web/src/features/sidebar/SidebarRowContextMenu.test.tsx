// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, MembershipRole, ReadState } from "@momo/core/lib/api";
import {
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_READ_LABEL,
  CHANNEL_MUTE_FAILURE,
  CHANNEL_MUTE_LABEL,
  CHANNEL_UNMUTE_LABEL,
} from "@momo/core/features/channels/model";
import {
  COPY_LINK_ACTION_LABEL,
  COPY_LINK_DONE_LABEL,
} from "@momo/core/features/timeline/copyLabels";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { SidebarRow } from "./SidebarRow";
import { SidebarRowContextMenu } from "./SidebarRowContextMenu";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";

const setChannelNotificationPref = vi.hoisted(() => vi.fn());
const updateReadState = vi.hoisted(() => vi.fn());
const removeChannelMember = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    setChannelNotificationPref: (ws: string, ch: string, muted: boolean) =>
      setChannelNotificationPref(ws, ch, muted) as Promise<boolean>,
    updateReadState: (ws: string, ch: string, seq: number) =>
      updateReadState(ws, ch, seq) as Promise<unknown>,
    removeChannelMember: (ws: string, ch: string, member: string) =>
      removeChannelMember(ws, ch, member) as Promise<unknown>,
  };
});

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

/** 포인터 하드웨어(hover 가 있는 화면)가 기본. 터치 시험만 뒤집는다. */
function stubPointerSurface(hoverNone = false) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: hoverNone && query.includes("hover: none"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  setChannelNotificationPref.mockReset();
  setChannelNotificationPref.mockResolvedValue(true);
  updateReadState.mockReset();
  updateReadState.mockResolvedValue({});
  removeChannelMember.mockReset();
  removeChannelMember.mockResolvedValue({});
  stubPointerSurface();
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  resetEscapeLayers();
  vi.unstubAllGlobals();
});

function channelFixture(over: Partial<Channel> = {}): Channel {
  return {
    id: CHANNEL_ID,
    workspaceId: WS,
    kind: "public",
    name: "general",
    muted: false,
    ...over,
  };
}

function readStateFixture(over: Partial<ReadState> = {}): ReadState {
  return {
    channelId: CHANNEL_ID,
    lastReadSeq: 40,
    latestSeq: 47,
    unreadCount: 7,
    mentionCount: 0,
    ...over,
  };
}

function mountRow({
  channel = channelFixture(),
  readState = readStateFixture(),
  selfRole = "owner",
  title = "general",
}: {
  channel?: Channel;
  readState?: ReadState | null;
  selfRole?: MembershipRole;
  title?: string;
} = {}): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        // 이 채널이 아닌 곳에 서 있다: 사이드바에서 조작하는 상황 그대로.
        { initialEntries: ["/c/00000000-0000-7000-8000-000000000299"] },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            "ul",
            null,
            createElement(SidebarRow, {
              to: `/c/${channel.id}`,
              icon: null,
              label: title,
              testId: "channel-item",
              wrapLink: (link) =>
                createElement(SidebarRowContextMenu, {
                  workspaceId: WS,
                  channel,
                  title,
                  selfMemberId: ME,
                  selfRole,
                  readState,
                  children: link,
                }),
            })
          )
        )
      )
    );
  });
  return host;
}

function row(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-testid="channel-item"]');
  if (!found) throw new Error("행이 없다");
  return found;
}

function trigger(): HTMLElement {
  const found = document.querySelector<HTMLElement>("[data-row-menu-trigger]");
  if (!found) throw new Error("트리거 상자가 없다");
  return found;
}

/** 우클릭 메뉴를 달지 않은 같은 행의 클래스 목록. 비교 기준. */
function plainRowClass(): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/c/00000000-0000-7000-8000-000000000299"] },
        createElement(
          "ul",
          null,
          createElement(SidebarRow, {
            to: `/c/${CHANNEL_ID}`,
            icon: null,
            label: "general",
            testId: "plain-row",
          })
        )
      )
    );
  });
  const cls =
    document.querySelector('[data-testid="plain-row"]')?.getAttribute("class") ??
    "";
  act(() => root.unmount());
  host.remove();
  return cls;
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="channel-row-menu"]');
}

function item(testKey: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="channel-row-${testKey}"]`
  );
}

function labels(): string[] {
  return Array.from(
    menu()?.querySelectorAll<HTMLElement>("[data-testid^='channel-row-']") ?? []
  ).map((el) => el.textContent?.trim() ?? "");
}

/** 포인터의 우클릭. 브라우저가 쏘는 것과 같은 이벤트다. */
function rightClick(target: HTMLElement = row()) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 40,
      })
    );
  });
}

function pressKey(
  target: Element | null,
  key: string,
  init: KeyboardEventInit = {}
) {
  act(() => {
    target?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    );
  });
}

/** Radix 는 마운트/언마운트 포커스를 setTimeout(0) 에 태운다. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickItem(testKey: string) {
  const target = item(testKey);
  if (!target) throw new Error(`항목이 없다: ${testKey}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("사이드바 행 우클릭 (BT-1 / #1929)", () => {
  it("우클릭이 이 행의 메뉴를 연다", () => {
    mountRow();
    expect(menu()).toBeNull();
    rightClick();
    expect(menu()).not.toBeNull();
    expect(labels()).toEqual([
      CHANNEL_MARK_READ_LABEL,
      CHANNEL_MUTE_LABEL,
      COPY_LINK_ACTION_LABEL,
      "이름 복사하기",
      CHANNEL_LEAVE_LABEL,
    ]);
    // 메뉴가 열려 있는 동안 행 자리가 그것을 말한다: 포털로 떠 있는 패널이
    // 어느 행의 것인지 아는 유일한 표식.
    expect(trigger().getAttribute("data-state")).toBe("open");
    expect(trigger().contains(row())).toBe(true);
  });

  it("메뉴는 행에 새 탭 정거장을 만들지 않는다", () => {
    mountRow();
    const before = document.querySelectorAll("[data-sidebar-row]").length;
    rightClick();
    // 트리거 상자는 span 이라 정거장이 아니다. 로빙 tabindex 가 세는 것은
    // 그대로 링크 하나.
    expect(document.querySelectorAll("[data-sidebar-row]").length).toBe(before);
    expect(row().tagName).toBe("A");
    expect(trigger().tagName).toBe("SPAN");
    expect(trigger().hasAttribute("tabindex")).toBe(false);
  });

  it("트리거가 행의 클래스를 건드리지 않는다", () => {
    // 실측 결함(캡처 회귀): `asChild` 로 감싸면 Radix Slot 이 NavLink 의 **함수**
    // className 을 문자열로 이어 붙여, 클래스 자리에 함수 소스가 꽂힌다. 행은
    // flex 도 패딩도 잘림도 전부 잃고 아이콘과 이름이 두 줄로 흩어진다.
    mountRow();
    const cls = row().getAttribute("class") ?? "";
    expect(cls).not.toContain("=>");
    expect(cls).not.toContain("isActive");
    expect(cls.split(/\s+/)).toContain("flex");
    expect(cls.split(/\s+/)).toContain("px-2");
    // 감싸지 않은 행과 글자 단위로 같은 목록이어야 한다.
    expect(cls).toBe(plainRowClass());
  });
});

describe("음소거 토글 왕복", () => {
  it("누르면 이 채널만 PUT 하고, 성공하면 메뉴가 닫힌다", async () => {
    mountRow();
    rightClick();
    clickItem("mute-toggle");
    // react-query 의 `mutate` 는 마이크로태스크에서 mutationFn 을 부른다.
    await flush();
    expect(setChannelNotificationPref).toHaveBeenCalledTimes(1);
    expect(setChannelNotificationPref).toHaveBeenCalledWith(WS, CHANNEL_ID, true);
    expect(menu()).toBeNull();
  });

  it("낱말이 상태를 따라 뒤집힌다", () => {
    mountRow({ channel: channelFixture({ muted: true }) });
    rightClick();
    expect(item("mute-toggle")?.textContent?.trim()).toBe(CHANNEL_UNMUTE_LABEL);
    expect(item("mute-toggle")?.hasAttribute("data-muted")).toBe(true);
  });

  it("이미 꺼져 있으면 켜기를 PUT 한다", async () => {
    mountRow({ channel: channelFixture({ muted: true }) });
    rightClick();
    clickItem("mute-toggle");
    await flush();
    expect(setChannelNotificationPref).toHaveBeenCalledWith(WS, CHANNEL_ID, false);
  });

  it("실패는 메뉴를 열어 둔 채 그 자리에서 말한다", async () => {
    setChannelNotificationPref.mockRejectedValue(new Error("nope"));
    mountRow();
    rightClick();
    clickItem("mute-toggle");
    await flush();
    expect(menu()).not.toBeNull();
    const banner = document.querySelector('[data-testid="channel-row-action-error"]');
    expect(banner?.textContent).toContain(CHANNEL_MUTE_FAILURE);
  });
});

describe("읽음 처리", () => {
  it("서버 투영의 latestSeq 를 광고한다 — 새 표면이 아니다", async () => {
    mountRow({ readState: readStateFixture({ latestSeq: 47 }) });
    rightClick();
    clickItem("mark-read");
    await flush();
    expect(updateReadState).toHaveBeenCalledTimes(1);
    expect(updateReadState).toHaveBeenCalledWith(WS, CHANNEL_ID, 47);
  });

  it("이미 다 읽은 채널에는 항목 자체가 없다", () => {
    mountRow({ readState: readStateFixture({ unreadCount: 0 }) });
    rightClick();
    expect(item("mark-read")).toBeNull();
    expect(labels()[0]).toBe(CHANNEL_MUTE_LABEL);
  });

  it("투영이 이 채널을 싣지 않았으면 광고하지 않는다", async () => {
    mountRow({ readState: null });
    rightClick();
    expect(item("mark-read")).toBeNull();
    await flush();
    expect(updateReadState).not.toHaveBeenCalled();
  });
});

describe("링크·이름 복사", () => {
  it("링크는 `#/c/{id}` 딥링크이고, 영수증 동안 메뉴가 열려 있다", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mountRow();
    rightClick();
    clickItem("copy-link");
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0][0])).toContain(`#/c/${CHANNEL_ID}`);
    expect(String(writeText.mock.calls[0][0])).not.toContain("msg=");
    expect(menu()).not.toBeNull();
    expect(item("copy-link")?.textContent?.trim()).toBe(COPY_LINK_DONE_LABEL);
  });

  it("이름 복사는 화면에 보이는 이름을 그대로 올린다", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mountRow({ title: "김인턴" });
    rightClick();
    clickItem("copy-name");
    await flush();
    expect(writeText).toHaveBeenCalledWith("김인턴");
  });

  it("클립보드가 없는 런타임은 「다시」라고 말하지 않는다", async () => {
    vi.stubGlobal("navigator", {});
    mountRow();
    rightClick();
    clickItem("copy-link");
    await flush();
    const banner = document.querySelector('[data-testid="channel-row-action-error"]');
    expect(banner?.textContent).toContain("클립보드");
    expect(banner?.textContent).not.toContain("다시");
  });
});

describe("나가기", () => {
  it("한 번의 무방비 클릭으로 발화하지 않는다 — 확인을 거친다", async () => {
    mountRow();
    rightClick();
    clickItem("leave");
    await flush();
    expect(removeChannelMember).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="channel-row-leave-confirm"]')
    ).not.toBeNull();
    const confirm = document.querySelector<HTMLElement>(
      '[data-testid="channel-row-leave-confirm-action"]'
    );
    act(() => confirm?.click());
    await flush();
    expect(removeChannelMember).toHaveBeenCalledWith(WS, CHANNEL_ID, ME);
  });

  it("DM 행에는 나가기가 없다 — 서버에 그 문이 없다", () => {
    mountRow({
      channel: channelFixture({ kind: "dm", name: undefined }),
      title: "김인턴",
    });
    rightClick();
    expect(item("leave")).toBeNull();
    expect(labels()).toEqual([
      CHANNEL_MARK_READ_LABEL,
      CHANNEL_MUTE_LABEL,
      COPY_LINK_ACTION_LABEL,
      "이름 복사하기",
    ]);
  });

  it("일반 멤버에게는 막다른 길을 내놓지 않는다", () => {
    mountRow({ selfRole: "member" });
    rightClick();
    expect(item("leave")).toBeNull();
  });
});

describe("키보드로 열고 Esc 로 닫는다", () => {
  it("Shift+F10 이 메뉴를 열고, Esc 가 포커스를 그 행으로 되돌린다", async () => {
    mountRow();
    const link = row();
    act(() => link.focus());
    expect(document.activeElement).toBe(link);

    pressKey(link, "F10", { shiftKey: true });
    expect(menu()).not.toBeNull();
    // 캐럿이 메뉴 안으로 들어갔다. 여기서 멈추면 「열렸다」의 절반만 증명한 것이다.
    await flush();
    expect(menu()?.contains(document.activeElement)).toBe(true);

    pressKey(document.activeElement, "Escape");
    expect(menu()).toBeNull();
    // 닫힘 복귀는 Radix 의 setTimeout(0) 에 실려 온다.
    await flush();
    expect(document.activeElement).toBe(link);
  });

  it("전용 메뉴 키도 같은 문이다", async () => {
    mountRow();
    const link = row();
    act(() => link.focus());
    pressKey(link, "ContextMenu");
    expect(menu()).not.toBeNull();
    await flush();
    pressKey(document.activeElement, "Escape");
    await flush();
    expect(document.activeElement).toBe(link);
  });

  it("아무 키나 열지 않는다 — Shift 없는 F10 도, 글자 키도", () => {
    // 이 시험이 없으면 위의 두 시험은 「keydown 을 쐈더니 초록」으로도 통과한다.
    mountRow();
    const link = row();
    act(() => link.focus());
    pressKey(link, "F10");
    expect(menu()).toBeNull();
    pressKey(link, "m");
    expect(menu()).toBeNull();
    pressKey(link, "ArrowDown");
    expect(menu()).toBeNull();
  });

  it("소환 키는 브라우저의 기본 동작을 가져간다 — 메뉴가 두 번 열리지 않는다", () => {
    mountRow();
    const link = row();
    act(() => link.focus());
    const event = new KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("터치 표면", () => {
  it("(hover: none) 에서는 롱프레스도 우클릭도 이 메뉴를 열지 않는다", () => {
    // 서랍의 세로 스크롤이 행을 누른 채 시작한다. 스크롤하려던 손이 메뉴를
    // 여는 것은 회귀이고, 손가락의 문은 채널을 연 뒤의 헤더 ⋮ 다.
    stubPointerSurface(true);
    mountRow();
    rightClick();
    expect(menu()).toBeNull();
    const link = row();
    act(() => link.focus());
    pressKey(link, "F10", { shiftKey: true });
    expect(menu()).toBeNull();
  });
});
