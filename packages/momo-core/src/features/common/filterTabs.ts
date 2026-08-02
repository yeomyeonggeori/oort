// =============================================================================
// 한 표면의 필터 어휘 (goal RN-C1 / ADR-0137 D3).
//
// 컨트롤이 아니라 **어휘**만 여기 산다. 값의 집합과 이름·id 규칙은 서버의 어휘를
// 그대로 따르므로(`?filter=`, `?status=`) 플랫폼이 없고, 키보드 계약과 기하를 쥔
// 실제 컴포넌트는 각 호스트에 남는다(웹: `clients/web/src/features/common/
// FilterTabs.tsx`).
// =============================================================================

/**
 * 한 표면의 필터 어휘. 그 표면의 model 옆에 두어, 절반만 설정된 탭 묶음(이름은
 * 정했는데 패널 id는 없는 식)이 나올 수 없게 한다.
 */
export interface FilterTabsSpec<T extends string> {
  /** tablist의 접근성 이름. 느슨한 버튼 N개가 아니라 한 질문임을 말한다. */
  label: string;
  values: readonly T[];
  labelFor: (value: T) => string;
  /** 탭 엘리먼트의 id. 라우트가 패널의 `aria-labelledby`로 되짚는다. */
  tabId: (value: T) => string;
  /** 이 탭이 지배하는 패널의 id. 라우트가 자기 패널에 붙인다. */
  panelId: (value: T) => string;
  testId: (value: T) => string;
}
