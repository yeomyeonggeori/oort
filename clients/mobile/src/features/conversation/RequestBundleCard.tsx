import {uuidEq, type AgentRunProgress} from '@momo/core/lib/api';
import type {AgentApprovalCard} from '@momo/core/features/timeline/agentCardModel';
import {
  cardReproposeReason,
  REPROPOSE_LABEL,
  reproposeDraft,
  reproposeTarget,
} from '@momo/core/features/approvals/expiry';
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
  useWindowDimensions,
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
import {OutlineButton, Sentence, STACK_PILL_SCALE} from '../../design/atoms';
import {useFormatMessage} from '../../i18n/useFormatMessage';
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
import {useOpenDecisionStage} from '../decisionStage/openDecisionStage';
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
  onRepropose,
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
  /**
   * 닫힌 카드(만료·거부·실패)의 「다시 요청」이 이 화면의 입력창에 초안을 넣는다 (#5171). 넣었으면 `true`, 쓰던 글이 있어 거절했으면
   * `false`. 없으면 단추가 서지 않는다: 눌러도 아무 일 없는 버튼을 두지 않는다.
   */
  onRepropose?: (draft: string) => boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // 큰 글씨(결정 무대와 같은 문턱)에서는 머리 문장을 자르지 않는다(#4982): 두 줄에서 말줄임하면 어느 요청인지를 말하는 유일한
  // 문장이 AX3 에서 「…」로 끝난다. 기본 크기는 카드 높이를 지키려고 두 줄에서 접는다.
  const {fontScale} = useWindowDimensions();
  const stage = useOpenDecisionStage();
  const stageSource = useRef<View | null>(null);
  const openDecision = onOpenDecision ?? (stage ? (id: string) => stage(id, stageSource) : undefined);
  const [expanded, setExpanded] = useState(false);
  const [reproposeNote, setReproposeNote] = useState<string | null>(null);
  const formatMessage = useFormatMessage();
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
  // 닫힌 카드의 다음 행동 「다시 요청」(#5171). 서는 조건은 웹 `AgentCard` 와 같은 코어 함수 둘이 정한다: 상태·거부한 사람·영수증 줄(`cardReproposeReason`:
  // 만료 카드가 이미 영수증 줄을 말하면 서지 않는다), 올린 이가 에이전트인가(`reproposeTarget`). 거부한 사람은 영수증이 먼저 안다(카드의
  // `decided_by` 는 서버 프레임이 올 때까지 없다).
  const decidedById = receipt?.decidedByMemberId ?? card.decidedByMemberId;
  const iDecided =
    decidedById !== undefined && uuidEq(decidedById, viewerMemberId);
  const reproposeReason = card.isResumeOffer
    ? null
    : cardReproposeReason(model.state, iDecided, receipt?.note);
  const reproposeTo =
    reproposeReason !== null && onRepropose !== undefined
      ? reproposeTarget(card, directory)
      : null;
  const repropose = () => {
    if (reproposeReason === null || reproposeTo === null) return;
    const seeded = onRepropose?.(
      reproposeDraft(reproposeTo.agent.handle, reproposeReason),
    );
    // 입력창에 넣었는지 거절당했는지를 눈으로 보이고, VoiceOver 에는 소리로 알린다(iOS 에는 live region 이 없다).
    const note = formatMessage(
      seeded === true
        ? 'timeline.approval.reproposeSeeded'
        : 'timeline.approval.reproposeBusy',
    );
    setReproposeNote(note);
    AccessibilityInfo.announceForAccessibility(note);
  };
  const openStage =
    model.canDecide &&
    model.decisionMode === 'open' &&
    openDecision !== undefined;
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
    ...(openDecision ? [{name: 'openDecision', label: openStage ? '열어서 결정' : '결정 보기'}] : []),
    // 액션의 이름은 낱말 상수(`REPROPOSE_LABEL`)를 라벨과 겸해서 쓴다: 직접 문구 장부는 맨 영어 낱말('repropose')도 문구로 세고,
    // 이름은 VoiceOver 가 읽지 않는 식별자라 한국어여도 해가 없다.
    ...(reproposeTo !== null ? [{name: REPROPOSE_LABEL, label: REPROPOSE_LABEL}] : []),
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
      ref={stageSource}
      collapsable={false}
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
            if (card.approvalId) openDecision?.(card.approvalId);
            break;
          case REPROPOSE_LABEL:
            repropose();
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
      <Pressable style={styles.head} accessibilityRole="button" accessibilityLabel="결정 보기" disabled={!openDecision || !card.approvalId} onPress={() => { if (card.approvalId) openDecision?.(card.approvalId); }}>
        <Sentence
          numberOfLines={fontScale >= STACK_PILL_SCALE ? undefined : 2}
          style={styles.headline}
          testID="request-bundle-headline"
        >
          {headline}
        </Sentence>
        <RequestStateFace state={model.state} />
      </Pressable>
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
        model.decisionMode === 'open' && openDecision ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="열어서 결정"
            onPress={() => openDecision(gate.approvalId)}
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
      {reproposeTo !== null ? (
        <View style={styles.closedNext} testID="request-bundle-closed-next">
          <OutlineButton
            label={REPROPOSE_LABEL}
            onPress={repropose}
            testID="request-bundle-repropose"
          />
          {reproposeNote !== null ? (
            <Sentence style={styles.meta} testID="request-bundle-repropose-note">
              {reproposeNote}
            </Sentence>
          ) : null}
        </View>
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
    head: {gap: space.xs, minHeight: TOUCH_TARGET},
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
    // 웹의 `self-start` 작은 윤곽 단추처럼 왼쪽에 붙고, 누른 뒤의 한 줄(넣었어요/못 넣었어요)이 그 아래에 선다.
    closedNext: {alignItems: 'flex-start', gap: space.xs},
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
