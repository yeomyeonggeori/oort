import { watchWindowFullscreen } from "@/lib/tauri";

// =============================================================================
// 데스크탑 셸의 전체 화면 표지 (#4591).
//
// macOS 전체 화면에서는 신호등이 창에서 사라진다. 상단 줄이 신호등 자리로 비워 둔 80px(`--titlebar-inset`)은
// 그때 죽은 빈 공간이므로, 셸이 창의 전체 화면 상태를 읽어 루트에 `data-window-fullscreen`을 찍고 CSS가
// 그 인셋을 접는다(`tokens.css`, `:root[data-window-fullscreen]`). 상태 읽기·구독은 `watchWindowFullscreen`이다.
//
// 브라우저 탭에는 설치하지 않는다(`main.tsx`가 `IS_TAURI`일 때만). 해제 함수는 표지도 걷는다.
// =============================================================================

export const FULLSCREEN_ATTRIBUTE = "data-window-fullscreen";

export function installDesktopFullscreenMark(
  root: Pick<HTMLElement, "setAttribute" | "removeAttribute"> = document.documentElement
): () => void {
  let stopped = false;
  let unsubscribe: () => void = () => {};
  void watchWindowFullscreen((fullscreen) => {
    if (stopped) return;
    if (fullscreen) root.setAttribute(FULLSCREEN_ATTRIBUTE, "");
    else root.removeAttribute(FULLSCREEN_ATTRIBUTE);
  })
    .then((off) => {
      // 구독이 끝나기 전에 해제되었으면 도착한 즉시 거둔다.
      if (stopped) off();
      else unsubscribe = off;
    })
    .catch(() => {
      /* 창 API를 못 부르면 표지 없이 80px 그대로다: 죽은 공간일 뿐 깨지지 않는다 */
    });
  return () => {
    stopped = true;
    unsubscribe();
    root.removeAttribute(FULLSCREEN_ATTRIBUTE);
  };
}
