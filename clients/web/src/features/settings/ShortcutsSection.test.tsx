// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TERMINAL_APP_BINDINGS } from "@momo/core/features/workbench/keymap";
import { REGISTERED_SHORTCUTS } from "@/app/keyboardShortcuts";
import {
  OPEN_INBOX_SHORTCUT,
  OPEN_QUICK_SWITCHER_SHORTCUT,
  OPEN_SETTINGS_SHORTCUT,
} from "@/app/keyboardShortcuts";
import { resetShortcutBindingsForTest } from "@/app/shortcutBindings";
import { ShortcutsSection } from "./ShortcutsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;

function render(desktop: boolean, platform: "mac" | "other" = "mac") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(ShortcutsSection, { desktop, platform })));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

function click(el: Element | null) {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).click();
  });
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function setQuery(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>('[data-testid="shortcut-search"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const rowIds = (host: HTMLElement) =>
  [...host.querySelectorAll("[data-shortcut-row]")].map((el) => el.getAttribute("data-shortcut-row"));
const live = (host: HTMLElement) => host.querySelector('[data-testid="shortcut-live"]')?.textContent ?? "";

beforeEach(() => {
  localStorage.clear();
  resetShortcutBindingsForTest();
});
afterEach(() => {
  cleanup?.();
  cleanup = null;
  localStorage.clear();
  resetShortcutBindingsForTest();
});

describe("설정 › 단축키 (#3281)", () => {
  it("목록은 도움말과 같은 등록표의 모든 줄이고, 데스크탑에는 터미널 표의 나머지가 붙는다", () => {
    const desktop = render(true);
    const ids = rowIds(desktop);
    for (const shortcut of REGISTERED_SHORTCUTS) expect(ids).toContain(shortcut.id);
    const terminalOnly = TERMINAL_APP_BINDINGS.filter(
      (b) => !REGISTERED_SHORTCUTS.some((s) => s.id === b.id)
    );
    expect(ids.length).toBe(REGISTERED_SHORTCUTS.length + terminalOnly.length);
    // ⌘B는 한 번만 적힌다.
    expect(ids.filter((id) => id?.endsWith("toggle-sidebar")).length).toBe(1);
  });

  it("웹에서도 데스크탑 전용 키를 보이되 「데스크탑 전용」으로 표시하고 터미널 안내는 없다", () => {
    const web = render(false);
    const row = web.querySelector('[data-shortcut-row="terminal:jump-palette"]');
    expect(row?.textContent).toContain("데스크탑 전용");
    expect(row?.textContent).not.toContain("앱이 받는");
    expect(web.textContent).toContain("이 브라우저에서는 동작하지 않아요");
    expect(web.querySelector('[data-shortcut-row="toggle-sidebar"]')?.textContent).not.toContain("터미널");
  });

  it("데스크탑에서는 터미널 묶음 머리말이 통과 규칙을 한 번 말하고, 줄마다 되풀이하지 않는다", () => {
    const desktop = render(true);
    const heading = desktop.textContent ?? "";
    expect(heading).toContain("터미널에 포커스가 있어도 앱이 받는 키예요");
    expect(heading.split("터미널에 포커스가 있어도 앱이 받는 키예요").length - 1).toBe(1);
    expect(desktop.querySelector('[data-shortcut-row="open-inbox"]')?.textContent).not.toContain("터미널");
  });

  it("데스크탑에서 ⌘B 줄은 터미널 동작을 고정으로 안내한다", () => {
    const desktop = render(true);
    const text = desktop.querySelector('[data-shortcut-row="toggle-sidebar"]')?.textContent ?? "";
    expect(text).toContain("터미널 안에서도 ⌘B로 접혀요");
    expect(text).toContain("Ctrl+B는 터미널이 받아요");
  });

  it("바꿀 수 있는 줄은 다섯 개이고 나머지는 고정이다", () => {
    const host = render(true);
    const rebindable = [...host.querySelectorAll('[data-rebindable="true"]')].map((el) =>
      el.getAttribute("data-shortcut-row")
    );
    expect(rebindable.sort()).toEqual(
      ["open-inbox", "open-new-dm", "open-quick-switcher", "open-settings", "toggle-sidebar"].sort()
    );
  });

  it("검색은 이름과 키(⌘ 표기·Ctrl 표기)로 거르고, 없으면 빈 상태를 말한다", () => {
    const host = render(true);
    setQuery(host, "인박스");
    expect(rowIds(host)).toEqual(["open-inbox"]);
    setQuery(host, "cmd+shift+a");
    expect(rowIds(host)).toEqual(["open-inbox"]);
    setQuery(host, "⌘,");
    expect(rowIds(host)).toEqual(["open-settings"]);
    setQuery(host, "zzzz");
    expect(rowIds(host)).toEqual([]);
    expect(host.querySelector('[data-testid="shortcut-empty"]')).not.toBeNull();
  });

  it("macOS 밖에서는 키캡을 Ctrl 표기로 적는다", () => {
    const host = render(false, "other");
    expect(host.querySelector('[data-shortcut-row="open-inbox"]')?.textContent).toContain("Ctrl+Shift+A");
  });

  it("변경 → 키 입력으로 바꾸고 낭독하며, 등록표 키캡·판정이 바뀐다. 초기화로 되돌린다", () => {
    const host = render(false);
    click(host.querySelector('[data-testid="shortcut-change-open-inbox"]'));
    expect(host.querySelector('[data-testid="shortcut-capture"]')).not.toBeNull();
    const ev = press({ key: "g", code: "KeyG", metaKey: true, shiftKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧G"]);
    expect(host.querySelector('[data-testid="shortcut-capture"]')).toBeNull();
    expect(live(host)).toContain("바꿨어요");
    expect(host.querySelector('[data-shortcut-row="open-inbox"]')?.textContent).toContain("변경됨");

    click(host.querySelector('[data-testid="shortcut-reset-open-inbox"]'));
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧A"]);
    expect(host.querySelector('[data-testid="shortcut-reset-open-inbox"]')).toBeNull();
  });

  it("입력 중의 ⌘K는 팔레트로 새지 않는다(사건을 소비한다)", () => {
    const host = render(false);
    let leaked = false;
    const spy = () => {
      leaked = true;
    };
    window.addEventListener("keydown", spy);
    click(host.querySelector('[data-testid="shortcut-change-open-settings"]'));
    press({ key: "k", code: "KeyK", metaKey: true });
    window.removeEventListener("keydown", spy);
    expect(leaked).toBe(false);
  });

  it("충돌: 다른 항목의 키를 누르면 바꾸지 않고 경고한다. 서로 바꾸기를 고르면 맞바꾼다", () => {
    const host = render(false);
    click(host.querySelector('[data-testid="shortcut-change-open-settings"]'));
    press({ key: "k", code: "KeyK", metaKey: true });
    expect(OPEN_SETTINGS_SHORTCUT.keycaps).toEqual(["⌘,"]);
    const notice = host.querySelector('[data-testid="shortcut-notice"]');
    expect(notice?.textContent).toContain("「검색과 이동 열기」");
    expect(live(host)).toContain("이미 「검색과 이동 열기」");
    click(host.querySelector('[data-testid="shortcut-swap"]'));
    expect(OPEN_SETTINGS_SHORTCUT.keycaps).toEqual(["⌘K"]);
    expect(OPEN_QUICK_SWITCHER_SHORTCUT.keycaps).toEqual(["⌘,"]);
  });

  it("충돌 알림에서 취소하면 아무것도 바뀌지 않는다", () => {
    const host = render(false);
    click(host.querySelector('[data-testid="shortcut-change-open-settings"]'));
    press({ key: "k", code: "KeyK", metaKey: true });
    click(host.querySelector('[data-testid="shortcut-swap-cancel"]'));
    expect(OPEN_SETTINGS_SHORTCUT.keycaps).toEqual(["⌘,"]);
    expect(OPEN_QUICK_SWITCHER_SHORTCUT.keycaps).toEqual(["⌘K"]);
    expect(host.querySelector('[data-testid="shortcut-notice"]')).toBeNull();
  });

  it("예약 키(⌘Q)와 수식 없는 키는 막고, 입력은 계속된다", () => {
    const host = render(false);
    click(host.querySelector('[data-testid="shortcut-change-open-inbox"]'));
    press({ key: "q", code: "KeyQ", metaKey: true });
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧A"]);
    expect(host.querySelector('[data-testid="shortcut-notice"]')?.textContent).toContain("앱 종료");
    expect(host.querySelector('[data-testid="shortcut-capture"]')).not.toBeNull();
    press({ key: "x", code: "KeyX" });
    expect(host.querySelector('[data-testid="shortcut-notice"]')?.textContent).toContain("⌘ 키와 함께");
  });

  it("데스크탑에서 터미널 키(⌘J)는 막고 이유를 말한다", () => {
    const host = render(true);
    click(host.querySelector('[data-testid="shortcut-change-open-inbox"]'));
    press({ key: "j", code: "KeyJ", metaKey: true });
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧A"]);
    expect(host.querySelector('[data-testid="shortcut-notice"]')?.textContent).toContain("칸 목록 열기");
  });

  it("Esc는 입력을 취소하고 낭독한다. 키는 그대로다", () => {
    const host = render(false);
    click(host.querySelector('[data-testid="shortcut-change-open-inbox"]'));
    const ev = press({ key: "Escape", code: "Escape" });
    expect(ev.defaultPrevented).toBe(true);
    expect(host.querySelector('[data-testid="shortcut-capture"]')).toBeNull();
    expect(live(host)).toContain("취소");
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧A"]);
  });

  it("포커스가 입력 칸을 벗어나면 입력이 끝나고 낭독하며 남은 경고를 걷는다", () => {
    const host = render(false);
    click(host.querySelector('[data-testid="shortcut-change-open-inbox"]'));
    press({ key: "q", code: "KeyQ", metaKey: true });
    expect(host.querySelector('[data-testid="shortcut-notice"]')).not.toBeNull();
    const capture = host.querySelector('[data-testid="shortcut-capture"]') as HTMLElement;
    expect(document.activeElement).toBe(capture);
    act(() => capture.blur());
    expect(host.querySelector('[data-testid="shortcut-capture"]')).toBeNull();
    expect(host.querySelector('[data-testid="shortcut-notice"]')).toBeNull();
    expect(live(host)).toContain("포커스를 옮겨");
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧A"]);
  });

  it("버튼의 접근 이름은 화면에 보이는 글자로 시작한다", () => {
    const host = render(false);
    click(host.querySelector('[data-testid="shortcut-change-open-inbox"]'));
    press({ key: "g", code: "KeyG", metaKey: true, shiftKey: true });
    const change = host.querySelector('[data-testid="shortcut-change-open-inbox"]') as HTMLElement;
    expect(change.textContent).toBe("변경");
    expect(change.getAttribute("aria-label")?.startsWith("변경")).toBe(true);
    const reset = host.querySelector('[data-testid="shortcut-reset-open-inbox"]') as HTMLElement;
    expect(reset.getAttribute("aria-label")?.startsWith(reset.textContent ?? "?")).toBe(true);
  });

  it("모두 초기화는 바꾼 키가 없으면 꺼져 있고, 있으면 전부 되돌린다", () => {
    const host = render(false);
    const reset = () => host.querySelector<HTMLButtonElement>('[data-testid="shortcut-reset-all"]') as HTMLButtonElement;
    expect(reset().disabled).toBe(true);
    click(host.querySelector('[data-testid="shortcut-change-open-inbox"]'));
    press({ key: "g", code: "KeyG", metaKey: true, shiftKey: true });
    expect(reset().disabled).toBe(false);
    click(reset());
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧A"]);
    expect(reset().disabled).toBe(true);
  });
});
