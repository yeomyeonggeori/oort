import {useEffect} from 'react';

import {useChannels, useDirectory} from '../features/workspace/queries';
import {useSession} from '../session/useSession';
import {
  exportChannelsForPush,
  presentationChannels,
  syncPresentationSettings,
  usePushShowSender,
} from './presentation';

// =============================================================================
// 알림 확장에게 앱이 아는 것을 건네는 자리 (#4316, ADR-0204 증보 5).
//
// 로그인한 셸 안에서 한 번 선다(`AppShell`). 하는 일은 둘이고 화면은 없다:
//
//   1. 뜰 때 「메시지 미리보기」「보낸 사람 표시」를 확장이 읽는 자리에 한 번 쓴다. 확장은 MMKV 를 읽지
//      못하고, 앱을 지웠다 깐 폰이나 그룹이 비워진 폰도 이 한 번으로 저장된 선택을 되찾는다.
//   2. 채널 목록이 바뀌면 이름·종류·멤버 수를 건넨다. 푸시는 채널 id 만 싣고 확장의 자격은 채널 목록을
//      읽지 못하므로 `#디자인` 같은 이름은 여기서만 나온다. 같은 목록은 다시 쓰지 않는다.
//
// 얼굴(사진)은 여기서 건네지 않는다: 앱이 **그린** 얼굴만 건넨다(`useMemberAvatarUri`).
// 두 목록은 셸이 이미 읽는 질의라(`useChannels`·`useDirectory`) 이 자리가 요청을 더하지 않는다.
// =============================================================================
export default function PushPresentationSync(): null {
  const {workspaceId} = useSession();
  const showSender = usePushShowSender();
  const channels = useChannels(workspaceId).data;
  const members = useDirectory(workspaceId).data;

  useEffect(() => {
    syncPresentationSettings();
  }, []);

  useEffect(() => {
    if (!showSender || channels === undefined) return;
    exportChannelsForPush(workspaceId, presentationChannels(channels, members ?? []));
  }, [showSender, workspaceId, channels, members]);

  return null;
}
