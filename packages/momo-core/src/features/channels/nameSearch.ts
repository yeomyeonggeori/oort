import { normalizeChannelName } from "./model";

// =============================================================================
// 한글 이름 채널을 찾을 때 조합 중에도 줄이 깜빡이지 않게 하는 도우미 (ADR-0225 D12).
//
// 「디자인」을 치는 동안 입력기는 `디` → `디ㅈ` → `디자` → `디장` → `디자이` → `디자인`
// 을 차례로 만든다. 글자 그대로 견주면 `디ㅈ`·`디장`·`디자이`에서 「디자인」이 목록에서
// 사라졌다가 돌아온다. 이 도우미는 질의의 **마지막 글자만** 느슨하게 본다.
//
//   1. 마지막 글자에 받침이 있으면 받침이 다음 글자의 첫소리로 넘어갈 수 있다
//      (`장` = `자` + 다음 글자 `ㅇ…`, 겹받침 `닭` = `달` + 다음 글자 `ㄱ…`).
//   2. 마지막 글자에 받침이 없으면 이름의 같은 글자는 받침이 있어도 맞는다 (`이` ↔ `인`).
//   3. 마지막 글자가 홀로 선 자음 자모면 그 자음이 첫소리인 글자에 맞는다 (`디ㅈ` ↔ `자`).
//
// 앞 글자들은 그대로(접은 이름 기준) 견준다. 마지막 글자가 한글(완성 글자 또는 홀로 선
// 자음)이 아니면 아무것도 맞추지 않는다 — 그 질의는 호출처의 지금 견줌이 그대로 맡는다.
// 초성 검색(`ㄷㅈㅇ` → 디자인)은 하지 않는다: 앞 글자는 늘 글자 그대로다.
// =============================================================================

export interface NameTailMatch {
  /** 맞은 구간 `[start, end)` — 접은 이름 위의 코드포인트 위치. */
  readonly start: number;
  readonly end: number;
}

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const CHO = 0x1100; // 첫소리 19, 이어지는 자모 블록
const JUNG = 0x1161; // 가운뎃소리 21
const JONG = 0x11a7; // 받침 27 (+1 이 첫 받침 ㄱ)

/** 호환 자모 자음의 코드포인트. 첫소리 19칸과 받침 27칸(받침 없음 제외)을 코드포인트로 적는다 — 글자 표는 사전이 아니다. */
const CHO_COMPAT: readonly number[] = [
  0x3131, 0x3132, 0x3134, 0x3137, 0x3138, 0x3139, 0x3141, 0x3142, 0x3143, 0x3145,
  0x3146, 0x3147, 0x3148, 0x3149, 0x314a, 0x314b, 0x314c, 0x314d, 0x314e,
];
const JONG_COMPAT: readonly number[] = [
  0x3131, 0x3132, 0x3133, 0x3134, 0x3135, 0x3136, 0x3137, 0x3139, 0x313a, 0x313b,
  0x313c, 0x313d, 0x313e, 0x313f, 0x3140, 0x3141, 0x3142, 0x3144, 0x3145, 0x3146,
  0x3147, 0x3148, 0x314a, 0x314b, 0x314c, 0x314d, 0x314e,
];
/** 겹받침 → [남는 받침, 다음 글자 첫소리로 넘어가는 자음]. */
const COMPOUND: Readonly<Record<number, readonly [number, number]>> = {
  0x3133: [0x3131, 0x3145], 0x3135: [0x3134, 0x3148], 0x3136: [0x3134, 0x314e],
  0x313a: [0x3139, 0x3131], 0x313b: [0x3139, 0x3141], 0x313c: [0x3139, 0x3142],
  0x313d: [0x3139, 0x3145], 0x313e: [0x3139, 0x314c], 0x313f: [0x3139, 0x314d],
  0x3140: [0x3139, 0x314e], 0x3144: [0x3142, 0x3145],
};
/** 받침 28칸(0 = 없음)을 `[남는 받침 단위, 넘어가는 첫소리 단위]` 로. 홑받침은 남는 받침이 없다. */
const JONG_SPLIT: ReadonlyArray<readonly [number | null, number | null]> = [
  [null, null],
  ...JONG_COMPAT.map((jong): readonly [number | null, number | null] => {
    const pair = COMPOUND[jong];
    if (pair) return [JONG + JONG_COMPAT.indexOf(pair[0]) + 1, CHO + CHO_COMPAT.indexOf(pair[1])];
    return [null, CHO + CHO_COMPAT.indexOf(jong)];
  }),
];

/** 글자 하나를 자모 단위(숫자) 몇 개로. 한글 완성 글자만 풀고 나머지는 코드포인트 그대로. */
function unitsOf(cp: number): number[] {
  if (cp < HANGUL_BASE || cp > HANGUL_LAST) return [cp];
  const s = cp - HANGUL_BASE;
  const jong = s % 28;
  const out = [CHO + Math.floor(s / 588), JUNG + Math.floor((s % 588) / 28)];
  if (jong > 0) out.push(JONG + jong);
  return out;
}

/** 대소문자만 접고 위치는 그대로 두는 줄 (접으면 글자 수가 바뀌는 글자는 둔다). */
function foldChars(text: string): number[] {
  return Array.from(text.normalize("NFC"), (ch) => {
    const lower = ch.toLowerCase();
    return (Array.from(lower).length === 1 ? lower : ch).codePointAt(0)!;
  });
}

/** 질의 마지막 글자가 만들 수 있는 자모열들 (정확히 맞는 것 포함). 한글이 아니면 빈 목록. */
function tailForms(cp: number): number[][] {
  if (cp >= HANGUL_BASE && cp <= HANGUL_LAST) {
    const own = unitsOf(cp);
    const forms = [own];
    const jong = (cp - HANGUL_BASE) % 28;
    if (jong > 0) {
      const [stays, moves] = JONG_SPLIT[jong];
      const open = own.slice(0, 2);
      if (stays !== null) open.push(stays);
      if (moves !== null) open.push(moves);
      forms.push(open);
    }
    return forms;
  }
  const lone = CHO_COMPAT.indexOf(cp);
  return lone >= 0 ? [[cp], [CHO + lone]] : [];
}

/**
 * `name` 안에서 `query` 가 (마지막 글자만 느슨하게) 맞는 곳 전부, 왼쪽부터.
 * 마지막 글자가 한글이 아니면 `[]` — 글자 그대로의 견줌은 호출처가 한다.
 * 이름은 서버가 접어 저장한 값(NFC·소문자)이라고 본다. 질의는 서버와 같은 접기로 맞춘다.
 */
export function looseTailMatches(query: string, name: string): NameTailMatch[] {
  const folded = Array.from(normalizeChannelName(query));
  if (folded.length === 0) return [];
  const headCps = folded.slice(0, -1).map((ch) => ch.codePointAt(0)!);
  const forms = tailForms(folded[folded.length - 1].codePointAt(0)!);
  if (forms.length === 0) return [];
  const head = headCps.flatMap(unitsOf);

  const hay: number[] = [];
  const origin: number[] = [];
  foldChars(name).forEach((cp, index) => {
    for (const unit of unitsOf(cp)) {
      hay.push(unit);
      origin.push(index);
    }
  });

  const found = new Map<number, number>();
  for (const tail of forms) {
    const needle = [...head, ...tail];
    for (let from = 0; from + needle.length <= hay.length; from += 1) {
      if (!needle.every((unit, i) => hay[from + i] === unit)) continue;
      // 첫소리·홀로 선 글자에서만 시작한다 (글자 한가운데에서 시작하는 일치는 없다).
      const unit = hay[from];
      if (unit >= JUNG && unit < JONG + 28) continue;
      const start = origin[from];
      const end = origin[from + needle.length - 1] + 1;
      const known = found.get(start);
      if (known === undefined || end > known) found.set(start, end);
    }
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([start, end]) => ({ start, end }));
}

export function looseTailIncludes(query: string, name: string): boolean {
  return looseTailMatches(query, name).length > 0;
}
