import { AI_HUB_COPY, AI_HUB_PATH } from "@momo/core/features/ai/aiHubModel";

/** 「AI」 허브 입구(AIH-3). 「에이전트·작업」 구획 맨 위 행. */
export const AI_HUB_NAV = {
  to: AI_HUB_PATH,
  label: AI_HUB_COPY.name,
} as const;

/** Left-rail destinations. Label is what the sidebar row shows. */
export const AGENTS_NAV = {
  to: "/agents",
  label: "에이전트",
} as const;
