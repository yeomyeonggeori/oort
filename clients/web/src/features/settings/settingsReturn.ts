import type { NavigateFunction } from "react-router-dom";

// =============================================================================
// 설정에서 나가기 (#2938 ③).
//
// 「앱으로 돌아가기」와 Esc는 한 칸 뒤로다(#1867: 설정은 원래 자리로 돌아간다).
// 그런데 설정이 앱의 **첫 항목**이면(딥링크·온보딩 뒤·주소로 바로 연 재진입을
// 닫은 뒤) 한 칸 뒤는 앱 밖이거나 아무 데도 아니다. 그때는 홈으로 바꿔 끼운다.
//
// 라우터(HashRouter)는 자기가 쌓은 항목에 `idx`를 적는다. 첫 항목은 0이다.
// 창의 히스토리가 한 칸뿐이어도 뒤가 없다.
// =============================================================================

export function settingsHasInAppBack(): boolean {
  if (window.history.length <= 1) return false;
  const state: unknown = window.history.state;
  const idx =
    state !== null && typeof state === "object" ? (state as { idx?: unknown }).idx : undefined;
  return idx !== 0;
}

/** 「앱으로 돌아가기」·Esc. */
export function leaveSettings(navigate: NavigateFunction): void {
  if (settingsHasInAppBack()) {
    navigate(-1);
    return;
  }
  navigate("/", { replace: true });
}
