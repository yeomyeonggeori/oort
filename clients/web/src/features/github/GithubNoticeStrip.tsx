import { ExternalLink } from "lucide-react";
import { githubNoticeLabel, type GithubNotice } from "@momo/core/features/github/model";
import { StatusChip } from "@/features/settings/SettingsFields";
import { GithubExternalLink } from "./GithubExternalLink";

// =============================================================================
// GitHub 알림 메시지의 아랫줄 (ADR-0205 D4·D10, #3955).
//
// 본문은 서버가 이미 문장으로 썼다(「repo · @login님이 PR을 열었어요」 + 링크). 이 줄은 그 본문을
// 바꾸지 않고 **누가 보낸 말인지**만 덧붙인다: 「GitHub 알림」 칩 하나, 무슨 소식인지, 열 곳.
// 사람인 척하지 않는다는 규칙의 화면 쪽 절반이다. 작성자가 에이전트 「GitHub」가 아니면 줄 자체가
// 서지 않는다(`githubNoticeFor`). 색은 중립이다: 알림은 경고가 아니다.
// =============================================================================

export function GithubNoticeStrip({ notice }: { notice: GithubNotice }) {
  const what = notice.actionLabel === null ? notice.eventLabel : `${notice.eventLabel} ${notice.actionLabel}`;
  return (
    <div
      className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta"
      role="group"
      aria-label={githubNoticeLabel(notice)}
      data-testid="github-notice"
    >
      <StatusChip tone="muted">GitHub 알림</StatusChip>
      <span className="text-ink-muted">{what}</span>
      {notice.url !== null && (
        <GithubExternalLink
          href={notice.url}
          className="press inline-flex items-center gap-1 rounded-sm py-1 text-signal-text underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring"
          data-testid="github-notice-open"
        >
          GitHub에서 열기
          <ExternalLink className="size-4" aria-hidden="true" />
        </GithubExternalLink>
      )}
    </div>
  );
}
