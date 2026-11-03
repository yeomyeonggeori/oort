import { useSyncExternalStore } from "react";
import { createMessageService, type MessageService } from "@momo/core/i18n";
import { useAppLocale } from "./localeContext";

// 사전에서 문구를 읽는 화면이 쓰는 한 줄 (#4937). 앱의 언어 서비스가 있으면 그것을 구독하고(언어를 바꾸면 바로 다시
// 그린다), 없으면(provider가 없는 독립 fixture·시험) 코어에 묶인 영어 사전으로 읽는다. 제품 앱은 늘 provider 안이다
// (`main.tsx`). 새 화면은 `locale.service`를 직접 쥐지 말고 이것을 쓴다: 구독과 대체가 한 곳에 있다.
const FALLBACK: MessageService = createMessageService({ messageLocale: "en-US" });
const NO_SUBSCRIBE = () => () => {};
const NO_SNAPSHOT = () => null;

export function useMessages(): MessageService {
  const locale = useAppLocale();
  useSyncExternalStore(
    locale ? locale.subscribe : NO_SUBSCRIBE,
    locale ? locale.getSnapshot : NO_SNAPSHOT,
    locale ? locale.getSnapshot : NO_SNAPSHOT,
  );
  return locale ? locale.service : FALLBACK;
}
