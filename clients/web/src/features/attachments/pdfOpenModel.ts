import { IS_TAURI } from "@/lib/env";
import type { PdfOpenFailure } from "@/features/attachments/content";
import {
  ATTACH_COPY,
  isPdfAttachment,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";

/**
 * PDF 를 어디서 여는가 (#2701).
 *
 * 브라우저 탭은 새 창(`application/pdf` blob)이다. 데스크탑 셸은 새 창을 열지
 * 못한다: wry 가 WKWebView 의 새 창 요청을 구현하지 않아 `window.open` 이 조용히
 * 버려지고(`lib/tauri.ts` openExternalUrl 이 같은 사실 위에 서 있다), `blob:` 은
 * 그 웹뷰 안에서만 사는 주소라 OS 로 넘길 수도 없다. 그래서 셸은 바이트를
 * 네이티브 명령에 넘겨 OS 기본 PDF 뷰어로 연다(`pdf_viewer.rs`).
 */
export type PdfOpenMode = "window" | "desktop";

export function pdfOpenMode(): PdfOpenMode {
  return IS_TAURI ? "desktop" : "window";
}

export function canOpenPdf(attachment: Pick<MessageAttachment, "mime">): boolean {
  return isPdfAttachment(attachment);
}

export function pdfOpenLabel(mode: PdfOpenMode): string {
  return mode === "desktop" ? ATTACH_COPY.openPdfDesktop : ATTACH_COPY.openPdf;
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

