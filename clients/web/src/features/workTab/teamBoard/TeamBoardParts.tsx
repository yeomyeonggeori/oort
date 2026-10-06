import {
  Bot,
  Check,
  CircleAlert,
  Circle,
  CircleX,
  Eye,
  LoaderCircle,
  SquareDot,
  type LucideIcon,
} from "lucide-react";
import type { SharedSessionState, SharedWorkSession } from "@momo/core/lib/api";
import {
  diffFacts,
  isAgentLane,
  laneLabel,
  stateChipLabel,
} from "@momo/core/features/workbench/teamBoard";
import { CHIP_CLASS } from "@/features/common/chip";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 보드 줄과 드로어가 같이 쓰는 작은 부분 (#2863, 시안 ④ `.chip` `.lane` `.plus/.minus`).
//
// 상태는 **글자와 모양**으로 말한다(색만으로 말하지 않는다, 시안 범례). 색은 토큰만이고,
// 에이전트 레인 표시만 `--agent`를 쓴다(에이전트 정체성, 디자인 취향 §9).
// =============================================================================

const STATE_ICON: Readonly<Record<SharedSessionState, LucideIcon>> = {
  waiting: CircleAlert,
  running: LoaderCircle,
  review: Eye,
  idle: Circle,
  done: Check,
  failed: CircleX,
  stopped: SquareDot,
};

// 칩 그릇은 vessel 넷뿐이다(chipVessel.test.ts): muted·ok·warn·danger. 대비는 tokens.contrast.test.ts가 잰 쌍.
const STATE_TONE: Readonly<Record<SharedSessionState, string>> = {
  waiting: "bg-warn-soft text-warn",
  running: "bg-muted-soft text-ink",
  review: "bg-muted-soft text-ink",
  idle: "bg-muted-soft text-ink-muted",
  done: "bg-ok-soft text-ok",
  failed: "bg-danger-soft text-danger",
  stopped: "bg-danger-soft text-danger",
};

export function StateChip({ item }: { item: SharedWorkSession }) {
  const Icon = STATE_ICON[item.state];
  return (
    <span
      className={cn(
        CHIP_CLASS,
        "inline-flex items-center gap-1",
        STATE_TONE[item.state]
      )}
      data-testid="team-board-state"
      data-state={item.state}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      {stateChipLabel(item)}
    </span>
  );
}

export function LaneLabel({ item }: { item: SharedWorkSession }) {
  const agent = isAgentLane(item);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-timestamp font-medium",
        agent ? "text-agent" : "text-ink-muted"
      )}
      data-testid="team-board-lane"
      data-lane={agent ? "agent" : "local"}
    >
      {agent && <Bot aria-hidden className="size-3 shrink-0" />}
      {laneLabel(item)}
    </span>
  );
}

/** 「+128 −40」. 숫자가 하나도 없으면(에이전트 레인) 아무것도 그리지 않는다. */
export function DiffNumbers({
  item,
  className,
}: {
  item: SharedWorkSession;
  className?: string;
}) {
  const facts = diffFacts(item.diff);
  if (facts === null || (facts.added === null && facts.deleted === null)) {
    return null;
  }
  return (
    <span
      data-numeric
      data-testid="team-board-diff"
      className={cn("shrink-0 font-mono text-timestamp", className)}
    >
      {facts.added !== null && (
        <span className="text-ok">+{facts.added}</span>
      )}
      {facts.added !== null && facts.deleted !== null && " "}
      {facts.deleted !== null && (
        <span className="text-danger">−{facts.deleted}</span>
      )}
    </span>
  );
}
