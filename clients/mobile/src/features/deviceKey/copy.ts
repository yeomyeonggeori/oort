import type {DeviceKeyView} from '../../deviceKey/enrollment';

// =============================================================================
// 「지시 기기」 문장 (#3026 stage 2). 설정·안내라 합니다체다(ADR-0193 D11 — 해요체는
// 코메토의 말과 Face ID 사유 줄의 몫). 맥 쪽 낱말과 맞춘다: 맥 설정 › 기기 ›
// 「지시 서명」, 버튼 「지시 기기로 승인」(`clients/web/.../DeviceKeysBlock.tsx`).
// =============================================================================

export const DEVICE_KEY_TITLE = '지시 기기';

export type DeviceKeyTone = 'ok' | 'warn' | 'danger' | 'muted';

export interface DeviceKeyCopy {
  /** 줄 끝 알약·프로필 줄의 값. 낱말 하나. */
  badge: string;
  tone: DeviceKeyTone;
  headline: string;
  detail: string;
}

export const MAC_WHERE = '맥의 oort에서 설정 › 기기 › 지시 서명을 여세요.';

/**
 * 맥 화면과 같은 낱말을 쓴다(`DeviceKeysBlock`: 「승인 전」, 「지시 권한 끊기」).
 * `busy` 는 등록이 진행 중인가 — 「아직 지시 기기가 아닙니다」가 실패처럼 읽히지 않게.
 */
export function deviceKeyCopy(view: DeviceKeyView, busy = false): DeviceKeyCopy {
  // 승인은 됐지만 Face ID 를 지금 못 쓴다 — 「지시할 수 있습니다」라고 말하면 거짓이다.
  if (
    (view.kind === 'approved' || view.kind === 'pending') &&
    view.biometryOff
  ) {
    return {
      badge: 'Face ID 필요',
      tone: 'warn',
      headline: 'Face ID를 켜야 이 폰으로 지시할 수 있습니다.',
      detail:
        view.kind === 'approved'
          ? '맥의 승인은 그대로 있습니다. iOS 설정에서 Face ID를 켜고 이 앱에 허용한 뒤 다시 확인하세요.'
          : `iOS 설정에서 Face ID를 켜세요. 맥의 승인도 필요합니다. ${MAC_WHERE}`,
    };
  }
  if (view.kind === 'reconnect') {
    // #3103: live and still approved, but its sign-in ended — it signs
    // nothing until it moves. Never 「승인됨」 (that would be a lie).
    if (busy) {
      return {
        badge: '다시 연결 중',
        tone: 'muted',
        headline: '이 폰의 지시 키를 이 로그인에 다시 연결하는 중입니다.',
        detail: 'Face ID로 확인하면 끝납니다.',
      };
    }
    return {
      badge: '다시 연결 필요',
      tone: 'warn',
      headline: '로그인이 바뀌어 이 폰으로 지금은 지시할 수 없습니다.',
      detail: view.biometryOff
        ? '같은 키를 이 로그인으로 옮기면 맥의 승인은 그대로입니다. 옮기려면 iOS 설정에서 Face ID를 켜세요.'
        : '같은 키를 이 로그인으로 옮기면 맥의 승인은 그대로입니다. Face ID로 한 번 확인하면 됩니다.',
    };
  }
  if (view.kind === 'unregistered' && busy) {
    return {
      badge: '등록 중',
      tone: 'muted',
      headline: '이 폰을 지시 기기로 등록하는 중입니다.',
      detail: '',
    };
  }
  switch (view.kind) {
    case 'loading':
      return {
        badge: '확인 중',
        tone: 'muted',
        headline: '지시 기기 상태를 확인하는 중입니다.',
        detail: '',
      };
    case 'unsupported':
      return {
        badge: '쓸 수 없음',
        tone: 'muted',
        headline: '이 기기에서는 지시 서명 키를 만들 수 없습니다.',
        detail:
          'Secure Enclave가 있는 iPhone에서만 에이전트에게 지시할 수 있습니다. 대화와 알림은 그대로 씁니다.',
      };
    case 'misconfigured':
      return {
        badge: '쓸 수 없음',
        tone: 'muted',
        headline: '이 빌드에는 서명 키를 보관할 권한이 없습니다.',
        detail: '팀 배포 앱에서 다시 연결하세요. 대화와 알림은 그대로 씁니다.',
      };
    case 'biometryOff':
      return {
        badge: 'Face ID 필요',
        tone: 'warn',
        headline: 'Face ID를 켜야 지시 기기로 쓸 수 있습니다.',
        detail:
          '지시마다 Face ID로 확인합니다. iOS 설정에서 Face ID를 등록하고 이 앱에 허용한 뒤 다시 확인하세요.',
      };
    case 'invalidated':
      return {
        badge: '무효',
        tone: 'danger',
        headline: 'Face ID 등록이 바뀌어 이 폰의 서명 키를 더 쓸 수 없습니다.',
        detail:
          '새 키를 만들어 등록하세요. 새 키는 맥에서 다시 승인해야 지시할 수 있습니다.',
      };
    case 'unregistered':
      return {
        badge: '등록 안 됨',
        tone: 'muted',
        headline: '이 폰은 아직 지시 기기가 아닙니다.',
        detail: '등록한 뒤 맥에서 승인하면 이 폰으로 에이전트에게 지시할 수 있습니다.',
      };
    case 'pending':
      return {
        badge: '승인 전',
        tone: 'warn',
        headline: '맥의 승인을 기다리고 있습니다.',
        detail: `${MAC_WHERE} 아래 지문이 맥에 보이는 것과 같을 때만 「지시 기기로 승인」을 누르세요.`,
      };
    case 'approved':
      return {
        badge: '승인됨',
        tone: 'ok',
        headline: '이 폰으로 에이전트에게 지시할 수 있습니다.',
        detail: '지시를 보낼 때마다 Face ID로 확인합니다.',
      };
    case 'revoked':
      return {
        badge: '끊김',
        tone: 'danger',
        headline: '이 폰의 지시 권한이 끊겼습니다.',
        detail:
          '맥에서 끊었거나 이 로그인이 끝났습니다. 다시 등록하면 맥에서 다시 승인해야 합니다.',
      };
    case 'serverError':
      return {
        badge: '알 수 없음',
        tone: 'muted',
        headline: '지시 기기 상태를 불러오지 못했습니다.',
        detail: '연결을 확인하고 다시 시도하세요.',
      };
    case 'localError':
      return {
        badge: '알 수 없음',
        tone: 'muted',
        headline: '이 폰의 서명 키 상태를 읽지 못했습니다.',
        detail: '잠시 뒤 다시 시도하세요.',
      };
  }
}

/** 끊긴 키인데 Face ID 도 지금 못 쓸 때 덧붙이는 한 줄(키는 그대로다). */
export const BIOMETRY_OFF_NOTE =
  'Face ID도 지금 쓸 수 없습니다. 다시 등록한 뒤 지시하려면 iOS 설정에서 Face ID를 켜세요.';

export const FINGERPRINT_LABEL = '지문';
export const FINGERPRINT_HINT = '맥에 보이는 지문과 한 글자씩 같아야 합니다.';

export const ACTION = {
  enroll: '지시 기기로 등록',
  reenroll: '다시 등록',
  replace: '새 키로 다시 등록',
  openSettings: 'iOS 설정 열기',
  recheck: '다시 확인',
  retry: '다시 시도',
  busy: '등록 중',
  reconnect: '다시 연결',
  reconnectBusy: '다시 연결 중',
} as const;
