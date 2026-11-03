import {
  type AgentTurnState,
} from '@momo/core/features/agents/workingSignal';
import {TURN_STALE_SENTENCE} from '@momo/core/features/agents/turnCopy';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {font, radius, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

// =============================================================================
// The 「작업 중」 badge and the stale notice on the phone (goal RN-T2). (대화 화면의 입력창 레일은 `ActivityRail.tsx`다 — #4620.)
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

  staleText: {fontSize: font.meta, color: color.warn},
  staleNotice: {
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.sm,
  },
});
