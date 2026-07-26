import { useEffect, useState } from "react";
import type { MentionRoutingTarget } from "./mentionTargets";
import { INHERIT_DRAFT, type RoutingDraft } from "./routingModel";

export interface MentionRouting {
  draft: RoutingDraft;
  reset: () => void;
}

/**
 * 컴포저가 들고 있는 1회 오버라이드 상태.
 *
 * 멘션 대상이 바뀌면 초안을 비운다. hermes에게 고른 강도가 김인턴에게 그대로
 * 따라가면, 사람은 자기가 고른 적 없는 값을 보낸다.
 */
export function useMentionRouting(target: MentionRoutingTarget): {
  draft: RoutingDraft;
  setDraft: (next: RoutingDraft) => void;
  reset: () => void;
} {
  const [draft, setDraft] = useState<RoutingDraft>(INHERIT_DRAFT);
  const targetId = target.kind === "one" ? target.agent.id.toLowerCase() : null;
  useEffect(() => {
    setDraft(INHERIT_DRAFT);
  }, [targetId]);
  return {
    draft,
    setDraft,
    reset: () => setDraft(INHERIT_DRAFT),
  };
}
