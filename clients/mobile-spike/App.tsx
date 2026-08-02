/**
 * RN 스파이크 하네스 — 게이트 선택 셸.
 *
 * **이 앱은 버려진다.** ADR-0137 D6 의 게이트 판정을 받아 내기 위한 계측 장치일 뿐,
 * momo 모바일 앱의 시작점이 아니다. 재사용하려고 손보지 마라.
 *
 * 담당 게이트: 1(한글 IME) · 2(URL/딥링크) · 3(centrifuge-js) · 5(타임라인 리스트)
 * 게이트 4(푸시/NSE)와 6(Android)은 다른 배치 소관이다.
 *
 * @format
 */
import React, {useState} from 'react';
import {StatusBar, Text, TouchableOpacity, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import ImeGate from './src/gate1_ime/ImeGate';
import UrlGate from './src/gate2_url/UrlGate';
import RealtimeGate from './src/gate3_realtime/RealtimeGate';
import ListGate from './src/gate5_list/ListGate';
import {C, s} from './src/ui';

type Tab = 'g1' | 'g2' | 'g3' | 'g5';

const TABS: Array<{id: Tab; label: string}> = [
  {id: 'g1', label: '1 · IME'},
  {id: 'g2', label: '2 · URL'},
  {id: 'g3', label: '3 · 실시간'},
  {id: 'g5', label: '5 · 리스트'},
];

function App() {
  const [tab, setTab] = useState<Tab>('g1');

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={s.screen} edges={['top']}>
        <View
          style={{
            flexDirection: 'row',
            borderBottomWidth: 1,
            borderBottomColor: C.line,
            backgroundColor: C.card,
          }}
        >
          {TABS.map(t => (
            <TouchableOpacity
              key={t.id}
              onPress={() => setTab(t.id)}
              style={{
                flex: 1,
                paddingVertical: 12,
                alignItems: 'center',
                borderBottomWidth: 2,
                borderBottomColor: tab === t.id ? C.accent : 'transparent',
              }}
            >
              <Text
                style={{
                  color: tab === t.id ? C.text : C.dim,
                  fontWeight: tab === t.id ? '700' : '500',
                  fontSize: 13,
                }}
              >
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={{flex: 1}}>
          {tab === 'g1' ? <ImeGate /> : null}
          {tab === 'g2' ? <UrlGate /> : null}
          {tab === 'g3' ? <RealtimeGate /> : null}
          {tab === 'g5' ? <ListGate /> : null}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

export default App;
