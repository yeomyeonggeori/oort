import React from 'react';
import {ActivityIndicator, StyleSheet, Switch} from 'react-native';
import {GroupRow, GroupSection, Sentence} from '../../design/atoms';
import {font, line, space, type Palette} from '../../design/tokens';
import {usePalette, useStyles} from '../../design/theme';
import {
  MEMORY_ADMIN_DETAIL,
  MEMORY_ADMIN_ROW,
  MEMORY_PAUSE_CHECKING,
  MEMORY_PAUSE_DETAIL_OFF,
  MEMORY_PAUSE_DETAIL_ON,
  MEMORY_PAUSE_LABEL,
  MEMORY_PAUSE_LOAD_FAILED,
  MEMORY_PAUSE_RETRY,
  MEMORY_PAUSE_SAVE_FAILED,
  MEMORY_PAUSE_WORKSPACE_OFF,
  MEMORY_SECTION,
} from './copy';
import {useMyMemoryPause} from './queries';

// =============================================================================
// 프로필 시트의 「기억」 묶음 (ADR-0196 D9 / #3166) — 내 일시정지 하나.
//
// 팀 전체 스위치와 채널별 제외는 관리자 일이라 폰에 두지 않는다(ADR-0137 D5: 설정은
// 데스크탑). 없는 스위치를 그려 두지 않고, 어디서 바꾸는지만 한 줄로 말한다.
// 스위치는 서버 값을 한 번 읽은 뒤에야 서며, 모르는 동안 「꺼짐」을 그리지 않는다.
// =============================================================================

export function MemoryPauseSection({
  workspaceId,
}: {
  workspaceId: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const pause = useMyMemoryPause(workspaceId);
  const locked = !pause.ready || pause.pending;
  const detail = pause.loadFailed
    ? MEMORY_PAUSE_LOAD_FAILED
    : !pause.ready
      ? MEMORY_PAUSE_CHECKING
      : pause.paused
        ? MEMORY_PAUSE_DETAIL_ON
        : MEMORY_PAUSE_DETAIL_OFF;
  return (
    <GroupSection label={MEMORY_SECTION} testID="memory-section">
      <GroupRow
        title={MEMORY_PAUSE_LABEL}
        detail={detail}
        onPress={() => pause.setPaused(!pause.paused)}
        accessibilityRole="switch"
        accessibilityState={{checked: pause.paused, disabled: locked}}
        accessibilityLabel={MEMORY_PAUSE_LABEL}
        accessibilityHint={detail}
        trailing={
          pause.ready ? (
            <Switch
              value={pause.paused}
              onValueChange={next => pause.setPaused(next)}
              disabled={locked}
              trackColor={{false: palette.border, true: palette.ok}}
              ios_backgroundColor={palette.border}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              testID="memory-pause-switch"
            />
          ) : pause.loadFailed ? null : (
            <ActivityIndicator
              color={palette.textMuted}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              testID="memory-pause-loading"
            />
          )
        }
        testID="memory-pause-row"
      />
      {pause.ready && !pause.workspaceEnabled ? (
        <Sentence style={styles.note} testID="memory-workspace-off">
          {MEMORY_PAUSE_WORKSPACE_OFF}
        </Sentence>
      ) : null}
      {pause.loadFailed ? (
        <GroupRow
          title={MEMORY_PAUSE_RETRY}
          tone="accent"
          separated
          onPress={pause.retryLoad}
          testID="memory-pause-retry"
        />
      ) : null}
      {pause.failed ? (
        <Sentence
          style={styles.failure}
          accessibilityLiveRegion="polite"
          testID="memory-pause-failure">
          {MEMORY_PAUSE_SAVE_FAILED}
        </Sentence>
      ) : null}
      <GroupRow
        title={MEMORY_ADMIN_ROW}
        detail={MEMORY_ADMIN_DETAIL}
        separated
        testID="memory-admin-row"
      />
    </GroupSection>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    note: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      paddingHorizontal: space.lg,
      paddingBottom: space.md,
    },
    failure: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.dangerText,
      paddingHorizontal: space.lg,
      paddingBottom: space.md,
    },
  });
