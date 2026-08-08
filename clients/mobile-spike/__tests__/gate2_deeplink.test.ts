/**
 * 게이트 2 — `deepLink.ts` 가 무수정으로 통과하는가 (기기 불필요)
 *
 * 이 테스트는 **웹의 진짜 소스 파일을 그대로 import 한다**(복사본이 아니다):
 *   clients/web/src/features/auth/deepLink.ts
 *   clients/web/src/lib/serverBase.ts
 * jest moduleNameMapper 가 `@/…` 를 웹 소스로 이어주고, Vite 전용인 `./env` 만
 * RN 상수 stub 으로 갈아끼운다(= 실측된 어댑터 비용, webEnvStub.ts 참조).
 *
 * 같은 케이스 목록을 URL 구현 3종 위에서 돌려 비교한다:
 *   1. Node 내장 URL        — 웹이 실제로 쓰는 것과 동등한 기준선
 *   2. RN 0.86 코어 URL      — 폴리필을 넣지 않았을 때 RN 이 주는 것
 *   3. react-native-url-polyfill@4.0.0 — 도입 후보
 *
 * 판정: 3번이 전부 통과해야 게이트 2 PASS. 2번이 실패해야 "폴리필이 필요하다"가
 * 주장이 아니라 측정이 된다.
 */

import {
  URL as PolyfillURL,
  URLSearchParams as PolyfillURLSearchParams,
} from 'react-native-url-polyfill';
// RN 코어가 폴리필 없이 제공하는 URL. 정규식 기반이며 WHATWG 구현이 아니다.
import {URL as RNCoreURL} from 'react-native/Libraries/Blob/URL';
import {URLSearchParams as RNCoreURLSearchParams} from 'react-native/Libraries/Blob/URLSearchParams';

import {
  parseJoinDeepLink,
  parseJoinFromPageUrl,
  urlWithoutJoinParams,
} from '@/features/auth/deepLink';
import {normalizeServerUrl} from '@/lib/serverBase';

import {runCases, tally, type CaseResult} from '../src/gate2_url/cases';

const api = {
  parseJoinDeepLink,
  parseJoinFromPageUrl,
  urlWithoutJoinParams,
  normalizeServerUrl,
};

const NodeURL = globalThis.URL;
const NodeURLSearchParams = globalThis.URLSearchParams;

function withUrlImpl(
  URLImpl: unknown,
  SPImpl: unknown,
  fn: () => CaseResult[],
): CaseResult[] {
  const prevURL = globalThis.URL;
  const prevSP = globalThis.URLSearchParams;
  // @ts-expect-error 런타임 교체가 이 테스트의 요점이다
  globalThis.URL = URLImpl;
  // @ts-expect-error 위와 같음
  globalThis.URLSearchParams = SPImpl;
  try {
    return fn();
  } finally {
    globalThis.URL = prevURL;
    globalThis.URLSearchParams = prevSP;
  }
}

function report(label: string, results: CaseResult[]): void {
  const t = tally(results);
  const lines = [`\n── ${label} → ${t.passed}/${t.total} 통과, ${t.failed} 실패`];
  for (const r of results.filter(x => !x.ok)) {
    lines.push(`   FAIL [${r.group}] ${r.name}\n        ${r.detail ?? ''}`);
  }
  // 보고서에 그대로 옮길 수 있도록 콘솔에 남긴다.
  console.log(lines.join('\n'));
}

describe('게이트 2 — deepLink.ts 이식성', () => {
  it('기준선: Node 내장 URL 에서 전부 통과한다 (케이스 전사가 정확하다는 증거)', () => {
    const results = withUrlImpl(NodeURL, NodeURLSearchParams, () => runCases(api));
    report('1. Node 내장 URL (기준선)', results);
    const t = tally(results);
    expect(t.failed).toBe(0);
  });

  it('폴리필 없이 RN 0.86 코어 URL 만으로는 통과하지 못한다 (= 폴리필은 선택이 아니다)', () => {
    const results = withUrlImpl(RNCoreURL, RNCoreURLSearchParams, () => runCases(api));
    report('2. RN 0.86 코어 URL (폴리필 없음)', results);
    const t = tally(results);
    // 하나라도 깨져야 "폴리필 필요"가 측정이 된다. 전부 통과하면
    // 우리가 잘못 알고 있는 것이므로 그것도 실패로 잡아야 한다.
    expect(t.failed).toBeGreaterThan(0);
  });

  it('react-native-url-polyfill 을 깔면 무수정으로 전부 통과한다', () => {
    const results = withUrlImpl(PolyfillURL, PolyfillURLSearchParams, () =>
      runCases(api),
    );
    report('3. react-native-url-polyfill@4.0.0', results);
    const t = tally(results);
    expect(t.failed).toBe(0);
  });
});
