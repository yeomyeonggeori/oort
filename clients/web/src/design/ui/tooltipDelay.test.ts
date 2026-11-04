// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "@/design/motion";
import { Tooltip } from "./tooltip";
import { tooltipGroup } from "./tooltipGroup";

/**
 * 공용 툴팁의 지연 규칙 (#5192, 데스크탑 검수에서 툴팁이 느리다는 지적). 가짜 타이머로 **경계**에서 단정한다:
 *
 *   · 처음: 지연 한 틱 전엔 없고 정확히 그때 선다 (목표 ≤ 150)
 *   · 옮겨 다님: 떠 있거나 방금(`TOOLTIP_SKIP_DELAY_MS` 안) 닫혔으면 다음 툴팁은 시간이 흐르지 않아도 바로 선다
 *   · 쉰 뒤: 창이 지나면 다시 처음 지연부터다
 *   · 빠른 통과: 지연 안에 나간 포인터는 아무것도 못 띄우고, 무리를 깨우지도 않는다
 *   · 키보드: 지연 없이 즉시(기존 약속 그대로)
 *
 * 한 줄씩 사보타주로 붉게 만들어 본 것은 PR 인계의 표에 있다(지연을 되돌리면 첫 경계, 창 검사를 빼면 옮겨 다님, 닫힘 기록을
 * 빼면 Esc·언마운트 칸이 붉다).
 */

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete env.IS_REACT_ACT_ENVIRONMENT;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  tooltipGroup.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function trigger(id: string, label: string): ReactElement {
  return createElement(Tooltip, {
    key: id,
    label,
    children: createElement("button", { type: "button", id, "aria-label": label }, id),
  });
}

function mount(ids: Array<[string, string]>) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (list: Array<[string, string]>) =>
    act(() => root?.render(createElement("div", null, list.map(([id, label]) => trigger(id, label)))));
  render(ids);
  const button = (id: string) => host.querySelector<HTMLButtonElement>(`#${id}`) as HTMLButtonElement;
  const tip = (id: string) =>
    button(id).parentElement?.querySelector<HTMLElement>('[data-testid="tooltip"]') ?? null;
  return { host, button, tip, render };
}

function pointer(el: Element, type: "pointerover" | "pointerout" | "pointerdown", pointerType = "mouse") {
  const event = new MouseEvent(type, {
    bubbles: true,
    relatedTarget: type === "pointerout" ? document.body : null,
  });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  act(() => {
    el.dispatchEvent(event);
  });
}

function focusVisible(el: HTMLElement, visible: boolean) {
  const original = el.matches.bind(el);
  vi.spyOn(el, "matches").mockImplementation((selector: string) =>
    selector === ":focus-visible" ? visible : original(selector)
  );
}

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("툴팁 지연 상수(이슈 계약)", () => {
  it("처음 뜨는 지연은 목표 150 이하이고, 옮겨 다님의 창은 지연보다 길다", () => {
    expect(TOOLTIP_DELAY_MS).toBeGreaterThan(0);
    expect(TOOLTIP_DELAY_MS).toBeLessThanOrEqual(150);
    // 창이 지연보다 짧으면 「옮겨 가는 동안 닫혔다 다시 기다리는」 틈이 생긴다.
    expect(TOOLTIP_SKIP_DELAY_MS).toBeGreaterThan(TOOLTIP_DELAY_MS);
  });
});

describe("처음 가리킬 때", () => {
  it("지연 한 틱 전엔 없고 정확히 그때 선다", () => {
    vi.useFakeTimers();
    const { button, tip } = mount([["a", "답글 달기"]]);
    pointer(button("a"), "pointerover");
    advance(TOOLTIP_DELAY_MS - 1);
    expect(tip("a")).toBeNull();
    advance(1);
    expect(tip("a")?.textContent).toBe("답글 달기");
  });

  it("빠른 통과: 지연 안에 나가면 안 뜨고, 그 뒤에 다른 트리거를 가리켜도 처음 지연을 다시 기다린다", () => {
    vi.useFakeTimers();
    const { button, tip } = mount([
      ["a", "답글 달기"],
      ["b", "더 많은 액션"],
    ]);
    pointer(button("a"), "pointerover");
    advance(TOOLTIP_DELAY_MS - 1);
    pointer(button("a"), "pointerout");
    expect(tip("a")).toBeNull();

    // a는 한 번도 뜬 적이 없으므로 무리를 깨우지 않았다: b는 처음 지연을 기다린다.
    pointer(button("b"), "pointerover");
    expect(tip("b")).toBeNull();
    advance(TOOLTIP_DELAY_MS - 1);
    expect(tip("b")).toBeNull();
    advance(1);
    expect(tip("b")).not.toBeNull();
  });
});

describe("옮겨 다닐 때", () => {
  function openThenLeave(
    ctx: ReturnType<typeof mount>,
    id: string,
    how: "leave" | "escape" | "press" | "blur" = "leave"
  ) {
    pointer(ctx.button(id), "pointerover");
    advance(TOOLTIP_DELAY_MS);
    expect(ctx.tip(id)).not.toBeNull();
    if (how === "leave") pointer(ctx.button(id), "pointerout");
    if (how === "press") pointer(ctx.button(id), "pointerdown");
    if (how === "escape") {
      act(() => {
        ctx.button(id).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    }
    if (how === "blur") {
      // 포인터로 열린 툴팁도 초점이 나가면 닫힌다(포커스 이벤트는 초점이 있어야 오므로 직접 쏜다).
      act(() => {
        ctx.button(id).dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
    }
    expect(ctx.tip(id)).toBeNull();
  }

  it("방금 닫혔으면 다음 트리거는 시간이 흐르지 않아도 바로 선다", () => {
    vi.useFakeTimers();
    const ctx = mount([
      ["a", "답글 달기"],
      ["b", "더 많은 액션"],
    ]);
    openThenLeave(ctx, "a");
    pointer(ctx.button("b"), "pointerover");
    expect(ctx.tip("b")?.textContent).toBe("더 많은 액션");
  });

  it("창의 가장자리: 닫힌 지 창 − 1에는 바로, 창이 지나면 처음 지연부터다", () => {
    vi.useFakeTimers();
    const ctx = mount([
      ["a", "답글 달기"],
      ["b", "더 많은 액션"],
    ]);
    openThenLeave(ctx, "a");
    advance(TOOLTIP_SKIP_DELAY_MS - 1);
    pointer(ctx.button("b"), "pointerover");
    expect(ctx.tip("b")).not.toBeNull();
    pointer(ctx.button("b"), "pointerout");

    // 같은 트리거를 이번에는 창이 끝난 뒤에 가리킨다.
    advance(TOOLTIP_SKIP_DELAY_MS);
    pointer(ctx.button("b"), "pointerover");
    expect(ctx.tip("b")).toBeNull();
    advance(TOOLTIP_DELAY_MS - 1);
    expect(ctx.tip("b")).toBeNull();
    advance(1);
    expect(ctx.tip("b")).not.toBeNull();
  });

  it("닫는 길이 무엇이든(Esc·눌림·초점 나감) 같은 창을 연다", () => {
    for (const how of ["escape", "press", "blur"] as const) {
      vi.useFakeTimers();
      const ctx = mount([
        ["a", "답글 달기"],
        ["b", "더 많은 액션"],
      ]);
      openThenLeave(ctx, "a", how);
      pointer(ctx.button("b"), "pointerover");
      expect(ctx.tip("b"), `${how} 뒤 옮겨 가기`).not.toBeNull();
      act(() => root?.unmount());
      root = null;
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("떠 있는 트리거가 사라져도(행의 도구 막대가 걷힘) 창이 열린다", () => {
    vi.useFakeTimers();
    const ctx = mount([
      ["a", "답글 달기"],
      ["b", "더 많은 액션"],
    ]);
    pointer(ctx.button("a"), "pointerover");
    advance(TOOLTIP_DELAY_MS);
    expect(ctx.tip("a")).not.toBeNull();
    ctx.render([["b", "더 많은 액션"]]);
    pointer(ctx.button("b"), "pointerover");
    expect(ctx.tip("b")).not.toBeNull();
  });

  it("떠 있는 동안에는 시간이 지나도 다음 트리거가 바로 선다(키보드로 연 툴팁 곁을 가리킴)", () => {
    vi.useFakeTimers();
    const ctx = mount([
      ["a", "답글 달기"],
      ["b", "더 많은 액션"],
    ]);
    focusVisible(ctx.button("a"), true);
    act(() => ctx.button("a").focus());
    expect(ctx.tip("a")).not.toBeNull();
    advance(TOOLTIP_SKIP_DELAY_MS * 3);
    pointer(ctx.button("b"), "pointerover");
    expect(ctx.tip("b")).not.toBeNull();
  });
});

describe("키보드·터치", () => {
  it("키보드 초점은 지연 없이 즉시 뜬다(무리의 상태와 무관)", () => {
    vi.useFakeTimers();
    const { button, tip } = mount([["a", "답글 달기"]]);
    focusVisible(button("a"), true);
    act(() => button("a").focus());
    expect(tip("a")?.textContent).toBe("답글 달기");
  });

  it("터치 포인터는 무리가 열려 있어도 띄우지 않는다", () => {
    vi.useFakeTimers();
    const ctx = mount([
      ["a", "답글 달기"],
      ["b", "더 많은 액션"],
    ]);
    pointer(ctx.button("a"), "pointerover");
    advance(TOOLTIP_DELAY_MS);
    expect(ctx.tip("a")).not.toBeNull();
    pointer(ctx.button("b"), "pointerover", "touch");
    advance(TOOLTIP_SKIP_DELAY_MS * 2);
    expect(ctx.tip("b")).toBeNull();
  });
});

describe("무리(tooltipGroup)", () => {
  it("마운트된 툴팁이 하나도 없으면 기억을 비운다(시험이 서로 새지 않는 근거)", () => {
    vi.useFakeTimers();
    const detach = tooltipGroup.attach();
    tooltipGroup.opened();
    expect(tooltipGroup.delayFor(TOOLTIP_DELAY_MS)).toBe(0);
    tooltipGroup.closed();
    expect(tooltipGroup.delayFor(TOOLTIP_DELAY_MS)).toBe(0);
    detach();
    expect(tooltipGroup.delayFor(TOOLTIP_DELAY_MS)).toBe(TOOLTIP_DELAY_MS);
  });

  it("닫힘이 열림보다 많이 와도 음수로 내려가지 않고 창을 엉뚱하게 열지 않는다", () => {
    vi.useFakeTimers();
    tooltipGroup.attach();
    tooltipGroup.closed();
    expect(tooltipGroup.delayFor(TOOLTIP_DELAY_MS)).toBe(TOOLTIP_DELAY_MS);
  });
});
