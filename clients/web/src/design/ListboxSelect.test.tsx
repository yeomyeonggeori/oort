// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListboxSelect, type ListboxOption } from "@/design/ui/listbox-select";

// #4131 — 공용 ListboxSelect 의 계약 고정: 라벨 클릭, aria-disabled, 타이프어헤드, 긴 영문 ID,
// 모달 안 휠 스크롤, 라벨을 가리지 않는 목록 앵커.

afterEach(() => cleanup());

const MODELS: ListboxOption[] = [
  { value: "opus", label: "claude-opus-4-1-20250805-with-an-unbroken-very-long-identifier" },
  { value: "sonnet", label: "sonnet-5-5" },
  { value: "haiku", label: "haiku-4-5" },
  { value: "sol", label: "sol-gated", disabled: true },
  { value: "sigma", label: "sigma-1" },
];

function Harness({
  extra = {},
  onValueChange = () => {},
}: {
  extra?: Record<string, unknown>;
  onValueChange?: (v: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <>
      <label id="lbl" htmlFor="box">
        모델
      </label>
      <ListboxSelect
        id="box"
        aria-labelledby="lbl"
        data-testid="box"
        value={value}
        options={MODELS}
        placeholder="고르기"
        onValueChange={(v) => {
          setValue(v);
          onValueChange(v);
        }}
        {...extra}
      />
    </>
  );
}

// 타이프어헤드는 500ms 안의 연타를 접두사로 읽는다 — 시계를 손으로 넘긴다.
let clock = 1_000_000;
const tick = (ms: number) => {
  clock += ms;
};
vi.spyOn(Date, "now").mockImplementation(() => clock);

const box = () => screen.getByTestId("box");
const activeValue = () =>
  document.querySelector('[role="option"][data-active]')?.getAttribute("data-value");

describe("ListboxSelect (#4131)", () => {
  it("라벨을 누르면 열리고 포커스가 목록으로 간다", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("모델"));
    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox", { name: "모델" })).toBeTruthy();
  });

  it("aria-disabled 는 클릭·키보드로 열리지 않고 기본으로 흐리게 보인다", () => {
    render(<Harness extra={{ "aria-disabled": true }} />);
    fireEvent.click(box());
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box().getAttribute("aria-expanded")).toBe("false");
    expect(box().className).toContain("aria-disabled:opacity-50");
  });

  it("글자를 치면 그 글자로 시작하는 활성 항목으로 가고, 비활성 항목은 건너뛴다", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    fireEvent.click(box());
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "h" });
    expect(activeValue()).toBe("haiku");
    tick(1000);
    // 비활성 "sol-gated" 는 건너뛰고 s 를 반복하면 sonnet → sigma → sonnet 으로 돈다.
    fireEvent.keyDown(list, { key: "s" });
    expect(activeValue()).toBe("sigma");
    fireEvent.keyDown(list, { key: "s" });
    expect(activeValue()).toBe("sonnet");
    tick(1000);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("sonnet");
  });

  it("접두사를 이어 치면 좁혀 간다", () => {
    render(<Harness />);
    fireEvent.click(box());
    const list = screen.getByRole("listbox");
    tick(1000);
    fireEvent.keyDown(list, { key: "s" });
    fireEvent.keyDown(list, { key: "i" });
    expect(activeValue()).toBe("sigma");
  });

  it("긴 영문 ID 는 칸 안에서 줄바꿈된다", () => {
    render(<Harness />);
    fireEvent.click(box());
    const label = screen.getAllByRole("option")[0].querySelector("span span") as HTMLElement;
    expect(label.className).toContain("[overflow-wrap:anywhere]");
  });

  it("목록의 휠·터치 이동은 문서까지 올라가지 않는다(모달의 스크롤 잠금이 막지 못한다)", () => {
    render(<Harness />);
    fireEvent.click(box());
    const seen = vi.fn();
    document.addEventListener("wheel", seen);
    document.addEventListener("touchmove", seen);
    try {
      fireEvent.wheel(screen.getByRole("listbox"), { deltaY: 40 });
      fireEvent.touchMove(screen.getByRole("listbox"));
      expect(seen).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("wheel", seen);
      document.removeEventListener("touchmove", seen);
    }
  });
});

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top, toJSON() {} } as DOMRect;
}

function Anchored({ anchored }: { anchored: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="field">
      <label id="l2">라벨</label>
      <ListboxSelect
        aria-labelledby="l2"
        data-testid="box"
        value=""
        options={MODELS}
        placeholder="고르기"
        onValueChange={() => {}}
        side="top"
        anchorRef={anchored ? ref : undefined}
      />
    </div>
  );
}

describe("ListboxSelect 앵커 (#4131)", () => {
  const yOf = () => {
    const wrapper = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(wrapper?.style.transform ?? "");
    return m ? Number(m[2]) : NaN;
  };

  async function openAt(anchored: boolean) {
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        // 라벨+칸 상자는 100~160, 칸은 130~160. 위로 열린 목록의 아래 끝이 어디인지를 잰다.
        return this.dataset.testid === "field" ? rect(100, 160) : rect(130, 160);
      });
    render(<Anchored anchored={anchored} />);
    fireEvent.click(screen.getByTestId("box"));
    await vi.waitFor(() => expect(Number.isNaN(yOf())).toBe(false));
    const y = yOf();
    spy.mockRestore();
    return y;
  }

  it("anchorRef 를 주면 위로 열린 목록이 라벨 위에 놓인다", async () => {
    const withAnchor = await openAt(true);
    cleanup();
    const withoutAnchor = await openAt(false);
    // 라벨 높이(30px)만큼 더 위. 앵커가 단추면 목록이 라벨 위로 겹친다.
    expect(withAnchor).toBeLessThan(withoutAnchor);
    expect(withoutAnchor - withAnchor).toBe(30);
  });
});
