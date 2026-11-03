import { Button } from "@/design/ui/button";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { deviceOnlineNow } from "@/lib/deviceOnline";
import { CONNECTION_KEYS, type ConnectionPlainKey } from "@momo/core/features/connection/copyKeys";
import { causeOfFailure } from "@momo/core/features/connection/failure";
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

// -----------------------------------------------------------------------------
// 남은 「불러오지 못했습니다」 자리들 (#5242, #5221 후속).
//
// 자리가 통째로 비는 곳(목록·상세·창 본문, 받아 둔 것 없음)은 위의 상자, 카드·설정 행·좁은 자리는 아래의 한 줄(`LoadFailureNote`)이다.
// 둘은 같은 제목 키와 같은 이유 표(`copyForCause`)를 읽는다: 무엇을 못 불러왔고(제목) 왜이며 무엇을 하면 되는지(이유)를 닫힌 분류의
// 완결된 문장으로 말하고, 상태 코드·서버 원문은 어디에도 없다. 실패한 그 자리의 오류 객체가 없으면(`isError`만 아는 자리) 원인은 `null`이고
// 이유는 「문제가 생겼어요」다.
// -----------------------------------------------------------------------------

/** 이 자리의 오류 객체 하나가 말하는 원인. 렌더 때 기기 온라인 여부를 읽는다(S-C 상자 자리들과 같다). */
export function loadCauseOf(error: unknown): ConnectionCause | null {
  return causeOfFailure(error, deviceOnlineNow());
}

type FormatMessage = ReturnType<typeof useFormatMessage>;

/** 제목 + 이유를 한 문장 묶음으로(`"{title}. {reason}"`의 언어별 틀). 문자열만 받는 자리(설명·aria)에도 쓴다. */
export function loadFailureSentence(
  formatMessage: FormatMessage,
  titleKey: ConnectionPlainKey,
  cause: ConnectionCause | null
): string {
  return formatMessage(CONNECTION_KEYS.loadSentence, {
    title: formatMessage(titleKey),
    reason: formatMessage(copyForCause(cause).loadReason),
  });
}

/**
 * 상자가 맞지 않는 좁은 자리의 **원인 한 줄**: 옛 `InlineBanner`가 서던 그 자리에 그대로 서고(같은 배너·같은 여백 규칙),
 * 문장만 제목 + 이유 한 벌이 된다. 단추가 없는 자리는 `onRetry`를 생략한다(문장은 그대로다).
 */
export function LoadFailureNote({
  titleKey,
  cause,
  onRetry,
  actionBusy,
  separator,
  className,
  testId,
}: {
  titleKey: ConnectionPlainKey;
  cause: ConnectionCause | null;
  onRetry?: () => void;
  actionBusy?: boolean;
  separator?: boolean;
  className?: string;
  testId?: string;
}) {
  const formatMessage = useFormatMessage();
  return (
    <InlineBanner
      message={loadFailureSentence(formatMessage, titleKey, cause)}
      actionLabel={onRetry ? formatMessage(CONNECTION_KEYS.retry) : undefined}
      onAction={onRetry}
      actionBusy={actionBusy}
      separator={separator}
      className={className}
      testId={testId}
    />
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
