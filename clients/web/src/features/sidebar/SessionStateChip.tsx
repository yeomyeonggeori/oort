import type { SessionStatus } from "@momo/core/features/workbench/sessionList";
import { SESSION_STATUS_LABEL } from "@momo/core/features/workbench/sessionList";
import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";

// =============================================================================
// 세션 줄의 글자 칩 (#3338, 시안 `?panel=grammar` 「세션 줄 상태」): 실행 중 · 응답 필요 · 끝남 · 대기.
// 상태는 **글자**가 말한다. 색은 거들 뿐이고 박동·회전이 없다(사이드바에는 시계가 없다).
//
// 그릇은 칩 그릇 규칙(`chipVessel.test.ts`)이 허용한 넷(muted·ok·warn·danger)만 쓴다. 시안은
// 응답 필요를 `--signal-soft`로 그렸지만 그 값은 선택 행의 채움(`--accent-soft`)과 같은 토큰이라
// 칩이 행 바탕에 묻힌다 — 그래서 이미 쓰이던 `--warn-soft` 그릇을 쓴다(PR 「시안과의 차이」).
// 호박(`--signal`)은 안 읽음 알약의 색이라 칩이 그것을 입으면 「안 읽음」으로 읽히기도 한다.
// 글자색의 `--agent`는 실행 중이 에이전트·로컬 세션의 일임을 말하는 기존 어휘다.
//
// 내 작업 목록(`SessionList`)·팀 작업 목록(`SidebarTeamSessions`)·구획 B의 지금 도는 세션 줄이
// 전부 이 컴포넌트를 읽는다: 같은 상태가 목록마다 다른 말·다른 색으로 그려질 수 없다.
// =============================================================================

const TONE: Readonly<Record<SessionStatus, string>> = {
  waiting: "bg-warn-soft text-warn",
  running: "bg-muted-soft text-agent",
  review: "bg-muted-soft text-ink",
  idle: "bg-muted-soft text-ink-muted",
  done: "bg-ok-soft text-ok",
  stopped: "bg-danger-soft text-danger",
};

export function SessionStateChip({
  status,
  label,
  testId = "session-state-chip",
}: {
  status: SessionStatus;
  /** 기본은 상태 어휘(`SESSION_STATUS_LABEL`). 「끝남 · PR」처럼 목록이 덧붙일 때만 넘긴다. */
  label?: string;
  testId?: string;
}) {
  return (
    <span
      className={cn(CHIP_CLASS, "inline-flex items-center", TONE[status])}
      data-status={status}
      data-testid={testId}
    >
      {label ?? SESSION_STATUS_LABEL[status]}
    </span>
  );
}
