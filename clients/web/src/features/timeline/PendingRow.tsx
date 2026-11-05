import { useState } from "react";
import { Clock } from "lucide-react";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { Avatar } from "./MessageRow";
import { AttachmentList } from "./AttachmentList";
import { MessageBody } from "./MessageBody";
import { QuoteCardAround } from "./QuoteBlock";
import { SendFailureActions } from "./SendFailureActions";
import { useSlowSend } from "./sendSlow";
import { timeLabel } from "./timeLabel";
import { Button } from "@/design/ui/button";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import {
  sendFailureReasonKey,
  type SendFailureKind,
} from "@momo/core/features/connection/sendFailure";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import { resolveQuote } from "@momo/core/features/timeline/quote";
import type { Message } from "@momo/core/lib/api";
import {
  MESSAGE_AVATAR_GUTTER_CLASS,
  MESSAGE_AVATAR_SIZE_CLASS,
  MESSAGE_HEAD_CLASS,
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
// 정상 전송에는 아무것도 깜빡이지 않는다 (#4468, 폰 #4455와 같은 규칙).
//
// 이 행은 실패가 아니면 언제나 「전송 중」 줄을 그렸고 본문을 흐리게 그렸다. 정상 전송은 수백 ms 안에 서버 사본으로
// 교체되므로 그 줄은 잠깐 서고 사라지는 글자였고, 사라질 때 행이 22px 줄었으며, 본문은 흐린 색에서 진한 색으로, 첨부는
// 불투명도 0.7에서 1로 한 번 튀었다. 교체는 언제나 **다른 컴포넌트의 새 마운트**(키 `p-…` → `m-…`)이므로 두 행은
// **같은 모양으로 서야** 이어진다.
//
//   - 정상 전송: 서버 사본과 같은 해부·같은 색. 글자 한 줄도 더하지 않는다.
//   - 오래 걸리는 전송(`SEND_SLOW_MS`, 폰과 같은 1.5초): 작은 시계 하나만. 흐름에 자리를 차지하지 않는다 — 머리 행은
//     시각 바로 오른쪽에, 이어지는 행은 거터에 `absolute`로 앉는다(거터의 시각이 서는 바로 그 자리). 낭독은 「전송 중」.
//   - 실패: 흐린 본문 + 「전송 실패」 + 아이콘 둘(#5210). 흐림은 **실패한 행만** 입는다: 정상 전송이 흐렸다가 진해지면
//     그것이 깜빡임이다. 새로고침은 같은 멱등키로 다시 보내고(model.ts retryPending — 서버의 정확히 한 번 쓰기 길이
//     하는 일), 빨간 X는 이 기기의 대기분만 지운다(model.ts discardPending, 서버 호출 없음).
//   - **머리 행은 기기 시계의 보낸 시각을 그린다**(폰 #4455의 planner 결정을 이어받음 — 옛 「시각을 지어내지 않는다」를
//     메아리 머리 행에 한해 뒤집음). 이슈가 문제 삼은 것이 「보낼 때 잠깐 생겼다 사라지는 글자」인데 교체 때 시각 글자가
//     새로 생기는 것도 같은 종류의 깜빡임이다. 같은 분이면 서버 사본으로 바뀔 때 글자 변화가 0이다. **위험**: 보낸 순간이
//     분 경계에 걸리거나 기기 시계가 서버와 다르면 교체 때 한 번 서버 시각으로 바뀐다. 순서·정렬은 이 글자와 무관하다
//     (`message.seq`). 이어지는 행은 시각을 그리지 않는다(서버 사본도 같다).
// =============================================================================

/**
 * 느린 전송의 시계 하나(#4468). 자리는 부르는 쪽이 `className`으로 정한다: 머리 행은 시각 바로 오른쪽(`left-full`), 이어지는 행은
 * 거터의 시각 자리(`right-0`). 어느 쪽이든 `absolute`라서 서고 져도 행 높이도 글자 자리도 움직이지 않는다.
 *
 * 낭독은 「전송 중」이다 — 정상 전송에는 낭독이 없다(곧 서버 사본으로 교체된다). 시계 글리프는 레포의 Lucide 한 벌이고 16px은 시각 줄
 * (`text-timestamp`의 줄 높이 16)과 같은 키라 글자 줄을 밀지 않는다.
 *
 * 부품으로 뺀 이유: 클래스를 `className` 속성값으로만 적게 하려는 것이다. `cn()` 인자나 상수 안의 클래스 목록은 직접 문구 장부
 * (`direct-copy.mjs`)가 영어 문구로 센다(`SendFailureActions` 머리말과 같은 함정).
 */
function SlowMark({ className }: { className: string }) {
  const formatMessage = useFormatMessage();
  return (
    <span
      role="img"
      aria-label={formatMessage("timeline.send.sending")}
      data-testid="pending-slow"
      className={className}
    >
      <Clock aria-hidden="true" className="size-4" />
    </span>
  );
}

export function PendingRow({
  pending,
  startsGroup,
  directory,
  quoteLookup,
  onResend,
  onDiscard,
  failureKind = null,
  resendAllCount,
  onResendAll,
}: {
  pending: PendingMessage;
  startsGroup: boolean;
  directory: Directory;
  /** 이 echo가 인용한 원본을 화면에 있는 행에서 찾는다 (ADR-0148). */
  quoteLookup?: (messageId: string) => Message | undefined;
  onResend?: (clientMsgId: string) => Promise<void> | void;
  /** 보내지 못한 이 행을 이 기기에서 지운다(#5210). 없으면 X 를 그리지 않는다. */
  onDiscard?: (clientMsgId: string) => void;
  /** 왜 보내지 못했나(#5221). 없으면 원인 없이 「전송 실패」만 말한다. */
  failureKind?: SendFailureKind | null;
  /**
   * 실패한 행이 둘 이상일 때 **마지막** 실패 행에만 개수가 온다(#5221): 이 행 아래에 「N개 모두 다시 보내기」가 선다.
   * 둘 이상일 때만인 이유는 하나일 때는 아이콘이 이미 그 일을 하기 때문이다.
   */
  resendAllCount?: number;
  onResendAll?: () => Promise<void> | void;
}) {
  const formatMessage = useFormatMessage();
  const [resending, setResending] = useState(false);
  const [resendingAll, setResendingAll] = useState(false);
  const author = memberFor(directory, pending.authorMemberId);
  const name = author?.displayName ?? "나";
  const failed = pending.status === "failed";
  // 오래 걸리는 전송만 시계 하나로 알린다(#4468). 시작 시각은 보낸 시각이다(`sendSlow.ts`).
  const slow = useSlowSend(pending.createdAtMs, failed);
  // 보낸 시각을 알 수 없으면(유한한 수가 아니면) 시각 글자를 지어내지 않는다.
  const sentAtMs = Number.isFinite(pending.createdAtMs) ? pending.createdAtMs : null;
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
        "flex gap-2 px-4 hover:bg-surface-hover active:bg-surface-pressed",
        // `press` 는 MessageRow 와 같이 본문 드래그 선택을 접는다. active 는 채움만.
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
      {/* 거터. 확정된 행과 같은 상자다: 이어지는 행의 시계는 거터의 시각이 서는 자리(`right-0 top-0`)에 `absolute`로 앉는다. */}
      <div className={cn("relative shrink-0", MESSAGE_AVATAR_GUTTER_CLASS)}>
        {startsGroup ? (
          <Avatar member={author} className={MESSAGE_AVATAR_SIZE_CLASS} />
        ) : (
          slow && (
            <SlowMark className="pointer-events-none absolute right-0 top-0 flex text-ink-muted" />
          )
        )}
      </div>
      <div className="min-w-0 flex-1">
        {startsGroup && (
          // 확정된 행과 **같은 머리 줄**(`MESSAGE_HEAD_CLASS`, 이름 묶음의 `truncate`까지)이다: 줄바꿈 판정이 다르면 이름이 긴
          // 폭에서 시각이 다음 줄로 꺾이는 쪽이 갈려 교체 때 행 높이가 달라진다.
          <div className={MESSAGE_HEAD_CLASS}>
            {/* `relative`는 보낸 시각을 알 수 없을 때(아래 분기) 시계가 이 묶음 오른쪽에 매달릴 기준 상자다. 오프셋이 없어 배치는 그대로다. */}
            <span className="relative flex min-w-0 items-baseline gap-1">
              <span className="truncate text-body font-semibold text-ink">{name}</span>
              {sentAtMs === null && slow && (
                <SlowMark className="pointer-events-none absolute left-full top-0 ml-1 flex text-ink-muted" />
              )}
            </span>
            {sentAtMs !== null && (
              <time
                dateTime={new Date(sentAtMs).toISOString()}
                data-numeric
                data-testid="pending-time"
                // `relative`: 시계가 이 글자 오른쪽에 `absolute`로 매달린다(폭·높이 0 — 서고 져도 줄이 꺾이지 않는다).
                className="relative text-timestamp text-ink-muted"
              >
                {timeLabel(sentAtMs)}
                {slow && (
                  <SlowMark className="pointer-events-none absolute left-full top-0 ml-1 flex text-ink-muted" />
                )}
              </time>
            )}
          </div>
        )}
        {/* 인용은 본문을 싸는 카드의 윗칸이다(#5381 Q4) — 확정된 행과 같은 카드다. 에코가 카드를 안 그렸다가 seq가
            도착하는 순간 모양이 바뀌면 읽는 사람 눈 아래에서 본문이 움직인다. */}
        <QuoteCardAround quote={quote} directory={directory}>
          {/* Same body renderer as the confirmed row (goal B8 H6): an echo that
              showed raw asterisks and then re-flowed into bold the moment its seq
              landed would move the text under the reader's eye. */}
          <MessageBody
            body={pending.body}
            directory={directory}
            // 흐림은 실패한 행만(#4468). 정상 전송이 흐렸다가 서버 사본에서 진해지면 그것이 색 깜빡임이다.
            muted={failed}
            selfMemberId={pending.authorMemberId}
          />
        </QuoteCardAround>
        {/* 확정된 행과 **같은 카드**를 그린다 (ADR-0151). 바이트는 전송을 누르기
            전에 이미 보관소에 올라가 있으므로, 이 카드는 seq 를 기다리는 동안에도
            거짓이 아니다 — 내려받기 버튼조차 진짜로 동작한다. 인용을 echo 에도
            그리기로 한 것과 같은 이유이기도 하다: 여기서 안 그렸다가 seq 가
            도착하는 순간 자라면 읽는 사람 눈 아래에서 본문이 밀린다. */}
        {(pending.attachments?.length ?? 0) > 0 && (
          <AttachmentList
            channelId={pending.channelId}
            attachments={pending.attachments ?? []}
            senderName={name}
            muted={failed}
          />
        )}
        {failed && (
          <span
            className="flex flex-wrap items-center gap-2 text-meta text-danger"
            data-testid="pending-failed"
          >
            {/* 원인 한 줄(#5221): 닫힌 분류의 완결된 문장이고 상태 코드·서버 원문은 없다. 종류를 모르면 지금까지처럼
                「전송 실패」만 말한다. */}
            <span data-testid="pending-failed-reason" data-failure-kind={failureKind ?? undefined}>
              {failureKind === null
                ? formatMessage("timeline.send.failed")
                : formatMessage(sendFailureReasonKey(failureKind))}
            </span>
            <SendFailureActions
              resending={resending}
              onResend={
                onResend &&
                (() => {
                  setResending(true);
                  void Promise.resolve(onResend(pending.clientMsgId)).finally(
                    () => setResending(false)
                  );
                })
              }
              onDiscard={onDiscard && (() => onDiscard(pending.clientMsgId))}
            />
          </span>
        )}
        {failed && onResendAll && resendAllCount !== undefined && resendAllCount >= 2 && (
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="pending-resend-all"
              aria-busy={resendingAll || undefined}
              onClick={() => {
                if (resendingAll) return;
                setResendingAll(true);
                void Promise.resolve(onResendAll()).finally(() => setResendingAll(false));
              }}
            >
              {formatMessage(CONNECTION_KEYS.resendAll, { count: resendAllCount })}
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
