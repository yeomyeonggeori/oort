// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Slider, sliderKeyTarget } from "./ui/slider";

// AP-3(#4190) AC 4: 방향키 1, PageUp·PageDown 10, Home·End은 끝, `aria-valuetext`, 범위 [하한, 95].
// 키보드 모델은 `sliderKeyTarget` 표 하나가 정본이고, 컴포넌트는 그 표를 읽는다. jsdom의 range 입력은 키로
// 움직이지 않으므로(브라우저 기본 동작이 없다) 시험이 보는 값은 모두 이 파일의 핸들러가 만든 것이다.

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function Harness({
  initial,
  min,
  max,
  step,
  pageStep,
  onChange,
  disabled,
}: {
  initial: number;
  min: number;
  max: number;
  step?: number;
  pageStep?: number;
  onChange?: (value: number) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return createElement(Slider, {
    value,
    min,
    max,
    step,
    pageStep,
    disabled,
    onValueChange: (next: number) => {
      setValue(next);
      onChange?.(next);
    },
    valueText: (v: number) => `${v}% 불투명`,
    labelledBy: "label-id",
    describedBy: "desc-id",
    testId: "slider",
  });
}

function mount(props: Parameters<typeof Harness>[0]): HTMLInputElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(Harness, props)));
  const input = host.querySelector<HTMLInputElement>('[data-testid="slider"]');
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

function press(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    input.dispatchEvent(event);
  });
  return event;
}

describe("sliderKeyTarget — 키보드 모델의 표", () => {
  const range = { min: 70, max: 95, step: 1, pageStep: 10 };

  it("화살표 ±1, PageUp·PageDown ±10, Home·End은 끝이다", () => {
    expect(sliderKeyTarget("ArrowRight", 80, range)).toBe(81);
    expect(sliderKeyTarget("ArrowUp", 80, range)).toBe(81);
    expect(sliderKeyTarget("ArrowLeft", 80, range)).toBe(79);
    expect(sliderKeyTarget("ArrowDown", 80, range)).toBe(79);
    expect(sliderKeyTarget("PageUp", 80, range)).toBe(90);
    expect(sliderKeyTarget("PageDown", 80, range)).toBe(70);
    expect(sliderKeyTarget("Home", 80, range)).toBe(70);
    expect(sliderKeyTarget("End", 80, range)).toBe(95);
  });

  it("범위 밖으로 나가지 않는다", () => {
    expect(sliderKeyTarget("ArrowRight", 95, range)).toBe(95);
    expect(sliderKeyTarget("ArrowLeft", 70, range)).toBe(70);
    expect(sliderKeyTarget("PageUp", 90, range)).toBe(95);
    expect(sliderKeyTarget("PageDown", 75, range)).toBe(70);
  });

  it("슬라이더의 키가 아니면 null이다(탭·글자·스페이스는 그대로 흘러간다)", () => {
    for (const key of ["Tab", "Enter", " ", "a", "Escape", "Shift"]) {
      expect(sliderKeyTarget(key, 80, range), key).toBeNull();
    }
  });
});

describe("Slider", () => {
  it("값·범위·이름·설명·`aria-valuetext`가 입력에 선다", () => {
    const input = mount({ initial: 80, min: 70, max: 95 });
    expect(input.type).toBe("range");
    expect(input.min).toBe("70");
    expect(input.max).toBe("95");
    expect(input.value).toBe("80");
    expect(input.step).toBe("1");
    expect(input.getAttribute("aria-valuetext")).toBe("80% 불투명");
    expect(input.getAttribute("aria-labelledby")).toBe("label-id");
    expect(input.getAttribute("aria-describedby")).toBe("desc-id");
    expect(input.getAttribute("aria-label")).toBeNull();
  });

  it("방향키는 한 칸씩, PageUp·PageDown은 열 칸씩 움직이고 값 문장도 따라간다", () => {
    const seen: number[] = [];
    const input = mount({ initial: 80, min: 70, max: 95, onChange: (v) => seen.push(v) });
    press(input, "ArrowRight");
    expect(input.value).toBe("81");
    expect(input.getAttribute("aria-valuetext")).toBe("81% 불투명");
    press(input, "ArrowLeft");
    press(input, "ArrowLeft");
    expect(input.value).toBe("79");
    press(input, "PageUp");
    expect(input.value).toBe("89");
    press(input, "PageDown");
    press(input, "PageDown");
    expect(input.value).toBe("70");
    press(input, "End");
    expect(input.value).toBe("95");
    press(input, "Home");
    expect(input.value).toBe("70");
    expect(seen).toEqual([81, 80, 79, 89, 79, 70, 95, 70]);
  });

  it("받은 키는 preventDefault한다(브라우저가 한 번 더 움직이지 않게). 값이 그대로여도 키는 삼킨다", () => {
    const input = mount({ initial: 95, min: 70, max: 95 });
    const event = press(input, "ArrowRight");
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe("95");
    expect(press(input, "Tab").defaultPrevented).toBe(false);
  });

  it("수정자 키(Ctrl·Meta·Alt)가 눌린 조합은 건드리지 않는다", () => {
    const onChange = vi.fn();
    const input = mount({ initial: 80, min: 70, max: 95, onChange });
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const event = press(input, "ArrowRight", init);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("범위가 한 점(하한 95 = 최대 95)이면 잠긴다: 키도 받지 않는다", () => {
    const onChange = vi.fn();
    const input = mount({ initial: 95, min: 95, max: 95, onChange });
    expect(input.disabled).toBe(true);
    press(input, "ArrowLeft");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("95");
  });

  it("disabled면 잠긴다", () => {
    const onChange = vi.fn();
    const input = mount({ initial: 80, min: 70, max: 95, onChange, disabled: true });
    expect(input.disabled).toBe(true);
    press(input, "PageUp");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("범위 밖으로 들어온 값은 보이는 값만 범위에 맞춘다(저장값을 쓰지 않는다)", () => {
    const onChange = vi.fn();
    const input = mount({ initial: 40, min: 70, max: 95, onChange });
    expect(input.value).toBe("70");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("끌기(input 이벤트)로 들어온 값도 범위에 맞춰 올린다", () => {
    const seen: number[] = [];
    const input = mount({ initial: 80, min: 70, max: 95, onChange: (v) => seen.push(v) });
    const setNative = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setNative?.call(input, "88");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(seen).toEqual([88]);
    expect(input.value).toBe("88");
  });

  it("트랙의 채움은 CSSOM 변수 `--slider-fraction`이 나른다(JSX style 없음)", () => {
    const input = mount({ initial: 70, min: 70, max: 95 });
    expect(input.getAttribute("style") ?? "").toContain("--slider-fraction: 0");
    press(input, "End");
    expect(input.style.getPropertyValue("--slider-fraction")).toBe("1");
    press(input, "Home");
    press(input, "PageUp");
    expect(Number(input.style.getPropertyValue("--slider-fraction"))).toBeCloseTo(10 / 25, 5);
  });

  it("inputRef가 입력 요소를 받는다(호출자가 포커스를 되돌릴 수 있게), 안쪽 채움 변수도 그대로 꽂힌다", () => {
    let received: HTMLInputElement | null = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        createElement(Slider, {
          value: 80,
          min: 70,
          max: 95,
          onValueChange: () => undefined,
          testId: "slider",
          inputRef: (node: HTMLInputElement | null) => {
            received = node;
          },
        })
      )
    );
    const input = host.querySelector<HTMLInputElement>('[data-testid="slider"]');
    expect(received).toBe(input);
    expect(input?.style.getPropertyValue("--slider-fraction")).toBe("0.4");
  });
});

describe("slider.css — 호버·눌림·포커스 (design-review L4)", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui", "slider.css"), "utf8");
  it("알은 호버에서 옅은 선 한 겹, 눌림에서 살짝 커지고, 잠긴 슬라이더는 반응하지 않는다", () => {
    for (const thumb of ["::-webkit-slider-thumb", "::-moz-range-thumb"]) {
      expect(css).toContain(`.slider:where(:not(:disabled)):hover${thumb}`);
      expect(css).toContain(`.slider:where(:not(:disabled)):active${thumb}`);
    }
    expect(css).toMatch(/:active::-webkit-slider-thumb \{\s*transform: scale\(1\.1\);/);
  });
  it("포커스 링 규칙이 호버 규칙보다 뒤에 서서 호버가 링을 가리지 않는다", () => {
    for (const thumb of ["::-webkit-slider-thumb", "::-moz-range-thumb"]) {
      const hover = css.indexOf(`.slider:where(:not(:disabled)):hover${thumb}`);
      const focus = css.indexOf(`.slider:focus-visible${thumb}`);
      expect(hover).toBeGreaterThan(-1);
      expect(focus).toBeGreaterThan(hover);
    }
  });
  it("모션 감소에서는 전이를 끈다", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*transition: none;/);
  });
});
