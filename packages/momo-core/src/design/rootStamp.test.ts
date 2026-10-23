import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, ROOT_ATTRIBUTES, type WebAppearance } from "./appearance";
import {
  accentOfSignal,
  LEGACY_ACCENT_ATTRIBUTE,
  rootStamp,
  signalOfAccent,
  signalStamp,
  STAMPED_ATTRIBUTES,
} from "./rootStamp";
import { modesOf, type ModesLookup } from "./themeResolve";

const base: WebAppearance = { ...DEFAULT_APPEARANCE };
const NONE = null;

describe("루트 속성 스탬프 규칙 표", () => {
  it("기본 레코드: 스킴·신호·강조·배경은 없고 나머지는 기본값으로 찍힌다", () => {
    expect(rootStamp(base)).toEqual({
      "data-theme": NONE,
      "data-palette": "dawnsky",
      "data-theme-ref": "dawnsky",
      "data-signal": NONE,
      "data-accent": "dawn",
      "data-density": "comfortable",
      "data-font-size": "default",
      "data-thread-layout": "split",
      "data-prominent-active": NONE,
      "data-wallpaper": NONE,
    });
  });

  it("전부 기본이 아닌 레코드", () => {
    const state: WebAppearance = {
      ...base,
      scheme: "dark",
      theme: "noeul",
      signal: { preset: "hongyeom" },
      density: "compact",
      fontSize: "larger",
      threadLayout: "focus",
      prominentActive: true,
      wallpaper: { kind: "preset", id: "bam" },
    };
    expect(rootStamp(state)).toEqual({
      "data-theme": "dark",
      "data-palette": "noeul",
      "data-theme-ref": "noeul",
      "data-signal": "hongyeom",
      "data-accent": "hongyeom",
      "data-density": "compact",
      "data-font-size": "larger",
      "data-thread-layout": "focus",
      "data-prominent-active": "",
      "data-wallpaper": "preset",
    });
  });

  it("직접 고른 색: data-signal은 custom, 옛 data-accent는 기본(정적 바인딩이 없다)", () => {
    const state: WebAppearance = { ...base, signal: { custom: "#9C447C" } };
    expect(rootStamp(state)["data-signal"]).toBe("custom");
    expect(rootStamp(state)["data-accent"]).toBe("dawn");
  });

  it("카탈로그 참조: 팔레트는 derived, 참조는 그대로", () => {
    const stamp = rootStamp({ ...base, theme: "catalog:nord", scheme: "light" });
    expect(stamp["data-palette"]).toBe("derived");
    expect(stamp["data-theme-ref"]).toBe("catalog:nord");
  });

  it("배경은 종류(kind)가 속성값이다", () => {
    for (const kind of ["solid", "preset", "image"] as const) {
      const wallpaper = kind === "image" ? { kind } : { kind, id: "bam" };
      expect(rootStamp({ ...base, wallpaper })["data-wallpaper"]).toBe(kind);
    }
  });

  it("단일 모드 테마는 스킴 선택과 무관하게 그 모드로 못 박는다 (모드는 인자로 받는다)", () => {
    const lookup: ModesLookup = (ref) => (ref === "catalog:solo-dark" ? ["dark"] : null);
    const state: WebAppearance = { ...base, theme: "catalog:solo-dark", scheme: "system" };
    expect(rootStamp(state, modesOf(state.theme, lookup))["data-theme"]).toBe("dark");
    expect(rootStamp({ ...state, scheme: "light" }, modesOf(state.theme, lookup))["data-theme"]).toBe("dark");
    // 모드를 알려 주지 않으면 둘 다로 본다.
    expect(rootStamp(state)["data-theme"]).toBeNull();
  });
});

describe("속성 이름 목록", () => {
  it("저장소가 찍는 이름은 ROOT_ATTRIBUTES에서 data-glass만 뺀 것 + 옛 data-accent다", () => {
    const expected = [
      ...Object.entries(ROOT_ATTRIBUTES)
        .filter(([key]) => key !== "glass")
        .map(([, name]) => name),
      LEGACY_ACCENT_ATTRIBUTE,
    ].sort();
    expect([...STAMPED_ATTRIBUTES].sort()).toEqual(expected);
  });

  it("data-glass는 예약만 되고 스탬프에 오르지 않는다 (planner 결정 2026-10-22)", () => {
    expect(ROOT_ATTRIBUTES.glass).toBe("data-glass");
    expect(STAMPED_ATTRIBUTES).not.toContain("data-glass");
    expect(Object.keys(rootStamp(base))).not.toContain("data-glass");
  });

  it("스탬프의 키 집합은 이름 목록과 같다", () => {
    expect(Object.keys(rootStamp(base)).sort()).toEqual([...STAMPED_ATTRIBUTES].sort());
  });
});

describe("신호 ↔ 옛 액센트", () => {
  it("signalStamp·accentOfSignal", () => {
    expect(signalStamp(null)).toBeNull();
    expect(signalStamp({ preset: "gamram" })).toBe("gamram");
    expect(signalStamp({ custom: "#112233" })).toBe("custom");
    expect(accentOfSignal(null)).toBe("dawn");
    expect(accentOfSignal({ preset: "gamram" })).toBe("gamram");
    expect(accentOfSignal({ custom: "#112233" })).toBe("dawn");
  });

  it("signalOfAccent: 프리셋 id만 프리셋이고 dawn·모르는 값은 테마 기본 신호", () => {
    expect(signalOfAccent("seongun")).toEqual({ preset: "seongun" });
    for (const id of ["dawn", "indigo", "", null, 3]) expect(signalOfAccent(id)).toBeNull();
  });
});
