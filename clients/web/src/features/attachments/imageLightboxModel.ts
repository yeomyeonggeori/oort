import {
  showsInlinePreview,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";

export type ImageLightboxViewState =
  | "empty"
  | "loading"
  | "ready"
  | "error"
  | "offline";

/** 라이트박스에 들어갈 수 있는 것은 타임라인에서 실제로 펴는 안전한 이미지뿐이다. */
export function lightboxAttachments(
  attachments: MessageAttachment[]
): MessageAttachment[] {
  return attachments.filter(showsInlinePreview);
}

/**
 * 화면 상태 한 벌. 캐시된 이미지는 연결이 끊겨도 남겨 둔다(P15). 바이트가 없을
 * 때만 offline이 loading/error를 대신해 지금 할 수 있는 일이 없음을 말한다.
 */
export function imageLightboxViewState({
  hasImage,
  previewStatus,
  offline,
}: {
  hasImage: boolean;
  previewStatus: "loading" | "ready" | "failed";
  offline: boolean;
}): ImageLightboxViewState {
  if (!hasImage) return "empty";
  if (previewStatus === "ready") return "ready";
  if (offline) return "offline";
  return previewStatus === "failed" ? "error" : "loading";
}

/** 왼쪽/오른쪽 화살표는 한 메시지의 이미지 안에서 순환한다. */
export function nextImageLightboxIndex(
  current: number,
  count: number,
  key: string
): number | null {
  if (count <= 0 || current < 0 || current >= count) return null;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  return null;
}

/** 비동기 작업 상태를 현재 선택이 아니라 시작한 첨부 ID에 귀속한다. */
export function updateAttachmentIdSet(
  current: ReadonlySet<string>,
  attachmentId: string,
  present: boolean
): Set<string> {
  const next = new Set(current);
  if (present) next.add(attachmentId);
  else next.delete(attachmentId);
  return next;
}
