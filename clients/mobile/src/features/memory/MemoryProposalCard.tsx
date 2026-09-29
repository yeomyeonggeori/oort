import type {MembershipRole} from '@momo/core/lib/api';
import type {
  MemoryEvidenceLink,
  MemoryProposal,
  MemoryProposalEvidence,
} from '@momo/core/features/memory/model';
import {memberFor} from '@momo/core/features/workspace/directory';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {font, line, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {
  PROPOSAL_ACCEPT,
  PROPOSAL_ACCEPTED,
  PROPOSAL_ACCEPT_A11Y,
  PROPOSAL_BUSY,
  PROPOSAL_DESKTOP_HINT,
  PROPOSAL_EVIDENCE_LABEL,
  PROPOSAL_EVIDENCE_LOADING,
  PROPOSAL_EVIDENCE_UNREADABLE,
  PROPOSAL_EXPIRED,
  PROPOSAL_FAILED,
  PROPOSAL_FORBIDDEN,
  PROPOSAL_GUEST,
  PROPOSAL_KIND_LABEL,
  PROPOSAL_REJECT,
  PROPOSAL_REJECTED,
  PROPOSAL_REJECT_A11Y,
  PROPOSAL_SELF_WARNING,
  PROPOSAL_STALE,
  PROPOSAL_TITLE,
  proposalEvidenceA11y,
  proposalEvidenceLine,
} from './copy';
import {
  proposalErrorOutcome,
  proposalView,
  type ProposalOutcome,
  type ProposalView,
} from './model';
import {
  useDecideProposal,
  useProposalEvidenceText,
  useRunMemoryProposals,
} from './queries';

// =============================================================================
// 「기억해 둘게요」 제안 카드 (plan.md §5 V3 / ADR-0196 D4 증보) — 에이전트 답 아래.
//
// 에이전트는 제안만 한다. 기억이 되는 것은 사람이 「기억하기」를 누른 뒤다. 카드는
// 서버가 내린 판단(누가 결정할 수 있는가)을 다시 하지 않는다 — 워크스페이스 게스트는
// 눌러 볼 버튼 없이 읽기만 하고, 그 밖의 거부는 응답(403·409)이 갈래를 정한다.
// 갈래를 고르는 순수 함수는 `proposalView`(model.ts)다.
// =============================================================================

/** 이 run의 답 아래에 세우는 카드들. 제안이 없거나 못 읽으면 아무것도 그리지 않는다. */
export function MemoryProposalCards({
  workspaceId,
  channelId,
  runId,
  directory,
  role,
  onOpenEvidence,
}: {
  workspaceId: string;
  channelId: string;
  runId: string;
  directory: Directory;
  role: MembershipRole | undefined;
  onOpenEvidence?: (link: MemoryEvidenceLink) => void;
}): React.JSX.Element | null {
  const proposals = useRunMemoryProposals(workspaceId, channelId, runId);
  const rows = proposals.data ?? [];
  if (rows.length === 0) return null;
  return (
    <View style={cardStackStyle} testID="memory-proposals">
      {rows.map(proposal => (
        <MemoryProposalCard
          key={proposal.id}
          proposal={proposal}
          workspaceId={workspaceId}
          directory={directory}
          role={role}
          onOpenEvidence={onOpenEvidence}
        />
      ))}
    </View>
  );
}

const cardStackStyle = {gap: space.sm, marginTop: space.sm} as const;

export function MemoryProposalCard({
  proposal,
  workspaceId,
  directory,
  role,
  nowMs,
  onOpenEvidence,
}: {
  proposal: MemoryProposal;
  workspaceId: string;
  directory: Directory;
  role: MembershipRole | undefined;
  nowMs?: number;
  onOpenEvidence?: (link: MemoryEvidenceLink) => void;
}): React.JSX.Element {
  const decide = useDecideProposal(workspaceId);
  const [outcome, setOutcome] = useState<ProposalOutcome>('none');
  const [failed, setFailed] = useState(false);
  const view = proposalView({
    proposal,
    role,
    outcome,
    failed,
    nowMs: nowMs ?? Date.now(),
  });
  const busy = decide.isPending;
  const press = (decision: 'accept' | 'reject') => {
    if (busy) return;
    setFailed(false);
    decide.mutate(
      {id: proposal.id, decision},
      {
        onSuccess: () => setOutcome(decision === 'accept' ? 'accepted' : 'rejected'),
        onError: error => {
          const next = proposalErrorOutcome(error);
          if (next === 'failed') setFailed(true);
          else setOutcome(next);
        },
      },
    );
  };
  return (
    <MemoryProposalCardView
      proposal={proposal}
      workspaceId={workspaceId}
      directory={directory}
      view={view}
      busy={busy}
      onAccept={() => press('accept')}
      onReject={() => press('reject')}
      onOpenEvidence={onOpenEvidence}
    />
  );
}

/** 갈래(`view`)와 진행 여부(`busy`)를 받아 그리기만 하는 카드. 측정 하네스도 이것을 세운다. */
export function MemoryProposalCardView({
  proposal,
  workspaceId,
  directory,
  view,
  busy,
  onAccept,
  onReject,
  onOpenEvidence,
}: {
  proposal: MemoryProposal;
  workspaceId: string;
  directory: Directory;
  view: ProposalView;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onOpenEvidence?: (link: MemoryEvidenceLink) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const decided =
    view.kind === 'accepted' || view.kind === 'rejected' || view.kind === 'stale';
  return (
    <View style={styles.card} testID="memory-proposal">
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.title}>
          {PROPOSAL_TITLE}
        </Text>
        <View style={styles.kind} testID="memory-proposal-kind">
          <Text style={styles.kindLabel}>{PROPOSAL_KIND_LABEL[proposal.kind]}</Text>
        </View>
      </View>
      {proposal.subject ? (
        <Text style={styles.subject} numberOfLines={1}>
          {proposal.subject}
        </Text>
      ) : null}
      {proposal.text ? (
        <Sentence style={[styles.body, decided && styles.bodyDecided]} testID="memory-proposal-text">
          {proposal.text}
        </Sentence>
      ) : null}
      {!decided ? (
        <EvidenceList
          workspaceId={workspaceId}
          channelId={proposal.channelId}
          rows={proposal.evidence}
          directory={directory}
          onOpen={onOpenEvidence}
        />
      ) : null}
      <Footer view={view} busy={busy} onAccept={onAccept} onReject={onReject} />
    </View>
  );
}

function Footer({
  view,
  busy,
  onAccept,
  onReject,
}: {
  view: ProposalView;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  switch (view.kind) {
    case 'accepted':
      return (
        <View style={styles.result} testID="memory-proposal-accepted">
          <Sentence style={styles.resultText}>{PROPOSAL_ACCEPTED}</Sentence>
          <Sentence style={styles.muted}>{PROPOSAL_DESKTOP_HINT}</Sentence>
        </View>
      );
    case 'rejected':
      return (
        <View style={styles.result} testID="memory-proposal-rejected">
          <Sentence style={styles.resultText}>{PROPOSAL_REJECTED}</Sentence>
        </View>
      );
    case 'stale':
      return (
        <View style={styles.result} testID="memory-proposal-stale">
          <Sentence style={styles.resultText}>
            {view.cause === 'expired' ? PROPOSAL_EXPIRED : PROPOSAL_STALE}
          </Sentence>
        </View>
      );
    case 'readOnly':
      return (
        <View style={styles.result} testID="memory-proposal-readonly">
          <Sentence style={styles.muted}>
            {view.cause === 'guest' ? PROPOSAL_GUEST : PROPOSAL_FORBIDDEN}
          </Sentence>
        </View>
      );
    case 'pending':
      return (
        <View style={styles.pending}>
          {view.selfWarning ? (
            <View style={styles.warn} testID="memory-proposal-self-warning">
              <Sentence style={styles.warnText}>{PROPOSAL_SELF_WARNING}</Sentence>
            </View>
          ) : null}
          {view.failed ? (
            <Sentence style={styles.errorText} testID="memory-proposal-error">
              {PROPOSAL_FAILED}
            </Sentence>
          ) : null}
          {busy ? (
            <View style={styles.busy} testID="memory-proposal-busy">
              <ActivityIndicator />
              <Text style={styles.muted}>{PROPOSAL_BUSY}</Text>
            </View>
          ) : (
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={PROPOSAL_ACCEPT_A11Y}
                onPress={onAccept}
                style={({pressed}) => [styles.accept, pressed && styles.pressed]}
                testID="memory-proposal-accept">
                <Text style={styles.acceptLabel}>{PROPOSAL_ACCEPT}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={PROPOSAL_REJECT_A11Y}
                onPress={onReject}
                style={({pressed}) => [styles.reject, pressed && styles.pressed]}
                testID="memory-proposal-reject">
                <Text style={styles.rejectLabel}>{PROPOSAL_REJECT}</Text>
              </Pressable>
            </View>
          )}
        </View>
      );
  }
}

function EvidenceList({
  workspaceId,
  channelId,
  rows,
  directory,
  onOpen,
}: {
  workspaceId: string;
  channelId: string;
  rows: readonly MemoryProposalEvidence[];
  directory: Directory;
  onOpen?: (link: MemoryEvidenceLink) => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  if (rows.length === 0) return null;
  return (
    <View style={styles.evidence} testID="memory-proposal-evidence">
      <Text style={styles.evidenceLabel}>{PROPOSAL_EVIDENCE_LABEL}</Text>
      {rows.map(row => (
        <EvidenceRow
          key={row.messageId}
          workspaceId={workspaceId}
          channelId={channelId}
          row={row}
          author={memberFor(directory, row.authorMemberId)?.displayName ?? '알 수 없는 멤버'}
          onOpen={onOpen}
        />
      ))}
    </View>
  );
}

function EvidenceRow({
  workspaceId,
  channelId,
  row,
  author,
  onOpen,
}: {
  workspaceId: string;
  channelId: string;
  row: MemoryProposalEvidence;
  author: string;
  onOpen?: (link: MemoryEvidenceLink) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const text = useProposalEvidenceText(workspaceId, channelId, row);
  const source =
    text.isPending
      ? PROPOSAL_EVIDENCE_LOADING
      : text.data == null
      ? PROPOSAL_EVIDENCE_UNREADABLE
      : text.data;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={proposalEvidenceA11y(author, row.seq)}
      disabled={onOpen === undefined}
      onPress={() => onOpen?.({messageId: row.messageId, channelId, seq: row.seq})}
      style={({pressed}) => [styles.evidenceRow, pressed && styles.pressed]}
      testID={`memory-proposal-evidence-${row.seq}`}>
      <Text style={styles.evidenceAuthor}>{proposalEvidenceLine(author, row.seq)}</Text>
      <Sentence numberOfLines={2} style={styles.evidenceText}>
        {source}
      </Sentence>
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    card: {
      padding: space.md,
      gap: space.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.agentSurface,
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space.sm,
    },
    title: {fontSize: font.label, color: color.text, fontWeight: '700'},
    kind: {
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.bg,
    },
    kindLabel: {fontSize: font.meta, color: color.accentText, fontWeight: '600'},
    subject: {fontSize: font.meta, color: color.textMuted},
    body: {fontSize: font.body, lineHeight: line.body, color: color.text},
    bodyDecided: {color: color.textMuted},
    muted: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    evidence: {gap: space.xs},
    evidenceLabel: {fontSize: font.meta, color: color.textMuted, fontWeight: '600'},
    evidenceRow: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingVertical: space.xs,
      paddingHorizontal: space.md,
      gap: 2,
      borderRadius: radius.sm,
      backgroundColor: color.bg,
    },
    evidenceAuthor: {fontSize: font.meta, color: color.accentText, fontWeight: '600'},
    evidenceText: {fontSize: font.label, lineHeight: line.label, color: color.text},
    pending: {gap: space.sm},
    warn: {
      padding: space.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: color.warnBorder,
      backgroundColor: color.warnSurface,
    },
    warnText: {fontSize: font.label, lineHeight: line.label, color: color.text},
    errorText: {fontSize: font.label, lineHeight: line.label, color: color.dangerText},
    busy: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      minHeight: TOUCH_TARGET,
    },
    actions: {flexDirection: 'row', gap: space.sm},
    accept: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      backgroundColor: color.accent,
    },
    acceptLabel: {fontSize: font.body, color: color.onAccent, fontWeight: '600'},
    reject: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.bg,
    },
    rejectLabel: {fontSize: font.body, color: color.text, fontWeight: '600'},
    pressed: {opacity: 0.6},
    result: {gap: space.xs},
    resultText: {fontSize: font.label, lineHeight: line.label, color: color.text, fontWeight: '600'},
  });
