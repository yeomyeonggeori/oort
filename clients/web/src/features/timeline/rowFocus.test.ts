// @vitest-environment jsdom

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  focusRowStation,
  focusRowStationBySeq,
  scheduleFocusRowStationBySeq,
  handoffRowFocusToPreferred,
  isKeyboardRowFocus,
  nextRovingIndex,
  normalizeRow,
  useRowRovingFocus,
} from "./rowFocus";

function stubFocusVisible(el: HTMLElement, visible: boolean) {
  const proto = HTMLElement.prototype.matches;
  return vi.spyOn(el, "matches").mockImplementation(function (
    this: HTMLElement,
    selectors: string
  ) {
    if (selectors === ":focus-visible") {
      return visible && document.activeElement === this;
    }
    return proto.call(this, selectors);
  });
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let offsetParentDescriptor: PropertyDescriptor | undefined;
let mountedRoot: Root | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom에는 layout engine이 없어 offsetParent가 항상 null이다. rowFocus가
  // display:none 구성원을 버리는 제품 분기를 유지한 채, 이 픽스처의 붙어 있는
  // 버튼만 실제로 보이는 것으로 번역한다.
  offsetParentDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetParent"
  );
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  document.body.replaceChildren();
});

afterAll(() => {
  if (offsetParentDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetParent",
      offsetParentDescriptor
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

function action(kind?: "primary"): HTMLButtonElement {
  const button = document.createElement("button");
  button.setAttribute("data-row-action", kind ?? "");
  return button;
}

function RovingRow() {
  const ref = useRef<HTMLDivElement>(null);
  return createElement(
    "div",
    { ref, onKeyDown: useRowRovingFocus(ref), "data-testid": "row" },
    createElement("button", {
      "data-row-action": "primary",
      "data-testid": "primary",
    }),
    createElement("button", {
      "data-row-action": "",
      "data-testid": "secondary",
    })
  );
}

function mountRovingRow(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(createElement(RovingRow)));
  return host.querySelector<HTMLElement>('[data-testid="row"]')!;
}

// 행 하나가 키보드에 얼마를 청구하는가를 정하는 산수. 위아래는 타임라인의
// 스크롤이므로 이 함수는 좌우만 안다.
describe("nextRovingIndex", () => {
  it("→는 다음으로 가고 끝에서 처음으로 돈다", () => {
    expect(nextRovingIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextRovingIndex(2, 3, "ArrowRight")).toBe(0);
  });

  it("←는 이전으로 가고 처음에서 끝으로 돈다", () => {
    expect(nextRovingIndex(2, 3, "ArrowLeft")).toBe(1);
    expect(nextRovingIndex(0, 3, "ArrowLeft")).toBe(2);
  });

  it("위아래는 이 그룹의 키가 아니다: 타임라인이 스크롤해야 한다", () => {
    expect(nextRovingIndex(0, 3, "ArrowDown")).toBeNull();
    expect(nextRovingIndex(0, 3, "ArrowUp")).toBeNull();
  });

  it("Home·End도 넘긴다: 스크롤 컨테이너의 처음과 끝이 먼저다", () => {
    expect(nextRovingIndex(1, 3, "Home")).toBeNull();
    expect(nextRovingIndex(1, 3, "End")).toBeNull();
  });

  it("Enter·Tab·문자는 그대로 통과시킨다", () => {
    for (const key of ["Enter", " ", "Tab", "a", "Escape"]) {
      expect(nextRovingIndex(0, 2, key)).toBeNull();
    }
  });

  it("컨트롤이 하나뿐인 행에서는 제자리다", () => {
    expect(nextRovingIndex(0, 1, "ArrowRight")).toBe(0);
    expect(nextRovingIndex(0, 1, "ArrowLeft")).toBe(0);
  });

  it("빈 그룹은 아무 데도 가지 않는다", () => {
    expect(nextRovingIndex(0, 0, "ArrowRight")).toBeNull();
  });
});

describe("normalizeRow", () => {
  it("구성원이 없으면 행 자신만 탭 정거장으로 만든다", () => {
    const row = document.createElement("div");

    normalizeRow(row);

    expect(row.tabIndex).toBe(0);
  });

  it("구성원이 생기면 행 정거장을 내리고 primary 하나를 우선한다", () => {
    const row = document.createElement("div");
    const secondary = action();
    const primary = action("primary");
    row.tabIndex = 0;
    row.append(secondary, primary);

    normalizeRow(row);

    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(secondary.tabIndex).toBe(-1);
    expect(primary.tabIndex).toBe(0);
  });

  it("행 안에서 이미 focused인 구성원을 로빙 정거장으로 보존한다", () => {
    const row = document.createElement("div");
    const primary = action("primary");
    const focused = action();
    row.append(primary, focused);
    document.body.append(row);
    focused.focus();

    normalizeRow(row);

    expect(document.activeElement).toBe(focused);
    expect(primary.tabIndex).toBe(-1);
    expect(focused.tabIndex).toBe(0);
  });

  it("actionable 행은 rest에서 행이 정거장이고 아바타를 승격하지 않는다", () => {
    const row = document.createElement("div");
    row.dataset.actionable = "true";
    const avatar = action();
    row.append(avatar);

    normalizeRow(row);

    expect(row.tabIndex).toBe(0);
    expect(avatar.tabIndex).toBe(-1);
  });

  it("행이 포커스를 들고 있으면 구성원이 생겨도 tabindex를 떼지 않는다", () => {
    const row = document.createElement("div");
    row.dataset.actionable = "true";
    row.tabIndex = 0;
    document.body.append(row);
    row.focus();
    const primary = action("primary");
    row.append(primary);

    normalizeRow(row);

    expect(document.activeElement).toBe(row);
    expect(row.tabIndex).toBe(0);
    expect(primary.tabIndex).toBe(-1);
  });

  it("핸드오프 후 포커스된 primary만 정거장이다", () => {
    const row = document.createElement("div");
    row.dataset.actionable = "true";
    row.tabIndex = 0;
    const avatar = action();
    const primary = action("primary");
    row.append(avatar, primary);
    document.body.append(row);
    stubFocusVisible(row, true);
    row.focus();
    expect(isKeyboardRowFocus(row)).toBe(true);

    handoffRowFocusToPreferred(row);

    expect(document.activeElement).toBe(primary);
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(avatar.tabIndex).toBe(-1);
    expect(primary.tabIndex).toBe(0);
  });

  it("비-focus-visible 포커스 진입 시 핸드오프 미발동", () => {
    const row = document.createElement("div");
    row.dataset.actionable = "true";
    const primary = action("primary");
    row.append(primary);
    document.body.append(row);
    normalizeRow(row);
    stubFocusVisible(row, false);
    row.focus();
    expect(isKeyboardRowFocus(row)).toBe(false);

    handoffRowFocusToPreferred(row);

    expect(document.activeElement).toBe(row);
    expect(row.tabIndex).toBe(0);
    expect(primary.tabIndex).toBe(-1);
  });

  it("비구성원 포커스 중 normalize를 다시 돌려도 아바타를 0으로 남기지 않는다", () => {
    const row = document.createElement("div");
    row.dataset.actionable = "true";
    const avatar = action();
    const card = document.createElement("button");
    const primary = action("primary");
    row.append(avatar, card, primary);
    document.body.append(row);
    card.focus();

    normalizeRow(row);
    normalizeRow(row);

    expect(avatar.tabIndex).toBe(-1);
    expect(primary.tabIndex).toBe(0);
    expect(row.hasAttribute("tabindex")).toBe(false);
    const memberStops = [avatar, primary].filter((el) => el.tabIndex >= 0);
    expect(memberStops).toHaveLength(1);
  });
});

describe("useRowRovingFocus DOM lifecycle", () => {
  it("늦게 마운트된 구성원을 MutationObserver가 -1로 재정규화한다", async () => {
    const row = mountRovingRow();
    const late = action();
    late.dataset.testid = "late";

    row.append(late);

    await vi.waitFor(() => expect(late.tabIndex).toBe(-1));
    expect(
      Array.from(row.querySelectorAll<HTMLElement>("[data-row-action]")).filter(
        (item) => item.tabIndex === 0
      )
    ).toHaveLength(1);
  });

  it("focusout은 행 안 이동을 보존하고 행을 떠날 때만 primary를 복원한다", () => {
    const row = mountRovingRow();
    const primary = row.querySelector<HTMLElement>('[data-testid="primary"]')!;
    const secondary = row.querySelector<HTMLElement>(
      '[data-testid="secondary"]'
    )!;
    const outside = document.createElement("button");
    document.body.append(outside);
    primary.tabIndex = -1;
    secondary.tabIndex = 0;
    secondary.focus();

    secondary.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: primary })
    );
    expect(primary.tabIndex).toBe(-1);
    expect(secondary.tabIndex).toBe(0);

    secondary.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: outside })
    );
    expect(primary.tabIndex).toBe(0);
    expect(secondary.tabIndex).toBe(-1);
  });
});

describe("focusRowStation", () => {
  it("actionable rest 정거장인 행 자신에 포커스를 둔다", () => {
    const row = document.createElement("div");
    row.dataset.actionable = "true";
    row.dataset.testid = "timeline-message";
    row.dataset.seq = "12";
    const primary = action("primary");
    row.append(primary);
    document.body.append(row);

    focusRowStation(row);

    expect(document.activeElement).toBe(row);
    expect(row.tabIndex).toBe(0);
    expect(primary.tabIndex).toBe(-1);
  });

  it("data-seq로 착지 행을 고른다", () => {
    const row = document.createElement("div");
    row.dataset.testid = "timeline-message";
    row.dataset.seq = "41";
    document.body.append(row);

    expect(focusRowStationBySeq(41)).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(focusRowStationBySeq(99)).toBe(false);
  });

  it("아직 없는 행은 기한 안에 재시도한다", () => {
    const times: number[] = [];
    let now = 0;
    scheduleFocusRowStationBySeq(7, {
      now: () => now,
      untilMs: 100,
      schedule: (fn, ms) => {
        times.push(ms);
        now += ms;
        fn();
        return 0;
      },
    });
    expect(times.length).toBeGreaterThan(0);

    const row = document.createElement("div");
    row.dataset.testid = "timeline-message";
    row.dataset.seq = "8";
    document.body.append(row);
    scheduleFocusRowStationBySeq(8);
    expect(document.activeElement).toBe(row);
  });
});
