import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FOCUS_MODALITY_ATTRIBUTE,
  applyFocusModality,
  initFocusModality,
} from "./focusModality";

const MAIN = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");

class FakeRoot {
  attrs: Record<string, string> = {};
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
}

function fakeDocument() {
  const documentElement = new FakeRoot();
  const listeners = new Map<string, EventListener[]>();
  return {
    documentElement,
    addEventListener(type: string, listener: EventListener): void {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type: string, listener: EventListener): void {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((item) => item !== listener)
      );
    },
    dispatch(type: string, event: Event): void {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

describe("#1866 포커스 모달리티", () => {
  it("시작은 pointer 이고 Tab 만 keyboard 로 올린다", () => {
    const doc = fakeDocument();
    const stop = initFocusModality(doc);
    expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE)).toBe(
      "pointer"
    );

    doc.dispatch("keydown", { key: "a" } as KeyboardEvent);
    expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE)).toBe(
      "pointer"
    );

    doc.dispatch("keydown", { key: "Tab" } as KeyboardEvent);
    expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE)).toBe(
      "keyboard"
    );

    doc.dispatch("pointerdown", { type: "pointerdown" } as Event);
    expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE)).toBe(
      "pointer"
    );
    stop();
  });

  it("해제 뒤에는 스탬프를 바꾸지 않는다", () => {
    const doc = fakeDocument();
    const stop = initFocusModality(doc);
    stop();
    applyFocusModality(doc, "keyboard");
    doc.dispatch("pointerdown", { type: "pointerdown" } as Event);
    expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE)).toBe(
      "keyboard"
    );
  });

  it("부트 경로가 스탬프를 켠다", () => {
    expect(MAIN).toContain("initFocusModality(document)");
  });
});
