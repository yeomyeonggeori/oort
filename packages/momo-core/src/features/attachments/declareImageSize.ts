import { setAttachmentMedia } from "../../lib/api";
import { canDeclareImageSize, imageSizeDeclaration } from "../../lib/attachmentMedia";

// =============================================================================
// 올린 사진·GIF 의 가로세로를 서버에 선언하는 보내는 쪽의 한 걸음 (ADR-0151 증보 9 I7, #5469).
//
// 웹과 폰이 같은 규칙으로 부른다: 「`complete` 가 돌아온 **뒤**, 그 첨부를 보내기 가능으로 바꾸기 **전에**」. 서버는 업로더 본인의
// `complete` 이고 아직 메시지에 안 묶인 첨부에만 쓰므로, 보내기 가능으로 바꾼 뒤에 부르면 빠른 전송이 먼저 묶어 이 호출이 조용히
// 404 가 된다. 호출처가 이 함수의 끝을 기다린 다음 `completeUpload` 를 한다.
//
// **이 호출은 덤이다 — 보내기를 막지 않는다.** 던지지 않고, 재기·보내기를 합친 예산(`DECLARE_IMAGE_SIZE_BUDGET_MS`)이 넘으면 기다리기를
// 그만둔다(그 PUT 은 뒤에서 끝날 수 있고, 메시지가 이미 나갔으면 서버가 같은 404 로 돌려주는 것을 아무도 읽지 않는다). 요약 없이 간 사진은
// 받는 쪽이 지금처럼 기기 기억을 쓴다.
//
// 가로세로는 호출처가 넘기는 `measure` 가 잰다: **받는 쪽이 같은 바이트에서 재는 것과 같은 자**여야 한다(웹 `createImageBitmap`, 폰
// `Image.getSize`) — 표시되는 크기(EXIF 방향 적용)가 아니면 세로로 찍은 사진의 칸이 가로로 선다. 재는 일은 업로드와 **함께** 시작해 두면
// 여기서는 이미 끝나 있다.
// =============================================================================

/** 재기와 보내기를 합친, 보내기 가능으로 바꾸기 전에 기다리는 한도(ms). 선언은 덤이라 오래 붙들지 않는다. */
export const DECLARE_IMAGE_SIZE_BUDGET_MS = 4_000;

export type DeclareImageSizeOutcome =
  /** 서버가 요약을 저장했다. */
  | "declared"
  /** 선언할 것이 없다: 닫힌 목록 밖의 종류, 재지 못했거나 범위 밖의 크기. 아무것도 보내지 않았다. */
  | "skipped"
  /** 보냈으나 서버가 받지 못했거나(오프라인·거절·429) 예산이 넘었다. 요약 없이 간다. */
  | "failed";

export interface DeclareImageSizeInput {
  workspaceId: string;
  channelId: string;
  attachmentId: string;
  /** 첨부의 선언 종류(서버의 저장된 mime 과 같다). */
  mime: string;
  /** 보낼 파일의 표시 크기. 못 재면 `null`(또는 던진다 — 둘 다 「선언하지 않음」이다). */
  measure: () => Promise<{ width: number; height: number } | null>;
  /** 시험이 서버 호출을 갈아 끼우는 자리. */
  put?: typeof setAttachmentMedia;
  /** 시험이 예산을 줄이는 자리. */
  budgetMs?: number;
}

export async function declareImageSize(input: DeclareImageSizeInput): Promise<DeclareImageSizeOutcome> {
  if (!canDeclareImageSize(input.mime)) return "skipped";
  const put = input.put ?? setAttachmentMedia;
  const budgetMs = input.budgetMs ?? DECLARE_IMAGE_SIZE_BUDGET_MS;

  const work = (async (): Promise<DeclareImageSizeOutcome> => {
    let size: { width: number; height: number } | null;
    try {
      size = await input.measure();
    } catch {
      return "skipped";
    }
    const body = imageSizeDeclaration(size);
    if (body === null) return "skipped";
    try {
      await put(input.workspaceId, input.channelId, input.attachmentId, body);
      return "declared";
    } catch {
      return "failed";
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<DeclareImageSizeOutcome>((resolve) => {
    timer = setTimeout(() => resolve("failed"), budgetMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
