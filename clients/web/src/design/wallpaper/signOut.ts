import { defaultPhotoStore } from "./idb";

// =============================================================================
// 로그아웃·세션 경계에서 배경 사진을 지운다 (ADR-0189 증보 2 D7 → 증보 3 D4, AP-4 #4191).
//
// 사진은 **사람의 것**이다. 공용 PC에서 로그아웃한 다음 사람의 화면에 앞 사람의 사진이 남으면 안 된다.
// 그래서 `lib/session.ts`의 `clearSession`이 이 함수를 한 줄로 부른다. `clearSession`은 로그아웃(`logout`),
// 죽은 토큰으로 복원 실패, 다른 탭의 로그아웃, 만료가 모두 지나가는 자리라 「세션 경계」가 한 곳이다.
// 같은 사람이 워크스페이스를 바꾸는 것은 경계가 아니다(`clearSession`을 지나지 않는다). 오프라인 시작도
// 경계가 아니다(`restoreSession`은 네트워크가 답하지 않으면 자격을 지우지 않는다).
//
// 이 파일은 **잎**이다. 세션 저장소가 외양 저장소(`@/design/theme`)나 Tauri 모듈 사슬을 끌고 오지 않게,
// 바이트를 지우는 IndexedDB 잎(`idb.ts`)과 구독자 목록만 든다. 외양 레코드의 참조(`wallpaper: {kind: "image"}`)를
// 「없음」으로 돌리는 일은 스토어(`store.ts`)가 이 신호를 듣고 한다. 스토어가 아직 올라오지 않은 경로(부팅 중
// 복원 실패)에서는 바이트만 먼저 지워지고, 참조는 다음 시작 때 「사진이 없으면 없음으로」 규칙이 거둔다.
// 단색·기본 제공은 취향이라 남긴다.
// =============================================================================

const listeners = new Set<() => void>();

/** 스토어가 로그아웃 신호를 듣는다. 해제 함수를 돌려준다. */
export function onWallpaperSignOut(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 어떤 실패도 던지지 않는다: 지우는 일이 로그아웃을 막으면 안 된다. */
export function forgetWallpaperOnSignOut(): void {
  try {
    void defaultPhotoStore()
      .clear()
      .catch(() => undefined);
  } catch {
    // 저장소가 없는 환경(시험의 node)에서는 지울 것이 없다.
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 구독자 하나의 실패가 다른 구독자와 로그아웃을 막지 않는다.
    }
  }
}
