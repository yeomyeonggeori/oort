import { messageAnchorPath } from "@/features/inbox/anchor";

/** root는 서버가 보내 준 소속만 읽어요. 없으면 현행 카드 주소로 폴백해요. */
export function requestNotificationTarget(channelId: string, messageId: string, rootId?: string | null): string {
  const path = messageAnchorPath(channelId, messageId);
  return rootId ? `${path}&thread=${encodeURIComponent(rootId.toLowerCase())}` : path;
}
