import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKGROUND_FALLBACK_COPY, PRESETS, SOLIDS, backgroundLabel } from "@momo/core/design/mobileBackground";
import { QUALITY_STEPS, SIDE_FACTORS, WALLPAPER_COPY, WALLPAPER_OFF_COPY, WALLPAPER_PRESETS, WALLPAPER_SOLIDS } from "@momo/core/design/wallpaper";

// =============================================================================
// 폰과 웹의 배경 표가 같다 (AP-4 #4191 → AP-6 #4194). AP-6이 폰의 배경 사본(`background/model.ts`·`scrim.ts`)을 지우고
// 표를 core `mobileBackground`(= `wallpaper` 표를 그대로 쓰는 것)로 옮겼다. 그래서 단색·기본 제공 표는 같은 객체여야 하고,
// 폰 `tokens.ts`는 core를 다시 내보내기만 한다(사본이 되살아나면 여기서 잡는다). 아직 폰에 남은 사본은 사진 계단의
// 품질·해상도 단과 설정 행 문장뿐이라 그것만 글자로 비교한다.
// 웹이 폰과 **다르게** 두기로 한 것(사진의 긴 변 1600→2560, 1MB→1.5MB, 청사진 §5.5-d)은 여기서 비교하지 않는다.
// =============================================================================

const MOBILE = fileURLToPath(new URL("../../../../mobile/src/design/", import.meta.url));
const read = (file: string): string => {
  try {
    return readFileSync(`${MOBILE}${file}`, "utf8");
  } catch {
    throw new Error(`폰 사본 ${file}을 읽지 못했다. 폰 경로가 바뀌었다면 이 시험의 경로도 옮긴다(wallpaper.phoneParity.test.ts).`);
  }
};

describe("폰과 웹의 배경 표가 같다", () => {
  const tokens = read("tokens.ts");

  it("단색·기본 제공 표는 core 한 벌이다: 폰 모델은 wallpaper 표를 그대로 쓰고, 폰 tokens.ts는 다시 내보내기만 한다", () => {
    expect(SOLIDS).toBe(WALLPAPER_SOLIDS);
    expect(PRESETS).toBe(WALLPAPER_PRESETS);
    expect(tokens).toContain("export {WALLPAPER_SOLIDS as BACKDROP_SOLIDS, WALLPAPER_PRESETS as BACKDROP_PRESETS} from '@momo/core/design/wallpaper';");
    expect(tokens, "폰 tokens.ts에 배경 표 사본이 되살아났다").not.toMatch(/export const BACKDROP_(SOLIDS|PRESETS)\b/);
  });

  it("고르지 않은 상태의 이름과 설명이 같다: 폰은 「기본」(테마의 바닥 그대로예요)이고 웹도 같은 이름·같은 설명이다 (design-review M-2)", () => {
    expect(backgroundLabel({ kind: "none" }), "폰 모델의 none 라벨").toBe("기본");
    expect(WALLPAPER_COPY.none).toBe(backgroundLabel({ kind: "none" }));
    const control = read("ThemeControl.tsx");
    expect(control, "폰 설정 행의 설명").toContain(`detail="${WALLPAPER_COPY.noneDetail}"`);
    // 「기본으로」(되돌리기)도 같은 이름이다.
    expect(control).toContain(`label="${WALLPAPER_COPY.reset}"`);
  });

  it("사진 계단의 품질·해상도 단과 시스템 접근성 문장", () => {
    const photo = read("background/photo.ts");
    const numbers = (name: string) => (new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(photo)?.[1] ?? "").split(",").map((value) => Number(value.trim()));
    expect(numbers("QUALITY_STEPS")).toEqual([...QUALITY_STEPS]);
    expect(numbers("SIDE_FACTORS")).toEqual([...SIDE_FACTORS]);
    expect(BACKGROUND_FALLBACK_COPY["reduce-transparency"]).toBe(WALLPAPER_OFF_COPY["reduce-transparency"]);
    expect(BACKGROUND_FALLBACK_COPY["increase-contrast"]).toBe(WALLPAPER_OFF_COPY["increase-contrast"]);
  });
});
