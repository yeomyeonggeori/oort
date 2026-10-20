// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseListbox, listboxChoices, listboxValue } from "@/design/ui/listboxTestKit";
import { SelectField } from "./SettingsFields";

// =============================================================================
// #4126 SelectField 는 네이티브 <select> 가 아니라 앱이 그린 listbox 다.
// 사보타주로 붉어지는 규율:
//   ① 고르면 onChange 가 그 id 로 불린다 (onValueChange no-op 이면 ② 가 붉어진다)
//   ② 보이는 라벨이 칸과 목록의 이름이다 (aria-labelledby 를 빼면 ③ 이 붉어진다)
//   ③ 비활성 선택지는 보이되 고를 수 없다
// =============================================================================

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(props: Partial<Parameters<typeof SelectField>[0]> = {}) {
  const onChange = vi.fn();
  act(() => {
    root.render(
      createElement(SelectField, {
        id: "sf",
        label: "저장소",
        value: "a",
        choices: [
          { id: "a", label: "alpha" },
          { id: "b", label: "bravo" },
          { id: "c", label: "charlie (쓸 수 없음)", disabled: true },
        ],
        onChange,
        testId: "sf-field",
        ...props,
      })
    );
  });
  return onChange;
}

const trigger = () => container.querySelector<HTMLElement>('[data-testid="sf-field"]');

describe("SelectField 는 앱이 그린 listbox (#4126)", () => {
  it("combobox 의미를 갖고, 고르면 onChange 가 그 id 로 불린다", () => {
    const onChange = mount();
    expect(trigger()?.getAttribute("role")).toBe("combobox");
    expect(trigger()?.tagName).toBe("BUTTON");
    expect(container.querySelector("select")).toBeNull();
    expect(listboxValue(trigger())).toBe("a");
    chooseListbox(trigger(), "b");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("보이는 라벨이 칸과 목록의 이름이다", () => {
    mount();
    const label = container.querySelector<HTMLElement>("label")!;
    expect(label.id).toBeTruthy();
    expect(trigger()?.getAttribute("aria-labelledby")).toBe(label.id);
    act(() => {
      trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-labelledby")).toBe(label.id);
  });

  it("ariaLabel 이 있으면 그것이 이름이다(같은 라벨이 여러 범위에 서는 자리)", () => {
    mount({ ariaLabel: "워크스페이스 저장소" });
    expect(trigger()?.getAttribute("aria-label")).toBe("워크스페이스 저장소");
    expect(trigger()?.getAttribute("aria-labelledby")).toBeNull();
  });

  it("비활성 선택지는 보이되 고를 수 없다", () => {
    const onChange = mount();
    expect(listboxChoices(trigger()).map((c) => [c.value, c.disabled])).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
    ]);
    // 목록이 닫혔으니 다시 열어 비활성 항목을 직접 누른다.
    act(() => {
      trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      document
        .querySelector('[role="option"][data-value="c"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled 이면 열리지 않는다", () => {
    mount({ disabled: true });
    expect(trigger()?.hasAttribute("disabled")).toBe(true);
  });
});
