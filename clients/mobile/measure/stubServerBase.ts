import {useEffect, useState} from 'react';
import {NON_SECRET_KEYS, nonSecretStore} from '../src/storage/kv';
import {getServerBase, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 측정 표면이 **이 프로세스만** 스텁 서버로 향하게 하는 곳 (#5313).
//
// ## 무슨 일이 있었나 (검증 5b·5c)
//
// 사진·승인 카드·파일 카드 표면은 앱의 내려받기 코드를 그대로 돌리려고 서버 주소를 스텁(`127.0.0.1:<포트>`)으로 가리켰다. 그런데
// `setServerBase` 는 **저장소(MMKV `momo.mobile.server.v1`)에 쓴다.** 정리는 표면이 내려갈 때(언마운트) 한 줄이었는데,
// 측정 구동기는 `simctl terminate` 로 앱을 끝낸다 — 언마운트가 돌지 않는다. 죽은 스텁 주소가 저장소에 남았고, 다음 **일반 실행**은 그 주소로
// 세션을 되살리려다 부트 화면 「서버에 닿지 못했어요」에서 멈췄다(제품 결함이 아니라 시험 오염). `steady.tsx` 의 `seedSteady()` 는 정리가 아예 없었다.
//
// ## 고침: 저장소에 스텁이 **남지 않게** 한다 — 정리에 기대지 않는다
//
// `pinServerBase` 는 처음 저장된 값을 적어 두고, `setServerBase`(메모리 값·구독자 알림을 바꾼다)를 부른 **바로 다음 줄에서** 저장소를 처음 값으로
// 되돌린다. 메모리(`apiBase()`)는 스텁을 가리키고 저장소는 처음 그대로다. 같은 틱의 동기 쓰기 두 번이라 그 사이에 프로세스가 끝나는 일은 없다 —
// 언제 어떻게 끝나든(terminate · 크래시 · 언마운트 없는 종료) 다음 실행이 읽는 값은 하네스를 돌리기 전 값이다.
// `unpinServerBase` 는 같은 프로세스 안에서 메모리 값까지 처음으로 되돌린다(언마운트 · 표면 교체).
//
// 이 파일 밖의 측정 코드는 `setServerBase` 를 직접 부르지 않는다 — 부르면 스텁이 저장소에 남는다(`__tests__/measureServerBase.test.ts` 가 센다).
// =============================================================================

interface Pinned {
  /** 저장소의 처음 값 **그대로**(검증 전, 없으면 undefined). 되돌릴 때 이 글자를 쓴다. */
  raw: string | undefined;
  /** 메모리의 처음 값(검증을 지난 것, 없으면 null). */
  base: string | null;
}

let pinned: Pinned | null = null;

/** 저장소의 서버 주소 칸을 `raw` 로 만든다(없으면 지운다). 저장소를 못 쓰면 되돌릴 것도 없다 — 계측이 앱을 죽이지 않는다. */
function putRaw(raw: string | undefined): void {
  try {
    const store = nonSecretStore();
    if (raw === undefined) store.remove(NON_SECRET_KEYS.serverBase);
    else store.set(NON_SECRET_KEYS.serverBase, raw);
  } catch {
    // 저장소가 없으면 스텁도 쓰이지 않았다.
  }
}

function readRaw(): string | undefined {
  try {
    return nonSecretStore().getString(NON_SECRET_KEYS.serverBase);
  } catch {
    return undefined;
  }
}

/**
 * 이 프로세스의 서버 주소를 `base` 로 한다. 저장소에는 아무것도 남기지 않는다. 여러 번 불러도 된다 — 처음 값은 **첫 호출에서만** 적는다
 * (두 번째 호출이 스텁을 「처음 값」으로 적는 일이 없다).
 */
export function pinServerBase(base: string): void {
  if (pinned === null) pinned = {raw: readRaw(), base: getServerBase()};
  setServerBase(base);
  putRaw(pinned.raw);
}

/** 메모리와 저장소를 `pinServerBase` 를 부르기 전 값으로 되돌린다. 건 적이 없으면 아무 일도 하지 않는다. */
export function unpinServerBase(): void {
  if (pinned === null) return;
  const {raw, base} = pinned;
  pinned = null;
  setServerBase(base);
  putRaw(raw);
}

/**
 * 표면 컴포넌트용: 첫 렌더 **전에** 한 번 건다(사진 타일 같은 부품은 마운트 직후 내려받기를 시작한다). `null` 이면 걸지 않는다(스텁이 필요 없는 장면).
 * 내려갈 때 메모리 값을 되돌리고, 빠른 새로고침이 효과만 다시 돌려도 다시 건다.
 */
export function usePinnedServerBase(base: string | null): void {
  useState(() => {
    if (base !== null) pinServerBase(base);
    return null;
  });
  useEffect(() => {
    if (base === null) return undefined;
    pinServerBase(base);
    return unpinServerBase;
  }, [base]);
}
