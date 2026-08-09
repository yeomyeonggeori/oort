import { useCallback, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";

// =============================================================================
// 파일이 컴포저로 들어오는 세 번째와 네 번째 문 (#1202 첨부 축).
//
// 첫째는 클립 버튼, 둘째는 파일 선택창. 이 파일은 나머지 둘이다: **끌어다
// 놓기**와 **붙여넣기**. 웹에서 이 둘 없는 첨부는 절반만 있는 첨부다 — 스크린샷을
// 찍어 ⌘V 로 넣는 것은 이 도구를 쓰는 사람들이 하루에 몇 번씩 하는 일이다.
// (mac 클라도 드롭을 갖는다: `MomoFileDropOverlay`.)
//
// ## dragenter/dragleave 는 셀 수밖에 없다
//
// 자식 요소 위로 커서가 넘어갈 때마다 부모는 `dragleave` 를 받고 곧바로 새
// `dragenter` 를 받는다. 그래서 불리언 하나로는 커서가 텍스트에어리어 경계를
// 지날 때마다 강조가 깜빡인다. 깊이를 세는 것이 이 문제의 표준 답이고, 그것이
// 이 훅에 상태 대신 ref 가 있는 이유다.
//
// ## 붙여넣은 것이 전부 파일은 아니다
//
// 텍스트를 복사하면 클립보드에는 `text/plain` 과 함께 `text/html` 이 오고, 어떤
// 앱은 거기에 이미지 렌디션까지 얹는다. 파일만 있을 때에만 기본 동작을 막는다 —
// 안 그러면 글을 붙여넣었는데 입력창에 아무것도 안 들어가는 일이 생긴다.
// =============================================================================

export interface ComposerDropZone {
  /** 지금 이 컴포저 위에 파일이 떠 있는가. 강조 한 겹의 근거. */
  dragging: boolean;
  onDragEnter: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  onPaste: (event: ClipboardEvent) => void;
}

/** 이 끌기가 파일을 나르고 있는가. 텍스트 선택을 끄는 손짓과 구별한다. */
function carriesFiles(transfer: DataTransfer | null): boolean {
  if (transfer === null) return false;
  return Array.from(transfer.types).includes("Files");
}

export function useComposerDropZone(
  onFiles: (files: File[]) => void,
  enabled = true
): ComposerDropZone {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    [enabled]
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return;
      // 막지 않으면 브라우저가 이 파일을 **새 탭에서 열고** 앱을 떠난다.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [enabled]
  );

  const onDragLeave = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    [enabled]
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      reset();
      // 폴더는 `File` 로 오지만 크기가 0 이고 타입이 없다. 서버의 mime 검증에서
      // 400 이 될 것을 알면서 올려 보내지 않는다 (mac 도 같은 자리에서 디렉터리를
      // 거른다: `!url.hasDirectoryPath`).
      const files = Array.from(event.dataTransfer.files).filter(
        (file) => file.size > 0 || file.type !== ""
      );
      if (files.length > 0) onFiles(files);
    },
    [enabled, onFiles, reset]
  );

  const onPaste = useCallback(
    (event: ClipboardEvent) => {
      if (!enabled) return;
      const data = event.clipboardData;
      if (!data) return;
      const files = Array.from(data.files);
      if (files.length === 0) return;
      // 글과 함께 온 이미지 렌디션이면 글이 우선이다. 파일만 있을 때에만 가로챈다.
      if (Array.from(data.types).some((type) => type.startsWith("text/"))) return;
      event.preventDefault();
      onFiles(files);
    },
    [enabled, onFiles]
  );

  return { dragging, onDragEnter, onDragOver, onDragLeave, onDrop, onPaste };
}
