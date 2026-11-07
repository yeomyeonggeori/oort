import {LogBox, Settings} from 'react-native';
import {sessionGateLaunch} from '../gate/root';
import {measureMode} from './root';

// =============================================================================
// 시험 도구가 켠 실행인가? (#5531)
//
// 디버그 빌드 아래쪽에 서는 LogBox 띠(「Open debugger to view warnings.」)는 시험에 쓸모가 없고 해롭다.
// Maestro 가 그 띠를 누르면(`subflows/dismiss-dev-logbox.yaml` 의 좌표 탭, 또는 그 자리를 지나는 다른 탭)
// RN 0.86 의 `NativeDevSettings.openDebugger()` 가 Metro 의 「디버거 열기」를 부르고, Metro 는 **독립 실행
// DevTools 앱**(`@react-native/debugger-shell`)을 띄운다. 그 창이 사람의 화면에 뜨고, 시험이 끝나도 남는다.
// `CHROME_PATH=/usr/bin/false`(#5083)는 Chrome 쪽 길만 막는다.
//
// 그래서 시험 도구가 켠 실행에서는 LogBox 알림을 처음부터 끈다. 띠가 없으면 누를 것도, 열릴 창도 없다
// (콘솔 출력은 그대로라 Metro 로그에는 경고가 계속 남는다. 끄는 것은 화면 알림뿐이다).
//
// 읽는 방법은 `measure/root.ts`·`gate/root.ts` 와 같다: iOS 가 `-key value` 실행 인자를 NSUserDefaults 의
// 인자 영역에 넣고 React Native 의 `Settings` 가 읽어 준다. 아무것도 저장되지 않아서, 인자 없이 다시 켠 앱은
// 평소 앱이다. 새 네이티브 의존은 없다.
//
//   -momoAutomation YES    Maestro `launchApp` 의 `arguments: {momoAutomation: "YES"}` 가 이렇게 넘어간다.
//                          값이 비었거나 NO·false·0·off 가 아니면 켜진 것으로 읽는다.
//   -momoMeasure …         계측 하네스(`measure/`)도 스크립트가 켜는 실행이라 같이 센다.
//   -momoSessionGate …     세션 게이트(`gate/`)도 마찬가지다.
//
// `__DEV__` 가 먼저 막는다: 출시 빌드는 누가 인자를 넘겨도 평소 앱이다(출시 빌드의 LogBox 는 원래 빈 껍데기다).
// 인자 없이 켠 개발 실행(사람이 `npm run ios` 로 켠 것)은 지금까지와 같다.
// =============================================================================

/** Maestro 흐름이 `launchApp` 에 싣는 실행 인자 이름. 흐름들이 이 이름을 쓰는지는 시험이 센다. */
export const AUTOMATION_ARGUMENT = 'momoAutomation';

const SWITCHED_OFF = new Set(['', '0', 'no', 'false', 'off']);

function switchedOn(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return !SWITCHED_OFF.has(value.trim().toLowerCase());
  return false;
}

/** 이 프로세스가 시험 도구(Maestro·계측 스크립트·세션 게이트)가 켠 디버그 실행인가. */
export function automationRun(): boolean {
  if (!__DEV__) return false;
  if (switchedOn(Settings.get(AUTOMATION_ARGUMENT))) return true;
  return measureMode() !== null || sessionGateLaunch() !== null;
}

/**
 * 시험 도구가 켠 실행이면 LogBox 알림을 끈다. 켠 경우에만 `LogBox.ignoreAllLogs(true)` 를 부른다.
 * 앱이 뜨는 가장 이른 자리(`index.js`)에서 한 번 부른다 — 경고가 처음 나기 전이면 띠는 서지 않는다.
 */
export function silenceLogBoxForAutomation(): boolean {
  if (!automationRun()) return false;
  LogBox.ignoreAllLogs(true);
  return true;
}
