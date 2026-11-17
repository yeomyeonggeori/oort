import { useSyncExternalStore } from "react";
import { useAppLocale } from "./localeContext";

const noopSubscribe = () => () => {};
const none = () => undefined;
// 시험용 가짜 언어 맥락처럼 `context` 가 없는 스냅샷도 견딘다.
const read = (locale: NonNullable<ReturnType<typeof useAppLocale>>) => () =>
  locale.getSnapshot().context?.messageLocale;

/**
 * 채널 이름을 클라이언트가 세울 때 쓰는 화면 언어(ADR-0225 D12). 앱 바깥(언어 맥락이 없는
 * 격리 화면)에서는 `undefined` — 부르는 쪽은 그때 차례를 바꾸지 않는다.
 */
export function useChannelNameLocale(): string | undefined {
  const locale = useAppLocale();
  return useSyncExternalStore(
    locale?.subscribe ?? noopSubscribe,
    locale ? read(locale) : none,
    locale ? read(locale) : none
  );
}
