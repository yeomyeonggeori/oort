import {
  elapsedLabel,
  type AgentTurnState,
  type AgentWorkingSignal,
} from '@momo/core/features/agents/workingSignal';
import {
  activityLines,
  activitySuffix,
  activityText,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
  type AgentActivityLine,
} from '@momo/core/features/agents/turnCopy';
import {memberNameParts} from '@momo/core/features/workspace/directory';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useMemo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {color, font, radius, SAFE_GUTTER, space} from '../../design/tokens';

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
  testID = 'composer-working',
}: {
  turns: readonly AgentWorkingSignal[];
  directory: Directory;
  nowMs: number;
  /** The realtime rail is connected, so a clock is measuring something. */
  live: boolean;
  /**
   * 이 턴을 멈추는 컨트롤 (goal RN-C1). 줄마다 하나이고, 이 컴포넌트는 그것을
   * **만들지 않고 자리만 내준다** — cancel은 워크스페이스와 react-query를 아는
   * 화면의 일이고, 이 파일은 문구와 배치만 안다. `runId`를 모르는 턴(레일이
   * 진행 중에 붙은 경우)에는 호출되지 않는다: 이름을 모르는 것을 멈출 수는 없다.
   */
  renderStop?: (turn: {runId: string; memberId: string}) => React.ReactNode;
  testID?: string;
}): React.JSX.Element | null {
  const {lines, overflowCount} = useMemo(
    () =>
      activityLines(turns, memberId =>
        memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME),
      ),
    [turns, directory],
  );
  /** 줄에서 다시 찾을 수 있게, memberId → runId. 병합 뒤에도 1:1이다. */
  const runIds = useMemo(() => {
    const out = new Map<string, string>();
    for (const turn of turns) {
      if (turn.runId !== undefined) out.set(turn.memberId, turn.runId);
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
        const runId = runIds.get(line.memberId);
        return (
          <ActivityRow
            key={line.key}
            line={line}
            nowMs={nowMs}
            live={live}
            stop={
              // 끊긴 레일에서는 중단을 권하지 않는다. 마지막으로 확인된 상태를
              // 보고 있는 것이고, 그 실행은 이미 끝났을 수 있다.
              live && runId !== undefined && renderStop
                ? renderStop({runId, memberId: line.memberId})
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
  return (
    <View style={styles.staleNotice} testID={testID}>
      <Text style={styles.staleText}>{TURN_STALE_SENTENCE}</Text>
    </View>
  );
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
  stop,
}: {
  line: AgentActivityLine;
  nowMs: number;
  live: boolean;
  /** 이 줄의 실행을 멈추는 컨트롤, 또는 null. 화면이 만들어 준다. */
  stop?: React.ReactNode;
}): React.JSX.Element {
  const showClock =
    live && line.state === 'working' && line.startedAtMs !== undefined;
  return (
    <View style={styles.activityRow}>
      <Text
        accessibilityLabel={activityText(line)}
        numberOfLines={1}
        ellipsizeMode="tail"
        style={[styles.activityText, styles.activityTextFlex]}>
        {/* Offline the name drops to the row's own muted ink: agent identity is
            a claim about who is acting right now, and nobody is acting right
            now. */}
        <Text style={live ? styles.activityName : undefined}>
          {line.name.name}
        </Text>
        {line.name.handle ? (
          <Text style={styles.activityText}>({line.name.handle})</Text>
        ) : null}
        {activitySuffix(line)}
      </Text>
      {showClock ? (
        <Text style={styles.activityClock}>
          {elapsedLabel(line.startedAtMs as number, nowMs)}
        </Text>
      ) : null}
      {stop ?? null}
    </View>
  );
}

const styles = StyleSheet.create({
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
    paddingBottom: space.xs,
    gap: 2,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  activityText: {fontSize: font.meta, color: color.textMuted},
  activityTextFlex: {flexShrink: 1},
  activityName: {color: color.agent},
  activityClock: {fontSize: font.meta, color: color.textFaint},
  staleText: {fontSize: font.meta, color: color.warn},
  staleNotice: {
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.sm,
  },
});
