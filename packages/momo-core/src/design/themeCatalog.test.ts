import { describe, expect, it } from "vitest";
import { toOklch } from "./color";
import { THEME_CATALOG, THEME_CATALOG_UPSTREAM } from "./themeCatalog.generated";
import { THEME_CATALOG_INDEX } from "./themeCatalogIndex.generated";
import { CATALOG_ALLOWED_SPDX, CATALOG_ID_RE, SEED_KEYS, isAllowedSpdx, seedMode } from "./themeSeed";

// =============================================================================
// 카탈로그 생성물의 모양과 라이선스 (AP-1b #4188, ADR-0189 증보 3 D1). 생성기 규칙(허용 목록·금지 이름)은 웹
// `catalogGenerator.test.ts`가 가짜 입력으로 재고, 이 파일은 **커밋된 생성물**이 그 규칙을 지켰는지 잰다.
// `legal/` 파일과의 대조(고지 25곳·`source.repo`)는 파일을 읽어야 해서 웹 `catalogLegal.test.ts`가 한다.
// =============================================================================

const FORBIDDEN = ["aurora-x", "slack-dark", "slack-ochin", "buzz", "buzz-dark"];

const slots = THEME_CATALOG.flatMap((entry) =>
  (["light", "dark"] as const).flatMap((mode) => (entry[mode] ? [{ entry, mode, seed: entry[mode]! }] : []))
);

describe("구성: 57 테마-모드 · 41항목", () => {
  it("항목 41개, 쌍 16 · 라이트 단독 1 · 다크 단독 24, 테마-모드 57", () => {
    expect(THEME_CATALOG).toHaveLength(41);
    const pairs = THEME_CATALOG.filter((e) => e.light && e.dark);
    const lightOnly = THEME_CATALOG.filter((e) => e.light && !e.dark);
    const darkOnly = THEME_CATALOG.filter((e) => !e.light && e.dark);
    expect([pairs.length, lightOnly.length, darkOnly.length]).toEqual([16, 1, 24]);
    expect(slots).toHaveLength(57);
    expect(lightOnly[0].id).toBe("snazzy-light");
  });

  it("id는 카탈로그 문법이고 겹치지 않으며 id 순이다", () => {
    const ids = THEME_CATALOG.map((e) => e.id);
    for (const id of ids) expect(id, id).toMatch(CATALOG_ID_RE);
    expect(new Set(ids).size).toBe(41);
    expect(ids).toEqual([...ids].sort());
  });

  it("라벨은 명시 표다: 비어 있지 않고 짧고 대시가 없다 (모드 낱말을 자동으로 지우면 light-plus가 사라진다)", () => {
    for (const entry of THEME_CATALOG) {
      expect(entry.label.length, entry.id).toBeGreaterThan(0);
      expect(entry.label.length, entry.id).toBeLessThanOrEqual(24);
      expect(entry.label, entry.id).not.toMatch(/[—–]/);
    }
    expect(THEME_CATALOG.find((e) => e.id === "vscode-plus")?.label).toBe("VS Code Plus");
    expect(new Set(THEME_CATALOG.map((e) => e.label)).size).toBe(41);
  });

  it("색인(themeCatalogIndex)은 카탈로그의 id·모드 투영이다 (메인 번들이 읽는 쪽이 어긋나지 않는다)", () => {
    const rows = THEME_CATALOG_INDEX.split(" ");
    expect(rows).toHaveLength(THEME_CATALOG.length);
    THEME_CATALOG.forEach((entry, i) => {
      const expectedMode = entry.light && entry.dark ? "b" : entry.light ? "l" : "d";
      expect(rows[i]).toBe(`${entry.id}:${expectedMode}`);
    });
  });
});

describe("씨앗", () => {
  it.each(slots.map((s) => [`${s.entry.id} ${s.mode}`, s] as const))("%s: 열쇠·형식·모드", (_name, slot) => {
    const { seed, mode } = slot;
    for (const key of Object.keys(seed)) expect(SEED_KEYS as readonly string[]).toContain(key);
    for (const value of Object.values(seed)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    expect(Object.keys(seed).slice(0, 2)).toEqual(["bg", "fg"]);
    // 라이트 칸에는 밝은 바탕이, 다크 칸에는 어두운 바탕이 든다(바탕 휘도로 가른다, type 필드가 아니다).
    expect(seedMode(seed)).toBe(mode);
  });

  it("열쇠는 SEED_KEYS 순서다 (생성물이 결정적이다)", () => {
    for (const { seed } of slots) {
      const keys = Object.keys(seed);
      expect(keys).toEqual(SEED_KEYS.filter((k) => keys.includes(k)));
    }
  });

  it("comment 색은 57행 전부에 있다 (tokenColors를 읽는다 — Buzz의 settings-only 읽기였다면 대부분 비어 있다)", () => {
    expect(slots.filter((s) => s.seed.comment !== undefined)).toHaveLength(57);
  });

  it("신호 씨앗은 57행 전부에 있고 채도가 있는 쪽을 골랐다 (무채색 신호가 3행 이하; 포커스 테두리 먼저로만 읽으면 23행)", () => {
    expect(slots.filter((s) => s.seed.accent !== undefined)).toHaveLength(57);
    const neutral = slots.filter((s) => toOklch(s.seed.accent!).C < 0.04);
    expect(neutral.length).toBeLessThanOrEqual(3);
  });
});

describe("출처와 라이선스 (AC 10)", () => {
  const refs = slots.flatMap((s) => {
    const ref = s.entry.source[s.mode];
    return ref ? [{ ...s, ref }] : [];
  });

  it("모든 모드에 출처가 있고 모드 수와 같다", () => {
    expect(refs).toHaveLength(57);
    for (const entry of THEME_CATALOG) {
      expect(Object.keys(entry.source).sort()).toEqual([...(entry.light ? ["light"] : []), ...(entry.dark ? ["dark"] : [])].sort());
    }
  });

  it("모든 SPDX가 허용 목록(MIT·Apache-2.0·BSD·ISC) 안이다: MIT 52 · Apache-2.0 5", () => {
    for (const { ref, entry, mode } of refs) {
      expect([entry.id, mode, isAllowedSpdx(ref.spdx)]).toEqual([entry.id, mode, true]);
      expect(CATALOG_ALLOWED_SPDX).toContain(ref.spdx);
    }
    const count = (spdx: string) => refs.filter((r) => r.ref.spdx === spdx).length;
    expect([count("MIT"), count("Apache-2.0")]).toEqual([52, 5]);
    // Apache-2.0은 material 계열 다섯뿐이다.
    expect(refs.filter((r) => r.ref.spdx === "Apache-2.0").map((r) => r.ref.theme).sort()).toEqual([
      "material-theme",
      "material-theme-darker",
      "material-theme-lighter",
      "material-theme-ocean",
      "material-theme-palenight",
    ]);
  });

  it("aurora-x(GPL-3.0)와 경쟁 제품 이름·Buzz 자체 테마는 항목·출처 어디에도 없다", () => {
    for (const entry of THEME_CATALOG) {
      expect(FORBIDDEN).not.toContain(entry.id);
      for (const ref of Object.values(entry.source)) {
        expect(FORBIDDEN, `${entry.id} ${ref.theme}`).not.toContain(ref.theme);
        expect(ref.repo.toLowerCase()).not.toContain("aurora");
        expect(ref.repo.toLowerCase()).not.toContain("slack-theme");
        expect(ref.spdx as string).not.toMatch(/GPL/i);
      }
    }
    // 생성물 전체를 문자열로 훑어도 이름이 없다(주석·헤더 포함).
    expect(JSON.stringify(THEME_CATALOG).toLowerCase()).not.toContain("aurora");
  });

  it("상류 저장소는 25곳이고 `owner/repo` 모양이다", () => {
    const repos = new Set(refs.map((r) => r.ref.repo));
    expect(repos.size).toBe(25);
    for (const repo of repos) expect(repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  });

  it("출처 테마 이름은 서로 다르다 (한 원본이 두 항목에 들어가지 않는다)", () => {
    const names = refs.map((r) => r.ref.theme);
    expect(new Set(names).size).toBe(57);
  });

  it("상류 패키지 버전과 tarball sha256을 적었다 (재생성 입력을 가리킨다)", () => {
    expect(THEME_CATALOG_UPSTREAM.shikiThemes.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(THEME_CATALOG_UPSTREAM.tmThemes.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(THEME_CATALOG_UPSTREAM.shikiThemes.tgzSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(THEME_CATALOG_UPSTREAM.tmThemes.tgzSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(THEME_CATALOG_UPSTREAM.buzz).toEqual({ repo: "block/buzz", commit: "af5bb0a" });
  });
});
