import {
  pickReleaseNoteLocale,
  type ReleaseNoteLocale,
} from "@momo/core/features/releaseNotes/model";
import type { MessageService } from "@momo/core/i18n";
import { useMessages } from "@/i18n/useMessages";

/** 업데이트 소식 화면이 읽는 문구 서비스와, 소식 파일의 ko·en 중 쓸 쪽. 사전이 없는 언어는 영어 문장이다. */
export function useReleaseNotesMessages(): { messages: MessageService; noteLocale: ReleaseNoteLocale } {
  const messages = useMessages();
  return { messages, noteLocale: pickReleaseNoteLocale(messages.messageLocale) };
}
