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

export type ParticlePair = "subject" | "object" | "topic" | "with";

const PAIRS: Record<ParticlePair, readonly [withFinal: string, withoutFinal: string]> = {
  subject: ["이", "가"],
  object: ["을", "를"],
  topic: ["은", "는"],
  /**
   * 과/와 — "WITH this person", "AND that one".
   *
   * Added by goal RN-A1 because a screen had already hardcoded it: 「대화 열기」
   * on an agent read `${displayName}과의 대화` and said "Hermes과의" to anyone
   * whose agent is not named in Hangul. It is the same decidable rule as the
   * three above, so it belongs in the same table rather than in the one screen
   * that happened to need it first.
   *
   * Note the inversion against 이/가: here the FINAL-consonant form is 과 and
   * the open form is 와 ("김인턴과", "Hermes와"). Writing this pair from memory
   * is how it ends up backwards, which is the second reason it is written down
   * once.
   */
  with: ["과", "와"],
};

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** Every Hangul syllable block cycles through 28 final-consonant slots, 0 = none. */
const JONGSEONG_SLOTS = 28;
/** Slot 8 in that cycle is ㄹ, the one final consonant 로 does not take 으 for. */
const JONGSEONG_RIEUL = 8;

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

// ---- 에 / 에게 ---------------------------------------------------------------
//
// The fourth pair, and the first one in this file that **the word cannot
// decide**. 이/가, 을/를, 은/는, 과/와 and 로/으로 are all phonology: read the
// last spoken syllable and the answer follows. 에 vs 에게 is not — it is
// animacy. "일반에 보낸다" (a place receives), "김인턴에게 보낸다" (a person
// receives), and nothing in the letters of 김인턴 says it is a person. A
// workspace can name a channel 하늘 and a member 하늘 on the same day.
//
// Why it still lives here: this file is where the repo keeps the answer to
// "which Korean particle goes after this name", and a caller who cannot find
// the pair here writes `${label}에` by hand — which is exactly the defect this
// pair was added for (#1384: the composer said "hermes에 메시지 보내기" in every
// DM with an agent whose name is not a place).
//
// So the rule is honest about its input: the fact comes from the caller, and
// the type makes the caller say it out loud rather than pass a bare boolean.
// A screen that does not know whether it is addressing a person does not get a
// default here — it gets a compile error, which is the right outcome, because
// the wrong particle is not a rendering detail to a Korean reader.

/** Who receives. 방·문서·채널이면 `place`, 사람·에이전트면 `person`. */
export type RecipientKind = "place" | "person";

/** "일반" + place -> "일반에"; "Hermes" + person -> "Hermes에게". */
export function attachRecipient(word: string, kind: RecipientKind): string {
  return `${word}${kind === "person" ? "에게" : "에"}`;
}

// ---- 로 / 으로 --------------------------------------------------------------
//
// A third pair, and it does not fit the table above, for two reasons that both
// show up in provider copy:
//
//   1. It is not a binary on 받침. ㄹ behaves like an open syllable here, so
//      "서울로" and "칠로" take 로 while "삼으로" and "육으로" do not. A
//      two-slot pair cannot express that.
//   2. Its most common subject in this product is a NUMBER. "provider가 503로
//      답했습니다." was on screen, and it is wrong for every status code ending
//      in 0, 3 or 6 (영/삼/육 all close on a consonant), which is exactly the
//      set an operator meets most: 500, 503, 400, 403, 406.
//
// So the digit is read the way it is spoken (Sino-Korean) and then decided by
// the same Hangul rule. Only the LAST digit is read, because only the last
// syllable is spoken before the particle: 503 is "오백삼", 5xx generally is
// decided by its final digit alone.
const SINO_DIGIT_READING = [
  "영",
  "일",
  "이",
  "삼",
  "사",
  "오",
  "육",
  "칠",
  "팔",
  "구",
] as const;

/**
 * The syllable actually spoken before the particle, or null.
 *
 * Digits answer their Sino-Korean reading. Latin letters answer null and are
 * treated as open, which is the same call `hasFinalConsonant` already makes:
 * anglicised endings have no single Korean reading ("Slack으로" and "API로" are
 * both current), and guessing one is worse than the neutral form.
 */
function spokenSyllable(word: string): number | null {
  const codePoint = lastSpokenCodePoint(word);
  if (codePoint === null) return null;
  if (codePoint >= 0x30 && codePoint <= 0x39) {
    return SINO_DIGIT_READING[codePoint - 0x30].codePointAt(0) ?? null;
  }
  if (codePoint < HANGUL_FIRST || codePoint > HANGUL_LAST) return null;
  return codePoint;
}

/**
 * 로 or 으로, the particle for "answered WITH", "moved TO", "saved AS".
 *
 * "503으로", "401로", "gateway.dawn.internal로". Never "503로".
 */
export function directionParticle(word: string): string {
  const syllable = spokenSyllable(word);
  if (syllable === null) return "로";
  const jongseong = (syllable - HANGUL_FIRST) % JONGSEONG_SLOTS;
  if (jongseong === 0 || jongseong === JONGSEONG_RIEUL) return "로";
  return "으로";
}

/** "503" -> "503으로"; "401" -> "401로". */
export function attachDirection(word: string): string {
  return `${word}${directionParticle(word)}`;
}
