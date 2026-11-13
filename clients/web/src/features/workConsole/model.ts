export {
  workExecutionLocation as workConsoleLocation,
  type WorkExecutionLocation as WorkConsoleLocation,
  type WorkExecutionLocationKey as WorkConsoleLocationKey,
} from "@momo/core/features/work/workLocation";

/** 한 작업 세션을 새로고침·붙여넣기에도 살아 있는 상세 주소로 만든다. */
export function workConsoleSessionPath(sessionId: string): string {
  return `/work?session=${encodeURIComponent(sessionId.toLowerCase())}`;
}

/**
 * 「작업」 목록이 세션 상세로 나갈 때 기억해 두는 자리: 열었던 줄과 목록 스크롤.
 * 돌아온 목록이 한 번만 되찾고 비운다(메모리뿐 — 새로고침하면 처음 자리다).
 */
let workReturnSpot: { rowId: string; scrollTop: number } | null = null;
export function rememberWorkReturnSpot(spot: { rowId: string; scrollTop: number }): void {
  workReturnSpot = spot;
}
export function takeWorkReturnSpot(): { rowId: string; scrollTop: number } | null {
  const spot = workReturnSpot;
  workReturnSpot = null;
  return spot;
}
