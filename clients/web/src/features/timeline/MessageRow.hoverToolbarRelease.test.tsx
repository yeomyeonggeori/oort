// @vitest-environment jsdom
// #5328: 「더 많은 기능」(⋮) 메뉴를 열었다 닫거나 메뉴에서 행동을 고른 뒤, 포인터가 그 메시지를 떠났으면 호버 도구 막대가 바로 내려간다.
//
// 재현은 브라우저가 쏘는 이벤트 순서 그대로다(실측: `scripts/capture-5328.mjs`, Chromium):
//   ① 포인터가 행에서 ⋮ 메뉴(포털, DOM 으로는 행 밖)로 건너간다 — `mouseout`/`mouseover` 쌍과 행의 **네이티브** `mouseleave`.
//      React 의 `onMouseLeave` 는 포털 자손을 행 안으로 쳐서 이 이동에 leave 를 주지 않는다(SidebarRow 가 같은 이유로 네이티브를 쓴다, #3963).
//   ② 행동을 고르면 메뉴 항목이 포인터 밑에서 사라진다. 사라진 노드는 `mouseout` 을 쏘지 못한다: 브라우저는 포인터 밑의 새 요소에
//      `relatedTarget: null` 인 `mouseover`(와 `mouseenter`)만 쏜다.
//   ③ Radix 가 닫으며 초점을 ⋮ 단추(도구 막대 안)로 돌려준다. 마우스로 시작한 흐름의 이 초점은 `:focus-visible` 이 아니다.
// 옛 구현은 ①에서 「호버 중」을 못 내리고(②에서도 못 내리고), ③의 초점을 「행에 초점 있음」으로 세어 포인터가 떠난 행의 막대를 붙들었다.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { MessageRow } from "./MessageRow";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const ROW_A = "0199eeee-0000-7000-8000-000000000a01";
const ROW_B = "0199eeee-0000-7000-8000-000000000b02";

vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
/** 브라우저의 입력 방식 판정을 시험이 쥔다: 마우스로 시작한 흐름이면 거짓, 키보드로 시작했으면 참. */
let focusVisible = false;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
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

beforeEach(() => {
  focusVisible = false;
  const original = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    if (selector === ":focus-visible") return focusVisible && document.activeElement === this;
    return original.call(this, selector);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
});

function member(id: string, displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName,
    handle,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function message(id: string, seq: number, authorMemberId: string, body: string): Message {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId,
    type: "text",
    body,
    state: "sent",
    createdAtMs: seq * 1000,
  };
}

const onTogglePin = vi.fn(async () => undefined);
const actions = {
  myMemberId: ME,
  chips: [],
  pinned: false,
  onToggleReaction: async () => undefined,
  onTogglePin,
  onEditMessage: async () => undefined,
  onDeleteMessage: async () => undefined,
};

/** 서로 이웃한 두 행: 위(A)는 내 글, 아래(B)는 남의 글. 같은 목록이라 포인터가 A 에서 B 로 닿는다. */
function mountPair(): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const directory = makeDirectory([member(OTHER, "이도현", "dohyeon"), member(ME, "박서연", "seoyeon")]);
  const rows: ReactElement[] = [
    createElement(MessageRow, {
      key: "a",
      message: message(ROW_A, 7, ME, "회의 시간은 3시예요"),
      startsGroup: true,
      directory,
      actions,
    }),
    createElement(MessageRow, {
      key: "b",
      message: message(ROW_B, 8, OTHER, "알겠어요, 자료는 제가 챙길게요"),
      startsGroup: true,
      directory,
      actions,
    }),
  ];
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          SessionProvider,
          { value: sessionValue() },
          createElement(
            OpenMemberProfileContext.Provider,
            { value: () => undefined },
            createElement(QueryClientProvider, { client }, createElement("div", null, rows))
          )
        )
      )
    );
  });
  return host;
}

const rowOf = (root: HTMLElement, seq: number) =>
  root.querySelector<HTMLElement>(`[data-testid="timeline-message"][data-seq="${String(seq)}"]`) as HTMLElement;
const toolbarOf = (row: HTMLElement) => row.querySelector('[data-testid="message-hover-toolbar"]');
const toolbarCount = (root: HTMLElement) => root.querySelectorAll('[data-testid="message-hover-toolbar"]').length;
const menu = () => document.querySelector<HTMLElement>('[data-testid="message-action-menu"]');

/** 포인터가 `from` 에서 `to` 로 건너온다: 브라우저가 쏘는 `mouseout`·`mouseover` 쌍과, 떠난·들어간 상자의 네이티브 enter/leave. */
function crossInto(to: HTMLElement, from: HTMLElement | null, entered: HTMLElement[] = [to], left: HTMLElement[] = []) {
  act(() => {
    from?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to }));
    for (const el of left) el.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: to }));
    to.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: from }));
    for (const el of entered) el.dispatchEvent(new MouseEvent("mouseenter", { relatedTarget: from }));
  });
}

/** 포인터 밑에서 노드가 사라져 새 요소가 포인터 밑에 선다: `mouseout` 은 없고 `relatedTarget: null` 인 `mouseover` 만 온다. */
function pointerSurfacesOver(target: HTMLElement, entered: HTMLElement[] = [target]) {
  act(() => {
    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    for (const el of entered) el.dispatchEvent(new MouseEvent("mouseenter", { relatedTarget: null }));
  });
}

async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 마우스로 ⋮ 를 열고 메뉴 항목으로 포인터를 옮긴다. 행 A 에 호버한 채 시작한다. */
async function openMenuByMouse(root: HTMLElement): Promise<HTMLElement> {
  const a = rowOf(root, 7);
  crossInto(a, null);
  expect(toolbarOf(a), "호버로 막대가 선다").not.toBeNull();
  const trigger = a.querySelector<HTMLElement>('[data-testid="message-actions-trigger"]') as HTMLElement;
  act(() => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  await tick();
  const item = document.querySelector<HTMLElement>('[data-testid="menu-pin"]');
  expect(menu(), "메뉴가 열린다").not.toBeNull();
  expect(item, "고정 항목").not.toBeNull();
  // 포인터가 ⋮ 에서 메뉴(포털)로 건너간다: DOM 으로는 행을 떠났다.
  crossInto(item as HTMLElement, trigger, [item as HTMLElement], [a]);
  return item as HTMLElement;
}

/** 항목을 마우스로 누른다. 메뉴는 닫히고, Radix 가 초점을 ⋮ 로 돌려준다. */
async function pickByMouse(item: HTMLElement) {
  act(() => {
    item.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    item.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await tick();
}

describe("메뉴에서 행동을 고른 뒤", () => {
  it("포인터가 그 메시지를 떠났으면 막대가 바로 내려가고, 포인터가 선 메시지의 막대 하나만 남는다", async () => {
    const root = mountPair();
    const item = await openMenuByMouse(root);
    expect(toolbarOf(rowOf(root, 7)), "메뉴가 열린 동안은 막대가 닻이라 남는다").not.toBeNull();

    await pickByMouse(item);
    expect(menu(), "메뉴가 닫혔다").toBeNull();
    // 메뉴 항목이 사라진 자리에 아래 메시지(B)가 포인터 밑에 선다.
    pointerSurfacesOver(rowOf(root, 8).querySelector<HTMLElement>("[data-row-body]") ?? rowOf(root, 8), [rowOf(root, 8)]);

    expect(onTogglePin).toHaveBeenCalled();
    expect(toolbarOf(rowOf(root, 7)), "포인터가 떠난 A 의 막대는 사라진다").toBeNull();
    expect(toolbarOf(rowOf(root, 8)), "포인터가 선 B 의 막대").not.toBeNull();
    expect(toolbarCount(root), "두 메시지에 막대가 동시에 남지 않는다").toBe(1);
  });

  it("포인터가 아무 행에도 없으면 막대가 하나도 남지 않는다", async () => {
    const root = mountPair();
    const item = await openMenuByMouse(root);
    await pickByMouse(item);
    expect(menu()).toBeNull();
    expect(toolbarCount(root)).toBe(0);
  });

  it("포인터가 그 메시지 위로 돌아오면 막대는 그대로다(떠난 적이 없는 것과 같다)", async () => {
    const root = mountPair();
    const item = await openMenuByMouse(root);
    await pickByMouse(item);
    // 메뉴가 A 의 몸 위로 펼쳐졌다가 접혀, 포인터가 다시 A 위에 선다.
    pointerSurfacesOver(rowOf(root, 7).querySelector<HTMLElement>("[data-row-body]") ?? rowOf(root, 7), [rowOf(root, 7)]);
    expect(toolbarOf(rowOf(root, 7))).not.toBeNull();
    expect(toolbarCount(root)).toBe(1);
  });
});

describe("메뉴를 열었다 닫을 때", () => {
  it("Esc 없이 바깥을 눌러 닫아도, 포인터가 떠난 행의 막대는 남지 않는다", async () => {
    const root = mountPair();
    await openMenuByMouse(root);
    const b = rowOf(root, 8);
    // 포인터가 메뉴에서 B 로 건너가 B 를 누른다(Radix 는 바깥 누름으로 닫는다).
    crossInto(b, document.querySelector<HTMLElement>('[data-testid="menu-pin"]'), [b]);
    act(() => {
      b.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      b.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await tick();
    expect(menu()).toBeNull();
    expect(toolbarOf(rowOf(root, 7))).toBeNull();
    expect(toolbarCount(root)).toBe(1);
  });
});

describe("막대 단추를 마우스로 누른 뒤", () => {
  it("단추가 초점을 쥐고 있어도 포인터가 행을 떠나면 막대가 내려간다(마우스 초점은 막대를 붙들지 않는다)", async () => {
    const root = mountPair();
    const a = rowOf(root, 7);
    crossInto(a, null);
    const react = a.querySelector<HTMLElement>('[data-testid^="toolbar-react-"]') as HTMLElement;
    expect(react, "호버로 막대가 선다").not.toBeNull();
    // Chromium 은 단추를 누르면 그 단추에 초점을 둔다. 마우스 흐름이라 `:focus-visible` 이 아니다.
    act(() => react.focus());
    expect(document.activeElement).toBe(react);
    expect(toolbarOf(a), "포인터가 아직 행 위다").not.toBeNull();
    crossInto(rowOf(root, 8), a, [rowOf(root, 8)], [a]);
    expect(toolbarOf(a), "포인터가 떠난 행의 막대는 초점이 남아도 사라진다").toBeNull();
    expect(toolbarCount(root)).toBe(1);
  });
});

describe("키보드로 고른 뒤", () => {
  it("초점이 ⋮ 로 돌아오면 막대는 남는다(키보드 사용자가 자리를 잃지 않는다)", async () => {
    focusVisible = true;
    const root = mountPair();
    const a = rowOf(root, 7);
    // 키보드로 행에 닿으면 막대가 서고 초점은 ⋮ 로 넘어간다.
    await vi.waitFor(() => expect(a.tabIndex).toBe(0));
    act(() => a.focus());
    await tick();
    const trigger = a.querySelector<HTMLElement>('[data-testid="message-actions-trigger"]');
    expect(trigger, "초점이 들어오면 막대가 선다").not.toBeNull();
    act(() => trigger?.focus());
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await tick();
    const item = document.querySelector<HTMLElement>('[data-testid="menu-pin"]');
    expect(item, "메뉴가 열린다").not.toBeNull();
    act(() => {
      item?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await tick();
    expect(menu()).toBeNull();
    expect(document.activeElement, "초점이 ⋮ 로 돌아왔다").toBe(a.querySelector('[data-testid="message-actions-trigger"]'));
    expect(toolbarOf(a), "키보드 초점이 막대 안에 있으니 남는다").not.toBeNull();
  });
});

describe("키보드로 연 메뉴를 마우스로 닫을 때", () => {
  it("초점을 쥔 채 사라진 메뉴가 낡은 초점을 남기지 않는다: 바깥을 누르면 막대가 내려간다", async () => {
    focusVisible = true;
    const root = mountPair();
    const a = rowOf(root, 7);
    await vi.waitFor(() => expect(a.tabIndex).toBe(0));
    act(() => a.focus());
    await tick();
    const trigger = a.querySelector<HTMLElement>('[data-testid="message-actions-trigger"]');
    expect(trigger, "키보드 초점으로 막대가 선다").not.toBeNull();
    act(() => trigger?.focus());
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await tick();
    expect(menu(), "메뉴가 열린다(초점은 메뉴 안이다)").not.toBeNull();
    // 사람이 마우스로 바꿔 B 를 누른다: Radix 는 바깥 누름으로 닫으면 초점을 ⋮ 로 돌려주지 않고, 메뉴는 초점을 쥔 채 사라진다(blur 없음).
    focusVisible = false;
    const b = rowOf(root, 8);
    act(() => {
      b.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      b.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await tick();
    expect(menu()).toBeNull();
    expect(document.activeElement, "초점이 ⋮ 로 돌아오지 않았다").not.toBe(a.querySelector('[data-testid="message-actions-trigger"]'));
    expect(toolbarOf(a), "낡은 「초점 있음」 때문에 막대가 남지 않는다").toBeNull();
  });
});
