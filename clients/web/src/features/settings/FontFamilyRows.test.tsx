// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FontFamilyRows } from "./FontFamilyRows";
import {
  APPEARANCE_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY_V1,
  getAppearance,
  reloadAppearanceForTest,
} from "@/design/theme";

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let hostEl: HTMLElement | null = null;

beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  localStorage.clear();
  reloadAppearanceForTest();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  hostEl?.remove();
  hostEl = null;
  localStorage.clear();
  reloadAppearanceForTest();
  vi.unstubAllGlobals();
});

function mount(tree: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  hostEl = host;
  root = createRoot(host);
  act(() => root?.render(tree));
  return host;
}

function byId<T extends HTMLElement>(host: HTMLElement, id: string): T {
  const node = host.querySelector<T>(`[data-testid="${id}"]`);
  expect(node, id).not.toBeNull();
  return node!;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submit(host: HTMLElement, id: string) {
  act(() => byId<HTMLButtonElement>(host, id).click());
}

const stored = () => JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}") as Record<string, unknown>;

describe("FontFamilyRows: 이름 직접 입력", () => {
  it("starts on the system fonts: empty fields, reset disabled, no custom variable", () => {
    const host = mount(createElement(FontFamilyRows));
    expect(byId<HTMLInputElement>(host, "font-sans-input").value).toBe("");
    expect(byId<HTMLButtonElement>(host, "font-reset").disabled).toBe(true);
    expect(document.documentElement.hasAttribute("data-font-sans")).toBe(false);
  });

  it("applies a name, stores it, and falls back through var(--font-sans)", () => {
    const host = mount(createElement(FontFamilyRows));
    type(byId<HTMLInputElement>(host, "font-sans-input"), "Pretendard");
    submit(host, "font-sans-apply");
    expect(getAppearance().fontSans).toBe("Pretendard");
    expect(stored().fontSans).toBe("Pretendard");
    expect(document.documentElement.getAttribute("data-font-sans")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-user-sans")).toBe(
      '"Pretendard", var(--font-sans)'
    );
    expect(byId<HTMLButtonElement>(host, "font-reset").disabled).toBe(false);
  });

  it("keeps the two fields independent", () => {
    const host = mount(createElement(FontFamilyRows));
    type(byId<HTMLInputElement>(host, "font-mono-input"), "D2Coding");
    submit(host, "font-mono-apply");
    expect(getAppearance().fontMono).toBe("D2Coding");
    expect(getAppearance().fontSans).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--font-user-mono")).toBe(
      '"D2Coding", var(--font-mono)'
    );
  });

  it("refuses an unsafe name with a sentence and leaves the page untouched", () => {
    const host = mount(createElement(FontFamilyRows));
    type(byId<HTMLInputElement>(host, "font-sans-input"), 'Evil"; } body { x');
    submit(host, "font-sans-apply");
    expect(byId(host, "font-sans-error").textContent).toContain("글꼴 이름에는");
    expect(byId<HTMLInputElement>(host, "font-sans-input").getAttribute("aria-invalid")).toBe("true");
    expect(getAppearance().fontSans).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--font-user-sans")).toBe("");
  });

  it("resets both fields to the system fonts", () => {
    const host = mount(createElement(FontFamilyRows));
    type(byId<HTMLInputElement>(host, "font-sans-input"), "Pretendard");
    submit(host, "font-sans-apply");
    type(byId<HTMLInputElement>(host, "font-mono-input"), "D2Coding");
    submit(host, "font-mono-apply");
    submit(host, "font-reset");
    expect(byId<HTMLInputElement>(host, "font-sans-input").value).toBe("");
    expect(byId<HTMLInputElement>(host, "font-mono-input").value).toBe("");
    expect(stored().fontSans).toBeUndefined();
    expect(document.documentElement.hasAttribute("data-font-sans")).toBe(false);
    expect(document.documentElement.hasAttribute("data-font-mono")).toBe(false);
  });

  it("restores a saved name into the field on load (v2 record)", () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        v: 2,
        scheme: "system",
        theme: "dawnsky",
        signal: null,
        density: "comfortable",
        fontSans: "Pretendard",
      })
    );
    reloadAppearanceForTest();
    const host = mount(createElement(FontFamilyRows));
    expect(byId<HTMLInputElement>(host, "font-sans-input").value).toBe("Pretendard");
  });

  // AP-1a(#4186) AC 1: 저장이 v2로 옮겨 가도 **글꼴 설정이 사라지지 않는다**. v1 레코드를 읽어
  // 두 칸에 그대로 채우고, 처음 바꾸는 순간 v2로 써서 이어 간다. v1 항목은 지우지 않는다.
  it("keeps both fonts when the person is still on the v1 record, and carries them into v2", () => {
    const v1 = JSON.stringify({ scheme: "dark", accent: "seongun", fontSans: "Pretendard", fontMono: "D2Coding" });
    localStorage.setItem(APPEARANCE_STORAGE_KEY_V1, v1);
    reloadAppearanceForTest();
    const host = mount(createElement(FontFamilyRows));
    expect(byId<HTMLInputElement>(host, "font-sans-input").value).toBe("Pretendard");
    expect(byId<HTMLInputElement>(host, "font-mono-input").value).toBe("D2Coding");
    expect(document.documentElement.style.getPropertyValue("--font-user-sans")).toBe(
      '"Pretendard", var(--font-sans)'
    );

    // 한 칸을 바꾸면 v2가 처음 쓰이고, 바꾸지 않은 칸과 v1에서 온 나머지(스킴·신호)가 같이 간다.
    type(byId<HTMLInputElement>(host, "font-mono-input"), "Menlo");
    submit(host, "font-mono-apply");
    expect(stored()).toMatchObject({
      v: 2,
      scheme: "dark",
      signal: { preset: "seongun" },
      fontSans: "Pretendard",
      fontMono: "Menlo",
    });
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY_V1)).toBe(v1);
  });
});

describe("FontFamilyRows: 설치된 글꼴 목록", () => {
  it("says so and hides the button when queryLocalFonts is missing", () => {
    const host = mount(createElement(FontFamilyRows));
    expect(host.querySelector('[data-testid="font-list-load"]')).toBeNull();
    expect(byId(host, "font-list").textContent).toContain("이 앱에서는 설치된 글꼴 목록을 볼 수 없어요");
  });

  it("loads families into the datalist and applies a picked candidate", async () => {
    vi.stubGlobal("queryLocalFonts", async () => [{ family: "Menlo" }, { family: "Pretendard" }, { family: "Menlo" }]);
    const host = mount(createElement(FontFamilyRows));
    await act(async () => byId<HTMLButtonElement>(host, "font-list-load").click());
    expect(byId(host, "font-list").textContent).toContain("설치된 글꼴 2개를 불러왔어요");
    const input = byId<HTMLInputElement>(host, "font-sans-input");
    const options = [...(document.getElementById(input.getAttribute("list") ?? "")?.querySelectorAll("option") ?? [])];
    expect(options.map((o) => o.value)).toEqual(["Menlo", "Pretendard"]);
    type(input, "Pretendard");
    expect(getAppearance().fontSans).toBe("Pretendard");
  });

  it("tells a denied permission in a sentence and keeps the input usable", async () => {
    vi.stubGlobal("queryLocalFonts", async () => {
      const error = new Error("denied");
      error.name = "NotAllowedError";
      throw error;
    });
    const host = mount(createElement(FontFamilyRows));
    await act(async () => byId<HTMLButtonElement>(host, "font-list-load").click());
    expect(byId(host, "font-list").textContent).toContain("권한이 없어요");
    expect(byId<HTMLInputElement>(host, "font-sans-input").disabled).toBe(false);
  });

  it("tells an unexpected failure apart from a denial", async () => {
    vi.stubGlobal("queryLocalFonts", async () => {
      throw new TypeError("boom");
    });
    const host = mount(createElement(FontFamilyRows));
    await act(async () => byId<HTMLButtonElement>(host, "font-list-load").click());
    expect(byId(host, "font-list").textContent).toContain("불러오지 못했어요");
  });

  it("disables the button and says it is loading while the call is pending", async () => {
    let finish: (value: { family: string }[]) => void = () => {};
    vi.stubGlobal("queryLocalFonts", () => new Promise((resolve) => (finish = resolve)));
    const host = mount(createElement(FontFamilyRows));
    act(() => byId<HTMLButtonElement>(host, "font-list-load").click());
    expect(byId<HTMLButtonElement>(host, "font-list-load").disabled).toBe(true);
    expect(byId(host, "font-list").textContent).toContain("불러오고 있어요");
    await act(async () => finish([{ family: "Menlo" }]));
    expect(byId<HTMLButtonElement>(host, "font-list-load").disabled).toBe(false);
  });
});
