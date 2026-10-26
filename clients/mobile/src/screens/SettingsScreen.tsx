import React from 'react';

import {SettingsPage} from '../features/profile/SettingsPage';
import {useDirectory} from '../features/workspace/queries';
import {useLayerClose} from '../nav/EdgeSwipeBack';
import {useRealtime} from '../realtime/RealtimeProvider';
import {useSession} from '../session/useSession';

// =============================================================================
// 「설정」 층 — 셸 위에 쌓이는 전체 화면 (#4457).
//
// 홈 머리의 내 얼굴이 연다(`nav.settings`). 이 파일은 층과 화면 사이의 이음매일 뿐이다: 세션·명부·실시간
// 연결을 읽어 `SettingsPage` 에 건네고, 닫기(머리의 원형 X·VoiceOver escape·왼쪽 가장자리 밀기)를 셸의 `back` 으로 잇는다.
// X 와 escape 는 층의 퇴장 모션(올라온 길의 반대로 내려간다)을 지난 뒤 `back` 이 불린다 — `useLayerClose`.
// 무엇이 어디에 서는지·왜 층인지는 `features/profile/SettingsPage.tsx` 머리 주석이 말한다.
// =============================================================================

export default function SettingsScreen({
  onBack,
}: {
  onBack: () => void;
}): React.JSX.Element {
  const {member, workspaceId, signOut} = useSession();
  const realtime = useRealtime();
  const directoryQuery = useDirectory(workspaceId);
  // 층 안에서는 움직임과 함께 걷히고, 층 밖(하네스·시험)에서는 `null` 이라 곧바로 `onBack` 이다.
  const closeLayer = useLayerClose();
  return (
    <SettingsPage
      workspaceId={workspaceId}
      member={member}
      directory={directoryQuery.directory}
      connected={realtime.status === 'connected'}
      onSignOut={signOut}
      onClose={closeLayer ?? onBack}
    />
  );
}
