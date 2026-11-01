import type {AgentRunProgress, Message} from '@momo/core/lib/api';
import {
  agentCardModel,
  type AgentApprovalCard,
} from '@momo/core/features/timeline/agentCardModel';
import {
  requestBundleModel,
  runBundleCanDecide,
  runBundleSnapshot,
} from '@momo/core/features/timeline/requestBundle';
import {
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import type {ApprovalGate, ApprovalReceipt} from './approvalGate';
import {mentionedAgents} from '@momo/core/features/routing/mentionTargets';

/** run 첫 읽기 전의 예약은 실제 에이전트 멘션이 있는 요청에만 해요. */
export function hasAgentRequest(message: Message, directory: Directory): boolean {
  return mentionedAgents(message.body ?? '', [...directory.byId.values()]).length > 0;
}

/** 가산 필드를 보내지 않는 서버는 지금 카드의 모양을 유지해요. */
export function hasRequestBundle(card: AgentApprovalCard): boolean {
  const bundle = card.bundle;
  return (
    !card.isResumeOffer &&
    bundle !== undefined &&
    (bundle.intent !== undefined ||
      bundle.result !== undefined ||
      bundle.decisionMode !== undefined ||
      bundle.canDecide !== undefined ||
      card.action?.rows.some(row => row.after !== undefined) === true)
  );
}

/** 낱말·상태·값은 코어가 정하고, 폰은 현재 원장의 문과 명부만 보태요. */
export function phoneRequestBundle(
  card: AgentApprovalCard,
  directory: Directory,
  viewerMemberId: string | undefined,
  gate: ApprovalGate | null,
  receipt: ApprovalReceipt | undefined,
  nowMs: number,
  offline = false,
  run?: AgentRunProgress,
) {
  const viewer = memberFor(directory, viewerMemberId);
  const status = receipt?.status ?? card.status;
  return requestBundleModel(
    {
      ...card,
      status,
      expiresAtMs: gate?.expiresAtMs ?? card.expiresAtMs,
      bundle: {
        ...card.bundle,
        ...(receipt?.status ? {status: receipt.status} : {}),
      },
    },
    {
      nowMs,
      run,
      viewerMemberId,
      viewerKind: viewer?.kind,
      // 현장의 문(대기 목록·영수증·연결)에 더해, 서버가 이 승인에 대해 보는 사람에게 「못 한다」고
      // 했으면(run 진행 bundle의 `canDecide`) 단추를 거둬요. 「한다」는 단추를 더 세우지 않아요.
      canDecide:
        gate !== null &&
        receipt === undefined &&
        !offline &&
        runBundleCanDecide(run, card.approvalId) !== false,
      nameFor: id => memberFor(directory, id)?.displayName,
      isWorkspaceAdmin: viewer?.role === 'owner' || viewer?.role === 'admin',
    },
  );
}

/** 목록마다 한 번만 짓는 닻. 코어가 읽은 승인 id만 연결 근거로 써요. */
export function requestLoopIndex(
  messages: readonly Message[],
  runs: readonly AgentRunProgress[],
) {
  const byApproval = new Map<
    string,
    {message: Message; card: AgentApprovalCard}
  >();
  for (const message of messages) {
    if (message.type !== 'approval_request' || message.state === 'deleted')
      continue;
    const card = agentCardModel(message);
    if (card?.kind === 'approval' && card.approvalId !== null) {
      byApproval.set(card.approvalId.toLowerCase(), {message, card});
    }
  }
  const entryFor = (run: AgentRunProgress) => {
    const approvalId = runBundleSnapshot(run)?.approvalId ?? run.approvalId;
    return approvalId === undefined
      ? undefined
      : byApproval.get(approvalId.toLowerCase());
  };
  const cardFor = (run: AgentRunProgress) => entryFor(run)?.message;
  const runForCard = new Map<string, AgentRunProgress>();
  for (const run of runs) {
    const card = cardFor(run);
    if (card) runForCard.set(card.id.toLowerCase(), run);
  }
  return {
    cardFor,
    runForCard,
    bundleFor: (run: AgentRunProgress) => {
      return entryFor(run)?.card.bundle ?? runBundleSnapshot(run);
    },
    bundleTargetFor: (run: AgentRunProgress) => {
      const card = cardFor(run);
      return card === undefined ? undefined : {id: card.id, seq: card.seq};
    },
  };
}
