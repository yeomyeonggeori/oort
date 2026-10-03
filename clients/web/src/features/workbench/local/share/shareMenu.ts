import type { PaneShareView } from "./paneShare";
import { SHARE_COPY } from "./shareCopy";

// 칸 머리 메뉴와 세션 목록 행 메뉴가 같은 항목을 쓴다(#2867). 어느 쪽이 그리든 항목과 순서는
// 이 함수 하나가 정한다.
//   꺼짐:   「채널에 공유」 · 「링크 복사」(공유 확인을 먼저 묻는다, Q5)
//   켜짐:   「링크 복사」 · 「공유 끄기」
//   바꾸는 중: 하나 — 서버 답을 기다리는 동안 누를 것이 없다.

export type ShareAction = "share" | "copy" | "unshare";

export interface ShareMenuEntry {
  id: ShareAction | "busy";
  label: string;
  disabled?: boolean;
}

export function shareMenuEntries(kind: PaneShareView["kind"]): ShareMenuEntry[] {
  switch (kind) {
    case "off":
      return [
        { id: "share", label: SHARE_COPY.menuShare },
        { id: "copy", label: SHARE_COPY.menuCopyLink },
      ];
    case "on":
      return [
        { id: "copy", label: SHARE_COPY.menuCopyLink },
        { id: "unshare", label: SHARE_COPY.menuUnshare },
      ];
    default:
      return [{ id: "busy", label: SHARE_COPY.menuBusy, disabled: true }];
  }
}
