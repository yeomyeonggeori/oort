import { serverSaysAbsent, serverSurface } from "@momo/core/features/capabilities/serverSurfaces";
import {
  GITHUB_UNAVAILABLE_SENTENCE,
  githubFailureMessage,
  isGithubUnavailable,
} from "@momo/core/features/github/model";
import { isOperatorDenied } from "@momo/core/features/settings/model";
import { InlineBanner } from "@/features/common/States";
import { OperatorNotice } from "@/features/settings/SettingsFields";

// =============================================================================
// 읽기가 실패했을 때의 한 장면 (ADR-0205, #3955). 실패마다 말이 다르다:
//   · 서버에 이 기능이 없다(404·405·501)  → 중립 문장 + 지금 할 수 있는 일. 장애가 아니다.
//   · 소유자·관리자가 아니다(403)         → 누가 하는지 말한다. 다시 시도 버튼은 없다.
//   · 서버에 키가 없다(503)               → 운영자가 설정을 마쳐야 한다. 다시 시도 버튼은 없다.
//   · 그 밖                              → 오류 문장 + 다시 시도.
// 서버가 준 문장은 옮기지 않는다(`githubFailureMessage`).
// =============================================================================

export function GithubLoadFailure({
  error,
  onRetry,
  who = "GitHub 알림은 소유자와 관리자만 정할 수 있어요.",
  testId = "github-load-failure",
}: {
  error: unknown;
  onRetry: () => void;
  who?: string;
  testId?: string;
}) {
  if (serverSaysAbsent(error)) {
    const surface = serverSurface("githubNotifications");
    return (
      <div className="flex min-w-0 flex-col gap-1" data-testid={`${testId}-absent`}>
        <InlineBanner tone="neutral" message={surface.absentReason} testId={testId} />
        <p className="break-keep text-meta text-ink-muted">{surface.fallback}</p>
      </div>
    );
  }
  if (isOperatorDenied(error)) {
    return (
      <OperatorNotice
        who={who}
        contact="필요하면 이 워크스페이스의 소유자나 관리자에게 부탁해 주세요."
      />
    );
  }
  if (isGithubUnavailable(error)) {
    return <InlineBanner tone="neutral" message={GITHUB_UNAVAILABLE_SENTENCE} testId={testId} />;
  }
  return (
    <InlineBanner
      message={githubFailureMessage("load", error)}
      actionLabel="다시 시도"
      onAction={onRetry}
      testId={testId}
    />
  );
}
