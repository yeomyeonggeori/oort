import { describe, expect, it } from "vitest";
import {
  CATALOG_IDS,
  DERIVED_PALETTE,
  catalogModesLookup,
  effectiveScheme,
  isCatalogId,
  isThemeRef,
  modesOf,
  moveNotice,
  normalizeThemeRef,
  paletteOf,
  splitThemeRef,
  themeMoveForScheme,
  THEME_REF_ID_MAX,
  type ModesLookup,
  type ThemeRef,
} from "./themeResolve";
import { THEME_CATALOG_INDEX } from "./themeCatalogIndex.generated";
import { DEFAULT_THEME_ID, MODES, THEME_IDS, THEME_ID_RE } from "./themes";

// AP-1a(#4186) 골격: 첫 파티 3종의 모드와 단일 모드 규칙을 **가짜 단일 모드 참조**로 잰다.
// AP-1b(#4188): 같은 규칙을 진짜 카탈로그 색인 위에서 다시 잰다(아래 「카탈로그 색인」 이하).

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

// =============================================================================
// AP-1b #4188: 카탈로그 색인 위의 판정과 단일 모드 규칙 셋 (청사진 §5.2-a, 테마 토큰 표 §8.6).
// =============================================================================

/** 색인 한 줄을 `[id, 모드 글자]` 목록으로 푼다(l 라이트 단독 · d 다크 단독 · b 쌍). */
const INDEX_ROWS: readonly (readonly [string, string])[] = THEME_CATALOG_INDEX.split(" ").map((item) => [
  item.slice(0, -2),
  item.slice(-1),
]);

describe("카탈로그 색인", () => {
  it("항목 41개, id 순이고 겹치지 않는다. 쌍 16 · 라이트 단독 1 · 다크 단독 24", () => {
    expect(CATALOG_IDS).toHaveLength(41);
    expect([...CATALOG_IDS]).toEqual([...CATALOG_IDS].sort());
    expect(new Set(CATALOG_IDS).size).toBe(41);
    const count = (modes: string) => INDEX_ROWS.filter(([, m]) => m === modes).length;
    expect([count("b"), count("l"), count("d")]).toEqual([16, 1, 24]);
    expect(THEME_CATALOG_INDEX).not.toMatch(/\s{2,}|^\s|\s$/);
  });

  it("색인의 모든 id는 `catalog:` 문법을 지킨다 (첫 파티 핀 `[a-z]`를 지나지 않는다)", () => {
    for (const id of CATALOG_IDS) {
      expect(isThemeRef(`catalog:${id}`), id).toBe(true);
      expect(isCatalogId(id)).toBe(true);
    }
    expect(CATALOG_IDS.some((id) => id.includes("-") || /[0-9]/.test(id))).toBe(true);
    expect(isCatalogId("aurora-x")).toBe(false);
    expect(isCatalogId("dawnsky")).toBe(false);
  });

  it("갤러리 타일 수: 시스템 19 · 라이트 20 · 다크 43 (첫 파티 3종 포함)", () => {
    const tiles = (mode: "system" | "light" | "dark") =>
      THEME_IDS.length +
      INDEX_ROWS.filter(([, modes]) =>
        mode === "system" ? modes === "b" : modes === "b" || modes === mode[0]
      ).length;
    expect([tiles("system"), tiles("light"), tiles("dark")]).toEqual([19, 20, 43]);
  });

  it("normalizeThemeRef: 카탈로그에 없는 catalog: id는 새벽하늘이고 user: 참조는 문법만 본다", () => {
    expect(normalizeThemeRef("catalog:nord")).toBe("catalog:nord");
    expect(normalizeThemeRef("catalog:github-default")).toBe("catalog:github-default");
    for (const unknown of ["catalog:aurora-x", "catalog:slack", "catalog:solo-dark", "catalog:nord-x"]) {
      expect(normalizeThemeRef(unknown), unknown).toBe("dawnsky");
    }
    expect(normalizeThemeRef("user:mine")).toBe("user:mine");
    expect(normalizeThemeRef("user:Mine")).toBe("dawnsky");
  });

  it("modesOf의 기본 조회는 카탈로그 색인이다 (다크 단독 24 · 라이트 단독 1 · 쌍 16)", () => {
    expect(modesOf("catalog:nord")).toEqual(["dark"]);
    expect(modesOf("catalog:snazzy-light")).toEqual(["light"]);
    expect(modesOf("catalog:github")).toEqual(["light", "dark"]);
    for (const [id, modes] of INDEX_ROWS) {
      expect(modesOf(`catalog:${id}`)).toEqual(modes === "b" ? ["light", "dark"] : modes === "l" ? ["light"] : ["dark"]);
    }
    // 색인이 모르는 참조와 사용자 참조는 둘 다다(깨진 데이터가 한 모드에 가두지 않는다).
    expect(modesOf("catalog:unknown-theme")).toEqual(["light", "dark"]);
    expect(modesOf("user:mine")).toEqual(["light", "dark"]);
    expect(catalogModesLookup("user:mine")).toBeUndefined();
    // 조회를 직접 주면 그것이 이긴다(시험이 가짜 참조를 쓰는 길).
    expect(modesOf("catalog:nord", () => null)).toEqual(["light", "dark"]);
  });

  it("단일 모드 테마의 유효 스킴은 그 모드다 (실제 카탈로그 위에서)", () => {
    expect(effectiveScheme("system", modesOf("catalog:nord"))).toBe("dark");
    expect(effectiveScheme("light", modesOf("catalog:nord"))).toBe("dark");
    expect(effectiveScheme("system", modesOf("catalog:snazzy-light"))).toBe("light");
    expect(effectiveScheme("system", modesOf("catalog:github"))).toBeNull();
  });
});

describe("단일 모드 규칙 2: 시스템으로 바꿀 때 짝이 없으면 첫 짝 테마(새벽하늘)로 옮긴다", () => {
  it("다크 단독·라이트 단독에서 시스템으로 바꾸면 새벽하늘로 옮긴다", () => {
    expect(themeMoveForScheme("catalog:nord", "system")).toEqual({
      from: "catalog:nord",
      to: DEFAULT_THEME_ID,
      why: "needs-pair",
      mode: null,
    });
    expect(themeMoveForScheme("catalog:snazzy-light", "system")?.to).toBe("dawnsky");
  });

  it("짝이 있는 테마와 첫 파티는 그대로다", () => {
    expect(themeMoveForScheme("catalog:github", "system")).toBeNull();
    for (const id of THEME_IDS) expect(themeMoveForScheme(id, "system")).toBeNull();
  });

  it("문구: 이 테마는 한쪽 모드만 있어서 {새벽하늘}로 바꿨어요 (떠나는 테마의 이름은 지연 청크의 라벨이라 메인 번들이 모른다)", () => {
    expect(moveNotice(themeMoveForScheme("catalog:nord", "system")!)).toBe(
      "이 테마는 한쪽 모드만 있어서 새벽하늘로 바꿨어요."
    );
  });
});

describe("단일 모드 규칙 3: 라이트·다크로 바꿀 때 그 모드가 없으면 그 모드의 첫 테마로 간다", () => {
  it("다크 단독에서 라이트로 바꾸면 라이트를 가진 첫 테마(새벽하늘)로 옮긴다", () => {
    expect(themeMoveForScheme("catalog:nord", "light")).toEqual({
      from: "catalog:nord",
      to: "dawnsky",
      why: "needs-mode",
      mode: "light",
    });
  });

  it("라이트 단독에서 다크로 바꾸면 다크를 가진 첫 테마로 옮긴다", () => {
    expect(themeMoveForScheme("catalog:snazzy-light", "dark")).toEqual({
      from: "catalog:snazzy-light",
      to: "dawnsky",
      why: "needs-mode",
      mode: "dark",
    });
  });

  it("이미 그 모드를 가진 테마는 옮기지 않는다 (단일 모드가 자기 모드로 바꾸는 경우 포함)", () => {
    expect(themeMoveForScheme("catalog:nord", "dark")).toBeNull();
    expect(themeMoveForScheme("catalog:snazzy-light", "light")).toBeNull();
    expect(themeMoveForScheme("catalog:github", "light")).toBeNull();
    expect(themeMoveForScheme("catalog:github", "dark")).toBeNull();
  });

  it("카탈로그 41항목 전부에서 규칙 2·3의 결과가 모드 수와 맞는다", () => {
    for (const [id, modes] of INDEX_ROWS) {
      const ref = `catalog:${id}` as const;
      expect([id, themeMoveForScheme(ref, "system") !== null]).toEqual([id, modes !== "b"]);
      expect([id, themeMoveForScheme(ref, "light") !== null]).toEqual([id, modes === "d"]);
      expect([id, themeMoveForScheme(ref, "dark") !== null]).toEqual([id, modes === "l"]);
    }
  });

  it("문구: 이 테마에는 {라이트/다크}가 없어서 {새벽하늘}로 바꿨어요", () => {
    expect(moveNotice(themeMoveForScheme("catalog:nord", "light")!)).toBe("이 테마에는 라이트가 없어서 새벽하늘로 바꿨어요.");
    expect(moveNotice(themeMoveForScheme("catalog:snazzy-light", "dark")!)).toBe(
      "이 테마에는 다크가 없어서 새벽하늘로 바꿨어요."
    );
  });

  it("옮긴 뒤의 테마는 그 모드를 실제로 가진다", () => {
    const move = themeMoveForScheme("catalog:nord", "light")!;
    expect(modesOf(move.to)).toContain("light");
  });
});
