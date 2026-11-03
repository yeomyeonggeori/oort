// =============================================================================
// 「비밀번호를 잊으셨나요?」 안내 화면의 순수 부분 (ADR-0215 D5, #4601).
//
// 이 화면은 **서버를 부르지 않는다**: 멤버·관리자 명단을 로그인 전에 보이려면 공개 엔드포인트가
// 필요하고 그것은 계정 열거다(OWASP). 그래서 화면이 건네는 것은 복사할 요청 문구 하나와 링크를 받은
// 뒤의 입구뿐이고, 문구에 담기는 것은 **입력해 둔 이메일과 서버 호스트뿐**이다. 비밀번호·워크스페이스
// 이름·멤버 이름은 이 모듈의 입력에 아예 없다(받지 않는 것이 담기지 않는 것을 보증한다).
// =============================================================================

import { expressionForState } from "../onboarding/guide";
import type { LocaleService } from "../../i18n/context";

/** 안내 화면에서 코메토의 표정: 서두르지 않고 기다리는 자세다(오류가 아니다). */
export const PASSWORD_HELP_EXPRESSION = expressionForState("awaiting");

/**
 * 웹 `classifyEntry`(`entryInput.ts`)가 돌려주는 `kind` 중 안내 화면이 가르는 둘의 이름. 화면이 낱말을
 * 직접 비교하지 않고 이 이름표를 읽는다. 어긋나면 웹의 `PasswordHelp.connect.test`가 빨개진다(그 시험이
 * 실제 판정의 `kind`와 이 값을 맞댄다).
 */
export const ENTRY_KIND_CLAIM = "claim";
export const ENTRY_KIND_EMPTY = "empty";

/**
 * 만료 시각을 문장에 넣을 꼴로: 「11월 4일 오후 2:30」. 날짜는 월·일만(24시간 안이라 해가 갈리지
 * 않는다), 시각은 이 기기의 언어·시간대 규칙을 따른다.
 */
export function resetExpiryWhen(
  locale: Pick<LocaleService, "formatDate" | "formatTime">,
  expiresAtMs: number
): string {
  const day = locale.formatDate(expiresAtMs, { month: "long", day: "numeric" });
  return `${day} ${locale.formatTime(expiresAtMs)}`;
}

/** 요청 문구의 이메일 칸 길이 상한(RFC 5321 주소 최대 길이). 붙여 넣은 긴 글이 문구를 키우지 않게 한다. */
const EMAIL_MAX_CHARS = 254;

/**
 * 서버 주소에서 **호스트(와 포트)만**. 경로 접두(`/momo`)와 스킴은 관리자가 어느 서버인지 알아보는 데
 * 필요 없고, 읽을 수 없는 주소는 스킴만 떼어 그대로 둔다.
 */
export function serverHost(serverBase: string): string {
  try {
    const host = new URL(serverBase).host;
    if (host !== "") return host;
  } catch {
    // 아래로 떨어진다.
  }
  return serverBase.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
}

/** 입력해 둔 이메일을 문구에 넣을 꼴로: 앞뒤 공백을 걷고, 안의 공백·줄바꿈은 한 칸으로. 비면 빈 글. */
function requestEmail(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, EMAIL_MAX_CHARS);
}

type RequestFormat = {
  (key: "recovery.help.requestNoEmail", args: { host: string }): string;
  (key: "recovery.help.requestWithEmail", args: { host: string; email: string }): string;
};

/**
 * 관리자에게 보낼 요청 문구. 이메일을 아직 안 넣었으면 서버만 담는다. 사전은 호출한 쪽의
 * `formatMessage`다(언어를 바꾸면 다시 읽는다).
 */
export function passwordHelpRequestText(
  input: { serverBase: string; email: string },
  formatMessage: RequestFormat
): string {
  const host = serverHost(input.serverBase);
  const email = requestEmail(input.email);
  return email === ""
    ? formatMessage("recovery.help.requestNoEmail", { host })
    : formatMessage("recovery.help.requestWithEmail", { host, email });
}
