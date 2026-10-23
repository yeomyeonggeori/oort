import { describe, expect, it } from "vitest";
import { luminance, normalizeHex, oklabDistance, parseHex } from "../../design/color";
import {
  AVATAR_BACKGROUNDS,
  AVATAR_BACKGROUND_IDS,
  DEFAULT_EMOJI_BACKGROUND,
  DEFAULT_PRESET_BACKGROUND,
  avatarBackgroundByHex,
  avatarBackgroundHex,
  avatarBackgroundById,
} from "./avatarPalette";

// 아바타 배경 팔레트 (#4261). 이 색은 PNG 로 구워지므로 테마와 무관한 고정 값이다.

describe("아바타 배경 팔레트", () => {
  it("열다섯 색이고 id 표와 같은 순서이며 서로 겹치지 않는다", () => {
    expect(AVATAR_BACKGROUNDS).toHaveLength(15);
    expect(AVATAR_BACKGROUNDS.map((entry) => entry.id)).toEqual([...AVATAR_BACKGROUND_IDS]);
    expect(new Set(AVATAR_BACKGROUNDS.map((entry) => entry.id)).size).toBe(15);
    expect(new Set(AVATAR_BACKGROUNDS.map((entry) => entry.hex)).size).toBe(15);
  });

  it("모든 색은 소문자 #rrggbb 이고 순흑·순백이 아니다", () => {
    for (const entry of AVATAR_BACKGROUNDS) {
      expect(parseHex(entry.hex), entry.id).not.toBeNull();
      expect(entry.hex, entry.id).toBe(normalizeHex(entry.hex));
      expect(entry.hex, entry.id).not.toBe("#000000");
      expect(entry.hex, entry.id).not.toBe("#ffffff");
    }
  });

  it("두 단이 실제로 갈린다: 연한 여덟은 명도가 높고 진한 일곱은 낮다", () => {
    const light = AVATAR_BACKGROUNDS.filter((entry) => entry.tier === "light");
    const deep = AVATAR_BACKGROUNDS.filter((entry) => entry.tier === "deep");
    expect([light.length, deep.length]).toEqual([8, 7]);
    // 단 이름이 값을 속이지 못한다: 표의 이름이 아니라 휘도로 센다.
    for (const entry of light) expect(luminance(entry.hex), entry.id).toBeGreaterThan(0.55);
    for (const entry of deep) expect(luminance(entry.hex), entry.id).toBeLessThan(0.15);
  });

  it("보조기술이 읽는 이름이 있고 서로 다르다", () => {
    for (const entry of AVATAR_BACKGROUNDS) expect(entry.label.trim(), entry.id).not.toBe("");
    expect(new Set(AVATAR_BACKGROUNDS.map((entry) => entry.label)).size).toBe(15);
  });

  it("어느 두 색도 눈으로 구별 못 할 만큼 가깝지 않다 (OKLab 거리)", () => {
    let nearest = Infinity;
    for (let i = 0; i < AVATAR_BACKGROUNDS.length; i += 1) {
      for (let j = i + 1; j < AVATAR_BACKGROUNDS.length; j += 1) {
        nearest = Math.min(nearest, oklabDistance(AVATAR_BACKGROUNDS[i].hex, AVATAR_BACKGROUNDS[j].hex));
      }
    }
    expect(nearest).toBeGreaterThan(0.045);
  });

  it("코메토의 처음 바탕은 정본 배지의 남색이다", () => {
    expect(avatarBackgroundById(DEFAULT_PRESET_BACKGROUND)?.hex).toBe("#222840");
    expect(avatarBackgroundById(DEFAULT_PRESET_BACKGROUND)?.tier).toBe("deep");
  });

  it("이모지의 처음 바탕도 진한 단의 남색이고, id 로 색을 찾는다", () => {
    expect(avatarBackgroundHex(DEFAULT_EMOJI_BACKGROUND)).toBe("#222840");
    expect(avatarBackgroundById(DEFAULT_EMOJI_BACKGROUND)?.tier).toBe("deep");
    for (const entry of AVATAR_BACKGROUNDS) expect(avatarBackgroundHex(entry.id)).toBe(entry.hex);
  });

  it("hex 로 칸을 찾는다: 대소문자는 무관하고 자유 색은 찾지 못한다", () => {
    expect(avatarBackgroundByHex("#222840")?.id).toBe("navy");
    expect(avatarBackgroundByHex(" #222840 ")?.id).toBe("navy");
    expect(avatarBackgroundByHex("#F7E8AF")?.id).toBe("butter");
    expect(avatarBackgroundByHex("#123456")).toBeUndefined();
    expect(avatarBackgroundById("nope")).toBeUndefined();
  });
});
