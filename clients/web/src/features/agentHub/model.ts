import type {
  AgentRunStatus,
  AgentRunSummary,
  MemoryScope,
  RosterMember,
} from "@/lib/api";
import {
  isStaleSignal,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";

export type AgentHubSection = "profile" | "memory" | "history";

export function normalizedId(value: string): string {
  return value.toLowerCase();
}

export function agentMembers(members: readonly RosterMember[]): RosterMember[] {
  return [...members]
    .filter((member) => member.kind === "agent")
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "ko"));
}

export function signalsForAgent(
  signals: ReadonlyMap<string, AgentWorkingSignal>,
  agentMemberId: string,
  nowMs: number
): AgentWorkingSignal[] {
  const target = normalizedId(agentMemberId);
  return [...signals.values()]
    .filter(
      (signal) =>
        normalizedId(signal.memberId) === target &&
        !isStaleSignal(signal, nowMs)
    )
    .sort((left, right) => {
      if (left.state !== right.state) return left.state === "working" ? -1 : 1;
      return (left.startedAtMs ?? Number.POSITIVE_INFINITY) -
        (right.startedAtMs ?? Number.POSITIVE_INFINITY);
    });
}

export function mergeRunPages(
  pages: readonly { runs: readonly AgentRunSummary[] }[]
): AgentRunSummary[] {
  const byId = new Map<string, AgentRunSummary>();
  for (const page of pages) {
    for (const run of page.runs) {
      const key = normalizedId(run.id);
      if (!byId.has(key)) byId.set(key, { ...run, id: key });
    }
  }
  return [...byId.values()];
}

const RUN_STATUS_LABELS: Record<AgentRunStatus, string> = {
  queued: "대기 중",
  running: "실행 중",
  awaiting_approval: "승인 대기",
  paused: "일시정지",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
  timed_out: "시간 초과",
};

export function runStatusLabel(status: AgentRunStatus): string {
  return RUN_STATUS_LABELS[status];
}

const MEMORY_SCOPE_LABELS: Record<MemoryScope, string> = {
  member: "멤버",
  agent: "에이전트",
  workspace: "워크스페이스",
  conversation: "대화",
};

export function memoryScopeLabel(scope: MemoryScope): string {
  return MEMORY_SCOPE_LABELS[scope];
}

const MEMORY_KIND_LABELS: Record<string, string> = {
  fact: "사실",
  preference: "선호",
};

export function memoryKindLabel(kind: string): string {
  return MEMORY_KIND_LABELS[kind] ?? kind;
}

export function canInvalidateMemory(
  role: RosterMember["role"],
  viewerMemberId: string,
  createdByMemberId: string | undefined
): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    (createdByMemberId !== undefined &&
      normalizedId(createdByMemberId) === normalizedId(viewerMemberId))
  );
}
