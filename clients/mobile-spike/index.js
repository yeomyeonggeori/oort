/**
 * @format
 *
 * 스파이크 하네스 진입점.
 *
 * URL 폴리필은 반드시 App 로드보다 먼저 설치되어야 한다(게이트 2).
 * `react-native-url-polyfill/auto` 가 globalThis.URL / URLSearchParams 를 덮어쓴다.
 * 이 import 를 지우면 RN 코어의 정규식 기반 URL 이 쓰이고, 커스텀 스킴(oort://)이
 * 파싱되지 않는다 — 그것이 게이트 2의 판정 대상이다.
 */
import 'react-native-url-polyfill/auto';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
