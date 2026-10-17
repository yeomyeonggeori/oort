import {
  APP_STORE_URL,
  FEED_FAILURE_TTL_MS,
  FEED_TIMEOUT_MS,
  FEED_TTL_MS,
  IOS_FEED_URL,
  TESTFLIGHT_URL,
  fetchIosFeed,
  loadIosFeed,
  offerFor,
  parseBuild,
  parseIosFeed,
  resetIosFeedCacheForTest,
} from '../src/features/appUpdate/feed';

// =============================================================================
// 새 버전 피드 (#3905). 규율은 하나: 읽지 못하면 아무것도 보이지 않는다.
// 네트워크는 전부 가짜 fetch 다. 이 파일은 실제 Pages 의 JSON 을 한 번도 읽지 않았다.
// =============================================================================

const GOOD = {ios: {latest_build: 3036, version: '0.1.29', testflight: true}};

function ok(body: unknown) {
  return {ok: true, json: async () => body};
}

beforeEach(() => {
  resetIosFeedCacheForTest();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('parseIosFeed', () => {
  it('정상 모양을 읽는다(빌드는 숫자 또는 숫자 문자열)', () => {
    expect(parseIosFeed(GOOD)).toEqual({latestBuild: 3036, version: '0.1.29', testflight: true});
    expect(
      parseIosFeed({ios: {latest_build: '3036', version: ' 0.1.29 ', testflight: false}}),
    ).toEqual({latestBuild: 3036, version: '0.1.29', testflight: false});
  });

  it.each([
    ['null', null],
    ['배열', []],
    ['ios 없음', {}],
    ['ios 가 문자열', {ios: 'x'}],
    ['빌드 0', {ios: {latest_build: 0, version: '1', testflight: true}}],
    ['빌드 음수', {ios: {latest_build: -3, version: '1', testflight: true}}],
    ['빌드 소수', {ios: {latest_build: 3.5, version: '1', testflight: true}}],
    ['빌드 글자', {ios: {latest_build: '3x', version: '1', testflight: true}}],
    ['빌드 누락', {ios: {version: '1', testflight: true}}],
    ['버전 누락', {ios: {latest_build: 3, testflight: true}}],
    ['버전에 공백·기호', {ios: {latest_build: 3, version: '1 <b>', testflight: true}}],
    ['버전이 너무 김', {ios: {latest_build: 3, version: '1'.repeat(40), testflight: true}}],
    ['testflight 가 문자열', {ios: {latest_build: 3, version: '1', testflight: 'true'}}],
  ])('모양이 틀리면 null: %s', (_name, body) => {
    expect(parseIosFeed(body)).toBeNull();
  });
});

describe('빌드 비교', () => {
  it('parseBuild: 숫자만 견준다', () => {
    expect(parseBuild('3035')).toBe(3035);
    expect(parseBuild(' 240 ')).toBe(240);
    expect(parseBuild(null)).toBeNull();
    expect(parseBuild('')).toBeNull();
    expect(parseBuild('1.0.2')).toBeNull();
    expect(parseBuild('abc')).toBeNull();
  });

  it('새 판일 때만 제안한다: 큼 / 같음 / 작음 / 모르는 빌드 / 피드 없음', () => {
    const feed = parseIosFeed(GOOD);
    expect(offerFor(feed, 3035)).toEqual({
      version: '0.1.29',
      latestBuild: 3036,
      currentBuild: 3035,
      testflight: true,
    });
    expect(offerFor(feed, 3036)).toBeNull();
    expect(offerFor(feed, 3037)).toBeNull();
    expect(offerFor(feed, null)).toBeNull();
    expect(offerFor(null, 3035)).toBeNull();
  });
});

describe('fetchIosFeed: 어떤 실패든 null 이고 던지지 않는다', () => {
  it('성공: 같은 주소로 한 번, 쿠키·인증 없이', async () => {
    const fetchImpl = jest.fn(async () => ok(GOOD));
    expect(await fetchIosFeed(fetchImpl)).toEqual({
      latestBuild: 3036,
      version: '0.1.29',
      testflight: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, {headers: Record<string, string>}];
    expect(url).toBe(IOS_FEED_URL);
    expect(Object.keys(init.headers)).toEqual(['Accept']);
  });

  it('HTTP 오류·던짐·형식 불량·JSON 파싱 실패는 모두 null', async () => {
    expect(await fetchIosFeed(async () => ({ok: false, json: async () => GOOD}))).toBeNull();
    expect(await fetchIosFeed(async () => { throw new Error('offline'); })).toBeNull();
    expect(await fetchIosFeed(async () => ok({ios: {}}))).toBeNull();
    expect(
      await fetchIosFeed(async () => ({ok: true, json: async () => { throw new SyntaxError('x'); }})),
    ).toBeNull();
  });

  it('시간 초과: 응답이 안 오면 중단하고 null', async () => {
    jest.useFakeTimers();
    let aborted = false;
    const hanging = (_url: string, init?: {signal?: AbortSignal}) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const pending = fetchIosFeed(hanging as never, FEED_TIMEOUT_MS);
    await jest.advanceTimersByTimeAsync(FEED_TIMEOUT_MS + 1);
    expect(await pending).toBeNull();
    expect(aborted).toBe(true);
  });
});

describe('loadIosFeed: 캐시', () => {
  it('두 화면이 동시에 물어도 요청은 하나', async () => {
    const fetchImpl = jest.fn(async () => ok(GOOD));
    const [a, b] = await Promise.all([loadIosFeed(fetchImpl), loadIosFeed(fetchImpl)]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('성공은 6시간 쓰고 그 뒤 다시 묻는다', async () => {
    const fetchImpl = jest.fn(async () => ok(GOOD));
    let now = 1_000;
    await loadIosFeed(fetchImpl, () => now);
    now += FEED_TTL_MS - 1;
    await loadIosFeed(fetchImpl, () => now);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2;
    await loadIosFeed(fetchImpl, () => now);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('실패는 5분만 기억해서, 오프라인에서 돌아오면 곧 다시 묻는다', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(ok(GOOD));
    let now = 1_000;
    expect(await loadIosFeed(fetchImpl, () => now)).toBeNull();
    now += FEED_FAILURE_TTL_MS - 1;
    expect(await loadIosFeed(fetchImpl, () => now)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2;
    expect((await loadIosFeed(fetchImpl, () => now))?.latestBuild).toBe(3036);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('상수', () => {
  it('피드는 데스크탑 업데이트 피드와 같은 Pages 저장소에 있다', () => {
    expect(IOS_FEED_URL).toBe('https://yeomyeonggeori.github.io/momo-alpha/ios-latest.json');
    expect(TESTFLIGHT_URL).toBe('itms-beta://');
    // 스토어 등록 전 자리표시. 등록되면 이 시험도 함께 바꾼다.
    expect(APP_STORE_URL).toContain('id0000000000');
  });
});
