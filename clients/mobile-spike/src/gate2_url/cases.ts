/**
 * 게이트 2 — 판정 케이스.
 *
 * 이 목록은 `clients/web/src/features/auth/model.test.ts` 의
 * `describe("server URL validation")` · `describe("oort://join deep link")` ·
 * `describe("browser deep-link fallback")` 을 **문자 그대로** 옮긴 것이다.
 * 입력·기대값을 바꾸지 마라 — 바꾸는 순간 이 게이트는 아무것도 증명하지 못한다.
 *
 * 같은 목록을 두 곳에서 돌린다:
 *   1. Jest (Node)      — URL 구현 3종을 갈아끼우며 비교 → 기기 없이 판정
 *   2. 앱 화면 (Hermes)  — 폴리필이 실제 RN 런타임에서도 같은 답을 내는지
 */

export interface DeepLinkApi {
  parseJoinDeepLink: (raw: string) => { serverUrl: string; inviteCode: string } | null;
  parseJoinFromPageUrl: (
    href: string,
  ) => { serverUrl: string; inviteCode: string } | null;
  urlWithoutJoinParams: (href: string) => string;
  normalizeServerUrl: (
    raw: string,
  ) => { ok: true; base: string } | { ok: false; message: string };
}

export interface CaseResult {
  name: string;
  group: string;
  ok: boolean;
  /** 실패했을 때만 채운다: 무엇을 기대했고 무엇이 나왔나 */
  detail?: string;
}

function eq(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function show(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
}

type Check = () => { ok: boolean; detail?: string };

function check(actual: unknown, expected: unknown): { ok: boolean; detail?: string } {
  const ok = eq(actual, expected);
  return ok ? { ok } : { ok, detail: `기대 ${show(expected)} / 실제 ${show(actual)}` };
}

/**
 * 케이스 전체를 주어진 구현으로 실행한다.
 * 어떤 케이스가 예외를 던지면 그것도 실패로 집계한다 — 던지고 끝내지 않는다.
 */
export function runCases(api: DeepLinkApi): CaseResult[] {
  const { parseJoinDeepLink, parseJoinFromPageUrl, urlWithoutJoinParams, normalizeServerUrl } =
    api;

  const defs: Array<{ group: string; name: string; run: Check }> = [
    // ---- describe("server URL validation") — deepLink 의 validatedServer 상류 ----
    {
      group: '서버 주소 검증',
      name: 'http 베이스와 포트를 그대로 둔다',
      run: () => check(normalizeServerUrl('http://macbook.local:28000'), {
        ok: true,
        base: 'http://macbook.local:28000',
      }),
    },
    {
      group: '서버 주소 검증',
      name: '호스트만 오면 http 로 내리지 않고 https 로 읽는다',
      run: () => check(normalizeServerUrl('momo.example.com'), {
        ok: true,
        base: 'https://momo.example.com',
      }),
    },
    {
      group: '서버 주소 검증',
      name: '공백과 끝 슬래시를 떼어 /v1 이 깨끗이 붙게 한다',
      run: () => check(normalizeServerUrl('  https://momo.example.com/  '), {
        ok: true,
        base: 'https://momo.example.com',
      }),
    },
    {
      group: '서버 주소 검증',
      name: '리버스 프록시 경로 접두사를 유지한다',
      run: () => check(normalizeServerUrl('https://team.example.com/momo/'), {
        ok: true,
        base: 'https://team.example.com/momo',
      }),
    },
    {
      group: '서버 주소 검증',
      name: '쿼리와 프래그먼트를 버린다',
      run: () => check(normalizeServerUrl('https://momo.example.com/?a=b#c'), {
        ok: true,
        base: 'https://momo.example.com',
      }),
    },
    {
      group: '서버 주소 검증',
      name: 'http 아닌 스킴을 거절하고 대안을 말한다',
      run: () => {
        const r = normalizeServerUrl('ws://momo.example.com');
        if (r.ok) {
          return { ok: false, detail: `기대 거절 / 실제 ${show(r)}` };
        }
        return r.message.includes('http://')
          ? { ok: true }
          : { ok: false, detail: `메시지에 "http://" 없음: ${show(r.message)}` };
      },
    },
    {
      group: '서버 주소 검증',
      name: '빈 주소를 거절한다',
      run: () => check(normalizeServerUrl('   ').ok, false),
    },
    {
      group: '서버 주소 검증',
      name: '호스트 없는 스킴을 거절한다',
      run: () => check(normalizeServerUrl('https://').ok, false),
    },

    // ---- describe("oort://join deep link") ----
    {
      group: 'oort://join 딥링크',
      name: '표준 링크를 파싱하고 server 를 퍼센트 디코딩한다',
      run: () => check(
        parseJoinDeepLink('oort://join?server=https%3A%2F%2Fapi.example.com&code=Ab3-_x'),
        { serverUrl: 'https://api.example.com', inviteCode: 'Ab3-_x' },
      ),
    },
    {
      group: 'oort://join 딥링크',
      name: '파라미터 순서를 따지지 않고 모르는 파라미터를 무시한다',
      run: () => check(
        parseJoinDeepLink(
          'oort://join?code=abc&utm=mail&server=http%3A%2F%2Fmacbook.local%3A28180',
        ),
        { serverUrl: 'http://macbook.local:28180', inviteCode: 'abc' },
      ),
    },
    {
      group: 'oort://join 딥링크',
      name: 'authority 없는 형태(oort:join)도 받는다 — mac 파서와 동일',
      run: () => check(parseJoinDeepLink('oort:join?code=abc'), {
        serverUrl: '',
        inviteCode: 'abc',
      }),
    },
    {
      group: 'oort://join 딥링크',
      name: 'server 가 못 쓸 값이어도 code 는 살린다',
      run: () => check(parseJoinDeepLink('oort://join?server=not%20a%20url&code=abc'), {
        serverUrl: '',
        inviteCode: 'abc',
      }),
    },
    {
      group: 'oort://join 딥링크',
      name: '다른 스킴·다른 액션·빈 링크를 무시한다',
      run: () => {
        const rows: Array<[string, unknown]> = [
          ['https://join?code=abc', parseJoinDeepLink('https://join?code=abc')],
          ['oort://open?code=abc', parseJoinDeepLink('oort://open?code=abc')],
          ['oort://join', parseJoinDeepLink('oort://join')],
          ['not a url', parseJoinDeepLink('not a url')],
        ];
        const bad = rows.filter(([, v]) => v !== null);
        return bad.length === 0
          ? { ok: true }
          : {
              ok: false,
              detail: bad.map(([k, v]) => `${k} → ${show(v)} (null 이어야 함)`).join(' · '),
            };
      },
    },
    {
      group: 'oort://join 딥링크',
      name: '구 스킴 momo:// 로 발급된 링크도 계속 열린다 (B13 회귀 가드)',
      run: () => {
        const a = check(
          parseJoinDeepLink('momo://join?server=https%3A%2F%2Fapi.example.com&code=Ab3-_x'),
          { serverUrl: 'https://api.example.com', inviteCode: 'Ab3-_x' },
        );
        if (!a.ok) {
          return a;
        }
        return check(parseJoinDeepLink('momo:join?code=abc'), {
          serverUrl: '',
          inviteCode: 'abc',
        });
      },
    },

    // ---- describe("browser deep-link fallback") ----
    {
      group: '브라우저 폴백',
      name: '페이지 쿼리에서 server 와 code 를 읽는다',
      run: () => check(
        parseJoinFromPageUrl(
          'https://momo.example.com/?server=https%3A%2F%2Fapi.example.com&code=abc',
        ),
        { serverUrl: 'https://api.example.com', inviteCode: 'abc' },
      ),
    },
    {
      group: '브라우저 폴백',
      name: '?join= 으로 통째로 넘어온 oort:// 링크를 푼다',
      run: () => check(
        parseJoinFromPageUrl(
          'https://momo.example.com/?join=oort%3A%2F%2Fjoin%3Fserver%3Dhttps%253A%252F%252Fapi.example.com%26code%3Dabc',
        ),
        { serverUrl: 'https://api.example.com', inviteCode: 'abc' },
      ),
    },
    {
      group: '브라우저 폴백',
      name: '라우터가 남긴 해시 쿼리를 읽는다',
      run: () => check(parseJoinFromPageUrl('https://momo.example.com/#/?code=abc'), {
        serverUrl: '',
        inviteCode: 'abc',
      }),
    },
    {
      group: '브라우저 폴백',
      name: '평범한 페이지 URL 에는 끼어들지 않는다',
      run: () => {
        const rows: Array<[string, unknown]> = [
          ['?stress=40', parseJoinFromPageUrl('http://127.0.0.1:5173/?stress=40')],
          ['#/c/abc', parseJoinFromPageUrl('http://127.0.0.1:5173/#/c/abc')],
        ];
        const bad = rows.filter(([, v]) => v !== null);
        return bad.length === 0
          ? { ok: true }
          : {
              ok: false,
              detail: bad.map(([k, v]) => `${k} → ${show(v)} (null 이어야 함)`).join(' · '),
            };
      },
    },
    {
      group: '브라우저 폴백',
      name: '초대 파라미터만 떼고 나머지는 그대로 둔다',
      run: () => check(
        urlWithoutJoinParams(
          'https://momo.example.com/?stress=40&code=secret&server=https%3A%2F%2Fapi.example.com#/inbox?code=secret&tab=all',
        ),
        'https://momo.example.com/?stress=40#/inbox?tab=all',
      ),
    },
  ];

  return defs.map(d => {
    try {
      const r = d.run();
      return { name: d.name, group: d.group, ok: r.ok, detail: r.detail };
    } catch (e) {
      return {
        name: d.name,
        group: d.group,
        ok: false,
        detail: `예외: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  });
}

export function tally(results: CaseResult[]): { passed: number; failed: number; total: number } {
  const passed = results.filter(r => r.ok).length;
  return { passed, failed: results.length - passed, total: results.length };
}
