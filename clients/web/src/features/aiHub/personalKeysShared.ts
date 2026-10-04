import type { RosterMember } from "@momo/core/lib/api";
import type { PersonalKey } from "@momo/core/features/ai/personalKeys";
import { AI_HUB_OVERVIEW_COPY } from "@momo/core/features/ai/aiHubModel";

/** 쿼리 키 머리: 발급·회수·에이전트 만들기가 이 머리로 한꺼번에 새로 읽는다. */
export const personalKeysQueryKey = (workspaceId: string, scope: "all" | "mine") =>
  ["ai-hub", "personal-keys", workspaceId, scope] as const;

export const personalKeysQueryPrefix = (workspaceId: string) => ["ai-hub", "personal-keys", workspaceId] as const;

export function companyOfKey(key: Pick<PersonalKey, "format">): string {
  return AI_HUB_OVERVIEW_COPY.providerLabel[key.format];
}

/** 「9월 27일」. */
export function keyDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

/** 키를 받을 수 있는 사람: 활성 사람 멤버, 게스트 아님, 사용 중인 키가 아직 없는 사람. */
export function issuableHolders(roster: readonly RosterMember[], keys: readonly PersonalKey[]): RosterMember[] {
  const holding = new Set(keys.filter((key) => key.status === "active").map((key) => key.ownerMemberId));
  return roster.filter(
    (member) =>
      member.kind === "human" && member.status === "active" && member.role !== "guest" && !holding.has(member.id.toLowerCase())
  );
}
