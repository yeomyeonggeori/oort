// =============================================================================
// 새 버전 알림의 값 출처 (#3905, 성재 결재 2026-10-16).
//
// 폰 앱은 스스로 새 판을 알 방법이 없다. TestFlight·App Store는 앱에게 「새 판이
// 있어요」를 알려 주지 않는다. 가장 작은 안전한 답: 데스크탑 업데이트 매니페스트
// (`update-next.json`)가 사는 같은 GitHub Pages 저장소(`momo-alpha`)에 정적 JSON 한
// 장을 두고, 앱이 그것을 읽어 **자기 빌드 번호와 견준다.**
//
//   https://yeomyeonggeori.github.io/momo-alpha/ios-latest.json
//   { "ios": { "latest_build": 3036, "version": "0.1.29", "testflight": true } }
//
// 서버 필드도, 네이티브 코드도, 새 의존도 없다. 이 파일은 순수 함수와 `fetch` 한 번만
// 가진다. 규율은 하나다: **읽지 못하면 아무것도 보이지 않는다.** 네트워크 실패·시간
// 초과·형식 불량·숫자가 아닌 빌드는 모두 「새 판 없음」과 같은 화면이 된다. 모르는 것을
// 새 판이 있다고 말하는 거짓 알림이, 알림을 못 띄우는 것보다 비싸다.
//
// 피드를 갱신하는 것은 증거 빌드 미션이다(`docs/RELEASING.md` 「iOS 새 버전 피드」).
// =============================================================================

/** 데스크탑 업데이트 피드와 같은 Pages 저장소의 정적 JSON. */
export const IOS_FEED_URL =
  'https://yeomyeonggeori.github.io/momo-alpha/ios-latest.json';

/** 이 시간 안에 못 읽으면 포기한다. 홈이 이 한 장 때문에 기다리는 일은 없다. */
export const FEED_TIMEOUT_MS = 5000;
/** 한 번 읽은 답을 이 시간 동안 쓴다. 정적 파일을 화면마다 다시 부르지 않는다. */
export const FEED_TTL_MS = 6 * 60 * 60 * 1000;
/** 실패는 짧게만 기억한다. 오프라인에서 돌아온 사람이 6시간을 기다리면 안 된다. */
export const FEED_FAILURE_TTL_MS = 5 * 60 * 1000;

/**
 * App Store 판의 이동 주소. **자리표시다**: 스토어 등록(M7-S)이 끝나기 전에는 앱 ID가
 * 없다. 등록 뒤 이 한 줄을 실제 주소로 바꾼다. 지금 `testflight: false` 피드는 운영에
 * 없으므로 이 상수가 화면에 닿는 길은 시험뿐이다.
 */
export const APP_STORE_URL = 'https://apps.apple.com/app/oort/id0000000000';

/** TestFlight 앱을 여는 주소. Apple 문서화된 스킴이고 `canOpenURL` 검사는 쓰지 않는다. */
export const TESTFLIGHT_URL = 'itms-beta://';

export interface IosFeed {
  latestBuild: number;
  version: string;
  testflight: boolean;
}

/** 화면이 그리는 값. 새 판이 있을 때만 존재한다. */
export interface AppUpdateOffer {
  version: string;
  latestBuild: number;
  currentBuild: number;
  testflight: boolean;
}

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/** `latest_build` 는 정수 또는 숫자만 든 문자열. 그 밖은 읽지 않는다. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** 모양이 맞지 않으면 `null`. 값을 고쳐 읽지 않는다. */
export function parseIosFeed(json: unknown): IosFeed | null {
  if (typeof json !== 'object' || json === null) return null;
  const ios = (json as {ios?: unknown}).ios;
  if (typeof ios !== 'object' || ios === null) return null;
  const {latest_build, version, testflight} = ios as Record<string, unknown>;
  const latestBuild = wholeNumber(latest_build);
  if (latestBuild === null) return null;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version.trim())) {
    return null;
  }
  if (typeof testflight !== 'boolean') return null;
  return {latestBuild, version: version.trim(), testflight};
}

/** 이 기기의 빌드 번호(`CFBundleVersion`). 숫자가 아니면 견줄 수 없다. */
export function parseBuild(build: string | null | undefined): number | null {
  if (typeof build !== 'string') return null;
  return wholeNumber(build.trim());
}

/** 피드가 이 기기의 빌드보다 새 판을 말할 때만 제안을 만든다. */
export function offerFor(
  feed: IosFeed | null,
  currentBuild: number | null,
): AppUpdateOffer | null {
  if (feed === null || currentBuild === null) return null;
  if (feed.latestBuild <= currentBuild) return null;
  return {
    version: feed.version,
    latestBuild: feed.latestBuild,
    currentBuild,
    testflight: feed.testflight,
  };
}

type FetchLike = (
  input: string,
  init?: {signal?: AbortSignal; headers?: Record<string, string>},
) => Promise<{ok: boolean; json: () => Promise<unknown>}>;

/** 피드 한 장을 읽는다. 어떤 실패든 `null` 이고 던지지 않는다. */
export async function fetchIosFeed(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs: number = FEED_TIMEOUT_MS,
): Promise<IosFeed | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(IOS_FEED_URL, {
      signal: controller.signal,
      headers: {Accept: 'application/json'},
    });
    if (!response.ok) return null;
    return parseIosFeed(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Cached {
  feed: IosFeed | null;
  at: number;
}

let cache: Cached | null = null;
let inFlight: Promise<IosFeed | null> | null = null;

/**
 * 캐시를 거쳐 피드를 읽는다. 성공은 6시간, 실패는 5분 쓴다. 동시에 여러 화면(홈 배너와
 * 프로필 배너)이 물어도 요청은 하나다.
 */
export function loadIosFeed(
  fetchImpl?: FetchLike,
  now: () => number = Date.now,
): Promise<IosFeed | null> {
  const at = now();
  if (cache !== null) {
    const ttl = cache.feed === null ? FEED_FAILURE_TTL_MS : FEED_TTL_MS;
    if (at - cache.at < ttl) return Promise.resolve(cache.feed);
  }
  if (inFlight !== null) return inFlight;
  inFlight = fetchIosFeed(fetchImpl).then(feed => {
    cache = {feed, at: now()};
    inFlight = null;
    return feed;
  });
  return inFlight;
}

/**
 * 캡처 접점. 계측 하네스(`measure/surfaces.tsx`)가 네트워크 없이 배너가 선 화면을 찍도록
 * 피드 캐시에 값을 꽂는다. 앱 본 흐름은 이 함수를 부르지 않는다.
 */
export function seedIosFeedCacheForCapture(feed: IosFeed): void {
  cache = {feed, at: Date.now()};
}

/** 시험 접점. */
export function resetIosFeedCacheForTest(): void {
  cache = null;
  inFlight = null;
}
