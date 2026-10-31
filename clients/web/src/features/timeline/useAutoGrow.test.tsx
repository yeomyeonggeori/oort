// @vitest-environment jsdom
import { createElement, useRef } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_MAX_ROWS, useAutoGrow } from "./useAutoGrow";

let contentHeight = 0;
function Field({ value }: { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value, { minRows: 1, maxRows: COMPOSER_MAX_ROWS });
  return createElement("textarea", {
    ref, value, readOnly: true,
    style: { boxSizing: "border-box", lineHeight: "24px", fontSize: "16px", padding: "8px", border: "1px solid" },
  });
}

afterEach(() => vi.restoreAllMocks());
function mount() {
  vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => contentHeight);
  return render(createElement(Field, { value: "" }));
}

describe("#4790 데스크탑 입력창 성장", () => {
  it("5줄 상수: 감긴 문단도 실측 높이로 자라고 초과분은 안에서 스크롤한다", () => {
    expect(COMPOSER_MAX_ROWS).toBe(5);
    contentHeight = 3 * 24 + 16;
    const view = mount();
    const input = view.container.querySelector("textarea")!;
    expect(input.style.height).toBe("90px");
    expect(input.style.overflowY).toBe("hidden");
    contentHeight = 5 * 24 + 16;
    view.rerender(createElement(Field, { value: "긴 문단" }));
    expect(input.style.height).toBe("138px");
    expect(input.style.overflowY).toBe("hidden");
    contentHeight = 6 * 24 + 16;
    view.rerender(createElement(Field, { value: "더 긴 문단" }));
    expect(input.style.height).toBe("138px");
    expect(input.style.overflowY).toBe("auto");
  });

  it("테두리를 포함해 첫 줄이 잘리지 않고, 지우면 한 줄로 돌아온다", () => {
    contentHeight = 300;
    const view = mount();
    const input = view.container.querySelector("textarea")!;
    contentHeight = 24 + 16;
    act(() => view.rerender(createElement(Field, { value: "짧은 글" })));
    expect(input.style.height).toBe("42px");
    expect(input.style.overflowY).toBe("hidden");
  });
});
