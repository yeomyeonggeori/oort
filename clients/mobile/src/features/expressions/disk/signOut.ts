import {
  compartmentNamesSync,
  destroyCompartmentSync,
  removeOrphansSync,
} from './fileBackend';
import {bumpSessionGeneration} from './generation';

// =============================================================================
// 세션이 끝나는 자리에서 이모티콘 그림의 기기 캐시를 모두 지운다 (ADR-0218 §14 M2.5, #5455 B-2).
//
// 로그아웃(`signOut`)·토큰 만료·복원 거절은 **`ExpressionProvider` 의 `dispose` 에만 걸지 않는다**: 만료된 채 앱이 켜져 로그인 화면으로 가면 provider 가 뜨지 않아 `dispose` 가
// 돌지 않는다. 그래서 `SessionProvider` 의 정리 효과와 `leftSession` 효과가 이 함수를 부른다(`session/useSession.tsx`). 모든 보관 칸은 폴더째 지운다.
// 동기다(`clearMemberAvatarCache` 처럼 부른 순간 사라진다). 어떤 실패도 던지지 않는다: 지우는 일이 로그아웃을 막으면 안 된다. 잎이다.
// =============================================================================

/** 모든 보관 칸과, 앱이 죽어 남은 옛 세션 폴더·받기 임시 파일을 지운다(세대는 올리지 않는다). */
export function destroyExpressionDisks(): void {
  try {
    for (const name of compartmentNamesSync()) destroyCompartmentSync(name);
    removeOrphansSync();
  } catch {
    // 못 지운 것은 다음 시작 청소가 다시 지운다.
  }
}

/**
 * 세션이 끝났다: **세대를 먼저 올리고** 모든 칸을 지운다. 로그아웃과 겹쳐 늦게 닿은 저장은 세대가 달라 칸을 되살리지 못하고, 되살렸더라도 쓴 직후 그 칸째 다시 지운다(저장소가 본다).
 * 새 저장소가 이미 만들어진 뒤 도는 정리(계정 교체)는 이 함수가 아니라 `destroyExpressionDisks` 를 쓴다 — 새 저장소의 세대를 올려 막지 않는다.
 */
export function forgetExpressionDisk(): void {
  try {
    bumpSessionGeneration();
  } catch {
    // 세대는 숫자 하나라 던질 일이 없다.
  }
  destroyExpressionDisks();
}
