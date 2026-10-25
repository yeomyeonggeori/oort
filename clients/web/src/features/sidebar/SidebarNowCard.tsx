import { Link } from "react-router-dom";
import { uuidEq, type AgentLiveness, type Channel } from "@momo/core/lib/api";
import {
  isSystemRun,
  isUncollected,
  isUntakenHumanRun,
  UNCOLLECTED_WORD,
  uncollectedReason,
  waitingLead,
} from "@momo/core/features/agents/runWaiting";
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
  memberFor,
  memberNameParts,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { MemberAvatar } from "@/features/common/MemberAvatar";

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
//
// ## 누가 기다리는 일만 싣는다 (#4285)
//
// 부른 사람이 없는 시스템 작업(환영 run)은 싣지 않는다 — 폰 홈 카드(`buildWorkingCard`)와 같은
// 규칙이다(성재 2026-10-23: 환영 작업이 「대기 1번째 · 5시간째 기다려요」로 홈에 떠 있었다). 사람이
// 부른 요청을 아무도 가져가지 않은 채 5분이 넘으면 낱말이 「아직 받지 않았어요」로 바뀌고, 에이전트에게
// 서버의 생존 경고(D4)가 있으면 짧은 문구가 장소 줄에 붙는다. 사이드바에는 시계가 없으므로 경과
// 시간은 싣지 않는다(「5시간째」는 대화 아래 활동 줄이 말한다). 「취소」는 카드(링크) 안에 둘 수
// 없어 이 카드에는 없다: 대화 아래 활동 줄에서 작업 패널을 열면 있다(`StopRunControl`).
// =============================================================================

export function openTurns(
  signals: ReadonlyMap<string, AgentWorkingSignal>,
  nowMs: number
): AgentWorkingSignal[] {
  const out: AgentWorkingSignal[] = [];
  for (const signal of signals.values()) {
    if (isStaleSignal(signal, nowMs)) continue;
    // 부른 사람이 없는 시스템 작업은 카드의 말이 아니다. 「외 n건」도 숨은 일을 세지 않는다.
    if (isSystemRun(signal.server)) continue;
    out.push(signal);
  }
  return out.sort(byOldestTurn);
}

export interface SidebarNowCardProps {
  signals: ReadonlyMap<string, AgentWorkingSignal>;
  nowMs: number;
  /** The realtime rail is connected, so the claim is confirmed, not remembered. */
  live: boolean;
  directory: Directory;
  channels: readonly Channel[];
  selfMemberId: string;
  /**
   * 카드 에이전트의 서버 생존 판정(D4). 아직 읽는 중이면 undefined, 호스티드가 아니면 null. 아무도
   * 가져가지 않은 요청의 짧은 경고 문구와 이유 문장만 이것을 읽는다. 카드는 읽지 않고 받는다.
   */
  liveness?: AgentLiveness | null;
}

export function SidebarNowCard({
  signals,
  nowMs,
  live,
  directory,
  channels,
  selfMemberId,
  liveness,
}: SidebarNowCardProps) {
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
  // 사람이 부른 요청을 아무도 가져가지 않았다(#4285): 5분을 넘으면 「대기 n번째」 대신 「아직 받지
  // 않았어요」, 서버의 생존 경고가 있으면 짧은 문구가 장소 줄에 붙는다(숫자 없는 낱말 — 사이드바에는
  // 시계가 없다). 이유 문장은 근거가 있을 때만 둘째 줄에 선다.
  const uncollected = lead.state === "queued" && isUncollected(lead.server, nowMs);
  const waitLead =
    lead.state === "queued" && isUntakenHumanRun(lead.server)
      ? waitingLead(liveness, nowMs, "short")
      : undefined;
  const reason = uncollected ? uncollectedReason(liveness) : undefined;
  const stateText = uncollected ? UNCOLLECTED_WORD : (copy?.text ?? "작업 중");
  const accessible = [
    agentLabel(name),
    stateText,
    placeText,
    headline,
    waitLead,
    reason,
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
      data-uncollected={uncollected ? "" : undefined}
      data-live={live ? "" : undefined}
      aria-label={accessible}
    >
      <span className="flex min-w-0 items-center gap-2" aria-hidden="true">
        <MemberAvatar member={memberFor(directory, lead.memberId) ?? null} size="sm" />
        <span className="sidebar-now-name min-w-0 truncate text-ink">
          {name.name}
        </span>
        <span
          className={cn(
            "sidebar-now-state",
            !live
              ? "text-ink-muted"
              : lead.state === "working"
                ? "text-agent"
                : lead.state === "queued"
                  ? "text-ink-muted"
                  : "text-warn"
          )}
          data-testid="sidebar-now-state"
        >
          <span className="sidebar-now-dot" />
          {stateText}
        </span>
      </span>
      {(placeText || headline || waitLead || more > 0) && (
        <span
          className="sidebar-now-line block min-w-0 truncate"
          aria-hidden="true"
          data-testid="sidebar-now-line"
        >
          {[placeText, headline, waitLead].filter(Boolean).join(" · ")}
          {more > 0 ? ` · 외 ${more}건` : null}
        </span>
      )}
      {reason !== undefined && (
        <span
          className="sidebar-now-line block min-w-0 truncate"
          aria-hidden="true"
          data-testid="sidebar-now-reason"
        >
          {reason}
        </span>
      )}
    </Link>
  );
}
