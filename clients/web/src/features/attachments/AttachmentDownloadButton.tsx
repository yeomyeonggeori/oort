import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/design/lib/cn";
import { downloadAttachment } from "@/features/attachments/content";
import {
  ATTACH_COPY,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";

// 타임라인 카드와 라이트박스가 같은 내려받기 상태를 쓴다. 바쁜 동안에도 버튼을
// 비활성화하지 않는 이유는 AttachmentList의 기존 계약 그대로다: 비활성은
// 「할 수 없음」이고, 이 상태는 「하고 있음」이다. content.ts가 받는 값은 완료된
// Blob 하나뿐이라 전송 중 바이트를 모른다. 잰 값 없이 퍼센트를 만들지 않는다.
export function AttachmentDownloadButton({
  workspaceId,
  channelId,
  attachment,
  joinsMessageRow = false,
  busy: controlledBusy,
  tapTarget = false,
  onBusyChange,
  onStarted,
  onFailed,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  /** 메시지 행의 단일 로빙 포커스 그룹에 들어가는 카드 버튼인가. */
  joinsMessageRow?: boolean;
  /** 같은 버튼 인스턴스에서 첨부가 바뀌는 표면은 첨부 ID별 상태를 주입한다. */
  busy?: boolean;
  /** 좁은 화면에서도 독립 조작점인 경우 44px 터치 타깃을 보장한다. */
  tapTarget?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onStarted?: () => void;
  onFailed?: () => void;
}) {
  const [localBusy, setLocalBusy] = useState(false);
  const busy = controlledBusy ?? localBusy;
  const setBusy = (next: boolean) => {
    if (controlledBusy === undefined) setLocalBusy(next);
    onBusyChange?.(next);
  };

  return (
    <button
      type="button"
      aria-busy={busy || undefined}
      onClick={() => {
        // 두 번 누르면 두 번 받는다. 막는 대신 같은 요청을 다시 보내지 않게만
        // 한다. 비활성화는 포커스를 <body>로 던지고 돌려주지 않는다.
        if (busy) return;
        onStarted?.();
        setBusy(true);
        void downloadAttachment(workspaceId, channelId, attachment)
          .catch(() => onFailed?.())
          .finally(() => setBusy(false));
      }}
      aria-label={`${attachment.name} ${ATTACH_COPY.download}`}
      title={busy ? ATTACH_COPY.downloading : ATTACH_COPY.download}
      data-testid="attachment-download"
      data-busy={busy ? "" : undefined}
      data-row-action={joinsMessageRow ? "" : undefined}
      className={cn(
        tapTarget ? "tap-target" : "touch-target",
        "flex size-control shrink-0 items-center justify-center rounded-sm text-ink-muted",
        "hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
      )}
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="size-4 spinner-busy" />
      ) : (
        <Download aria-hidden="true" className="size-4" />
      )}
    </button>
  );
}
