/**
 * 게이트 1 판정 로직을 **2026-08-02 실기기 실측 데이터로** 못박는다.
 *
 * 왜 이 파일이 있나: 1차 판정에서 하네스가 A·B·C 를 FAIL 로 찍었는데, 최종값은
 * 셋 다 "안녕하세요" 로 정확히 일치했다. 즉 **판정 로직이 틀렸지 RN 이 틀린 게
 * 아니었다.** 옛 불변식이 한글의 받침 이동을 몰라서 정상 전이를 위반으로 셌다.
 *
 * 아래 전이들은 전부 성재의 iPhone(iOS 26.5.1)에서 실제로 찍힌 값이다. 손으로
 * 지어낸 예가 아니다. 판정 로직을 다시 조이면 이 테스트가 빨개진다.
 */
import {classify, summarize, verdictOf} from '../src/gate1_ime/composition';

const t = (from: string, to: string) => classify(from, to, 1, 0);

describe('한글 받침 이동은 위반이 아니다 (표준 쿼티 실측)', () => {
  // 안녕핫 에서 ㅔ 를 누르면 받침 ㅅ 이 다음 음절 초성으로 옮겨간다.
  it.each([
    ['안녕핫', '안녕하세'],
    ['안녕하셍', '안녕하세요'],
    ['안', '안ㄴ'],
    ['안ㄴ', '안녀'],
  ])('%s → %s 는 정상', (from, to) => {
    expect(t(from, to).suspicious).toBe(false);
  });
});

describe('10키(천지인) 의 다글자 조합 꼬리도 위반이 아니다 (실측)', () => {
  it.each([
    ['안녕핫', '안녕하ㅅ·'], // 꼬리가 2글자로 벌어짐
    ['안녕하ㅅ·', '안녕하서'], // 꼬리 2글자가 한 음절로 접힘 (dropped 2)
    ['안녕하셍', '안녕하세ㅇ·'],
    ['안녕하세ㅇ：', '안녕하세요'],
  ])('%s → %s 는 정상', (from, to) => {
    expect(t(from, to).suspicious).toBe(false);
  });
});

describe('진짜 파손은 여전히 잡는다', () => {
  it('확정된 앞부분이 사라지면 위반', () => {
    // 조합 리셋 후 재쌓임(RN #48497 계열)이 이런 모양으로 나타난다.
    expect(t('안녕하세요', '안녀').suspicious).toBe(true);
  });

  it('꼬리 밖까지 날아가면 위반', () => {
    expect(t('안녕하세', '안').suspicious).toBe(true);
  });
});

describe('주 판정은 finalMatches 다 — 위반 0건이 정상을 뜻하지 않는다', () => {
  it('비동기 setState 케이스: 자모가 안 합쳐져도 위반은 0건이었다 (실측 D)', () => {
    // 실측: 표준에서 최종값이 ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ 로 남았다.
    // 매 전이가 (-0/+1) 이라 되돌아간 것이 없어 위반은 0건이다.
    const seq = ['ㅇ', 'ㅇㅏ', 'ㅇㅏㄴ', 'ㅇㅏㄴㄴ', 'ㅇㅏㄴㄴㅕ'];
    const transitions = seq.map((to, i) =>
      classify(i === 0 ? '' : seq[i - 1], to, i + 1, 0),
    );
    const r = summarize(transitions, '안녕');
    expect(r.suspiciousCount).toBe(0);
    expect(r.finalMatches).toBe(false);
    expect(verdictOf(r)).toBe('FAIL'); // 위반 0건이어도 FAIL 이어야 한다
  });

  it('정상 입력은 PASS', () => {
    const seq = ['ㅇ', '아', '안', '안ㄴ', '안녀', '안녕'];
    const transitions = seq.map((to, i) =>
      classify(i === 0 ? '' : seq[i - 1], to, i + 1, 0),
    );
    const r = summarize(transitions, '안녕');
    expect(r.suspiciousCount).toBe(0);
    expect(verdictOf(r)).toBe('PASS');
  });
});
