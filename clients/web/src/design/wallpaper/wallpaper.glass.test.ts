import { describe, expect, it } from "vitest";
import type { WallpaperRef } from "@momo/core/design/appearance";
import { wallpaperBlocksGlass } from "@momo/core/design/wallpaper";

// =============================================================================
// 배경화면과 유리는 같은 창 바닥 층을 쓴다: 배경이 켜져 있으면 유리는 꺼진다 (이슈 AC 6, ADR-0189 증보 3 결정 9).
//
// 유리(AP-3, #4190)와 배경화면(AP-4, 이 이슈)은 같은 파도에서 따로 만들어진다. 이 판정의 양쪽 끝이 서로 모르는 채 어긋나지
// 않도록, 유리의 판정 함수(`resolveGlass`)가 트리에 있으면 이 시험이 저절로 켜져 **두 술어가 같은 말을 하는지**를 잰다:
//   · 이 쪽: `wallpaperBlocksGlass(ref)` — 배경화면을 「고른 상태」인가(선택이지, 지금 깔렸는가가 아니다)
//   · 저 쪽: `resolveGlass({ wallpaper })`가 `reason: "wallpaper"`로 유리를 잠그는가
// 유리가 아직 합류하지 않은 트리에서는 이 시험이 할 말이 없어 todo로 남는다(빈 초록으로 두지 않는다). 뒤에 합류하는 쪽이
// 이 시험을 켜고, 어긋나면 그 PR에서 빨개진다.
// =============================================================================

interface GlassModule {
  resolveGlass(input: {
    on: boolean;
    supported: boolean;
    floorPercent: number | null;
    wallpaper: boolean;
    failed: boolean;
    reducedTransparency: boolean;
  }): { reason: string | null; toggleDisabled: boolean; checked: boolean; nativeWanted: boolean; paintWanted: boolean };
}

const glassModules = import.meta.glob("../../../../../packages/momo-core/src/design/glass.ts");
const ACTIVE = Object.keys(glassModules).length > 0;

const REFS: ReadonlyArray<readonly [string, WallpaperRef | undefined]> = [
  ["없음", undefined],
  ["단색", { kind: "solid", id: "slate" }],
  ["기본 제공", { kind: "preset", id: "bam" }],
  ["내 사진", { kind: "image", width: 2560, height: 1690, rev: 1 }],
];

async function loadGlass(): Promise<GlassModule> {
  const load = Object.values(glassModules)[0];
  if (load === undefined) throw new Error("glass module missing");
  return (await load()) as GlassModule;
}

describe("배경화면 선택은 유리를 잠근다 (판정이 한 칸이다)", () => {
  it("술어: 배경화면을 고르지 않았으면 막지 않고 고르면(종류 무관) 막는다", () => {
    expect(REFS.map(([, ref]) => wallpaperBlocksGlass(ref))).toEqual([false, true, true, true]);
  });
});

describe.skipIf(!ACTIVE)("유리 판정(AP-3)과 같은 말을 한다", () => {
  it.each(REFS)("%s", async (_label, ref) => {
    const { resolveGlass } = await loadGlass();
    const base = { on: true, supported: true, floorPercent: 40, failed: false, reducedTransparency: false };
    const decision = resolveGlass({ ...base, wallpaper: wallpaperBlocksGlass(ref) });
    if (ref === undefined) {
      // 배경이 없으면 유리가 자기 일을 한다(켜져 있고 그려도 된다).
      expect(decision.reason).toBeNull();
      expect(decision.toggleDisabled).toBe(false);
      expect(decision.paintWanted).toBe(true);
    } else {
      // 배경을 골랐으면 저장된 켬은 남아도 유효 값은 꺼짐이고, 스위치는 잠기고, 이유가 문장으로 선다.
      expect(decision.reason).toBe("wallpaper");
      expect(decision.toggleDisabled).toBe(true);
      expect(decision.checked).toBe(false);
      expect(decision.nativeWanted).toBe(false);
      expect(decision.paintWanted).toBe(false);
    }
  });
});

describe.skipIf(ACTIVE)("유리 판정(AP-3)과 같은 말을 한다 (유리가 합류하기 전)", () => {
  it.todo("유리의 `resolveGlass`가 트리에 들어오면 이 묶음이 저절로 켜진다");
});
