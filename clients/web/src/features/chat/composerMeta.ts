export type ComposerMetaMode = "hint" | "typing" | "empty";

/**
 * 컴포저 액션 행 가운데 공유 슬롯의 내용 (U-8 · #1749).
 *
 * 사람의 작성 신호가 넓은 화면 힌트보다 우선한다. 둘 다 없을 때의 빈 슬롯은
 * 액션 행의 남는 가로폭만 차지하므로 별도 세로 띠를 만들지 않는다. 폰에는 Enter
 * 키 힌트가 없으며, DM 힌트는 이 공유 슬롯 밖에서 기존처럼 상시 남는다.
 */
export function composerMetaMode(options: {
  typistCount: number;
  hasDmHint: boolean;
  keysHintNeeded: boolean;
  isMobile: boolean;
}): ComposerMetaMode {
  if (options.typistCount > 0) return "typing";
  if (
    !options.isMobile &&
    (options.hasDmHint || options.keysHintNeeded)
  ) {
    return "hint";
  }
  return "empty";
}

/** 폰 DM 안내는 U-8의 wide-only 키 힌트가 아니므로 기존 행을 그대로 지킨다. */
export function keepPhoneDmHint(options: {
  hasDmHint: boolean;
  isMobile: boolean;
}): boolean {
  return options.hasDmHint && options.isMobile;
}
