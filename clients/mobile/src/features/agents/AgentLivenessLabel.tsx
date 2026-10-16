import {
  livenessToneFor,
  livenessView,
  mayActOnLiveness,
  type LivenessTone,
} from '@momo/core/features/agents/liveness';
import {memberFor} from '@momo/core/features/workspace/directory';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {font, radius, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {useSession} from '../../session/useSession';
import {useDirectory} from '../workspace/queries';
import {useAgentLiveness} from './useAgentLiveness';

// =============================================================================
// 에이전트의 생존 라벨 — 폰 (ADR-0200 D4, U4 #3750). 낱말과 색 규칙은 웹과 같은 core
// (`livenessView`)가 정한다. 「연결됨/활성」과 다른 사실이다: 라벨은 서버가 수령·읽기·run
// 이벤트·ping으로 **지금** 파생한 것이고, 서버가 모르는 에이전트(hosted가 아님)에는
// 아무것도 그리지 않는다. 점은 색만으로 말하지 않는다 — 낱말이 항상 곁에 있다.
//
// 폰에는 「다시 깨우기」가 없다: 도어벨 등록과 같은 관리 동작은 데스크톱에 있다
// (`HOSTED_READONLY_NOTE`). 그래서 경고색은 경고하는 사람(owner/admin)에게만 켠다 — 같은
// 사실이 일반 멤버에게는 중립이다(할 수 있는 일이 없는 경고는 소음이다).
// =============================================================================

export function AgentLivenessLabel({
  agentId,
  testID,
}: {
  agentId: string | null;
  testID?: string;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const {liveness, nowMs} = useAgentLiveness(agentId);
  const {workspaceId, member} = useSession();
  const directory = useDirectory(workspaceId).directory;
  if (liveness === null || liveness === undefined) {
    return null;
  }
  const view = livenessView(liveness, nowMs);
  // 경고색은 할 수 있는 일이 있는 사람(owner/admin)에게만 경고다. 규칙은 core 한 곳이다 (#3964).
  const mayAct = mayActOnLiveness(memberFor(directory, member.id)?.role);
  const tone: LivenessTone = livenessToneFor(view, mayAct);
  return (
    <View
      accessible
      accessibilityLabel={`${view.text}. ${view.meaning}`}
      style={styles.row}
      testID={testID ?? 'agent-liveness'}>
      <View
        style={[
          styles.dot,
          tone === 'ok' && styles.dotOk,
          tone === 'warn' && styles.dotWarn,
        ]}
        testID="agent-liveness-dot"
      />
      <Text
        // 라벨은 낱말이 곧 사실이라 말줄임하면 뜻이 사라진다: 두 줄까지 연다.
        numberOfLines={2}
        style={[styles.text, tone === 'warn' && styles.textWarn]}
        testID="agent-liveness-text">
        {view.text}
      </Text>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
    dot: {
      width: 8,
      height: 8,
      borderRadius: radius.pill,
      backgroundColor: color.textFaint,
    },
    dotOk: {backgroundColor: color.ok},
    dotWarn: {backgroundColor: color.warn},
    text: {fontSize: font.meta, color: color.textMuted, flexShrink: 1},
    textWarn: {color: color.warn},
  });
