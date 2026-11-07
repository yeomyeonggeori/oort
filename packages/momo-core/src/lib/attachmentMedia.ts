import type { AttachmentMedia, ImageMedia, SetImageMediaBody } from "./api";

// =============================================================================
// 첨부 요약 `media` 를 받는 쪽의 거름 (openapi `AttachmentMedia`, ADR-0151 증보 5 D5 #4673 · 증보 9 #5469).
//
// 서버는 이 숫자들을 **보내는 기기의 선언으로 저장하고 범위만 검사한다**(영상도 사진도 열어 보지 않는다). 받는 쪽은 그 숫자로 카드·
// 칸의 크기와 길이 표기를 그리므로, 칸을 그리기 전에 같은 범위를 한 번 더 지킨다. 어긋난 요약은 **요약만** 버린다 — 첨부(파일 카드·
// 바이트로 가는 길)는 남아야 하고, 크기를 모르는 첨부는 그대로 설 수 있다.
//
// 요약은 둘이다: 영상(`kind: "video"`, 다섯 키)과 사진·GIF(`kind: "image"`, 세 키). **모르는 `kind` 는 요약만 버린다** — 앞으로 더해질
// 종류도, v0.1.42~v0.1.44 가 사진 요약을 만났을 때와 같은 길이다(그 판은 `kind !== "video"` 를 버렸다. 시험이 그 옛 거름을 고정해 둔다).
//
// 이 모듈은 순수하다(플랫폼·네트워크 없음). 실시간 프레임(`attachmentsFromWire`)과 화면 쪽 읽기(`attachmentMediaOf`·
// `attachmentImageSizeOf`)가 같은 판정을 쓴다 — REST 페이지는 응답을 그대로 통과시키므로 화면이 읽을 때 다시 거르지 않으면 두 길이
// 갈라진다.
// =============================================================================

/** openapi `VideoAttachmentMedia.durationMs` 의 최댓값(24시간). */
export const MAX_VIDEO_DURATION_MS = 86_400_000;

/** openapi `width`·`height` 의 최댓값. 영상과 사진이 한 숫자다(서버 `MEDIA_MAX_DIMENSION`, DB CHECK). */
export const MAX_VIDEO_DIMENSION = 16_384;

/** 사진·GIF 의 가로세로 최댓값 — 영상과 같은 숫자다. */
export const MAX_IMAGE_DIMENSION = MAX_VIDEO_DIMENSION;

/**
 * 서버가 가로세로를 받는 사진·GIF 종류(닫힌 목록, 서버 `IMAGE_MIMES`). 이 밖의 종류(HEIC·SVG·BMP 등)는 서버가 400 으로 돌려주므로
 * 보내는 쪽은 선언하지 않는다. 서버의 매직 판별이 아는 넷과 같다.
 */
export const IMAGE_MEDIA_MIMES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function boundedInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : undefined;
}

/**
 * 와이어의 `media` → 화면이 믿어도 되는 요약. 하나라도 어긋나면 `undefined`(첨부는 호출한 쪽이 남긴다).
 * 문서에 있는 키만 옮긴다 — 영상은 다섯, 사진은 셋이고 모르는 키가 화면까지 따라오지 않는다. 모르는 `kind` 는 `undefined` 다.
 */
export function attachmentMediaFromWire(value: unknown): AttachmentMedia | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const width = boundedInteger(source.width, MAX_IMAGE_DIMENSION);
  const height = boundedInteger(source.height, MAX_IMAGE_DIMENSION);
  if (width === undefined || height === undefined) return undefined;
  if (source.kind === "image") return { kind: "image", width, height };
  if (source.kind !== "video") return undefined;
  const durationMs = boundedInteger(source.durationMs, MAX_VIDEO_DURATION_MS);
  if (durationMs === undefined) return undefined;
  if (typeof source.hasPoster !== "boolean") return undefined;
  return { kind: "video", durationMs, width, height, hasPoster: source.hasPoster };
}

/** 이 종류의 파일에 가로세로를 선언할 수 있는가(서버의 닫힌 목록). 매개변수(`; charset=…`)와 대소문자는 보지 않는다. */
export function canDeclareImageSize(mime: unknown): boolean {
  if (typeof mime !== "string") return false;
  const essence = mime.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return IMAGE_MEDIA_MIMES.includes(essence);
}

/**
 * 잰 크기 → 서버에 보낼 선언. **받는 쪽과 같은 범위**(1~16,384)를 한 번 지키고, 정수가 아니면 반올림한다(재는 쪽이 점 단위일 수
 * 있다). 유한하지 않거나 범위 밖이면 `null` — 틀린 크기를 선언하느니 선언하지 않는다(요약 없이 가면 지금처럼 기기 기억을 쓴다).
 */
export function imageSizeDeclaration(
  size: { width: number; height: number } | null | undefined,
): SetImageMediaBody | null {
  if (size === null || size === undefined) return null;
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  if (
    boundedInteger(width, MAX_IMAGE_DIMENSION) === undefined ||
    boundedInteger(height, MAX_IMAGE_DIMENSION) === undefined
  ) {
    return null;
  }
  return { kind: "image", width, height };
}

/** `ImageMedia` 인가. */
export function isImageMedia(media: AttachmentMedia | undefined | null): media is ImageMedia {
  return media?.kind === "image";
}
