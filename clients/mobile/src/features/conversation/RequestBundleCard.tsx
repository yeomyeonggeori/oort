import type {AgentRunProgress} from '@momo/core/lib/api';
import type {AgentApprovalCard} from '@momo/core/features/timeline/agentCardModel';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import {
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {roleRequiredCopy} from '@momo/core/features/approvals/actionRole';
import {isMemberAvatarSetAction} from '@momo/core/features/approvals/avatarPreview';
import {approvalHeadTitle} from '@momo/core/features/timeline/agentInitiative';
import {
  teamAiProposalLine,
  TEAM_AI_PROPOSAL_AUTHORITY,
} from '@momo/core/features/timeline/teamAi';
import React, {useImperativeHandle, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ds2Radius,
  font,
  line,
  radius,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {
  ApprovalDecision,
  type ApprovalDecisionHandle,
} from '../inbox/ApprovalDecision';
import {RequestStateFace} from '../agents/RequestStatusChip';
import {ApprovalAvatarPreview} from './ApprovalAvatarPreview';
import {
  ApprovalMessagePreview,
  openableMessagePreview,
} from './ApprovalMessagePreview';
import {LinkOnce} from './LinkOnce';
import type {ApprovalGate, ApprovalReceipt} from './approvalGate';
import {deadlinePassed} from './approvalGate';
import {phoneRequestBundle} from './requestLoop';
import {copyText} from './copy';
import {spawnHostGate} from '@momo/core/features/timeline/spawnHostChoice';

export function RequestBundleCard({
  card,
  directory,
  viewerMemberId,
  gate,
  receipt,
  nowMs,
  offline,
  run,
  decisionRef,
  onSettled,
  onOpenMessage,
  onOpenDecision,
}: {
  card: AgentApprovalCard;
  directory: Directory;
  viewerMemberId?: string;
  gate: ApprovalGate | null;
  receipt?: ApprovalReceipt;
  nowMs: number;
  offline?: boolean;
  run?: AgentRunProgress;
  decisionRef?: React.Ref<ApprovalDecisionHandle>;
  onSettled?: (approvalId: string, outcome: DecisionOutcome) => void;
  onOpenMessage?: (channelId: string, messageId: string) => void;
  onOpenDecision?: (approvalId: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [expanded, setExpanded] = useState(false);
  const decision = useRef<ApprovalDecisionHandle | null>(null);
  useImperativeHandle(
    decisionRef,
    () => ({decide: direction => decision.current?.decide(direction)}),
    [],
  );
  const model = phoneRequestBundle(
    card,
    directory,
    viewerMemberId,
    gate,
    receipt,
    nowMs,
    offline,
    run,
  );
  const decideAfterReconnect =
    offline === true &&
    phoneRequestBundle(
      card,
      directory,
      viewerMemberId,
      gate,
      receipt,
      nowMs,
      false,
      run,
    ).canDecide;
  const viewer = memberFor(directory, viewerMemberId);
  const admin = viewer?.role === 'owner' || viewer?.role === 'admin';
  const details = admin
    ? model.details.rows
    : model.details.rows.filter(row => !card.detail.rows.includes(row));
  const headline = approvalHeadTitle({...card, title: model.headline});
  const openStage =
    model.canDecide &&
    model.decisionMode === 'open' &&
    onOpenDecision !== undefined;
  const canApprove = spawnHostGate(card.execution).canApprove;
  const resultTarget =
    model.ref?.type === 'message' &&
    card.channelId !== undefined &&
    onOpenMessage !== undefined
      ? model.ref.id
      : undefined;
  const resultLabel = model.next?.label ?? '결과 보기';
  const rotor = [
    ...(model.canDecide && !openStage
      ? [
          ...(canApprove ? [{name: 'approve', label: '승인'}] : []),
          {name: 'reject', label: '거부'},
        ]
      : []),
    ...(openStage ? [{name: 'openDecision', label: '열어서 결정'}] : []),
    {name: 'details', label: expanded ? '자세히 접기' : '자세히'},
    ...(resultTarget ? [{name: 'result', label: resultLabel}] : []),
    ...(receipt?.secretOnce
      ? [{name: 'copyLink', label: '링크 복사하기'}]
      : []),
  ];
  const preview = openableMessagePreview(
    card,
    receipt?.status ?? card.status,
    onOpenMessage !== undefined,
  );
  return (
    <View
      style={styles.card}
      accessible
      accessibilityRole="summary"
      accessibilityState={{expanded}}
      accessibilityLabel={[
        headline,
        model.word,
        model.state !== 'approval' ? model.sentence : '',
        ...model.valueChips.map(value => value.labelText),
        model.waitingFor ?? '',
        receipt?.note ?? '',
        ...(expanded ? details.map(row => `${row.label}: ${row.value}`) : []),
      ]
        .filter(Boolean)
        .join('. ')}
      accessibilityActions={rotor}
      onAccessibilityAction={event => {
        switch (event.nativeEvent.actionName) {
          case 'approve':
            decision.current?.decide('approve');
            break;
          case 'reject':
            decision.current?.decide('reject');
            break;
          case 'openDecision':
            if (gate) onOpenDecision?.(gate.approvalId);
            break;
          case 'details':
            setExpanded(value => !value);
            break;
          case 'result':
            if (resultTarget && card.channelId)
              onOpenMessage?.(card.channelId, resultTarget);
            break;
          case 'copyLink':
            if (receipt?.secretOnce)
              void copyText(receipt.secretOnce.value).then(ok => {
                if (ok)
                  AccessibilityInfo.announceForAccessibility('링크 복사됨');
              });
            break;
        }
      }}
      testID="request-bundle-card"
    >
      <View style={styles.head}>
        <Sentence
          numberOfLines={2}
          style={styles.headline}
          testID="request-bundle-headline"
        >
          {headline}
        </Sentence>
        <RequestStateFace state={model.state} />
      </View>
      {card.proposedVia !== undefined ? (
        <Sentence style={styles.meta}>
          {teamAiProposalLine(
            memberFor(directory, card.proposedVia.requesterId ?? undefined)
              ?.displayName ?? card.proposedVia.requesterName,
          )}{' '}
          · {TEAM_AI_PROPOSAL_AUTHORITY}
        </Sentence>
      ) : null}
      {model.state !== 'approval' ? (
        <Sentence style={styles.sentence} testID="request-bundle-sentence">
          {model.sentence}
        </Sentence>
      ) : null}
      <View style={styles.values}>
        {model.valueChips.map((value, index) => (
          <View
            key={index}
            accessible
            accessibilityLabel={value.labelText}
            style={styles.value}
            testID="request-bundle-value"
          >
            <Text style={styles.meta}>{value.label}</Text>
            <Sentence style={styles.sentence}>
              {value.after === undefined ? (
                value.value
              ) : (
                <>
                  {value.before !== undefined ? (
                    <Text style={styles.before}>{value.before}</Text>
                  ) : null}
                  {value.before !== undefined ? ' → ' : ''}
                  {value.after}
                </>
              )}
            </Sentence>
          </View>
        ))}
        {model.moreValues > 0 ? (
          <Text style={styles.meta}>{`외 ${model.moreValues}건`}</Text>
        ) : null}
      </View>
      {model.state === 'approval' &&
      isMemberAvatarSetAction(card.action?.id) ? (
        <ApprovalAvatarPreview
          card={card}
          agentName={
            memberFor(directory, card.requestedByMemberId)?.displayName ?? null
          }
        />
      ) : null}
      {preview !== null && onOpenMessage ? (
        <ApprovalMessagePreview preview={preview} onOpen={onOpenMessage} />
      ) : null}
      {model.canDecide && gate !== null ? (
        model.decisionMode === 'open' && onOpenDecision ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="열어서 결정"
            onPress={() => onOpenDecision(gate.approvalId)}
            style={styles.open}
          >
            <Text style={styles.openLabel}>열어서 결정</Text>
          </Pressable>
        ) : (
          <ApprovalDecision
            approvalId={gate.approvalId}
            deadlinePassed={deadlinePassed(gate, nowMs)}
            lead={null}
            shape="request"
            subject={model.headline}
            execution={card.execution}
            decisionRef={decision}
            forbiddenCopy={
              card.action?.requiredRole
                ? roleRequiredCopy(card.action.requiredRole)
                : null
            }
            onSettled={outcome => onSettled?.(gate.approvalId, outcome)}
            testIDPrefix={`card-approval-${gate.approvalId}`}
          />
        )
      ) : model.state === 'approval' ? (
        <Sentence style={styles.meta} testID="request-bundle-waiting">
          {decideAfterReconnect
            ? '연결이 돌아오면 여기서 결정할 수 있어요.'
            : model.waitingFor}
        </Sentence>
      ) : null}
      {receipt !== undefined ? (
        <Sentence style={styles.meta} testID="request-bundle-receipt">
          {receipt.note}
        </Sentence>
      ) : null}
      {receipt?.secretOnce !== undefined ? (
        <LinkOnce secret={receipt.secretOnce} />
      ) : null}
      {resultTarget && card.channelId && onOpenMessage ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={resultLabel}
          onPress={() => onOpenMessage(card.channelId!, resultTarget)}
          style={styles.detailsButton}
          testID="request-bundle-result"
        >
          <Text style={styles.meta}>{resultLabel}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="자세히"
        accessibilityState={{expanded}}
        onPress={() => setExpanded(value => !value)}
        style={styles.detailsButton}
        testID="request-bundle-details-toggle"
      >
        <Text style={styles.meta}>{model.quietLine}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.details} testID="request-bundle-details">
          {details.map((row, index) => (
            <Sentence
              key={index}
              style={styles.meta}
            >{`${row.label} · ${row.value}`}</Sentence>
          ))}
          {model.details.withheld > 0 ? (
            <Text
              style={styles.meta}
            >{`민감한 값 ${model.details.withheld}개는 숨겼어요`}</Text>
          ) : null}
          {model.details.approvalId !== undefined ? (
            <Text
              selectable
              style={styles.meta}
            >{`원장 번호 · ${model.details.approvalId}`}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: color.surface,
      borderRadius: ds2Radius.card,
      padding: space.md,
      gap: space.sm,
    },
    head: {gap: space.xs},
    headline: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
      fontWeight: '600',
    },
    sentence: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
    meta: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    values: {gap: space.xs},
    value: {
      backgroundColor: color.surfaceMuted,
      borderRadius: radius.sm,
      padding: space.sm,
      gap: space.xs,
    },
    before: {color: color.textMuted, textDecorationLine: 'line-through'},
    detailsButton: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      alignSelf: 'flex-start',
      paddingHorizontal: space.sm,
    },
    details: {gap: space.sm},
    open: {
      minHeight: TOUCH_TARGET,
      borderRadius: radius.pill,
      backgroundColor: color.primary,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: space.md,
    },
    openLabel: {
      fontSize: font.label,
      color: color.onPrimary,
      fontWeight: '600',
    },
  });
