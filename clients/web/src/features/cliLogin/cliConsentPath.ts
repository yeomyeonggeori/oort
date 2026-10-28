// =============================================================================
// oort CLI 로그인 동의 화면도 HashRouter 밖의 실경로다 (ADR-0216 D6-나, #4700).
//
// 서버의 공개 `GET /v1/oauth/authorize?client_id=oort-cli…` 는 아무것도 쓰지 않고
// 브라우저를 `https://앱/oauth/cli?request=<서명된 봉투>` 로 넘긴다. 그 `?request=`
// 는 해시가 아니라 진짜 쿼리 문자열이라 HashRouter 의 `<Routes>` 가 잡지 못한다.
// 그래서 App 은 라우터보다 먼저 `window.location.pathname` 을 보고 이 화면으로
// 갈라진다(호스티드 에이전트 동의 `/oauth/consent` 와 같은 이유, 같은 모양:
// hostedAgents/oauthConsentPath.ts). 판정은 window 없이 시험하도록 순수 함수로 뗐다.
//
// 이 경로의 서버 쪽 정본은 설정 `MOMO_DEV_LOGIN_OAUTH_CONSENT_URL` 의 path 부분이다.
//
// request 값은 서버가 서명한 opaque 값 하나다. 저장소·텔레메트리·로그 어디에도
// 복제하지 않고, 여기서는 URL 쿼리에서 한 번 읽을 뿐이다. 나머지 쿼리는 보지 않는다.
// =============================================================================

/** 동의 화면의 경로. */
export const CLI_CONSENT_PATH = "/oauth/cli";

/** 지금 이 브라우저가 CLI 동의 경로에 서 있는가. 끝의 슬래시는 허용한다. */
export function isCliConsentPath(pathname: string): boolean {
  return pathname === CLI_CONSENT_PATH || pathname === `${CLI_CONSENT_PATH}/`;
}

/**
 * URL 쿼리에서 서버가 서명한 request 값을 한 번 읽는다. `search` 는
 * `window.location.search`("?request=...")다. 없거나 비면 `null` 이고, 화면은
 * 추측한 요청을 서버에 보내지 않고 「올바르지 않은 요청」으로 그린다.
 */
export function readCliRequestId(search: string): string | null {
  const value = new URLSearchParams(search).get("request");
  return value !== null && value.length > 0 ? value : null;
}
