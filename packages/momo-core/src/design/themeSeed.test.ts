import { describe, expect, it } from "vitest";
import { toOklch } from "./color";
import { deriveThemeMode } from "./derive";
import {
  CATALOG_ALLOWED_SPDX,
  SEED_KEYS,
  SEED_MIN_CHROMA,
  extractSeed,
  isAllowedSpdx,
  readThemeColor,
  seedMode,
} from "./themeSeed";

// =============================================================================
// 씨앗 추출 (AP-1b #4188, ADR-0189 증보 3 D2). Buzz `theme-loader.ts`의 추출을 옮기되 결함을 옮기지 않는다:
// Buzz는 comment 색을 `settings`만 읽는데 shiki 4.1.0 테마 모듈에는 `settings`가 없고 `tokenColors`만 있다.
// =============================================================================

const BASE = { "editor.background": "#101820", "editor.foreground": "#e6e6e6" };

describe("readThemeColor: #RRGGBB 계열만 읽고 알파는 버린다", () => {
  it.each([
    ["#ABCDEF", "#abcdef"],
    ["#abc", "#aabbcc"],
    ["#abcd", "#aabbcc"],
    ["#abcdef80", "#abcdef"],
    ["  #123456  ", "#123456"],
  ])("%s → %s", (raw, expected) => {
    expect(readThemeColor(raw)).toBe(expected);
  });

  it.each(["rgb(1,2,3)", "red", "#12", "#12345", "#1234567", "#ggg", "abcdef", "", null, undefined, 7, {}])(
    "%j는 읽지 않는다",
    (raw) => {
      expect(readThemeColor(raw)).toBeNull();
    }
  );
});

describe("extractSeed: 필수와 선택", () => {
  it("배경·글자만 있으면 그 둘만 담는다", () => {
    expect(extractSeed({ colors: BASE })).toEqual({ bg: "#101820", fg: "#e6e6e6" });
  });

  it("배경이나 글자가 없거나 읽을 수 없으면 null이다 (가져오기가 필수 키 없음을 말해야 한다)", () => {
    expect(extractSeed({ colors: { "editor.background": "#101820" } })).toBeNull();
    expect(extractSeed({ colors: { "editor.foreground": "#e6e6e6" } })).toBeNull();
    expect(extractSeed({ colors: { ...BASE, "editor.foreground": "rgb(1,2,3)" } })).toBeNull();
    expect(extractSeed({})).toBeNull();
    expect(extractSeed({ colors: [] })).toBeNull();
  });

  it("객체가 아닌 입력에도 던지지 않는다", () => {
    for (const bad of [null, undefined, 3, "x", [], () => 1]) expect(extractSeed(bad)).toBeNull();
  });

  it("defaults를 켜면 없는 색을 Buzz처럼 기본색으로 채운다 (글자 기본색은 바탕에 맞춘다)", () => {
    const onDark = extractSeed({ colors: { "editor.background": "#262335" } }, { defaults: true });
    expect(onDark).toEqual({ bg: "#262335", fg: "#d4d4d4" });
    const onLight = extractSeed({ colors: { "editor.background": "#fafafa" } }, { defaults: true });
    expect(onLight).toEqual({ bg: "#fafafa", fg: "#333333" });
    expect(extractSeed({ colors: {} }, { defaults: true })).toEqual({ bg: "#1e1e1e", fg: "#d4d4d4" });
    // colors 자체가 없으면 기본색을 지어내지 않는다.
    expect(extractSeed({}, { defaults: true })).toBeNull();
  });

  it("씨앗의 열쇠 목록은 열둘이고 bg·fg가 앞이다", () => {
    expect(SEED_KEYS).toHaveLength(12);
    expect(SEED_KEYS.slice(0, 2)).toEqual(["bg", "fg"]);
  });
});

describe("comment 색 — Buzz 결함을 옮기지 않는다 (AC 7)", () => {
  const rule = (scope: unknown, foreground: string) => ({ scope, settings: { foreground } });

  it("tokenColors만 있는 합성 픽스처에서 comment를 읽는다", () => {
    const seed = extractSeed({ colors: BASE, tokenColors: [rule("comment", "#6a9955")] });
    expect(seed?.comment).toBe("#6a9955");
    // 글자색과 다르다: Buzz의 settings-only 읽기는 여기서 fg로 폴백한다.
    expect(seed?.comment).not.toBe(seed?.fg);
  });

  it("그 씨앗에서 파생한 ink-muted는 글자(ink)가 아니다 — comment가 muted 글자의 출발점이다", () => {
    const seed = extractSeed({ colors: BASE, tokenColors: [rule("comment", "#6a9955")] })!;
    const withComment = deriveThemeMode(seed).tokens.color;
    const withoutComment = deriveThemeMode({ bg: seed.bg, fg: seed.fg }).tokens.color;
    expect(withComment["ink-muted"]).not.toBe(withComment.ink);
    // comment 씨앗이 파생에 닿았다: comment가 없을 때(글자와 바탕 40% 혼합)와 다른 색에서 출발한다.
    expect(withComment["ink-muted"]).not.toBe(withoutComment["ink-muted"]);
  });

  it("settings(옛 TextMate 형식)도 읽는다. tokenColors가 있으면 그것이 이긴다", () => {
    expect(extractSeed({ colors: BASE, settings: [rule("comment", "#112233")] })?.comment).toBe("#112233");
    const both = extractSeed({
      colors: BASE,
      tokenColors: [rule("comment", "#aa0000")],
      settings: [rule("comment", "#00aa00")],
    });
    expect(both?.comment).toBe("#aa0000");
  });

  it("tokenColors가 문자열(.tmTheme 경로)이면 읽지 않고 settings로 간다", () => {
    expect(extractSeed({ colors: BASE, tokenColors: "./x.tmTheme", settings: [rule("comment", "#334455")] })?.comment).toBe(
      "#334455"
    );
    expect(extractSeed({ colors: BASE, tokenColors: "./x.tmTheme" })?.comment).toBeUndefined();
  });

  it("scope는 문자열·배열·쉼표 목록 모두에서 정확히 `comment`인 항목만 잡는다", () => {
    expect(extractSeed({ colors: BASE, tokenColors: [rule(["string", "comment"], "#010203")] })?.comment).toBe("#010203");
    expect(extractSeed({ colors: BASE, tokenColors: [rule("comment, punctuation.definition.comment", "#040506")] })?.comment).toBe(
      "#040506"
    );
    // 하위 scope(`comment.line`)나 이름이 비슷한 scope는 comment가 아니다(Buzz와 같다).
    expect(extractSeed({ colors: BASE, tokenColors: [rule("comment.line", "#070809")] })?.comment).toBeUndefined();
    expect(extractSeed({ colors: BASE, tokenColors: [rule("meta.comment", "#070809")] })?.comment).toBeUndefined();
  });

  it("전경이 없거나 형식이 틀린 규칙은 건너뛰고 다음 규칙을 본다", () => {
    const seed = extractSeed({
      colors: BASE,
      tokenColors: [{ scope: "comment", settings: {} }, rule("comment", "red"), rule("comment", "#0a0b0c")],
    });
    expect(seed?.comment).toBe("#0a0b0c");
  });
});

describe("git 장식·신호·에이전트 씨앗의 열쇠 순서", () => {
  it("git 장식색은 gitDecoration > editorGutter > diffEditor 순서다 (Buzz와 같다)", () => {
    const seed = extractSeed({
      colors: {
        ...BASE,
        "gitDecoration.addedResourceForeground": "#00aa00",
        "editorGutter.addedBackground": "#00bb00",
        "diffEditor.insertedTextBackground": "#00cc00",
        "editorGutter.deletedBackground": "#bb0000",
        "diffEditor.removedTextBackground": "#cc0000",
        "editorGutter.modifiedBackground": "#0000bb",
      },
    });
    expect(seed).toMatchObject({ added: "#00aa00", deleted: "#bb0000", modified: "#0000bb" });
  });

  it("git 장식색의 알파는 버린다", () => {
    const seed = extractSeed({ colors: { ...BASE, "diffEditor.insertedTextBackground": "#9bb95533" } });
    expect(seed?.added).toBe("#9bb955");
  });

  it("신호 씨앗: focusBorder > textLink > button > activityBarBadge (채도가 있을 때)", () => {
    const colors = {
      ...BASE,
      focusBorder: "#cc3300",
      "textLink.foreground": "#00aacc",
      "button.background": "#33cc00",
      "activityBarBadge.background": "#9900cc",
    };
    expect(extractSeed({ colors })?.accent).toBe("#cc3300");
    const { focusBorder: _focus, ...withoutFocus } = colors;
    expect(extractSeed({ colors: withoutFocus })?.accent).toBe("#00aacc");
  });

  it("무채색 신호 후보는 채도 있는 뒤 후보가 있으면 건너뛴다 (포커스 테두리가 흰색·회색인 테마가 57종 중 23종이다)", () => {
    const grayFirst = {
      ...BASE,
      focusBorder: "#ffffff",
      "textLink.foreground": "#808080",
      "button.background": "#ca9ee6",
      "activityBarBadge.background": "#ff0000",
    };
    expect(extractSeed({ colors: grayFirst })?.accent).toBe("#ca9ee6");
    expect(toOklch("#ca9ee6").C).toBeGreaterThanOrEqual(SEED_MIN_CHROMA);
  });

  it("후보가 전부 무채색이면 읽힌 것 가운데 첫 색을 쓴다", () => {
    const seed = extractSeed({ colors: { ...BASE, focusBorder: "#808080", "button.background": "#ffffff" } });
    expect(seed?.accent).toBe("#808080");
  });

  it("에이전트 씨앗: 청록 > 파랑, 같은 채도 규칙", () => {
    expect(extractSeed({ colors: { ...BASE, "terminal.ansiCyan": "#11aabb", "terminal.ansiBlue": "#1155dd" } })?.agent).toBe(
      "#11aabb"
    );
    expect(extractSeed({ colors: { ...BASE, "terminal.ansiCyan": "#cccccc", "terminal.ansiBlue": "#1155dd" } })?.agent).toBe(
      "#1155dd"
    );
    expect(extractSeed({ colors: { ...BASE, "terminal.ansiBlue": "#1155dd" } })?.agent).toBe("#1155dd");
  });

  it("사이드바·ANSI 빨강·초록·노랑을 담는다", () => {
    const seed = extractSeed({
      colors: {
        ...BASE,
        "sideBar.background": "#0a0a0a",
        "terminal.ansiRed": "#ee0000",
        "terminal.ansiGreen": "#00ee00",
        "terminal.ansiYellow": "#eeee00",
      },
    });
    expect(seed).toMatchObject({ sidebar: "#0a0a0a", ansiRed: "#ee0000", ansiGreen: "#00ee00", ansiYellow: "#eeee00" });
  });

  it("출력의 열쇠 순서는 SEED_KEYS 순서다 (생성물이 결정적이다)", () => {
    const seed = extractSeed({
      colors: { ...BASE, "terminal.ansiYellow": "#eeee00", focusBorder: "#cc3300" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#334455" } }],
    })!;
    const order = Object.keys(seed);
    expect(order).toEqual(SEED_KEYS.filter((key) => key in seed));
  });
});

describe("seedMode: 바탕 휘도로 가른다 (type 필드는 힌트일 뿐)", () => {
  it("어두운 바탕은 다크, 밝은 바탕은 라이트", () => {
    expect(seedMode({ bg: "#101820" })).toBe("dark");
    expect(seedMode({ bg: "#fafafa" })).toBe("light");
  });

  it("type이 거짓말해도 휘도가 이긴다", () => {
    const seed = extractSeed({ type: "dark", colors: { "editor.background": "#ffffff", "editor.foreground": "#222222" } })!;
    expect(seedMode(seed)).toBe("light");
  });
});

describe("허용 라이선스", () => {
  it("MIT·Apache-2.0·BSD·ISC만 허용한다", () => {
    expect([...CATALOG_ALLOWED_SPDX].sort()).toEqual(["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"]);
    for (const ok of CATALOG_ALLOWED_SPDX) expect(isAllowedSpdx(ok)).toBe(true);
    for (const bad of ["GPL-3.0", "AGPL-3.0", "LGPL-2.1", "MIT OR GPL-3.0", "mit", "", "Unlicense", null, undefined, 1]) {
      expect(isAllowedSpdx(bad), String(bad)).toBe(false);
    }
  });
});
