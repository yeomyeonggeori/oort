// =============================================================================
// 「이 낱말 추천 끄기」의 기억 (#5476 웹, #5478 폰, owner 2026-11-07). 추천 줄의 ✕ 를 누르면 **이 대화에서** 그 낱말(들)의 추천이 꺼진다. 웹과 폰이 같은 규칙을 쓰도록 코어에 둔다.
//
// 저장은 메모리뿐이다(이슈: 「저장은 메모리나 세션 범위면 충분」): 앱을 다시 켜거나 새로고침하면 풀리고 기기에는 아무것도 남지 않는다. 모듈 변수인 이유는 입력칸이 사라졌다
// 돌아와도(웹은 스레드 패널을 열고 닫으면 컴포저가 다시 마운트된다) 끈 낱말이 그대로여야 하기 때문이다 - 컴포넌트 상태에 두면 그때 풀린다. 대화마다 따로다
// (같은 낱말이 다른 대화에서는 계속 뜬다). 낱말은 줄을 세운 낱말들(`suggestExpressionRow` 의 `keywords`, #5588)을 정리한 꼴 그대로 담고, 비교는 맞추기가 같은 정리를 거쳐 한다.
// 시계·저장소·네트워크를 만지지 않는다 - 받은 낱말을 메모리 지도에 적고 돌려줄 뿐이다.
// =============================================================================

/** 한 대화가 기억하는 끈 낱말의 수. 넘치면 가장 먼저 끈 것부터 잊는다(세션 동안 무한히 자라지 않게). */
export const MAX_MUTED_KEYWORDS = 200;

const mutedByScope = new Map<string, Set<string>>();

/** 이 대화에서 끈 낱말들(끈 차례). */
export function mutedKeywords(scope: string): readonly string[] {
  return [...(mutedByScope.get(scope) ?? [])];
}

/** 이 대화에서 낱말들의 추천을 끈다. 이미 끈 낱말은 그대로다. */
export function muteKeywords(scope: string, keywords: readonly string[]): void {
  const muted = mutedByScope.get(scope) ?? new Set<string>();
  for (const keyword of keywords) {
    if (keyword === "") continue;
    muted.add(keyword);
  }
  while (muted.size > MAX_MUTED_KEYWORDS) {
    const oldest = muted.values().next();
    if (oldest.done) break;
    muted.delete(oldest.value);
  }
  mutedByScope.set(scope, muted);
}

/** 시험 사이에 기억을 비운다. */
export function resetSuggestMuteForTest(): void {
  mutedByScope.clear();
}
