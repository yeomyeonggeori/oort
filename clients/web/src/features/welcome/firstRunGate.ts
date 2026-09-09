import { peekFreshSignup } from "./freshSignup";
import { firstAgentIsPending } from "./firstAgentStore";
import { FIRST_AGENT_STAGE_ORDER } from "./firstAgent";

// =============================================================================
// 로그인 뒤 first-run 게이트 (#2216).
//
// 킥오프는 웰컴 채널에 산다. 그 홀드가 풀리기 전에는 앱을 열어 킥오프가
// 재생되게 하고, 그 다음 첫 에이전트, 그 다음 폰 연결.
// =============================================================================

export type FirstRunSurface =
  | "kickoff-hold"
  | "first-agent"
  | "phone-link"
  | "app";

const listeners = new Set<() => void>();

let kickoffSettled = peekFreshSignup() === null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeFirstRun(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function peekKickoffSettled(): boolean {
  return kickoffSettled || peekFreshSignup() === null;
}

export function holdKickoffForFreshSignup(): void {
  kickoffSettled = false;
  emit();
}

export function settleKickoffHold(): void {
  if (kickoffSettled) return;
  kickoffSettled = true;
  emit();
}

export function resetKickoffHoldForTests(): void {
  kickoffSettled = peekFreshSignup() === null;
  emit();
}

export function snapshotFirstRun(): boolean {
  return peekKickoffSettled();
}

export function decideFirstRun(input: {
  kickoffSettled: boolean;
  firstAgentPending: boolean;
  phonePending: boolean;
}): FirstRunSurface {
  if (!input.kickoffSettled) return "kickoff-hold";
  if (input.firstAgentPending) return "first-agent";
  if (input.phonePending) return "phone-link";
  return "app";
}

export function decideFirstRunForSession(input: {
  workspaceId: string;
  phonePending: boolean;
}): FirstRunSurface {
  return decideFirstRun({
    kickoffSettled: peekKickoffSettled(),
    firstAgentPending: firstAgentIsPending(input.workspaceId),
    phonePending: input.phonePending,
  });
}

export function firstRunStageOrder(): readonly string[] {
  return FIRST_AGENT_STAGE_ORDER;
}
