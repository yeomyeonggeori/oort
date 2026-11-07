import type { DiskImage } from "@momo/core/features/expressions/diskCache";

// 데이터 주소 ↔ 바이트, sha256. 앱은 그림을 데이터 주소로 그린다(CSP `img-src data:`, ADR-0218 §14 M2.3).

const PNG_PREFIX = "data:image/png;base64,";
const GIF_PREFIX = "data:image/gif;base64,";

/** `data:image/(png|gif);base64,…` → 받은 그대로의 바이트. 다른 모양이면 `null`. */
export function parseImageDataUrl(src: string): DiskImage | null {
  const mime = src.startsWith(PNG_PREFIX) ? "image/png" : src.startsWith(GIF_PREFIX) ? "image/gif" : null;
  if (mime === null) return null;
  let binary: string;
  try {
    binary = atob(src.slice(mime === "image/png" ? PNG_PREFIX.length : GIF_PREFIX.length));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes: bytes.buffer, mime };
}

/** 바이트 → 데이터 주소(`FileReader`: 네트워크로 받은 그림을 데이터 주소로 만드는 길과 같은 길이다). */
export function bytesToDataUrl(image: DiskImage): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (reader.result instanceof ArrayBuffer || reader.result === null ? reject(new Error("image")) : resolve(reader.result));
    reader.onerror = () => reject(new Error("image"));
    reader.readAsDataURL(new Blob([image.bytes], { type: image.mime }));
  });
}

/** 소문자 hex sha256. `crypto.subtle`이 없으면(보안 맥락이 아니다) 던진다 — 호출부는 디스크를 쓰지 않는다. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error("crypto.subtle unavailable");
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** 이 환경에서 sha256을 잴 수 있는가(못 재면 디스크 저장소를 켜지 않는다: 무결성을 확인할 수 없는 캐시는 두지 않는다). */
export function canVerifyImages(): boolean {
  return globalThis.crypto?.subtle !== undefined;
}
