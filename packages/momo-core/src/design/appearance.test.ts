import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  MOBILE_APPEARANCE_ENTRY,
  MOBILE_LEGACY_SCHEME_ENTRY,
  ROOT_ATTRIBUTES,
  WEB_APPEARANCE_ENTRY,
  WEB_APPEARANCE_ENTRY_V1,
  WEB_LEGACY_SCHEME_ENTRY,
  migrateAppearanceV1,
  normalizeAppearance,
  normalizeBubble,
  normalizeGlass,
  normalizeWallpaper,
  parseAppearanceV2,
  parseWebAppearanceV2,
  readMobileAppearance,
  readWebAppearance,
  serializeAppearance,
  type AppearanceV2,
  type WebAppearance,
} from "./appearance";

// ADR-0189 D3 「ADR-0174 이행」 표를 한 줄씩 옮긴다.

const v1 = (record: unknown) => JSON.stringify(record);

describe("저장 키(ADR-0189 D3)", () => {
  it("웹 v2 · v1 · 옛 스킴 키, 폰 새 키 · 옛 키", () => {
    expect(WEB_APPEARANCE_ENTRY).toBe("momo.web.appearance.v2");
    expect(WEB_APPEARANCE_ENTRY_V1).toBe("momo.web.appearance.v1");
    expect(WEB_LEGACY_SCHEME_ENTRY).toBe("momo.web.theme.v1");
    expect(MOBILE_APPEARANCE_ENTRY).toBe("momo.mobile.appearance.v1");
    expect(MOBILE_LEGACY_SCHEME_ENTRY).toBe("momo.mobile.theme.v1");
  });

  it("웹 루트 속성 열(증보 3). data-theme은 스킴 전용이다", () => {
    expect(ROOT_ATTRIBUTES).toEqual({
      scheme: "data-theme",
      palette: "data-palette",
      themeRef: "data-theme-ref",
      signal: "data-signal",
      density: "data-density",
      fontSize: "data-font-size",
      glass: "data-glass",
      prominentActive: "data-prominent-active",
      threadLayout: "data-thread-layout",
      wallpaper: "data-wallpaper",
    });
  });
});

describe("v1 → v2 (ADR-0189 D3 표)", () => {
  it.each(["system", "light", "dark"] as const)("scheme %s 는 그대로", (scheme) => {
    expect(migrateAppearanceV1(v1({ scheme, accent: "dawn" }))?.scheme).toBe(scheme);
  });

  it.each([
    ["dawn", { scheme: "dark", accent: "dawn" }],
    ["없음", { scheme: "dark" }],
    ["모르는 값", { scheme: "dark", accent: "neon" }],
    ["문자열 아님", { scheme: "dark", accent: 3 }],
  ])("accent %s → dawnsky + 테마 기본 신호", (_n, record) => {
    expect(migrateAppearanceV1(v1(record))).toEqual({
      v: 2,
      scheme: "dark",
      theme: "dawnsky",
      signal: null,
      density: "comfortable",
    });
  });

  it.each(["seongun", "hongyeom", "hyeseong", "gamram"] as const)("accent %s → 같은 id의 프리셋", (accent) => {
    expect(migrateAppearanceV1(v1({ scheme: "light", accent }))).toEqual({
      v: 2,
      scheme: "light",
      theme: "dawnsky",
      signal: { preset: accent },
      density: "comfortable",
    });
  });

  it("모르는 scheme은 system", () => {
    expect(migrateAppearanceV1(v1({ scheme: "sepia", accent: "gamram" }))?.scheme).toBe("system");
  });

  it.each([
    ["comfy", "comfortable"],
    // 증보 1 D1: spacious는 이제 유효한 값이라 comfortable로 접지 않는다(AP-2a #4189).
    ["spacious", "spacious"],
    ["compact", "compact"],
    ["dense", "comfortable"],
  ])("옛 밀도 이름 %s → %s (D4 방어적 읽기)", (density, expected) => {
    expect(migrateAppearanceV1(v1({ scheme: "light", density }))?.density).toBe(expected);
  });

  it("JSON이 아니면 v1이 없는 것으로 본다", () => {
    expect(migrateAppearanceV1("{not json")).toBeNull();
    expect(migrateAppearanceV1("[1,2]")).toBeNull();
    expect(migrateAppearanceV1("")).toBeNull();
    expect(migrateAppearanceV1(null)).toBeNull();
  });
});

describe("웹 읽기 순서: v2 → v1 → 옛 스킴 키", () => {
  const stored: AppearanceV2 = {
    v: 2,
    scheme: "dark",
    theme: "noeul",
    signal: { custom: "#9C447C" },
    density: "compact",
  };

  it("v2가 있으면 v1·옛 키를 보지 않는다", () => {
    expect(
      readWebAppearance({
        v2: serializeAppearance(stored),
        v1: v1({ scheme: "light", accent: "gamram" }),
        legacyScheme: "light",
      })
    ).toEqual(stored);
  });

  it("v2가 없으면 v1을 옮긴다", () => {
    expect(readWebAppearance({ v1: v1({ scheme: "light", accent: "gamram" }), legacyScheme: "dark" })).toEqual({
      ...DEFAULT_APPEARANCE,
      scheme: "light",
      signal: { preset: "gamram" },
    });
  });

  it("v2가 v2가 아니면(버전 없음·깨짐) 다음 키로 넘어간다", () => {
    expect(readWebAppearance({ v2: v1({ scheme: "dark" }), v1: v1({ scheme: "light" }) }).scheme).toBe("light");
    expect(readWebAppearance({ v2: "{", legacyScheme: "dark" }).scheme).toBe("dark");
  });

  it("옛 스킴 키만 있으면 스킴만 옮긴다", () => {
    expect(readWebAppearance({ legacyScheme: "light" })).toEqual({ ...DEFAULT_APPEARANCE, scheme: "light" });
    expect(readWebAppearance({ legacyScheme: "garbage" })).toEqual(DEFAULT_APPEARANCE);
  });

  it("아무것도 없으면 기본값: 시스템 · 새벽하늘 · 테마 기본 신호 · comfortable", () => {
    expect(readWebAppearance({})).toEqual({
      v: 2,
      scheme: "system",
      theme: "dawnsky",
      signal: null,
      density: "comfortable",
    });
  });
});

describe("폰 읽기 순서: momo.mobile.appearance.v1 → momo.mobile.theme.v1", () => {
  it.each(["system", "light", "dark"] as const)("옛 키 %s 는 스킴만 옮긴다", (scheme) => {
    expect(readMobileAppearance({ legacyScheme: scheme })).toEqual({ ...DEFAULT_APPEARANCE, scheme });
  });

  it("새 키가 있으면 옛 키를 보지 않는다", () => {
    const current = serializeAppearance({ ...DEFAULT_APPEARANCE, theme: "graphite", scheme: "light" });
    expect(readMobileAppearance({ current, legacyScheme: "dark" })).toMatchObject({ theme: "graphite", scheme: "light" });
  });
});

describe("v2 레코드 정규화", () => {
  it("커스텀 hex는 대문자 #RRGGBB, 틀린 hex는 테마 기본 신호", () => {
    const parse = (signal: unknown) => parseAppearanceV2(JSON.stringify({ v: 2, signal }))?.signal;
    expect(parse({ custom: "#9c447c" })).toEqual({ custom: "#9C447C" });
    expect(parse({ custom: "#fff" })).toBeNull();
    expect(parse({ custom: "red" })).toBeNull();
    expect(parse({ preset: "dawn" })).toBeNull();
    expect(parse({ preset: "seongun" })).toEqual({ preset: "seongun" });
    expect(parse("seongun")).toBeNull();
  });

  it("모르는 테마 id는 기본 테마", () => {
    expect(parseAppearanceV2(JSON.stringify({ v: 2, theme: "neon" }))?.theme).toBe("dawnsky");
  });

  it("직렬화 → 읽기가 제자리로 돌아온다", () => {
    const state: AppearanceV2 = { v: 2, scheme: "light", theme: "graphite", signal: { preset: "hyeseong" }, density: "compact" };
    expect(parseAppearanceV2(serializeAppearance(state))).toEqual(state);
  });
});

// ---- AP-1a(#4186): 글꼴 보존·선택 필드·웹 테마 참조 --------------------------------

const keysOf = (json: string) => Object.keys(JSON.parse(json) as Record<string, unknown>);

describe("AC 1: v1 {scheme, accent, fontSans, fontMono} → v2 동치 (글꼴 보존)", () => {
  const v1Full = v1({ scheme: "dark", accent: "seongun", fontSans: "Pretendard", fontMono: "D2Coding" });
  const expected: WebAppearance = {
    v: 2,
    scheme: "dark",
    theme: "dawnsky",
    signal: { preset: "seongun" },
    density: "comfortable",
    fontSans: "Pretendard",
    fontMono: "D2Coding",
  };

  it("네 필드가 모두 v2로 옮겨 간다 — 글꼴이 사라지지 않는다", () => {
    expect(migrateAppearanceV1(v1Full)).toEqual(expected);
    expect(readWebAppearance({ v1: v1Full })).toEqual(expected);
  });

  it("글꼴이 없는 v1은 글꼴 키 없이 옮겨 간다(기존 다섯 키 그대로)", () => {
    const moved = migrateAppearanceV1(v1({ scheme: "light", accent: "dawn" }));
    expect(moved).toEqual({ v: 2, scheme: "light", theme: "dawnsky", signal: null, density: "comfortable" });
    expect(moved).not.toHaveProperty("fontSans");
    expect(moved).not.toHaveProperty("fontMono");
  });

  it("허용 목록을 통과하지 못한 글꼴만 버리고 나머지는 지킨다", () => {
    const moved = migrateAppearanceV1(v1({ scheme: "dark", accent: "dawn", fontSans: 'x"; y', fontMono: "D2Coding" }));
    expect(moved).toEqual({ v: 2, scheme: "dark", theme: "dawnsky", signal: null, density: "comfortable", fontMono: "D2Coding" });
    expect(moved).not.toHaveProperty("fontSans");
  });

  it("v2가 있으면 v1의 글꼴이 아니라 v2의 글꼴을 쓴다", () => {
    const v2 = serializeAppearance({ ...expected, fontSans: "Menlo" });
    expect(readWebAppearance({ v2, v1: v1Full }).fontSans).toBe("Menlo");
  });

  it("v1을 읽는 것만으로는 v2와 같은 문자열이 돌아온다: 쓰기 → 읽기 왕복에서 글꼴이 그대로다", () => {
    const moved = readWebAppearance({ v1: v1Full });
    expect(readWebAppearance({ v2: serializeAppearance(moved) })).toEqual(moved);
  });
});

describe("선택 필드는 기본값이면 직렬화에서 빠진다 (폰의 저장 형태는 다섯 키 그대로)", () => {
  it("기본 레코드는 정확히 다섯 키", () => {
    expect(keysOf(serializeAppearance(DEFAULT_APPEARANCE))).toEqual(["v", "scheme", "theme", "signal", "density"]);
  });

  it("기본값을 명시해도 키가 생기지 않는다", () => {
    const explicit: WebAppearance = {
      ...DEFAULT_APPEARANCE,
      fontSize: "default",
      threadLayout: "split",
      prominentActive: false,
    };
    expect(keysOf(serializeAppearance(explicit))).toEqual(["v", "scheme", "theme", "signal", "density"]);
    expect(normalizeAppearance(explicit)).toEqual(DEFAULT_APPEARANCE);
  });

  it("기본이 아니면 고정된 순서로 실린다", () => {
    const set: WebAppearance = {
      ...DEFAULT_APPEARANCE,
      fontSize: "larger",
      threadLayout: "focus",
      prominentActive: true,
      glass: { on: true, opacity: 80 },
      wallpaper: { kind: "preset", id: "bam" },
      fontSans: "Pretendard",
      fontMono: "D2Coding",
    };
    expect(keysOf(serializeAppearance(set))).toEqual([
      "v", "scheme", "theme", "signal", "density",
      "fontSize", "threadLayout", "prominentActive", "glass", "wallpaper", "fontSans", "fontMono",
    ]);
    expect(parseWebAppearanceV2(serializeAppearance(set))).toEqual(set);
  });

  it("정규화는 멱등이다", () => {
    const messy = {
      ...DEFAULT_APPEARANCE,
      fontSize: "huge",
      threadLayout: "grid",
      glass: { on: "yes" },
      wallpaper: { kind: "video" },
      fontSans: "   ",
    } as unknown as WebAppearance;
    const once = normalizeAppearance(messy);
    expect(once).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance(once)).toEqual(once);
  });
});

describe("선택 필드 읽기 규칙", () => {
  const read = (extra: Record<string, unknown>) =>
    parseWebAppearanceV2(JSON.stringify({ v: 2, scheme: "system", theme: "dawnsky", signal: null, density: "comfortable", ...extra }));

  it("글자 크기·스레드 배치: 목록 밖은 기본", () => {
    expect(read({ fontSize: "smaller" })?.fontSize).toBe("smaller");
    expect(read({ fontSize: "larger" })?.fontSize).toBe("larger");
    expect(read({ fontSize: "small" })).not.toHaveProperty("fontSize");
    expect(read({ threadLayout: "focus" })?.threadLayout).toBe("focus");
    expect(read({ threadLayout: "overlay" })).not.toHaveProperty("threadLayout");
  });

  it("선택한 항목 강조는 true일 때만", () => {
    expect(read({ prominentActive: true })?.prominentActive).toBe(true);
    expect(read({ prominentActive: "true" })).not.toHaveProperty("prominentActive");
    expect(read({ prominentActive: 1 })).not.toHaveProperty("prominentActive");
  });

  it("유리: 꺼짐+불투명도 없음은 두지 않고, 불투명도는 0~100 정수로 맞춘다", () => {
    expect(normalizeGlass(undefined)).toBeUndefined();
    expect(normalizeGlass({ on: false })).toBeUndefined();
    expect(normalizeGlass({ on: true })).toEqual({ on: true });
    expect(normalizeGlass({ on: false, opacity: 70.4 })).toEqual({ on: false, opacity: 70 });
    expect(normalizeGlass({ on: true, opacity: 250 })).toEqual({ on: true, opacity: 100 });
    expect(normalizeGlass({ on: true, opacity: -5 })).toEqual({ on: true, opacity: 0 });
    expect(normalizeGlass({ on: true, opacity: Number.NaN })).toEqual({ on: true });
    expect(normalizeGlass([true])).toBeUndefined();
  });

  it("배경화면 참조: 종류·id 문법이 틀리면 없음, 덤 필드만 틀리면 종류는 지킨다", () => {
    expect(normalizeWallpaper({ kind: "preset", id: "bam" })).toEqual({ kind: "preset", id: "bam" });
    expect(normalizeWallpaper({ kind: "solid", id: "slate" })).toEqual({ kind: "solid", id: "slate" });
    expect(normalizeWallpaper({ kind: "solid" })).toBeUndefined();
    expect(normalizeWallpaper({ kind: "preset", id: "../etc" })).toBeUndefined();
    expect(normalizeWallpaper({ kind: "preset", id: "A" })).toBeUndefined();
    expect(normalizeWallpaper({ kind: "none" })).toBeUndefined();
    expect(normalizeWallpaper({ kind: "image", width: 1600, height: 900, rev: 3 })).toEqual({
      kind: "image",
      width: 1600,
      height: 900,
      rev: 3,
    });
    expect(normalizeWallpaper({ kind: "image", width: -1, height: "x", rev: 1.5 })).toEqual({ kind: "image" });
    expect(normalizeWallpaper("preset")).toBeUndefined();
  });

  it("레코드 안의 배경 참조는 `__proto__`·알 수 없는 키를 싣지 않는다", () => {
    const parsed = read({ wallpaper: JSON.parse('{"kind":"preset","id":"bam","__proto__":{"x":1},"url":"https://a.test/x"}') });
    expect(parsed?.wallpaper).toEqual({ kind: "preset", id: "bam" });
  });
});

describe("웹 테마 참조 (themeResolve 문법)", () => {
  const rec = (theme: unknown) => JSON.stringify({ v: 2, scheme: "dark", theme, signal: null, density: "comfortable" });

  it("웹은 catalog:·user: 참조를 그대로 읽는다", () => {
    expect(parseWebAppearanceV2(rec("catalog:nord"))?.theme).toBe("catalog:nord");
    expect(parseWebAppearanceV2(rec("user:my-theme-2"))?.theme).toBe("user:my-theme-2");
    expect(parseWebAppearanceV2(rec("graphite"))?.theme).toBe("graphite");
  });

  it("문법이 틀린 참조는 새벽하늘이다", () => {
    for (const bad of ["catalog:", "catalog:Nord", "catalog:a b", "theme:nord", "nord", "user:-x", "", 3, null, ["catalog:nord"]]) {
      expect(parseWebAppearanceV2(rec(bad))?.theme, JSON.stringify(bad)).toBe("dawnsky");
    }
  });

  it("첫 파티 전용 호환 파서는 참조를 새벽하늘로 읽는다", () => {
    expect(parseAppearanceV2(rec("catalog:nord"))?.theme).toBe("dawnsky");
    expect(parseAppearanceV2(rec("noeul"))?.theme).toBe("noeul");
  });

  it("웹 레코드는 참조를 직렬화 → 읽기 왕복으로 지킨다", () => {
    const state: WebAppearance = { ...DEFAULT_APPEARANCE, theme: "catalog:gruvbox-hard", scheme: "dark" };
    expect(parseWebAppearanceV2(serializeAppearance(state))).toEqual(state);
  });
});

// 폰이 저장하는 다섯 키는 AP-1a 전과 한 글자도 다르지 않다(themeSwitch.test.tsx가 같은 단정을 폰에서 한다).
describe("폰 저장 형태 불변", () => {
  it("선택 필드가 새로 생겨도 폰 레코드의 직렬화는 그대로다", () => {
    const state: AppearanceV2 = { v: 2, scheme: "light", theme: "graphite", signal: { preset: "hyeseong" }, density: "compact" };
    expect(serializeAppearance(state)).toBe(
      '{"v":2,"scheme":"light","theme":"graphite","signal":{"preset":"hyeseong"},"density":"compact"}'
    );
  });
});

// #4383 — 말풍선 개인 덮어쓰기(`bubble`). 폰 `bubbleFor` 가 읽고 #4307 설정층이 쓴다.
describe("bubble: 말풍선 덮어쓰기 필드(#4383)", () => {
  const base: AppearanceV2 = { ...DEFAULT_APPEARANCE };

  it("기본(없음·빈 객체·알 수 없는 값)이면 레코드에 키가 없다 — 기존 저장 문자열이 한 글자도 안 바뀐다", () => {
    const before = serializeAppearance(base);
    expect(before).not.toContain("bubble");
    for (const empty of [undefined, {}, { layout: "bubble" }, { layout: "row2" }, { mine: {} }, { radius: 29 }, 5, "row", []]) {
      expect(serializeAppearance({ ...base, bubble: empty as never })).toBe(before);
    }
  });

  it("줄 보기·색·모서리가 저장되고 다시 읽으면 제자리다", () => {
    const state: AppearanceV2 = {
      ...base,
      bubble: { layout: "row", radius: 4, mine: { bg: "#7b3fe4", fg: "#ffffff" }, other: { bg: "#EEEEEE" } },
    };
    const raw = serializeAppearance(state);
    const read = parseAppearanceV2(raw);
    expect(read?.bubble).toEqual({
      layout: "row",
      radius: 4,
      mine: { bg: "#7B3FE4", fg: "#FFFFFF" },
      other: { bg: "#EEEEEE" },
    });
    expect(serializeAppearance(read as AppearanceV2)).toBe(raw);
  });

  it("틀린 필드만 버리고 나머지는 지킨다 (hex 형식·반경 범위·정수)", () => {
    expect(normalizeBubble({ layout: "row", radius: 28.5, mine: { bg: "red", fg: "#000000" } })).toEqual({
      layout: "row",
      mine: { fg: "#000000" },
    });
    expect(normalizeBubble({ radius: 28 })).toEqual({ radius: 28 });
    expect(normalizeBubble({ radius: 0 })).toEqual({ radius: 0 });
    expect(normalizeBubble({ radius: -1 })).toBeUndefined();
    expect(normalizeBubble({ layout: "bubble" })).toBeUndefined();
  });

  it("손으로 넣은 저장 문자열의 쓰레기 값도 화면을 잠그지 않는다", () => {
    const raw = JSON.stringify({ v: 2, scheme: "dark", theme: "dawnsky", signal: null, density: "comfortable", bubble: "row" });
    expect(parseAppearanceV2(raw)?.bubble).toBeUndefined();
  });
});


it("AP-6 폰은 카탈로그를 재실행해도 보존하고 미지원 사용자·모르는 항목은 기본으로 읽는다", () => {
  const rec = (theme: string) => JSON.stringify({ v: 2, theme, scheme: "dark" });
  expect(readMobileAppearance({ current: rec("catalog:nord") }).theme).toBe("catalog:nord");
  for (const ref of ["catalog:missing", "user:custom", "catalog:Nord"]) {
    expect(readMobileAppearance({ current: rec(ref) }).theme).toBe("dawnsky");
  }
  const state = readMobileAppearance({ current: rec("catalog:github") });
  expect(readMobileAppearance({ current: serializeAppearance(state) })).toEqual(state);
});
