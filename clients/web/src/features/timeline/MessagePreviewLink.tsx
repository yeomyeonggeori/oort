import { messageAnchorPath } from "@/features/inbox/anchor";
import {
  MESSAGE_PREVIEW_LINK_LABEL,
  type MessagePreview,
} from "@momo/core/features/approvals/messagePreview";

// =============================================================================
// 고정·고정 풀기 카드의 「전문 보기」 (ADR-0186 증보 v5 U-e, #4705)
//
// 카드 행은 서버가 읽은 메시지의 앞 120자와 글자 수를 말한다. 승인하는 사람이 자기가 읽지 않은
// 글을 채널 맨 위에 올리지 않도록, 그 메시지가 있는 자리로 가는 문 하나를 결정 버튼 바로 위에
// 세운다(링크 하나뿐이다: 새 문구·새 블록 없음). 문은 앱 안의 해시 경로다(`ActionResultCard` 의
// `next` 와 같은 모양, Router 컨텍스트가 필요 없다). 결정이 난 카드에는 서지 않는다.
// =============================================================================
export function MessagePreviewLink({ preview }: { preview: MessagePreview }) {
  return (
    <div className="border-t border-line px-3 py-2" data-testid="approval-message-preview">
      <a
        href={`#${messageAnchorPath(preview.channelId, preview.messageId)}`}
        className="press rounded-sm text-meta text-signal-text underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring"
        data-testid="approval-message-preview-link"
      >
        {MESSAGE_PREVIEW_LINK_LABEL}
      </a>
    </div>
  );
}
