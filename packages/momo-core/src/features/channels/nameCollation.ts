// =============================================================================
// 채널 이름을 세우는 자 (ADR-0225 D12). 「ko」로 못 박지 않고 보는 사람의 화면 언어로,
// 숫자는 값으로(`sprint-2` 가 `sprint-10` 앞). 같은 언어면 같은 Collator 를 돌려주고,
// 언어가 바뀔 때만 새로 만든다 (줄마다 만들면 정렬이 느려진다).
// =============================================================================

let current: { locale: string; collator: Intl.Collator } | null = null;

export function channelNameCollator(locale: string): Intl.Collator {
  if (current !== null && current.locale === locale) return current.collator;
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale, { numeric: true });
  } catch {
    collator = new Intl.Collator("en-US", { numeric: true });
  }
  current = { locale, collator };
  return collator;
}

/** `array.sort(compareChannelNames(locale))` 에 바로 쓴다. */
export function compareChannelNames(locale: string): (a: string, b: string) => number {
  const collator = channelNameCollator(locale);
  return (a, b) => collator.compare(a, b);
}
