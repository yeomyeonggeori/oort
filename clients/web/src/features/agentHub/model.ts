import type {
  AgentProfile,
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

// ---- 프로필 카드: 모델 · 추론 강도 · 상태 ------------------------------------
//
// Three facts a person checks before they mention an agent, and each of them can
// be UNKNOWN rather than absent. The distinction is the whole point of these
// three functions: "기본값 사용"과 "확인하지 못함"은 다른 말이고, 후자를 전자로
// 적으면 화면이 서버가 한 적 없는 말을 하게 된다.

/** What this agent is running now. `null` profile = 아직 읽지 못한 상태. */
export function effectiveModelLabel(
  profile: AgentProfile | null,
  agent: RosterMember
): string {
  const inherited = agent.agentModel?.trim() ?? "";
  const preferred = profile?.modelPref?.trim() ?? "";
  if (preferred !== "") return preferred;
  if (inherited !== "") return `${inherited} (에이전트 기본)`;
  return "지정된 모델 없음";
}

/**
 * 추론 강도. `effortPref`가 없는 것은 두 가지 뜻일 수 있다 — 고르지 않았거나,
 * 이 서버가 그 축을 모르거나. 후자를 아는 것은 capability 판정뿐이라, 이 함수는
 * 그 판정을 인자로 받는다.
 */
export function effectiveEffortLabel(
  profile: AgentProfile | null,
  effortAxisReady: boolean
): string {
  const effort = profile?.effortPref?.trim() ?? "";
  if (effort !== "") return effort;
  if (!effortAxisReady) return "이 서버에는 추론 강도 축이 없음";
  return "모델 기본값";
}

/**
 * 상태 한 단어. 순서가 곧 정확도다: 멤버십 정지가 프로필의 일시정지를 이기고,
 * 프로필을 읽지 못한 상태는 "활성"이라고 말하지 않는다.
 */
export function lifecycleLabel(
  agent: RosterMember,
  profile: AgentProfile | null,
  profilePending: boolean,
  profileFailed: boolean
): string {
  if (agent.status !== "active") return "사용 중지";
  if (profilePending) return "상태 확인 중";
  if (profileFailed) return "상태 확인 실패";
  return profile?.paused ? "일시정지" : "활성";
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
