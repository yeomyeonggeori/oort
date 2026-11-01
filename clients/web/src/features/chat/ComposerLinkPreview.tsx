import type { KeyboardEvent } from "react";
import { X } from "lucide-react";
import { composerKeyIntent, isComposingEvent } from "@momo/core/features/chat/composerKeys";
import { unfurlDrawsCards, type UnfurlPreviewCard } from "@momo/core/features/timeline/unfurl";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { useLinkPreviewPreference } from "@/features/timeline/linkPreviewPreference";
import { UnfurlCard } from "@/features/timeline/UnfurlCards";

// =============================================================================
// 입력칸 위의 링크 미리보기 (#5005). 카드 한 장은 타임라인 카드와 같은 컴포넌트(`UnfurlCard`)이고,
// 무엇을 보일지는 코어 표시 모델이 정한다(작게·크게는 이 기기의 설정을 따른다). 이 파일이 더하는 것은
// 줄의 자리와 「이번 메시지는 미리보기 없이 보내기」(✕) 하나다.
//
// 자리: 첨부 트레이와 같은 줄 모양(`attachment-tray`: 폰에서는 구분선이 있는 띠, 넓은 창에서는 입력 카드
// 가장자리에 맞춘 좌우 24)이다. 줄은 **폼 밖**이다 — ✕가 보내기 폼의 제출을 일으키지 않게, 그리고
// 입력 그릇을 눌러 캐럿을 돌려주는 규칙(그릇 안 클릭)에 카드 링크가 섞이지 않게. 카드는 늘 입력칸 위에서
// 자라므로, 줄 높이는 트레이와 같은 상한으로 묶고 넘치면 줄 안에서 스크롤한다.
//
// ✕는 첫 카드에 한 개다. 끄는 범위는 카드 한 장이 아니라 **이번 메시지의 미리보기 전체**이기 때문이다
// (타임라인의 제거 칩과 같은 자리·같은 모양).
// =============================================================================

export function ComposerLinkPreview({
  cards,
  suppressed,
  onDismiss,
}: {
  cards: readonly UnfurlPreviewCard[];
  /** ✕를 누른 직후: 카드는 사라졌고, 이 메시지가 어떻게 나가는지를 낭독으로만 알린다. */
  suppressed: boolean;
  /** ✕·Esc. 호출한 쪽이 입력칸으로 포커스를 돌려준다(버튼이 사라지면 포커스가 갈 곳을 잃는다). */
  onDismiss: () => void;
}) {
  const formatMessage = useFormatMessage();
  const preference = useLinkPreviewPreference();
  const dismissLabel = formatMessage("timeline.unfurl.previewDismiss");
  // 포커스가 카드나 ✕에 있을 때의 Esc. 입력칸에 있을 때의 Esc는 입력칸의 키 규칙이 받는다. 어느 키가
  // 「카드 닫기」인지는 같은 코어 규칙이 답한다(여기서 키 이름을 다시 적지 않는다).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const intent = composerKeyIntent(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        composing: isComposingEvent(event.nativeEvent),
      },
      { mentionsOpen: false, justComposed: false, enterSends: false, previewOpen: true }
    );
    if (intent !== "preview-dismiss") return;
    event.preventDefault();
    onDismiss();
  };
  return (
    <>
      {unfurlDrawsCards(preference) && cards.length > 0 ? (
        <div
          role="group"
          aria-label={formatMessage("timeline.unfurl.previewGroup")}
          className="attachment-tray"
          data-testid="composer-link-preview"
          onKeyDown={onKeyDown}
        >
          <div className="flex max-h-tray-max max-w-pane-lg flex-col gap-1 overflow-y-auto">
            {cards.map((card, index) => (
              <div
                key={card.id}
                className="relative isolate flex shrink-0 rounded-md bg-surface-muted"
              >
                <UnfurlCard unfurl={card} preference={preference} />
                {index === 0 ? (
                  <button
                    type="button"
                    aria-label={dismissLabel}
                    title={dismissLabel}
                    className="tap-target absolute right-1 top-1 layer-content-float flex size-control-sm items-center justify-center rounded-sm border border-line-strong bg-surface-raised text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
                    onClick={onDismiss}
                    data-testid="composer-link-preview-dismiss"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {/* 늘 붙어 있는 낭독 노드: 조건부로 처음 생기는 라이브 리전은 낭독이 보장되지 않는다(예약 확정 줄과 같은 이유). */}
      <p role="status" className="sr-only" data-testid="composer-link-preview-status">
        {suppressed ? formatMessage("timeline.unfurl.previewDismissed") : ""}
      </p>
    </>
  );
}
