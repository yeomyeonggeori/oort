import { IS_TAURI } from "@/lib/env";
import type { PdfOpenFailure } from "@/features/attachments/content";
import {
  ATTACH_COPY,
  isPdfAttachment,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";

/**
 * 이 표면에서 PDF 를 새 창으로 열 수 있는가.
 *
 * 데스크탑 셸은 못 한다: wry 가 WKWebView 의 새 창 요청을 구현하지 않아
 * `window.open` 이 조용히 버려진다(`lib/tauri.ts` openExternalUrl 이 같은 사실 위에
 * 서 있다). `blob:` 은 OS 브라우저로 넘길 수도 없다 — 이 웹뷰 안에서만 사는
 * 주소다. 그래서 거기서는 버튼을 세우지 않고 내려받기만 남긴다. 죽은 컨트롤은
 * 없는 컨트롤보다 나쁘다.
 */
export function canOpenPdf(attachment: Pick<MessageAttachment, "mime">): boolean {
  return !IS_TAURI && isPdfAttachment(attachment);
}

export function pdfOpenFailureCopy(reason: PdfOpenFailure): string {
  switch (reason) {
    case "blocked":
      return ATTACH_COPY.pdfPopupBlocked;
    case "not-pdf":
      return ATTACH_COPY.pdfNotPdf;
    case "failed":
      return ATTACH_COPY.pdfOpenFailed;
  }
}

