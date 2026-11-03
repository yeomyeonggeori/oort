import { Button } from "@/design/ui/button";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { CONNECTION_KEYS, type ConnectionPlainKey } from "@momo/core/features/connection/copyKeys";
import { copyForCause, type ConnectionCause } from "@momo/core/features/connection/model";
import { InlineBanner } from "./States";

// =============================================================================
// 불러오기가 실패한 곳 (#5221, #5201 S-C, 감사 문서 §3·§5 W3).
//
// 받아 둔 것이 **없으면** 제목 + 이유 한 줄 + 「다시 시도」 상자(이 파일의 `LoadFailureBox`), **있으면** 상자로 덮지 않고 목록
// 위 한 줄만(`LoadFailureLine`). 읽을 것이 있는데 화면을 비우면 정보를 버리는 일이다.
//
// 이유는 닫힌 분류의 완결된 문장이다(오프라인 / 서버에 닿지 못함 / 그 밖): 상태 코드·서버 원문은 어디에도 없다. 어떤
// 분류인지는 실패한 그 자리의 실패 객체로 정한다(`causeOfFailure`). 화면이 `cause`만 넘기면 문장은 모델의 표
// (`copyForCause`)가 고른다. 말은 이 자리에서만 하고 연결 카드는 되풀이하지 않는다(감사 §4 원칙 3).
//
// 왼쪽 정렬의 조용한 상자다(가운데 정렬 빈 상태 포스터가 아니다, 웹 스킬 §8).
// =============================================================================

export function LoadFailureBox({
  titleKey,
  cause,
  onRetry,
  testId,
}: {
  /** 표면별 제목의 사전 키(`CONNECTION_KEYS.loadConversationTitle` 등). */
  titleKey: ConnectionPlainKey;
  /** 실패가 말하는 원인. 연결 쪽 원인이 아니면 `null`. */
  cause: ConnectionCause | null;
  onRetry: () => void;
  testId?: string;
}) {
  const formatMessage = useFormatMessage();
  return (
    <div
      role="alert"
      data-testid={testId}
      data-cause={cause ?? undefined}
      className="flex break-keep flex-col items-start gap-3 px-4 py-6"
    >
      <p className="text-body font-medium text-ink">{formatMessage(titleKey)}</p>
      <p className="text-body text-ink-muted" data-testid="load-failure-reason">
        {formatMessage(copyForCause(cause).loadReason)}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {formatMessage(CONNECTION_KEYS.retry)}
      </Button>
    </div>
  );
}

/** 받아 둔 글이 있을 때의 한 줄: 내용은 그대로 두고 위에서만 말한다. */
export function LoadFailureLine({
  titleKey,
  onRetry,
  testId,
  className,
}: {
  titleKey: ConnectionPlainKey;
  onRetry: () => void;
  testId?: string;
  className?: string;
}) {
  const formatMessage = useFormatMessage();
  return (
    <InlineBanner
      message={formatMessage(titleKey)}
      actionLabel={formatMessage(CONNECTION_KEYS.retry)}
      onAction={onRetry}
      testId={testId}
      className={className}
    />
  );
}
