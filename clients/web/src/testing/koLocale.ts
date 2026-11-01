import { catalog as ko } from "@momo/core/i18n/generated/ko-KR";
import { createAppLocale, type AppLocale } from "@/i18n/localeStore";

// 시험용: 한국어 언어 객체. 공급자 밖의 화면은 번들된 영어로 물러나므로(`useFormatMessage`), 한국어 문구를 단정하는
// 시험은 이것을 `LocaleProvider`에 넣어 감싼다. 카탈로그는 제품과 같은 생성물이고, 네트워크 덩어리 로더는 쓰지 않는다.

export async function koreanLocale(): Promise<AppLocale> {
  return createAppLocale(
    {
      readPreference: () => "ko-KR",
      writePreference: () => undefined,
      readDevice: () => ({ languages: ["ko-KR"], timeZone: "Asia/Seoul" }),
    },
    { loadCatalog: async () => ko, applyLang: () => undefined }
  );
}
