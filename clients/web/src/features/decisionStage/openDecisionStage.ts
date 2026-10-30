import type { AgentApprovalCard } from "@momo/core/features/timeline/agentCardModel";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import type { RequestBundleContext } from "@momo/core/features/timeline/requestBundle";
import type { StageSource } from "@/features/attachments/useStageHero";
import type { DialogFocusTarget } from "@/design/ui/dialog";

export interface DecisionStageEntry {
  id: string;
  /** agentCardModel이 읽은 공개 필드만 받아요. 원본 payload를 넘기지 않아요. */
  card: AgentApprovalCard;
}

export interface DecisionStageRequest {
  workspaceId: string;
  cards: readonly DecisionStageEntry[];
  context: Omit<RequestBundleContext, "nowMs">;
  selectedId?: string;
  opener: DialogFocusTarget | null;
  /** 매번 현재 위치를 찾아요. 없어진 카드는 hero 부품의 안전한 폴백을 따라요. */
  source?: StageSource;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onSettled?: (id: string, outcome: DecisionOutcome) => void;
}

type StageSnapshot = { request: DecisionStageRequest; open: boolean; ticket: number };
let snapshot: StageSnapshot | null = null;
let ticket = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** 셸에 DecisionStageHost를 한 번 놓고 호출해요. 카드 렌더와 무대의 연결점이에요. */
export function openDecisionStage(request: DecisionStageRequest) {
  const currentTicket = ++ticket;
  snapshot = { request, open: true, ticket: currentTicket };
  emit();
  return {
    /** 구독 중인 목록·권한이 바뀌면 같은 무대에 새 스냅샷을 넘겨요. */
    update(patch: Partial<Pick<DecisionStageRequest, "cards" | "context" | "loading" | "error">>) {
      if (snapshot?.ticket !== currentTicket || !snapshot.open) return;
      snapshot = { ...snapshot, request: { ...snapshot.request, ...patch } };
      emit();
    },
    close() { closeDecisionStage(currentTicket); },
  };
}

export function closeDecisionStage(currentTicket: number): void {
  if (snapshot?.ticket !== currentTicket || !snapshot.open) return;
  // 닫힌 인스턴스를 보존해 useStageHero의 분리된 exit snapshot이 끝나게 해요.
  snapshot = { ...snapshot, open: false };
  emit();
}

export const decisionStageSnapshot = () => snapshot;
export function subscribeDecisionStage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
