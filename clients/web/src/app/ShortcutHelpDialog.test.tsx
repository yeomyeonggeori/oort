// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocale } from "@/testing/koLocale";
import { REGISTERED_SHORTCUTS } from "./keyboardShortcuts";
import { ShortcutHelpDialog } from "./ShortcutHelpDialog";
import { resetShortcutBindingsForTest } from "./shortcutBindings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #6081: 단축키 창의 찾기 · 빈 상태 · 열리면 찾기 칸 · 「단축키 바꾸기」 → 설정 › 단축키.
// 모양(폭 640 · 두 열 · 선 0 · 넘침 0)은 jsdom 이 재지 못해 `scripts/capture-6081.mjs`(Chromium)가 잰다.

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let path = "";

function LocationProbe() {
  const location = useLocation();
  path = location.pathname + location.search;
  return null;
}

async function mount() {
  const locale = await koreanLocale();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(LocaleProvider, {
        locale,
        children: createElement(
          MemoryRouter,
          { initialEntries: ["/c/general"] },
          createElement(ShortcutHelpDialog),
          createElement(LocationProbe)
        ),
      })
    )
  );
  act(() => {
    (document.querySelector('[data-testid="shortcut-help-trigger"]') as HTMLElement).click();
  });
}

const search = () => document.querySelector<HTMLInputElement>('[data-testid="shortcut-help-search"]')!;
const rowIds = () =>
  [...document.querySelectorAll('[data-testid="shortcut-help-dialog"] [data-shortcut-id]')].map((el) =>
    el.getAttribute("data-shortcut-id")
  );

function type(value: string) {
  const input = search();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  resetShortcutBindingsForTest();
  path = "";
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
});

describe("단축키 창 찾기 (#6081)", () => {
  it("열리면 캐럿이 찾기 칸에 있고, 친 말에 맞는 줄만 남고, 0건이면 빈 상태 문장이 선다", async () => {
    await mount();
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute("aria-label")).toBe("단축키 찾기");
    expect(rowIds()).toHaveLength(REGISTERED_SHORTCUTS.length);

    type("설정");
    expect(rowIds()).toEqual(["open-settings"]);

    // 묶음 머리도 재료다: 「메시지 행」은 그 묶음의 줄을 남긴다. 두 낱말은 둘 다 맞아야 한다.
    type("메시지 이동");
    expect(rowIds()).toEqual(["row-actions"]);

    // 한글 조합 중의 마지막 글자(「탐새」 → 탐색)도 맞는다.
    type("탐새");
    expect(rowIds()).toContain("toggle-sidebar");
    expect(rowIds().length).toBeLessThan(REGISTERED_SHORTCUTS.length);

    type("없는낱말");
    expect(rowIds()).toHaveLength(0);
    expect(document.querySelector('[data-testid="shortcut-help-empty"]')?.textContent).toBe("맞는 단축키가 없어요");

    type("");
    expect(rowIds()).toHaveLength(REGISTERED_SHORTCUTS.length);
    expect(document.querySelector('[data-testid="shortcut-help-empty"]')).toBeNull();
  });

  it("「단축키 바꾸기」가 창을 닫고 설정 › 단축키를 연다", async () => {
    await mount();
    const change = document.querySelector<HTMLButtonElement>('[data-testid="shortcut-help-change"]')!;
    expect(change.textContent).toBe("단축키 바꾸기");
    expect(document.querySelector('[data-testid="shortcut-help-dialog"]')?.textContent).toContain("로 다시 열 수 있어요");
    act(() => change.click());
    expect(path).toBe("/settings?section=shortcuts");
    expect(document.querySelector('[data-testid="shortcut-help-dialog"]')).toBeNull();
  });
});
