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

  // #2938 ②: 화살표·Home/End·PageUp/Down도 캐럿을 옮기는 키보드 탐색이다(설정 절
  // 목록·라디오 묶음·메뉴). 반면 Esc·Enter·수정 키·단축키는 탐색이 아니다: 마우스로
  // 쓰던 사람이 Esc로 설정을 닫거나 ⌘를 눌렀다고 방금 누른 버튼에 링이 서면 안 된다
  // (Chromium·WebKit은 포커스가 있는 채로 **아무 키**나 눌리면 그 요소를
  // :focus-visible로 친다 — 제품 빌드 실측, scripts/capture-focus-ring.mjs).
  it("캐럿을 옮기는 키만 keyboard 로 올린다(#2938)", () => {
    const button = { tagName: "BUTTON", isContentEditable: false } as unknown as EventTarget;
    const at = (key: string, target: EventTarget = button, extra: object = {}) =>
      ({ key, target, ...extra }) as unknown as KeyboardEvent;
    for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "PageDown", "PageUp"]) {
      const doc = fakeDocument();
      const stop = initFocusModality(doc);
      doc.dispatch("keydown", at(key));
      expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE), key).toBe("keyboard");
      stop();
    }
    for (const key of ["Escape", "Enter", " ", "Shift", "Meta", "Control", "Alt", "a"]) {
      const doc = fakeDocument();
      const stop = initFocusModality(doc);
      doc.dispatch("keydown", at(key));
      expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE), key).toBe("pointer");
      stop();
    }
    // ⌘↓ 같은 단축키는 탐색이 아니다.
    const doc = fakeDocument();
    const stop = initFocusModality(doc);
    doc.dispatch("keydown", at("ArrowDown", button, { metaKey: true }));
    expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE)).toBe("pointer");
    stop();
  });

  it("글 입력 칸 안의 화살표는 캐럿 이동이라 모달리티를 바꾸지 않는다(#1866 그릇 링 유지)", () => {
    const doc = fakeDocument();
    const stop = initFocusModality(doc);
    const textarea = { tagName: "TEXTAREA", isContentEditable: false } as unknown as EventTarget;
    const input = { tagName: "INPUT", type: "text", isContentEditable: false } as unknown as EventTarget;
    const editor = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
    for (const target of [textarea, input, editor]) {
      doc.dispatch("keydown", { key: "ArrowUp", target } as unknown as KeyboardEvent);
      expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE)).toBe("pointer");
    }
    // 라디오·체크박스 input 의 화살표는 탐색이다.
    const radio = { tagName: "INPUT", type: "radio", isContentEditable: false } as unknown as EventTarget;
    doc.dispatch("keydown", { key: "ArrowDown", target: radio } as unknown as KeyboardEvent);
    expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE)).toBe("keyboard");
    // Tab 은 글 입력 칸 안에서도 탐색이다.
    doc.dispatch("pointerdown", { type: "pointerdown" } as Event);
    doc.dispatch("keydown", { key: "Tab", target: textarea } as unknown as KeyboardEvent);
    expect(doc.documentElement.getAttribute(FOCUS_MODALITY_ATTRIBUTE)).toBe("keyboard");
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
