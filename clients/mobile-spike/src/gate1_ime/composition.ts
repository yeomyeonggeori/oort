/**
 * 게이트 1 — 한글 조합 불변식 (순수 로직, 기기 없이 단위테스트 가능)
 *
 * 왜 이런 검사를 하나:
 * RN #48497 / #55257 계열의 IME 파손은 "조합이 리셋되어 앞 글자가 중복되거나
 * 자모가 풀려서 다시 쌓인다"는 형태로 나타난다. 사람이 눈으로 보면 "글자가 이상하다"
 * 지만, 기계가 보면 **한 번의 keystroke 에서 이전 값의 마지막 글자보다 더 많은 것이
 * 사라지거나 더 많은 것이 생긴다**는 성질로 잡힌다.
 *
 * 한글 IME 의 정상 동작(2026-08-02 실기기 실측으로 정정):
 *   - 조합 중인 꼬리는 **최대 2글자**다(10키에서 `ㅅ·` 처럼 보였다가 한 음절로 접힌다).
 *   - keystroke 하나가 **두 글자를 만드는 것은 정상**이다 — 받침이 다음 음절 초성으로
 *     옮겨가기 때문이다(`안녕핫` + ㅔ → `안녕하세`).
 *   - 따라서 진짜 불변식은 "확정된 앞부분은 되돌아가지 않는다" 하나뿐이다.
 *
 * 이 불변식을 깨는 전이 = `suspicious`. **단 이것은 보조 신호이고 주 판정은
 * `finalMatches` 다** — 실측에서 비동기 setState 케이스는 위반 0건이면서 최종값이
 * 완전히 깨졌다(자모가 아예 안 합쳐져 되돌아갈 것이 없었다).
 *
 * 한계(정직하게): 붙여넣기·자동수정·예측변환은 정상적으로도 이 불변식을 깬다.
 * 그래서 하네스는 "지정된 문자열을 손으로 타이핑"하는 조작만 시킨다.
 */

export type Transition = {
  /** 몇 번째 onChangeText 인가 */
  i: number;
  from: string;
  to: string;
  /** 공통 접두 길이 */
  common: number;
  /** 이전 값에서 사라진 글자 수 */
  dropped: number;
  /** 새 값에 추가된 글자 수 */
  added: number;
  suspicious: boolean;
  /** 직전 이벤트로부터 경과 ms */
  dtMs: number;
};

export function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) {
    i++;
  }
  return i;
}

/**
 * 한 번의 값 변화가 한글 조합으로 설명 가능한가.
 *
 * **[2026-08-02 실기기 실측으로 정의를 고쳤다 — 옛 정의는 오탐이었다.]**
 *
 * 옛 정의(`dropped >= 2 || added >= 2`)는 한글을 몰랐다. 실측에서 이렇게 찍혔다:
 *
 *   안녕핫 → 안녕하세   (dropped 1 / added 2)  ← 옛 정의는 "위반"
 *   안녕하셍 → 안녕하세요 (dropped 1 / added 2)  ← 옛 정의는 "위반"
 *
 * 둘 다 **받침 이동**이다. `안녕핫` 에서 ㅔ 를 누르면 받침 ㅅ 이 다음 음절 초성으로
 * 옮겨가 `안녕하세` 가 된다 — 한글 입력에서 매번 일어나는 정상 동작이고, 한 번의
 * keystroke 가 두 글자를 만드는 것이 당연하다. 그래서 `added` 조건은 **버린다**.
 *
 * 10키(천지인) 에서는 조합 중 영역이 한 글자가 아니다:
 *
 *   안녕핫 → 안녕하ㅅ·   (dropped 1 / added 3)
 *   안녕하ㅅ· → 안녕하서 (dropped 2 / added 1)
 *
 * 조합 중인 꼬리가 `ㅅ·` 처럼 2글자로 보였다가 한 음절로 접힌다. 그러므로
 * "마지막 한 글자만 바뀐다"는 전제도 틀렸다. 꼬리는 **최대 2글자**까지 다시 쓰인다.
 *
 * 남는 진짜 불변식: **확정된 앞부분은 되돌아가지 않는다.** 조합 꼬리 밖의 텍스트가
 * 사라지면 그것이 파손이다(RN #48497 계열이 보고하는 "조합 리셋 후 중복/재쌓임").
 *   → `dropped > 2` 만 의심으로 센다.
 *
 * 그리고 이 신호는 **보조**다. 주 판정은 언제나 `finalMatches` 다 —
 * 실측에서 D(비동기 setState)는 위반 0건이면서 최종값이 완전히 깨졌다.
 * 자모가 아예 안 합쳐지니 되돌아갈 것도 없었던 것이다. 위반 수가 0이라는 말이
 * "정상"을 뜻하지 않는다.
 */
export function classify(from: string, to: string, i: number, dtMs: number): Transition {
  const common = commonPrefixLength(from, to);
  const dropped = from.length - common;
  const added = to.length - common;
  return {
    i,
    from,
    to,
    common,
    dropped,
    added,
    // 조합 꼬리(최대 2글자) 밖이 사라지면 파손. 글자가 늘어나는 것은 받침 이동으로
    // 언제나 설명되므로 세지 않는다.
    suspicious: dropped > 2,
    dtMs,
  };
}

export type CaseResult = {
  /** 최종 값이 지시한 목표 문자열과 정확히 일치하는가 — 가장 강한 기계 판정 */
  finalMatches: boolean;
  finalValue: string;
  target: string;
  keystrokeCount: number;
  suspiciousCount: number;
  transitions: Transition[];
};

export function summarize(
  transitions: Transition[],
  target: string,
): CaseResult {
  const finalValue =
    transitions.length > 0 ? transitions[transitions.length - 1].to : '';
  return {
    finalMatches: finalValue === target,
    finalValue,
    target,
    keystrokeCount: transitions.length,
    suspiciousCount: transitions.filter(t => t.suspicious).length,
    transitions,
  };
}

/**
 * 기계 판정.
 * PASS 조건: 최종 값이 목표와 일치하고, 의심 전이가 0건.
 * 둘 중 하나라도 어긋나면 FAIL — "대체로 맞다"는 없다.
 */
export function verdictOf(r: CaseResult): 'PASS' | 'FAIL' | 'PENDING' {
  if (r.keystrokeCount === 0) {
    return 'PENDING';
  }
  return r.finalMatches && r.suspiciousCount === 0 ? 'PASS' : 'FAIL';
}
