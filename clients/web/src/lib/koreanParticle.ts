// =============================================================================
// Korean particles, ported rule-for-rule from the mac client
// (clients/macOS/Sources/MomoMac/MomoAppLocalization.swift, MomoKoreanParticle).
//
// "Hermes이(가) 작업 중" is not a localised string, it is a machine refusing to
// decide in front of the reader. The choice is fully decidable from the last
// spoken syllable, so it gets decided: a Hangul syllable with a final consonant
// (jongseong) takes 이/을/은, everything else takes 가/를/는. The demo roster
// carries both 김인턴 and Hermes, so both branches are on screen daily.
// =============================================================================

export type ParticlePair = "subject" | "object" | "topic";

const PAIRS: Record<ParticlePair, readonly [withFinal: string, withoutFinal: string]> = {
  subject: ["이", "가"],
  object: ["을", "를"],
  topic: ["은", "는"],
};

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** Every Hangul syllable block cycles through 28 final-consonant slots, 0 = none. */
const JONGSEONG_SLOTS = 28;

/** Trailing whitespace and punctuation are not spoken, so they do not decide. */
const IGNORED_AT_END = /[\s\p{P}]/u;

/**
 * The last code point that is actually pronounced, or null for a word that is
 * only whitespace and punctuation.
 */
function lastSpokenCodePoint(word: string): number | null {
  const chars = Array.from(word);
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if (IGNORED_AT_END.test(chars[i])) continue;
    return chars[i].codePointAt(0) ?? null;
  }
  return null;
}

/**
 * Does this word end in a final consonant? A non-Hangul ending (Latin, digits,
 * emoji) answers false, which is what makes "Hermes가" and "MOMO-613이" come
 * out the way a Korean reader expects.
 */
export function hasFinalConsonant(word: string): boolean {
  const codePoint = lastSpokenCodePoint(word);
  if (codePoint === null) return false;
  if (codePoint < HANGUL_FIRST || codePoint > HANGUL_LAST) return false;
  return (codePoint - HANGUL_FIRST) % JONGSEONG_SLOTS !== 0;
}

/** The particle alone, for callers that must place it after a qualifier. */
export function particleFor(word: string, pair: ParticlePair = "subject"): string {
  const [withFinal, withoutFinal] = PAIRS[pair];
  return hasFinalConsonant(word) ? withFinal : withoutFinal;
}

/** "김인턴" + subject -> "김인턴이"; "Hermes" + subject -> "Hermes가". */
export function attachParticle(word: string, pair: ParticlePair = "subject"): string {
  return `${word}${particleFor(word, pair)}`;
}
