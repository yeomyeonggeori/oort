import { SquareTerminal } from "lucide-react";
import type { WorkSessionIdleNotice } from "@momo/core/features/work/workSessionModel";

/**
 * A durable idle reply uses event-tense copy: the current ledger may since have
 * moved to running, ended, or orphaned. The neutral action therefore opens the
 * current session instead of promising that same-PTY attach is still possible.
 */
export function WorkSessionIdleCard({
  notice,
  onOpen,
}: {
  notice: WorkSessionIdleNotice;
  onOpen?: (sessionId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen?.(notice.sessionId)}
      disabled={onOpen === undefined}
      data-testid="work-session-idle-card"
      data-session-id={notice.sessionId}
      className="mt-1 flex w-full max-w-pane-lg flex-col rounded-md border border-line bg-surface-raised text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
    >
      <span className="flex w-full items-center gap-2 border-b border-line px-3 py-2">
        <SquareTerminal aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
        <span className="min-w-0 flex-1 text-body font-medium text-ink">
          작업 세션
        </span>
        <span className="shrink-0 rounded-sm bg-surface-hover px-2 py-px text-timestamp font-medium text-ink-muted">
          {notice.eventLabel}
        </span>
      </span>
      <span className="px-3 py-2 text-meta text-ink-muted">
        이 시각에 작업 도구 실행이 끝나 세션이 대기 상태로 전환됐습니다.
      </span>
      <span className="border-t border-line px-3 py-2 text-meta font-medium text-accent">
        현재 세션 보기
      </span>
    </button>
  );
}
