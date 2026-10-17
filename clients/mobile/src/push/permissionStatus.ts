import {getPermissionsAsync} from 'expo-notifications';
import {useCallback, useEffect, useRef, useState} from 'react';
import {AppState} from 'react-native';

import type {PushPermission} from './notifications';

// =============================================================================
// 알림 권한을 **읽기만** 한다 — 프로필 시트의 「푸시 알림」 스위치 (#2702, #3924).
//
// 시트를 열어 본 것이 권한 요청이 되면 안 된다. 요청은 사람이 누른 버튼에서만
// 한다: M3 알림 미리 안내의 [계속], 그리고 이 시트의 「푸시 알림」 스위치(아직 안
// 물었을 때). 둘 다 `PushProvider` 의 `usePushPrompt().ask` 를 부른다(#2820,
// ADR-0193 D8). 여기서는 지금 서 있는 답만 읽는다.
//
// 앱이 다시 앞으로 올 때마다 다시 읽는다. 「설정 열기」로 나가 권한을 켜고 돌아온
// 사람에게 시트가 여전히 꺼져 있다고 말하면, 그 줄은 방금 한 일을 부정한다. 허용 창을
// 닫은 직후에도 같다 — 창이 AppState 를 흔드는지는 iOS 판마다 다르므로, 묻는 쪽이 창이
// 닫힌 때 `recheck` 로 직접 다시 읽는다.
// =============================================================================

export type PushPermissionView = PushPermission | 'checking';

type PermissionReader = () => Promise<{granted: boolean; canAskAgain: boolean}>;

const nativePermissionReader: PermissionReader = () => getPermissionsAsync();

let permissionReader: PermissionReader = nativePermissionReader;

/**
 * 시험·측정 하네스가 iOS 의 답을 정해 두는 자리(`null` 이면 진짜 iOS 에 묻는다).
 * 시뮬레이터에는 알림 권한을 허용·거부로 **고정**하는 길이 없다(`simctl privacy` 에
 * notifications 가 없다) — 한 표면의 세 상태를 찍으려면 읽는 자리를 바꿔야 한다.
 */
export function __setPermissionReader(next: PermissionReader | null): void {
  permissionReader = next ?? nativePermissionReader;
}

async function readPermission(): Promise<PushPermission> {
  const current = await permissionReader();
  if (current.granted) return 'granted';
  return current.canAskAgain ? 'undetermined' : 'denied';
}

export interface PushPermissionState {
  permission: PushPermissionView;
  /** 지금 다시 읽는다. 허용 창이 닫힌 직후처럼 AppState 가 알려 주지 않는 때에 쓴다. */
  recheck: () => void;
}

export function usePushPermissionState(): PushPermissionState {
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

  // 지금 서 있는 읽기. 새 읽기가 시작되면 앞의 것은 접는다 — 늦게 온 옛 답이 새 답을
  // 덮지 않게.
  const cancelRead = useRef<() => void>(() => {});

  useEffect(() => {
    cancelRead.current = refresh();
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active') return;
      cancelRead.current();
      cancelRead.current = refresh();
    });
    return () => {
      cancelRead.current();
      subscription.remove();
    };
  }, [refresh]);

  const recheck = useCallback(() => {
    cancelRead.current();
    cancelRead.current = refresh();
  }, [refresh]);

  return {permission: state, recheck};
}

export function usePushPermission(): PushPermissionView {
  return usePushPermissionState().permission;
}
