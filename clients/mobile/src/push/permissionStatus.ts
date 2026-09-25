import {getPermissionsAsync} from 'expo-notifications';
import {useCallback, useEffect, useState} from 'react';
import {AppState} from 'react-native';

import type {PushPermission} from './notifications';

// =============================================================================
// 알림 권한을 **읽기만** 한다 — 프로필 시트의 「푸시 알림」 줄 (#2702).
//
// `ensurePushPermission()` 을 쓰지 않는다: 그 함수는 아직 안 물었으면 **묻는다.**
// 시트를 열어 본 것이 권한 요청이 되면 안 되고, 요청은 `PushProvider` 가 로그인
// 직후 한 번 한다. 여기서는 지금 서 있는 답만 읽는다.
//
// 앱이 다시 앞으로 올 때마다 다시 읽는다. 「설정 열기」로 나가 권한을 켜고 돌아온
// 사람에게 시트가 여전히 「꺼져 있습니다」라고 말하면, 그 줄은 방금 한 일을
// 부정한다.
// =============================================================================

export type PushPermissionView = PushPermission | 'checking';

async function readPermission(): Promise<PushPermission> {
  const current = await getPermissionsAsync();
  if (current.granted) return 'granted';
  return current.canAskAgain ? 'undetermined' : 'denied';
}

export function usePushPermission(): PushPermissionView {
  const [state, setState] = useState<PushPermissionView>('checking');

  const refresh = useCallback(() => {
    let cancelled = false;
    readPermission()
      .then(next => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        // 못 읽었으면 「묻지 않음」도 「꺼짐」도 아니다. 확인 중으로 둔다 —
        // 틀린 답을 말하는 것보다 모른다고 두는 편이 낫다.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancel = refresh();
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active') return;
      cancel();
      cancel = refresh();
    });
    return () => {
      cancel();
      subscription.remove();
    };
  }, [refresh]);

  return state;
}

/** 줄의 설명 문장. 상태 이름만이 아니라 사람이 할 수 있는 일까지 말한다. */
export function pushPermissionDetail(state: PushPermissionView): string {
  switch (state) {
    case 'granted':
      return '켜져 있습니다. 이 기기로 알림을 받습니다.';
    case 'denied':
      return '꺼져 있습니다. iOS 설정에서 이 앱의 알림을 켜야 받을 수 있습니다.';
    case 'undetermined':
      return '아직 허용 여부를 정하지 않았습니다.';
    case 'checking':
      return '확인 중…';
  }
}
