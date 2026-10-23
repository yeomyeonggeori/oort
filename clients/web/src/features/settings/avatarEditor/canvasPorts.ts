import type {
  AvatarCanvasPorts,
  AvatarForeground,
  AvatarPresetId,
  SquareCrop,
} from "@momo/core/features/workspace/avatarEditor";
import { KOMETTO_EXPRESSION_ASSETS } from "@/features/onboarding/guide/komettoExpressions";

// =============================================================================
// 아바타 그리기: 브라우저 캔버스 포트 (#4261). 모델과 판정은 코어(`avatarEditor.ts`)가 갖고, 이 파일은 코어가
// 부르는 여섯 동작만 캔버스로 구현한다. 폰은 자기 포트를 붙인다.
//
//   fill      캔버스를 한 색으로 칠한다.
//   이모지    **잉크 상자를 가운데에 맞춰** 그린다. 글꼴마다 기준선과 글리프 상자가 달라서
//             (색 글꼴의 `measureText` 는 잉크가 아니라 줄 상자를 주기도 한다) 상자를 재는 대신 **한 번 그려
//             보고 실제 픽셀의 경계를 읽어** 옮긴다. 어느 엔진·글꼴이어도 같은 규칙으로 가운데에 선다.
//   코메토    정본 컷 PNG 를 `crop` 비율로 잘라 캔버스 전체에 맞춘다(표정 에셋 경로는 `komettoExpressions.ts` 한 곳).
//   픽셀      `getImageData`(곧은 알파)로 읽는다. 같은 오리진 이미지와 글자뿐이라 캔버스가 오염되지 않는다.
//   PNG       `toBlob("image/png")`. 이 바이트가 정본이다.
//
// CSP(`img-src 'self' data:`)에 걸리는 것이 없다: 이미지는 번들이 같은 오리진으로 내는 자산이고, 결과는 바이트로
// 업로드된다(blob: URL 을 `<img>` 에 싣지 않는다 — 미리보기는 `data:` 주소다, `Preview` 참조).
//
// 글꼴은 시스템 글꼴 이름만 쓴다. 이모지는 플랫폼의 색 이모지 글꼴이 그리고, 그것이 기기마다 다르다는 사실이
// 이 기능이 PNG 를 정본으로 삼는 이유다.
// =============================================================================

export interface AvatarLayer {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly size: number;
}

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

/** 이 알파(0~255)보다 옅은 픽셀은 잉크 경계에 넣지 않는다(글꼴이 남기는 아주 옅은 번짐). */
const INK_EDGE_ALPHA = 8;

function newLayer(size: number): AvatarLayer | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  // CPU 캔버스: GPU 래스터화의 기기별 차이를 줄이고, 읽기가 잦은 표본에도 맞다.
  const context = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  return context === null ? null : { canvas, context, size };
}

interface InkBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function inkBox(context: CanvasRenderingContext2D, size: number): InkBox | null {
  const { data } = context.getImageData(0, 0, size, size);
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if ((data[(y * size + x) * 4 + 3] ?? 0) < INK_EDGE_ALPHA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function drawEmoji(
  context: CanvasRenderingContext2D,
  size: number,
  text: string,
  font: string,
  offsetX: number,
  offsetY: number
): void {
  context.font = font;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, size / 2 + offsetX, size / 2 + offsetY);
}

/** 이모지를 그린다. 먼저 빈 층에 그려 잉크 경계를 읽고, 그 상자의 중심이 층의 중심이 되게 옮겨 그린다. */
function paintEmoji(layer: AvatarLayer, text: string, font: string): boolean {
  const probe = newLayer(layer.size);
  if (probe === null) return false;
  drawEmoji(probe.context, layer.size, text, font, 0, 0);
  const box = inkBox(probe.context, layer.size);
  probe.canvas.width = 0;
  probe.canvas.height = 0;
  if (box === null) return false; // 글꼴에 없는 글자: 아무것도 그려지지 않았다.
  const dx = Math.round(layer.size / 2 - (box.minX + box.maxX + 1) / 2);
  const dy = Math.round(layer.size / 2 - (box.minY + box.maxY + 1) / 2);
  drawEmoji(layer.context, layer.size, text, font, dx, dy);
  return true;
}

const artCache = new Map<AvatarPresetId, Promise<HTMLImageElement | null>>();

function loadArt(art: AvatarPresetId): Promise<HTMLImageElement | null> {
  let pending = artCache.get(art);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const image = new Image();
        image.src = KOMETTO_EXPRESSION_ASSETS[art];
        await image.decode();
        return image;
      } catch {
        // 받지 못한 자산은 다음 호출이 다시 시도하게 캐시에서 뺀다.
        artCache.delete(art);
        return null;
      }
    })();
    artCache.set(art, pending);
  }
  return pending;
}

async function paintArt(layer: AvatarLayer, art: AvatarPresetId, crop: SquareCrop): Promise<boolean> {
  const image = await loadArt(art);
  if (image === null || image.naturalWidth === 0) return false;
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  layer.context.imageSmoothingEnabled = true;
  layer.context.imageSmoothingQuality = "high";
  layer.context.drawImage(
    image,
    crop.x * side,
    crop.y * side,
    crop.size * side,
    crop.size * side,
    0,
    0,
    layer.size,
    layer.size
  );
  return true;
}

function toPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        if (blob === null) {
          resolve(null);
          return;
        }
        blob.arrayBuffer().then(
          (buffer) => resolve(new Uint8Array(buffer)),
          () => resolve(null)
        );
      }, "image/png");
    } catch {
      resolve(null);
    }
  });
}

/** 테스트 전용: 받아 둔 코메토 그림을 비운다. */
export function resetAvatarArtCacheForTests(): void {
  artCache.clear();
}

export const canvasAvatarPorts: AvatarCanvasPorts<AvatarLayer> = {
  createLayer: newLayer,

  fillBackground(layer, hex) {
    layer.context.fillStyle = hex;
    layer.context.fillRect(0, 0, layer.size, layer.size);
  },

  async paintForeground(layer, foreground: AvatarForeground) {
    switch (foreground.kind) {
      case "emoji":
        return paintEmoji(layer, foreground.text, `${foreground.fontPx}px ${EMOJI_FONT}`);
      case "art":
        return paintArt(layer, foreground.art, foreground.crop);
    }
  },

  readPixels(layer) {
    try {
      return layer.context.getImageData(0, 0, layer.size, layer.size).data;
    } catch {
      return null;
    }
  },

  toPng: (layer) => toPng(layer.canvas),

  release(layer) {
    // 캔버스 메모리를 바로 놓는다(Safari 는 놓지 않은 캔버스를 오래 쥔다).
    layer.canvas.width = 0;
    layer.canvas.height = 0;
  },
};
