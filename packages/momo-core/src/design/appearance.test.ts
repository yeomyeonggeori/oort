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
  parseAppearanceV2,
  readMobileAppearance,
  readWebAppearance,
  serializeAppearance,
  type AppearanceV2,
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

  it("웹 루트 속성 넷. data-theme은 스킴 전용이다", () => {
    expect(ROOT_ATTRIBUTES).toEqual({
      scheme: "data-theme",
      palette: "data-palette",
      signal: "data-signal",
      density: "data-density",
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
    ["spacious", "comfortable"],
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
