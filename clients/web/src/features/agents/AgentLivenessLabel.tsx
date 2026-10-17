import {
  livenessToneFor,
  livenessView,
  mayActOnLiveness,
  type LivenessTone,
} from "@momo/core/features/agents/liveness";
import { agentDotTone } from "@momo/core/features/presence/statusDot";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { STATUS_DOT_FILL_CLASS } from "@/design/statusDot";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { useAgentLiveness } from "./useAgentLiveness";
import { WakeAgentButton } from "./WakeAgentButton";

// =============================================================================
// 에이전트의 생존 라벨 (ADR-0200 D4, #3749). 멤버 목록·에이전트 헤더·작업 패널이 이 한
// 컴포넌트를 쓴다: 같은 에이전트에 대해 자리마다 다른 말을 하지 않게.
//
// 「연결됨」과 다른 사실이다. 라벨은 서버가 수령·읽기·run 이벤트·ping으로 **지금**
// 파생한 것이고, 서버가 모르는 에이전트(hosted가 아님)에는 아무것도 그리지 않는다.
// 이 칩의 점은 색만으로 상태를 말하지 않는다 — 낱말이 항상 곁에 있다.
//
// 사이드바 DM 행에는 이 칩이 없다 (#3964): 행은 글자 대신 아바타 모서리의 점(`DmAvatar`)이 같은 판정을
// 같은 색 체계로 말한다. 점의 톤은 코어의 한 함수(`agentDotTone`)가 정하고 클래스는 한 맵
// (`design/statusDot.ts`)이 매기므로 칩과 점이 한 상태에 다른 색을 칠할 수 없다(소유자 결정 2026-10-17
// 「Buzz식: 초록=살아 있음, 회색 고리=꺼짐」: 살아 있음·대기도 초록이다. 낱말은 칩이 말한다).
// =============================================================================

const TEXT_CLASS: Readonly<Record<LivenessTone, string>> = {
  ok: "text-ink-muted",
  neutral: "text-ink-muted",
  warn: "text-warn",
};

export function AgentLivenessLabel({
  agentId,
  className,
}: {
  agentId: string | null;
  className?: string;
}) {
  const { liveness, nowMs } = useAgentLiveness(agentId);
  const { session, workspaceId } = useSession();
  const { directory } = useDirectory(workspaceId);
  if (liveness === null || liveness === undefined) return null;
  const view = livenessView(liveness, nowMs);
  // 경고색은 **사람이 할 수 있는 일이 있는 상태**의 색이다. 다시 깨울 수 있는 사람
  // (owner/admin)에게만 경고로 읽히고, 그 밖의 멤버에게는 같은 사실이 중립 낱말이다
  // (할 수 있는 일이 없는 경고는 소음이다, design-review U3 M-3). 규칙은 코어 한 곳이다.
  const mayAct = mayActOnLiveness(memberFor(directory, session.member.id)?.role);
  const tone: LivenessTone = livenessToneFor(view, mayAct);
  // 점의 톤은 아바타 점과 같은 함수다(칩의 글자 색은 아래 `tone`).
  const dotTone = agentDotTone(view, mayAct);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-timestamp",
        TEXT_CLASS[tone],
        className
      )}
      data-testid="agent-liveness"
      data-state={view.state}
      data-tone={tone}
      data-dot-tone={dotTone}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          STATUS_DOT_FILL_CLASS[dotTone]
        )}
      />
      <span className="min-w-0 truncate">{view.text}</span>
      <span className="sr-only">{`${view.text}. ${view.meaning}`}</span>
    </span>
  );
}

/**
 * 라벨과 「다시 깨우기」를 한 덩어리로(에이전트 헤더·작업 패널 머리). 버튼은 owner/admin이
 * 눌러도 되는 상태에서만 서고, 그렇지 않으면 라벨만 남는다.
 */
export function AgentLivenessBar({
  agentId,
  className,
}: {
  agentId: string | null;
  className?: string;
}) {
  const { liveness } = useAgentLiveness(agentId);
  if (agentId === null || liveness === null || liveness === undefined) return null;
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1", className)}
      data-testid="agent-liveness-bar"
    >
      <AgentLivenessLabel agentId={agentId} />
      <WakeAgentButton agentId={agentId} state={liveness.state} />
    </div>
  );
}
