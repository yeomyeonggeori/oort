import {
  lastRunningRowId,
  workTimelineRowCopy,
  workTimelineSourceLabel,
  workTimelineSourceNote,
  workToolSummaryText,
  type WorkTimelineRow,
  type WorkTimelineSource,
  type WorkTimelineStatus,
  type WorkToolRecord,
} from '@momo/core/features/agents/workTimeline';
import {
  workActivityTallyText,
  type WorkActivityRecord,
} from '@momo/core/features/agents/workReport';
import {
  workPlanCopy,
  workPlanStepWord,
  type WorkPlanProgress,
  type WorkPlanStep,
  type WorkPlanStepState,
} from '@momo/core/features/work/workPlan';
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Image, StyleSheet, Text, View} from 'react-native';
import {CONV_ICONS, CONV_ICON_SIZE} from '../../design/icons';
import {EASE_OUT} from '../../design/motion';
import {circleLook} from '../../design/sheetModel';
import {GroupCard, GroupCardItem} from '../../design/sheetParts';
import {usePalette, useStyles} from '../../design/theme';
import {ds2Radius, font, line, SHEET, space, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useReduceMotion} from '../../lib/useReduceMotion';

// =============================================================================
// 작업 타임라인의 칸과 줄 — 폰 판 (#4658, 웹 `WorkTimelineView`의 짝). 규칙은 전부 코어(`workTimeline`·`workReport`·
// `workPlan`)가 정하고 이 파일은 **그리기만** 한다: 무엇을 접고(읽기·검색 묶음) 무엇을 개별 줄로 세우는지, 칸을 출처마다
// 어떻게 가르는지, 계획 진척을 어떻게 세는지, 문장이 무엇인지는 웹과 **같은 함수·같은 사전 키**다. 에이전트·하네스가 쓴
// 글(`label`)과 계획 글은 믿지 않는 일반 텍스트라 텍스트 노드로만 그린다.
//
// ## 모션 (웹과 같은 규칙, 새 값 없이 기존 사다리만 — A1 4-6)
//
//   1. **새 줄**: 불투명도만 240ms(사다리 `standard`)로 선다. 이동 없음(transform 없음). 화면을 처음 그릴 때 이미 있던 줄은
//      움직이지 않고 새로 **도착한** 줄만이다(`useArrivedIds`).
//   2. **상태 변화**(진행 → 끝남·실패·끝 보고 없음): **같은 줄**(같은 id = 같은 인스턴스)에서 칩의 색만 120ms(사다리
//      `instant`)로 바뀐다. 줄을 다시 끼우지 않는다 — 줄은 `row.id`로 키를 건다(`GroupCard`는 자식을 자리(index)로 키를
//      걸어 접힘으로 자리가 바뀌면 인스턴스가 다른 줄로 넘어가므로 쓰지 않는다).
//   3. **움직이는 건 하나**: 진행 중인 **마지막** 줄의 점 하나(불투명도 루프). 연결이 끊기거나 서버가 「지금 돈다」고 말하지
//      않으면 점도 걷힌다(`live`). 다른 진행 중 줄은 정지다.
//   4. **숫자**: 시각은 「14:05」, 개수는 `tabular-nums`로 폭이 고정이고 초 단위 숫자도 카운트업도 없다.
//   5. **동작 줄이기**: 사다리가 0이 된다 — 새 줄은 바로 서고, 색은 바로 바뀌고, 점은 멈춘 채 선다(사다리 D9: 모션을 끄는 게
//      아니라 0으로 만든다, 상태는 착지한다).
//   6. **줄이 붙어도 위 줄은 움직이지 않는다**: 줄은 시간순(오래된 것이 위)이고 새 줄은 맨 아래에 붙으며, 줄 **위**에는 줄이 붙을
//      때 달라지는 것이 없다(계획 블록은 줄 위에 서고 합계·상한 문장은 줄 **아래**에 선다).
// =============================================================================

/** 새 줄이 서는 시간. 오르트 구름의 모션 사다리 `standard`(웹 `--motion-standard`)와 같은 수다. */
export const TIMELINE_ARRIVE_MS = 240;
/** 칩의 색이 바뀌는 시간. 사다리 `instant`(웹 `--motion-instant`)와 같은 수다. */
export const TIMELINE_STATE_MS = 120;

/** 점의 한 번 오르내림(`RespondingDots`와 같은 박자 1200ms, 한 점이라 오름·내림이 각 절반). */
const DOT_HALF_MS = 600;
const DOT_LOW = 0.3;
/** 동작 줄이기에서 멈춘 점의 불투명도(`RespondingDots`의 `STILL`). */
const DOT_STILL = 0.6;
const DOT_SIZE = 4;

const NO_ARRIVED: ReadonlySet<string> = new Set();

/**
 * 처음 그릴 때 없던 id를 모은다. 한 번 모이면 그 줄이 마운트된 동안 남는다: 도착 직후 다시 그려져도 불투명도 전환이 끊기지
 * 않는다. 마운트될 때 이미 있던 줄(화면을 열었을 때의 기록)은 모이지 않는다 — 칸은 **원장을 읽은 뒤에** 마운트되므로 「처음」은
 * 읽은 기록이고, 읽는 동안의 빈 화면이 아니다.
 */
export function useArrivedIds(ids: readonly string[]): ReadonlySet<string> {
  const initial = useRef<ReadonlySet<string> | null>(null);
  const arrived = useRef<Set<string>>(new Set());
  if (initial.current === null) initial.current = new Set(ids);
  for (const id of ids) {
    if (!initial.current.has(id)) arrived.current.add(id);
  }
  return arrived.current.size === 0 ? NO_ARRIVED : arrived.current;
}

/** 도착한 줄만 불투명도 0 → 1. 동작 줄이기에서는 움직이지 않고 바로 선다. 이동·크기 변화 없음. */
function ArrivalFade({
  arrived,
  children,
}: {
  arrived: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const reduceMotion = useReduceMotion();
  const [opacity] = useState(() => new Animated.Value(arrived && !reduceMotion ? 0 : 1));
  useEffect(() => {
    if (!arrived || reduceMotion) return undefined;
    const run = Animated.timing(opacity, {
      toValue: 1,
      duration: TIMELINE_ARRIVE_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [arrived, reduceMotion, opacity]);
  return <Animated.View style={{opacity}}>{children}</Animated.View>;
}

/**
 * 진행 중인 마지막 줄의 점 하나. 동작 줄이기에서는 멈춘 채 선다(곁의 「진행 중」 낱말이 상태를 말한다). 보조기술에는 나가지
 * 않는다. 점은 칩 안 왼쪽 여백에 **절대 위치**로 서므로 서고 져도 줄의 어떤 치수도 달라지지 않는다.
 */
function TimelineDot(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(DOT_LOW)).current;
  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(DOT_STILL);
      return undefined;
    }
    opacity.setValue(DOT_LOW);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: DOT_HALF_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: DOT_LOW,
          duration: DOT_HALF_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, opacity]);
  return (
    <View style={styles.dotSlot} pointerEvents="none">
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.dot, {opacity}]}
        testID={reduceMotion ? DOT_TEST_ID.still : DOT_TEST_ID.moving}
      />
    </View>
  );
}

// ---- 상태 칩 ---------------------------------------------------------------------

/** 칩의 톤: 에이전트가 지금 돌린다 · 조용한 중립 · 실패. 숫자라서 색 표·testID 표의 자리(index)가 된다. */
const TONE = {live: 0, muted: 1, failed: 2} as const;
type ChipTone = (typeof TONE)[keyof typeof TONE];
const TONE_TEST_ID = [
  'work-timeline-status-live',
  'work-timeline-status-muted',
  'work-timeline-status-failed',
] as const;

/**
 * 상태마다 칩이 어떻게 서는지. 키가 코어의 닫힌 상태 넷이라 코어가 상태를 더하면 여기서 컴파일이 막힌다(새 상태가 기본으로 `done`처럼
 * 그려지지 않는다). 끝남(`done`)은 조용해서 칩이 없으므로(`workTimelineRowCopy.statusWord`) 표에 있어도 그려지지 않는다.
 *
 * - `tone`: 연결이 끊겼거나 서버가 지금 돈다고 하지 않을 때. 끊긴 화면은 마지막으로 확인된 상태라 지금 하고 있다고 움직이지 않는다.
 * - `liveTone`: 연결이 살아 있고 서버가 지금 돈다고 말할 때. 진행 중만 에이전트색이다.
 * - `unclosed`(끝 보고 없음)는 **진행 중으로도 끝났다고도 그리지 않는다** → 어느 때나 중립. 에이전트색을 입으면 도는 중처럼 읽힌다.
 * - `reserveDot`: 진행 중 칩은 점이 있든 없든 왼쪽 여백을 늘 예약한다(점이 서고 져도, 연결이 오가도 칩 폭이 변하지 않는다).
 */
const STATUS_FACE: Record<
  WorkTimelineStatus,
  {tone: ChipTone; liveTone: ChipTone; reserveDot: boolean}
> = {
  running: {tone: TONE.muted, liveTone: TONE.live, reserveDot: true},
  done: {tone: TONE.muted, liveTone: TONE.muted, reserveDot: false},
  failed: {tone: TONE.failed, liveTone: TONE.failed, reserveDot: false},
  unclosed: {tone: TONE.muted, liveTone: TONE.muted, reserveDot: false},
};

function chipTone(status: WorkTimelineStatus, live: boolean): ChipTone {
  const face = STATUS_FACE[status];
  return live ? face.liveTone : face.tone;
}

function toneColors(color: Palette): readonly {bg: string; fg: string}[] {
  // 자리(index)는 `TONE`이다: live, muted, failed.
  return [
    {bg: color.agentSurface, fg: color.agent},
    {bg: color.surfaceMuted, fg: color.textMuted},
    {bg: color.dangerSurface, fg: color.dangerText},
  ];
}

/**
 * 상태 낱말 칩. 톤이 바뀌면(같은 줄의 진행 → 실패·끝 보고 없음, 연결이 끊겨 에이전트색이 걷힘) 색만 120ms로 옮겨 간다. 톤이 바뀐
 * **그 렌더**에서 진행값을 0으로 새로 만들어 이전 톤의 색으로 시작한다 — 효과에서 되돌리면 한 프레임 새 색이 먼저 비친다.
 */
function StatusChip({
  tone,
  word,
  reserveDot,
  dot,
}: {
  tone: ChipTone;
  word: string;
  /** 진행 중 칩은 점이 있든 없든 왼쪽 여백을 늘 예약한다: 점이 서고 져도 칩 폭이 변하지 않는다. */
  reserveDot: boolean;
  dot: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const reduceMotion = useReduceMotion();
  const [shown, setShown] = useState(() => ({
    from: tone,
    to: tone,
    progress: new Animated.Value(1),
  }));
  if (shown.to !== tone) {
    setShown({
      from: shown.to,
      to: tone,
      progress: new Animated.Value(reduceMotion ? 1 : 0),
    });
  }
  useEffect(() => {
    if (shown.from === shown.to || reduceMotion) return undefined;
    const run = Animated.timing(shown.progress, {
      toValue: 1,
      duration: TIMELINE_STATE_MS,
      easing: EASE_OUT,
      // 색은 네이티브 구동에 맡기지 않는다: 칩 하나이고 120ms라 JS 구동으로 충분하다.
      useNativeDriver: false,
    });
    run.start();
    return () => run.stop();
  }, [shown, reduceMotion]);
  const colors = toneColors(palette);
  const from = colors[shown.from];
  const to = colors[shown.to];
  const bg = shown.progress.interpolate({inputRange: [0, 1], outputRange: [from.bg, to.bg]});
  const fg = shown.progress.interpolate({inputRange: [0, 1], outputRange: [from.fg, to.fg]});
  return (
    <Animated.View
      style={[styles.chip, reserveDot && styles.chipDot, {backgroundColor: bg}]}
      testID={TONE_TEST_ID[tone]}>
      {dot ? <TimelineDot /> : null}
      <Animated.Text style={[styles.chipText, {color: fg}]} testID="work-timeline-status">
        {word}
      </Animated.Text>
    </Animated.View>
  );
}

// ---- 줄 ---------------------------------------------------------------------------

/** 줄의 testID: `work-timeline-row-<상태>`. JSX 식 밖에서 만든다(식 안의 문자열은 직접 문구 장부가 문구 후보로 센다). */
function rowTestId(status: WorkTimelineStatus): string {
  return `work-timeline-row-${status}`;
}

/** 계획 단계의 testID들. 같은 이유로 식 밖에서 만든다. */
function planMarkTestId(state: WorkPlanStepState): string {
  return `work-plan-mark-${state}`;
}
function planStepTestId(state: WorkPlanStepState): string {
  return `run-ledger-plan-step-${state}`;
}

const DOT_TEST_ID = {still: 'timeline-dot-still', moving: 'timeline-dot-moving'} as const;

function TimelineRow({
  row,
  nowMs,
  live,
  dot,
}: {
  row: WorkTimelineRow;
  nowMs: number;
  live: boolean;
  dot: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const copy = workTimelineRowCopy(row, formatMessage, nowMs);
  return (
    <View style={styles.row} testID={rowTestId(row.status)}>
      <View style={styles.rowLine}>
        <Text style={styles.time} testID="work-timeline-time">
          {copy.time}
        </Text>
        {/* 이름은 도구 낱말이거나 에이전트가 쓴 글이다. 텍스트 노드로만 그리고 긴 글은 어절 단위로 접는다. */}
        <Text style={styles.label} lineBreakStrategyIOS="hangul-word" testID="work-timeline-label">
          {copy.label}
          {copy.repeat !== null ? (
            <Text style={styles.muted} testID="work-timeline-repeat">{` ${copy.repeat}`}</Text>
          ) : null}
        </Text>
        {copy.statusWord !== null ? (
          <StatusChip
            tone={chipTone(row.status, live)}
            word={copy.statusWord}
            reserveDot={STATUS_FACE[row.status].reserveDot}
            dot={dot}
          />
        ) : null}
        {copy.duration !== null ? (
          <Text style={styles.time} testID="work-timeline-duration">
            {copy.duration}
          </Text>
        ) : null}
      </View>
      {copy.failure !== null ? (
        <Text style={styles.note} lineBreakStrategyIOS="hangul-word" testID="work-timeline-failure">
          {copy.failure}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * 한 칸의 줄들. 카드 모양은 `GroupCardItem`(줄마다 한 칸)이 주고, **키는 `row.id`**다 — 같은 id의 상태 변화는 같은 인스턴스에서
 * 일어난다. 점은 진행 중인 마지막 줄에만, 그것도 `live`일 때만 선다.
 */
export function TimelineRows({
  rows,
  nowMs,
  live,
  arrived,
  testID,
}: {
  rows: readonly WorkTimelineRow[];
  nowMs: number;
  /** 서버가 지금 돈다고 말하고 실시간 연결도 살아 있는가: 점과 에이전트색의 조건. */
  live: boolean;
  arrived: ReadonlySet<string>;
  testID: string;
}): React.JSX.Element {
  const dotRowId = live ? lastRunningRowId(rows) : null;
  return (
    <View testID={testID}>
      {rows.map((row, index) => (
        <GroupCardItem key={row.id} index={index} count={rows.length}>
          <ArrivalFade arrived={arrived.has(row.id)}>
            <TimelineRow row={row} nowMs={nowMs} live={live} dot={dotRowId === row.id} />
          </ArrivalFade>
        </GroupCardItem>
      ))}
    </View>
  );
}

// ---- 칸 ---------------------------------------------------------------------------

/** 칸 머리: 출처 배지 + 이 칸의 내용을 누가 말하는지 한 줄(믿음의 정도를 칸이 직접 말한다). */
function SourceHead({
  source,
  agent = false,
}: {
  source: WorkTimelineSource;
  /** 에이전트가 스스로 알린 칸이다(배지가 에이전트색): 믿음의 정도가 칸마다 다르다는 것을 색도 말한다. */
  agent?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  return (
    <View style={styles.sourceHead}>
      <View
        style={[styles.badge, agent && styles.badgeAgent]}
        testID="work-timeline-source-badge">
        <Text
          accessibilityRole="header"
          style={[styles.badgeText, agent && styles.badgeTextAgent]}>
          {workTimelineSourceLabel(source, formatMessage)}
        </Text>
      </View>
      <Text style={styles.note} lineBreakStrategyIOS="hangul-word" testID="work-timeline-source-note">
        {workTimelineSourceNote(source, formatMessage)}
      </Text>
    </View>
  );
}

/** 칸 안의 상태 문장(구 서버·빈 칸): 카드 안에 서야 시트 몸의 거터와 겹치지 않는다. */
function StateCard({
  children,
  testID,
}: {
  children: string;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <GroupCard>
      <View style={styles.stateBlock}>
        <Text style={styles.stateText} lineBreakStrategyIOS="hangul-word" testID={testID}>
          {children}
        </Text>
      </View>
    </GroupCard>
  );
}

/**
 * 계획 단계의 표지. 완료는 체크, 지금 단계는 점선 원, 대기는 빈 원 — 색과 모양과 낱말(접근성 이름) 셋으로 갈린다. 낱말 비교 없이
 * 코어가 주는 불리언(`done`·`current`)으로 고른다.
 */
function PlanMark({step}: {step: WorkPlanStep}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  if (step.done) {
    return (
      <Image
        source={CONV_ICONS.check}
        style={styles.planCheck}
        accessible={false}
        testID={planMarkTestId(step.state)}
      />
    );
  }
  return (
    <View
      style={[styles.planCircle, step.current ? styles.planCircleCurrent : styles.planCirclePending]}
      testID={planMarkTestId(step.state)}
    />
  );
}

/**
 * 에이전트가 계획으로 알린 단계 목록(ADR-0200 증보 7: 통째 교체되는 최신 계획). 지금 단계는 굵게 + 점선 원이고 **움직이지
 * 않는다**. 단계는 같은 자리(index)에서 상태만 바뀌므로 줄이 다시 끼워지지 않는다. 글은 에이전트가 쓴 믿지 않는 일반 텍스트다.
 */
export function AgentPlanBlock({plan}: {plan: WorkPlanProgress}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const copy = workPlanCopy(plan, {maybeStale: false}, formatMessage);
  return (
    <GroupCard testID="run-ledger-plan">
      <View style={styles.plan}>
        <Text
          accessibilityRole="header"
          style={styles.planTitle}
          lineBreakStrategyIOS="hangul-word"
          testID="run-ledger-plan-title">
          {copy.title}
        </Text>
        <View testID="run-ledger-plan-steps">
          {plan.steps.map((step, index) => (
            <View
              // 계획은 통째로 바뀌므로 자리(index)가 열쇠다: 같은 자리의 단계는 같은 줄에서 상태만 바뀐다.
              key={index}
              accessible
              accessibilityLabel={`${step.content}, ${workPlanStepWord(step, formatMessage)}`}
              style={styles.planStep}
              testID={planStepTestId(step.state)}>
              <PlanMark step={step} />
              <Text
                style={[
                  styles.planText,
                  step.current && styles.planTextCurrent,
                  step.done && styles.muted,
                ]}
                lineBreakStrategyIOS="hangul-word">
                {step.content}
              </Text>
            </View>
          ))}
        </View>
        {!plan.live && !plan.allDone ? (
          <Text style={styles.note} lineBreakStrategyIOS="hangul-word" testID="run-ledger-plan-note">
            {formatMessage('timeline.workReport.planNotLive')}
          </Text>
        ) : null}
      </View>
    </GroupCard>
  );
}

/**
 * 시트의 「에이전트 보고」 칸: 에이전트가 스스로 알린 활동과 계획(ADR-0200 증보 7 7-7, 웹 `AgentReportSection`과 같은 말). 서버가
 * 잰 「oort 기록」 칸과 **다른 칸**이다. 네 가지 상태가 다 말이 있다: 구 서버(`include=activity`를 모름)는 「서버 업데이트 뒤에
 * 보여요」, 알린 것이 없으면 「없어요」(열린 run과 끝난 run의 말이 다르다), 있으면 계획 블록 + 줄, 줄 아래에는 끝난 활동 합계와
 * (줄이 합계보다 적을 때) 한 줄이 선다.
 *
 * 순서가 이동 0의 계약이다: 계획 블록은 줄 위, 합계·상한은 줄 아래. 계획 블록은 계획이 **처음 도착할 때** 한 번 줄을 밀 수 있다
 * (새 줄이 붙는 게 아니라 블록이 서는 것이고, 첫 보고 시각을 모르는 계획은 타임라인에 자리를 못 잡는다 — `workReport` 머리 5).
 */
export function AgentReportSection({
  record,
  open,
  live,
  nowMs,
}: {
  record: WorkActivityRecord;
  /** 이 run이 아직 열려 있는가(빈 칸의 말이 달라진다). */
  open: boolean;
  /** 서버가 지금 돈다고 말하고 연결도 살아 있는가(점·진행 중 칩의 색). */
  live: boolean;
  nowMs: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const arrived = useArrivedIds(record.rows.map(row => row.id));
  const tally = workActivityTallyText(record.tally, formatMessage);
  const empty = record.supported && record.rows.length === 0 && record.plan === null;
  return (
    <View style={styles.section} testID="run-ledger-agent-report">
      <SourceHead source="agent" agent />
      {!record.supported ? (
        <StateCard testID="run-ledger-agent-unsupported">
          {formatMessage('timeline.workReport.unsupported')}
        </StateCard>
      ) : (
        <>
          {record.plan !== null ? <AgentPlanBlock plan={record.plan} /> : null}
          {empty ? (
            <StateCard testID="run-ledger-agent-empty">
              {formatMessage(open ? 'timeline.workReport.emptyOpen' : 'timeline.workReport.emptyEnded')}
            </StateCard>
          ) : null}
          {record.rows.length > 0 ? (
            <TimelineRows
              rows={record.rows}
              nowMs={nowMs}
              live={live}
              arrived={arrived}
              testID="run-ledger-agent-rows"
            />
          ) : null}
          {tally !== null || record.trimmed ? (
            <View style={styles.footer}>
              {tally !== null ? (
                <Text style={styles.note} lineBreakStrategyIOS="hangul-word" testID="run-ledger-agent-tally">
                  {tally}
                </Text>
              ) : null}
              {record.trimmed ? (
                <Text style={styles.note} lineBreakStrategyIOS="hangul-word" testID="run-ledger-agent-trimmed">
                  {formatMessage('timeline.workReport.trimmed')}
                </Text>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

/**
 * 시트의 「oort 기록」 칸: oort가 직접 잰 도구 호출(ADR-0200 증보 2026-10-15). 네 가지 상태가 다 말이 있다. 구 서버(`include=tools`를
 * 모름)는 「서버 업데이트 뒤에 보여요」, 호출이 아직 없으면 「없어요」(열린 run과 끝난 run의 말이 다르다), 줄이 있으면 합계 한 줄 +
 * 줄, 줄 상한을 넘었으면 합계가 모두 센 값이라는 한 줄. 합계는 행 상한(100)을 넘은 호출까지 센 서버 값이다.
 */
export function OortRecordSection({
  record,
  open,
  nowMs,
}: {
  record: WorkToolRecord;
  open: boolean;
  nowMs: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const arrived = useArrivedIds(record.rows.map(row => row.id));
  // 호출이 0번이면 합계 줄은 서지 않는다: 빈 칸 문장이 이미 같은 말을 한다.
  const summary =
    record.tally !== null && record.tally.calls > 0
      ? workToolSummaryText(record.tally, formatMessage)
      : null;
  return (
    <View style={styles.section} testID="run-ledger-oort-record">
      <SourceHead source="oort" />
      {!record.supported ? (
        <StateCard testID="run-ledger-oort-unsupported">
          {formatMessage('timeline.workRecord.unsupported')}
        </StateCard>
      ) : (
        <>
          {summary !== null ? (
            <Text style={styles.summaryLine} lineBreakStrategyIOS="hangul-word" testID="run-ledger-oort-summary">
              {summary}
            </Text>
          ) : null}
          {record.rows.length === 0 ? (
            <StateCard testID="run-ledger-oort-empty">
              {formatMessage(open ? 'timeline.workRecord.emptyOpen' : 'timeline.workRecord.emptyEnded')}
            </StateCard>
          ) : (
            <TimelineRows
              rows={record.rows}
              nowMs={nowMs}
              live={false}
              arrived={arrived}
              testID="run-ledger-oort-rows"
            />
          )}
          {record.capped ? (
            <Text style={styles.note} lineBreakStrategyIOS="hangul-word" testID="run-ledger-oort-capped">
              {formatMessage('timeline.workRecord.capped', {shown: record.listedCalls})}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

const buildStyles = (color: Palette) => {
  // 중립 배지(oort 기록)의 채움은 `surfaceMuted` 하나로 두지 않는다: 밝은 시트 위에서 칸이 시트와 1.00~1.01:1이라 사라진다(#5170 L1).
  // 라이트는 `surface`(카드와 같은 면), 다크는 한 단 위 `surfaceMuted` + 가장자리 한 줄이다(`circleLook`, 시트 머리의 원과 같은 답).
  const look = circleLook(color);
  return StyleSheet.create({
    // 칸 하나: 머리와 카드들은 한 묶음이다(`GroupCard`의 라벨과 같은 간격).
    section: {gap: space.sm},
    sourceHead: {gap: space.xs, paddingHorizontal: space.xs},
    badge: {
      alignSelf: 'flex-start',
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: ds2Radius.badge,
      backgroundColor: look.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: look.ring,
    },
    badgeAgent: {backgroundColor: color.agentSurface, borderColor: color.agentSurface},
    badgeText: {fontSize: font.label, lineHeight: line.label, fontWeight: '600', color: color.text},
    badgeTextAgent: {color: color.agent},
    note: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    muted: {color: color.textMuted},
    summaryLine: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
      paddingHorizontal: space.xs,
      fontVariant: ['tabular-nums'],
    },
    footer: {gap: space.xs, paddingHorizontal: space.xs},
    stateBlock: {paddingHorizontal: SHEET.cardInset, paddingVertical: space.md},
    stateText: {fontSize: font.body, lineHeight: line.body, color: color.textMuted},
    // 카드 안의 한 줄. 줄 사이는 카드의 구분선이 그린다.
    row: {
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
      gap: space.xs,
    },
    rowLine: {flexDirection: 'row', alignItems: 'baseline', gap: space.sm},
    time: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
    },
    label: {flex: 1, fontSize: font.body, lineHeight: line.body, color: color.text},
    chip: {
      paddingHorizontal: space.xs,
      borderRadius: ds2Radius.badge,
      justifyContent: 'center',
    },
    // 진행 중 칩의 왼쪽 여백은 점이 있든 없든 늘 예약한다(점이 서고 져도 칩 폭이 변하지 않는다).
    chipDot: {paddingLeft: space.md},
    chipText: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '600'},
    dotSlot: {
      position: 'absolute',
      left: space.xs,
      top: 0,
      bottom: 0,
      justifyContent: 'center',
    },
    dot: {
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: DOT_SIZE / 2,
      backgroundColor: color.agent,
    },
    plan: {
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
      gap: space.xs,
    },
    planTitle: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.text,
      fontVariant: ['tabular-nums'],
    },
    planStep: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.xs},
    planText: {flex: 1, fontSize: font.body, lineHeight: line.body, color: color.text},
    planTextCurrent: {fontWeight: '600'},
    // 표지는 글자 첫 줄 높이에 가운데로 선다.
    planCheck: {
      width: CONV_ICON_SIZE.check,
      height: CONV_ICON_SIZE.check,
      marginTop: (line.body - CONV_ICON_SIZE.check) / 2,
      tintColor: color.ok,
    },
    planCircle: {
      width: CONV_ICON_SIZE.check,
      height: CONV_ICON_SIZE.check,
      marginTop: (line.body - CONV_ICON_SIZE.check) / 2,
      borderRadius: CONV_ICON_SIZE.check / 2,
      borderWidth: 1.5,
    },
    planCircleCurrent: {borderColor: color.warn, borderStyle: 'dashed'},
    planCirclePending: {borderColor: color.textMuted},
  });
};
