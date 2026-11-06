import fs from 'fs';
import path from 'path';

import {pinServerBase, unpinServerBase} from '../measure/stubServerBase';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetServerBaseCache, apiBase} from '../src/storage/serverBase';

// =============================================================================
// #5313 — 측정 하네스가 앱의 저장 서버 주소(MMKV `momo.mobile.server.v1`)를 스텁으로 덮고 되돌리지 않아, 하네스 뒤의 일반 실행이 부트 화면
// 「서버에 닿지 못했어요」에 멈췄다(검증 5b·5c). 구동기는 `simctl terminate` 로 앱을 끝내므로 언마운트 정리는 돌지 않는다 — 그래서 이 시험은
// **정리를 부르지 않고** 「프로세스가 끝난 뒤 다음 실행이 읽는 값」(캐시를 비운 뒤의 `apiBase()`)을 잰다.
// =============================================================================

const KEY = NON_SECRET_KEYS.serverBase;
const REAL = 'https://real.example.com';
const STUB = 'http://127.0.0.1:18993';

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

let store = memoryStore();

beforeEach(() => {
  store = memoryStore();
  __setNonSecretStore(store);
  __resetServerBaseCache();
});

afterEach(() => {
  unpinServerBase();
  __setNonSecretStore(null);
  __resetServerBaseCache();
});

describe('측정 표면의 스텁 서버 주소 (#5313)', () => {
  it('프로세스 안에서는 스텁을 쓰지만 저장소는 처음 값 그대로여서, 정리 없이 끝난 다음 실행은 원래 주소를 읽는다', () => {
    store.set(KEY, REAL);
    __resetServerBaseCache();

    pinServerBase(STUB);
    expect(apiBase()).toBe(STUB);
    expect(store.getString(KEY)).toBe(REAL);

    // 같은 표면이 다시 걸어도(첫 렌더 + 효과) 「처음 값」을 스텁으로 덮어쓰지 않는다.
    pinServerBase(STUB);
    expect(store.getString(KEY)).toBe(REAL);

    // `simctl terminate`: 언마운트 정리는 돌지 않고 메모리만 사라진다. 다음 실행은 저장소에서 읽는다.
    __resetServerBaseCache();
    expect(apiBase()).toBe(REAL);

    // 저장된 주소가 아예 없던 기기에도 스텁이 남지 않는다(남으면 연결 화면 대신 죽은 스텁으로 간다).
    unpinServerBase();
    store.remove(KEY);
    __resetServerBaseCache();
    pinServerBase(STUB);
    expect(apiBase()).toBe(STUB);
    expect(store.getString(KEY)).toBeUndefined();
    __resetServerBaseCache();
    expect(apiBase()).toBe('');

    // 같은 프로세스 안의 정리(언마운트)는 메모리까지 처음 값으로 되돌린다.
    unpinServerBase();
    store.set(KEY, REAL);
    __resetServerBaseCache();
    pinServerBase(STUB);
    unpinServerBase();
    expect(apiBase()).toBe(REAL);
    expect(store.getString(KEY)).toBe(REAL);
  });

  it('측정 코드는 setServerBase 를 직접 부르지 않는다 — 부르면 스텁이 저장소에 남는다', () => {
    const dir = path.join(__dirname, '..', 'measure');
    const offenders = fs
      .readdirSync(dir)
      .filter(name => /\.(tsx?|mjs|cjs)$/.test(name) && name !== 'stubServerBase.ts')
      .filter(name => /\bsetServerBase\s*\(/.test(fs.readFileSync(path.join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
