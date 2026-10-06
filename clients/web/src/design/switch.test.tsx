// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Switch } from "./ui/switch";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(props: Partial<Parameters<typeof Switch>[0]> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onCheckedChange = vi.fn();
  act(() =>
    root?.render(
      createElement(Switch, {
        checked: false,
        onCheckedChange,
        "aria-label": "알림 소리",
        testId: "sw",
        ...props,
      })
    )
  );
  return { button: host.querySelector<HTMLButtonElement>('[data-testid="sw"]')!, onCheckedChange };
}

describe("Switch", () => {
  it("role=switch와 aria-checked로 상태를 말한다", () => {
    const off = mount();
    expect(off.button.getAttribute("role")).toBe("switch");
    expect(off.button.getAttribute("aria-checked")).toBe("false");
    const on = mount({ checked: true });
    expect(on.button.getAttribute("aria-checked")).toBe("true");
  });

  it("누르면 반대 값으로 onCheckedChange가 불린다", () => {
    const off = mount();
    act(() => off.button.click());
    expect(off.onCheckedChange).toHaveBeenCalledWith(true);
    const on = mount({ checked: true });
    act(() => on.button.click());
    expect(on.onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("disabled면 눌러도 부르지 않는다", () => {
    const { button, onCheckedChange } = mount({ disabled: true });
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("이름은 행 라벨(labelledBy)이 있으면 그것이, 없으면 aria-label이 진다", () => {
    const labelled = mount({ labelledBy: "row-label" });
    expect(labelled.button.getAttribute("aria-labelledby")).toBe("row-label");
    expect(labelled.button.hasAttribute("aria-label")).toBe(false);
    const plain = mount();
    expect(plain.button.getAttribute("aria-label")).toBe("알림 소리");
  });

  it("알(thumb)은 장식이라 보조기술에서 숨는다", () => {
    const { button } = mount();
    expect(button.querySelector(".switch-thumb")?.getAttribute("aria-hidden")).toBe("true");
  });
});
