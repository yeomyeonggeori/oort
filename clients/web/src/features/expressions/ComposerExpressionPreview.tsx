import type { KeyboardEvent } from "react";
import { X } from "lucide-react";
import { composerKeyIntent, isComposingEvent } from "@momo/core/features/chat/composerKeys";
import type { Expression } from "@momo/core/features/expressions/types";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { ExpressionImage } from "./ExpressionImage";

// =============================================================================
// 입력창 위의 이모티콘 미리 보기 (#5453, owner 2026-11-07, 카카오톡 레퍼런스).
//
// 이모티콘 창에서 이모티콘이나 GIF 를 고르면 입력창 **위에** 크게 선다. 이 줄에는 **그림과 작은 ✕ 뿐**이다: 설명 글도 힌트 글도 두지 않는다
// (owner 「보내기를 누르면 글과 같이가요 라든지 미리보기 X로 지우기 같은 텍스트는 같이 노출 안하고」). 이름(aria-label)은 낭독을 위해 남긴다.
// 보내는 단추도 여기 없다 — 입력창의 보내기와 ↵ 가 글과 함께 보낸다(표현 메시지 → 글 메시지, 코어 `sendBundle.ts`).
//
// 그림은 `ExpressionImage` 그대로다(불러오는 중·실패·다시 불러오기·움직임 멈춤은 그 부품이 말한다). 이 줄이 더하는 것은 자리와 ✕ 하나다.
// 표현이 그 사이에 숨겨졌거나 지워졌으면(`gone`) 그림 자리에 **무슨 일이 일어났고 무엇을 할지** 한 문장만 선다(오류 상태) — 보내기는 막힌다.
//
// 키보드: ✕ 는 Tab 으로 닿고, 이 줄 안의 Esc 는 미리 보기를 지운다(입력칸의 Esc 는 호출한 쪽이 같은 선택으로 받는다). 호출한 쪽이 지운 뒤 포커스를
// 입력칸으로 돌려준다 — 눌린 버튼이 사라지므로 포커스가 갈 곳을 잃지 않게.
// =============================================================================

export function ComposerExpressionPreview({
  expression,
  gone,
  onCancel,
  testId = "composer-expression-preview",
}: {
  expression: Expression;
  /** 고른 표현이 더는 쓸 수 없다(숨김·삭제). 그림 대신 한 문장을 보이고 ✕ 로 치우게 한다. */
  gone: boolean;
  /** ✕·Esc. 호출한 쪽이 입력칸으로 포커스를 돌려준다. */
  onCancel: () => void;
  testId?: string;
}) {
  const formatMessage = useFormatMessage();
  const cancelLabel = formatMessage("expressions.preview.cancel", { name: expression.displayName });
  // 파생 열쇠는 JSX 밖에서 만든다: 직접 문구 장부는 JSX 표현식 안의 문자열 조각을 문구로 센다.
  const cancelTestId = `${testId}-cancel`;
  const goneTestId = `${testId}-gone`;
  // 어느 키가 「치우기」인지는 링크 미리보기 줄과 같은 코어 규칙이 답한다(여기서 키 이름을 다시 적지 않는다).
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
    event.stopPropagation();
    onCancel();
  };
  return (
    <div
      role="group"
      aria-label={formatMessage("expressions.preview.group")}
      className="attachment-tray"
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {/* 그림이 오기 전에도 상자가 서 있어 도착 순간에 입력창이 한 번에 자라지 않는다(`min-h-tray-card`). 아래 8은 그림과 입력 카드 사이다: 이 줄은
          넓은 창에서 아래 여백이 없는 띠(`attachment-tray`)라서 그림이 카드 윗변에 바짝 붙는다. */}
      <div className="relative mb-2 inline-flex min-h-tray-card min-w-tray-card items-center justify-center rounded-md">
        {gone ? (
          <p role="alert" className="max-w-pane-sm py-2 pr-8 text-meta text-warn" data-testid={goneTestId}>
            {formatMessage("expressions.sheet.unavailable")}
          </p>
        ) : (
          <ExpressionImage item={expression} size="large" />
        )}
        <button
          type="button"
          aria-label={cancelLabel}
          className="tap-target absolute right-1 top-1 layer-content-float flex size-control-sm items-center justify-center rounded-full bg-surface-raised text-ink-muted shadow-sm press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
          onClick={onCancel}
          data-testid={cancelTestId}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
