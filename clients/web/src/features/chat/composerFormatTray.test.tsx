// @vitest-environment jsdom

import {
  act,
  createElement,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerFormatTray } from "./ComposerFormatTray";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { useComposerFormat } from "./useComposerFormat";
import * as position from "./composerFormatPosition";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  resetEscapeLayers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(node);
  });
  return host;
}

function Probe({
  mentionVisible = false,
  initial = "배포 롤백 근거",
}: {
  mentionVisible?: boolean;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const format = useComposerFormat({
    value,
    inputRef,
    mentionVisible,
    onValueChange: (next) => setValue(next),
    surfaceKey: "probe",
  });
  return (
    <div>
      <div data-composer-shell="">
        <textarea
          ref={inputRef}
          value={value}
          data-testid="probe-input"
          onChange={(event) => setValue(event.target.value)}
          onSelect={format.onSelect}
          onKeyUp={format.onSelect}
          onKeyDown={(event) => {
            if (format.handleKeyDown(event)) event.preventDefault();
          }}
          onBlur={format.onBlur}
        />
        <button type="button" data-testid="probe-next">
          다음
        </button>
        <ComposerFormatTray
          open={format.open}
          value={value}
          selectionEpoch={format.selectionEpoch}
          inputRef={inputRef}
          trayRef={format.trayRef}
          onApply={format.apply}
          onDismiss={format.dismiss}
          testIdPrefix="composer-format"
        />
      </div>
      <button type="button" data-testid="probe-outside">
        밖
      </button>
    </div>
  );
}

function selectRange(input: HTMLTextAreaElement, start: number, end: number) {
  act(() => {
    input.focus();
    input.setSelectionRange(start, end);
    input.dispatchEvent(new Event("select", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function press(node: EventTarget | null, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    node?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    );
  });
}

describe("컴포저 선택 서식 트레이 (#1902)", () => {
  it("선택이 생기면 트레이가 뜨고 굵게를 누르면 접사를 넣으며 선택을 유지한다", () => {
    mount(createElement(Probe));
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='probe-input']"
    );
    expect(input).not.toBeNull();
    if (!input) throw new Error("missing input");
    expect(document.querySelector("[data-testid='composer-format-tray']")).toBeNull();

    selectRange(input, 0, 2);
    const tray = document.querySelector("[data-testid='composer-format-tray']");
    expect(tray).not.toBeNull();
    expect(tray?.getAttribute("role")).toBe("toolbar");
    expect(tray?.getAttribute("aria-label")).toBe("선택 서식");
    const bold = document.querySelector<HTMLButtonElement>(
      "[data-testid='composer-format-bold']"
    );
    expect(bold?.getAttribute("aria-label")).toBe("굵게");
    expect(bold?.getAttribute("title")).toBe("굵게 (⌘B)");
    expect(bold?.getAttribute("aria-pressed")).toBe("false");
    const italic = document.querySelector("[data-testid='composer-format-italic']");
    const code = document.querySelector("[data-testid='composer-format-code']");
    const link = document.querySelector("[data-testid='composer-format-link']");
    expect(italic && code && link).toBeTruthy();
    expect(italic?.getAttribute("title")).toContain("영문이나 숫자");

    act(() => {
      bold?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      bold?.click();
    });
    expect(input.value).toBe("**배포** 롤백 근거");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(4);
    expect(
      document.querySelector("[data-testid='composer-format-bold']")?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      document
        .querySelector("[data-testid='composer-format-bold']")
        ?.className.includes("bg-accent-soft")
    ).toBe(true);
  });

  it("⌘B 는 트레이 없이 접사를 넣고, ⌘I 는 라틴이 있는 선택에만 넣는다", () => {
    mount(createElement(Probe, { initial: "soon 롤백" }));
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='probe-input']"
    );
    if (!input) throw new Error("missing input");
    selectRange(input, 0, 4);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "i",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(input.value).toBe("*soon* 롤백");
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(5);
    expect(
      document
        .querySelector("[data-testid='composer-format-italic']")
        ?.getAttribute("title")
    ).toBe("기울임 (⌘I)");

    selectRange(input, 7, 9);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "i",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(input.value).toBe("*soon* 롤백");

    selectRange(input, 7, 9);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "b",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(input.value).toBe("*soon* **롤백**");
    expect(input.selectionStart).toBe(9);
    expect(input.selectionEnd).toBe(11);
  });

  it("멘션 목록이 열려 있으면 선택이 있어도 트레이를 올리지 않는다", () => {
    mount(createElement(Probe, { mentionVisible: true }));
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='probe-input']"
    );
    if (!input) throw new Error("missing input");
    selectRange(input, 0, 2);
    expect(document.querySelector("[data-testid='composer-format-tray']")).toBeNull();
  });

  it("트레이 mousedown 은 기본 동작을 막고 Esc keydown+keyup 짝으로 접힌 채 유지된다", () => {
    mount(createElement(Probe));
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='probe-input']"
    );
    if (!input) throw new Error("missing input");
    selectRange(input, 0, 2);
    const tray = document.querySelector("[data-testid='composer-format-tray']");
    expect(tray).not.toBeNull();
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      tray?.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(document.querySelector("[data-testid='composer-format-tray']")).toBeNull();

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Escape", bubbles: true })
      );
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(document.querySelector("[data-testid='composer-format-tray']")).toBeNull();

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Shift", bubbles: true })
      );
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(document.querySelector("[data-testid='composer-format-tray']")).toBeNull();

    selectRange(input, 3, 5);
    expect(document.querySelector("[data-testid='composer-format-tray']")).not.toBeNull();
  });

  it("툴바는 탭스톱 하나와 방향키 로빙이며 Tab 은 다음 컴포저 컨트롤로 간다", () => {
    mount(createElement(Probe));
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='probe-input']"
    );
    const next = document.querySelector<HTMLButtonElement>(
      "[data-testid='probe-next']"
    );
    const outside = document.querySelector<HTMLButtonElement>(
      "[data-testid='probe-outside']"
    );
    if (!input || !next || !outside) throw new Error("missing probe controls");
    selectRange(input, 0, 2);
    const bold = document.querySelector<HTMLButtonElement>(
      "[data-testid='composer-format-bold']"
    );
    const italic = document.querySelector<HTMLButtonElement>(
      "[data-testid='composer-format-italic']"
    );
    const tray = document.querySelector("[data-testid='composer-format-tray']");
    if (!bold || !italic || !tray) throw new Error("missing tray");
    const tabStops = [...tray.querySelectorAll("button")].filter(
      (button) => button.tabIndex === 0
    );
    expect(tabStops).toHaveLength(1);
    expect(bold.tabIndex).toBe(0);

    act(() => {
      bold.focus();
    });
    press(tray, "ArrowRight");
    expect(document.activeElement).toBe(italic);
    expect(italic.tabIndex).toBe(0);
    expect(bold.tabIndex).toBe(-1);

    press(tray, "Tab");
    expect(document.activeElement).toBe(next);
    expect(document.querySelector("[data-testid='composer-format-tray']")).not.toBeNull();

    act(() => {
      outside.focus();
    });
    expect(document.querySelector("[data-testid='composer-format-tray']")).toBeNull();
  });

  it("한국어만 고르면 기울임 버튼은 aria-disabled 이고 접사를 넣지 않는다", () => {
    mount(createElement(Probe, { initial: "배포 일정" }));
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='probe-input']"
    );
    if (!input) throw new Error("missing input");
    selectRange(input, 0, 5);
    const italic = document.querySelector<HTMLButtonElement>(
      "[data-testid='composer-format-italic']"
    );
    expect(italic?.getAttribute("aria-disabled")).toBe("true");
    expect(italic?.getAttribute("title")).toContain("영문이나 숫자");
    act(() => {
      italic?.click();
    });
    expect(input.value).toBe("배포 일정");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "i",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(input.value).toBe("배포 일정");
  });

  it("selectionchange 로 선택이 자라면 트레이 좌표를 다시 잰다", () => {
    let left = 100;
    vi.spyOn(position, "getTextareaSelectionRect").mockImplementation(
      () =>
        ({
          x: left,
          y: 80,
          left,
          top: 80,
          width: 40,
          height: 18,
          right: left + 40,
          bottom: 98,
          toJSON: () => ({}),
        }) as DOMRect
    );
    mount(createElement(Probe));
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='probe-input']"
    );
    if (!input) throw new Error("missing input");
    selectRange(input, 0, 2);
    const tray = document.querySelector<HTMLElement>(
      "[data-testid='composer-format-tray']"
    );
    expect(tray).not.toBeNull();
    const first = tray?.style.getPropertyValue("--composer-format-left");
    left = 240;
    selectRange(input, 0, 7);
    const second = tray?.style.getPropertyValue("--composer-format-left");
    expect(first).not.toBe("");
    expect(second).not.toBe(first);
  });

  it("hover:none/pointer:coarse 에서는 트레이를 그리지 않는다", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches:
        query.includes("hover: none") || query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    mount(createElement(Probe));
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='probe-input']"
    );
    if (!input) throw new Error("missing input");
    selectRange(input, 0, 2);
    expect(document.querySelector("[data-testid='composer-format-tray']")).toBeNull();
  });
});
