import {nativeApplicationVersion, nativeBuildVersion} from 'expo-application';

// =============================================================================
// 프로필 시트 맨 아래의 한 줄 — 이 기기에 깔린 앱이 몇 판인가 (#2702).
//
// 값은 네이티브가 답한다(`CFBundleShortVersionString` · `CFBundleVersion`,
// Info.plist 가 빌드 설정 `MARKETING_VERSION` · `CURRENT_PROJECT_VERSION` 에서 받는다).
// JS 에 숫자를 적어 두면 릴리스마다 둘 중 하나가 틀리고, 틀린 버전 줄은 버그
// 신고를 엉뚱한 빌드로 보낸다.
//
// `expo-application` 은 이 앱에 이미 링크돼 있다(`expo-notifications` 의 의존으로
// Podfile.lock 에 `EXApplication` 이 있다). 직접 의존으로 적은 것은 import 하는
// 파일이 생겼기 때문이고, 네이티브 쪽에 새로 들어오는 코드는 없다.
// =============================================================================

/** 버전 줄의 글자. 모르는 것은 모른다고 말한다 — 빈 괄호를 그리지 않는다. */
export function appVersionLabel(
  version: string | null,
  build: string | null,
): string {
  const v = version?.trim() ?? '';
  const b = build?.trim() ?? '';
  if (v === '') return 'oort · 버전 정보를 읽지 못했습니다';
  return b === '' ? `oort ${v}` : `oort ${v} (${b})`;
}

/** 이 실행의 버전 줄. 값은 실행 중에 바뀌지 않는다. */
export function currentAppVersionLabel(): string {
  return appVersionLabel(nativeApplicationVersion, nativeBuildVersion);
}
