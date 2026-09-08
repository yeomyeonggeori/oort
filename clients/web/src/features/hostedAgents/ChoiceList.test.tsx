// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChoiceList } from "./ChoiceList";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function mount(lockMode?: "native" | "aria"): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(ChoiceList, {
        name: "lock-probe",
        legend: "목록",
        multiple: false,
        items: [
          { id: "a", label: "하나", detail: "설명" },
          { id: "b", label: "둘", detail: "다른 설명" },
        ],
        selected: ["a"],
        onChange: () => undefined,
        disabled: true,
        lockMode,
        testId: "lock-probe",
      })
    );
  });
  return host;
}

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
});

describe("ChoiceList 그룹 잠금", () => {
  it("기본은 native fieldset disabled 이고 hover 채움 클래스를 그대로 둔다", () => {
    const host = mount();
    const fieldset = host.querySelector("fieldset");
    const row = host.querySelector("[data-choice-id='b']");
    expect(fieldset?.disabled).toBe(true);
    expect(fieldset?.hasAttribute("aria-disabled")).toBe(false);
    expect(row?.className).toMatch(/hover:bg-surface-hover/);
    expect(row?.className).not.toMatch(/opacity-50/);
  });

  it("lockMode=aria 는 native disabled 없이 보이는 반쪽을 쌍으로 둔다", () => {
    const host = mount("aria");
    const fieldset = host.querySelector("fieldset");
    const row = host.querySelector<HTMLElement>("[data-choice-id='a']");
    const label = host.querySelector("#lock-probe-a")?.nextElementSibling
      ?.firstElementChild;
    const detail = host.querySelector("#lock-probe-a-detail");
    expect(fieldset?.disabled).toBe(false);
    expect(fieldset?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.className).toMatch(/cursor-default/);
    expect(row?.className).not.toMatch(/hover:bg-surface-hover/);
    expect(row?.className.split(/\s+/)).not.toContain("opacity-50");
    expect(label?.className.split(/\s+/)).toContain("opacity-50");
    expect(detail?.className.split(/\s+/)).not.toContain("opacity-50");
    const before = row ? getComputedStyle(row).backgroundColor : "";
    act(() => {
      row?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      row?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(row ? getComputedStyle(row).backgroundColor : "").toBe(before);
  });
});
