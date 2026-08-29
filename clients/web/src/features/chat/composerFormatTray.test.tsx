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
      <ComposerFormatTray
        open={format.open}
        inputRef={inputRef}
        trayRef={format.trayRef}
        onApply={format.apply}
        onDismiss={format.dismiss}
        testIdPrefix="composer-format"
      />
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
    expect(bold?.hasAttribute("aria-pressed")).toBe(false);
    const italic = document.querySelector("[data-testid='composer-format-italic']");
    const code = document.querySelector("[data-testid='composer-format-code']");
    const link = document.querySelector("[data-testid='composer-format-link']");
    expect(italic && code && link).toBeTruthy();

    act(() => {
      bold?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      bold?.click();
    });
    expect(input.value).toBe("**배포** 롤백 근거");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(4);
  });

  it("⌘B / ⌘I 는 트레이 없이도 접사를 넣고 선택을 보존한다", () => {
    mount(createElement(Probe));
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='probe-input']"
    );
    if (!input) throw new Error("missing input");
    selectRange(input, 3, 5);
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
    expect(input.value).toBe("배포 **롤백** 근거");
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(7);

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
    expect(input.value).toBe("배포 ***롤백*** 근거");
    expect(input.selectionStart).toBe(6);
    expect(input.selectionEnd).toBe(8);
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

  it("트레이 mousedown 은 기본 동작을 막아 선택을 지키며 Esc 로 접힌다", () => {
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
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector("[data-testid='composer-format-tray']")).toBeNull();
  });
});
