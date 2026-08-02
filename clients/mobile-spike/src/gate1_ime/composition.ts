/**
 * 게이트 1 — 한글 조합 불변식 (순수 로직, 기기 없이 단위테스트 가능)
 *
 * 왜 이런 검사를 하나:
 * RN #48497 / #55257 계열의 IME 파손은 "조합이 리셋되어 앞 글자가 중복되거나
 * 자모가 풀려서 다시 쌓인다"는 형태로 나타난다. 사람이 눈으로 보면 "글자가 이상하다"
 * 지만, 기계가 보면 **한 번의 keystroke 에서 이전 값의 마지막 글자보다 더 많은 것이
 * 사라지거나 더 많은 것이 생긴다**는 성질로 잡힌다.
 *
 * 한글 IME 의 정상 동작:
 *   - 조합 중인 음절은 **항상 문자열의 마지막 글자 한 칸**이다.
 *   - 따라서 keystroke 하나가 바꿀 수 있는 것은 마지막 글자 1개 + 새로 붙는 1글자뿐.
 *
 * 이 불변식을 깨는 전이 = `suspicious`. 눈대중이 아니라 기계 판정이다.
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
 * dropped >= 2 (이전 값의 마지막 글자보다 더 많이 날아감)
 * 또는 added >= 2 (한 번에 두 글자 이상 생김) 이면 조합이 깨진 것이다.
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
    suspicious: dropped >= 2 || added >= 2,
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
