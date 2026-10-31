import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  AppState,
  ActivityIndicator,
  Animated,
  findNodeHandle,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import type {AgentRunProgress} from '@momo/core/lib/api';
import type {AgentApprovalCard} from '@momo/core/features/timeline/agentCardModel';
import {formatMicroUsd} from '@momo/core/features/timeline/agentCardModel';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import {
  createDecisionStage,
  decisionStageModel,
  decisionStageDragAction,
  moveDecisionStage,
  nextPendingDecisionStage,
} from '@momo/core/features/timeline/decisionStage';
import {
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {roleRequiredCopy} from '@momo/core/features/approvals/actionRole';
import {Sentence, STACK_PILL_SCALE} from '../../design/atoms';
import {GlassSurface, LiquidGlassAllowed} from '../../design/glass';
import {CloseCircle} from '../../design/SheetChrome';
import {useStyles} from '../../design/theme';

import {
  ds2Radius,
  font,
  line,
  radius,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {haptics} from '../../lib/haptics';
import {StageHero} from '../attachments/StageHero';
import {phoneRequestBundle} from '../conversation/requestLoop';
import {
  linkOnceFrom,
  type ApprovalGate,
  type ApprovalReceipt,
} from '../conversation/approvalGate';
import {LinkOnce} from '../conversation/LinkOnce';
import {ApprovalDecision, decisionReceiptCopy} from '../inbox/ApprovalDecision';
import type {DecisionStageSource} from './openDecisionStage';
import {useDecisionStageHero} from './useDecisionStageHero';

export interface DecisionStageEntry {
  id: string;
  card: AgentApprovalCard;
  gate: ApprovalGate | null;
  receipt?: ApprovalReceipt;
  run?: AgentRunProgress;
}

/** 본문이 끝에 닿았다고 보는 여유(pt). 대화 입력창 후보 시트의 「아래에 더 있다」 표지와 같은 판정이다. */
const BODY_END_SLOP = 2;

export function DecisionStage({
  entries,
  selectedId,
  source,
  directory,
  viewerMemberId,
  nowMs,
  offline = false,
  loading = false,
  error,
  onRetry,
  onSettled,
  onClose,
}: {
  entries: readonly DecisionStageEntry[];
  selectedId?: string;
  source?: DecisionStageSource;
  directory: Directory;
  viewerMemberId: string;
  nowMs: number;
  offline?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onSettled: (approvalId: string, outcome: DecisionOutcome) => void;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [receipts, setReceipts] = useState<
    ReadonlyMap<string, ApprovalReceipt>
  >(new Map());
  const [clock, setClock] = useState(nowMs);
  const time = Math.max(nowMs, clock);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') setClock(Date.now());
    });
    return () => subscription.remove();
  }, []);
  const cards = useMemo(
    () =>
      entries.map(entry => ({
        id: entry.id,
        bundle: phoneRequestBundle(
          entry.card,
          directory,
          viewerMemberId,
          entry.gate,
          receipts.get(entry.id) ?? entry.receipt,
          time,
          offline,
          entry.run,
        ),
      })),
    [entries, directory, viewerMemberId, receipts, time, offline],
  );
  const [selection, setSelection] = useState(() =>
    createDecisionStage(cards, selectedId),
  );
  const model = decisionStageModel(selection, cards);
  const current = model.current;
  const entry = entries.find(candidate => candidate.id === current?.id);
  const [feedback, setFeedback] = useState<{
    id: string;
    receipt: ApprovalReceipt;
  } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [current?.id]);
  // 큰 글씨(접근성 크기, 다른 폰 표면과 같은 문턱)에서는 결정 패널이 본문 아래 고정 칸을 떠나 본문 끝에서 함께 흐른다(#4921).
  // 고정 패널·썸네일이 화면을 나눠 가지면 본문 창은 제목 한 덩이로 차서 값·되돌릴 수 없음·비용이 접힌 아래에 숨고
  // 결정 단추만 남았다. 흐르는 칸에서는 단추가 언제나 그 내용 뒤에 선다.
  const {fontScale} = useWindowDimensions();
  const flowing = fontScale >= STACK_PILL_SCALE;
  const body = useRef<ScrollView | null>(null);
  const bodyMetrics = useRef({viewport: 0, content: 0, offset: 0});
  const [bodyFrame, setBodyFrame] = useState({y: 0, height: 0});
  const [moreBelow, setMoreBelow] = useState(false);
  const syncMoreBelow = () => {
    const {viewport, content, offset} = bodyMetrics.current;
    setMoreBelow(viewport > 0 && content - (offset + viewport) > BODY_END_SLOP);
  };
  const onBodyLayout = (event: LayoutChangeEvent) => {
    const {y, height} = event.nativeEvent.layout;
    bodyMetrics.current.viewport = height;
    setBodyFrame({y, height});
    syncMoreBelow();
  };
  const onBodyContentSize = (_width: number, height: number) => {
    bodyMetrics.current.content = height;
    syncMoreBelow();
  };
  const onBodyScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, layoutMeasurement, contentSize} = event.nativeEvent;
    bodyMetrics.current = {
      viewport: layoutMeasurement.height,
      content: contentSize.height,
      offset: contentOffset.y,
    };
    syncMoreBelow();
  };
  // 다른 장으로 넘기면 본문은 그 장의 맨 위에서 시작한다. 흐르는 본문은 길어서, 앞 장에서 내린 자리가 남으면 새 장의
  // 제목·값을 지나쳐 단추 앞에서 시작한다.
  useEffect(() => {
    body.current?.scrollTo({y: 0, animated: false});
  }, [current?.id]);
  const busyRef = useRef(false);
  const multipleTouches = useRef(false);
  const heading = useRef<View | Text | null>(null);
  const alive = useRef(true);
  const hero = useDecisionStageHero(
    current?.id === selectedId ? source : undefined,
    onClose,
  );
  const canNavigate =
    hero.stage.phase === 'open' &&
    !busy &&
    !feedback &&
    !complete &&
    !loading &&
    !error;
  const move = (direction: 'next' | 'previous') => {
    if (!canNavigate || busyRef.current) return;
    const next = moveDecisionStage(selection, cards, direction);
    if (next === selection) return;
    hero.restore();
    setSelection(next);
    haptics.event('filterChanged');
  };
  const gestureRef = useRef({
    canNavigate,
    move,
    close: hero.close,
    restore: hero.restore,
  });
  gestureRef.current = {
    canNavigate,
    move,
    close: hero.close,
    restore: hero.restore,
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        // This dedicated drag handle has no nested ScrollView/buttons to steal touches from.
        onStartShouldSetPanResponder: () =>
          gestureRef.current.canNavigate && !busyRef.current,
        onPanResponderGrant: () => {
          multipleTouches.current = false;
          hero.drag.stopAnimation();
        },
        onPanResponderStart: event => {
          if (event.nativeEvent.touches.length > 1)
            multipleTouches.current = true;
        },
        onPanResponderMove: (_event, gesture) => {
          if (gesture.numberActiveTouches > 1) multipleTouches.current = true;
          if (
            !gestureRef.current.canNavigate ||
            busyRef.current ||
            multipleTouches.current
          )
            return;
          hero.offset.current = {x: gesture.dx, y: gesture.dy};
          hero.drag.setValue(hero.offset.current);
        },
        onPanResponderRelease: (_event, gesture) => {
          if (
            !gestureRef.current.canNavigate ||
            busyRef.current ||
            multipleTouches.current ||
            gesture.numberActiveTouches > 1
          ) {
            gestureRef.current.restore();
            return;
          }
          const action = decisionStageDragAction({
            x: gesture.dx,
            y: gesture.dy,
            velocityX: gesture.vx,
            velocityY: gesture.vy,
          });
          if (action === 'close') void gestureRef.current.close();
          else if (action === 'next' || action === 'previous') {
            gestureRef.current.move(action);
            gestureRef.current.restore();
          } else gestureRef.current.restore();
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderTerminate: () => gestureRef.current.restore(),
      }),
    [hero.drag, hero.offset],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!selection.cardIds.length && cards.length)
      setSelection(createDecisionStage(cards, selectedId));
  }, [selection.cardIds.length, cards, selectedId]);
  useEffect(() => {
    const future = entries.flatMap(item => {
      const expiry = item.gate?.expiresAtMs ?? item.card.expiresAtMs;
      return expiry !== undefined && expiry > time ? [expiry] : [];
    });
    const timer = setTimeout(
      () => setClock(Date.now()),
      future.length ? Math.min(60_000, Math.min(...future) - time) : 60_000,
    );
    return () => clearTimeout(timer);
  }, [entries, time]);
  useEffect(() => {
    if (hero.stage.phase !== 'open') return;
    const handle = findNodeHandle(heading.current);
    if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
  }, [hero.stage.phase, current?.id, complete, loading, error]);
  const restoreDrag = hero.restore;
  const advance = useCallback(() => {
    setFeedback(null);
    restoreDrag();
    if (model.allProcessed) {
      setComplete(true);
      AccessibilityInfo.announceForAccessibility('모두 처리했어요');
    } else setSelection(previous => nextPendingDecisionStage(previous, cards));
  }, [cards, model.allProcessed, restoreDrag]);
  useEffect(() => {
    if (!feedback || feedback.receipt.secretOnce) return;
    // The receipt stays long enough to read; an explicit next button also works with VoiceOver.
    const timer = setTimeout(advance, 260);
    return () => clearTimeout(timer);
  }, [feedback, advance]);
  const settle = (id: string, outcome: DecisionOutcome) => {
    if (outcome.kind === 'error') return;
    onSettled(id, outcome);
    if (!alive.current) return;
    if (!outcome.status || outcome.status === 'pending') {
      setUnconfirmed(id);
      return;
    }
    const receipt: ApprovalReceipt = {
      status: outcome.status,
      note: decisionReceiptCopy(outcome),
      secretOnce: linkOnceFrom(outcome),
    };
    setReceipts(previous => new Map(previous).set(id, receipt));
    setUnconfirmed(null);
    setFeedback({id, receipt});
  };
  const summary = (
    <View style={styles.card}>
      <Sentence style={styles.title}>
        {current?.bundle.headline ?? '결정 보기'}
      </Sentence>
      {current?.bundle.valueChips.map((value, index) => (
        <Sentence key={index} style={styles.body}>
          {value.labelText}
        </Sentence>
      ))}
    </View>
  );
  const stageOpen = hero.stage.phase === 'open';
  // 결정 패널. 기본 크기에서는 본문 아래 고정 칸에, 큰 글씨(`flowing`)에서는 본문 끝에 선다(위 주석).
  const actions =
    stageOpen &&
    !loading &&
    !error &&
    !complete &&
    !feedback &&
    current?.bundle.canDecide &&
    current.bundle.state === 'approval' &&
    entry ? (
      <GlassSurface
        radius={ds2Radius.card}
        style={styles.actions}
        testID="decision-stage-actions-glass"
      >
        <ApprovalDecision
          key={current.id}
          approvalId={current.bundle.approvalId!}
          execution={entry.card.execution}
          shape="request"
          subject={current.bundle.headline}
          lead="결정은 버튼을 눌러요"
          forbiddenCopy={
            entry.card.action?.requiredRole
              ? roleRequiredCopy(entry.card.action.requiredRole)
              : null
          }
          testIDPrefix="decision-stage"
          onBusyChange={value => {
            busyRef.current = value;
            if (alive.current) setBusy(value);
          }}
          onSettled={outcome => settle(current.id, outcome)}
        />
      </GlassSurface>
    ) : null;

  return (
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      presentationStyle="overFullScreen"
      onShow={() => {
        void hero.enter();
      }}
      onRequestClose={() => {
        void hero.close();
      }}
    >
      <SafeAreaProvider>
        <View
          style={styles.root}
          testID="decision-stage"
          accessibilityViewIsModal
          onAccessibilityEscape={() => {
            void hero.close();
          }}
        >
          <LiquidGlassAllowed.Provider value={false}>
            <GlassSurface
              radius={0}
              style={StyleSheet.absoluteFill}
              testID="decision-stage-backdrop"
            />
          </LiquidGlassAllowed.Provider>
          <SafeAreaView style={styles.layout}>
            <View style={styles.header}>
              <Text style={styles.meta}>결정 보기</Text>
              <CloseCircle
                label="결정 무대 닫기"
                onPress={() => {
                  void hero.close();
                }}
                testID="decision-stage-close"
              />
            </View>
            <ScrollView
              ref={body}
              style={styles.bodyScroll}
              contentContainerStyle={[
                styles.bodyContent,
                flowing && styles.bodyContentFlow,
              ]}
              keyboardShouldPersistTaps="handled"
              testID="decision-stage-body"
              scrollEventThrottle={16}
              onLayout={flowing ? onBodyLayout : undefined}
              onContentSizeChange={flowing ? onBodyContentSize : undefined}
              onScroll={flowing ? onBodyScroll : undefined}
            >
              <Animated.View
                ref={hero.content}
                onLayout={() => {
                  void hero.enter();
                }}
                style={[
                  styles.card,
                  {transform: hero.drag.getTranslateTransform()},
                  hero.stage.phase !== 'open' && styles.hidden,
                ]}
                pointerEvents={hero.stage.phase === 'open' ? 'auto' : 'none'}
                accessibilityElementsHidden={hero.stage.phase !== 'open'}
                testID="decision-stage-card"
              >
                {loading ? (
                  <>
                    <ActivityIndicator />
                    <Sentence style={styles.body}>
                      결정을 불러오는 중이에요
                    </Sentence>
                  </>
                ) : error ? (
                  <>
                    <Sentence style={styles.body}>{error}</Sentence>
                    {onRetry ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="다시 불러오기"
                        onPress={onRetry}
                        style={styles.control}
                      >
                        <Text style={styles.body}>다시 불러오기</Text>
                      </Pressable>
                    ) : null}
                  </>
                ) : complete ? (
                  <Text
                    ref={heading}
                    style={styles.title}
                    accessibilityRole="header"
                  >
                    모두 처리했어요
                  </Text>
                ) : current && entry ? (
                  <>
                    <View
                      ref={heading}
                      // 큰 글씨(`flowing`)에서는 끌기 응답자를 달지 않는다(#4921). 제목·안내 줄(= 이 손잡이)이 첫 화면을 거의 다 덮어서,
                      // 터치 시작에서 가로채는 손잡이가 본문을 내리려는 세로 끌기를 스크롤 대신 「무대 닫기」로 읽는다(시뮬레이터에서
                      // 확인). 가로 끌기만 움직임에서 가져가는 길도 시험했지만 시뮬레이터의 가로 끌기가 넘어가지 않았다. 이 크기의 넘기기·닫기는
                      // 이전/다음·썸네일·닫기 단추와 VoiceOver 동작(아래 `accessibilityActions`)이 맡는다. 없는 끌기를 말하는 안내 문장(낭독 힌트·
                      // 「끌어 넘겨 보기」 줄)도 이 크기에서는 서지 않는다.
                      {...(flowing ? undefined : responder.panHandlers)}
                      testID="decision-stage-drag"
                      accessible
                      accessibilityRole="adjustable"
                      accessibilityLabel={`${current.bundle.headline}. ${model.positionLabel}`}
                      accessibilityHint={
                        flowing
                          ? undefined
                          : '가로로 끌어 넘겨 보고 세로로 끌어 닫아요. 결정은 버튼을 눌러요.'
                      }
                      accessibilityActions={[
                        {name: 'increment', label: '다음 결정'},
                        {name: 'decrement', label: '이전 결정'},
                        {name: 'close', label: '결정 무대 닫기'},
                      ]}
                      onAccessibilityAction={event => {
                        const action = event.nativeEvent.actionName;
                        if (action === 'close') void hero.close();
                        else if (action === 'increment') move('next');
                        else if (action === 'decrement') move('previous');
                      }}
                    >
                      <Text style={styles.title} accessibilityRole="header">
                        {current.bundle.headline}
                      </Text>
                      {flowing ? null : (
                        <Text style={styles.meta}>
                          끌어 넘겨 보기 · 결정은 버튼을 눌러요
                        </Text>
                      )}
                    </View>
                    {offline ? (
                      <Sentence style={styles.body}>
                        연결이 없어요. 내용을 살펴보고 연결되면 결정해 주세요.
                      </Sentence>
                    ) : null}
                    {current.bundle.valueChips.map((value, index) => (
                      <View
                        key={index}
                        style={styles.value}
                        accessible
                        accessibilityLabel={value.labelText}
                      >
                        <Text style={styles.meta}>{value.label}</Text>
                        <Sentence style={styles.body}>
                          {value.before !== undefined
                            ? `${value.before} → `
                            : ''}
                          {value.after ?? value.value}
                        </Sentence>
                      </View>
                    ))}
                    {entry.card.isReversible !== undefined ? (
                      <Sentence style={styles.body}>
                        {entry.card.isReversible
                          ? '되돌릴 수 있어요'
                          : '실행하면 되돌릴 수 없어요'}
                      </Sentence>
                    ) : null}
                    {entry.card.estimatedMicroUsd !== undefined ? (
                      <Sentence style={styles.body}>
                        예상 비용 {formatMicroUsd(entry.card.estimatedMicroUsd)}
                      </Sentence>
                    ) : null}
                    <Sentence style={styles.meta}>
                      {current.bundle.quietLine}
                    </Sentence>
                    {current.bundle.waitingFor ? (
                      <Sentence style={styles.body}>
                        {current.bundle.waitingFor}
                      </Sentence>
                    ) : null}
                    {current.bundle.state !== 'approval' ? (
                      <Sentence style={styles.body}>
                        {current.bundle.sentence}
                      </Sentence>
                    ) : null}
                    {unconfirmed === current.id ? (
                      <Sentence style={styles.body}>
                        결정 상태를 확인하지 못했어요. 닫고 다시 열어 주세요.
                      </Sentence>
                    ) : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        expanded ? '자세히 접기' : current.bundle.details.label
                      }
                      onPress={() => setExpanded(value => !value)}
                      accessibilityState={{expanded}}
                      style={styles.control}
                    >
                      <Text style={styles.meta}>자세히</Text>
                    </Pressable>
                    {expanded
                      ? current.bundle.details.rows
                          .filter(row => {
                            const viewer = memberFor(directory, viewerMemberId);
                            return (
                              viewer?.role === 'owner' ||
                              viewer?.role === 'admin' ||
                              !entry.card.detail.rows.includes(row)
                            );
                          })
                          .map((row, index) => (
                            <Sentence key={index} style={styles.body}>
                              {row.label} · {row.value}
                            </Sentence>
                          ))
                      : null}
                    {feedback?.id === current.id ? (
                      <View accessibilityLiveRegion="polite">
                        <Sentence style={styles.body}>
                          {feedback.receipt.note}
                        </Sentence>
                        {feedback.receipt.secretOnce ? (
                          <LinkOnce
                            secret={feedback.receipt.secretOnce}
                            testIDPrefix="decision-stage"
                          />
                        ) : null}
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="다음 결정 보기"
                          style={styles.control}
                          onPress={advance}
                        >
                          <Text style={styles.body}>다음 결정 보기</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </>
                ) : (
                  <Text ref={heading} style={styles.body}>
                    지금 살펴볼 결정이 없어요.
                  </Text>
                )}
              </Animated.View>
              {flowing ? actions : null}
            </ScrollView>
            {flowing && moreBelow && stageOpen ? (
              // 흐르는 본문이 창보다 길고 끝이 아닐 때 「아래에 더 있다」. 대화 입력창 후보 시트의 표지와 같은 도형이고
              // 눌리지 않으며 보조기술에는 서지 않는다(스크린리더는 순서대로 읽어 내려간다). 높이를 먹지 않는 겹침이다.
              <View
                style={[
                  styles.moreCue,
                  {top: bodyFrame.y + bodyFrame.height - space.xl},
                ]}
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                testID="decision-stage-more-cue"
              >
                <View style={styles.moreChevron} />
              </View>
            ) : null}
            {flowing ? null : actions}
            <View style={styles.navigation}>
              <View style={styles.header}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="이전 결정"
                  accessibilityState={{
                    disabled: !canNavigate || model.index <= 0,
                  }}
                  disabled={!canNavigate || model.index <= 0}
                  onPress={() => move('previous')}
                  style={styles.control}
                >
                  <Text style={styles.body}>이전</Text>
                </Pressable>
                <Text
                  style={styles.meta}
                  accessibilityLiveRegion="polite"
                  testID="decision-stage-position"
                >
                  {model.positionLabel}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="다음 결정"
                  accessibilityState={{
                    disabled:
                      !canNavigate || model.index >= model.cards.length - 1,
                  }}
                  disabled={
                    !canNavigate || model.index >= model.cards.length - 1
                  }
                  onPress={() => move('next')}
                  style={styles.control}
                >
                  <Text style={styles.body}>다음</Text>
                </Pressable>
              </View>
              <ScrollView
                horizontal
                style={styles.thumbnails}
                contentContainerStyle={styles.thumbnailRow}
                testID="decision-stage-thumbnails"
              >
                {model.cards.map(card => (
                  <Pressable
                    key={card.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${card.bundle.headline}, ${card.bundle.word}`}
                    accessibilityState={{
                      selected: current?.id === card.id,
                      disabled: !canNavigate,
                    }}
                    disabled={!canNavigate}
                    onPress={() => {
                      if (!canNavigate || busyRef.current) return;
                      hero.restore();
                      setSelection(previous => ({
                        ...previous,
                        selectedId: card.id,
                      }));
                      haptics.event('filterChanged');
                    }}
                    style={[
                      styles.thumbnail,
                      current?.id === card.id && styles.selected,
                    ]}
                    testID={`decision-stage-thumbnail-${card.id}`}
                  >
                    <Text style={styles.meta} numberOfLines={2}>
                      {card.bundle.headline}
                    </Text>
                    <Text style={styles.meta}>{card.bundle.word}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </SafeAreaView>
          {hero.hero ? (
            <StageHero
              key={`${hero.stage.ticket}-${hero.hero.closing}`}
              {...hero.hero}
              rectRef={hero.rect}
              onArrive={hero.arrived}
            >
              {summary}
            </StageHero>
          ) : null}
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    layout: {flex: 1, paddingHorizontal: space.lg, gap: space.sm},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space.sm,
    },
    bodyScroll: {flex: 1},
    bodyContent: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingVertical: space.md,
    },
    // 큰 글씨: 위에서부터 읽고(가운데 정렬은 패널이 열릴 때 카드를 밀어 올린다), 카드와 패널 사이를 띄운다.
    bodyContentFlow: {justifyContent: 'flex-start', gap: space.md},
    moreCue: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: space.xl,
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingBottom: space.xs,
    },
    moreChevron: {
      width: 10,
      height: 10,
      borderRightWidth: 2,
      borderBottomWidth: 2,
      borderColor: color.textMuted,
      transform: [{rotate: '45deg'}],
    },
    card: {
      backgroundColor: color.surface,
      borderRadius: ds2Radius.card,
      padding: space.lg,
      gap: space.md,
    },
    title: {
      fontSize: font.title,
      lineHeight: line.title,
      fontWeight: '600',
      color: color.text,
    },
    body: {fontSize: font.body, lineHeight: line.body, color: color.text},
    meta: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    value: {
      backgroundColor: color.surfaceMuted,
      borderRadius: radius.md,
      padding: space.sm,
      gap: space.xs,
    },
    control: {
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET,
      justifyContent: 'center',
      padding: space.sm,
    },
    actions: {padding: space.md},
    navigation: {gap: space.xs, paddingBottom: space.sm},
    thumbnails: {flexGrow: 0, flexShrink: 1},
    thumbnailRow: {gap: space.sm},
    thumbnail: {
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET,
      maxWidth: TOUCH_TARGET * 3,
      padding: space.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
    },
    selected: {borderColor: color.text, backgroundColor: color.surfaceMuted},
    hidden: {opacity: 0},
  });
