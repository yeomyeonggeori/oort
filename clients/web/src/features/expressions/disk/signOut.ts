import { bumpSessionGeneration } from "./generation";
import { defaultExpressionDiskBackend } from "./idb";
import type { ExpressionDiskBackend } from "@momo/core/features/expressions/diskCache";

// =============================================================================
// 세션이 끝나는 자리에서 이모티콘 그림의 기기 캐시를 모두 지운다 (ADR-0218 §14 M2.5, #5455 B-1).
//
// `lib/session.ts`의 `clearSession`이 한 줄로 부른다(배경 사진의 `forgetWallpaperOnSignOut`과 같은 자리·같은 모양). `clearSession`은 로그아웃,
// 죽은 토큰으로 복원 실패, 다른 탭의 로그아웃, 만료가 모두 지나가는 자리라 「세션 경계」가 한 곳이다. 네트워크가 답하지 않아 복원하지 못한 경우는
// 자격을 지우지 않으므로 여기를 지나지 않고 보관 칸도 그대로다.
//
// 순서가 중요하다: **세대를 먼저 동기로 올리고** 삭제는 그 뒤 비동기로 한다. 다른 탭의 진행 중 다운로드가 지운 뒤에 칸을 되살려 쓰려 해도 세대가
// 달라 쓰지 못한다(저장소가 쓰기 직전과 쓴 직후에 본다). 멱등이다(다른 탭도 `adoptExternal(null)`→만료 효과→자기 `clearSession`을 지난다).
// 어떤 실패도 던지지 않는다: 지우는 일이 로그아웃을 막으면 안 된다. 이 파일은 잎이다.
// =============================================================================

/** 모든 보관 칸을 지운다(던지지 않는다). */
export async function destroyAllExpressionDisks(backend: ExpressionDiskBackend): Promise<void> {
  try {
    for (const name of await backend.list()) await backend.destroy(name).catch(() => undefined);
  } catch {
    // 못 지운 칸은 다음 시작 청소가 다시 지운다.
  }
}

export function forgetExpressionDiskOnSignOut(backend?: ExpressionDiskBackend): Promise<void> {
  try {
    bumpSessionGeneration();
    return destroyAllExpressionDisks(backend ?? defaultExpressionDiskBackend());
  } catch {
    return Promise.resolve();
  }
}
