import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AtSign, SendHorizontal, Smile } from "lucide-react";
import { sendThreadReply } from "@momo/core/lib/api";
import {
  composerKeyIntent,
  isComposingEvent,
} from "@momo/core/features/chat/composerKeys";
import { InlineBanner } from "@/features/common/States";
import { replyFailureMessage } from "@momo/core/features/timeline/actionCopy";
import { THREAD_COMPOSER_PLACEHOLDER } from "@momo/core/features/chat/composerCopy";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useIsMobileShell } from "@/app/shellNav";
import type { Directory } from "@/features/workspace/useWorkspace";
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
  MentionAutocompleteList,
  useMentionAutocomplete,
} from "@/features/chat/MentionAutocomplete";
import { useComposerEmoji } from "@/features/chat/useComposerEmoji";
import { EmojiPickerDialog } from "@/features/emoji/EmojiPickerDialog";
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
// Deliberately simpler than the channel composer only where the action changes
// how an agent runs: no model/effort selector. Mention autocomplete, attachments
// and emoji are message contents, so both composers use the same surfaces. A
// reply that cannot name a member or carry the file it discusses is not a
// simpler reply; it is an incomplete one (#1688).
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
  directory,
  onSent,
}: {
  workspaceId: string;
  channelId: string;
  rootId: string;
  directory: Directory;
  /** Refetch the thread; the reply also arrives on the realtime rail. */
  onSent: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const justComposedRef = useRef(false);
  const isMobile = useIsMobileShell();
  const mentions = useMentionAutocomplete({
    value: draft,
    members: directory.members,
    inputRef: ref,
    onValueChange: setDraft,
  });
  const emoji = useComposerEmoji({
    value: draft,
    inputRef: ref,
    onValueChange: mentions.replaceValue,
  });

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
        mentions.close();
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
        <div className="relative">
          <MentionAutocompleteList
            id="thread-mention-list"
            candidates={mentions.candidates}
            highlight={mentions.highlight}
            onChoose={mentions.choose}
            testId="thread-mention-list"
            optionTestId="thread-mention-option"
            className="left-0"
          />
          <div
            className="rounded-md border border-line-strong bg-surface-raised"
            data-testid="thread-composer-frame"
          >
            <textarea
              ref={ref}
              value={draft}
              disabled={sending}
              // 공유 문구는 아직 「답글 쓰기」만 말한다. C-1 코어 파도와 충돌하지
              // 않도록 이 goal은 코어 문장을 건드리지 않고, 실제 @ 동작만 웹과 폰에
              // 맞춘다. 다음 코어 카피 정리에서 광고 절을 한 벌로 올릴 수 있다.
              placeholder={THREAD_COMPOSER_PLACEHOLDER}
              aria-label={THREAD_COMPOSER_PLACEHOLDER}
              aria-autocomplete="list"
              aria-expanded={mentions.visible}
              aria-controls={mentions.visible ? "thread-mention-list" : undefined}
              aria-activedescendant={
                mentions.visible
                  ? `thread-mention-list-option-${mentions.highlight}`
                  : undefined
              }
              data-testid="thread-composer-input"
              onChange={(event) =>
                mentions.onTextChange(
                  event.target.value,
                  event.target.selectionStart ?? 0
                )
              }
              onSelect={(event) =>
                mentions.setCaret(
                  (event.target as HTMLTextAreaElement).selectionStart ?? 0
                )
              }
              onPaste={drop.onPaste}
              onCompositionStart={() => {
                justComposedRef.current = false;
              }}
              onCompositionEnd={() => {
                justComposedRef.current = true;
              }}
              onKeyUp={() => {
                justComposedRef.current = false;
              }}
              onBlur={() => {
                justComposedRef.current = false;
              }}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if (event.key !== "Enter" && event.key !== "Tab") {
                  justComposedRef.current = false;
                }
                const intent = composerKeyIntent(
                  {
                    key: event.key,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    altKey: event.altKey,
                    composing: isComposingEvent(event.nativeEvent),
                  },
                  {
                    mentionsOpen: mentions.visible,
                    justComposed: justComposedRef.current,
                    enterSends: !isMobile,
                  }
                );
                if (mentions.handleIntent(intent)) {
                  event.preventDefault();
                  return;
                }
                if (intent !== "send") return;
                event.preventDefault();
                submit();
              }}
              className="tap-target block min-h-control w-full resize-none rounded-sm bg-transparent px-3 py-2 text-body text-ink focus-visible:focus-ring disabled:opacity-50"
            />
            <div
              className="flex items-center justify-between gap-2 px-2 pb-2"
              data-testid="thread-composer-actions"
            >
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="tap-target shrink-0"
                  disabled={sending}
                  aria-label="멘션 넣기"
                  title="멘션 넣기"
                  data-testid="thread-composer-mention-trigger"
                  onClick={mentions.insertTrigger}
                >
                  <AtSign aria-hidden="true" />
                </Button>
                <AttachButton onPick={onFiles} disabled={sending} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="tap-target shrink-0"
                  disabled={sending}
                  aria-label="이모지 넣기"
                  title="이모지 넣기"
                  data-testid="thread-composer-emoji-trigger"
                  onClick={(event) => {
                    mentions.close();
                    emoji.openPicker(event.currentTarget);
                  }}
                >
                  <Smile aria-hidden="true" />
                </Button>
              </div>
              <button
                type="button"
                disabled={!canSend}
                onClick={submit}
                aria-label="답글 보내기"
                title={attachBlockCopy ?? "답글 보내기"}
                data-testid="thread-composer-send"
                className="tap-target flex size-control shrink-0 items-center justify-center rounded-sm bg-accent text-on-accent transition-opacity hover:opacity-90 focus-visible:focus-ring focus-ring-on-fill disabled:opacity-50"
              >
                <SendHorizontal className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
      <EmojiPickerDialog
        open={emoji.open}
        onOpenChange={emoji.setOpen}
        onPick={emoji.pick}
        opener={emoji.opener}
        anchor={emoji.anchor}
        purpose="insert"
        testId="thread-composer-emoji-picker"
      />
    </div>
  );
}
