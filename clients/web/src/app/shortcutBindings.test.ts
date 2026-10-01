// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COMBOS,
  SHORTCUT_STORAGE_KEY,
  checkBinding,
  effectiveCombos,
  parseStoredOverrides,
  resetAllBindings,
  resetBinding,
  resetShortcutBindingsForTest,
  setBinding,
  shortcutStorageFailed,
  swapBindings,
  type ShortcutCombo,
} from "./shortcutBindings";
import {
  OPEN_INBOX_SHORTCUT,
  OPEN_QUICK_SWITCHER_SHORTCUT,
  OPEN_SETTINGS_SHORTCUT,
  TOGGLE_SIDEBAR_SHORTCUT,
  shouldToggleSidebar,
} from "./keyboardShortcuts";

// #3281: 재지정 판정(충돌·예약·터미널), 저장소 읽기(항목별 폴백), 등록표가 재지정을 읽는지.
// 각 시험은 가드를 지우면 실패한다(PR 본문의 사보타주 기록).

const mac = { desktop: true, platform: "mac" as const };
const web = { desktop: false, platform: "mac" as const };
const P: ShortcutCombo = { code: "KeyG", shift: true, alt: false };

function ctx(over: Partial<typeof mac> = {}, effective = effectiveCombos()) {
  return { ...mac, ...over, effective };
}

beforeEach(() => {
  localStorage.clear();
  resetShortcutBindingsForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetShortcutBindingsForTest();
});

describe("checkBinding", () => {
  it("다른 앱 단축키와 겹치면 막고 상대 id를 돌려준다", () => {
    const result = checkBinding("open-settings", DEFAULT_COMBOS["open-quick-switcher"], ctx());
    expect(result).toMatchObject({ ok: false, kind: "conflict", conflictId: "open-quick-switcher" });
  });

  it("재지정 뒤의 유효 키로 충돌을 잰다(기본 키가 아니라)", () => {
    setBinding("open-quick-switcher", P);
    expect(
      checkBinding("open-settings", P, ctx()).ok
    ).toBe(false);
    // 비워진 기본 키는 이제 쓸 수 있다.
    expect(
      checkBinding("open-settings", DEFAULT_COMBOS["open-quick-switcher"], ctx()).ok
    ).toBe(true);
  });

  it("예약 키를 막는다: ⌘Q ⌘W ⌘C ⌘V ⌘X ⌘Z ⌘A와 입력 칸 서식 ⌘B ⌘I ⌘U", () => {
    for (const code of ["KeyQ", "KeyW", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyA", "KeyB", "KeyI", "KeyU"]) {
      const result = checkBinding("open-inbox", { code, shift: false, alt: false }, ctx());
      expect(result, code).toMatchObject({ ok: false, kind: "reserved" });
    }
  });

  it("Tab·Esc·Enter 같은 키는 지원 키가 아니다", () => {
    for (const code of ["Tab", "Escape", "Enter", "Space"]) {
      expect(checkBinding("open-inbox", { code, shift: false, alt: false }, ctx())).toMatchObject({
        ok: false,
        kind: "invalid",
      });
    }
  });

  it("브라우저 예약 키(⌘T)는 웹에서만 막는다", () => {
    const t = { code: "KeyF", shift: false, alt: false };
    expect(checkBinding("open-inbox", t, ctx(web))).toMatchObject({ ok: false, kind: "reserved" });
    expect(checkBinding("open-inbox", t, ctx())).toEqual({ ok: true });
  });

  it("데스크탑에서 터미널이 앱으로 넘기는 키(⌘J, ⌘D, ⌘])는 막고, 웹에서는 막지 않는다", () => {
    for (const code of ["KeyJ", "KeyD", "BracketRight"]) {
      const combo = { code, shift: false, alt: false };
      expect(checkBinding("open-inbox", combo, ctx()), code).toMatchObject({
        ok: false,
        kind: "terminal",
      });
    }
    expect(checkBinding("open-inbox", { code: "KeyJ", shift: false, alt: false }, ctx({ desktop: false }))).toEqual({
      ok: true,
    });
  });

  it("무관한 새 키는 통과한다", () => {
    expect(checkBinding("open-inbox", P, ctx())).toEqual({ ok: true });
  });
});

describe("저장소 읽기: 항목별로 걸러 기본 키로 폴백", () => {
  const stored = (bindings: Record<string, unknown>, version: unknown = 1) =>
    JSON.stringify({ version, bindings });

  it("깨진 JSON·다른 버전·모양이 틀린 값은 전부 기본이다", () => {
    expect(parseStoredOverrides("{not json", mac)).toEqual({});
    expect(parseStoredOverrides(stored({ "open-inbox": P }, 2), mac)).toEqual({});
    expect(parseStoredOverrides(JSON.stringify([1, 2]), mac)).toEqual({});
    expect(parseStoredOverrides(null, mac)).toEqual({});
  });

  it("한 항목이 깨져도 나머지는 산다", () => {
    const result = parseStoredOverrides(
      stored({
        "open-inbox": P,
        "open-settings": { code: "Nope", shift: false, alt: false },
        "open-new-dm": { code: "KeyK", shift: "yes", alt: false },
        "does-not-exist": P,
      }),
      mac
    );
    expect(result).toEqual({ "open-inbox": P });
  });

  it("예약 키·터미널 키로 저장된 항목은 기본으로 돌아간다", () => {
    const result = parseStoredOverrides(
      stored({
        "open-inbox": { code: "KeyQ", shift: false, alt: false },
        "open-settings": { code: "KeyJ", shift: false, alt: false },
      }),
      mac
    );
    expect(result).toEqual({});
  });

  it("서로 겹치는 저장 항목은 한쪽을 기본으로 돌려 충돌을 남기지 않는다", () => {
    const result = parseStoredOverrides(
      stored({ "open-inbox": P, "open-settings": P }),
      mac
    );
    expect(Object.keys(result)).toHaveLength(1);
    const effective = effectiveCombos(result);
    const keys = Object.values(effective).map((c) => `${c.code}${c.shift}${c.alt}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("서로 바꾼 두 항목(기본 키를 교차)은 겹침이 아니라 그대로 산다", () => {
    const result = parseStoredOverrides(
      stored({
        "open-quick-switcher": DEFAULT_COMBOS["open-settings"],
        "open-settings": DEFAULT_COMBOS["open-quick-switcher"],
      }),
      mac
    );
    expect(Object.keys(result).sort()).toEqual(["open-quick-switcher", "open-settings"]);
  });
});

describe("저장과 등록표", () => {
  it("setBinding은 저장하고, 다시 읽어도 같다(기기 로컬·버전 포함)", () => {
    setBinding("open-inbox", P);
    const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual({ version: 1, bindings: { "open-inbox": P } });
    resetShortcutBindingsForTest();
    expect(effectiveCombos()["open-inbox"]).toEqual(P);
  });

  it("저장소가 던져도 메모리에서 동작하고 실패를 알린다", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    setBinding("open-inbox", P);
    expect(shortcutStorageFailed()).toBe(true);
    expect(OPEN_INBOX_SHORTCUT.matches({ key: "g", code: "KeyG", metaKey: true, shiftKey: true })).toBe(true);
  });

  it("저장소 읽기가 던져도 기본 키로 시작한다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    resetShortcutBindingsForTest();
    expect(effectiveCombos()["open-inbox"]).toEqual(DEFAULT_COMBOS["open-inbox"]);
  });

  it("matches와 keycaps가 재지정을 읽고, 초기화하면 원래 판정으로 돌아간다", () => {
    const newKey = { key: "ㅎ", code: "KeyG", metaKey: true, shiftKey: true };
    const oldKey = { key: "a", code: "KeyA", metaKey: true, shiftKey: true };
    expect(OPEN_INBOX_SHORTCUT.matches(oldKey)).toBe(true);
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧A"]);

    setBinding("open-inbox", P);
    expect(OPEN_INBOX_SHORTCUT.matches(newKey)).toBe(true);
    expect(OPEN_INBOX_SHORTCUT.matches(oldKey)).toBe(false);
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧G"]);

    resetBinding("open-inbox");
    expect(OPEN_INBOX_SHORTCUT.matches(oldKey)).toBe(true);
    expect(OPEN_INBOX_SHORTCUT.matches(newKey)).toBe(false);
  });

  it("swapBindings는 두 항목의 키를 한 번에 맞바꾼다", () => {
    swapBindings("open-quick-switcher", "open-settings");
    expect(OPEN_QUICK_SWITCHER_SHORTCUT.keycaps).toEqual(["⌘,"]);
    expect(OPEN_SETTINGS_SHORTCUT.keycaps).toEqual(["⌘K"]);
    expect(OPEN_SETTINGS_SHORTCUT.matches({ key: "k", code: "KeyK", metaKey: true })).toBe(true);
  });

  it("모두 초기화는 저장 항목을 지운다", () => {
    setBinding("open-inbox", P);
    resetAllBindings();
    expect(localStorage.getItem(SHORTCUT_STORAGE_KEY)).toBeNull();
    expect(OPEN_INBOX_SHORTCUT.keycaps).toEqual(["⌘⇧A"]);
  });
});

describe("⌘B 재지정과 터미널(ADR-0190 D5)", () => {
  function target(inTerminal: boolean): EventTarget {
    const host = document.createElement("div");
    if (inTerminal) host.className = "xterm";
    const el = document.createElement(inTerminal ? "textarea" : "button");
    host.append(el);
    document.body.append(host);
    return el;
  }
  const cmdB = { code: "KeyB", key: "b", metaKey: true };
  const cmdShiftY = { code: "KeyY", key: "y", metaKey: true, shiftKey: true };

  it("재지정하면 일반 포커스에서는 새 키로 접고 옛 ⌘B로는 접지 않는다", () => {
    setBinding("toggle-sidebar", { code: "KeyY", shift: true, alt: false });
    expect(TOGGLE_SIDEBAR_SHORTCUT.keycaps).toEqual(["⌘⇧Y"]);
    expect(shouldToggleSidebar({ ...cmdShiftY, target: target(false) }, "mac")).toBe(true);
    expect(shouldToggleSidebar({ ...cmdB, target: target(false) }, "mac")).toBe(false);
  });

  it("터미널 안에서는 재지정과 상관없이 macOS ⌘B만 앱이 받고, 새 키는 통과하지 않는다", () => {
    setBinding("toggle-sidebar", { code: "KeyY", shift: true, alt: false });
    expect(shouldToggleSidebar({ ...cmdB, target: target(true) }, "mac")).toBe(true);
    expect(shouldToggleSidebar({ ...cmdShiftY, target: target(true) }, "mac")).toBe(false);
  });

  it("비 mac Ctrl+B는 재지정과 상관없이 터미널 몫이다", () => {
    setBinding("toggle-sidebar", { code: "KeyY", shift: true, alt: false });
    expect(
      shouldToggleSidebar({ code: "KeyB", key: "b", ctrlKey: true, target: target(true) }, "other")
    ).toBe(false);
  });
});
