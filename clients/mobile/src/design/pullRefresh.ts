// =============================================================================
// 당겨서 새로고침의 순수 판정 (#3962). 화면도 햅틱도 모르는 값과 함수만 둔다:
// 거리 → 진행도, 재조회 결과가 실패인가.
//
// 시험은 이 파일을 직접 읽는다(`__tests__/pullRefreshLogic.test.ts`). 훅(`refresh.tsx`)은
// 이 판정에 스크롤 이벤트와 햅틱·접근성 낭독을 연결할 뿐이다.
// =============================================================================

/**
 * 당김 진행도 1 에 해당하는 거리(pt): 표준 `UIRefreshControl` 이 새로고침을 세우는 오프셋.
 *
 * **잰 값이다.** iPhone 16e 시뮬레이터(iOS 26.5, 390pt)에서 `cliclick` 으로 주입한 손가락 당김으로,
 * 표준 `RefreshControl` 의 `onRefresh` 가 불린 순간의 `contentOffset.y` 를 읽었다: 같은 당김을 세 번
 * 되풀이해 세 번 모두 -147.3 이었다(`measure/` 계측, PR 본문). 그리고 이 컨트롤은 손가락이 **아직
 * 닿아 있는 채로** 그 거리를 넘는 순간 `onRefresh` 를 부른다(놓을 때가 아니다). 위성이 궤도에 다 나오는
 * 때(진행도 1)가 곧 새로고침이 서는 때이도록 이 값에 맞췄다. 기기·OS 가 바뀌어 이 값이 어긋나도
 * 시각(위성이 조금 일찍·늦게 다 나옴)만 어긋나고 새로고침 자체는 컨트롤이 정한다. 값은 위성 스케일에만
 * 쓰이고 트리거를 정하지 않는다. 배포 타깃(iOS 16.4)과 다른 OS 에서의 값은 재지 못했다.
 */
export const PULL_TRIGGER = 147;

/** 당김 머리(로더가 서는 띠)의 높이(pt). 새로고침 중 `UIRefreshControl` 이 열어 두는 자리(잰 값 약 60)와 맞춘다. */
export const PULL_HEADER_HEIGHT = 64;

/** 로더 한 변(pt). 당김 머리 안에서 display 마크(꼬리 점 포함)가 읽히는 첫 크기다. */
export const PULL_LOADER_SIZE = 40;

/**
 * 당김이 걸리는 목록의 **내용 컨테이너**에 줄 스타일(`contentContainerStyle`): 내용이 뷰포트를 채운다.
 *
 * 내용이 뷰포트보다 짧으면 iOS(RN Fabric)에서 **내용 밖의 빈 자리를 눌러 끄는 제스처가 시작되지 않는다**
 * (그 터치는 스크롤뷰 자신이 아니라 그 부모 뷰가 받는다: `RCTScrollViewComponentView.betterHitTest`).
 * 짧은 목록과 빈 상태에서 엄지가 놓이는 아래쪽 빈 자리가 먹통이 된다. 내용 컨테이너가 뷰포트를 채우면
 * 빈 자리도 내용이라 어디서나 당겨진다. 실측(iPhone 16e, iOS 26.5): 두 줄짜리 목록과 빈 상태에서 아래 빈 자리
 * (화면 y 500)를 당기면 아무 일도 없고, `flexGrow: 1` 이면 선다(`measure/pullRefresh.tsx` `PULL-REFRESH-SHORT[-DEAD]`).
 * 목록 내용은 그대로 위에서부터 쌓인다.
 */
export const PULL_FILL = {flexGrow: 1} as const;

/** 스크롤 오프셋(위로 넘치면 음수) → 당김 진행도 0~1. */
export function pullProgress(offsetY: number): number {
  if (!(offsetY < 0)) return 0;
  return Math.min(1, -offsetY / PULL_TRIGGER);
}

/**
 * 재조회가 **실패했는가**. react-query 의 `refetch()` 는 실패해도 던지지 않고 결과(`isError`)로
 * 답한다. 그래서 던짐뿐 아니라 결과도 본다: 하나라도 오류 상태면 실패다(여러 재조회를 묶은
 * `Promise.all` 의 배열 포함). 결과가 무엇인지 모르면(`void`) 실패라고 단정하지 않는다.
 */
export function refreshFailed(result: unknown): boolean {
  if (Array.isArray(result)) return result.some(refreshFailed);
  if (result === null || typeof result !== 'object') return false;
  const shape = result as {isError?: unknown; status?: unknown};
  return shape.isError === true || shape.status === 'error';
}
