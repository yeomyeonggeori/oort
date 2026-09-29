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
  /** 번호 붙은 방법 — 지금은 「QR 연결 필요」만 쓴다(#3129). */
  steps?: readonly string[];
  /**
   * 보안 경고 한 문장(#3154 M3). 절차 속에 묻히면 안 되는 「하지 말 것」이라 판이
   * 따로 세운다(강조 블록). 없는 상태가 대부분이다.
   */
  warning?: string;
  /** 지문 줄의 이름. 없으면 「지문」. 이전 키의 지문을 보일 때 다르게 부른다. */
  fingerprintLabel?: string;
}

/**
 * 맥에서 QR로 연결하는 방법(#3129, ADR-0146 D-6 증보 「QR 연결로만」). 맥 쪽
 * 낱말과 맞춘다: 설정 › 기기 › 「폰 연결」 카드의 「QR 만들기」
 * (`clients/web/.../DeviceLinkCard.tsx`), 폰 첫 화면의 「QR 찍기」
 * (`WELCOME_QR_LABEL`). QR은 로그인 전 화면에서만 찍으므로 로그아웃이 가운데 선다.
 */
export const QR_LINK_STEPS: readonly string[] = [
  '맥의 oort에서 설정 › 기기 › 폰 연결의 「QR 만들기」를 누릅니다.',
  '이 폰의 프로필에서 로그아웃합니다.',
  '첫 화면의 「QR 찍기」로 맥에 뜬 QR을 찍습니다.',
];

/**
 * 계보당 폰 키 1개(#3127, ADR-0146 증보 2026-09-29)로 새 키를 못 등록할 때의
 * 방법(#3145). 맥이 이전 키를 끊는 쪽이 먼저, QR로 다시 연결하는 쪽은 문장으로.
 * 맥 낱말과 맞춘다: 설정 › 기기 › 지시 서명, 「지시 권한 끊기」.
 */
export const REVOKE_OLD_KEY_STEPS: readonly string[] = [
  '맥의 oort에서 설정 › 기기 › 지시 서명을 엽니다.',
  '이 폰의 이전 키에서 「지시 권한 끊기」를 누릅니다.',
];
const AFTER_REVOKE_OLD = '여기로 돌아오면 「새 키로 다시 등록」이 열립니다.';
const AFTER_REVOKE_REFUSED = '여기로 돌아와 「다시 시도」를 누릅니다.';
/** 계보에 낯선 폰 키가 있을 수 있다 — 승인하면 그 키가 이 계정으로 지시한다. */
export const REFUSED_WARNING =
  '내가 등록한 것이 아니면 승인하지 말고 끊어야 합니다.';
const OR_RELINK = '맥에서 QR을 새로 만들어 이 폰에 다시 연결해도 됩니다.';

export const MAC_WHERE = '맥의 oort에서 설정 › 기기 › 지시 서명을 엽니다.';

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
      headline: '로그인이 끝나 이 폰으로 지금은 지시할 수 없습니다.',
      detail: view.biometryOff
        ? '같은 키를 이 로그인에 다시 연결하면 맥의 승인은 그대로입니다. 옮기려면 iOS 설정에서 Face ID를 켜세요.'
        : '같은 키를 이 로그인에 다시 연결하면 맥의 승인은 그대로입니다. Face ID로 한 번 확인하면 됩니다.',
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
    case 'replaceBlocked':
      return view.reason === 'oldKey'
        ? {
            badge: '맥 확인 필요',
            tone: 'warn',
            headline: '이전 지시 키가 맥에 남아 있어 새 키를 등록할 수 없습니다.',
            detail: `이 폰의 이전 키는 더 쓸 수 없는 것으로 보입니다(Face ID 등록이 바뀌면 이렇게 됩니다). 맥에는 아직 승인된 채로 남아 있을 수 있습니다. 이전 키를 끊은 뒤 새 키를 등록합니다. ${OR_RELINK} 새 키도 맥에서 다시 승인해야 지시할 수 있습니다.`,
            steps: [...REVOKE_OLD_KEY_STEPS, AFTER_REVOKE_OLD],
            fingerprintLabel: '이전 키 지문',
          }
        : {
            badge: '맥 확인 필요',
            tone: 'warn',
            headline: '이 연결에 이미 폰 키가 있어 새 키를 등록하지 못했습니다.',
            detail: `이전 키를 끊으면 등록됩니다. ${OR_RELINK} 짚이는 이전 키가 없다면 맥의 지시 서명 목록에서 키의 이름과 등록 시각을 확인합니다.`,
            warning: REFUSED_WARNING,
            steps: [...REVOKE_OLD_KEY_STEPS, AFTER_REVOKE_REFUSED],
          };
    case 'unlinked':
      return view.reason === 'notFromMac'
        ? {
            badge: 'QR 연결 필요',
            tone: 'warn',
            headline: '맥에서 만든 QR로 다시 연결해야 지시할 수 있습니다.',
            detail:
              '이 폰은 맥이 아닌 곳에서 띄운 QR로 연결돼 맥에서 승인할 수 없습니다. 대화와 알림은 그대로 씁니다.',
            steps: QR_LINK_STEPS,
          }
        : {
            badge: 'QR 연결 필요',
            tone: 'warn',
            headline: '이 폰으로 지시하려면 맥에서 QR로 한 번 연결해야 합니다.',
            detail:
              'QR로 연결하지 않은 로그인은 지시 기기가 될 수 없습니다. 대화와 알림은 그대로 씁니다.',
            steps: QR_LINK_STEPS,
          };
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
