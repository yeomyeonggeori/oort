// @vitest-environment jsdom
import { createElement, useRef } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_GROW_MIRROR_ATTR, COMPOSER_MAX_ROWS, useAutoGrow } from "./useAutoGrow";

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

describe("#5567 재는 동안 살아 있는 입력창을 접지 않는다", () => {
  // 앞 판은 키마다 입력창을 `height: auto`로 접고 `scrollHeight`를 읽었다. 그 강제 레이아웃에서 WebKit 이 대화 목록의
  // scrollTop 을 깎아 여러 줄 초안을 치는 동안 목록이 입력창 뒤로 내려앉았다(gates/gate-typing-jitter.mjs 가 WebKit 에서 잰다).
  // jsdom 은 레이아웃이 없으므로 여기서는 그 원인 자체를 잰다: 살아 있는 입력창에 쓰인 높이 값의 차례.
  function heightWrites(input: HTMLTextAreaElement) {
    const writes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) writes.push(record.oldValue ?? "");
    });
    observer.observe(input, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
    return {
      /** 바뀌기 전 값들 + 지금 값 = 이 입력창이 거쳐 간 모든 style. */
      seen: () => {
        for (const record of observer.takeRecords()) writes.push(record.oldValue ?? "");
        return [...writes, input.getAttribute("style") ?? ""];
      },
      stop: () => observer.disconnect(),
    };
  }

  it("세 줄 초안에서 한 글자씩 쳐도 입력창 높이는 한 번도 auto 를 거치지 않고, 높이는 마지막 값 하나다", () => {
    contentHeight = 3 * 24 + 16;
    const view = mount();
    const input = view.container.querySelector("textarea")!;
    const probe = heightWrites(input);
    for (const value of ["세 줄 초안 가", "세 줄 초안 가나", "세 줄 초안 가나다"]) {
      act(() => view.rerender(createElement(Field, { value })));
    }
    const seen = probe.seen();
    probe.stop();
    expect(seen.filter((style) => /height:\s*auto/.test(style))).toEqual([]);
    expect(input.style.height).toBe("90px");
  });

  it("높이는 같은 부모 안의 보이지 않는 거울에서 잰다: 초점·포인터·보조기술에 서지 않고, 입력창이 사라지면 함께 사라진다", () => {
    contentHeight = 2 * 24 + 16;
    const view = mount();
    const input = view.container.querySelector("textarea")!;
    const mirror = input.parentElement!.querySelector<HTMLTextAreaElement>(`[${AUTO_GROW_MIRROR_ATTR}]`);
    expect(mirror).not.toBeNull();
    expect(mirror).not.toBe(input);
    expect(mirror!.tabIndex).toBe(-1);
    expect(mirror!.inert).toBe(true);
    expect(mirror!.style.visibility).toBe("hidden");
    expect(mirror!.style.position).toBe("absolute");
    expect(mirror!.style.height).toBe("0px");
    act(() => view.rerender(createElement(Field, { value: "거울로 재는 글" })));
    expect(mirror!.value).toBe("거울로 재는 글");
    view.unmount();
    expect(mirror!.isConnected).toBe(false);
  });
});
