// =============================================================================
// 데스크탑 셸: 받는 곳 없이 놓인 끌기를 삼킨다 (#2671).
//
// 셸은 `dragDropEnabled: false`로 끌기를 WebKit에 넘긴다(HTML5 경로). 그래야
// 컴포저(`useComposerDropZone`)와 사이드바 재배치(`sidebarDnd`)가 드롭을 받는다.
// 대가가 하나 있다. 받는 곳이 없는 자리에 놓인 끌기에는 WebKit 기본 동작이
// 돌아온다. 파일을 놓으면 그 파일로, 링크를 놓으면 그 주소로 **창 전체가
// 이동한다.** 실측: 연결 화면 빈 자리에 놓은 텍스트 파일이 앱을 통째로
// 대체했다. 데스크탑 창에는 뒤로 가기가 없어서 앱을 다시 켜야 돌아온다.
// 셸이 끌기를 가져가던 전에는 이런 드롭이 아무 일도 하지 않았다.
//
// 그래서 문서의 끝(window, 버블 단계)에서, 어느 드롭 영역도 가져가지 않은
// (`defaultPrevented`가 거짓인) 끌기만 막는다.
// - dragover: 「여기에는 놓을 수 없음」(`dropEffect = "none"`)으로 답한다.
// - drop: 그래도 오면 기본 동작을 막는다.
// 드롭 영역이 먼저 preventDefault한 끌기는 건드리지 않는다. 그 영역의
// 핸들러는 버블 순서상 이 리스너보다 먼저 돈다.
//
// 브라우저 탭에는 걸지 않는다. 탭에는 뒤로 가기가 있고, 웹 동작은 이 변경의
// 범위가 아니다(`main.tsx`가 `IS_TAURI`일 때만 설치한다).
// =============================================================================

export interface DropGuardTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

function transferOf(event: Event): DataTransfer | null {
  return (event as DragEvent).dataTransfer ?? null;
}

/** 설치하고 해제 함수를 돌려준다. 앱에서는 문서와 수명이 같아 해제하지 않는다. */
export function installDesktopDropGuard(target: DropGuardTarget): () => void {
  const onDragOver = (event: Event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const transfer = transferOf(event);
    if (transfer) transfer.dropEffect = "none";
  };
  const onDrop = (event: Event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
  };
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}
