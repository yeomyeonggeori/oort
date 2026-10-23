import { useEffect, useMemo, useState } from "react";
import {
  renderAvatarPng,
  sampleAvatarForeground,
  type AvatarCanvasPorts,
  type AvatarDraft,
  type AvatarGlyph,
} from "@momo/core/features/workspace/avatarEditor";
import { judgePalette, type GlyphVisibility } from "@momo/core/features/workspace/avatarContrast";
import type { AvatarBackgroundId } from "@momo/core/features/workspace/avatarPalette";
import { bytesToPngDataUrl } from "./avatarDataUrl";

// =============================================================================
// 편집기가 그림을 그리고 재는 훅 둘 (#4261). 둘 다 같은 포트(`AvatarCanvasPorts`)를 쓰므로 시험은 가짜 포트로,
// 앱은 캔버스 포트로 돈다. **미리보기와 판정과 올리는 PNG 는 같은 그림이다**: 미리보기는 올릴 PNG 와 같은 함수
// (`renderAvatarPng`)가 굽고, 판정은 올릴 글리프와 같은 계획(`planAvatar`)의 표본을 잰다.
// =============================================================================

export type GlyphSample =
  | { readonly state: "idle" }
  | { readonly state: "pending" }
  | { readonly state: "failed"; readonly reason: "no-canvas" | "paint-failed" }
  | { readonly state: "ready"; readonly pixels: ArrayLike<number> };

/** 이 글리프(이모지 또는 코메토 표정)를 배경 없이 그려 픽셀을 읽는다. 배경이 바뀌어도 다시 그리지 않는다. */
export function useGlyphSample<Layer>(ports: AvatarCanvasPorts<Layer>, glyph: AvatarGlyph | null): GlyphSample {
  const [sample, setSample] = useState<GlyphSample>({ state: "idle" });
  useEffect(() => {
    if (glyph === null) {
      setSample({ state: "idle" });
      return;
    }
    let live = true;
    setSample({ state: "pending" });
    void sampleAvatarForeground(ports, glyph).then((result) => {
      if (!live) return;
      setSample(result.ok ? { state: "ready", pixels: result.pixels } : { state: "failed", reason: result.reason });
    });
    return () => {
      live = false;
    };
  }, [ports, glyph]);
  return sample;
}

/** 표본이 있으면 팔레트 열다섯 색 각각의 판정, 없으면 `null`. */
export function usePaletteVerdicts(sample: GlyphSample): Readonly<Record<AvatarBackgroundId, GlyphVisibility>> | null {
  return useMemo(() => (sample.state === "ready" ? judgePalette(sample.pixels) : null), [sample]);
}

/**
 * 초안을 올릴 PNG 와 같은 함수로 구워 `data:` 주소로 돌려준다. 초안이 바뀌어 다시 굽는 동안에는 앞의 그림을 그대로
 * 둔다(깜박이지 않게). 초안이 없거나 굽지 못하면 `null` 이고, 호출한 쪽은 지금의 아바타를 그대로 보인다.
 */
export function usePreviewUrl<Layer>(
  ports: AvatarCanvasPorts<Layer>,
  draft: AvatarDraft | null,
  size?: number
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (draft === null) {
      setUrl(null);
      return;
    }
    let live = true;
    void renderAvatarPng(ports, draft, size).then((result) => {
      if (live) setUrl(result.ok ? bytesToPngDataUrl(result.png) : null);
    });
    return () => {
      live = false;
    };
  }, [ports, draft, size]);
  return url;
}
