// @vitest-environment jsdom

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyFirstAgentFocus,
  clearAllFirstAgentMarkers,
  markFirstAgentFocusTarget,
  takeFirstAgentFocusTarget,
} from "./firstAgentStore";

beforeEach(() => {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const make = (store: Map<string, string>) => ({
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("localStorage", make(local));
  vi.stubGlobal("sessionStorage", make(session));
  document.body.innerHTML = "";
  document.body.focus();
});

afterEach(() => {
  clearAllFirstAgentMarkers();
  vi.unstubAllGlobals();
});

describe("핸드오프 초점", () => {
  it("플래그가 없으면 body 에 남는다", () => {
    document.body.innerHTML = `<textarea id="composer-input"></textarea>`;
    applyFirstAgentFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it("컴포저가 있으면 그곳으로 옮긴다", () => {
    document.body.innerHTML = `<textarea id="composer-input"></textarea>`;
    const input = document.getElementById("composer-input");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("input");
    markFirstAgentFocusTarget();
    applyFirstAgentFocus();
    expect(document.activeElement).toBe(input);
    expect(takeFirstAgentFocusTarget()).toBe(false);
  });

  it("컴포저가 없으면 채널 제목으로 옮긴다", () => {
    document.body.innerHTML =
      `<header data-testid="channel-header"><h1 tabindex="-1">general</h1></header>`;
    const heading = document.querySelector("h1");
    if (!(heading instanceof HTMLElement)) throw new Error("heading");
    markFirstAgentFocusTarget();
    applyFirstAgentFocus();
    expect(document.activeElement).toBe(heading);
  });
});
