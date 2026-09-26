import { Bot } from "lucide-react";
import { Link } from "react-router-dom";
import { uuidEq, type Channel } from "@momo/core/lib/api";
import {
  byOldestTurn,
  isStaleSignal,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";
import {
  agentLabel,
  agentTurnBadgeCopy,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
} from "@/features/agents/turnCopy";
import {
  channelLabelParts,
  memberNameParts,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 작업 중 카드 (DS2-6 #2718, 시안 A `.a-side .a-now`).
//
// 사이드바에서 「지금 일하고 있는 에이전트」를 채널 목록보다 먼저 말한다. 재료는
// 채널 행의 알약과 같은 가게(`useAgentWorkingSignals`)라 둘이 다르게 말할 수
// 없다. 이 카드가 더하는 것은 **어디서**(채널)와 **무엇을**(에이전트가 쓴 마지막
// 줄)이다.
//
// 시안과 다른 것 둘 (PR 「시안과의 차이」):
//   - 진행 3분할 막대가 없다. 신호에는 단계 수가 없다(`AgentWorkingSignal`).
//     재지 않은 2/3을 그리면 막대가 거짓말을 한다(SKILL §8).
//   - 「작업 중」 점이 깜빡이지 않는다. 사이드바에는 시계도 박동도 없다
//     (Sidebar.tsx 「No clock in the sidebar at all」). 상태는 낱말이 말한다.
//
// 열린 턴이 여럿이면 가장 오래된 하나를 싣고 나머지는 수로 센다. 카드 전체가
// 그 채널로 가는 링크다. 열린 턴이 없으면 아무것도 그리지 않는다.
// =============================================================================

export function openTurns(
  signals: ReadonlyMap<string, AgentWorkingSignal>,
  nowMs: number
): AgentWorkingSignal[] {
  const out: AgentWorkingSignal[] = [];
  for (const signal of signals.values()) {
    if (isStaleSignal(signal, nowMs)) continue;
    out.push(signal);
  }
  return out.sort(byOldestTurn);
}

export function SidebarNowCard({
  signals,
  nowMs,
  live,
  directory,
  channels,
  selfMemberId,
}: {
  signals: ReadonlyMap<string, AgentWorkingSignal>;
  nowMs: number;
  /** The realtime rail is connected, so the claim is confirmed, not remembered. */
  live: boolean;
  directory: Directory;
  channels: readonly Channel[];
  selfMemberId: string;
}) {
  const turns = openTurns(signals, nowMs);
  if (turns.length === 0) return null;
  const lead = turns[0];
  const name = memberNameParts(directory, lead.memberId, UNKNOWN_AGENT_NAME);
  const copy = agentTurnBadgeCopy([lead], (memberId) =>
    memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME)
  );
  const channel = channels.find((c) => uuidEq(c.id, lead.channelId));
  const place = channel
    ? channelLabelParts(channel, directory, selfMemberId)
    : null;
  const placeText = place
    ? channel?.kind === "dm"
      ? place.text
      : `#${place.text}`
    : null;
  const headline =
    lead.state === "working" && lead.headlines.length > 0
      ? lead.headlines[0]
      : null;
  const more = turns.length - 1;
  const stateText = copy?.text ?? "작업 중";
  const accessible = [
    agentLabel(name),
    stateText,
    placeText,
    headline,
    more > 0 ? `외 ${more}건` : null,
    live ? null : TURN_STALE_SENTENCE,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Link
      to={`/c/${lead.channelId}`}
      className="glass band-surface sidebar-now press focus-visible:focus-ring"
      data-testid="sidebar-now-card"
      data-state={lead.state}
      data-live={live ? "" : undefined}
      aria-label={accessible}
    >
      <span className="flex min-w-0 items-center gap-2" aria-hidden="true">
        <span className="sidebar-now-agent">
          <Bot />
        </span>
        <span className="sidebar-now-name min-w-0 truncate text-agent">
          {name.name}
        </span>
        <span
          className={cn(
            "sidebar-now-state",
            !live
              ? "text-ink-muted"
              : lead.state === "working"
                ? "text-agent"
                : "text-warn"
          )}
          data-testid="sidebar-now-state"
        >
          <span className="sidebar-now-dot" />
          {stateText}
        </span>
      </span>
      {(placeText || headline || more > 0) && (
        <span
          className="sidebar-now-line block min-w-0 truncate"
          aria-hidden="true"
          data-testid="sidebar-now-line"
        >
          {[placeText, headline].filter(Boolean).join(" · ")}
          {more > 0 ? ` · 외 ${more}건` : null}
        </span>
      )}
    </Link>
  );
}
