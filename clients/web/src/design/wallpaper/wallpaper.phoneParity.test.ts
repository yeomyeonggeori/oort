import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRESET_IDS, QUALITY_STEPS, SIDE_FACTORS, SOLID_IDS, WALLPAPER_OFF_COPY, WALLPAPER_PRESETS, WALLPAPER_SOLIDS } from "@momo/core/design/wallpaper";

// =============================================================================
// 폰 사본과 같은 표 (AP-4 #4191, 이슈 AC 7). 단색 여덟·기본 제공 여섯·사진 계단의 품질·해상도 단과 시스템 접근성 문장은 폰
// `clients/mobile/src/design/{tokens.ts,background/*}`에서 core로 **복사**한 것이다(폰 import 교체는 AP-6). 폰은 그때까지 자기
// 사본을 쓰므로 두 표가 어긋나면 같은 「새벽」이 폰과 웹에서 다른 그림이 된다. 이 시험이 그 어긋남을 잡는다.
//
// AP-6이 폰의 사본을 지우면 이 시험이 읽는 파일이 사라진다. 그때 이 시험도 함께 지운다(지우는 것이 맞다: 비교할 사본이 없다).
// 웹이 폰과 **다르게** 두기로 한 것(사진의 긴 변 1600→2560, 1MB→1.5MB, 청사진 §5.5-d)은 여기서 비교하지 않는다.
// =============================================================================

const MOBILE = fileURLToPath(new URL("../../../../mobile/src/design/", import.meta.url));
const read = (file: string): string => {
  try {
    return readFileSync(`${MOBILE}${file}`, "utf8");
  } catch {
    throw new Error(`폰 사본 ${file}을 읽지 못했다. AP-6이 폰의 배경 사본을 지웠다면 이 시험도 지운다(wallpaper.phoneParity.test.ts).`);
  }
};

/** `BACKDROP_SOLIDS = { slate: {label, hex}, ... }`의 항목들(키 → 필드 표). */
function entries(source: string, constName: string): Map<string, Record<string, string>> {
  const start = source.indexOf(`export const ${constName}`);
  if (start < 0) throw new Error(`${constName}을 찾지 못했다`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let close = open;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  const body = source.slice(open + 1, close);
  const out = new Map<string, Record<string, string>>();
  for (const match of body.matchAll(/(\w+):\s*\{([^{}]*)\}/g)) {
    const fields: Record<string, string> = {};
    for (const field of match[2].matchAll(/(\w+):\s*'([^']*)'/g)) fields[field[1]] = field[2];
    out.set(match[1], fields);
  }
  return out;
}

describe("폰 사본과 core 표가 같다", () => {
  const tokens = read("tokens.ts");
  const model = read("background/model.ts");

  it("전제: 폰 표를 실제로 읽었다 (빈 읽기의 초록이 아니다)", () => {
    expect(entries(tokens, "BACKDROP_SOLIDS").size).toBe(8);
    expect(entries(tokens, "BACKDROP_PRESETS").size).toBe(6);
  });

  it("단색: id 순서·라벨·값", () => {
    const phone = entries(tokens, "BACKDROP_SOLIDS");
    expect([...phone.keys()]).toEqual([...SOLID_IDS]);
    for (const id of SOLID_IDS) expect([id, phone.get(id)]).toEqual([id, { label: WALLPAPER_SOLIDS[id].label, hex: WALLPAPER_SOLIDS[id].hex }]);
  });

  it("기본 제공: id 순서·라벨·그라데이션·폴백", () => {
    const phone = entries(tokens, "BACKDROP_PRESETS");
    expect([...phone.keys()]).toEqual([...PRESET_IDS]);
    for (const id of PRESET_IDS) {
      expect([id, phone.get(id)]).toEqual([id, { label: WALLPAPER_PRESETS[id].label, gradient: WALLPAPER_PRESETS[id].gradient, fallback: WALLPAPER_PRESETS[id].fallback }]);
    }
  });

  it("폰 모델의 id 목록도 같다", () => {
    const solid = /SOLID_IDS = \[([^\]]*)\]/.exec(model)?.[1].match(/'(\w+)'/g)?.map((value) => value.slice(1, -1));
    const preset = /PRESET_IDS = \[([^\]]*)\]/.exec(model)?.[1].match(/'(\w+)'/g)?.map((value) => value.slice(1, -1));
    expect(solid).toEqual([...SOLID_IDS]);
    expect(preset).toEqual([...PRESET_IDS]);
  });

  it("사진 계단의 품질·해상도 단과 시스템 접근성 문장", () => {
    const photo = read("background/photo.ts");
    const numbers = (name: string) => (new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(photo)?.[1] ?? "").split(",").map((value) => Number(value.trim()));
    expect(numbers("QUALITY_STEPS")).toEqual([...QUALITY_STEPS]);
    expect(numbers("SIDE_FACTORS")).toEqual([...SIDE_FACTORS]);
    expect(model).toContain(WALLPAPER_OFF_COPY["reduce-transparency"]);
    expect(model).toContain(WALLPAPER_OFF_COPY["increase-contrast"]);
  });
});
