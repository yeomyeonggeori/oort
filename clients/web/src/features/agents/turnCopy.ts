// =============================================================================
// The turn vocabulary moved to `@momo/core/features/agents/turnCopy` in goal
// RN-T2, for the reason recorded in that file: the phone grew the same two
// surfaces and a second copy of the words 작업 중 / 승인 대기 is the drift this
// module exists to prevent.
//
// Nothing about the strings changed. This file re-exports them verbatim so
// every caller here keeps importing from where it always did — the same shape
// `agentWorkingSignal.ts` took when RN-A1 moved the rules out from under it.
// =============================================================================

export {
  activityLines,
  activitySuffix,
  activityText,
  agentLabel,
  agentLabelAsSubject,
  agentTurnBadgeCopy,
  MAX_ACTIVITY_LINES,
  turnSummary,
  UNKNOWN_AGENT_NAME,
  type AgentActivityLine,
  type AgentActivityList,
  type AgentNameLookup,
  type AgentNameParts,
  type AgentTurnBadgeCopy,
} from "@momo/core/features/agents/turnCopy";
