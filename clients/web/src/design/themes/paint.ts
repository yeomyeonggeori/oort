/** `style.setProperty`만 있으면 되는 요소(진짜 `HTMLElement`가 구조적으로 만족한다). */
export interface PaintTarget {
  style: { setProperty(name: string, value: string): unknown };
}

/**
 * 변수 몇 개를 요소 하나에 꽂는다. 인라인 `style=` 속성이 아니라 CSSOM이라 CSP(`style-src`)와 프리플라이트
 * `inline_style`에 걸리지 않는다(`theme-boot.js`가 사용자 글꼴에 이미 쓰는 길). 미리보기 타일이 자기 테마의
 * 색을 입는 방법이다.
 */
export function paintElement(node: PaintTarget, vars: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(vars)) node.style.setProperty(name, value);
}
