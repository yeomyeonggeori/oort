import { describe, expect, it } from "vitest";
import { MODES, THEME_IDS, THEMES } from "@momo/core/design/themes";
import { contrast } from "../tokens.contrast.test";

// 설정 > 모양의 테마 미리보기 카드(#3578 S3a)가 칠하는 글자·알약의 대비. 카드는 팔레트
// 범위 변형(`[data-palette-preview]`)으로 한 요소에 그 팔레트의 역할을 묶으므로, 세
// 팔레트 × 두 모드 어디서도 카드 안 글자가 읽혀야 한다. 짝은 카드 소스가 실제로 쓰는
// 것만 적는다: 제목(ink)·보조 줄(ink-muted)은 본문 면(surface) 위, 알약 글자(on-signal)는
// 팔레트 기본 신호(signal) 위. 기대값은 core 원천에서 직접 읽는다(생성 CSS를 거치지
// 않는다). 렌더된 픽셀은 capture-settings 하네스가 같은 짝을 한 번 더 잰다.
// 11px(text-timestamp) 글자라 본문 하한 4.5를 쓴다.

const FLOOR = 4.5;

describe("테마 미리보기 카드 글자 대비", () => {
  for (const theme of THEME_IDS) {
    for (const mode of MODES) {
      const { color } = THEMES[theme][mode];
      it(`${theme} ${mode}: 제목·보조 줄·알약 글자가 ${FLOOR} 이상`, () => {
        const pairs: Array<[string, string, string]> = [
          ["ink / surface", color.ink, color.surface],
          ["ink-muted / surface", color["ink-muted"], color.surface],
          ["on-signal / signal", color["on-signal"], color.signal],
        ];
        for (const [name, fg, bg] of pairs) {
          expect([name, contrast(fg, bg) >= FLOOR]).toEqual([name, true]);
        }
      });
    }
  }

  it("자가 점검: 일부러 틀린 짝은 이 자에서 걸린다", () => {
    const { color } = THEMES.dawnsky.light;
    expect(contrast(color.surface, color.surface)).toBeLessThan(FLOOR);
  });
});
