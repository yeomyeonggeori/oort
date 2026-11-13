export type ComposerMetaMode = "hint" | "empty";

/**
 * 컴포저 도구 줄 가운데 슬롯의 내용 (U-8 · #1749).
 *
 * 힌트(넓은 화면의 키 힌트·DM 안내·링크 자리표시)가 있으면 힌트, 없으면 빈 슬롯이다. 빈 슬롯은 도구 줄의 남는 가로폭만
 * 차지하므로 별도 세로 띠를 만들지 않는다. 폰에는 Enter 키 힌트가 없으며, DM 힌트는 이 공유 슬롯 밖에서 상시 남는다.
 *
 * 남의 「작성 중」은 이 슬롯을 쓰지 않는다(#5567): 카드 아래 늘 잡아 둔 한 줄(`TypingLine`)에 서므로, 누가 치기 시작해도
 * 힌트가 바뀌지 않고 입력창의 설명(`aria-describedby`)도 그대로다.
 */
export function composerMetaMode(options: {
  hasDmHint: boolean;
  keysHintNeeded: boolean;
  isMobile: boolean;
  hasPendingLink?: boolean;
}): ComposerMetaMode {
  if (options.hasPendingLink) return "hint";
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
