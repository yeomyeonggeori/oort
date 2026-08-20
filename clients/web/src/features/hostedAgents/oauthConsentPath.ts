// =============================================================================
// OAuth consent 는 HashRouter 밖에 산다 (goal HAP-UX4 / #1369).
//
// 이 앱은 HashRouter 다(app/App.tsx: Tauri 릴리스가 `tauri://localhost` 에서 서버
// 없이 번들을 열기 때문). 그런데 #1368 인가 서버의 consent_url 은 **해시가 없는**
// 절대 https 경로여야 한다(config.rs: `!value.contains(['#', ' '])`). 그래서
// provider 리다이렉트는 `https://앱/oauth/consent?request=<봉투>` 로 떨어지고, 그
// `?request=` 는 해시가 아니라 **진짜 쿼리 문자열**에 있다. HashRouter 의 `<Routes>`
// 는 해시만 보므로 이 경로를 라우트로 잡지 못한다.
//
// 그래서 App 은 라우터보다 먼저 `window.location.pathname` 을 보고 이 화면으로
// 갈라진다. 아래 둘은 그 판단을 순수 함수로 떼어 낸 것이다 — 컴포넌트는 window 를
// 읽어 이 함수들에 넘기고, 판정 자체는 window 없이 테스트된다(이 클라이언트의 웹
// 테스트는 node 환경이라 window 가 없다).
//
// ## request id 는 서버가 서명한 opaque 값 하나다
//
// 이 값은 저장소·히스토리·텔레메트리·로그 어디에도 복제하지 않는다(#1369 보안
// 척추). 여기서 하는 일은 URL 쿼리에서 한 번 읽는 것뿐이고, 그 값을 다른 곳에
// 쓰지 않는다. provider 리다이렉트의 다른 값은 신뢰하지 않으므로 이 함수도
// `request` 하나만 읽고 나머지 쿼리는 보지 않는다.
// =============================================================================

/** consent 화면의 경로. 서버 `MOMO_AGENT_PORT_OAUTH_CONSENT_URL` 의 path 부분과 같다. */
export const OAUTH_CONSENT_PATH = "/oauth/consent";

/** 지금 이 브라우저가 consent 경로에 서 있는가. 끝의 슬래시는 허용한다. */
export function isOauthConsentPath(pathname: string): boolean {
  return pathname === OAUTH_CONSENT_PATH || pathname === `${OAUTH_CONSENT_PATH}/`;
}

/**
 * URL 쿼리에서 서버가 서명한 request id 를 한 번 읽는다.
 *
 * `search` 는 `window.location.search`("?request=...")이다. 값이 없으면 `null` 을
 * 돌려주고, 화면은 그것을 "잘못된 링크"로 그린다 — 추측한 요청을 서버에 보내지
 * 않는다.
 */
export function readOauthRequestId(search: string): string | null {
  const value = new URLSearchParams(search).get("request");
  return value !== null && value.length > 0 ? value : null;
}
