import {PULL_TRIGGER, pullProgress, refreshFailed} from '../src/design/pullRefresh';

// =============================================================================
// 당겨서 새로고침의 순수 판정 (#3962): 거리 → 진행도, 재조회 결과가 실패인가.
// 화면·햅틱·타이머 없이 값만 잰다.
//
// red proof (이 파일이 지키는 것):
//   - `pullProgress` 의 clamp 를 지우면 → 「1 을 넘지 않는다」가 붉다
//   - `refreshFailed` 가 배열을 안 훑으면 → 「묶음 재조회」가 붉다
//   - `PULL_TRIGGER` 를 잰 값이 아닌 것으로 바꾸면 → 「잰 값」이 붉다
// =============================================================================

describe('진행도', () => {
  it('임계는 잰 값이다: iPhone 16e 시뮬레이터(iOS 26.5)에서 표준 컨트롤이 onRefresh 를 부른 오프셋 -147.3', () => {
    // 같은 당김을 세 번 되풀이해 세 번 모두 같았다. 바꾸려면 다시 재고 PR 본문의 측정도 고친다.
    expect(PULL_TRIGGER).toBe(147);
  });

  it('넘치지 않으면 0, 임계에서 1, 그 너머로도 1 이다', () => {
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(24)).toBe(0); // 아래로 스크롤(양수)은 당김이 아니다
    expect(pullProgress(Number.NaN)).toBe(0);
    expect(pullProgress(-PULL_TRIGGER / 2)).toBeCloseTo(0.5, 10);
    expect(pullProgress(-PULL_TRIGGER)).toBe(1);
    expect(pullProgress(-PULL_TRIGGER * 3)).toBe(1);
  });

  it('거리에 비례한다', () => {
    for (const f of [0.1, 0.25, 0.75]) {
      expect(pullProgress(-PULL_TRIGGER * f)).toBeCloseTo(f, 10);
    }
  });
});

describe('재조회 결과가 실패인가', () => {
  it('결과를 모르면(void) 실패라고 단정하지 않는다', () => {
    expect(refreshFailed(undefined)).toBe(false);
    expect(refreshFailed(null)).toBe(false);
    expect(refreshFailed('x')).toBe(false);
    expect(refreshFailed(3)).toBe(false);
  });

  it('react-query 결과의 오류 상태를 실패로 본다 (refetch 는 실패해도 던지지 않는다)', () => {
    expect(refreshFailed({isError: true})).toBe(true);
    expect(refreshFailed({status: 'error'})).toBe(true);
    expect(refreshFailed({isError: false, status: 'success'})).toBe(false);
    expect(refreshFailed({})).toBe(false);
  });

  it('묶음 재조회(Promise.all 의 배열)는 하나라도 오류면 실패다', () => {
    expect(refreshFailed([{status: 'success'}, {status: 'success'}])).toBe(false);
    expect(refreshFailed([{status: 'success'}, {isError: true}])).toBe(true);
    expect(refreshFailed([[{status: 'success'}], [{status: 'error'}]])).toBe(true);
    expect(refreshFailed([])).toBe(false);
  });
});
