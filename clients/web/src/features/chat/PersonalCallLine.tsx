import { CALL_NOT_DELIVERED } from "@momo/core/features/auth/personalAgentCall";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { previewFor, type PersonalCallSpec } from "@/features/work/personalAgentCalling";
import type { CallNotice } from "@/features/chat/usePersonalCall";

// 보내기 전 한 줄(도착지)과 보낸 뒤 한 줄(결과). 입력창 바로 위, 다른 안내 줄과 같은 폭·글자다.
// 도착지를 모르는 채 일을 시키지 않게 하는 줄이고(ADR-0198 D7), 보낸 뒤에는 서버가 아닌
// 이 기기가 아는 사실(맥 꺼짐·서명 키 없음)을 사람 말로 한 번 말한다.

export const CALL_SENT_LINE = "내 맥에 보냈어요. 시작하면 이 대화에 작업 카드가 떠요.";
export const CALL_REPLAYED_LINE = "이미 보낸 호출이에요. 작업 카드를 확인해 주세요.";
export const CALL_RETRYING_LINE = "같은 요청을 다시 보내는 중이에요.";

const ROW = "flex min-h-8 flex-wrap items-center gap-x-2 px-4 py-1 text-meta";

export function PersonalCallPreview({ spec }: { spec: Pick<PersonalCallSpec, "agent" | "host" | "signer" | "audience"> }) {
  const preview = previewFor(spec);
  const readers = preview.audience === "channel" ? "이 채널 멤버가 요청과 답을 읽어요" : "이 대화 상대만 읽어요";
  return (
    <p
      role="status"
      className={cn(ROW, preview.blocked === null ? "text-ink-muted" : "text-warn")}
      data-testid="composer-call-preview"
    >
      {preview.destination !== null ? (
        <>
          <span className="font-medium text-ink" data-testid="composer-call-destination">
            {preview.destination}
          </span>
          <span>{readers}</span>
        </>
      ) : (
        <span data-testid="composer-call-blocked">{preview.blocked}</span>
      )}
    </p>
  );
}

export function PersonalCallNotice({
  notice,
  onRetry,
  onDismiss,
}: {
  notice: CallNotice;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { call } = notice;
  let text: string;
  let tone: "ok" | "warn";
  if (notice.retrying) {
    text = CALL_RETRYING_LINE;
    tone = "ok";
  } else if (call.state === "called") {
    text = call.replayed ? CALL_REPLAYED_LINE : CALL_SENT_LINE;
    tone = "ok";
  } else if (call.state === "message_only") {
    text = call.text;
    tone = "warn";
  } else {
    text = call.text;
    tone = "warn";
  }
  const canRetry = !notice.retrying && call.state === "not_delivered" && call.signed !== null;
  return (
    <div
      role="status"
      className={cn(ROW, tone === "warn" ? "text-warn" : "text-ink-muted")}
      data-testid="composer-call-notice"
      data-state={notice.retrying ? "retrying" : call.state}
    >
      {call.state === "not_delivered" && !notice.retrying && (
        <span className="font-medium" data-testid="composer-call-label">
          {CALL_NOT_DELIVERED}
        </span>
      )}
      <span data-testid="composer-call-text">{text}</span>
      {canRetry && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onRetry}
          data-testid="composer-call-retry"
        >
          다시 불러요
        </Button>
      )}
      {!notice.retrying && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="안내 닫기"
          data-testid="composer-call-dismiss"
        >
          닫기
        </Button>
      )}
    </div>
  );
}
