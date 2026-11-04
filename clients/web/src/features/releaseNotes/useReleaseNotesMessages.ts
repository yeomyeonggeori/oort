import type { MessageService } from "@momo/core/i18n";
import { useMessages } from "@/i18n/useMessages";

/**
 * 업데이트 소식 화면이 읽는 문구 서비스. 소식의 글도 화면 문구와 같은 사전의 키라서(`ReleaseNote`의 `summary`·`title`…),
 * 소식 쪽에 언어 갈래가 없다: 사전이 없는 언어는 사전의 영어 대체를 그대로 탄다(ADR-0213, #5054).
 */
export function useReleaseNotesMessages(): { messages: MessageService } {
  return { messages: useMessages() };
}
