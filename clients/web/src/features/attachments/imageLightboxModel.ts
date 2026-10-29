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

const SENT_SAME_YEAR = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const SENT_OTHER_YEAR = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * 위 왼쪽 칩의 둘째 줄: 보낸 날짜·시각(「10월 29일 오후 2:43」). 올해가 아니면 연도가 앞에 붙는다.
 * 시각을 모르면(아직 서버 시각이 없는 echo 행) `null`이고, 칩은 그 줄을 그리지 않는다. 시각을 지어내지 않는다.
 */
export function lightboxSentAtLabel(
  atMs: number | null | undefined,
  nowMs: number = Date.now()
): string | null {
  if (atMs === null || atMs === undefined || !Number.isFinite(atMs)) return null;
  const sameYear = new Date(atMs).getFullYear() === new Date(nowMs).getFullYear();
  return (sameYear ? SENT_SAME_YEAR : SENT_OTHER_YEAR).format(new Date(atMs));
}

/**
 * 위 왼쪽 칩의 두 줄. 첫 줄은 **보낸 사람**(굵게), 둘째 줄은 날짜·시각이다. 파일 이름은 칩의 툴팁과 보조 글(대화상자
 * 이름)로 내려갔다. 보낸 사람을 모르면 첫 줄이 파일 이름이다: 칩이 빈 채로 서지 않는다.
 */
export function lightboxInfoLines({
  senderName,
  sentAtMs,
  fileName,
  nowMs,
}: {
  senderName?: string | null | undefined;
  sentAtMs?: number | null | undefined;
  fileName: string;
  nowMs?: number;
}): { primary: string; secondary: string | null; fileName: string } {
  const sender = senderName?.trim() ?? "";
  return {
    primary: sender === "" ? fileName : sender,
    secondary: lightboxSentAtLabel(sentAtMs, nowMs),
    fileName,
  };
}

/** 아래 가운데 캡션. 두 장 이상일 때만 선다: 「3장 중 2번」. */
export function lightboxPositionLabel(index: number, count: number): string {
  return `${count}장 중 ${index + 1}번`;
}
