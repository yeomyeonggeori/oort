// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseListbox, listboxChoices, listboxValue } from "@/design/ui/listboxTestKit";
import type { RoutingDraft } from "@momo/core/features/routing/routingModel";
import { RoutingFields } from "./RoutingFields";

// =============================================================================
// #4126 모델·추론 강도 상자는 앱이 그린 listbox 다.
// 사보타주: onValueChange 를 no-op 으로 두면 「고르면 draft 가 바뀐다」 두 건이 붉어진다.
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

function mount(draft: RoutingDraft = { model: null, effort: null }) {
  const onChange = vi.fn();
  act(() => {
    root.render(
      createElement(RoutingFields, {
        idPrefix: "rf",
        table: null,
        models: ["hermes-fast", "hermes-deep"],
        inheritedModel: "hermes-fast",
        modelInheritLabel: "상속",
        effortInheritLabel: "상속",
        draft,
        onChange,
      })
    );
  });
  return onChange;
}

const model = () => container.querySelector<HTMLElement>('[data-testid="rf-model"]');
const effort = () => container.querySelector<HTMLElement>('[data-testid="rf-effort"]');

describe("RoutingFields 는 앱이 그린 listbox (#4126)", () => {
  it("모델 상자: combobox 이고 라벨이 이름이며, 고르면 draft.model 이 바뀐다", () => {
    const onChange = mount();
    expect(model()?.getAttribute("role")).toBe("combobox");
    expect(container.querySelector("select")).toBeNull();
    const label = container.querySelector<HTMLElement>('label[for="rf-model"]')!;
    expect(model()?.getAttribute("aria-labelledby")).toBe(label.id);
    expect(listboxChoices(model()).map((c) => c.value)).toEqual(["", "hermes-fast", "hermes-deep"]);
    chooseListbox(model(), "hermes-deep");
    expect(onChange).toHaveBeenCalledWith({ model: "hermes-deep", effort: null }, null);
  });

  it("저장된 값이 목록에 없어도 그 값을 선택지로 남긴다(다른 값처럼 보이지 않는다)", () => {
    mount({ model: "retired-model", effort: null });
    expect(listboxValue(model())).toBe("retired-model");
    expect(model()?.textContent).toContain("retired-model");
  });

  it("추론 강도 상자는 표를 모르는 서버에서 잠겨 있다", () => {
    mount();
    expect(effort()?.getAttribute("role")).toBe("combobox");
    expect(effort()?.hasAttribute("disabled")).toBe(true);
  });
});
