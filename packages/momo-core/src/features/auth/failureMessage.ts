import type { LocaleService } from "../../i18n/context";
import type { MessageRef, PlainMessageKey } from "../../i18n/keys";

// 가입·연결 실패 한 줄이 들고 있는 문장. 사전의 문장(키와 값)이거나, 다른 곳이 이미 지어 온 글(전송 오류가 자기 말로
// 들고 온 문장, 주소 검사의 문장)이다. 코어는 문장을 돌려주지 않고, 화면이 그릴 때 지금 언어로 푼다.
// 값이 있는 문장은 키를 여기에 이름으로 올린다: 모든 키의 합집합(`MessageRef`)은 너무 커서 식이 복잡해진다.
export type FailureMessage =
  | { key: PlainMessageKey; values?: undefined }
  | MessageRef<"auth.passwordRule.tooShort" | "auth.passwordRule.tooLong">
  | { key?: undefined; raw: string };

export function failureMessageText(
  formatMessage: LocaleService["formatMessage"],
  message: FailureMessage
): string {
  return message.key === undefined
    ? message.raw
    : formatMessage(message.key, message.values as never);
}
