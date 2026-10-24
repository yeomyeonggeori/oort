// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetPointerTrailForTest } from "./pointerTrail";
import { SidebarRow } from "./SidebarRow";

// =============================================================================
// DM 행의 호버 X (#3963). SidebarRow 가 지는 것만 잰다: 언제 서고 언제 내려가는가, 무엇을
// 알리는가. 닫는 일의 실행은 사이드바의 몫이라 `Sidebar.dm.test.tsx` 가 잰다.
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

function stubPointer(hoverNone = false) {
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

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

function tree(
  props: Partial<Parameters<typeof SidebarRow>[0]>,
  wrapLink?: (link: ReactElement) => ReactElement
): ReactElement {
  return createElement(
    MemoryRouter,
    { initialEntries: ["/"] },
    createElement(
      "ul",
      null,
      createElement(SidebarRow, {
        to: "/c/00000000-0000-7000-8000-000000000301",
        icon: createElement("span", null, "이"),
        label: "이도현",
        testId: "channel-item",
        wrapLink,
        ...props,
      })
    )
  );
}

function mount(
  props: Partial<Parameters<typeof SidebarRow>[0]> = {},
  wrapLink?: (link: ReactElement) => ReactElement
): void {
  stubPointer(false);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(tree(props, wrapLink));
  });
}

/** 같은 루트에 다른 프롭으로 다시 그린다 - 행 요소(`<li>`)는 그대로 남는다. */
function update(props: Partial<Parameters<typeof SidebarRow>[0]>): void {
  act(() => {
    root?.render(tree(props));
  });
}

const li = () => document.querySelector("li") as HTMLElement;
const link = () => document.querySelector('[data-testid="channel-item"]') as HTMLElement;
const x = () => document.querySelector<HTMLButtonElement>('[data-testid="dm-close"]');
const enter = () => act(() => void li().dispatchEvent(new MouseEvent("mouseenter")));
const leave = () => act(() => void li().dispatchEvent(new MouseEvent("mouseleave")));

describe("호버 X 가 서는 조건", () => {
  it("닫는 손이 없는 행에는 X 도 위치 기준(relative)도 없다", () => {
    mount();
    enter();
    expect(x()).toBeNull();
    expect(li().className).not.toContain("relative");
    expect(link().hasAttribute("data-row-close")).toBe(false);
  });

  it("호버하지 않은 행에는 DOM 이 없다 — opacity·visibility 로 숨기지 않는다", () => {
    mount({ onClose: () => undefined });
    expect(x()).toBeNull();
    expect(li().className).toContain("relative");
    enter();
    expect(x()).not.toBeNull();
    leave();
    expect(x()).toBeNull();
  });

  it("누르면 닫는 손을 한 번 부른다. 행은 이동하지 않는다", () => {
    const onClose = vi.fn();
    mount({ onClose });
    enter();
    act(() => x()!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("호버 X 가 말하는 것", () => {
  it("이름은 어느 대화인지 말하고, 탭 정거장이 아니며, 링크 안이 아니다", () => {
    mount({ onClose: () => undefined, closeLabel: "이도현, 대화 닫기" });
    enter();
    expect(x()?.getAttribute("aria-label")).toBe("이도현, 대화 닫기");
    expect(x()?.getAttribute("title")).toBe("대화 닫기");
    expect(x()?.tabIndex).toBe(-1);
    expect(link().contains(x())).toBe(false);
  });

  it("이름이 없으면 낱말만 쓴다", () => {
    mount({ onClose: () => undefined });
    enter();
    expect(x()?.getAttribute("aria-label")).toBe("대화 닫기");
  });

  it("닫을 수 없는 행의 DOM 은 예전 그대로다: 오른쪽 끝의 것들을 묶는 상자가 없다", () => {
    mount({ unreadCount: 3 });
    expect(link().querySelector("[data-row-trailing]")).toBeNull();
    expect(link().querySelector('[data-testid="unread-count"]')).not.toBeNull();
  });

  it("서 있는 동안 링크가 알린다: 오른쪽 끝의 것들이 한 덩어리로 내려갈 수 있다", () => {
    mount({ onClose: () => undefined, unreadCount: 3 });
    const trailing = link().querySelector("[data-row-trailing]");
    expect(trailing?.querySelector('[data-testid="unread-count"]')).not.toBeNull();
    expect(link().hasAttribute("data-row-close")).toBe(false);
    enter();
    expect(link().hasAttribute("data-row-close")).toBe(true);
    leave();
    expect(link().hasAttribute("data-row-close")).toBe(false);
  });

  it("아이콘 자리의 종류를 말한다: 아바타만 표시가 선다", () => {
    mount({ iconKind: "avatar" });
    expect(link().querySelector("[data-row-icon]")?.getAttribute("data-icon-kind")).toBe(
      "avatar"
    );
    act(() => root?.unmount());
    root = null;
    host?.remove();
    mount();
    expect(link().querySelector("[data-row-icon]")?.hasAttribute("data-icon-kind")).toBe(false);
  });
});

describe("닫을 수 없던 행이 포인터를 둔 채 닫을 수 있게 바뀔 때 (design-review R4 M1 + 마이크로 델타 H)", () => {
  // 닫기를 내미는 규칙이 안 읽음 수에 따라 켜지고 꺼지면서(소유자 결정 2026-10-17), 호버 구독은 행이 닫을 수 있게 바뀌는
  // 순간에야 붙는다. 포인터가 이미 행 위에 있었으면 `mouseenter` 는 지나갔으니, 지금 포인터가 어디 있는지를 `:hover` 로 묻는다.
  // 그런데 그때 X 를 바로 세우면 안 읽음 알약을 누른 포인터 바로 밑에 서서, 같은 자리의 둘째 클릭(더블클릭)이 방금 뜬 X 를
  // 눌러 읽으려고 연 DM 을 열자마자 닫는다. 그래서 포인터가 **움직인 뒤에** 세운다(알려진 마지막 자리에서 8px 이상).
  // jsdom 은 `:hover` 를 모른다(항상 거짓): 행 요소에 포인터가 어디 있다는 답을 건다.
  function pointerIsOver(over: boolean): void {
    const row = li();
    const original = row.matches.bind(row);
    row.matches = (selector: string) => (selector === ":hover" ? over : original(selector));
  }
  /** 포인터가 (x, y) 로 움직였다고 알린다. 문서 전체의 기록과 행의 mousemove 둘 다 이 이벤트를 본다(버블링). */
  const moveTo = (x: number, y: number) =>
    act(() => void li().dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })));
  /** 포인터가 (x, y) 에서 행에 들어왔다고 알린다(좌표가 있는 mouseenter). */
  const enterAt = (x: number, y: number) =>
    act(() => void li().dispatchEvent(new MouseEvent("mouseenter", { clientX: x, clientY: y })));
  /** 행에 닿지 않는 곳에서 움직임을 알린다(문서의 기록만 갱신된다): 클릭 직전에 포인터가 있던 자리를 만든다. */
  const pointerWasAt = (x: number, y: number) =>
    act(() => void document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })));

  it("포인터가 행 위에 머문 채 닫을 수 있게 바뀌면 X 는 바로 서지 않는다 - 알약을 누른 클릭의 꼬리가 방금 뜬 X 를 누르지 않게", () => {
    mount({ unreadCount: 2 }); // 안 읽음이 있어 닫기를 내밀지 않는다: 구독도 없다
    pointerIsOver(true);
    pointerWasAt(292, 715); // 알약 자리를 눌렀다
    update({ unreadCount: 0, onClose: () => undefined }); // 열어서 읽는 중: 닫을 수 있다
    expect(x()).toBeNull();
    expect(link().hasAttribute("data-row-close")).toBe(false);
    moveTo(292, 715); // 같은 자리의 둘째 클릭: 움직임이 없다
    moveTo(294, 716); // 손의 흔들림(2px)은 움직임이 아니다
    expect(x()).toBeNull();
  });

  it("포인터가 움직이면 X 가 선다 - 흔들림을 넘는 거리면 이벤트 한 번으로도", () => {
    mount({ unreadCount: 2 });
    pointerIsOver(true);
    pointerWasAt(292, 715);
    update({ unreadCount: 0, onClose: () => undefined });
    expect(x()).toBeNull();
    moveTo(272, 715); // 20px, 이벤트 한 번(빠른 휙)
    expect(x()).not.toBeNull();
    expect(link().hasAttribute("data-row-close")).toBe(true);
  });

  it("움직임은 알려진 마지막 자리에서 잰다 - 8px 에 못 미치면 서지 않고 넘으면 선다", () => {
    mount({ unreadCount: 2 });
    pointerIsOver(true);
    pointerWasAt(100, 100);
    update({ unreadCount: 0, onClose: () => undefined });
    moveTo(107, 100); // 7px
    expect(x()).toBeNull();
    moveTo(109, 100); // 9px
    expect(x()).not.toBeNull();
  });

  it("포인터를 본 적 없으면 첫 움직임이 기준이 된다", () => {
    resetPointerTrailForTest();
    mount({ unreadCount: 2 });
    pointerIsOver(true);
    update({ unreadCount: 0, onClose: () => undefined });
    moveTo(50, 50); // 기준을 잡는다
    expect(x()).toBeNull();
    moveTo(53, 50); // 3px
    expect(x()).toBeNull();
    moveTo(70, 50); // 기준에서 20px
    expect(x()).not.toBeNull();
  });

  it("지켜보는 동안 같은 자리의 합성 mouseenter 는 X 를 세우지 않는다 - Chromium 은 눌린 알약이 사라지면 행에 mouseenter 를 쏜다", () => {
    mount({ unreadCount: 2 });
    pointerIsOver(true);
    pointerWasAt(292, 715);
    update({ unreadCount: 0, onClose: () => undefined });
    enterAt(292, 715); // 포인터는 그대로: 호버 사슬이 다시 서며 온 합성 이벤트
    expect(x()).toBeNull();
    enterAt(294, 716); // 흔들림 안
    expect(x()).toBeNull();
    moveTo(272, 715); // 진짜 움직임
    expect(x()).not.toBeNull();
  });

  it("지켜보는 동안 움직임이 따라온 mouseenter 는 X 를 세운다", () => {
    mount({ unreadCount: 2 });
    pointerIsOver(true);
    pointerWasAt(292, 715);
    update({ unreadCount: 0, onClose: () => undefined });
    enterAt(262, 715); // 기준에서 30px
    expect(x()).not.toBeNull();
  });

  it("포인터가 행 밖이면 닫을 수 있게 바뀌어도 X 는 서지 않는다 - 호버할 때만 선다", () => {
    mount({ unreadCount: 2 });
    pointerIsOver(false);
    update({ unreadCount: 0, onClose: () => undefined });
    moveTo(300, 300); // 행 밖에서 지켜보지 않는다: mousemove 를 들어도 서지 않는다
    expect(x()).toBeNull();
    enter();
    expect(x()).not.toBeNull();
  });

  it("행을 벗어났다 다시 들어오면 움직임 없이 바로 선다 - 평소 호버와 같다", () => {
    mount({ unreadCount: 2 });
    pointerIsOver(true);
    pointerWasAt(292, 715);
    update({ unreadCount: 0, onClose: () => undefined });
    expect(x()).toBeNull();
    leave();
    expect(x()).toBeNull();
    enter();
    expect(x()).not.toBeNull();
  });

  it("지켜보는 동안 행을 벗어나면 그 뒤 움직임으로는 서지 않는다(고착 X 없음)", () => {
    mount({ unreadCount: 2 });
    pointerIsOver(true);
    pointerWasAt(292, 715);
    update({ unreadCount: 0, onClose: () => undefined });
    leave();
    moveTo(200, 715); // 떠난 뒤 행 요소가 받은 움직임(경계에서 오는 늦은 이벤트)
    expect(x()).toBeNull();
  });

  it("닫을 수 없게 되면 내려가고, 포인터가 머문 채 다시 닫을 수 있게 되면 움직인 뒤에 또 선다", () => {
    mount({ onClose: () => undefined });
    pointerIsOver(true);
    enter();
    expect(x()).not.toBeNull();
    update({ unreadCount: 3 }); // 새 메시지: 안 읽음이 생겨 닫기를 내밀지 않는다
    expect(x()).toBeNull();
    expect(link().hasAttribute("data-row-close")).toBe(false);
    pointerWasAt(292, 715);
    update({ unreadCount: 0, onClose: () => undefined }); // 읽었다: 포인터는 아직 행 위에 있다
    expect(x()).toBeNull();
    moveTo(262, 715);
    expect(x()).not.toBeNull();
    leave(); // 행을 떠나면 내려간다
    expect(x()).toBeNull();
  });
});

describe("포털 메뉴로 포인터가 건너가면 X 가 내려간다", () => {
  it("브라우저의 실제 이벤트 순서(mouseover→mouseenter, mouseout→mouseleave)에서 남지 않는다", () => {
    // 우클릭 메뉴는 `document.body` 로 포털되지만 React 트리로는 이 행의 자손이다. React 의
    // `onMouseLeave` 는 포털 자손으로의 이동을 행 안의 이동으로 치므로, 그것으로 호버를 들으면
    // 포인터가 메뉴로 건너가도 leave 가 오지 않고 메뉴가 닫힌 뒤에도 X 가 남는다. DOM 으로는
    // 행 밖이라 네이티브 mouseenter/leave 가 맞다 - 이 순서를 브라우저가 쏘는 대로 재현한다.
    mount({ onClose: () => undefined }, (child) =>
      createElement(
        "span",
        null,
        child,
        createPortal(createElement("div", { "data-testid": "portal-menu" }, "메뉴"), document.body)
      )
    );
    const menu = document.querySelector('[data-testid="portal-menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    // 포인터가 바깥에서 행으로 들어온다.
    act(() => {
      link().dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      li().dispatchEvent(new MouseEvent("mouseenter"));
    });
    expect(x()).not.toBeNull();
    // 포인터가 행에서 포털 메뉴로 건너간다.
    act(() => {
      link().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: menu }));
      menu.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: link() }));
      li().dispatchEvent(new MouseEvent("mouseleave"));
    });
    expect(x()).toBeNull();
  });
});
