import React from 'react';

import {SettingsPage} from '../features/profile/SettingsPage';
import {useDirectory} from '../features/workspace/queries';
import {useRealtime} from '../realtime/RealtimeProvider';
import {useSession} from '../session/useSession';

// =============================================================================
// 「설정」 층 — 셸 위에 쌓이는 전체 화면 (#4457).
//
// 홈 머리의 내 얼굴이 연다(`nav.settings`). 이 파일은 층과 화면 사이의 이음매일 뿐이다: 세션·명부·실시간
// 연결을 읽어 `SettingsPage` 에 건네고, 닫기(머리의 원형 X, 왼쪽 가장자리 밀기)를 셸의 `back` 으로 잇는다.
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
  return (
    <SettingsPage
      workspaceId={workspaceId}
      member={member}
      directory={directoryQuery.directory}
      connected={realtime.status === 'connected'}
      onSignOut={signOut}
      onClose={onBack}
    />
  );
}
