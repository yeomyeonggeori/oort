import { ApiError } from "@momo/core/lib/api";
import {
  MEMBER_AVATAR_MAX_BYTES,
  MEMBER_AVATAR_MIMES,
} from "@momo/core/lib/api";
import { AVATAR_EDITOR_COPY } from "@momo/core/features/workspace/avatarEditor";

// 내 프로필 사진(ADR-0161 증보 2026-10-01, #3277)의 말: 서버를 부르기 전의 검사와
// 서버가 돌려주는 코드별 해요체 문구. 화면은 이 모듈이 돌려준 문장만 그린다.

/** 파일을 고른 직후, 서버를 부르기 전에 거른다. 통과하면 `null`. */
export function memberAvatarPickError(file: {
  type: string;
  size: number;
}): string | null {
  if (!(MEMBER_AVATAR_MIMES as readonly string[]).includes(file.type)) {
    return "PNG, JPG, GIF, WebP 이미지만 올릴 수 있어요.";
  }
  if (file.size <= 0) return "비어 있는 파일이에요. 다른 이미지를 골라 주세요.";
  if (file.size > MEMBER_AVATAR_MAX_BYTES) {
    return "프로필 사진은 5MB까지 올릴 수 있어요.";
  }
  return null;
}

const GENERIC = "프로필 사진을 올리지 못했어요. 잠시 뒤에 다시 시도해 주세요.";

/** 서버가 사진에 대해 말하는 4096px 상한(`MAX_MEMBER_AVATAR_DIMENSION`). 클라가 올리기 전에 먼저 거르는 데도 쓴다. */
export const MEMBER_AVATAR_MAX_SIDE = 4096;

/**
 * 업로드·완료 단계의 서버 오류를 사람 말로.
 *
 * `kind` 가 `drawn` 이면 우리가 그려 올린 512px PNG(이모지·코메토)라서 「프로필 사진」·「5MB」·「4096px」 문장이 맞지 않는다
 * (design-review M-4): 한도 초과와 형식 거절은 우리 PNG 에서는 나올 수 없으므로 일반 문장으로 읽고, 너무 잦은 변경만 따로 말한다.
 */
export function memberAvatarUploadError(
  error: unknown,
  kind: "photo" | "drawn" = "photo"
): string {
  if (kind === "drawn") {
    return error instanceof ApiError && error.status === 429
      ? AVATAR_EDITOR_COPY.uploadTooOften
      : AVATAR_EDITOR_COPY.uploadFailed;
  }
  if (!(error instanceof ApiError)) return GENERIC;
  switch (error.status) {
    case 413:
      return "프로필 사진은 5MB까지 올릴 수 있어요.";
    case 422:
      return AVATAR_EDITOR_COPY.photoUnusable;
    case 409:
      return "파일 형식이 맞지 않거나 그사이 다른 사진으로 바뀌었어요. 이미지를 다시 골라 주세요.";
    case 429:
      return "프로필 사진을 너무 자주 바꿨어요. 잠시 뒤에 다시 시도해 주세요.";
    default:
      return GENERIC;
  }
}

/** 「기본으로 되돌리기」(`removeMyAvatar`)의 실패. 문장은 코어에 있어 폰이 같은 말을 한다. */
export function memberAvatarRemoveError(): string {
  return AVATAR_EDITOR_COPY.resetFailed;
}
