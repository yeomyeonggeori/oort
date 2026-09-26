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

/** 연결 화면이 세션을 세우기 직전에 부른다. */
export function noteConnectRoute(route: PhoneRoute): void {
  connectedRoute = route;
}

/** M3이 읽는다. 읽어도 지우지 않는다(같은 세션 안에서 다시 그려질 수 있다). */
export function lastConnectRoute(): PhoneRoute | null {
  return connectedRoute;
}

/** 로그아웃·시험 정리용. */
export function resetConnectRoute(): void {
  connectedRoute = null;
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

/** M3 (ADR-0193 D8 문장 그대로, 버튼은 [계속] 하나). */
export const NOTIFY_LINE = '에이전트가 나를 부를 때 알려 드릴까요?';
export const NOTIFY_DETAIL =
  '계속하면 iOS 알림 허용 창이 떠요. 나중에 설정 › 알림에서 바꿀 수 있어요.';
export const NOTIFY_CONTINUE_LABEL = '계속';
/** 알림 예시 카드. 사람 이름을 넣지 않는다(누구의 폰에서나 참이어야 한다). */
export const NOTIFY_SAMPLE_TITLE = 'oort';
export const NOTIFY_SAMPLE_TIME = '지금';
export const NOTIFY_SAMPLE_BODY =
  'Claude · PR 리뷰를 끝냈어요. 두 군데 확인이 필요해요.';
