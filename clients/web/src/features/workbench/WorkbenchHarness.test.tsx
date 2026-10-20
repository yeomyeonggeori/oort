// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WorkbenchHarness } from "./WorkbenchHarness";

// 하네스의 세션 고르기는 앱이 그린 listbox다(#4128).

afterEach(() => cleanup());

function mount() {
  render(
    <MemoryRouter initialEntries={["/design/workbench?preset=two"]}>
      <WorkbenchHarness />
    </MemoryRouter>
  );
}

describe("WorkbenchHarness 세션 칸 (#4128)", () => {
  it("「세션」 라벨이 이름인 combobox 이고 네이티브 select 가 아니다", () => {
    mount();
    const box = screen.getByRole("combobox", { name: "세션" });
    expect(box.tagName).toBe("BUTTON");
    expect(box.getAttribute("aria-haspopup")).toBe("listbox");
    expect(document.querySelector("select")).toBeNull();
    fireEvent.click(box);
    expect(screen.getByRole("listbox", { name: "세션" })).toBeTruthy();
  });

  it("다른 세션을 고르면 칸의 값이 바뀐다", () => {
    mount();
    const box = screen.getByTestId("workbench-session-select");
    const before = box.getAttribute("data-value");
    fireEvent.click(box);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    fireEvent.click(options[1]);
    expect(box.getAttribute("data-value")).toBe(options[1].getAttribute("data-value"));
    expect(box.getAttribute("data-value")).not.toBe(before);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
