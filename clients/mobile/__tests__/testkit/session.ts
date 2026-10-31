import type {LoginResponse, Member} from '@momo/core/lib/api';

import {__resetSessionStore, sessionPort} from '../../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../../src/storage/serverBase';
import {BASE_URL} from './ids';
import {loginBody} from '@momo/core/testkit/session';
export {loginBody, selfMember} from '@momo/core/testkit/session';

/**
 * 세션·저장소를 시험에서 만지는 길 하나.
 *
 * `jest.setup.js` 가 `react-native-mmkv`·`react-native-keychain` 을 메모리 대역으로 바꿔 두고,
 * 그 안쪽(`__store`·`__items`)을 노출한다. 「토큰이 키체인에만 들어가고 MMKV 에는 없다」 같은
 * 단정은 이 안쪽을 직접 봐야 하므로, 엿보는 길을 파일마다 다시 만들지 않고 여기서 한 번만 낸다
 * (MMKV 쪽만 47개 파일이 같은 세 줄을 복제했다).
 */
export const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

export const keychainItems = (
  jest.requireMock('react-native-keychain') as {
    __items: Map<string, {username: string; password: string; service: string}>;
  }
).__items;

/**
 * 저장소·세션·서버 주소 캐시를 빈 상태로. `beforeEach` 첫머리에 둔다. 기존 시험이 네 줄로 하던
 * 것과 같은 순서다: MMKV 를 비우고, 세션 저장소를 되돌리고, 서버 주소 캐시를 되돌린다.
 */
export function resetSession(): void {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
}

/** 서버 주소를 정하고 로그인한 상태로 만든다. `resetSession()` 뒤에 부른다. */
export function signIn(who: Member, base: string = BASE_URL): LoginResponse {
  const body = loginBody(who);
  setServerBase(base);
  sessionPort.applyLogin(body);
  return body;
}
