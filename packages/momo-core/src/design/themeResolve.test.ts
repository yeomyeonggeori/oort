import { describe, expect, it } from "vitest";
import {
  DERIVED_PALETTE,
  effectiveScheme,
  isThemeRef,
  modesOf,
  normalizeThemeRef,
  paletteOf,
  splitThemeRef,
  THEME_REF_ID_MAX,
  type ModesLookup,
  type ThemeRef,
} from "./themeResolve";
import { MODES, THEME_IDS, THEME_ID_RE } from "./themes";

// AP-1a(#4186) 골격: 첫 파티 3종의 모드와 단일 모드 규칙을 **가짜 단일 모드 참조**로 잰다.
// 카탈로그가 들어오는 AP-1b에서 같은 규칙이 진짜 데이터 위에서 다시 돈다.

const SOLO_DARK = "catalog:solo-dark" as const satisfies ThemeRef;
const SOLO_LIGHT = "catalog:solo-light" as const satisfies ThemeRef;
const PAIR = "catalog:pair" as const satisfies ThemeRef;

const fake: ModesLookup = (ref) => {
  switch (ref) {
    case SOLO_DARK:
      return ["dark"];
    case SOLO_LIGHT:
      return ["light"];
    case PAIR:
      return ["dark", "light"];
    default:
      return null;
  }
};

describe("ThemeRef 문법", () => {
  it("첫 파티 id는 기존 핀(소문자만)을 그대로 쓴다 — 핀을 넓히지 않는다", () => {
    expect(THEME_ID_RE.source).toBe("^[a-z]+$");
    for (const id of THEME_IDS) expect(isThemeRef(id)).toBe(true);
    expect(isThemeRef("github-light-default")).toBe(false);
  });

  it("카탈로그·사용자 참조는 `네임스페이스:id`다", () => {
    for (const ok of ["catalog:github-default", "catalog:nord", "user:abc123", "user:a-1-b"]) {
      expect(isThemeRef(ok), ok).toBe(true);
    }
    expect(splitThemeRef("catalog:github-default")).toEqual({ namespace: "catalog", id: "github-default" });
    expect(splitThemeRef("user:x1")).toEqual({ namespace: "user", id: "x1" });
  });

  it("문법이 틀리면 참조가 아니다", () => {
    const tooLong = `catalog:${"a".repeat(THEME_REF_ID_MAX + 1)}`;
    for (const bad of [
      "catalog:", ":nord", "catalog", "Catalog:nord", "catalog:Nord", "catalog:nord_x", "catalog:-nord", "catalog:nord-",
      "catalog:no--rd", "catalog:a b", "theme:nord", "catalog:nord:x", tooLong, "", 3, null, undefined, {},
    ]) {
      expect(isThemeRef(bad), JSON.stringify(bad)).toBe(false);
      expect(splitThemeRef(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("normalizeThemeRef: 모르는 값은 새벽하늘", () => {
    expect(normalizeThemeRef("noeul")).toBe("noeul");
    expect(normalizeThemeRef("catalog:nord")).toBe("catalog:nord");
    for (const bad of ["neon", "catalog:", 5, null, undefined]) expect(normalizeThemeRef(bad)).toBe("dawnsky");
  });
});

describe("paletteOf: 루트 data-palette에 찍을 값", () => {
  it("첫 파티는 자기 id, 나머지는 derived", () => {
    for (const id of THEME_IDS) expect(paletteOf(id)).toBe(id);
    expect(paletteOf("catalog:nord")).toBe(DERIVED_PALETTE);
    expect(paletteOf("user:mine")).toBe("derived");
  });
});

describe("modesOf", () => {
  it("첫 파티 3종은 라이트·다크 둘 다다 (AC 8)", () => {
    for (const id of THEME_IDS) expect(modesOf(id)).toEqual(["light", "dark"]);
    expect([...modesOf("dawnsky")]).toEqual([...MODES]);
  });

  it("조회가 무엇을 말하든 첫 파티는 둘 다다 (카탈로그가 첫 파티를 가릴 수 없다)", () => {
    const lying: ModesLookup = () => ["dark"];
    for (const id of THEME_IDS) expect(modesOf(id, lying)).toEqual(["light", "dark"]);
  });

  it("가짜 단일 모드 참조는 조회가 말하는 대로다", () => {
    expect(modesOf(SOLO_DARK, fake)).toEqual(["dark"]);
    expect(modesOf(SOLO_LIGHT, fake)).toEqual(["light"]);
    expect(modesOf(PAIR, fake)).toEqual(["light", "dark"]);
  });

  it("조회가 없거나 모르거나 비었으면 둘 다로 본다 (깨진 데이터가 한 모드에 가두지 않는다)", () => {
    expect(modesOf(SOLO_DARK)).toEqual(["light", "dark"]);
    expect(modesOf("catalog:unknown", fake)).toEqual(["light", "dark"]);
    expect(modesOf(SOLO_DARK, () => [])).toEqual(["light", "dark"]);
    expect(modesOf(SOLO_DARK, () => undefined)).toEqual(["light", "dark"]);
  });

  it("순서는 라이트·다크로 맞추고 중복을 접는다", () => {
    expect(modesOf(PAIR, () => ["dark", "light"])).toEqual(["light", "dark"]);
    expect(modesOf(SOLO_DARK, () => ["dark", "dark"])).toEqual(["dark"]);
  });
});

describe("effectiveScheme: 단일 모드 테마는 그 모드로 못 박는다", () => {
  const both = modesOf("dawnsky");

  it("모드가 둘이면 사람이 고른 대로, 시스템이면 찍지 않는다(null)", () => {
    expect(effectiveScheme("system", both)).toBeNull();
    expect(effectiveScheme("light", both)).toBe("light");
    expect(effectiveScheme("dark", both)).toBe("dark");
  });

  it("다크 단독: 시스템이든 라이트든 다크다", () => {
    const solo = modesOf(SOLO_DARK, fake);
    expect(effectiveScheme("system", solo)).toBe("dark");
    expect(effectiveScheme("light", solo)).toBe("dark");
    expect(effectiveScheme("dark", solo)).toBe("dark");
  });

  it("라이트 단독: 시스템이든 다크든 라이트다", () => {
    const solo = modesOf(SOLO_LIGHT, fake);
    expect(effectiveScheme("system", solo)).toBe("light");
    expect(effectiveScheme("dark", solo)).toBe("light");
    expect(effectiveScheme("light", solo)).toBe("light");
  });

  it("짝 테마는 단일 모드 규칙을 타지 않는다", () => {
    expect(effectiveScheme("system", modesOf(PAIR, fake))).toBeNull();
  });
});
