// @vitest-environment jsdom

import {
  act,
  cloneElement,
  createContext,
  createElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { ChannelHeaderMenu } from "./ChannelHeaderMenu";

// =============================================================================
// #2741 R1 M1 — 넘긴 다이얼로그는 **그 선택의** 메뉴가 내려갈 때만 연다.
//
// 헤더 ⋮ 는 주제/나가기 다이얼로그를 메뉴 콘텐츠가 실제로 언마운트될 때
// (`onCloseAutoFocus`) 연다. 선택과 언마운트 사이에는 창이 있다: Radix 는
// 닫힌 콘텐츠를 Presence 가 내릴 때까지 들고 있다. 그 창에서 ⋮ 를 다시 열면
// 콘텐츠는 끝내 언마운트되지 않고, 이어서 **선택 없이** 닫으면 그때의
// `onCloseAutoFocus` 가 앞 선택의 열쇠를 읽어 다이얼로그를 연다 — 검수 실측
// (Playwright force 클릭) 3/8.
//
// jsdom 은 Presence 를 즉시 내리므로 그 창을 스스로 만들지 못한다. 그래서
// 드롭다운 그릇을 가짜로 바꾸고 「콘텐츠가 이제 내려갔다」를 시험이 직접
// 발화한다. 가짜가 대신하는 것은 여닫힘과 언마운트 시점뿐이고, 판정은
// ChannelHeaderMenu 의 실제 코드가 한다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";

const menu = vi.hoisted(() => ({
  onCloseAutoFocus: null as ((event: Event) => void) | null,
}));

vi.mock("@/design/ui/dropdown-menu", async () => {
  const React = await import("react");
  type MenuCtx = { open: boolean; onOpenChange: (next: boolean) => void };
  const Ctx = createContext<MenuCtx>({ open: false, onOpenChange: () => undefined });
  const passthrough =
    (tag: string) =>
    ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => {
      const { tone: _tone, ...dom } = rest;
      void _tone;
      return React.createElement(tag, dom, children);
    };
  return {
    DropdownMenu: ({
      open,
      onOpenChange,
      children,
    }: MenuCtx & { children: ReactNode }) =>
      React.createElement(Ctx.Provider, { value: { open, onOpenChange } }, children),
    DropdownMenuTrigger: ({ children }: { children: ReactElement<{ onClick?: () => void }> }) => {
      const ctx = useContext(Ctx);
      return cloneElement(children, { onClick: () => ctx.onOpenChange(!ctx.open) });
    },
    DropdownMenuContent: ({
      children,
      onCloseAutoFocus,
      ...rest
    }: {
      children: ReactNode;
      onCloseAutoFocus?: (event: Event) => void;
    } & Record<string, unknown>) => {
      const ctx = useContext(Ctx);
      // 가장 최근 렌더의 콜백을 쥔다: 실제 Radix 도 언마운트 시점의 prop 을 부른다.
      menu.onCloseAutoFocus = onCloseAutoFocus ?? null;
      return ctx.open ? React.createElement("div", rest, children) : null;
    },
    DropdownMenuItem: ({
      children,
      onSelect,
      ...rest
    }: {
      children?: ReactNode;
      onSelect?: (event: Event) => void;
    } & Record<string, unknown>) => {
      const { tone: _tone, ...dom } = rest;
      void _tone;
      return React.createElement(
        "button",
        { ...dom, type: "button", onClick: () => onSelect?.(new Event("select", { cancelable: true })) },
        children
      );
    },
    DropdownMenuLabel: passthrough("div"),
    DropdownMenuRadioGroup: passthrough("div"),
    DropdownMenuRadioItem: passthrough("div"),
    DropdownMenuSeparator: passthrough("hr"),
    DropdownMenuGroup: passthrough("div"),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  menu.onCloseAutoFocus = null;
  resetEscapeLayers();
});

function mountMenu() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const channel: Channel = {
    id: CHANNEL_ID,
    workspaceId: WS,
    kind: "public",
    name: "general",
    muted: false,
    topic: "릴리스 전 점검 채널",
  };
  client.setQueryData<Channel[]>(["channels", WS], [channel]);
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/c/${CHANNEL_ID}`] },
        createElement(
          QueryClientProvider,
          { client },
          createElement(ChannelHeaderMenu, {
            workspaceId: WS,
            channel,
            title: "general",
            selfMemberId: ME,
            selfRole: "owner" as const,
          })
        )
      )
    );
  });
}

function click(id: string) {
  const target = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!target) throw new Error(`없다: ${id}`);
  act(() => target.click());
}

/** 닫힌 콘텐츠가 마침내 언마운트된다 — Radix 가 이때 onCloseAutoFocus 를 부른다. */
function contentUnmounts() {
  const handler = menu.onCloseAutoFocus;
  if (!handler) throw new Error("onCloseAutoFocus 가 없다");
  act(() => handler(new Event("focusScope.autoFocusOnUnmount", { cancelable: true })));
}

const topicDialogOpen = () =>
  document.querySelector('[data-testid="channel-topic-dialog"]') !== null;

describe("ChannelHeaderMenu handoff (#2741)", () => {
  it("opens the topic dialog once the menu that chose it has unmounted", () => {
    mountMenu();
    click("channel-title-menu");
    click("channel-topic");
    expect(topicDialogOpen()).toBe(false);
    contentUnmounts();
    expect(topicDialogOpen()).toBe(true);
  });

  it("forgets the handed-off choice when the menu reopens before unmounting (R1 M1)", () => {
    mountMenu();
    click("channel-title-menu");
    click("channel-topic");
    // 콘텐츠가 내려가기 전에 ⋮ 를 다시 연다.
    click("channel-title-menu");
    // 이번에는 아무것도 고르지 않고 닫는다(Esc 와 같은 onOpenChange(false)).
    click("channel-title-menu");
    contentUnmounts();
    expect(topicDialogOpen()).toBe(false);
  });
});
