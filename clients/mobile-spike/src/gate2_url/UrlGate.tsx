/**
 * 게이트 2 — URL 폴리필 + oort://join (Hermes 실행 확인)
 *
 * 이 화면은 **웹의 진짜 소스**를 import 한다(복사본 아님):
 *   @/features/auth/deepLink  → clients/web/src/features/auth/deepLink.ts
 *   @/lib/serverBase          → clients/web/src/lib/serverBase.ts
 * metro.config.js 의 resolveRequest 가 경로를 이어 주고, Vite 전용 `./env` 만
 * RN 상수 stub 으로 바뀐다.
 *
 * 기계 판정은 이미 Jest 에서 끝났다(__tests__/gate2_deeplink.test.ts,
 * URL 구현 3종 비교). 이 화면이 추가로 답하는 것은 하나다:
 *   **Hermes 런타임에서도 같은 답이 나오는가.**
 */
import React, {useMemo, useState} from 'react';
import {ScrollView, Text, TextInput, View} from 'react-native';

import {
  parseJoinDeepLink,
  parseJoinFromPageUrl,
  urlWithoutJoinParams,
} from '@/features/auth/deepLink';
import {normalizeServerUrl} from '@/lib/serverBase';

import {Badge, C, Card, KV, s, type Verdict} from '../ui';
import {runCases, tally} from './cases';

export default function UrlGate() {
  const [probe, setProbe] = useState(
    'oort://join?server=https%3A%2F%2Fapi.example.com&code=Ab3-_x',
  );

  const results = useMemo(
    () =>
      runCases({
        parseJoinDeepLink,
        parseJoinFromPageUrl,
        urlWithoutJoinParams,
        normalizeServerUrl,
      }),
    [],
  );
  const t = tally(results);
  const verdict: Verdict = t.failed === 0 ? 'PASS' : 'FAIL';

  const polyfillTag =
    (globalThis as any).REACT_NATIVE_URL_POLYFILL ?? '(설치 안 됨 — 코어 URL 사용 중)';

  const live = useMemo(() => {
    try {
      const parsed = parseJoinDeepLink(probe.trim());
      return parsed
        ? `serverUrl=${parsed.serverUrl || '(빈 값)'}  inviteCode=${
            parsed.inviteCode || '(빈 값)'
          }`
        : 'null (조인 링크가 아니거나 쓸 내용이 없음)';
    } catch (e) {
      return `예외: ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [probe]);

  const groups = Array.from(new Set(results.map(r => r.group)));

  return (
    <ScrollView style={s.screen} keyboardShouldPersistTaps="handled">
      <Card title="게이트 2 — URL 폴리필 + oort://join" verdict={verdict}>
        <Text style={s.cardSub}>
          웹의 deepLink.ts / serverBase.ts 를 무수정으로 import 해 Hermes 에서 실행한 결과다.
        </Text>
        <KV k="폴리필" v={String(polyfillTag)} />
        <KV
          k="케이스"
          v={`${t.passed}/${t.total} 통과 · ${t.failed} 실패`}
          tone={verdict}
        />
        <KV k="URL.canParse 존재" v={String(typeof (URL as any).canParse === 'function')} />
      </Card>

      <Card title="직접 넣어 보기">
        <TextInput
          style={s.input}
          value={probe}
          onChangeText={setProbe}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <KV k="parseJoinDeepLink" v={live} />
        <Text style={[s.dim, {marginTop: 6}]}>
          실제 딥링크 왕복(OS 가 앱을 깨우는 경로)은 Info.plist 에 스킴을 등록하고
          Safari 에서 링크를 눌러야 한다 — README 의 기기 절차 참조.
        </Text>
      </Card>

      {groups.map(g => (
        <Card key={g} title={g}>
          {results
            .filter(r => r.group === g)
            .map(r => (
              <View key={r.name} style={{flexDirection: 'row', marginTop: 6}}>
                <Badge verdict={r.ok ? 'PASS' : 'FAIL'} />
                <View style={{flex: 1, marginLeft: 8}}>
                  <Text style={{color: C.text, fontSize: 12}}>{r.name}</Text>
                  {r.detail ? (
                    <Text style={[s.mono, {color: C.fail}]}>{r.detail}</Text>
                  ) : null}
                </View>
              </View>
            ))}
        </Card>
      ))}
      <View style={{height: 60}} />
    </ScrollView>
  );
}
