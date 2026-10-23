import { describe, expect, it } from "vitest";
import {
  catalogEntries,
  catalogEntry,
  catalogPresetOutcomes,
  deriveCatalogMode,
  deriveCatalogVars,
} from "./deriveCatalog";
import { DERIVED_VAR_NAMES } from "./derive";
import { THEME_CATALOG } from "./themeCatalog.generated";
import { parseThemeCache } from "./themeCache";
import { CATALOG_IDS, modesOf } from "./themeResolve";

// 카탈로그 위의 조회 (AP-1b #4188). 파생 자체의 규칙은 derive.test.ts가 재고, 여기서는 id로 찾는 길·기억·
// 모드 판정이 색인(메인 번들이 읽는 쪽)과 어긋나지 않는지를 잰다.

describe("조회", () => {
  it("항목을 id로 찾고 없으면 undefined", () => {
    expect(catalogEntry("nord")?.label).toBe("Nord");
    expect(catalogEntry("aurora-x")).toBeUndefined();
    expect(catalogEntries()).toBe(THEME_CATALOG);
  });

  it("전체 카탈로그의 id 순서는 색인과 같다", () => {
    expect(catalogEntries().map((e) => e.id)).toEqual([...CATALOG_IDS]);
  });
});

describe("deriveCatalogMode", () => {
  it("없는 항목·없는 모드는 null이다", () => {
    expect(deriveCatalogMode("nope", "dark")).toBeNull();
    expect(deriveCatalogMode("nord", "light")).toBeNull();
    expect(deriveCatalogMode("snazzy-light", "dark")).toBeNull();
  });

  it("같은 입력은 같은 객체를 돌려준다 (기억)", () => {
    const a = deriveCatalogMode("github", "light", null);
    expect(a).not.toBeNull();
    expect(deriveCatalogMode("github", "light", null)).toBe(a);
    expect(deriveCatalogMode("github", "light", { preset: "gamram" })).not.toBe(a);
    expect(deriveCatalogMode("github", "light", { preset: "gamram" })).toBe(
      deriveCatalogMode("github", "light", { preset: "gamram" })
    );
  });

  it("신호가 다르면 신호 칸이 달라진다", () => {
    const base = deriveCatalogMode("github", "dark", null)!;
    const chosen = deriveCatalogMode("github", "dark", { preset: "gamram" })!;
    expect(chosen.tokens.color.signal).not.toBe(base.tokens.color.signal);
    expect(chosen.tokens.color.ink).toBe(base.tokens.color.ink);
  });
});

describe("catalogPresetOutcomes", () => {
  it("항목·모드마다 네 프리셋의 결과를 돌려주고 기억한다", () => {
    const a = catalogPresetOutcomes("catppuccin-frappe", "dark")!;
    expect(Object.keys(a).sort()).toEqual(["gamram", "hongyeom", "hyeseong", "seongun"]);
    expect(catalogPresetOutcomes("catppuccin-frappe", "dark")).toBe(a);
    expect(a.hongyeom.ok).toBe(false);
    expect(catalogPresetOutcomes("nord", "light")).toBeNull();
  });
});

describe("deriveCatalogVars", () => {
  it("모든 항목에서 값이 서고, 모드가 하나뿐인 항목은 pinned가 그 모드이고 색 하나다", () => {
    for (const entry of THEME_CATALOG) {
      const out = deriveCatalogVars(entry.id)!;
      expect(out, entry.id).not.toBeNull();
      expect(Object.keys(out.vars).sort()).toEqual([...DERIVED_VAR_NAMES].sort());
      const modes = modesOf(`catalog:${entry.id}`);
      expect([entry.id, out.pinned]).toEqual([entry.id, modes.length === 1 ? modes[0] : null]);
      expect(Object.keys(out.canvas).sort()).toEqual([...modes].sort());
      const anyLightDark = Object.values(out.vars).some((v) => v.startsWith("light-dark("));
      expect([entry.id, anyLightDark]).toEqual([entry.id, modes.length === 2]);
    }
  });

  it("값은 부트 캐시 문법을 지킨다 (캐시에 그대로 쓸 수 있다)", () => {
    for (const entry of THEME_CATALOG) {
      const out = deriveCatalogVars(entry.id, { preset: "hyeseong" })!;
      expect(parseThemeCache(JSON.stringify({ key: `1|catalog:${entry.id}|hyeseong`, vars: out.vars }))).not.toBeNull();
    }
  });

  it("바닥색은 모드별 canvas다", () => {
    const github = deriveCatalogVars("github")!;
    expect(github.canvas.light).toBe(deriveCatalogMode("github", "light")!.tokens.canvas[1]);
    expect(github.canvas.dark).toBe(deriveCatalogMode("github", "dark")!.tokens.canvas[1]);
    expect(Object.keys(deriveCatalogVars("nord")!.canvas)).toEqual(["dark"]);
  });

  it("없는 항목은 null", () => {
    expect(deriveCatalogVars("nope")).toBeNull();
  });
});
