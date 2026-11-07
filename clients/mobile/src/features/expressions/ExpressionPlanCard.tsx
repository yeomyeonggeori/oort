import {
  expressionSetPlanView,
  type ExpressionSetMotion,
  type ExpressionSetPlanCard,
  type ExpressionSetPlanState,
} from '@momo/core/features/expressions/set';
import {expressionDecisionRequest} from '@momo/core/features/expressions/setWire';
import type {
  AgentApprovalCard,
  ApprovalStatus,
} from '@momo/core/features/timeline/agentCardModel';
import type {ApprovalCardNote} from '@momo/core/features/timeline/approvalNote';
import {
  newDecisionId,
  type DecisionOutcome,
} from '@momo/core/features/timeline/approvalDecision';
import React, {useEffect, useRef, useState} from 'react';
import {Image, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {CONV_ICONS, CONV_ICON_SIZE} from '../../design/icons';
import {useKeyboardAppearance, usePalette, useStyles} from '../../design/theme';
import {ds2Radius, font, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {LiveLine} from './ExpressionChapter';
import {useExpressions} from './ExpressionProvider';
import {
  ExpressionSetReferenceRows,
  ExpressionSetReferences,
} from './ExpressionSetReferences';
import {PillButton, PillRow} from './setCardParts';
import {Decided, sendSetDecision, Status} from './setDecision';
import {
  emptyPlanEdit,
  planEditValid,
  planRevisionFields,
  planSlotKept,
  type PlanEdit,
} from './planRevision';
import {SET_ID, SET_WORD} from './setWords';
import {useExpressionMessages, type PlainMessageKey} from './useExpressionMessages';

// =============================================================================
// 세트 계획 카드 (ADR-0218 §12 L2.5·L19, #5463 폰): 사람이 한 번 보는 카드다. 계획이 저장된 뒤 **아무것도 만들기 전에** 서버가 대화에 올린다.
// 웹 `ExpressionPlanCard` 의 폰 짝이다. 대화에 서는 길은 기존 행동 승인 카드다(`MessageRow` 의 `AgentCard` 가 `expression.set.plan` 을 여기로 보낸다).
// 새 경로는 없다.
//
// 보이는 것: 제목, 컨셉, 장면 줄(정지는 장면 글, GIF 는 바탕과 움직임), 만들 그림 N장(숫자만), 보낼 참조 그림의 썸네일과 장수. 참조가 있으면 얼굴 없음 선언이
// **매번** 보이고, 그 멤버의 첫 참조 세트면 고지 두 줄이 더 보인다. **이 줄의 값은 서버가 멤버별 기록으로 계산한 `noticeDue` 뿐이다** — 이 화면은 읽은 적이
// 있는지 스스로 기억하거나 세지 않는다(코어 `expressionSetPlanView` 가 `noticeDue` 와 장수로 고른다).
// 버튼 셋: 「이대로 만들기」(승인) · 「장면 고치기」(새 계획) · 「취소」(거절). **「이대로 만들기」 전에는 이 화면이 보내는 요청이 0이다**(보기·고치기 열기·닫기 모두;
// L19.3) — 서버의 불변식과 같은 말이고, 시험이 요청 수 0 을 잰다.
//
// 앱 안에서만 확정한다(L2.5 결정 방식, A44): 폰도 이미 앱이고 카드를 본 채로 누르는 곳이라 이 카드의 단추가 곧 그 자리다. 잠금 화면·푸시에서의 결정은 서버가 403 으로
// 거절하고 이 화면과 무관하다. 받은함처럼 카드를 보여 주지 않는 곳에서는 일반 승인 단추 대신 「열기」만 선다(`InboxScreen`).
//
// 폰 손맛: 단추와 고치기의 한 줄 한 줄이 모두 `TOUCH_TARGET` 이상이고, 글자는 끝까지 자란다. 이 카드에는 움직임이 없다(보내는 중의 표시기만 동작 줄이기를 따른다).
// 이 파일에는 상태 이름 같은 글자 리터럴이 없다(직접 문구 장부: 새 파일은 0칸). 표의 키는 속성 이름이고, 갈래는 숫자다.
// =============================================================================

const Mode = {view: 0, edit: 1} as const;

const MOTION_LABEL = {
  bounce: 'expressions.plan.motionBounce',
  wobble: 'expressions.plan.motionWobble',
  pulse: 'expressions.plan.motionPulse',
  sparkle: 'expressions.plan.motionSparkle',
} as const satisfies Record<ExpressionSetMotion, PlainMessageKey>;
/** 계획 카드가 스스로 말하는 끝난 상태(서버가 메시지를 고쳐 쓴 뒤). */
const PLAN_STATE_LINE = {
  planned: 'expressions.set.settledExpired',
  confirmed: 'expressions.plan.confirmed',
  cancelled: 'expressions.plan.closed',
  expired: 'expressions.set.settledExpired',
} as const satisfies Record<ExpressionSetPlanState, PlainMessageKey>;
/** 방금 이 화면이 결정한(영수증 표가 말하는) 승인 상태가 말하는 것. */
const STATUS_LINE = {
  pending: 'expressions.set.settledExpired',
  approved: 'expressions.plan.confirmed',
  rejected: 'expressions.plan.closed',
  expired: 'expressions.set.settledExpired',
  cancelled: 'expressions.plan.closed',
} as const satisfies Record<ApprovalStatus, PlainMessageKey>;

/** 「넣기」 체크 상자의 한 변. 누름 면(`TOUCH_TARGET`)은 이 상자를 감싼 단추가 채운다. */
const CHECK_BOX = 22;

export function ExpressionPlanCard({
  card,
  plan,
  settledStatus,
  note,
  nowMs,
  onSettled,
}: {
  card: AgentApprovalCard;
  plan: ExpressionSetPlanCard | null;
  /** 이 카드가 지금 말하는 승인 상태: 이 화면이 방금 결정한 것(영수증 표)이 메시지 스냅샷보다 앞선다. */
  settledStatus: ApprovalStatus;
  /** 컨트롤 대신 서는 한 줄(오프라인·다른 자리). `null` 이면 컨트롤이 선다. */
  note: ApprovalCardNote | null;
  nowMs: number;
  /** 결정이 끝났다: 화면의 영수증 표(`onApprovalSettled`)가 이 카드가 끝났다는 사실을 한 곳에서 읽는다. */
  onSettled?: (approvalId: string, outcome: DecisionOutcome) => void;
}): React.JSX.Element {
  const {store} = useExpressions();
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const keyboardAppearance = useKeyboardAppearance();
  const [mode, setMode] = useState<number>(Mode.view);
  const [edit, setEdit] = useState<PlanEdit>(emptyPlanEdit);
  const [busy, setBusy] = useState(false);
  const [errorLine, setErrorLine] = useState<PlainMessageKey | null>(null);
  const lock = useRef(false);
  const keys = useRef(new Map<string, string>());

  // 다른 워크스페이스의 계획은 그리지 않는다: 이 저장소로는 참조 그림의 대화를 열 수 없다.
  const usable =
    plan !== null && store !== null && plan.workspaceId === store.workspaceId
      ? plan
      : null;
  const planId = usable?.setId ?? null;
  useEffect(() => {
    setMode(Mode.view);
    setEdit(emptyPlanEdit());
  }, [planId]);

  const view = usable ? expressionSetPlanView(usable, nowMs) : null;
  // 열려 있다 = 아직 결정되지 않았고, 카드의 기한이 지나지 않았고, 계획이 아직 답을 기다린다(서버가 확정·취소·만료로 바꾸면 닫힌다).
  const open =
    settledStatus === Status.pending &&
    (!card.expiresAtMs || nowMs < card.expiresAtMs) &&
    (view === null || view.canConfirm);
  // 컨트롤은 카드가 열려 있고 할 말(오프라인·다른 자리)이 없을 때만 선다.
  const live = open && note === null;
  const offlineRefs = note?.kind === SET_WORD.offline;

  async function decide(
    fields: Record<string, unknown>,
    approve: boolean,
  ): Promise<void> {
    if (!store || !card.approvalId || !live || lock.current) return;
    lock.current = true;
    setBusy(true);
    setErrorLine(null);
    // 같은 결정을 다시 누르면 같은 키라 서버가 첫 영수증을 돌려준다. 고친 내용이 바뀌면 다른 결정이라 새 키다.
    const pin = JSON.stringify(fields);
    const key = keys.current.get(pin) ?? newDecisionId();
    keys.current.set(pin, key);
    try {
      const outcome = await sendSetDecision(
        expressionDecisionRequest(store.root, card.approvalId, key, fields),
        approve,
      );
      if (outcome.kind === Decided.failed) {
        if (outcome.freshKey) keys.current.delete(pin);
        setErrorLine(outcome.line);
        return;
      }
      onSettled?.(card.approvalId, outcome.outcome);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (!store) {
    return (
      <Sentence style={styles.body} testID="expression-plan-unreadable">
        {formatMessage('expressions.set.unreadable')}
      </Sentence>
    );
  }
  const title = usable
    ? formatMessage('expressions.plan.heading', {title: usable.title})
    : card.title;
  // 승인이 이미 끝났다고 말하면(방금 이 화면이 결정했거나 메시지가 그렇게 말하면) 그 상태가, 아직 대기라면 계획이 스스로 말하는 상태(확정·취소·만료)가 말한다.
  const settledLine = formatMessage(
    settledStatus === Status.pending && view
      ? PLAN_STATE_LINE[view.state]
      : STATUS_LINE[settledStatus],
  );
  const slotName = (index: number) =>
    usable?.slots.find(slot => slot.index === index)?.displayName ?? '';
  const editing = mode === Mode.edit;
  const keptReferences = usable
    ? usable.references.filter(
        reference => !edit.removedReferences.includes(reference.attachmentId),
      )
    : [];
  const sorted = usable ? [...usable.slots].sort((a, b) => a.index - b.index) : [];

  return (
    <View style={styles.root} testID="expression-plan">
      <Sentence style={styles.title} accessibilityRole="header">
        {title}
      </Sentence>
      {open && usable === null ? (
        <>
          <Sentence style={styles.body} testID="expression-plan-unreadable">
            {formatMessage('expressions.set.unreadable')}
          </Sentence>
          <PillRow>
            <PillButton
              quiet
              label={formatMessage('expressions.plan.cancel')}
              disabled={!live || busy}
              onPress={() => void decide({approve: false}, false)}
              testID="expression-plan-cancel"
            />
          </PillRow>
        </>
      ) : null}
      {open && usable !== null && view !== null && !editing ? (
        <>
          <View style={styles.block}>
            <Sentence style={styles.label}>
              {formatMessage('expressions.plan.concept')}
            </Sentence>
            <Sentence style={styles.body} testID="expression-plan-concept">
              {usable.prompt}
            </Sentence>
          </View>
          <View style={styles.block}>
            <Sentence style={styles.label}>
              {formatMessage('expressions.plan.scenes')}
            </Sentence>
            <View testID="expression-plan-scenes">
              {sorted.map(slot => (
                <View
                  key={slot.index}
                  style={styles.scene}
                  testID={SET_ID.planScene(slot.index)}>
                  <Text style={styles.sceneNumber}>{slot.index + 1}</Text>
                  <Sentence style={styles.sceneText}>
                    <Text style={styles.sceneName}>{slot.displayName}</Text>
                    <Text style={styles.sceneBody}>
                      {' '}
                      {slot.scene !== null
                        ? slot.scene
                        : formatMessage('expressions.plan.gif', {
                            base: slotName(slot.baseIndex ?? -1),
                            motion: slot.motion
                              ? formatMessage(MOTION_LABEL[slot.motion])
                              : '',
                          })}
                    </Text>
                  </Sentence>
                </View>
              ))}
            </View>
          </View>
          <Sentence style={styles.meta} testID="expression-plan-pictures">
            {formatMessage('expressions.plan.pictures', {count: usable.slots.length})}
          </Sentence>
          {view.referencesLine !== null ? (
            <View style={styles.block} testID="expression-plan-references">
              <ExpressionSetReferences
                references={usable.references}
                workspaceId={store.workspaceId}
                channelId={card.channelId}
                offline={offlineRefs}
              />
              <Sentence style={styles.meta} testID="expression-plan-references-line">
                {formatMessage('expressions.plan.references', {
                  count: usable.references.length,
                })}
              </Sentence>
              {view.declareLine !== null ? (
                <Sentence style={styles.declare} testID="expression-plan-declare">
                  {formatMessage('expressions.plan.declare')}
                </Sentence>
              ) : null}
            </View>
          ) : null}
          {view.noticeLines.length > 0 ? (
            <View style={styles.block} testID="expression-plan-notice">
              <Sentence style={styles.meta}>
                {formatMessage('expressions.plan.notice')}
              </Sentence>
              <Sentence style={styles.meta}>
                {formatMessage('expressions.plan.kept')}
              </Sentence>
            </View>
          ) : null}
          {note !== null ? (
            <Sentence style={styles.meta} testID="expression-plan-note">
              {note.text}
            </Sentence>
          ) : null}
          <PillRow>
            <PillButton
              quiet
              label={formatMessage('expressions.plan.cancel')}
              disabled={!live || busy || !view.canCancel}
              onPress={() => void decide({approve: false}, false)}
              testID="expression-plan-cancel"
            />
            <PillButton
              quiet
              label={formatMessage('expressions.plan.revise')}
              disabled={!live || busy || !view.canRevise}
              onPress={() => setMode(Mode.edit)}
              testID="expression-plan-revise"
            />
            <PillButton
              label={formatMessage('expressions.plan.confirm')}
              busy={busy}
              busyLabel={formatMessage('expressions.plan.confirm')}
              disabled={!live || !view.canConfirm}
              onPress={() => void decide({approve: true}, true)}
              testID="expression-plan-confirm"
            />
          </PillRow>
        </>
      ) : null}
      {open && usable !== null && editing ? (
        <View style={styles.block} testID="expression-plan-edit">
          <ExpressionSetReferenceRows
            references={keptReferences}
            workspaceId={store.workspaceId}
            channelId={card.channelId}
            offline={offlineRefs}
            disabled={!live || busy}
            onRemove={attachmentId =>
              setEdit(current => ({
                ...current,
                removedReferences: [...current.removedReferences, attachmentId],
              }))
            }
          />
          {sorted.map(slot => {
            const kept = planSlotKept(usable, edit, slot.index);
            // 움직일 정지 칸이 빠진 GIF 는 스스로 켤 수 없다: 바탕이 돌아와야 같이 돌아온다.
            const follows =
              slot.scene === null &&
              slot.baseIndex !== null &&
              !planSlotKept(usable, edit, slot.baseIndex);
            const includeDisabled = !live || busy || follows;
            return (
              <View
                key={slot.index}
                style={styles.editSlot}
                testID={SET_ID.planEditSlot(slot.index)}>
                <View style={styles.editHead}>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={formatMessage('expressions.plan.editInclude', {
                      displayName: edit.names[slot.index] ?? slot.displayName,
                    })}
                    accessibilityState={{checked: kept, disabled: includeDisabled}}
                    disabled={includeDisabled}
                    onPress={() =>
                      setEdit(current => {
                        const dropped = new Set(current.dropped);
                        if (dropped.has(slot.index)) dropped.delete(slot.index);
                        else dropped.add(slot.index);
                        return {...current, dropped};
                      })
                    }
                    style={styles.editInclude}
                    testID={SET_ID.planEditInclude(slot.index)}>
                    <View style={[styles.box, kept && styles.boxOn]}>
                      {kept ? (
                        <Image
                          accessible={false}
                          source={CONV_ICONS.check}
                          style={{
                            width: CONV_ICON_SIZE.check,
                            height: CONV_ICON_SIZE.check,
                            tintColor: palette.onPrimary,
                          }}
                        />
                      ) : null}
                    </View>
                  </Pressable>
                  <TextInput
                    accessibilityLabel={formatMessage('expressions.plan.editName', {
                      index: slot.index + 1,
                    })}
                    editable={live && !busy && kept}
                    keyboardAppearance={keyboardAppearance}
                    maxLength={40}
                    onChangeText={next =>
                      setEdit(current => ({
                        ...current,
                        names: {...current.names, [slot.index]: next},
                      }))
                    }
                    returnKeyType="done"
                    style={[styles.input, !kept && styles.inputOff]}
                    testID={SET_ID.planEditName(slot.index)}
                    value={edit.names[slot.index] ?? slot.displayName}
                  />
                </View>
                {slot.scene !== null ? (
                  <TextInput
                    accessibilityLabel={formatMessage('expressions.plan.editScene', {
                      index: slot.index + 1,
                    })}
                    editable={live && !busy && kept}
                    keyboardAppearance={keyboardAppearance}
                    // 한국어 장면 글이라 낱말 가운데서 끊기지 않게 한다(컴포저와 같은 규칙, #1422 — `conversationHygiene` 의 여러 줄 입력창 전수 스윕).
                    lineBreakStrategyIOS="hangul-word"
                    maxLength={300}
                    multiline
                    onChangeText={next =>
                      setEdit(current => ({
                        ...current,
                        scenes: {...current.scenes, [slot.index]: next},
                      }))
                    }
                    style={[styles.input, styles.inputScene, !kept && styles.inputOff]}
                    testID={SET_ID.planEditScene(slot.index)}
                    value={edit.scenes[slot.index] ?? slot.scene}
                  />
                ) : null}
              </View>
            );
          })}
          {note !== null ? (
            <Sentence style={styles.meta} testID="expression-plan-note">
              {note.text}
            </Sentence>
          ) : null}
          <PillRow>
            <PillButton
              quiet
              label={formatMessage('expressions.plan.editBack')}
              disabled={busy}
              onPress={() => {
                setMode(Mode.view);
                setEdit(emptyPlanEdit());
              }}
              testID="expression-plan-edit-back"
            />
            <PillButton
              label={formatMessage('expressions.plan.editSubmit')}
              busy={busy}
              busyLabel={formatMessage('expressions.plan.editSubmit')}
              disabled={!live || !planEditValid(usable, edit)}
              onPress={() => void decide(planRevisionFields(usable, edit), false)}
              testID="expression-plan-edit-submit"
            />
          </PillRow>
        </View>
      ) : null}
      {/* 끝난 카드의 한 줄은 낭독하지 않는다(세트 카드와 같은 이유): 결정의 낭독은 화면이 한다. */}
      {!open ? (
        <Sentence style={styles.body} testID="expression-plan-settled">
          {settledLine}
        </Sentence>
      ) : null}
      <LiveLine
        text={errorLine === null ? null : formatMessage(errorLine)}
        tone="danger"
        testID="expression-plan-error"
      />
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {gap: space.md},
    title: {fontSize: font.heading, fontWeight: '600', color: color.text},
    body: {fontSize: font.body, color: color.text},
    label: {fontSize: font.label, fontWeight: '600', color: color.textMuted},
    meta: {fontSize: font.meta, color: color.textMuted},
    // 얼굴 없음 선언은 매번 읽히는 줄이다: 보조 글(meta)보다 한 단 위(본문 잉크, 라벨 크기).
    declare: {fontSize: font.label, color: color.text},
    block: {gap: space.sm},
    scene: {flexDirection: SET_WORD.row, gap: space.sm, paddingVertical: space.xs},
    sceneNumber: {
      width: space.xl,
      fontSize: font.label,
      color: color.textMuted,
      textAlign: SET_WORD.center,
    },
    sceneText: {flex: 1},
    sceneName: {fontSize: font.label, fontWeight: '600', color: color.text},
    sceneBody: {fontSize: font.label, color: color.textMuted},
    editSlot: {
      gap: space.sm,
      paddingTop: space.sm,
      borderTopWidth: 1,
      borderTopColor: color.border,
    },
    editHead: {flexDirection: SET_WORD.row, alignItems: SET_WORD.center, gap: space.sm},
    editInclude: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      alignItems: SET_WORD.center,
      justifyContent: SET_WORD.center,
    },
    box: {
      width: CHECK_BOX,
      height: CHECK_BOX,
      borderRadius: ds2Radius.badge,
      borderWidth: 1,
      borderColor: color.textFaint,
      alignItems: SET_WORD.center,
      justifyContent: SET_WORD.center,
    },
    boxOn: {backgroundColor: color.primary, borderColor: color.primary},
    input: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.textFaint,
      fontSize: font.body,
      color: color.text,
    },
    inputScene: {flex: 0, textAlignVertical: SET_WORD.top},
    inputOff: {opacity: 0.5},
  });
