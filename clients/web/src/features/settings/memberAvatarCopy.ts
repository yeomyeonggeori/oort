import { ApiError } from "@momo/core/lib/api";
import {
  MEMBER_AVATAR_MAX_BYTES,
  MEMBER_AVATAR_MIMES,
} from "@momo/core/lib/api";

// 내 프로필 사진(ADR-0161 증보 2026-10-01, #3277)의 말: 서버를 부르기 전의 검사와
// 서버가 돌려주는 코드별 합니다체 문구. 화면은 이 모듈이 돌려준 문장만 그린다.

/** 파일을 고른 직후, 서버를 부르기 전에 거른다. 통과하면 `null`. */
export function memberAvatarPickError(file: {
  type: string;
  size: number;
}): string | null {
  if (!(MEMBER_AVATAR_MIMES as readonly string[]).includes(file.type)) {
    return "PNG, JPG, GIF, WebP 이미지만 올릴 수 있습니다.";
  }
  if (file.size <= 0) return "비어 있는 파일입니다. 다른 이미지를 골라 주세요.";
  if (file.size > MEMBER_AVATAR_MAX_BYTES) {
    return "프로필 사진은 5MB까지 올릴 수 있습니다.";
  }
  return null;
}

const GENERIC = "프로필 사진을 올리지 못했습니다. 잠시 뒤에 다시 시도해 주세요.";

/** 업로드·완료 단계의 서버 오류를 사람 말로. */
export function memberAvatarUploadError(error: unknown): string {
  if (!(error instanceof ApiError)) return GENERIC;
  switch (error.status) {
    case 413:
      return "이미지가 너무 큽니다. 5MB 이하로 줄여서 올려 주세요.";
    case 422:
      return "이 이미지는 사용할 수 없습니다. 열 수 있는 이미지이고 가로세로 4096px 이하인지 확인해 주세요.";
    case 409:
      return "파일 형식이 맞지 않거나 그사이 다른 사진으로 바뀌었습니다. 이미지를 다시 골라 주세요.";
    case 429:
      return "프로필 사진을 너무 자주 바꿨습니다. 잠시 뒤에 다시 시도해 주세요.";
    default:
      return GENERIC;
  }
}

export function memberAvatarRemoveError(): string {
  return "프로필 사진을 지우지 못했습니다. 연결을 확인하고 다시 시도해 주세요.";
}
