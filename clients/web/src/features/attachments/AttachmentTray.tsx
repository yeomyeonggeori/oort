import { FileText, ImageIcon, Paperclip, X } from "lucide-react";
import { useId, useRef } from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  ATTACH_COPY,
  formatBytes,
  isImageMime,
  isRetryableIssue,
  sendBlockReason,
  uploadIssueCopy,
  type AttachmentDraft,
} from "@momo/core/features/attachments/model";

// =============================================================================
// 컴포저의 첨부 자리 (ADR-0151 D2 / #1202 첨부 축).
//
// **칩이지 카드가 아니다.** 첨부 하나마다 둥근 상자를 씌우면 입력창 위에 작은
// 카드들이 쌓이고, 그것이 이 앱이 금지한 「모든 행을 감싼 과대한 웹 카드」다
// (design-taste-web §8). 한 줄에 이름·상태·크기, 오른쪽 끝에 제거 하나.
//
// ## 네 칸이 화면에서 다르게 보이는 방식
//
//   대기 중   회색 한 줄. 막대 없음 — 아무 바이트도 안 움직이고 있다.
//   업로드 중 회색 한 줄 + 퍼센트 + 막대. 막대는 이 칩에만 있다.
//   확인 중   회색 한 줄. **막대가 사라진다** — 셈이 끝났으므로 셈을 그리지 않는다.
//   업로드 완료 회색 한 줄 + 크기. 조용하다.
//   실패     빨간 한 줄 + 이유 + (되돌릴 값이 있으면) 다시 시도.
//
// 「확인 중」에서 막대를 100%로 세워 두지 않는 것이 이 파일의 유일한 시각적
// 고집이다. 다 찬 막대는 「끝났다」로 읽히고, 그 순간 끝난 것은 바이트 전송뿐이지
// 업로드가 아니다.
//
// ## 아이콘
//
// 이미지/그 외 둘뿐이다. mac은 UTType으로 열 몇 가지 심볼을 고르는데, 웹에는 그
// 사전이 없고 사전을 하나 지어 넣으면 그 사전에 없는 타입에서만 조용히 이상해진다.
// 두 갈래는 mime의 앞 조각 하나로 참이 보장된다.
// =============================================================================

/** 상태별 한 줄. 실패만 색이 다르다. */
function statusLine(draft: AttachmentDraft): { text: string; danger: boolean } {
  switch (draft.status) {
    case "ready":
      return { text: ATTACH_COPY.queued, danger: false };
    case "uploading":
      return { text: ATTACH_COPY.uploading, danger: false };
    case "verifying":
      return { text: ATTACH_COPY.verifying, danger: false };
    case "uploaded":
      return {
        text: `${ATTACH_COPY.uploaded} · ${formatBytes(draft.sizeBytes)}`,
        danger: false,
      };
    case "failed":
      return {
        text: draft.issue ? uploadIssueCopy(draft.issue) : ATTACH_COPY.uploading,
        danger: true,
      };
  }
}

function DraftChip({
  draft,
  onRemove,
  onRetry,
}: {
  draft: AttachmentDraft;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const line = statusLine(draft);
  const uploading = draft.status === "uploading";
  const percent = Math.round(draft.progress * 100);
  const Icon = isImageMime(draft.mime) ? ImageIcon : FileText;
  const retryable =
    draft.status === "failed" &&
    draft.issue !== undefined &&
    isRetryableIssue(draft.issue);

  return (
    <li
      data-testid="attachment-chip"
      data-attachment-status={draft.status}
      className="flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-surface-hover"
    >
      <Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0", line.danger ? "text-danger" : "text-ink-muted")}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-body text-ink" title={draft.name}>
            {draft.name}
          </span>
          <span
            className={cn(
              "shrink-0 text-meta",
              line.danger ? "text-danger" : "text-ink-muted"
            )}
            data-testid="attachment-chip-status"
          >
            {line.text}
          </span>
          {/* 퍼센트는 **잰 값이 있을 때만** 나온다. 브라우저가 업로드 진행
              이벤트를 아직 한 번도 안 준 상태에서 「0%」를 찍으면, 그것은
              "아무것도 안 갔다"는 측정이 아니라 "아직 안 재 봤다"는 침묵을
              수치로 위장한 것이다. 막대는 그대로 서 있어서 자리는 튀지 않는다. */}
          {uploading && percent > 0 && (
            <span
              className="shrink-0 text-timestamp text-ink-muted"
              data-numeric
              data-testid="attachment-chip-percent"
            >
              {percent}%
            </span>
          )}
        </span>
        {/* 막대는 「업로드 중」에만 있다. 확인 중에 다 찬 막대를 남겨 두면 화면이
            아직 끝나지 않은 일을 끝났다고 말한다. */}
        {uploading && (
          <progress
            data-upload-progress
            data-testid="attachment-chip-progress"
            value={draft.progress}
            max={1}
            aria-label={`${draft.name} ${ATTACH_COPY.uploading}`}
          />
        )}
      </span>
      {retryable && (
        <button
          type="button"
          onClick={() => onRetry(draft.localId)}
          data-testid="attachment-chip-retry"
          className="touch-target shrink-0 rounded-sm text-meta text-danger underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {ATTACH_COPY.retry}
        </button>
      )}
      <button
        type="button"
        onClick={() => onRemove(draft.localId)}
        aria-label={`${draft.name} ${ATTACH_COPY.remove}`}
        title={ATTACH_COPY.remove}
        data-testid="attachment-chip-remove"
        className="touch-target flex size-control-sm shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
}

/**
 * 클립 버튼. 숨은 `<input type="file">`을 여는 label 이 아니라 button 인 이유는
 * 이 컨트롤이 폼 안에 살기 때문이다: label 은 클릭을 input 으로 넘기지만 키보드
 * 포커스 순서에서 자기 자리를 갖지 못하고, 폼 제출을 막지도 못한다.
 */
export function AttachButton({
  onPick,
  disabled,
}: {
  onPick: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  return (
    <>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          // 같은 파일을 두 번 고를 수 있어야 한다. 값을 비우지 않으면 두 번째
          // 선택에 change 가 아예 발화하지 않는다.
          event.target.value = "";
          onPick(picked);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="tap-target"
        disabled={disabled ?? false}
        onClick={() => inputRef.current?.click()}
        aria-label={ATTACH_COPY.attach}
        title={ATTACH_COPY.attach}
        data-testid="composer-attach"
      >
        <Paperclip />
      </Button>
    </>
  );
}

/**
 * 트레이 전체. 첨부가 하나도 없고 버려진 것도 없으면 **서지 않는다** — 빈 제목
 * 줄은 컴포저 위의 죽은 공간이다.
 */
export function AttachmentTray({
  drafts,
  rejected,
  onRemove,
  onRetry,
  onClear,
  onAcknowledgeRejected,
}: {
  drafts: AttachmentDraft[];
  /** 20개 상한에 걸려 자리를 못 얻은 개수. */
  rejected: number;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  onClear: () => void;
  onAcknowledgeRejected: () => void;
}) {
  if (drafts.length === 0 && rejected === 0) return null;
  // 비활성 버튼은 자기가 왜 비활성인지 말하지 못한다. 그 문장이 사는 자리는
  // 버튼 옆이 아니라 트레이 발치이고, 그 규율은 오프라인 줄이 이미 세워 뒀다.
  const blocked = sendBlockReason(drafts);

  return (
    <div
      className="flex flex-col gap-1 border-b border-line px-3 py-2"
      data-testid="attachment-tray"
    >
      {drafts.length > 0 && (
        <div className="flex items-baseline justify-between gap-2 px-2">
          <h2 className="text-meta font-semibold text-ink-muted">
            {ATTACH_COPY.tray}{" "}
            <span data-numeric className="font-mono">
              {drafts.length}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClear}
            data-testid="attachment-clear"
            className="touch-target rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {ATTACH_COPY.clearAll}
          </button>
        </div>
      )}
      {drafts.length > 0 && (
        <ul className="flex flex-col" aria-label={ATTACH_COPY.tray}>
          {drafts.map((draft) => (
            <DraftChip
              key={draft.localId}
              draft={draft}
              onRemove={onRemove}
              onRetry={onRetry}
            />
          ))}
        </ul>
      )}
      {/* 자리를 못 얻은 파일은 **말하고 나서** 사라진다. mac 은 여기서 말없이
          떨궜고, 말없이 사라진 파일은 사용자가 보낸 줄 아는 파일이다. */}
      {rejected > 0 && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 px-2 text-meta text-warn"
          data-testid="attachment-rejected"
        >
          <span>
            <span data-numeric>{rejected}</span>개는 한 메시지의 상한을 넘어 넣지
            못했습니다.
          </span>
          <button
            type="button"
            onClick={onAcknowledgeRejected}
            className="touch-target rounded-sm underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            확인
          </button>
        </p>
      )}
      {blocked !== null && (
        <p
          role="status"
          className={cn(
            "px-2 text-meta",
            blocked === "uploading" ? "text-ink-muted" : "text-warn"
          )}
          data-testid="attachment-blocked"
          data-block-reason={blocked}
        >
          {blocked === "uploading"
            ? ATTACH_COPY.sendBlocked
            : ATTACH_COPY.sendBlockedFailed}
        </p>
      )}
    </div>
  );
}
