import {Settings} from 'react-native';
import type {ColorScheme} from '../src/design/theme';

/**
 * Is this process a measurement run?
 *
 * Answered from the LAUNCH ARGUMENT `-momoMeasure YES`, which iOS places in
 * NSUserDefaults' argument domain and React Native's `Settings` module reads
 * back. Nothing persists: the next launch without the argument is the app.
 *
 * `__DEV__` gates it as well, so a release build cannot be talked into the
 * harness by anyone who can pass it arguments.
 */
export type MeasureMode =
  | {kind: 'measure'}
  | {kind: 'states'}
  /** One of goal RN-C5's action/search surfaces — see `measure/surfaces.tsx`. */
  | {kind: 'surface'; name: string; scheme: ColorScheme}
  | null;

/**
 * 사진의 스킴 (U2). **언제나 못 박는다** — 시뮬레이터의 시스템 설정을 따라가면
 * 같은 명령이 기기 상태에 따라 다른 색을 찍고, 그 사진은 증거가 아니라 일화가 된다.
 * 기본은 `dark` 라서 이 배치 이전의 캡처 명령은 전부 전과 같은 그림을 낸다.
 */
const SCHEME_PREFIX = 'light-';

/**
 * Anything that is neither `YES` nor `STATES` names a SURFACE. Adding a
 * screenshot therefore costs a case in `surfaces.tsx` and nothing here, which is
 * deliberate: the list of screens worth reviewing grows faster than this
 * function should.
 *
 * 이름 앞의 `light-` 는 표면이 아니라 **스킴**을 고른다 (U2):
 * `-momoMeasure LIGHT-ROW` 는 `row` 를 라이트로 찍는다. 접두사를 쓰는 이유는
 * 인자를 하나 더 늘리지 않기 위해서다 — 표면 목록은 계속 자라고, 두 축이 한 낱말에
 * 들어가면 캡처 스크립트의 반복문이 그대로 두 배가 된다.
 */
export function measureMode(): MeasureMode {
  if (!__DEV__) return null;
  const value = Settings.get('momoMeasure');
  if (value === 'YES' || value === true || value === 1 || value === '1') {
    return {kind: 'measure'};
  }
  if (typeof value !== 'string' || value === '') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'states') return {kind: 'states'};
  const light = normalized.startsWith(SCHEME_PREFIX);
  return {
    kind: 'surface',
    name: light ? normalized.slice(SCHEME_PREFIX.length) : normalized,
    scheme: light ? 'light' : 'dark',
  };
}
