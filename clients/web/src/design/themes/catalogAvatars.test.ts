import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, oklabDistance } from "@momo/core/design/color";
import { deriveThemeMode } from "@momo/core/design/derive";
import { THEME_CATALOG } from "@momo/core/design/themeCatalog.generated";
import { VESSEL_MIN_CONTRAST, VESSEL_MIN_DISTANCE, type Mode } from "@momo/core/design/themes";

// =============================================================================
// 사람 기본 아바타가 카탈로그 면 위에서 서는가 (AP-1b #4188, 청사진 §5.2-b 「테마가 다시 묶지 않는 이름」).
//
// `--avatar-1`…`5`와 `-soft`는 테마와 무관한 **웹 상수**다(`tokens.css`, core 역할이 아니다). 테마가 바뀌어도 이 값은
// 그대로이므로 두 가지가 테마마다 달라진다. 글자와 자기 원판의 대비는 둘 다 상수라 변하지 않지만(여기서도 한 번 더
// 잰다), **원판이 놓이는 면**은 테마가 정한다. 원판이 면과 같은 색이면 이니셜만 떠 있게 된다. 디자인 시스템이 칩
// 그릇에 쓰는 두 자(대비 1.05 **또는** OKLab 0.02, `VESSEL_MIN_*`)를 그대로 쓴다: 어두운 중간톤 바탕(Nord·Dracula)에서
// 원판은 밝기가 거의 같아도 색상이 달라 두 번째 자가 받쳐 준다(측정: 최소 OKLab 0.031).
// =============================================================================

const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

function pair(name: string): Record<Mode, string> {
  const found = new RegExp(`--${name}: light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\)`).exec(css);
  expect(found, `--${name}`).not.toBeNull();
  return { light: found![1], dark: found![2] };
}

const TONES = [1, 2, 3, 4, 5].map((n) => ({ n, fill: pair(`avatar-${n}-soft`), text: pair(`avatar-${n}`) }));

const ROWS = THEME_CATALOG.flatMap((entry) =>
  (["light", "dark"] as const).flatMap((mode) => (entry[mode] ? [{ id: entry.id, mode, seed: entry[mode]! }] : []))
);

describe("기본 아바타 상수", () => {
  it("다섯 색조가 있고 라이트·다크 쌍이다", () => {
    expect(TONES).toHaveLength(5);
  });

  it.each(["light", "dark"] as const)("%s: 글자는 자기 원판 위에서 4.5 이상이다 (테마와 무관한 상수)", (mode) => {
    for (const tone of TONES) expect(contrast(tone.text[mode], tone.fill[mode]), `avatar-${tone.n}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("카탈로그 면 위의 원판 (57 테마-모드 × 5 색조 × 놓이는 면 셋)", () => {
  it.each(ROWS.map((row) => [`${row.id} ${row.mode}`, row] as const))("%s", (_name, row) => {
    const derived = deriveThemeMode(row.seed);
    const hosts: [string, string][] = [
      ["pane(타임라인)", derived.pane],
      ["sheet(사이드바)", derived.tokens.color.sheet],
      ["surface(카드)", derived.tokens.color.surface],
    ];
    for (const tone of TONES) {
      const fill = tone.fill[row.mode];
      for (const [host, color] of hosts) {
        const ok = contrast(fill, color) >= VESSEL_MIN_CONTRAST || oklabDistance(fill, color) >= VESSEL_MIN_DISTANCE;
        expect([`avatar-${tone.n}`, host, ok]).toEqual([`avatar-${tone.n}`, host, true]);
      }
    }
  });

  it("자가 점검: 원판과 같은 색의 면은 이 자에서 걸린다 (가드가 실패할 수 있다)", () => {
    const fill = TONES[0].fill.dark;
    expect(contrast(fill, fill) >= VESSEL_MIN_CONTRAST || oklabDistance(fill, fill) >= VESSEL_MIN_DISTANCE).toBe(false);
  });

  it("밝기만으로는 17행이 모자라고 색상이 받친다 (두 번째 자가 일하는 곳을 숨기지 않는다)", () => {
    let weakByLightness = 0;
    for (const row of ROWS) {
      const derived = deriveThemeMode(row.seed);
      for (const tone of TONES) {
        if (contrast(tone.fill[row.mode], derived.pane) < VESSEL_MIN_CONTRAST) weakByLightness += 1;
      }
    }
    // 측정: 285조합 가운데 77이 밝기 대비 1.10 미만이고 41이 1.05 미만이다. 첫 파티의 최소는 1.17.
    expect(weakByLightness).toBeGreaterThan(0);
  });
});
