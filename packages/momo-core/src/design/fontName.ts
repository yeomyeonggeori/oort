// =============================================================================
// 사용자 글꼴 이름 규칙 (#3774, AP-1a #4186에서 웹 `userFont.ts`로부터 core로 옮김).
//
// 규칙이 core에 사는 까닭은 하나다: 외양 레코드 v2(`appearance.ts`)가 글꼴을 같이
// 들고 가야 하고(v1 `{scheme, accent, fontSans, fontMono}` → v2 이행에서 글꼴이
// 사라지면 설정이 조용히 지워진다), 레코드를 읽는 자리가 이 규칙으로 값을 거르기
// 때문이다. 웹 `userFont.ts`는 이 모듈을 다시 내보낸다.
//
// 안전 규칙은 두 개다.
//   1. 이름은 허용 목록으로만 받는다. 글자·숫자·공백·`. _ + & -` 밖의 것
//      (`; { } ( ) ' " \ / < >`, 쉼표, 개행)은 값으로 들어가지 못한다. CSS에 닿는
//      문자열이므로 걸러 쓰는 것이 아니라 **거절**한다: 조용히 깎아 낸 이름은 사람이
//      적지 않은 글꼴을 가리킨다.
//   2. 적용되는 font-family는 언제나 `"이름", var(--font-sans)`(코드는
//      `--font-mono`)다(적용은 웹 `userFont.ts`가 한다).
//
// 정규식은 **처음 쓸 때** 만든다. 폰은 이 파일을 레코드 읽기 경로로 불러오지만 글꼴
// 값을 한 번도 갖지 않는다. 모듈 로드 때 `\p{…}`(유니코드 속성 이스케이프)를 컴파일하면
// 그것을 모르는 엔진에서 앱이 시작도 못 한다. 만들 수 없는 엔진에서는 비어 있지 않은
// 이름을 전부 거절한다(글꼴을 못 쓰는 쪽으로 닫는다).
// =============================================================================

/** 이름 길이 상한(공백 정리 뒤). */
export const FONT_NAME_MAX = 64;

/** 허용 목록. 부트 스크립트가 같은 식을 쓴다(웹 시험이 문자열로 맞춰 본다). */
export const FONT_NAME_PATTERN = "^[\\p{L}\\p{M}\\p{N} ._+&-]+$";

let fontNameRe: RegExp | null | undefined;

function fontNameRegExp(): RegExp | null {
  if (fontNameRe === undefined) {
    try {
      fontNameRe = new RegExp(FONT_NAME_PATTERN, "u");
    } catch {
      fontNameRe = null;
    }
  }
  return fontNameRe;
}

export type FontNameResult =
  | { ok: true; name: string | undefined }
  | { ok: false; reason: "chars" | "long" };

/**
 * 입력을 글꼴 이름으로 읽는다. 빈 입력은 「기본으로」(`name: undefined`)이고, 앞뒤 공백을
 * 지우고 안쪽 공백은 하나로 접는다. 허용 밖 문자는 `chars`, 상한 초과는 `long`.
 */
export function parseFontName(raw: unknown): FontNameResult {
  if (typeof raw !== "string") return { ok: true, name: undefined };
  const name = raw.replace(/\s+/g, " ").trim();
  if (name === "") return { ok: true, name: undefined };
  if (name.length > FONT_NAME_MAX) return { ok: false, reason: "long" };
  // 개행·탭은 위에서 공백 하나로 접혔다. 접힌 뒤에도 허용 밖이면 거절한다.
  const re = fontNameRegExp();
  if (re === null || !re.test(name)) return { ok: false, reason: "chars" };
  return { ok: true, name };
}

/** 저장소에서 읽을 때: 모르는 값·깨진 값은 undefined(시스템 서체). */
export function normalizeFontName(raw: unknown): string | undefined {
  const result = parseFontName(raw);
  return result.ok ? result.name : undefined;
}
