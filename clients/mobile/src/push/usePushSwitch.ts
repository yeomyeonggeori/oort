import {useCallback, useEffect, useRef, useState} from 'react';
import {Linking} from 'react-native';

import {revokeOwnDevice} from './devices';
import {
  usePushPermissionState,
  type PushPermissionView,
} from './permissionStatus';
import {setPushOptedOut, usePushOptedOut} from './pushOptOut';
import {usePushPrompt} from './PushProvider';
import {registeredPushDeviceId} from './registration';

// =============================================================================
// 프로필 시트의 「푸시 알림」 — 이 폰의 스위치 (#3924, ADR-0204 D1).
//
// 성재(2026-10-16): 「푸시알림이 토글형태로 되어야 하고」. 이 줄은 OS 권한을 설명하는
// 글이었다. 이제 스위치이고, 그 뜻은 하나다:
//
//   켬   OS 가 허용했고 + 사람이 이 폰을 끄지 않았다. 등록은 `PushProvider` 가 한다.
//   끔   OS 가 막았거나(`denied`·`undetermined`), 사람이 껐다.
//
// 「사람이 껐다」는 서버에도 남는다(이 기기의 토큰이 무효가 된다). 그러나 서버의 상태로는
// 스위치를 그리지 않는다: 이 스위치의 거짓말이 가장 비싼 것은 「껐는데 앱을 다시 켜자 스스로
// 켜져 있다」이고, 그 고리를 끊는 것은 서버 값이 아니라 이 폰의 기억(`pushOptOut.ts`)이다.
//
// 끄면 데스크탑 알림과 다른 기기에는 영향이 없다 — 지우는 것은 이 `deviceId` 의 토큰
// 하나다.
//
// ## 끌 때의 순서
//
// 1. **기억을 먼저 적는다.** 스위치가 곧바로 꺼지고, 아직 날아가는 등록이 있어도 그 등록이
//    끝났을 때 `PushProvider` 가 이 기억을 보고 되돌린다.
// 2. 서버에서 이 기기를 지운다. 끝나지 못하면 **기억을 되돌리고** 말한다 — 스위치가 꺼졌다고
//    말하는데 서버가 계속 보내는 것이 이 줄이 낼 수 있는 가장 나쁜 답이다.
//
// 서버에 등록된 적이 없는 폰(`deviceId` 없음)은 지울 것이 없다. 이 호출이 id 를 새로 만들어
// 서버에 죽은 행을 남기지 않는다(`registeredPushDeviceId`).
//
// ## 켤 때
//
//   허용됨        기억을 지운다. `PushProvider` 의 등록 효과가 이 변화를 보고 등록한다.
//   묻지 않음     기억을 지우고 iOS 허용 창을 띄운다(`ask`). 창이 닫히면 권한을 다시 읽는다.
//   거부됨        기억을 지우고 iOS 설정을 연다. iOS 는 거부한 앱에 창을 다시 띄우지 않는다.
//                 기억을 먼저 지우는 까닭: 설정에서 켜고 돌아온 사람이 한 번 더 눌러야 한다면
//                 첫 탭의 뜻이 사라진 것이다.
// =============================================================================

export const PUSH_SWITCH_LABEL = '푸시 알림';

export const PUSH_SWITCH_OFF_FAILED =
  '이 폰의 알림을 끄지 못했어요. 연결을 확인하고 다시 눌러 주세요.';

export interface PushSwitch {
  permission: PushPermissionView;
  /** 스위치 값: OS 허용 **그리고** 사람이 끄지 않음. */
  on: boolean;
  /** 서버에서 지우는 중이거나 iOS 허용 창이 열려 있다. */
  busy: boolean;
  /** 마지막 「끄기」가 서버에 닿지 못해 되돌려졌다. */
  failed: boolean;
  /** 지금 값의 반대로. 읽는 중이거나 바쁜 동안은 아무 일도 하지 않는다. */
  toggle: () => void;
}

/** 줄의 설명 문장. 상태 이름만이 아니라 사람이 할 수 있는 일까지 말한다. */
export function pushSwitchDetail(
  state: Pick<PushSwitch, 'permission' | 'on'>,
): string {
  switch (state.permission) {
    case 'checking':
      return '확인하는 중이에요.';
    case 'denied':
      return 'iOS 설정에서 알림이 꺼져 있어요. 스위치를 누르면 설정이 열려요.';
    case 'undetermined':
      return '아직 허용 여부를 정하지 않았어요. 켜면 iOS 허용 창이 떠요.';
    case 'granted':
      return state.on
        ? '이 폰으로 알림을 받아요.'
        : '이 폰으로는 보내지 않아요. 데스크탑 알림은 그대로예요.';
  }
}

export function usePushSwitch(
  workspaceId: string,
  memberId: string,
): PushSwitch {
  const {permission, recheck} = usePushPermissionState();
  const optedOut = usePushOptedOut(memberId);
  const prompt = usePushPrompt();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // 시트가 닫힌 뒤에 끝나는 요청이 닫힌 화면의 상태를 건드리지 않게. 기억은 모듈
  // 저장소라 화면이 없어도 되돌려진다.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const on = permission === 'granted' && !optedOut;

  const turnOff = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    setPushOptedOut(memberId, true);
    try {
      const deviceId = registeredPushDeviceId();
      if (deviceId === null) return;
      const outcome = await revokeOwnDevice(workspaceId, deviceId);
      if (outcome.kind === 'revoked' || outcome.kind === 'gone') return;
      console.warn(
        `[push] switch off: server did not revoke (${outcome.kind}${
          outcome.kind === 'rejected' ? ` ${outcome.status}` : ''
        })`,
      );
      setPushOptedOut(memberId, false);
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [workspaceId, memberId]);

  const turnOn = useCallback(async () => {
    setFailed(false);
    setPushOptedOut(memberId, false);
    if (permission === 'granted') return;
    if (permission === 'denied') {
      await Linking.openSettings().catch(() => {});
      return;
    }
    setBusy(true);
    try {
      await prompt.ask();
      recheck();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [memberId, permission, prompt, recheck]);

  const toggle = useCallback(() => {
    if (busy || permission === 'checking') return;
    void (on ? turnOff() : turnOn());
  }, [busy, permission, on, turnOff, turnOn]);

  return {permission, on, busy, failed, toggle};
}
