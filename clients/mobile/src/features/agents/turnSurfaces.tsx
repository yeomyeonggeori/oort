import {
  elapsedLabel,
  type AgentTurnState,
  type AgentWorkingSignal,
} from '@momo/core/features/agents/workingSignal';
import {
  cancelWordingFor,
  type CancelWording,
} from '@momo/core/features/agents/runCancel';
import {
  activityDetail,
  activityLines,
  activitySuffix,
  activityText,
  isRespondingLine,
  MAX_ACTIVITY_LINES,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
  type AgentActivityLine,
  type AgentLivenessLookup,
} from '@momo/core/features/agents/turnCopy';
import {memberNameParts} from '@momo/core/features/workspace/directory';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useMemo} from 'react';
import {StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {Sentence, STACK_PILL_SCALE} from '../../design/atoms';
import {font, line as lineHeightToken, radius, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {Avatar} from '../conversation/Avatar';
import {CONV} from '../conversation/convDesign';
import {RespondingDots} from './RespondingDots';

// =============================================================================
// The two 「작업 중」 surfaces on the phone (goal RN-T2).
//
// Every word they say comes from `@momo/core/features/agents/turnCopy`, which
// is where the web client's sidebar pill and composer activity list get theirs.
// That is the whole point of the module having moved into the core: 작업 중 and
// 승인 대기 mean one thing each in this product, and a phone that spelled them
// itself would be one release away from meaning something else.
//
// ## OFFLINE is shown, not merely encoded
//
// `live` is not decoration. The web version learned this the expensive way: its
// first cut expressed a dead rail by hiding the clock and rewriting an
// aria-label, which for an `awaiting_approval` turn changed nothing at all on
// screen — the app kept asserting agent state on a socket that was gone. So here
// the agent colour comes OFF the name (a remembered claim must not look as
// confirmed as a live one) and one line says why, in place.
// =============================================================================

/**
 * A compact turn state whose colour is evidence-sensitive.
 *
 * The realtime rail is the authority on whether a remembered working claim is
 * still live, so both surfaces take the same `live` input: a row that keeps its
 * colour on a dead socket looks more certain than the rail that supplied it.
 */
export function AgentTurnBadge({
  state,
  text,
  label,
  live,
  testID,
}: {
  state: AgentTurnState;
  text: string;
  label: string;
  live: boolean;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const accessibilityLabel = live
    ? label
    : `${label} ${TURN_STALE_SENTENCE}`;
  return (
    <View
      style={[
        styles.badge,
        live && state === 'working' && styles.badgeWorking,
        live && state === 'awaiting_approval' && styles.badgeWaiting,
      ]}
      testID={testID}>
      <Text
        accessibilityLabel={accessibilityLabel}
        style={[
          styles.badgeText,
          live && state === 'working' && styles.badgeWorkingText,
          live && state === 'awaiting_approval' && styles.badgeWaitingText,
        ]}>
        {text}
      </Text>
    </View>
  );
}

/** 「답하는 중」 줄의 얼굴 크기(dp). 줄 높이(meta 글자 한 줄)와 같은 자리를 쓴다. */
const RESPONDING_FACE = 16;

/**
 * One flat line per open turn in a channel, oldest first, all shown at once.
 *
 * Deliberately NOT a rotation. Content that swaps itself every few seconds needs
 * a pause control to meet WCAG 2.2.2, and a "1/3" pager turns a work surface
 * into a slideshow. Two or three stacked lines say more and sit still — and on a
 * phone, a line that changes under a thumb already reaching for it is worse than
 * on a desktop, not better.
 *
 * The bar states a turn even before a headline exists ("김인턴이 작업 중" plus a
 * clock is a true thing the reader wants) and states an approval wait as an
 * approval wait, never as work.
 */
export function AgentActivityBar({
  turns,
  directory,
  nowMs,
  live,
  renderStop,
  livenessFor,
  testID = 'composer-working',
}: {
  turns: readonly AgentWorkingSignal[];
  directory: Directory;
  nowMs: number;
  /** The realtime rail is connected, so a clock is measuring something. */
  live: boolean;
  /**
   * 에이전트의 서버 생존 판정(D4)을 찾는 함수. 아무도 가져가지 않은 요청의 근거 줄 맨 앞에 경고 라벨이
   * 서고 「연결이 꺼져 있을 수 있어요」가 붙는 데에만 쓴다(#4285). 이 컴포넌트는 읽지 않고 받는다 —
   * 읽기는 워크스페이스와 react-query를 아는 화면의 일이다(`renderStop`과 같은 이유). 생략하면 판정
   * 없이 말한다.
   */
  livenessFor?: AgentLivenessLookup;
  /**
   * 이 턴을 멈추는 컨트롤 (goal RN-C1). 줄마다 하나이고, 이 컴포넌트는 그것을
   * **만들지 않고 자리만 내준다** — cancel은 워크스페이스와 react-query를 아는
   * 화면의 일이고, 이 파일은 문구와 배치만 안다. `runId`를 모르는 턴(레일이
   * 진행 중에 붙은 경우)에는 호출되지 않는다: 이름을 모르는 것을 멈출 수는 없다.
   */
  renderStop?: (turn: {
    runId: string;
    memberId: string;
    /** 표시명, 영수증이 부를 이름 (2R M2). */
    name: string;
    /** 이 줄로 합쳐진 동시 실행의 수 (2R M3). */
    runCount?: number;
    /** 이 줄의 실행에 맞는 낱말: 아직 아무도 가져가지 않았으면 「취소」, 가져간 뒤는 「중단」 (#4285). */
    wording: CancelWording;
  }) => React.ReactNode;
  testID?: string;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const {lines, overflowCount} = useMemo(
    () =>
      activityLines(
        turns,
        memberId => memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME),
        MAX_ACTIVITY_LINES,
        livenessFor,
      ),
    [turns, directory, livenessFor],
  );
  /**
   * 줄에서 다시 찾을 수 있게, memberId → (runId, 합쳐진 실행 수). 병합 뒤에도
   * 에이전트당 한 줄이므로 1:1이다. `runCount`는 그 줄이 몇 개의 동시 실행을
   * 접었는지이고, `runId`는 그중 가장 먼저 시작한 하나다 (2R M3).
   */
  const stops = useMemo(() => {
    const out = new Map<
      string,
      {runId: string; runCount?: number; wording: CancelWording}
    >();
    for (const turn of turns) {
      if (turn.runId === undefined) continue;
      out.set(turn.memberId, {
        runId: turn.runId,
        ...(turn.runCount === undefined ? {} : {runCount: turn.runCount}),
        // 아직 아무도 가져가지 않은 실행은 「취소」, 가져간 뒤는 「중단」(#4285).
        wording: cancelWordingFor(turn.server),
      });
    }
    return out;
  }, [turns]);

  if (lines.length === 0) return null;

  return (
    // The container is NOT `accessible`, and that is a change of REASON rather
    // than a walk-back of 2R M1.
    //
    // M1's defect was a label nobody read: an `accessibilityLabel` on a bare
    // React Native `View`, which is not an accessibility element. The fix was to
    // claim the element and carry the whole story in one label — correct while
    // the bar was text only.
    //
    // It stopped being correct the moment a 중단 button landed inside it (goal
    // RN-C1). `accessible` MERGES the subtree, and a merged subtree has no
    // focusable button in it: VoiceOver would read the sentence and offer no way
    // to act on it, which on the one surface whose whole point is "stop this" is
    // worse than the original silence.
    //
    // So the label moves down instead of disappearing: every line is a `Text`
    // (an accessibility element by default) carrying its own full sentence, the
    // overflow count and the offline line are their own elements, and each stop
    // control is its own button. Nothing is unannounced — it is announced in
    // reading order, next to the control that acts on it.
    <View style={styles.activityBar} testID={testID}>
      {lines.map(line => {
        const stop = stops.get(line.memberId);
        return (
          <ActivityRow
            key={line.key}
            line={line}
            nowMs={nowMs}
            live={live}
            directory={directory}
            testID={`${testID}-row-${line.memberId}`}
            stop={
              // 끊긴 레일에서는 중단을 권하지 않는다. 마지막으로 확인된 상태를
              // 보고 있는 것이고, 그 실행은 이미 끝났을 수 있다.
              live && stop !== undefined && renderStop
                ? renderStop({
                    ...stop,
                    memberId: line.memberId,
                    // 화면에 이미 있는 그 이름을 그대로 넘긴다. 영수증이 다른
                    // 경로로 이름을 구하면 같은 줄이 두 이름을 갖게 된다.
                    name: line.name.name,
                  })
                : null
            }
          />
        );
      })}
      {overflowCount > 0 ? (
        <Text style={styles.activityText}>외 {overflowCount}명</Text>
      ) : null}
      {live ? null : (
        <Text
          accessibilityLabel={TURN_STALE_SENTENCE}
          style={styles.staleText}
          testID={`${testID}-stale`}>
          {TURN_STALE_SENTENCE}
        </Text>
      )}
    </View>
  );
}

/**
 * 연결이 끊긴 동안 이 탭이 말하는 한 줄 (2R H2).
 *
 * 에이전트 탭에는 이 고지가 없었다. 배지가 회색으로 내려앉는 것이 유일한 신호였는데
 * **무색이 곧 「열린 턴이 없음」의 모양**이라, 끊긴 화면과 조용한 화면이 픽셀 단위로
 * 같았다. 그것은 웹의 첫 컴포저 시안이 저지른 실수 그대로다 — 상태를 인코딩만 하고
 * 화면에 말하지 않은 것. `AgentActivityBar`가 스스로 세운 규칙("한 줄이 그 자리에서
 * 이유를 말한다")을 이 탭도 지킨다.
 *
 * 열린 턴이 하나도 없을 때도 뜬다. 이 화면이 끊긴 동안 못 말하는 것은 배지만이
 * 아니라 **「지금 일하는 에이전트가 없다」는 문장 자체**이고, 그 침묵이야말로
 * 고지가 필요한 자리다.
 */
export function AgentTurnStaleNotice({
  testID,
}: {
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.staleNotice} testID={testID}>
      <Text style={styles.staleText}>{TURN_STALE_SENTENCE}</Text>
    </View>
  );
}

/** 숫자 한 칸과 같은 폭의 줄바꿈 금지 공백(U+2007 FIGURE SPACE). 소스에 보이지 않는 글자를 두지 않으려고 escape 로 쓴다. */
const FIGURE_SPACE = '\u2007';

// 시간이 흐르며 매초(또는 매분) 바뀌는 낱말의 한 자리 숫자: 「5초째」「3분째」「마지막 보고 7초 전」「1분 전에 가져감」. 앞이 숫자나 숫자 공백이면 이미 두 자리다.
const TICKING_NUMBER = /(^|[^\d\u2007])(\d)(?=(?:초|분)(?:째| 전))/g;
// 시계의 한 자리 초(「5s」). 분 이상(「2m 05s」「1h 04m」)은 코어가 이미 0 을 채워 폭이 일정하다.
const TICKING_CLOCK_SECONDS = /^(\d)(?=s$)/;

/**
 * 근거 글에서 바뀌는 숫자의 **폭을 두 자리로 미리 잡는다** (#4613). 한 자리 숫자 앞에 숫자 폭 공백을 하나 둔다(「5초째」→「 5초째」).
 *
 * 활동 줄은 줄바꿈이 되는 줄이고 근거 글은 그 안에서 줄어드는 글자라서, 숫자가 한 자리에서 두 자리로 넘어가는 순간(9→10초) 글자가 한 자리만큼 길어져 줄 수가
 * 한 줄→두 줄로 뒤집혔다(`tabular-nums` 뒤에도 남은 것: 375pt·글자 ×1.118 에서 「grok … 앞에 2건」). 두 자리 폭을 처음부터 잡아 두면 1초부터 59분까지 낱말의
 * 폭이 같다 — 「59초째」와 「 1분째」도 같아서 1분이 되는 순간에도 줄 수가 안 바뀐다. 두 자리 숫자·시간 낱말(「17시간째」)은 건드리지 않는다.
 *
 * 코어 문구(`runPhaseDetail`)는 웹과 나눠 쓰므로 고치지 않고 **보이는 글에만** 입힌다: 접근성 이름(`activityText`)은 숫자가 없어 그대로다.
 */
export function reserveTickingDigits(text: string): string {
  return text.replace(TICKING_NUMBER, `$1${FIGURE_SPACE}$2`);
}

/** 시계(「5s」)의 한 자리 초에도 같은 규칙. 「9s」→「10s」에서 글자가 길어져 줄이 뒤집히지 않게. */
export function reserveClockDigits(label: string): string {
  return label.replace(TICKING_CLOCK_SECONDS, `${FIGURE_SPACE}$1`);
}

/**
 * The line itself. The clock sits right after the text it belongs to rather than
 * pushed to the far edge: a number a screen away from its label stops reading as
 * a status line and starts reading as a card.
 *
 * The clock is printed only for a `working` turn with an observed start. A turn
 * parked on an approval has stopped, so an elapsed number beside it would be
 * measuring how long the READER has taken — and a turn the rail attached to
 * mid-flight has no honest start to count from (`startedAtMs` is absent by
 * design, never guessed).
 */
function ActivityRow({
  line,
  nowMs,
  live,
  directory,
  stop,
  testID,
}: {
  line: AgentActivityLine;
  nowMs: number;
  live: boolean;
  /** 「답하는 중」 줄에 서는 에이전트의 작은 얼굴을 위한 명부. */
  directory: Directory;
  /** 이 줄의 실행을 멈추는 컨트롤, 또는 null. 화면이 만들어 준다. */
  stop?: React.ReactNode;
  /** 이 행이 확정 패널을 감쌀 수 있는 모양인지 테스트가 확인할 수 있게 (2R H1). */
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // 서버가 아는 run은 근거 줄이 「12분째 · 마지막 보고 1분 전」을 이미 말한다(#3824).
  // 같은 시간을 두 번, 두 말(「12m 03s」)로 하지 않는다.
  const showClock =
    live &&
    line.server === undefined &&
    line.state === 'working' &&
    line.startedAtMs !== undefined;
  const rawDetail = activityDetail(line, nowMs);
  const detail = rawDetail === undefined ? undefined : reserveTickingDigits(rawDetail);
  // 큰 글씨(`STACK_PILL_SCALE`부터)에서는 「이름: 상태 낱말」이 한 줄에 다 들어가지 않는다. 한 줄로 자르면 새 낱말
  // 「아직 받지 않았어요」가 「아직 받지…」로 잘려 핵심이 사라진다(design-review #4285 r1 H1과 같은 폭의 문제) —
  // 큰 글씨에서는 줄을 바꿔 다 말한다.
  const {fontScale} = useWindowDimensions();
  const wrapLead = fontScale >= STACK_PILL_SCALE;
  // 에이전트가 요청을 가져가 답을 쓰는 중이면 얼굴과 점이 붙는다(#4020). 끊긴 레일에서는
  // 둘 다 뺀다: 아무도 일하는 중이 아닌 줄에 움직임을 두지 않는다.
  const responding = live && isRespondingLine(line);
  return (
    <View style={styles.activityRow} testID={testID}>
      {responding ? (
        <View style={styles.activityFace} testID="responding-avatar">
          <Avatar directory={directory} memberId={line.memberId} size={RESPONDING_FACE} />
        </View>
      ) : null}
      <Text
        accessibilityLabel={activityText(line, nowMs)}
        numberOfLines={wrapLead ? undefined : 1}
        ellipsizeMode="tail"
        style={[styles.activityText, styles.activityTextFlex]}
        testID="activity-lead">
        {/* Offline the name drops to the row's own muted ink: agent identity is
            a claim about who is acting right now, and nobody is acting right
            now. */}
        <Text style={live ? styles.activityName : undefined}>
          {line.name.name}
        </Text>
        {line.name.handle ? (
          <Text style={styles.activityText}>({line.name.handle})</Text>
        ) : null}
        {activitySuffix(line, nowMs)}
      </Text>
      {responding ? <RespondingDots /> : null}
      {detail !== undefined ? (
        // 서버가 아는 run의 근거 한 줄(n분째 기다려요 · 앞에 m건 / 가져간 뒤 n분째 소식이
        // 없어요 / 마지막 보고 n분 전). 사실만 적고 판정은 하지 않는다 — 「끊김」은 서버가
        // 알릴 때만 나온다.
        // 근거 글은 세 토막(생존 문구 · 경과 · 이유)까지 길어진다(#4285): 어절에서 끊는다(`Sentence`) — 좁은
        // 폭에서 글자 단위로 꺾여 한 음절이 홀로 남지 않게(design-review r1 M7).
        <Sentence style={styles.activityDetail} testID="activity-detail">
          {detail}
        </Sentence>
      ) : null}
      {showClock ? (
        <Text style={styles.activityClock}>
          {reserveClockDigits(elapsedLabel(line.startedAtMs as number, nowMs))}
        </Text>
      ) : null}
      {stop ?? null}
    </View>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    // Offline is the DEFAULT here on purpose: an unproved claim gets the quiet
    // treatment, and only a live rail earns a colour.
    borderColor: color.border,
  },
  badgeWorking: {borderColor: color.agent},
  badgeWaiting: {borderColor: color.warn},
  badgeText: {fontSize: font.meta, color: color.textMuted, fontWeight: '600'},
  badgeWorkingText: {color: color.agent},
  badgeWaitingText: {color: color.warn},

  activityBar: {
    paddingHorizontal: space.lg,
    // 마지막 행과의 거리는 8 이다 — 목록 꼬리가 8 을 주던 때의 값 그대로. 대화 화면이 꼬리를 줄인 만큼
    // (`CONV.conversationTail`) 이 줄이 진다(#4264). **이 값은 대화 화면의 도크 전용이다**: 꼬리 기본(8)을 쓰는 표면에
    // 세우면 8 + 8 = 16 이 된다(이 줄은 `ConversationScreen` 과 그것을 본뜬 계측 표면에만 선다).
    paddingTop: space.sm - CONV.conversationTail,
    paddingBottom: space.xs,
    gap: 2,
  },
  activityRow: {
    flexDirection: 'row',
    // 가운데 맞춤이다 — `baseline` 이면 줄 높이가 **글자에 따라** 1~2pt 달라졌다(「59분째」→「1시간째」에서 활동 줄이 1~2pt 줄고, 그만큼 입력창 위
    // 대화가 움직였다 #4331). 줄 높이는 가장 큰 자식(중단 컨트롤의 손가락 바닥 44)이 정하고, 글자는 그 안에서 가운데에 선다.
    alignItems: 'center',
    gap: space.sm,
    // `flexWrap` is REQUIRED, not tidying (2R H1). The stop control's confirm
    // panel asks for the full width (`flexBasis: '100%'`), and in React Native a
    // row does NOT wrap by default — `nowrap` is the flexbox default and RN does
    // not override it. Without this, arming the control squeezes a full-width
    // child into whatever is left of one line: the consequence sentence collapses
    // toward zero width and the 중단 확정 button is pushed past the edge, which on
    // the one control whose entire job is a deliberate second tap is the worst
    // possible place for it. Every other wrapping row in this app states the same
    // property explicitly (`MessageRow.tsx` reaction bar, and four more).
    flexWrap: 'wrap',
  },
  // 얼굴은 줄(meta 글자) 높이에 맞춘 작은 자리다. 행이 가운데 맞춤이 되기 전(baseline)에 가운데로 빼 둔 것이라 지금은 같은 뜻이다.
  activityFace: {alignSelf: 'center'},
  activityText: {fontSize: font.meta, lineHeight: lineHeightToken.meta, color: color.textMuted},
  activityTextFlex: {flexShrink: 1},
  activityName: {color: color.agent},
  // 숫자 글리프의 폭을 같게 한다(#4613). 가변폭 숫자는 같은 자릿수끼리도 폭이 달라(「1」은 좁고 「4」·「8」은 넓다) 「N초째」·「12m 03s」가 매초 바뀔 때, 줄바꿈 경계에
  // 걸린 줄이 어떤 초에서는 한 줄·어떤 초에서는 두 줄이 됐다. 그때마다 도크가 입력창 위에서 자라고 줄어 대화가 같은 양만큼 오르내렸다(375pt·글자 ×1.118 에서
  // 첫 1분에 11번·26pt, `measure/activityRows.tsx`). 자릿수가 바뀌는 순간(9→10초)의 폭 차이는 `reserveTickingDigits`·`reserveClockDigits` 가 두 자리 폭을 미리 잡아 없앤다.
  activityClock: {fontSize: font.meta, lineHeight: lineHeightToken.meta, color: color.textFaint, fontVariant: ['tabular-nums']},
  // 근거 줄은 사람이 판단하는 근거라 시계(장식)와 위계가 다르다: 본문 AA를 노리는
  // `textMuted`이고, 줄이 모자라면 이름이 아니라 이 줄이 줄어든다(design-review U4).
  activityDetail: {fontSize: font.meta, lineHeight: lineHeightToken.meta, color: color.textMuted, flexShrink: 1, fontVariant: ['tabular-nums']},
  staleText: {fontSize: font.meta, color: color.warn},
  staleNotice: {
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.sm,
  },
});
