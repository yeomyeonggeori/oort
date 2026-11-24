import { ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/design/lib/cn";
import {
  openPdfAttachment,
  openPdfAttachmentInDesktop,
  openPdfWindow,
  PdfOpenError,
  type PdfOpenFailure,
} from "@/features/attachments/content";
import { pdfOpenLabelKey, pdfOpenMode } from "@/features/attachments/pdfOpenModel";
import {
  ATTACH_COPY,
  attachmentDisplayName,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";
import { Tooltip } from "@/design/ui/tooltip";
import { useRowTipSide } from "@/features/timeline/rowTipSide";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// PDF 카드의 「새 창에서 열기」 (#2701). 왜 새 창인지는 content.ts 의 PDF 절이
// 말한다(CSP 가 임베드를 막는다). 이 파일은 그 버튼의 모양과 실패 문장뿐이다.

export function AttachmentOpenPdfButton({
  workspaceId,
  channelId,
  attachment,
  onStarted,
  onFailed,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  onStarted?: () => void;
  onFailed?: (reason: PdfOpenFailure) => void;
}) {
  const [busy, setBusy] = useState(false);
  // 대화 줄의 파일 카드에만 서므로 툴팁 방향은 단추 자리로 가른다(#5980, `rowTipSide.ts`).
  const tip = useRowTipSide();
  const mode = pdfOpenMode();
  const formatMessage = useFormatMessage();
  const label = formatMessage(pdfOpenLabelKey(mode));
  const fail = (error: unknown) =>
    onFailed?.(error instanceof PdfOpenError ? error.reason : "failed");

  return (
    <Tooltip label={busy ? formatMessage(ATTACH_COPY.openingPdf) : label} side={tip.side}>
      <button
        type="button"
        aria-busy={busy || undefined}
        onPointerEnter={tip.probe}
        onFocus={tip.probe}
        onClick={() => {
          // 내려받기 버튼과 같은 계약: 바쁜 동안 비활성화하지 않는다(포커스를
          // <body>로 던지지 않는다). 같은 요청을 두 번 보내지 않을 뿐이다.
          if (busy) return;
          onStarted?.();
          if (mode === "desktop") {
            setBusy(true);
            void openPdfAttachmentInDesktop(workspaceId, channelId, attachment)
              .catch(fail)
              .finally(() => setBusy(false));
            return;
          }
          // 창은 await **앞**에서 연다. 뒤에서 열면 팝업 차단에 걸린다.
          const target = openPdfWindow(formatMessage(ATTACH_COPY.openingPdf));
          if (target === null) {
            onFailed?.("blocked");
            return;
          }
          setBusy(true);
          void openPdfAttachment(workspaceId, channelId, attachment, target)
            .catch(fail)
            .finally(() => setBusy(false));
        }}
        aria-label={`${attachmentDisplayName(formatMessage, attachment)} ${label}`}
        data-testid="attachment-open-pdf"
        data-busy={busy ? "" : undefined}
        data-row-action=""
        className={cn(
          "touch-target flex size-control shrink-0 items-center justify-center rounded-sm text-ink-muted",
          "press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
        )}
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="size-4 spinner-busy" />
        ) : (
          <ExternalLink aria-hidden="true" className="size-4" />
        )}
      </button>
    </Tooltip>
  );
}
