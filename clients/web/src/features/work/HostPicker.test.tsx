// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkHost } from "@momo/core/lib/api";
import { HostPicker, type HostPickerCopy } from "./HostPicker";

// 호스트 고르기 칸은 앱이 그린 listbox다(#4128). 네이티브 select 가 아니고, 라벨이
// 칸과 목록의 이름이며, 고르면 확정 버튼이 그 호스트로 나간다.

const copy: HostPickerCopy = {
  group: "인수할 호스트",
  confirm: "인수",
  action: (name) => `${name}에서 인수`,
  busy: (name) => `${name}에서 인수 중`,
};

const HOST_A = "00000000-0000-7000-8000-0000000000a1";
const HOST_B = "00000000-0000-7000-8000-0000000000b2";
const targets = [
  { id: HOST_A, displayName: "성재 맥북" },
  { id: HOST_B, displayName: "작업실 맥 미니" },
] as unknown as WorkHost[];

function mount(over: { busyHostId?: string | null; onPick?: (id: string) => void } = {}) {
  const onPick = over.onPick ?? vi.fn();
  render(
    <HostPicker
      id="picker"
      labelId="picker-label"
      copy={copy}
      targets={targets}
      busyHostId={over.busyHostId ?? null}
      onPick={onPick}
      selectTestId="picker-select"
      confirmTestId="picker-confirm"
    />
  );
  return { onPick };
}

afterEach(() => cleanup());

describe("HostPicker 호스트 칸은 앱이 그린 listbox (#4128)", () => {
  it("combobox 의미를 갖고, 눈에 보이는 라벨이 칸과 목록의 이름이다", () => {
    mount();
    const box = screen.getByTestId("picker-select");
    expect(box.tagName).toBe("BUTTON");
    expect(box.getAttribute("role")).toBe("combobox");
    expect(box.getAttribute("aria-haspopup")).toBe("listbox");
    expect(document.querySelector("select")).toBeNull();
    expect(screen.getByRole("combobox", { name: "인수할 호스트" })).toBe(box);
    expect(box.textContent).toContain("성재 맥북");
    fireEvent.click(box);
    expect(screen.getByRole("listbox", { name: "인수할 호스트" })).toBeTruthy();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "성재 맥북",
      "작업실 맥 미니",
    ]);
  });

  it("다른 호스트를 고르면 확정 버튼이 그 호스트로 나간다", () => {
    const { onPick } = mount();
    fireEvent.click(screen.getByTestId("picker-select"));
    fireEvent.click(screen.getByRole("option", { name: "작업실 맥 미니" }));
    expect(screen.getByTestId("picker-select").getAttribute("data-host-id")).toBe(HOST_B);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByTestId("picker-confirm"));
    expect(onPick).toHaveBeenCalledWith(HOST_B);
  });

  it("요청이 나가 있는 동안 칸은 잠겨 열리지 않는다", () => {
    mount({ busyHostId: HOST_A });
    const box = screen.getByTestId("picker-select") as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    fireEvent.click(box);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("라벨을 누르면 칸이 열린다 (#4131)", () => {
    mount();
    fireEvent.click(screen.getByText("인수할 호스트", { selector: "label" }));
    expect(screen.getByTestId("picker-select").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox", { name: "인수할 호스트" })).toBeTruthy();
  });

  it("목록은 라벨+칸 상자에 붙는다 — 위로 뒤집혀도 라벨을 가리지 않는다 (#4131)", async () => {
    // 상자(라벨+칸)는 100~220, 칸은 150~200. jsdom 에서 목록은 위로 뒤집힌다: 단추에 붙으면 y=146(라벨을 덮음), 상자에 붙으면 y=96(라벨 위).
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const box = this.getAttribute("role") === "combobox" ? [150, 200] : [100, 220];
        return { top: box[0], bottom: box[1], left: 0, right: 200, width: 200, height: box[1] - box[0], x: 0, y: box[0], toJSON() {} } as DOMRect;
      });
    try {
      mount();
      fireEvent.click(screen.getByTestId("picker-select"));
      const wrapper = await vi.waitFor(() => {
        const el = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
        if (!el || !/px, [-\d.]+px/.test(el.style.transform)) throw new Error("not placed");
        return el;
      });
      expect(wrapper.style.transform).toMatch(/translate\([-\d.]+px, 96px\)/);
    } finally {
      spy.mockRestore();
    }
  });
});
