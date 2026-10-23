import { describe, expect, it } from "vitest";
import {
  cacheMatchesLook,
  lookKeyOf,
  parseThemeCache,
  serializeThemeCache,
  signalKeyOf,
  themeCacheKey,
  THEME_CACHE_MAX_KEY,
  THEME_CACHE_MAX_VARS,
  type ThemeCacheEntry,
} from "./themeCache";
import type { ThemeRef } from "./themeResolve";

// 부트 캐시의 계약(AP-1a #4186). 읽는 쪽은 부트 스크립트이고 이 모듈이 그 문법의 정본이다.

const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    key: "1|catalog:nord|-",
    vars: { "--ink": "light-dark(#2e3440, #d8dee9)", "--glass": "light-dark(rgba(255,254,252,.74), rgba(32,35,43,.72))", "--line": "#e7e4df" },
    ...over,
  });

describe("parseThemeCache: 전부 통과해야 하나도 안 꽂는다", () => {
  it("올바른 캐시를 읽는다", () => {
    const parsed = parseThemeCache(entry());
    expect(parsed?.key).toBe("1|catalog:nord|-");
    expect(Object.keys(parsed?.vars ?? {})).toEqual(["--ink", "--glass", "--line"]);
    expect(parsed).not.toHaveProperty("mode");
  });

  it("mode는 light·dark일 때만 싣는다", () => {
    expect(parseThemeCache(entry({ mode: "dark" }))?.mode).toBe("dark");
    expect(parseThemeCache(entry({ mode: "light" }))?.mode).toBe("light");
    expect(parseThemeCache(entry({ mode: "sepia" }))).toBeNull();
    expect(parseThemeCache(entry({ mode: 1 }))).toBeNull();
  });

  it("없거나 깨진 원문은 null", () => {
    for (const raw of [null, undefined, "", "{", "[]", "null", "3", '"x"']) {
      expect(parseThemeCache(raw as string | null | undefined), String(raw)).toBeNull();
    }
  });

  it("값에 들 수 없는 것: url()·var()·세미콜론·따옴표·중괄호·역슬래시·개행·콜론 스킴", () => {
    for (const bad of [
      "url(https://evil.test/x.png)",
      "light-dark(url(data:image/png;base64,AAAA), #fff)",
      "var(--ink)",
      "#fff; background: red",
      '#fff"',
      "#fff'",
      "{}",
      "#fff\\",
      "#fff\n",
      "expression(1)",
      "red",
      "rgb(1, 2, 3, 4, 5)",
      "light-dark(#fff)",
      "light-dark(#fff, #000, #111)",
      "#ggg",
      "",
      12,
      null,
    ]) {
      expect(parseThemeCache(entry({ vars: { "--ink": bad } })), JSON.stringify(bad)).toBeNull();
    }
  });

  it("값 하나만 나빠도 통째로 거절한다 (일부만 꽂지 않는다)", () => {
    const parsed = parseThemeCache(entry({ vars: { "--ink": "#112233", "--bad": "url(x)" } }));
    expect(parsed).toBeNull();
  });

  it("이름은 --소문자·숫자·하이픈만", () => {
    for (const bad of ["ink", "--Ink", "--", "---x", "--ink;x", "--a b", "--ink)", "__proto__", "constructor", "--" + "a".repeat(49)]) {
      expect(parseThemeCache(entry({ vars: { [bad]: "#112233" } })), bad).toBeNull();
    }
    expect(parseThemeCache(entry({ vars: { ["--" + "a".repeat(47)]: "#112233" } }))).not.toBeNull();
  });

  it("상한: 변수 수·키 길이·원문 크기·빈 목록", () => {
    const many = Object.fromEntries(Array.from({ length: THEME_CACHE_MAX_VARS + 1 }, (_, i) => [`--v${i}`, "#112233"]));
    expect(parseThemeCache(entry({ vars: many }))).toBeNull();
    const ok = Object.fromEntries(Array.from({ length: THEME_CACHE_MAX_VARS }, (_, i) => [`--v${i}`, "#112233"]));
    expect(parseThemeCache(entry({ vars: ok }))).not.toBeNull();
    expect(parseThemeCache(entry({ vars: {} }))).toBeNull();
    expect(parseThemeCache(entry({ key: "1|" + "a".repeat(THEME_CACHE_MAX_KEY) }))).toBeNull();
    expect(parseThemeCache(entry({ key: "1|catalog:nord|-", pad: "x".repeat(13_000) }))).toBeNull();
  });

  it("키에 들 수 없는 글자와 모양", () => {
    for (const bad of ["", "a b", "1|catalog:nord|-;", "1|catalog:nord|-\n", 5, null]) {
      expect(parseThemeCache(entry({ key: bad })), JSON.stringify(bad)).toBeNull();
    }
    expect(parseThemeCache(entry({ vars: [["--ink", "#112233"]] }))).toBeNull();
    expect(parseThemeCache(entry({ vars: "x" }))).toBeNull();
  });

  it("직렬화 → 읽기 왕복", () => {
    const source: ThemeCacheEntry = { key: "2|user:mine|#9C447C|h1", vars: { "--ink": "#112233" }, mode: "dark" };
    expect(parseThemeCache(serializeThemeCache(source))).toEqual(source);
  });
});

describe("키: 엔진 판 | 테마 | 신호", () => {
  const nord = { theme: "catalog:nord" as ThemeRef, signal: null };

  it("signalKeyOf", () => {
    expect(signalKeyOf(null)).toBe("-");
    expect(signalKeyOf({ preset: "seongun" })).toBe("seongun");
    expect(signalKeyOf({ custom: "#9C447C" })).toBe("#9C447C");
  });

  it("themeCacheKey는 엔진 판 뒤에 lookKey를 붙인다", () => {
    expect(lookKeyOf(nord)).toBe("catalog:nord|-");
    expect(themeCacheKey("7", nord)).toBe("7|catalog:nord|-");
  });

  it("엔진 판이 달라도 같은 모양이면 맞고, 뒤 칸이 더 붙어도 맞는다", () => {
    expect(cacheMatchesLook("1|catalog:nord|-", nord)).toBe(true);
    expect(cacheMatchesLook("99|catalog:nord|-", nord)).toBe(true);
    expect(cacheMatchesLook("1|catalog:nord|-|o3f2a", nord)).toBe(true);
  });

  it("다른 테마·다른 신호·접두사만 같은 참조는 맞지 않는다 (첫 페인트에 남의 색을 얹지 않는다)", () => {
    expect(cacheMatchesLook("1|catalog:nord-x|-", nord)).toBe(false);
    expect(cacheMatchesLook("1|catalog:nor|-", nord)).toBe(false);
    expect(cacheMatchesLook("1|catalog:nord|seongun", nord)).toBe(false);
    expect(cacheMatchesLook("1|dawnsky|-", nord)).toBe(false);
    expect(cacheMatchesLook("catalog:nord|-", nord)).toBe(false);
    expect(cacheMatchesLook("|catalog:nord|-", nord)).toBe(false);
    expect(cacheMatchesLook("", nord)).toBe(false);
  });

  it("신호가 직접 고른 색이면 그 색까지 같아야 맞는다", () => {
    const custom = { theme: "dawnsky" as ThemeRef, signal: { custom: "#9C447C" } };
    expect(cacheMatchesLook("1|dawnsky|#9C447C", custom)).toBe(true);
    expect(cacheMatchesLook("1|dawnsky|#9C447D", custom)).toBe(false);
  });
});
