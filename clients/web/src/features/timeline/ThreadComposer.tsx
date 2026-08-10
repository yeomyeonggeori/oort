import { useMemo, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { sendThreadReply } from "@momo/core/lib/api";
import { InlineBanner } from "@/features/common/States";
import { replyFailureMessage } from "@momo/core/features/timeline/actionCopy";
import { cn } from "@/design/lib/cn";
import {
  AttachButton,
  AttachmentTray,
} from "@/features/attachments/AttachmentTray";
import {
  acknowledgeNotices,
  addFiles,
  clearSurface,
  dropDraft,
  peekSent,
  retryDraft,
  surfaceKey,
  useAttachmentSurface,
} from "@/features/attachments/draftStore";
import { useComposerDropZone } from "@/features/attachments/useComposerDropZone";
import {
  sendBlockCopy,
  sendBlockReason,
} from "@momo/core/features/attachments/model";
import { useAutoGrow } from "./useAutoGrow";

// =============================================================================
// Writing a reply, from inside the thread (B11).
//
// The thread panel could read replies before this and not write them, which
// made 답글 a link to a transcript rather than an action. This is the other
// half.
//
// **The same write path as a channel send**, with `rootId` set — server
// `SendMessageRequest.rootId`, which is exactly how the mac client shares a
// work excerpt into a session thread. There is no reply endpoint and inventing
// one client-side would be a second write path into the same ledger.
//
// Deliberately simpler than the channel composer: no mention autocomplete and no
// model/effort selector. Those belong to the surface where a conversation
// starts; a reply is a follow-up, and every control added here is one more thing
// between reading the thread and answering it.
//
// ## 첨부는 그 목록에서 빠진다 (ADR-0151 D2 / #1202)
//
// 이 자리에는 "no attachments"가 함께 적혀 있었고, 그 판단은 **뒤집힌다.** 뒤집는
// 근거는 위 문단이 세운 기준 자체다: 여기 놓이는 컨트롤은 "읽기와 답하기 사이에
// 끼는 것"이면 안 된다. 그런데 첨부는 답의 **내용**이지 답의 설정이 아니다 —
// 멘션 자동완성이나 모델 선택기와 달리, 첨부 없이는 하려던 말을 아예 못 하는
// 경우가 있다("이 로그 보세요"의 그 로그). 스레드에서 파일을 붙이려면 채널로
// 나가서 맥락을 잃은 채 다시 써야 했고, 그것이 원래 문단이 막으려던 마찰보다 크다.
//
// 대가도 그만큼 작다. 클립 버튼 하나가 늘고, 트레이는 **첨부가 있을 때만** 선다.
// 아무것도 붙이지 않은 사람에게 이 표면은 이전과 픽셀 단위로 같다.
//
// 서버 계약은 이미 그것을 허용하고 있었다: `rootId`와 `attachmentIds`는 같은
// 전송 요청의 서로 무관한 두 필드이고, 스레드 답글이라고 다르게 취급하는 분기가
// 서버에 없다. 막고 있던 것은 화면뿐이었다(mac 도 같은 자리에서 막혀 있다 —
// `MessageThreadPanel.sendReply` 가 `attachmentIds` 를 안 싣는다).
// =============================================================================

export function ThreadComposer({
  workspaceId,
  channelId,
  rootId,
  onSent,
}: {
  workspaceId: string;
  channelId: string;
  rootId: string;
  /** Refetch the thread; the reply also arrives on the realtime rail. */
  onSent: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // 트레이는 **이 스레드의 것**이다. 채널 컴포저와 열쇠가 다르므로, 스레드에 붙인
  // 파일이 패널을 닫는 순간 채널 입력창에 나타나는 일이 없다.
  const trayKey = surfaceKey(workspaceId, channelId, rootId);
  const tray = useAttachmentSurface(trayKey);
  const attachTarget = useMemo(
    () => ({ workspaceId, channelId }),
    [workspaceId, channelId]
  );
  const onFiles = (files: File[], batch?: { folders?: number }) =>
    addFiles(trayKey, attachTarget, files, batch);
  const drop = useComposerDropZone(onFiles);
  const attachBlock = sendBlockReason(tray.drafts);
  const attachBlockCopy = sendBlockCopy(tray.drafts);

  // 답글도 한 줄로 끝나지 않는다. 메인 컴포저가 1행에서 6행까지 자라는 것과 같은
  // 규칙이다 (R2 M4) — 다른 것은 이 창이 320px 패널 안에 있어서 접히는 줄이 더
  // 빨리 생긴다는 점뿐이다.
  useAutoGrow(ref, draft, { minRows: 1, maxRows: 6 });

  // 파일만 보내는 답글도 답글이다. 채널 컴포저와 같은 규칙을 같은 함수로 판정한다.
  const canSend =
    !sending &&
    attachBlock === null &&
    (draft.trim().length > 0 || tray.drafts.length > 0);

  const submit = () => {
    if (!canSend) return;
    const body = draft.trim();
    setSending(true);
    setError(null);
    // 트레이는 **성공한 뒤에** 비운다. 채널 컴포저와 다른 점이 여기다: 그쪽은
    // 실패한 전송이 타임라인에 「전송 실패 · 다시 보내기」 행으로 남아 첨부를
    // 계속 들고 있지만, 이 표면에는 그런 행이 없다. 먼저 비우면 실패한 답글의
    // 파일이 사라지고 사람은 같은 파일을 다시 찾아 붙여야 한다.
    const sent = peekSent(trayKey);
    // A fresh idempotency key per attempt, like the channel send: a retry after
    // a failure is a new send, not a replay of one that may already have
    // landed.
    sendThreadReply(workspaceId, channelId, rootId, crypto.randomUUID(), body, {
      attachmentIds: sent.attachmentIds,
    })
      .then(() => {
        setDraft("");
        clearSurface(trayKey);
        onSent();
        ref.current?.focus();
      })
      .catch((cause: unknown) => setError(replyFailureMessage(cause)))
      .finally(() => setSending(false));
  };

  return (
    <div
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      data-dragging={drop.dragging ? "" : undefined}
      className={cn(
        "safe-area-bottom border-t border-line",
        drop.dragging && "bg-accent-soft"
      )}
      data-testid="thread-composer"
    >
      <AttachmentTray
        drafts={tray.drafts}
        rejected={tray.rejected}
        folders={tray.folders}
        onRemove={(localId) => dropDraft(trayKey, localId)}
        onRetry={(localId) => retryDraft(trayKey, attachTarget, localId)}
        onClear={() => clearSurface(trayKey)}
        onAcknowledgeNotices={() => acknowledgeNotices(trayKey)}
      />
      <div className="p-3">
        {error && (
          <InlineBanner
            message={error}
            separator={false}
            testId="thread-composer-error"
          />
        )}
        <div className="flex items-end gap-2">
          <AttachButton onPick={onFiles} disabled={sending} />
          <textarea
            ref={ref}
            value={draft}
            disabled={sending}
            placeholder="답글 쓰기"
            aria-label="답글 쓰기"
            data-testid="thread-composer-input"
            onChange={(event) => setDraft(event.target.value)}
            onPaste={drop.onPaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className="tap-target min-h-control w-full resize-none rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          />
          <button
            type="button"
            disabled={!canSend}
            onClick={submit}
            aria-label="답글 보내기"
            title={
              attachBlockCopy ?? "답글 보내기"
            }
            data-testid="thread-composer-send"
            className="tap-target flex size-control shrink-0 items-center justify-center rounded-sm bg-accent text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            <SendHorizontal className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
