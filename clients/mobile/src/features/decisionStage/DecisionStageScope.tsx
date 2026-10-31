import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, findNodeHandle, Keyboard, View} from 'react-native';
import type {AgentRunProgress, Message} from '@momo/core/lib/api';
import {agentCardModel} from '@momo/core/features/timeline/agentCardModel';
import type {Directory} from '@momo/core/features/workspace/directory';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import {
  gateFor,
  type ApprovalGate,
  type ApprovalReceipt,
} from '../conversation/approvalGate';
import {DecisionStage, type DecisionStageEntry} from './DecisionStage';

import {
  DecisionStageEntryContext,
  type DecisionStageSource,
  type OpenDecisionStage,
} from './openDecisionStage';
import {requestLoopIndex} from '../conversation/requestLoop';
const NO_RUNS: readonly AgentRunProgress[] = [];

export function DecisionStageScope({
  children,
  messages,
  runs = NO_RUNS,
  directory,
  viewerMemberId,
  gates,
  receipts,
  nowMs,
  offline,
  onSettled,
}: {
  children: React.ReactNode;
  messages: readonly Message[];
  runs?: readonly AgentRunProgress[];
  directory: Directory;
  viewerMemberId: string;
  gates: ReadonlyMap<string, ApprovalGate>;
  receipts: ReadonlyMap<string, ApprovalReceipt>;
  nowMs: number;
  offline: boolean;
  onSettled: (approvalId: string, outcome: DecisionOutcome) => void;
}): React.JSX.Element {
  const [request, setRequest] = useState<{
    id: string;
    source?: DecisionStageSource;
    ticket: number;
  } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const opener = useRef<DecisionStageSource | undefined>(undefined);
  useEffect(() => {
    if (request) {
      opener.current = request.source;
      return;
    }
    const source = opener.current;
    opener.current = undefined;
    if (!source) return;
    const frame = requestAnimationFrame(() => {
      const handle = source.current ? findNodeHandle(source.current) : null;
      if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
    });
    return () => cancelAnimationFrame(frame);
  }, [request]);
  const entries = useMemo(() => {
    const index = requestLoopIndex(messages, runs);
    return messages.flatMap(message => {
      if (message.state === 'deleted') return [];
      const card = agentCardModel(message);
      return card?.kind === 'approval' && card.approvalId
        ? [
            {
              id: card.approvalId,
              card,
              gate: gateFor(card, gates),
              receipt: receipts.get(card.approvalId),
              run: index.runForCard.get(message.id.toLowerCase()),
            } satisfies DecisionStageEntry,
          ]
        : [];
    });
  }, [messages, runs, gates, receipts]);
  const openDecisionStage = useCallback<OpenDecisionStage>((id, source) => {
    Keyboard.dismiss();
    setRequest(previous => ({
      id,
      source,
      ticket: (previous?.ticket ?? 0) + 1,
    }));
  }, []);
  return (
    <DecisionStageEntryContext.Provider value={openDecisionStage}>
      <View
        style={FILL}
        accessibilityElementsHidden={request !== null}
        importantForAccessibility={request ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {request ? (
        <DecisionStage
          key={request.ticket}
          entries={entries}
          selectedId={request.id}
          source={request.source}
          directory={directory}
          viewerMemberId={viewerMemberId}
          nowMs={nowMs}
          offline={offline}
          onSettled={(id, outcome) => {
            if (alive.current) onSettled(id, outcome);
          }}
          onClose={() => setRequest(null)}
        />
      ) : null}
    </DecisionStageEntryContext.Provider>
  );
}
const FILL = {flex: 1} as const;
