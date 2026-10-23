// =============================================================================
// 아바타 PNG 검사 (#4261): 올리기 직전에 「이 바이트가 정말 우리가 그린 정사각 PNG인가」를 본다.
//
// 이모지·코메토 아바타는 클라이언트가 그린 PNG 한 장이 **정본**이다. 이모지는 기기마다 다르게 그려지
// 므로(글꼴이 다르다) 서버가 받는 것도, 다른 멤버가 보는 것도 그 PNG 바이트다. 그 약속이 깨지는
// 길은 둘이다: 그리는 쪽이 PNG가 아닌 것(SVG·빈 응답)이나 엉뚱한 크기를 내놓는 것, 올리는 쪽이
// 그림 대신 다른 것을 올리는 것. 이 파일은 앞쪽을 막는다. 디코더가 아니라 구조 검사다:
//
//   · 시그니처 8바이트
//   · 첫 청크가 IHDR(길이 13)이고 CRC가 맞다 → 너비·높이를 믿을 수 있다
//   · 끝 청크가 IEND다 → 잘린 파일이 아니다
//
// 서버도 같은 것을 한다(매직 넘버·IHDR 크기, `member_avatar.rs`). 그래도 클라가 먼저 보는 이유는
// 올리기 전에 거절하면 시간당 20번인 업로드 한도(429)를 쓰지 않기 때문이다.
// =============================================================================

export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly byteLength: number;
}

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** PNG 청크의 CRC-32(종류 4바이트 + 본문). */
export function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) * 0x1000000 +
      (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0))) >>>
    0
  );
}

function isChunkType(bytes: Uint8Array, at: number, type: string): boolean {
  for (let offset = 0; offset < 4; offset += 1) {
    if (bytes[at + offset] !== type.charCodeAt(offset)) return false;
  }
  return true;
}

const IEND_CHUNK: readonly number[] = [
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

/**
 * PNG 구조가 온전하면 헤더의 값을, 아니면 `null`.
 * 너비·높이가 0이거나 2^31을 넘는 것(PNG 규격 밖)도 `null` 이다.
 */
export function inspectPng(bytes: Uint8Array): PngInfo | null {
  // 시그니처 8 + IHDR 청크 25(길이 4, 종류 4, 본문 13, CRC 4) + IEND 청크 12.
  if (bytes.length < 8 + 25 + 12) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  if (readUint32(bytes, 8) !== 13 || !isChunkType(bytes, 12, "IHDR")) return null;
  if (readUint32(bytes, 29) !== pngCrc32(bytes, 12, 29)) return null;
  const tail = bytes.length - IEND_CHUNK.length;
  for (let index = 0; index < IEND_CHUNK.length; index += 1) {
    if (bytes[tail + index] !== IEND_CHUNK[index]) return null;
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return null;
  return {
    width,
    height,
    bitDepth: bytes[24] ?? 0,
    colorType: bytes[25] ?? 0,
    byteLength: bytes.length,
  };
}
