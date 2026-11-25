import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/design/lib/cn";
import { downloadAttachment } from "@/features/attachments/content";
import {
  ATTACH_COPY,
  attachmentDisplayName,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";
import { Tooltip } from "@/design/ui/tooltip";
import { useRowTipSide } from "@/features/timeline/rowTipSide";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// 타임라인 카드와 라이트박스가 같은 내려받기 상태를 쓴다. 바쁜 동안에도 버튼을
// 비활성화하지 않는 이유는 AttachmentList의 기존 계약 그대로다: 비활성은
// 「할 수 없음」이고, 이 상태는 「하고 있음」이다. 이 버튼이 아는 것은 하고 있다/끝났다/
// 못 했다 셋뿐이라 퍼센트를 그리지 않는다: 잰 값 없이 퍼센트를 만들지 않는다. 잰 진행(받은
// 바이트)은 데스크탑 셸의 다운로드 매니저가 들고 상단 오른쪽 패널이 보여 준다(#4587).
export function AttachmentDownloadButton({
  workspaceId,
  channelId,
  attachment,
  joinsMessageRow = false,
  busy: controlledBusy,
  tapTarget = false,
  tooltipSide = "bottom",
  className,
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
  /**
   * 툴팁 방향. 아래에 알약 높이만큼의 자리가 없는 자리는 위로 돌린다(#5965). `row`는 대화 줄의 파일 카드: 열릴 때 단추 자리로
   * 가른다 — 스크롤 칸 맨 위 띠에 걸리면 아래, 그 밖은 위(#5980, `rowTipSide.ts`).
   */
  tooltipSide?: "top" | "bottom" | "row";
  /** 이 버튼이 선 표면이 모양을 바꿀 때(라이트박스의 둥근 유리 버튼). 기본 모양 뒤에 합쳐지므로 같은 축은 이쪽이 이긴다. */
  className?: string;
  onBusyChange?: (busy: boolean) => void;
  onStarted?: () => void;
  onFailed?: () => void;
}) {
  const formatMessage = useFormatMessage();
  const [localBusy, setLocalBusy] = useState(false);
  const busy = controlledBusy ?? localBusy;
  const tip = useRowTipSide();
  const byRow = tooltipSide === "row";
  const setBusy = (next: boolean) => {
    if (controlledBusy === undefined) setLocalBusy(next);
    onBusyChange?.(next);
  };

  return (
    <Tooltip label={formatMessage(busy ? ATTACH_COPY.downloading : ATTACH_COPY.download)} side={byRow ? tip.side : tooltipSide}>
      <button
        type="button"
        aria-busy={busy || undefined}
        onPointerEnter={byRow ? tip.probe : undefined}
        onFocus={byRow ? tip.probe : undefined}
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
        aria-label={formatMessage("attachments.action.downloadNamed", {
          name: attachmentDisplayName(formatMessage, attachment),
        })}
        data-testid="attachment-download"
        data-busy={busy ? "" : undefined}
        data-row-action={joinsMessageRow ? "" : undefined}
        className={cn(
          tapTarget ? "tap-target" : "touch-target",
          "flex size-control shrink-0 items-center justify-center rounded-sm text-ink-muted",
          "press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring",
          className
        )}
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="size-4 spinner-busy" />
        ) : (
          <Download aria-hidden="true" className="size-4" />
        )}
      </button>
    </Tooltip>
  );
}
