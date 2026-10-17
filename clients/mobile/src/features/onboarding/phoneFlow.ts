// =============================================================================
// 폰 온보딩 흐름의 모델 (ADR-0193 D8·D10·D11, ADR-0185 증보 §6, #2819·#2820).
//
// 폰은 새 단계를 만들지 않는다(§6). 같은 연결 경로의 겉만 나눈다.
//
//   M0 환영 ──[QR 찍기]──> M1 스캔 ─> M2 확인 번호 ─┐
//      ├──[주소로 로그인]──> M-b 로그인 ─────────────┼─> M3 알림 미리 안내 ─> 앱
//      └──[초대 링크로 참여]─> M-a 초대 ──────────────┘   (권한이 이미 정해졌으면 건너뜀)
//
// 진행 점은 경로마다 한 줄이다(D10). 첫 화면(M0)에는 점이 없다. M3은 세션이 선
// 뒤라 연결 화면이 이미 내려갔으므로, 어느 경로로 왔는지는 아래 한 칸이 들고
// 간다. 앱을 다시 띄우면 비어 있고, 그때 M3은 점 없이 선다.
//
// M3은 ADR-0204 D4(#3925)로 「어떤 알림을 받을까요?」가 됐다. iOS 허용 창을 거부하면
// 같은 자리에서 한 장 더 선다(거부 뒤 안내). 그 한 장이 서 있는 동안 키 연결 시트가
// 겹쳐 서지 않게 하는 신호가 아래 `notifyPrimerHeld` 한 칸이다.
// =============================================================================

import {
  onboardingDotsLabel,
  type OnboardingDots,
  type OnboardingDotState,
} from '@momo/core/features/onboarding/guide';

export type PhoneRoute = 'qr' | 'signIn' | 'join';

export type PhoneScreen = 'scan' | 'sas' | 'sign-in' | 'join' | 'notify';

const ROUTE_SCREENS: Readonly<Record<PhoneRoute, readonly PhoneScreen[]>> = {
  qr: ['scan', 'sas', 'notify'],
  signIn: ['sign-in', 'notify'],
  join: ['join', 'notify'],
};

/** 이 경로의 이 화면에 그릴 점. 경로가 모르면(앱 재시작) null이라 점을 숨긴다. */
export function phoneOnboardingDots(
  route: PhoneRoute | null,
  screen: PhoneScreen,
): OnboardingDots | null {
  if (route === null) return null;
  const screens = ROUTE_SCREENS[route];
  const index = screens.indexOf(screen);
  if (index < 0) return null;
  const dots: OnboardingDotState[] = screens.map((_, i) =>
    i < index ? 'done' : i === index ? 'current' : 'todo',
  );
  return {
    total: screens.length,
    current: index + 1,
    dots,
    label: onboardingDotsLabel(screens.length, index + 1),
  };
}

// ---- 연결 화면이 M3에 넘기는 한 칸 ------------------------------------------

let connectedRoute: PhoneRoute | null = null;
/** QR 연결 뒤 기기 키를 한 번 만들고 등록할지(#3026, ADR-0146 개정 D-6 ②). */
let keyEnrollmentArmed = false;

/** 연결 화면이 세션을 세우기 직전에 부른다. */
export function noteConnectRoute(route: PhoneRoute): void {
  connectedRoute = route;
  // QR로 시작했다가 주소 로그인으로 들어오면 풀린다 — 키는 QR 연결의 몫이다.
  keyEnrollmentArmed = route === 'qr';
}

/** 셸이 QR 연결 직후 한 번 읽는다. 읽지 않고 들여다보기만 한다. */
export function qrKeyEnrollmentArmed(): boolean {
  return keyEnrollmentArmed;
}

/** 셸이 등록을 시작하며 부른다. 같은 연결로 두 번 등록하지 않는다. */
export function consumeQrKeyEnrollment(): void {
  keyEnrollmentArmed = false;
}

/** M3이 읽는다. 읽어도 지우지 않는다(같은 세션 안에서 다시 그려질 수 있다). */
export function lastConnectRoute(): PhoneRoute | null {
  return connectedRoute;
}

/** 로그아웃·시험 정리용. */
export function resetConnectRoute(): void {
  connectedRoute = null;
  keyEnrollmentArmed = false;
  setNotifyPrimerHeld(false);
}

// ---- M3이 아직 서 있는 동안 (ADR-0204 D4, #3925) -------------------------------
//
// 키 연결 시트(`DeviceKeyLinkGate`)는 M3 다음에 선다. 그런데 그 시트는 네이티브
// `Modal`이라, 푸시 게이트가 `ask`를 벗어나는 순간 무엇이 떠 있든 그 위로 오른다.
// D4 전에는 `ask`를 벗어나면 M3도 곧장 내려가서 겹칠 일이 없었다. 이제 iOS 창을
// 거부하면 M3이 거부 뒤 안내를 한 장 더 들고 서 있으므로, 그 끝까지 시트를 붙든다.
//
// 이 칸은 **[계속]을 누르는 그 이벤트에서** 세운다. 게이트가 `settled`로 바뀐 뒤에
// 효과로 세우면 시트가 그 한 렌더에 먼저 마운트됐다가 내려간다(Modal 깜박임).
// 내리는 때는 M3이 완전히 사라진 때다(허용되었거나, 거부 뒤 안내를 닫았을 때).

let notifyPrimerHeld = false;
const heldListeners = new Set<() => void>();

export function isNotifyPrimerHeld(): boolean {
  return notifyPrimerHeld;
}

/** `useSyncExternalStore`용. 지우는 함수를 돌려준다. */
export function subscribeNotifyPrimerHeld(listener: () => void): () => void {
  heldListeners.add(listener);
  return () => {
    heldListeners.delete(listener);
  };
}

export function setNotifyPrimerHeld(next: boolean): void {
  if (notifyPrimerHeld === next) return;
  notifyPrimerHeld = next;
  for (const listener of [...heldListeners]) listener();
}

// ---- M3을 보일지 (ADR-0193 D8, #2820) ---------------------------------------

/** expo `IosAuthorizationStatus.NOT_DETERMINED`. UNAuthorizationStatus.notDetermined. */
const IOS_NOT_DETERMINED = 0;

/**
 * 아직 아무도 묻지 않았을 때만 M3을 보인다.
 *
 * `status`만으로는 모자란다. expo는 iOS의 provisional(3)·ephemeral(4)을 일반
 * `status`에서 `undetermined`로 접는다
 * (`ExpoNotificationsPermissionsRequester.swift` `makePermissionsResult`의
 * `default:` 가지). 그 둘은 이미 정해진 권한이라 M3을 건너뛰어야 하므로 iOS 원래
 * 값을 본다. iOS 값이 없으면(안드로이드·시험 대역) 일반 `status`로 판정한다.
 */
export interface PermissionSnapshot {
  /** expo `PermissionStatus` 값(`'granted' | 'denied' | 'undetermined'`). */
  status: string;
  granted: boolean;
  /** iOS `UNAuthorizationStatus` 원래 값. */
  ios?: {status?: number} | null;
}

export function shouldAskNotifications(settings: PermissionSnapshot): boolean {
  if (settings.granted) return false;
  if (settings.status !== 'undetermined') return false;
  const iosStatus = settings.ios?.status;
  if (iosStatus === undefined || iosStatus === null) return true;
  return iosStatus === IOS_NOT_DETERMINED;
}

// ---- 문장 --------------------------------------------------------------------
// 코메토의 말은 해요체 한 문장, 폼 라벨·오류는 합니다체다(D11).

/** M0 (시안 프레임 6). */
export const WELCOME_TAGLINE = '사람과 에이전트가 같은 자리에서 일하는 메신저.';
export const WELCOME_LINE = '데스크탑의 QR을 찍어 연결해요.';
export const WELCOME_DETAIL = '데스크탑 설정 › 기기 › 폰 연결에 있어요.';
export const WELCOME_QR_LABEL = 'QR 찍기';
export const ADDRESS_LOGIN_LABEL = '주소로 로그인';

/** M0에서 카메라가 거부됐을 때(M1 거부, 당황). */
export const CAMERA_DENIED_LINE = '카메라를 쓸 수 없어 QR을 찍지 못해요.';
export const CAMERA_DENIED_DETAIL = '주소로 로그인하면 바로 들어갈 수 있어요.';

/** M0에서 연결 코드가 실패했을 때(당황). 까닭은 아래 배너의 core 문장이 말한다. */
export const LINK_FAILED_LINE = 'QR로 연결하지 못했어요.';

/** M0에서 네트워크가 없을 때(당황). */
export const OFFLINE_LINE = '지금은 인터넷에 닿지 않아요.';

/** M2 (시안 프레임 7, 이슈 #2819 Acceptance). */
export const SAS_LINE = '데스크탑에 보이는 번호와 같나요?';
export const SAS_DETAIL = '직접 시작한 연결일 때만 확인하세요.';
export const SAS_CANCEL_LABEL = '취소';
export const SAS_MISMATCH_LABEL = '번호가 달라요';

/** M-b. */
export const SIGN_IN_LINE = '팀 서버 주소로 로그인해요.';

/**
 * M3 (ADR-0204 D4, #3925 — ADR-0193 D8의 문장을 **이 증보가 바꾼다**).
 *
 * D8은 한 가지 질문(「에이전트가 나를 부를 때 알려 드릴까요?」)과 알림 예시 한 장이었다.
 * D4는 같은 자리를 「어떤 알림을 받을까요?」로 넓힌다: 종류 미리 보기 셋과 작업 끝남
 * 스위치 하나. 그 문장에 맞춰 질문과 아래 안내도 새로 적었다.
 *
 * D8에서 **바뀌지 않은 것**이 이 화면의 뼈대다.
 *   - iOS 허용 창 앞의 버튼은 [계속] 하나다(Apple HIG). 「허용」·「나중에」처럼 시스템
 *     버튼과 헷갈리거나 창을 건너뛰는 라벨을 두지 않는다. 스위치는 버튼이 아니다.
 *   - 거부해도 앱은 온전히 쓴다(심사 지침 4.5.4). 거부 뒤에는 어디서 켜는지만 말한다.
 *   - 표시 조건은 iOS 권한이 미결정일 때뿐이다(`shouldAskNotifications`).
 */
export const NOTIFY_LINE = '어떤 알림을 받을까요?';
// 두 문장을 줄로 나눈다: 한 문단으로 두면 둘째 줄에 「있어요.」만 남는다(390 캡처).
export const NOTIFY_DETAIL =
  '계속하면 iOS 알림 허용 창이 떠요.\n나중에 프로필 › 알림에서 바꿀 수 있어요.';
export const NOTIFY_CONTINUE_LABEL = '계속';

/**
 * 거부 뒤 안내 (ADR-0204 D4 「거부하면 「프로필 › 알림에서 켤 수 있어요」」).
 * 코메토는 「건너뛰고 나중에 할 때」(D11 `skipped`)의 표정을 짓는다. 버튼은 이미 창을
 * 지난 뒤라 HIG의 제약 밖이고, 하나다.
 */
export const NOTIFY_DECLINED_LINE = '알림 없이 시작해요.';
export const NOTIFY_DECLINED_DETAIL = '프로필 › 알림에서 켤 수 있어요.';
export const NOTIFY_DECLINED_LABEL = '시작하기';

// ---- 종류 미리 보기 (ADR-0204 D4) ---------------------------------------------
// 「항상 와요」는 종류별로 끌 수 없는 알림이다(승인 요청·멘션·DM). 끌 수 있는 것은 작업
// 끝남 하나이고, 그 이름은 core가 프로필과 함께 읽는 `PUSH_WORK_COMPLETE_LABEL`이다.
export const NOTIFY_ALWAYS_LABEL = '항상 와요';
export const NOTIFY_APPROVAL_LABEL = '승인 요청';
export const NOTIFY_APPROVAL_NOTE = '잠금 화면에서 바로';
export const NOTIFY_MENTION_LABEL = '나를 부른 멘션·답·DM';

/**
 * 승인 알림의 버튼 모양. 실제 버튼의 제목이다(`push/categories.ts`의 `APPROVE_ACTION`·
 * `REJECT_ACTION`). 미리 보기가 실제와 다른 버튼을 보이면 거짓이라 시험이 둘을 대조한다.
 */
export const NOTIFY_APPROVE_BUTTON = '승인';
export const NOTIFY_REJECT_BUTTON = '거부';

/**
 * 알림 예시 카드. **사람 이름을 넣지 않는다**(누구의 폰에서나 참이어야 한다). 제목은
 * 에이전트 이름이거나 고정 문구다.
 *
 * 문구는 실제 알림이 쓰는 꼴을 따른다.
 *   - 승인 요청: 서버가 쓰는 카드 본문 「승인 요청: {제목}」(`momo-agent` `actions.rs`).
 *     예시 액션은 잠금 화면에서 결정할 수 있는 것이어야 한다(ADR-0204 D7: 한 번 보이는
 *     비밀을 내는 링크 발급·호스트 권한은 「열어서 결정」이라 이 약속과 맞지 않는다).
 *   - 작업 끝남: 알림 확장(NSE)의 고정 문구 `PushWorkRunDoneCopy`
 *     (`ios/MomoPushKit/PushNotification.swift`). 시험이 Swift 원문과 대조한다.
 *   - 멘션·답: 에이전트가 쓴 메시지가 제목(작성자)과 본문으로 그대로 뜬다.
 */
export interface NotifySample {
  title: string;
  body: string;
}
export const NOTIFY_SAMPLES: Readonly<
  Record<'approval' | 'work' | 'mention', NotifySample>
> = {
  approval: {title: 'Claude', body: '승인 요청: 채널 만들기'},
  work: {title: '작업이 끝났어요', body: '요청한 작업이 끝났어요'},
  mention: {
    title: 'Claude',
    body: 'PR 리뷰를 끝냈어요. 두 군데 확인이 필요해요.',
  },
};
export const NOTIFY_SAMPLE_TIME = '지금';
