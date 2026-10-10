import {createPhoneSpawnPort} from '../features/work/ask/phoneSpawnPort';
import {registerSpawnPort} from '../features/work/ask/spawnPort';

/**
 * 내 맥으로 보내는 길을 부팅에서 한 번 연다 (#3638, #3597 후속). 이 한 줄이 「내 맥에 물어보기」
 * (T6b)와 AI 시트의 내 도구·개인 에이전트 구획(N10)의 게이트다. 신원·서명 키는 로그인 전이라
 * 읽지 않는다 — 포트가 보내는 순간에 읽는다.
 */
export function bootSpawnPort(): void {
  registerSpawnPort(createPhoneSpawnPort());
}
