import { describe, expect, it } from "vitest";
import {
  contrast,
  fromOklch,
  hueGap,
  luminance,
  mixOklab,
  normalizeHex,
  oklabDistance,
  parseHex,
  toOklab,
  toOklch,
} from "./color";

// 자 자체의 검정. 이 값들이 맞지 않으면 테마 대비 시험은 엉뚱한 수를 잰다.
describe("WCAG 대비", () => {
  it("흑백 21, 같은 색 1", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 6);
    expect(contrast("#777777", "#777777")).toBe(1);
  });

  it("순서와 대소문자에 무관하다", () => {
    expect(contrast("#16171b", "#FFFEFC")).toBe(contrast("#FFFEFC", "#16171B"));
  });

  it("알려진 값: WebAIM 기준 #767676 / 흰색 = 4.54", () => {
    expect(contrast("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
  });

  it("상대 휘도 끝점", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#FFFFFF")).toBeCloseTo(1, 9);
  });
});

describe("OKLab", () => {
  it("흰색은 L=1, 무채색은 a=b=0", () => {
    const white = toOklab("#FFFFFF");
    expect(white.L).toBeCloseTo(1, 4);
    expect(Math.abs(white.a)).toBeLessThan(1e-4);
    expect(Math.abs(white.b)).toBeLessThan(1e-4);
  });

  it("알려진 값: sRGB 빨강 = OKLab(0.628, 0.225, 0.126)", () => {
    const red = toOklab("#FF0000");
    expect(red.L).toBeCloseTo(0.628, 3);
    expect(red.a).toBeCloseTo(0.2249, 3);
    expect(red.b).toBeCloseTo(0.1258, 3);
  });

  it("거리는 대칭이고 같은 색이면 0", () => {
    expect(oklabDistance("#C2410C", "#BE2C4F")).toBeCloseTo(oklabDistance("#BE2C4F", "#C2410C"), 12);
    expect(oklabDistance("#C2410C", "#c2410c")).toBe(0);
  });

  it("OKLCH 왕복이 한 단위 안에서 돌아온다", () => {
    for (const hex of ["#C2410C", "#2F5B8A", "#0E7740", "#FDFDFE", "#16171B", "#FF4BCC"]) {
      const back = fromOklch(toOklch(hex));
      const [a, b] = [parseHex(hex)!, parseHex(back)!];
      a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(1));
    }
  });

  it("sRGB 밖의 OKLCH는 명도·색상각을 지키고 채도만 줄인다", () => {
    const out = fromOklch({ L: 0.9, C: 0.4, h: 264 });
    const lch = toOklch(out);
    expect(lch.L).toBeCloseTo(0.9, 2);
    expect(Math.abs(lch.h - 264)).toBeLessThan(2);
    expect(lch.C).toBeLessThan(0.4);
  });

  it("색상각 차이는 0~180", () => {
    expect(hueGap("#FF0000", "#FF0000")).toBe(0);
    const gap = hueGap("#FF0000", "#00FFFF");
    expect(gap).toBeGreaterThan(150);
    expect(gap).toBeLessThanOrEqual(180);
  });

  it("OKLab 섞기의 끝점은 두 원래 색이다", () => {
    expect(mixOklab("#FFFEFC", "#C2410C", 0)).toBe("#fffefc");
    expect(mixOklab("#FFFEFC", "#C2410C", 1)).toBe("#c2410c");
  });
});

describe("hex 입력", () => {
  it.each(["#GGGGGG", "red", "#fff", "#C2410C80", "C2410C", "", "#12345", " #1234567"])(
    "%j 는 거절한다",
    (input) => {
      expect(parseHex(input)).toBeNull();
    }
  );

  it("앞뒤 공백과 대소문자는 받는다", () => {
    expect(parseHex(" #c2410C ")).toEqual([194, 65, 12]);
    expect(normalizeHex("#C2410C")).toBe("#c2410c");
  });

  it("다른 함수는 잘못된 입력을 조용히 검정으로 읽지 않는다", () => {
    expect(() => contrast("#GGG", "#FFFFFF")).toThrow(/not a #RRGGBB/);
  });
});
