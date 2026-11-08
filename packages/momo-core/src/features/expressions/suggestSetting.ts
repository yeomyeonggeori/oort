// =============================================================================
// 「이모티콘 추천」 켜기·끄기 설정 (owner 2026-11-07 「설정에서 다 끌 수도 있어요」, #5493). 입력창 위의 키워드 추천 줄(`suggest.ts`, 웹 #5476·폰 #5478)을 **통째로** 끄는 스위치의 저장값이다.
// 줄의 ✕(`suggestMute.ts`)는 그 대화의 낱말 하나를 메모리에서만 끄고, 이것은 이 기기에 남는 사람의 선택이라 둘은 겹치지 않는다.
//
// 저장은 즐겨찾기(`favorites.ts`)와 같은 자리 규칙이다: **이 기기 · 이 워크스페이스 · 이 사람**의 로컬 값이고 서버 계약은 없다. 저장소 쪽은 각 클라이언트가 맡고(웹 localStorage, 폰 MMKV),
// 이 모듈은 값의 모양과 읽는 법·쓰는 법만 가진다: 순수 함수라 DOM·저장소가 없다.
//
// **기본은 켜짐이다.** 저장된 값은 믿지 않는다: 끈 것으로 **분명히** 적힌 값(현재 모양, 이 워크스페이스·이 사람, `on === false`)만 끔이고, 비어 있거나 깨졌거나 옛 모양이거나 다른 계정·다른
// 워크스페이스의 값이거나 `on` 이 불리언이 아니면 켜짐이다. 못 읽어서 사람이 켜 둔 기능이 저절로 꺼지는 쪽이 더 나쁘다.
// =============================================================================

export interface ExpressionSuggestSetting {
  v: 1;
  workspaceId: string;
  memberId: string;
  /** 추천 줄을 쓰는가. 한 번도 바꾸지 않았으면 켜짐이다. */
  on: boolean;
}

/** 한 번도 건드리지 않은 사람의 값. */
export const EXPRESSION_SUGGEST_DEFAULT_ON = true;

/** 저장소에 쓸 값. 켠 것도 적는다(나중에 기본이 바뀌어도 이 사람의 선택이 따라 움직이지 않게). */
export function expressionSuggestSetting(workspaceId: string, memberId: string, on: boolean): ExpressionSuggestSetting {
  return { v: 1, workspaceId, memberId, on };
}

/** 저장소에서 읽은 값(믿지 않는 입력)이 말하는 켬·끔. 끈 것으로 분명히 적힌 값만 `false` 다. */
export function restoreExpressionSuggestOn(value: unknown, workspaceId: string, memberId: string): boolean {
  if (!value || typeof value !== "object") return EXPRESSION_SUGGEST_DEFAULT_ON;
  const data = value as Partial<ExpressionSuggestSetting>;
  if (data.v !== 1 || data.workspaceId !== workspaceId || data.memberId !== memberId) return EXPRESSION_SUGGEST_DEFAULT_ON;
  return data.on === false ? false : EXPRESSION_SUGGEST_DEFAULT_ON;
}
