import React from 'react';

import {GroupCard, ListRow} from '../../design/sheetParts';
import {
  ActionRow,
  SettingsNote,
  SettingsSection,
  SwitchRow,
} from '../profile/settingsRows';
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
// 설정 페이지의 「기억」 묶음 (ADR-0196 D9 / #3166) — 내 일시정지 하나.
//
// 팀 전체 스위치와 채널별 제외는 관리자 일이라 폰에 두지 않는다(ADR-0137 D5: 설정은
// 데스크탑). 없는 스위치를 그려 두지 않고, 어디서 바꾸는지만 한 줄로 말한다.
// 스위치는 서버 값을 한 번 읽은 뒤에야 서며, 모르는 동안 「꺼짐」을 그리지 않는다.
//
// #4457: 옛 `GroupSection`·`GroupRow`(반경 8·테두리 카드)에서 새 묶음 카드 가족(`GroupCard`·
// `ListRow`·`SwitchRow`)으로 제자리 교체했다. 로직(`useMyMemoryPause`)과 testID 는 그대로다.
// =============================================================================

export function MemoryPauseSection({
  workspaceId,
}: {
  workspaceId: string;
}): React.JSX.Element {
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
    <SettingsSection>
      <GroupCard label={MEMORY_SECTION} testID="memory-section">
        <SwitchRow
          title={MEMORY_PAUSE_LABEL}
          detail={detail}
          checked={pause.paused}
          a11yDisabled={locked}
          onPress={() => pause.setPaused(!pause.paused)}
          accessibilityHint={detail}
          control={
            pause.ready
              ? {
                  kind: 'switch',
                  value: pause.paused,
                  onValueChange: next => pause.setPaused(next),
                  disabled: locked,
                  testID: 'memory-pause-switch',
                }
              : pause.loadFailed
                ? {kind: 'none'}
                : {kind: 'loading', testID: 'memory-pause-loading'}
          }
          testID="memory-pause-row"
        />
        {pause.loadFailed ? (
          // 복구 길은 강조색 글자다(옛 판의 `tone="accent"`) — 눌리지 않는 안내 행과 갈린다.
          <ActionRow
            title={MEMORY_PAUSE_RETRY}
            tone="accent"
            onPress={pause.retryLoad}
            testID="memory-pause-retry"
          />
        ) : null}
        <ListRow
          title={MEMORY_ADMIN_ROW}
          detail={MEMORY_ADMIN_DETAIL}
          testID="memory-admin-row"
        />
      </GroupCard>
      {pause.ready && !pause.workspaceEnabled ? (
        <SettingsNote testID="memory-workspace-off">
          {MEMORY_PAUSE_WORKSPACE_OFF}
        </SettingsNote>
      ) : null}
      {pause.failed ? (
        <SettingsNote tone="danger" testID="memory-pause-failure">
          {MEMORY_PAUSE_SAVE_FAILED}
        </SettingsNote>
      ) : null}
    </SettingsSection>
  );
}
