import { PNG_SIGNATURE, pngCrc32 } from "../avatarPng";

// 아바타 편집기 시험용 조각 (#4261). 시험만 읽는다: 코어와 웹의 시험이 같은 픽스처를 쓴다.

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(body, 8);
  view.setUint32(8 + body.length, pngCrc32(out, 4, 8 + body.length));
  return out;
}

/**
 * 구조만 맞는 PNG(시그니처, IHDR, IDAT, IEND, CRC 모두 정확하다). 픽셀을 디코드할 수는 없다:
 * 그림은 진짜 캔버스를 쓰는 브라우저 시험이 맡고, 여기는 바이트의 구조와 흐름을 시험한다.
 * `payload` 를 달리하면 서로 다른 PNG 가 되어, 「이 바이트가 그 바이트인가」를 가릴 수 있다.
 */
export function buildPng(options: {
  width?: number;
  height?: number;
  payload?: readonly number[] | Uint8Array;
} = {}): Uint8Array {
  const { width = 512, height = 512, payload = [1, 2, 3, 4] } = options;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // 비트 깊이
  header[9] = 6; // RGBA
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", Uint8Array.from(payload)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export type RgbaPart = { readonly rgb: readonly [number, number, number]; readonly alpha?: number; readonly count: number };

/**
 * 표본 픽셀 버퍼(RGBA). `parts` 를 앞에서부터 채우고 나머지는 투명으로 둔다.
 * 판정 시험이 「이 면적의 이 색」을 그대로 적을 수 있게 한다.
 */
export function rgbaBuffer(totalPixels: number, parts: readonly RgbaPart[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(totalPixels * 4);
  let pixel = 0;
  for (const part of parts) {
    // 소수 개수는 타입 배열 바깥 칸을 조용히 건너뛴다. 시험이 의도와 다른 버퍼로 통과하지 않게 막는다.
    if (!Number.isInteger(part.count) || part.count < 0) throw new Error(`rgbaBuffer: count must be a whole number, got ${part.count}`);
    if (pixel + part.count > totalPixels) throw new Error("rgbaBuffer: parts exceed the buffer");
    for (let index = 0; index < part.count; index += 1) {
      const at = (pixel + index) * 4;
      out[at] = part.rgb[0];
      out[at + 1] = part.rgb[1];
      out[at + 2] = part.rgb[2];
      out[at + 3] = part.alpha ?? 255;
    }
    pixel += part.count;
  }
  return out;
}
