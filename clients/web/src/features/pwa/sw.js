// =============================================================================
// 서비스 워커 (goal B10). 이 파일은 앱 번들에 들어가지 않는다: vite.config.ts의
// `momoServiceWorker` 플러그인이 빌드 끝에서 아래 두 자리를 채워 dist/sw.js로
// 내보낸다(그래서 확장자도 .js다 — tsc는 src의 .js를 보지 않는다).
//
// 이 워커가 하는 일은 두 가지뿐이다.
//   1. 앱 셸(문서 + 진입 스크립트 + 스타일시트)을 캐시해서 두 번째 실행부터
//      네트워크를 기다리지 않게 한다. 홈 화면에서 여는 앱은 콜드 스타트가 곧
//      첫인상이다.
//   2. 네트워크가 없을 때 **셸만** 띄운다.
//
// 하지 않는 일이 더 중요하다: **데이터는 캐시하지 않는다.** /v1 응답은 이
// 워커를 그대로 통과하므로, 오프라인에서 열린 앱은 빈 화면에 각 표면의 오프라인
// 상태(States.tsx의 배너/빈 상태)를 그린다. 어제 받아 둔 메시지 목록을 오늘 것인
// 양 보여주는 것은 캐시가 아니라 거짓말이고, 그 화면에서 사람이 내리는 판단
// ("아무도 답을 안 했네")은 되돌릴 수 없다. 오프라인 동기화는 RN(ADR-0137)이
// 세션·읽음 상태와 함께 설계할 몫이지, 셸 캐시가 흉내 낼 일이 아니다.
//
// 푸시 알림도 없다: ADR-0120의 알림 경로는 NSE(네이티브 확장)이고 이 다리의
// 범위가 아니다. 그래서 push/notificationclick 핸들러가 이 파일에 없는 것은
// 빠뜨린 것이 아니라 정한 것이다.
// =============================================================================

// 빌드 산출물의 파일 이름 해시에서 나온 값. 내용이 바뀌면 바뀌고, 안 바뀌면
// 그대로다. 캐시 이름에 들어가므로 새 빌드는 언제나 빈 캐시에서 시작한다.
const BUILD_ID = "__MOMO_BUILD_ID__";
// 설치 시점에 미리 받아 둘 셸 자산. 플러그인이 진입 청크와 CSS를 넣어 준다.
const SHELL_ASSETS = __MOMO_SHELL_ASSETS__;

const CACHE = `oort-shell-${BUILD_ID}`;
const CACHE_PREFIX = "oort-shell-";
// 오프라인 항해가 돌려받는 문서. Caddy도 vite preview도 모르는 경로를
// index.html로 되돌리므로(SPA 폴백), 캐시에서도 문서는 이 열쇠 하나다.
const SHELL_DOCUMENT = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 한 장이 실패해도 설치는 계속한다. 자산 하나를 못 받아 워커 자체가 서지
      // 못하면, 그 다음 방문은 캐시도 없고 워커도 없는 상태로 시작한다.
      // `cache: "reload"`는 HTTP 캐시에 있던 낡은 사본을 프리캐시로 승격시키지
      // 않기 위한 것이다.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      );
      // 즉시 활성화. 새 워커가 `waiting`에 앉아 다음 전체 종료를 기다리면, 탭
      // 하나를 계속 열어 두는 사람(= 홈 화면에서 여는 사람)은 낡은 셸에 영영
      // 고착된다. 대신 사람이 보는 화면을 몰래 바꾸지는 않는다: 아래 claim이
      // 알린 controllerchange를 받아 앱이 "새 버전" 줄을 띄우고, 새로고침을
      // 누르는 것은 사람이다(store.ts).
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // 다른 오리진(레일 WS, LiveKit)은 이 워커의 일이 아니다.
  if (url.origin !== self.location.origin) return;
  // 서버가 답해야 하는 것들. 이 두 줄이 "데이터는 캐시하지 않는다"의 전부다:
  // 여기서 return하면 요청은 워커가 없는 것과 똑같이 네트워크로 나가고,
  // 오프라인이면 그대로 실패해서 앱의 오프라인 상태가 켜진다.
  if (url.pathname.startsWith("/v1/") || url.pathname === "/health") return;

  if (request.mode === "navigate") {
    event.respondWith(freshShellFirst(event, request));
    return;
  }
  event.respondWith(cachedAsset(event, request));
});

/**
 * 캐시 쓰기는 응답을 붙잡지 않는다. `await cache.put(...)`은 본문을 끝까지 읽은
 * 뒤에야 페이지에 응답을 넘기므로, 캐시를 채우는 대가를 매 요청의 지연으로
 * 치르게 된다. `waitUntil`은 반대로 응답을 즉시 흘려보내면서 워커가 쓰기 도중에
 * 종료되지 않도록 붙잡아 둔다.
 */
function cacheInBackground(event, cache, key, response) {
  event.waitUntil(cache.put(key, response).catch(() => {}));
}

/**
 * 문서는 네트워크 우선이다.
 *
 * 캐시 우선으로 두면 배포된 새 index.html이 언제 반영될지 아무도 모르게 되고,
 * 그것이 PWA가 "업데이트가 안 되는 앱"이라는 평판을 얻은 이유다. 온라인에서는
 * 언제나 방금 서버에 있는 문서를 받고, 네트워크가 없을 때만 마지막으로 받아 둔
 * 셸을 돌려준다. 문서는 몇 KB짜리 껍데기이고 무게는 해시가 붙은 자산에 있으므로,
 * 이 왕복이 콜드 스타트를 되돌리지 않는다.
 */
async function freshShellFirst(event, request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cacheInBackground(event, cache, SHELL_DOCUMENT, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(SHELL_DOCUMENT);
    if (cached) return cached;
    // 캐시에도 없다: 브라우저 자신의 오프라인 화면이 우리가 지어낸 문구보다
    // 정확하다.
    throw error;
  }
}

/**
 * 자산은 캐시 우선이다.
 *
 * 이 캐시는 빌드 하나의 것이고(BUILD_ID), 활성화될 때 이전 세대를 지운다. 한
 * 빌드 안에서 /assets/*.js 같은 파일은 이름에 내용 해시가 박혀 있어 정의상
 * 변하지 않으므로, 캐시가 낡을 수 있는 창 자체가 없다. 그래서 재검증 경로도
 * 없다: 만료가 없는 캐시에 만료 처리를 붙이는 것은 코드만 늘린다.
 *
 * 캐시에 없고 네트워크도 실패하면 그대로 실패한다. 지연 로드되는 청크(관전
 * 터미널의 xterm, 허들의 LiveKit)가 여기 해당하고, 그 표면은 자기 오류 상태를
 * 이미 갖고 있다. 없는 기능을 있는 척하는 것보다 낫다.
 */
async function cachedAsset(event, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // `basic`만 저장한다: 불투명 응답은 상태 코드도 못 읽으므로, 실패를 성공으로
  // 캐시할 수 있다.
  if (response && response.ok && response.type === "basic") {
    cacheInBackground(event, cache, request, response.clone());
  }
  return response;
}
