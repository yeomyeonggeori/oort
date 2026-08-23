import { useState } from "react";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { Avatar } from "./MessageRow";
import { AttachmentList } from "./AttachmentList";
import { MessageBody } from "./MessageBody";
import { QuoteBlock } from "./QuoteBlock";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import { resolveQuote } from "@momo/core/features/timeline/quote";
import type { Message } from "@momo/core/lib/api";
import {
  ROW_CONTINUATION_PAD_CLASS,
  ROW_GROUP_START_PAD_CLASS,
} from "./spacing";

// =============================================================================
// Optimistic echo row (M10, R-1 §3 "내 메시지는 seq 미확정이어도 로컬 echo").
//
// Its own component rather than a variant of MessageRow, because the two rows
// differ in what they can honestly claim: this one has no seq, no thread
// rollup, no server state and no permanence. It borrows MessageRow's grid
// (same padding, same 24px avatar column, same body type) so the row does not
// twitch into place when the server echo replaces it.
//
// Delivery status is stated in words, not with a decorative dot or a spinner:
// "전송 중" while the write path is running, "전송 실패" plus a retry when it
// is not. That retry re-sends with the SAME idempotency key, which is what the
// server's exactly-once write path is for (model.ts retryPending).
// =============================================================================

export function PendingRow({
  pending,
  startsGroup,
  directory,
  quoteLookup,
  onResend,
}: {
  pending: PendingMessage;
  startsGroup: boolean;
  directory: Directory;
  /** 이 echo가 인용한 원본을 화면에 있는 행에서 찾는다 (ADR-0148). */
  quoteLookup?: (messageId: string) => Message | undefined;
  onResend?: (clientMsgId: string) => Promise<void> | void;
}) {
  const [resending, setResending] = useState(false);
  const author = memberFor(directory, pending.authorMemberId);
  const name = author?.displayName ?? "나";
  const failed = pending.status === "failed";
  // 확정된 행과 **같은 것**을 그린다 (ADR-0148). echo가 인용을 안 그렸다가 seq가
  // 도착하는 순간 하나 자라면, 읽는 사람 눈 아래에서 본문이 아래로 밀린다 - 이
  // 파일이 마크다운을 echo에도 그리기로 한 것과 같은 이유다(goal B8 H6).
  // 점프는 주지 않는다: 아직 보내지지도 않은 글에서 원본으로 떠나는 길은, 돌아왔을
  // 때 그 글이 어디 있는지 아무도 보장하지 못한다.
  const quote =
    pending.replyToId === undefined
      ? null
      : resolveQuote({ replyToId: pending.replyToId }, quoteLookup);

  return (
    <article
      data-testid="timeline-pending"
      data-client-msg-id={pending.clientMsgId}
      data-status={pending.status}
      className={cn(
        "flex gap-2 px-4 hover:bg-surface-hover",
        // 확정된 행과 **같은 다리**를 쓴다 (U4-6 리뷰 M-1). 이 자리는 `pt-3 pb-1`
        // /`py-1` 이라는 손으로 적은 값이었고, 그래서 묶음 안 간격이 8px(4+4)
        // 이었다 — 코어가 말하는 12(`ROW_SPACE.withinGroup`)가 아니다. echo 행은
        // 서버 echo 가 도착하면 `MessageRow` 로 **교체된다.** 두 행의 패딩이
        // 다르면 그 순간 글이 4px 아래로 내려앉는다: 이 파일 머리말이 「같은
        // 그리드를 빌려 쓰는 이유는 행이 제자리로 튀지 않게 하려는 것」이라고
        // 적은 그 성질을, 정작 간격에서만 지키지 않고 있었다.
        startsGroup ? ROW_GROUP_START_PAD_CLASS : ROW_CONTINUATION_PAD_CLASS
      )}
    >
      <div className="w-8 shrink-0">
        {startsGroup && <Avatar member={author} />}
      </div>
      <div className="min-w-0 flex-1">
        {startsGroup && (
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-body font-semibold text-ink">{name}</span>
            {/* No timestamp: the message has no server time yet, and printing
                the local clock beside confirmed server times would invent an
                ordering the timeline does not have. */}
          </div>
        )}
        {quote && <QuoteBlock block={quote} directory={directory} />}
        {/* Same body renderer as the confirmed row (goal B8 H6): an echo that
            showed raw asterisks and then re-flowed into bold the moment its seq
            landed would move the text under the reader's eye. */}
        <MessageBody
          body={pending.body}
          directory={directory}
          muted
          selfMemberId={pending.authorMemberId}
        />
        {/* 확정된 행과 **같은 카드**를 그린다 (ADR-0151). 바이트는 전송을 누르기
            전에 이미 보관소에 올라가 있으므로, 이 카드는 seq 를 기다리는 동안에도
            거짓이 아니다 — 내려받기 버튼조차 진짜로 동작한다. 인용을 echo 에도
            그리기로 한 것과 같은 이유이기도 하다: 여기서 안 그렸다가 seq 가
            도착하는 순간 자라면 읽는 사람 눈 아래에서 본문이 밀린다. */}
        {(pending.attachments?.length ?? 0) > 0 && (
          <AttachmentList
            channelId={pending.channelId}
            attachments={pending.attachments ?? []}
            muted
          />
        )}
        {failed ? (
          <span
            className="flex flex-wrap items-center gap-2 text-meta text-danger"
            data-testid="pending-failed"
          >
            전송 실패
            {onResend && (
              <button
                type="button"
                disabled={resending}
                data-testid="pending-resend"
                onClick={() => {
                  setResending(true);
                  void Promise.resolve(onResend(pending.clientMsgId)).finally(
                    () => setResending(false)
                  );
                }}
                className="rounded-sm underline underline-offset-2 hover:text-ink focus-visible:focus-ring disabled:opacity-50"
              >
                {resending ? "보내는 중…" : "다시 보내기"}
              </button>
            )}
          </span>
        ) : (
          <span className="text-meta text-ink-muted" data-testid="pending-sending">
            전송 중
          </span>
        )}
      </div>
    </article>
  );
}
