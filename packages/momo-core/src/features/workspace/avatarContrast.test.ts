import { describe, expect, it } from "vitest";
import { contrast, normalizeHex } from "../../design/color";
import { rgbaBuffer } from "./__fixtures__/avatarFixture";
import {
  AVATAR_MIN_CONTRAST,
  AVATAR_MIN_INK_AREA,
  AVATAR_MIN_VISIBLE_SHARE,
  AVATAR_OPAQUE_ALPHA,
  firstVisibleBackground,
  judgeGlyphVisibility,
  judgePalette,
} from "./avatarContrast";
import { AVATAR_BACKGROUNDS, avatarBackgroundById } from "./avatarPalette";

// 아바타 판정 (#4261): 그려진 글리프가 이 배경 위에서 읽히는가. 기준은 이슈의 「3:1 이상」이다.

const PIXELS = 128 * 128;
const BUTTER = avatarBackgroundById("butter")!.hex;
const NAVY = avatarBackgroundById("navy")!.hex;

const hex = ([r, g, b]: readonly number[]): string =>
  normalizeHex(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);

/** 면적의 `share` 가 이 색인 글리프(나머지는 투명). */
const solidGlyph = (rgb: readonly [number, number, number], area = 0.15) =>
  rgbaBuffer(PIXELS, [{ rgb, count: Math.round(PIXELS * area) }]);

// 노란 얼굴, 달, 별처럼 밝은 글리프의 대표색.
const YELLOW = [255, 204, 77] as const;

describe("기준값", () => {
  it("이슈의 기준 그대로다: 3:1 이상, 면적의 절반, 알파 128", () => {
    // 상수를 상수로 비교하면 상수를 바꾼 사보타주가 시험과 함께 움직여 못 잡는다. 숫자를 시험이 직접 쥔다.
    expect(AVATAR_MIN_CONTRAST).toBe(3);
    expect(AVATAR_MIN_VISIBLE_SHARE).toBe(0.5);
    expect(AVATAR_OPAQUE_ALPHA).toBe(128);
  });
});

describe("judgeGlyphVisibility", () => {
  it("밝은 글리프는 연한 배경에 묻힌다: 노란 얼굴이 버터색 위에서 사라진다", () => {
    const verdict = judgeGlyphVisibility(solidGlyph(YELLOW), BUTTER);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: "low-contrast", share: 0 });
  });

  it("같은 글리프가 진한 배경에서는 선다", () => {
    expect(judgeGlyphVisibility(solidGlyph(YELLOW), NAVY)).toEqual({ ok: true, share: 1 });
  });

  it("어두운 글리프는 반대로 연한 배경에서 서고 진한 배경에 묻힌다", () => {
    const heart = [30, 30, 34] as const;
    expect(judgeGlyphVisibility(solidGlyph(heart), BUTTER).ok).toBe(true);
    expect(judgeGlyphVisibility(solidGlyph(heart), NAVY)).toMatchObject({ ok: false, reason: "low-contrast" });
  });

  it("한 색 글리프의 판정은 WCAG 대비비 3:1 과 모든 팔레트 색에서 정확히 일치한다", () => {
    // 색 하나짜리 글리프는 면적 비율이 0 아니면 1 이라, 판정이 곧 대비비 ≥ 3 이어야 한다(`color.ts` 의 식과 대조).
    const steps = [0, 51, 102, 153, 204, 255];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const buffer = solidGlyph([r, g, b]);
          for (const entry of AVATAR_BACKGROUNDS) {
            const expected = contrast(hex([r, g, b]), entry.hex) >= 3;
            expect(judgeGlyphVisibility(buffer, entry.hex).ok, `${hex([r, g, b])} on ${entry.id}`).toBe(expected);
          }
        }
      }
    }
  });

  it("면적의 절반이 3:1을 넘는 경계: 50%는 통과이고 49%는 막힌다 (노랑·검정 반반인 벌 같은 그림)", () => {
    const black = [20, 20, 20] as const;
    const area = 3200; // 표본의 19.5%: 두 색의 면적이 정수가 되게 고른 값
    const half = area / 2;
    // 진한 남색 위: 노랑은 보이고 검정은 묻힌다. 노랑이 절반이면 통과.
    const fifty = rgbaBuffer(PIXELS, [
      { rgb: YELLOW, count: half },
      { rgb: black, count: half },
    ]);
    expect(judgeGlyphVisibility(fifty, NAVY)).toEqual({ ok: true, share: AVATAR_MIN_VISIBLE_SHARE });
    const forty9 = rgbaBuffer(PIXELS, [
      { rgb: YELLOW, count: 1568 }, // 49%
      { rgb: black, count: 1632 }, // 51%
    ]);
    const verdict = judgeGlyphVisibility(forty9, NAVY);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: "low-contrast" });
  });

  it("한 점이 3:1을 넘는다고 통과시키지 않는다: 어두운 눈 한 점이 노란 얼굴을 살리지 못한다", () => {
    const face = rgbaBuffer(PIXELS, [
      { rgb: YELLOW, count: 2400 },
      { rgb: [20, 20, 20], count: 40 },
    ]);
    expect(judgeGlyphVisibility(face, BUTTER)).toMatchObject({ ok: false, reason: "low-contrast" });
  });

  it("가장자리의 반투명 띠(알파 128 미만)는 면적으로 세지 않는다", () => {
    const withFringe = rgbaBuffer(PIXELS, [
      { rgb: YELLOW, count: 1000 },
      // 연한 배경에서 보이는 어두운 띠가 아주 많아도 반투명이면 판정을 뒤집지 못한다.
      { rgb: [10, 10, 10], count: 5000, alpha: AVATAR_OPAQUE_ALPHA - 1 },
    ]);
    expect(judgeGlyphVisibility(withFringe, BUTTER)).toMatchObject({ ok: false, reason: "low-contrast", share: 0 });
    const exactlyOpaque = rgbaBuffer(PIXELS, [
      { rgb: YELLOW, count: 1000 },
      { rgb: [10, 10, 10], count: 5000, alpha: AVATAR_OPAQUE_ALPHA },
    ]);
    expect(judgeGlyphVisibility(exactlyOpaque, BUTTER).ok).toBe(true);
  });

  it("아무것도 그려지지 않았으면 blank 다: 투명한 표본, 글꼴에 없는 이모지", () => {
    expect(judgeGlyphVisibility(new Uint8ClampedArray(PIXELS * 4), NAVY)).toEqual({
      ok: false,
      reason: "blank",
      share: 0,
    });
    expect(judgeGlyphVisibility([], NAVY)).toMatchObject({ ok: false, reason: "blank" });
  });

  it("불투명 면적이 표본의 0.5% 미만이면 blank 이고 그 이상이면 센다", () => {
    const need = Math.ceil(PIXELS * AVATAR_MIN_INK_AREA);
    expect(judgeGlyphVisibility(rgbaBuffer(PIXELS, [{ rgb: YELLOW, count: need - 1 }]), NAVY)).toMatchObject({
      reason: "blank",
    });
    expect(judgeGlyphVisibility(rgbaBuffer(PIXELS, [{ rgb: YELLOW, count: need }]), NAVY).ok).toBe(true);
  });

  it("배경이 #rrggbb 가 아니면 invalid-color 로 막는다 (던지지 않는다)", () => {
    for (const bad of ["", "red", "#fff", "#12345g", "222840"]) {
      expect(judgeGlyphVisibility(solidGlyph(YELLOW), bad), bad).toMatchObject({
        ok: false,
        reason: "invalid-color",
      });
    }
  });

  it("범위를 벗어난 채널 값도 던지지 않는다 (호스트가 float 버퍼를 줄 수 있다)", () => {
    const odd = [300, -5, 255.4, 255, 0, 0, 0, 255];
    expect(() => judgeGlyphVisibility(odd, NAVY)).not.toThrow();
  });
});

describe("judgePalette · firstVisibleBackground", () => {
  it("팔레트 열다섯 색 전부에 대해 판정을 돌려준다", () => {
    const all = judgePalette(solidGlyph(YELLOW));
    expect(Object.keys(all)).toHaveLength(15);
    for (const entry of AVATAR_BACKGROUNDS) {
      expect(all[entry.id].ok, entry.id).toBe(contrast(hex(YELLOW), entry.hex) >= 3);
    }
  });

  it("밝은 글리프에서 통과하는 첫 색은 진한 단의 첫 칸(남색)이다", () => {
    expect(firstVisibleBackground(solidGlyph(YELLOW))?.id).toBe("navy");
  });

  it("어두운 글리프에서는 연한 단의 첫 칸이고, 그려진 게 없으면 null 이다", () => {
    expect(firstVisibleBackground(solidGlyph([30, 30, 34]))?.id).toBe("butter");
    expect(firstVisibleBackground(new Uint8ClampedArray(PIXELS * 4))).toBeNull();
  });
});
