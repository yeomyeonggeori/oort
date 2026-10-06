// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Moon, Sun } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./ui/segmented-control";

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

const OPTIONS = [
  { value: "system", label: "시스템" },
  { value: "light", label: "라이트", Icon: Sun },
  { value: "dark", label: "다크", Icon: Moon },
] as const;

function mount(props: Partial<Parameters<typeof SegmentedControl>[0]> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onValueChange = vi.fn();
  act(() =>
    root?.render(
      createElement(SegmentedControl, {
        legend: "색상 모드",
        options: OPTIONS,
        value: "system",
        onValueChange,
        testId: "mode",
        ...props,
      } as Parameters<typeof SegmentedControl>[0])
    )
  );
  return { host, onValueChange };
}

describe("SegmentedControl", () => {
  it("fieldset + legend + radio 그룹이고 고른 값만 checked다", () => {
    const { host } = mount();
    const group = host.querySelector("fieldset");
    expect(group?.querySelector("legend")?.textContent).toBe("색상 모드");
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual(["system", "light", "dark"]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    // 같은 name이라 방향키 이동·한 칸 탭 정차를 브라우저가 한다.
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  });

  it("고르면 onValueChange가 그 값으로 불린다", () => {
    const { host, onValueChange } = mount();
    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="mode-dark"]')?.click();
    });
    expect(onValueChange).toHaveBeenCalledWith("dark");
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("이미 고른 값을 다시 눌러도 다시 부르지 않는다", () => {
    const { host, onValueChange } = mount();
    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="mode-system"]')?.click();
    });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("아이콘은 장식이다(aria-hidden)", () => {
    const { host } = mount();
    const svgs = host.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("disabled면 모든 입력이 잠긴다", () => {
    const { host, onValueChange } = mount({ disabled: true });
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    for (const radio of host.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      expect(radio.matches(":disabled")).toBe(true);
    }
    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="mode-dark"]')?.click();
    });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("선택 칸은 면(surface)으로 올라오고 나머지는 글자만 muted다", () => {
    const { host } = mount({ value: "light" });
    const labels = [...host.querySelectorAll("label")];
    expect(labels[1]?.className).toContain("bg-surface");
    expect(labels[0]?.className).not.toContain("bg-surface ");
    expect(labels[0]?.className).toContain("text-ink-muted");
  });
});
