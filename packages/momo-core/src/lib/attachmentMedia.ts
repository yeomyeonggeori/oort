import type { AttachmentMedia } from "./api";

// =============================================================================
// 영상 첨부 요약 `media` 를 받는 쪽의 거름 (openapi `AttachmentMedia`, ADR-0151 증보 5 D5, #4673).
//
// 서버는 이 숫자들을 **보내는 기기의 선언으로 저장하고 범위만 검사한다**(영상을 열어 보지 않는다). 받는 쪽은 그 숫자로 카드의
// 크기와 길이 표기를 그리므로, 칸을 그리기 전에 같은 범위를 한 번 더 지킨다. 어긋난 요약은 **요약만** 버린다 — 첨부(파일 카드·
// 바이트로 가는 길)는 남아야 하고, 길이를 모르는 영상 카드는 그대로 설 수 있다.
//
// 이 모듈은 순수하다(플랫폼·네트워크 없음). 실시간 프레임(`attachmentsFromWire`)과 화면 쪽 읽기(`attachmentMediaOf`)가
// 같은 판정을 쓴다 — REST 페이지는 응답을 그대로 통과시키므로 화면이 읽을 때 다시 거르지 않으면 두 길이 갈라진다.
// =============================================================================

/** openapi `AttachmentMedia.durationMs` 의 최댓값(24시간). */
export const MAX_VIDEO_DURATION_MS = 86_400_000;

/** openapi `AttachmentMedia.width`·`height` 의 최댓값. */
export const MAX_VIDEO_DIMENSION = 16_384;

function boundedInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : undefined;
}

/**
 * 와이어의 `media` → 화면이 믿어도 되는 요약. 하나라도 어긋나면 `undefined`(첨부는 호출한 쪽이 남긴다).
 * 문서에 있는 다섯 키만 옮긴다 — 모르는 키가 화면까지 따라오지 않는다.
 */
export function attachmentMediaFromWire(value: unknown): AttachmentMedia | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  if (source.kind !== "video") return undefined;
  const durationMs = boundedInteger(source.durationMs, MAX_VIDEO_DURATION_MS);
  const width = boundedInteger(source.width, MAX_VIDEO_DIMENSION);
  const height = boundedInteger(source.height, MAX_VIDEO_DIMENSION);
  if (durationMs === undefined || width === undefined || height === undefined) return undefined;
  if (typeof source.hasPoster !== "boolean") return undefined;
  return { kind: "video", durationMs, width, height, hasPoster: source.hasPoster };
}
