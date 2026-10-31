import fs from 'fs';
import path from 'path';
import {AppState} from 'react-native';

import {__resetHapticClockForTests, getHapticMode, haptics} from '../src/lib/haptics';

// =============================================================================
// #4936 (owner 10-31): 햅틱은 풍부 하나로 두고 고르는 옵션을 없앤다.
//
// 설정의 햅틱 줄 셋과 안내 문장이 없어졌고, 앱 햅틱은 늘 「풍부」다. 이미 「기본」·「끔」을 고른 사람도 풍부로 울린다.
// 예전 판은 그 선택을 `momo.mobile.haptics.v1` 에 적었다 — 지금 앱은 그 키를 읽지 않는다(`NON_SECRET_KEYS.hapticMode` 는 v2).
// 기기 설정의 「시스템 햅틱」을 끄면 꺼지는 것은 iOS 피드백 생성기가 지키는 그대로라 여기서 재지 않는다.
// 실제 진동의 세기는 실기기에서만 잰다(PR 본문 「미검증」).
// =============================================================================

const haptic = jest.requireMock('expo-haptics') as {__calls: string[]};
const store = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
/** 예전 판이 사람의 선택(`basic`·`off`)을 적던 키. 지금 앱은 읽지 않는다. */
const LEGACY_KEY = 'momo.mobile.haptics.v1';

beforeEach(() => {
  store.clear();
  haptic.__calls.length = 0;
  __resetHapticClockForTests();
  AppState.currentState = 'active';
});

describe('앱 햅틱은 늘 풍부다 (#4936)', () => {
  it('저장된 값이 없어도 풍부이고, 풍부에만 있는 사건이 울린다', () => {
    expect(getHapticMode()).toBe('rich');
    // `tabChanged` 는 풍부 단계의 사건이다 — 기본·끔이었다면 무음이다.
    haptics.event('tabChanged');
    expect(haptic.__calls).toEqual(['selection']);
  });

  it.each(['off', 'basic'])('예전 판이 저장한 「%s」도 풍부로 동작한다 — 풍부 사건이 울리고 앱 호출이 0회가 아니다', legacy => {
    store.set(LEGACY_KEY, legacy);
    expect(store.get(LEGACY_KEY)).toBe(legacy);
    expect(getHapticMode()).toBe('rich');
    haptics.event('tabChanged');
    // 끔이었다면 []이고, 기본이었다면 풍부 사건이라 []다. 풍부로 울릴 때만 이 한 번이 난다.
    expect(haptic.__calls).toEqual(['selection']);
  });

  it('앱 소스 어디도 햅틱 단계를 바꾸지 않는다 — `setHapticMode` 는 시험 이음새이고 앱은 부르지 않는다', () => {
    const root = path.join(__dirname, '../src');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) sources.push(full);
      }
    };
    walk(root);
    expect(sources.length).toBeGreaterThan(100);
    const home = path.join(root, 'lib/haptics.ts');
    expect(sources).toContain(home);
    const callers = sources
      .filter(file => file !== home)
      .filter(file => /\bsetHapticMode\b/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(root, file));
    expect(callers).toEqual([]);
  });
});
