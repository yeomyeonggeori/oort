import { SquareTerminal } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";
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
      className="mt-1 flex w-full max-w-pane-lg flex-col rounded-md border border-line bg-surface-raised text-left hover:bg-surface-hover focus-visible:focus-ring disabled:opacity-50"
    >
      <span className="flex w-full items-center gap-2 border-b border-line px-3 py-2">
        <SquareTerminal aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
        <span className="min-w-0 flex-1 text-body font-medium text-ink">
          작업 세션
        </span>
        {/* 기하를 손으로 다시 적지 않는다 (#1515 회전 2). 앞 판은 `CHIP_CLASS` 와
            **바이트 동일한** 클래스 목록을 직접 적었고, 그래서 이 칩이 칩을 훑는
            가드에 보이지 않았다 — 그 사이 그릇은 `--surface-hover` 였고 이 카드의
            <button> 이 바로 `hover:bg-surface-hover` 다. 가리키는 순간 그릇이
            사라졌다(실측 두 스킴 대비 1.000 · OKLab 거리 0.0000). */}
        <span
          data-testid="work-session-idle-chip"
          className={cn(CHIP_CLASS, "bg-muted-soft text-ink-muted")}
        >
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
