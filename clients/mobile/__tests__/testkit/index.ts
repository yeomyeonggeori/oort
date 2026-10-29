/**
 * 폰 시험의 공용 도구(testkit). 새 시험은 파일 안에 도구를 다시 선언하지 말고 여기서 가져온다.
 *
 *   import {member, mount, cleanupMounts, createCopy, control} from './testkit';
 *
 * `createCopy(copyModule)`의 키로 문구를 읽고 역할·레이블 조회에 넘긴다. 픽스처·카탈로그·
 * mount 수명 관리·flush 순서는 `@momo/core/testkit`을 웹과 함께 쓴다.
 *
 * 무엇이 여기 있나 — 폰 시험 파일들이 각자 다시 선언하던 것 중 가장 많은 것들(2026-10 감사 기준
 * 같은 이름을 `member` 59·`mmkvStore` 47·`jsonResponse` 46·`installFetch` 46·`message` 43개 파일이 따로 선언):
 *
 *   ids.ts       고정 id·주소·기준 시각
 *   fixtures.ts  `member`(로스터 한 명), `message`(글 메시지 한 건)
 *   fetch.ts     `jsonResponse`, `installFetch`(뼈대: 라우트 하나, 모르는 요청은 던진다), `callsTo`
 *   session.ts   `mmkvStore`·`keychainItems`(저장소 엿보기), `resetSession`, `signIn`, `selfMember`
 *   render.tsx   `makeQueryClient`, `renderWithQuery`, `flat`(스타일 펴기), `settle`·`flush`(비우기),
 *                `drainRender`(describe 로 감싼 `afterEach` 가 RNTL 정리보다 먼저 돌 때의 순서 보정)
 *   query.ts     역할·레이블로 찾기(`control`·`labelled`…) — 한국어 문장을 시험에 박지 않는다
 *   catalog.ts   문구 카탈로그 검사의 재료(`blankCopy`·`missingKeys`·`copyModules`)
 *
 * `mount`는 공용 코어의 수명 관리와 폰 renderer를 연결한다. 화면마다 다른 라우트 표·props는
 * 그 화면 시험 파일에 두고, 위 도구를 조립한다. 시나리오 대역(`fixtures/`)과도 겹치지 않는다 —
 * 가짜 시계만 한 곳에서 집을 수 있게 아래에서 다시 내보낸다.
 *
 * 이 도구가 받치는 시험 쓰기 규칙(2026-10-28 owner 결정): 새 시험은 같은 행동을 보는 기존 파일에
 * 더하고, 파일 이름은 대상(컴포넌트·모듈) 기준이며 이슈·PR 번호는 `describe`·주석에 둔다. 화면
 * 문구는 한국어 문장이 아니라 역할·레이블(`query.ts`)로 찾는다.
 */
export {BASE_MS, BASE_URL, OTHER_ID, SELF_ID, WS_ID} from './ids';
export {member, message} from './fixtures';
export {callsTo, installFetch, jsonResponse} from './fetch';
export type {FetchRoute} from './fetch';
export {keychainItems, loginBody, mmkvStore, resetSession, selfMember, signIn} from './session';
export {cleanupMounts, mount, drainRender, flat, flush, makeQueryClient, renderWithQuery, settle} from './render';
export {control, controls, labelled, maybeControl, pressControl, typeInto} from './query';
export type {ControlNode, Copy, Role} from './query';
export {blankCopy, copyModules, copyStringCount, missingKeys} from './catalog';
export {installAppClock, installTimersOnlyClock, SHELL_WAIT_TEST_TIMEOUT_MS} from '../fixtures/fakeClock';
export {createCopy} from '@momo/core/testkit/copy';
