/** `catalog:nord` → `theme-tile-catalog-nord`. 시험·캡처가 읽는 `data-testid`다(컴포넌트 파일에서 함수를 내보내지 않으려고 따로 둔다). */
export function tileTestId(ref: string): string {
  return `theme-tile-${ref.replace(":", "-")}`;
}
