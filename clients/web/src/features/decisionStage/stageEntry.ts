import type { Member, AgentRunProgress, Message } from "@momo/core/lib/api";
import { fetchMessages } from "@momo/core/lib/api";
import { agentCardModel, resolveApprovalStatus, type AgentApprovalCard } from "@momo/core/features/timeline/agentCardModel";
import { approvalHeadTitle } from "@momo/core/features/timeline/agentInitiative";
import { requestBundleModel, runBundleSnapshot, type RequestBundleContext } from "@momo/core/features/timeline/requestBundle";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { decisionNote } from "@/features/inbox/approvalsPanel";
import { rememberSettledApproval, settledApprovalFor, type SettledReceipt } from "@/features/timeline/settledApprovals";
import { decisionStageSnapshot, openDecisionStage, type DecisionStageEntry, type DecisionStageRequest } from "./openDecisionStage";

/** ApprovalBody와 무대는 같은 명부·서버 권한·옛 카드 폴백을 읽어요. */
export function approvalBundleContext(card: Pick<AgentApprovalCard, "bundle">, member: Member, directory: Directory): Omit<RequestBundleContext, "nowMs"> {
  const viewer = memberFor(directory, member.id) ?? member;
  const role = memberFor(directory, member.id)?.role;
  return {
    viewerMemberId: member.id,
    viewerKind: viewer.kind,
    canDecide: card.bundle?.canDecide ?? true,
    isWorkspaceAdmin: role === "owner" || role === "admin",
    nameFor: (id) => memberFor(directory, id)?.displayName,
  };
}

export function approvalBundleCard(card: AgentApprovalCard, receipt: SettledReceipt | null = settledApprovalFor(card.approvalId)): AgentApprovalCard {
  const status = resolveApprovalStatus(receipt?.status ?? null, card.status);
  return {
    ...card, title: approvalHeadTitle(card), status,
    decidedByMemberId: receipt?.decidedByMemberId ?? card.decidedByMemberId,
    ...(card.bundle ? { bundle: { ...card.bundle, ...(receipt ? { status } : {}) } } : {}),
  };
}

function settlement(cards: readonly DecisionStageEntry[]): NonNullable<DecisionStageRequest["onSettled"]> {
  return (id, outcome) => {
    if (outcome.kind === "error") return;
    const card = cards.find((entry) => entry.id === id)?.card;
    // 원래 카드와 같은 결정 영수증. 1회 값은 무대의 state에만 남아요.
    rememberSettledApproval(card?.approvalId, {
      status: outcome.status ?? "pending", decidedAtMs: outcome.decidedAtMs,
      decidedByMemberId: outcome.decidedByMemberId, note: decisionNote(outcome).text,
    });
  };
}

export function openApprovalDecisionStage({ card, member, directory, workspaceId, opener, source }: {
  card: AgentApprovalCard; member: Member; directory: Directory; workspaceId: string;
  opener: HTMLElement | null; source: () => HTMLElement | null;
}) {
  const context = approvalBundleContext(card, member, directory);
  const prepared = approvalBundleCard(card);
  if (!requestBundleModel(prepared, { ...context, nowMs: Date.now() }).canDecide) return;
  const cards = [{ id: card.approvalId!, card: prepared }];
  openDecisionStage({ workspaceId, cards, context, selectedId: cards[0].id, opener, source, onSettled: settlement(cards) });
}

/** 서버가 decision_mode를 안 보내는 동안에도 칩·요약 줄은 실제 카드를 찾아 열어요. */
export function openRunDecisionStage({ runs, member, directory, workspaceId, channelId, triggerSeq, opener, fallback }: {
  runs: readonly AgentRunProgress[]; member: Member; directory: Directory; workspaceId: string;
  channelId: string; triggerSeq: number; opener: HTMLElement | null; fallback: () => void;
}) {
  const source = (id: string) => Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((node) => node.dataset.messageId === id.toLowerCase())?.querySelector<HTMLElement>('[data-testid="agent-card"]')
    ?? (opener?.isConnected ? opener.closest<HTMLElement>("[data-message-id]") ?? opener : null);
  const context = approvalBundleContext({}, member, directory);
  const controller = openDecisionStage({ workspaceId, cards: [], context, loading: true, opener, source, onRetry: () => { void load(); },
    onSettled: (id, outcome) => settlement(entries)(id, outcome) });
  const ticket = decisionStageSnapshot()!.ticket;
  let entries: DecisionStageEntry[] = [];
  const current = () => { const snapshot = decisionStageSnapshot(); return snapshot?.ticket === ticket && snapshot.open; };
  async function load() {
    controller.update({ loading: true, error: null });
    try {
      const approvalIds = new Set(runs.flatMap((run) => [run.approvalId, runBundleSnapshot(run)?.approvalId].filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase())));
      const runIds = new Set(runs.map((run) => run.id.toLowerCase()));
      const found = new Map<string, DecisionStageEntry>();
      const collect = (messages: Message[]) => {
        for (const message of messages) {
          const card = agentCardModel(message);
          if (card?.kind !== "approval" || card.isResumeOffer || !card.approvalId) continue;
          const runId = message.props?.run_id ?? message.props?.runId;
          if (!approvalIds.has(card.approvalId.toLowerCase()) && !(typeof runId === "string" && runIds.has(runId.toLowerCase()))) continue;
          const prepared = approvalBundleCard(card);
          if (requestBundleModel(prepared, { ...approvalBundleContext(card, member, directory), nowMs: Date.now() }).canDecide) {
            found.set(card.approvalId.toLowerCase(), { id: message.id, card: prepared });
          }
        }
      };
      // 기존 채널 history는 본류와 답글을 함께 읽어요. DM 카드도 같은 경로예요.
      let after = triggerSeq;
      while (true) {
        const page = await fetchMessages(workspaceId, channelId, { after, limit: 200 });
        if (!current()) return;
        collect(page.messages);
        const next = Math.max(after, ...page.messages.map((message) => message.seq));
        if (page.messages.length < 200 || next <= after) break;
        after = next;
      }
      entries = [...found.values()];
      if (entries.length === 0) { controller.close(); fallback(); return; }
      controller.update({ cards: entries, context: approvalBundleContext(entries[0].card, member, directory), loading: false });
    } catch {
      controller.update({ loading: false, error: "결정할 카드를 불러오지 못했어요. 다시 불러와 주세요." });
    }
  }
  void load();
}
