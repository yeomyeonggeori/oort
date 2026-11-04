// 캡처 컨텍스트의 언어 (#5260). 캡처 하네스가 컨텍스트에 `locale`을 넘기지 않으면 Chromium 기본(en-US)이라, 사전 문장이
// 영어로 찍힌다. 앱의 첫 언어(ko-KR)로 찍고, 다른 언어가 필요하면 `CAPTURE_LOCALE`로 바꾼다. 호출이 직접 정한 `locale`은 그대로 둔다.

export const CAPTURE_LOCALE = process.env.CAPTURE_LOCALE || "ko-KR";

/** Playwright `newContext` 옵션에 캡처 언어를 더한다. 옵션이 없어도 된다. */
export function withCaptureLocale(options, locale = CAPTURE_LOCALE) {
  return { locale, ...(options ?? {}) };
}
