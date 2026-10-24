import { ApiError } from "../../lib/api";

// 내 프로필 사진(ADR-0161 증보 2026-10-01, #3277)의 서버 오류 문구 — 폰(#4384)이 먼저 쓰고,
// 웹의 같은 문구(`clients/web/.../memberAvatarCopy.ts`)는 #4261 이 그 파일을 고치는 중이라 그
// 머지 뒤 이 모듈을 가리키게 옮긴다(미결, 같은 문장이라 어긋나면 시험이 잡는다).

const GENERIC = "프로필 사진을 올리지 못했어요. 잠시 뒤에 다시 시도해 주세요.";

/** 5MiB 상한(`MEMBER_AVATAR_MAX_BYTES`)을 넘었을 때. 서버 413 과 클라 사전 검사가 같은 문장이다. */
export const MEMBER_AVATAR_TOO_LARGE = "프로필 사진은 5MB까지 올릴 수 있어요.";

/** 업로드·완료 단계의 서버 오류를 사람 말로. */
export function memberAvatarUploadError(error: unknown): string {
  if (!(error instanceof ApiError)) return GENERIC;
  switch (error.status) {
    case 413:
      return MEMBER_AVATAR_TOO_LARGE;
    case 422:
      return "이 이미지는 사용할 수 없어요. 열 수 있는 이미지이고 가로세로 4096px 이하인지 확인해 주세요.";
    case 409:
      return "파일 형식이 맞지 않거나 그사이 다른 사진으로 바뀌었어요. 이미지를 다시 골라 주세요.";
    case 429:
      return "프로필 사진을 너무 자주 바꿨어요. 잠시 뒤에 다시 시도해 주세요.";
    default:
      return GENERIC;
  }
}

export function memberAvatarRemoveError(): string {
  return "프로필 사진을 지우지 못했어요. 연결을 확인하고 다시 시도해 주세요.";
}
