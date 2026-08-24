export type ComposerMetaMode = "hint" | "typing" | "reserved";

/**
 * 컴포저 아래 26px 공유 행의 내용 (U-8).
 *
 * 사람의 작성 신호가 넓은 화면 힌트보다 우선하고, 둘 다 없으면 빈 판이 높이를
 * 예약한다. 폰에는 Enter 키 힌트가 없으며, DM 힌트는 이 공유 행 밖에서 기존처럼
 * 타이핑 행 위에 상시 남는다.
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
  return "reserved";
}

/** 폰 DM 안내는 U-8의 wide-only 키 힌트가 아니므로 기존 행을 그대로 지킨다. */
export function keepPhoneDmHint(options: {
  hasDmHint: boolean;
  isMobile: boolean;
}): boolean {
  return options.hasDmHint && options.isMobile;
}
