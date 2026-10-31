import { useSyncExternalStore } from "react";
import { createMessageService, type MessageService } from "@momo/core/i18n";
import { useAppLocale } from "./localeContext";

// 화면이 사전 문구를 얻는 문 하나 (#4878 — 타임라인의 첫 사전 소비처라 이 모양이 다음 화면의 본이 된다).
//
// 제품은 부트에서 늘 언어 공급자를 세운다(`main.tsx`의 `LocaleProvider`). 공급자 밖의 격리 화면(시험·측정 하니스)은
// **번들된 영어 서비스**로 물러난다: 영어는 코어 서비스에 이미 실려 있어 새 덩어리를 끌어오지 않고(한국어는
// 별도 Vite 덩어리라 정적으로 부르면 그 분리가 깨진다), 폴백 문구를 화면 코드에 리터럴로 두지 않는다.
// 한국어를 단정하는 시험은 `@/testing/koLocale`의 공급자로 감싼다.

const bundledEnglish = createMessageService({ messageLocale: "en-US" });
const noSubscribe = () => () => undefined;
const noSnapshot = () => null;

/** 선택한 언어의 `formatMessage`. 언어가 바뀌면(스냅샷이 갈린다) 다시 그려진다. */
export function useFormatMessage(): MessageService["formatMessage"] {
  const locale = useAppLocale();
  useSyncExternalStore(
    locale ? locale.subscribe : noSubscribe,
    locale ? locale.getSnapshot : noSnapshot,
    locale ? locale.getSnapshot : noSnapshot
  );
  return locale ? locale.service.formatMessage : bundledEnglish.formatMessage;
}
