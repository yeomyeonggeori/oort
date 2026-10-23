import { describe, expect, it } from "vitest";
import { contrast } from "@momo/core/design/color";
import { INK_MIN_ON_BACKDROP, NON_TEXT_MIN_ON_BACKDROP, TEXT_MIN_ON_BACKDROP, blend, holdsOnBoth, minimumScrimAlpha, worstCaseBackdrops } from "@momo/core/design/scrim";
import type { Mode, ThemeModeTokens } from "@momo/core/design/themes";
import {
  WALLPAPER_BLURRY_MIN_PERCENT,
  WALLPAPER_NON_TEXT_ROLES,
  WALLPAPER_TEXT_ROLES,
  WALLPAPER_USABLE_MAX_PERCENT,
  wallpaperTokensOf,
  wallpaperTreatment,
} from "@momo/core/design/wallpaper";

// =============================================================================
// 카탈로그 57 테마-모드 위의 배경화면 (AP-4 #4191, 이슈 AC 2). **파생 엔진이 이 트리에 들어오는 순간 저절로 켜지는 짝 시험**이다.
//
// 카탈로그와 파생 엔진(`deriveCatalog.ts`)은 AP-1b(#4188)가 들인다. AP-4와 AP-1b는 같은 파도에서 따로 나가므로 이 PR의
// 트리에는 그 파일이 없을 수 있다. 그때 이 시험은 「없음」을 **눈에 보이게** 말하고(아래 todo), 있을 때는 57 테마-모드
// 전수에서 같은 산수를 잰다. 병합 트리 게이트(`verify_merge_tree.sh`)가 두 PR이 만난 트리에서 이 시험을 돌리므로, 합류 순간에
// 조용히 초록으로 남지 않는다. PR 본문에는 AP-1b의 커밋 위에 임시로 얹어 돌린 결과(57/57, 판정 분포)를 적는다.
// =============================================================================

interface CatalogModule {
  catalogEntries(): readonly { id: string; light?: unknown; dark?: unknown }[];
  deriveCatalogMode(id: string, mode: Mode): { tokens: ThemeModeTokens } | null;
}

const found = import.meta.glob("../../../../../packages/momo-core/src/design/deriveCatalog.ts", { eager: true }) as Record<string, unknown>;
const catalog = Object.values(found)[0] as CatalogModule | undefined;

function prng(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 채널 값으로 만든 `#rrggbb`(색 리터럴을 소스에 적지 않는다). */
const pixel = (r: number, g: number, b: number): string => `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;

/** 순흑·순백·중간 회색 + 결정적 의사난수 304개 = 307픽셀. */
const PIXELS: readonly string[] = [
  pixel(0, 0, 0),
  pixel(255, 255, 255),
  pixel(127, 127, 127),
  ...(() => {
    const next = prng(20261022);
    const byte = () => Math.floor(next() * 256);
    return Array.from({ length: 304 }, () => pixel(byte(), byte(), byte()));
  })(),
];

describe.skipIf(catalog !== undefined)("카탈로그 위의 배경화면 (이 트리에는 파생 엔진이 아직 없다)", () => {
  it.todo("AP-1b(#4188)가 합류하면 이 시험이 57 테마-모드 전수에서 저절로 켜진다");
});

describe.runIf(catalog !== undefined)("카탈로그 57 테마-모드 위의 배경화면", () => {
  const modes: Mode[] = ["light", "dark"];
  const rows = (() => {
    if (!catalog) return [];
    const out: { id: string; mode: Mode; tokens: ThemeModeTokens }[] = [];
    for (const entry of catalog.catalogEntries()) {
      for (const mode of modes) {
        if (!entry[mode]) continue;
        const derived = catalog.deriveCatalogMode(entry.id, mode);
        if (derived) out.push({ id: entry.id, mode, tokens: derived.tokens });
      }
    }
    return out;
  })();

  it("테마-모드가 57개다 (ADR-0189 증보 3 D1: Buzz 62 - 자체 2 - aurora-x 1 - slack 2)", () => {
    expect(rows).toHaveLength(57);
  });

  it("깔리는 불투명도는 같은 산수로 다시 구한 하한이고, 잉크가 순흑·순백·잡음 307픽셀 합성 위에서 7:1 이상이다 (쓸 수 있는 모드 전부)", () => {
    const bad: string[] = [];
    let usable = 0;
    for (const { id, mode, tokens } of rows) {
      const input = wallpaperTokensOf(tokens);
      const t = wallpaperTreatment(input, mode);
      expect(t.alpha).toBe(minimumScrimAlpha(tokens.canvas[1], tokens.color.ink, INK_MIN_ON_BACKDROP));
      if (t.verdict === "unavailable") continue;
      usable += 1;
      for (const pixel of PIXELS) {
        if (contrast(input.ink, blend(input.canvas, pixel, t.alpha)) < INK_MIN_ON_BACKDROP) bad.push(`${id}/${mode}@${pixel}`);
      }
    }
    expect(bad).toEqual([]);
    expect(usable).toBeGreaterThan(30);
  });

  it("하한은 빠듯하다 (0.01만 얇아도 최악 입력에서 7:1이 깨진다)", () => {
    for (const { id, mode, tokens } of rows) {
      const t = wallpaperTreatment(wallpaperTokensOf(tokens), mode);
      if (t.verdict === "unavailable" || t.alpha === 0) continue;
      expect([id, mode, holdsOnBoth(tokens.color.ink, worstCaseBackdrops(tokens.canvas[1], t.alpha - 0.01), INK_MIN_ON_BACKDROP)]).toEqual([id, mode, false]);
    }
  });

  it("사보타주: 불투명도를 0.15 낮추면 쓸 수 있는 모든 테마-모드가 최악 입력에서 빨개진다", () => {
    for (const { id, mode, tokens } of rows) {
      const t = wallpaperTreatment(wallpaperTokensOf(tokens), mode);
      if (t.verdict === "unavailable") continue;
      expect([id, mode, holdsOnBoth(tokens.color.ink, worstCaseBackdrops(tokens.canvas[1], t.alpha - 0.15), INK_MIN_ON_BACKDROP)]).toEqual([id, mode, false]);
    }
  });

  it("보정한 글자는 4.5:1, 표식은 3:1 이상이다 (모든 픽셀 위, 쓸 수 있는 테마-모드 전부)", () => {
    const bad: string[] = [];
    for (const { id, mode, tokens } of rows) {
      const input = wallpaperTokensOf(tokens);
      const t = wallpaperTreatment(input, mode);
      if (t.verdict === "unavailable") continue;
      for (const pixel of PIXELS) {
        const host = blend(input.canvas, pixel, t.alpha);
        for (const role of WALLPAPER_TEXT_ROLES) if (contrast(t.roles[role], host) < TEXT_MIN_ON_BACKDROP) bad.push(`${id}/${mode}/${role}@${pixel}`);
        for (const role of WALLPAPER_NON_TEXT_ROLES) if (contrast(t.roles[role], host) < NON_TEXT_MIN_ON_BACKDROP) bad.push(`${id}/${mode}/${role}@${pixel}`);
      }
      if (contrast(t.roles["on-signal"], t.roles.signal) < TEXT_MIN_ON_BACKDROP) bad.push(`${id}/${mode}/on-signal`);
    }
    expect(bad).toEqual([]);
  });

  // 교정점: 파생 엔진(AP-1b #4256)이 머지된 뒤의 57 테마-모드 하한 분포를 리터럴로 못 박는다. 파생 엔진이 바닥·잉크 파생을 바꿔서 이
  // 숫자가 움직이면 이 시험이 빨개지고, 그때는 문서와 함께 의식적으로 고친다.
  //
  // **ADR-0189 증보 3 D6의 표(26·9·13·9, 불가 9건)와 다르다.** 그 표는 Buzz 원본 색을 그대로 잰 프로토타입 값이다. 엔진이 들어온 뒤에는
  // 잉크가 바닥과의 대비(7:1)를 지키도록 파생되어서 하한이 내려갔고, 0.95를 넘는 모드가 없다(쓸 수 없는 테마 0, 힌트 22).
  // ADR·이슈 정정 코멘트의 「57종 중 9」는 엔진 뒤의 값이 아니다(문서 갱신은 기획 트랙의 몫, PR 본문에 적었다).
  it("교정점: 하한 분포 26·9·22·0 — 파생 엔진 뒤의 값이고, 쓸 수 없는 모드는 없다", () => {
    const floors = rows.map(({ mode, tokens }) => wallpaperTreatment(wallpaperTokensOf(tokens), mode).floor);
    expect({
      "0.80 이하": floors.filter((f) => f <= 0.8).length,
      "0.80 초과 0.85 미만": floors.filter((f) => f > 0.8 && f < 0.85).length,
      "0.85 이상 0.95 이하": floors.filter((f) => f >= 0.85 && f <= 0.95).length,
      "0.95 초과": floors.filter((f) => f > 0.95).length,
    }).toEqual({ "0.80 이하": 26, "0.80 초과 0.85 미만": 9, "0.85 이상 0.95 이하": 22, "0.95 초과": 0 });
    const unavailable = rows
      .filter(({ mode, tokens }) => wallpaperTreatment(wallpaperTokensOf(tokens), mode).verdict === "unavailable")
      .map(({ id, mode }) => `${id}/${mode}`)
      .sort();
    expect(unavailable).toEqual([]);
  });

  it("판정은 하한의 퍼센트로만 정해진다 (불가는 95% 초과, 힌트는 85~95%)", () => {
    const seen = { ok: 0, blurry: 0, unavailable: 0 };
    for (const { id, mode, tokens } of rows) {
      const t = wallpaperTreatment(wallpaperTokensOf(tokens), mode);
      const percent = Math.round(t.floor * 100);
      const expected = percent > WALLPAPER_USABLE_MAX_PERCENT ? "unavailable" : percent >= WALLPAPER_BLURRY_MIN_PERCENT ? "blurry" : "ok";
      expect([id, mode, t.verdict]).toEqual([id, mode, expected]);
      seen[t.verdict] += 1;
    }
    // 분포 자체는 위 교정점 시험이 못 박는다(ADR의 표는 프로토타입 값이고, 파생 엔진의 규칙이 바뀌면 그 시험이 먼저 빨개진다). 여기서는
    // 이 시험이 빈 반복의 초록이 아니도록 「쓸 수 있는 모드」와 「하한이 높은 모드(힌트나 불가)」가 둘 다 있는지만 단정한다. 불가가
    // 몇 개인지는 파생 엔진의 몫이다(규칙이 잉크를 더 끌어올려 0이 될 수 있다): 임계 자체는 core 시험이 의사난수 테마로 잰다.
    expect(seen.ok).toBeGreaterThan(0);
    expect(seen.blurry + seen.unavailable).toBeGreaterThan(0);
  });
});
