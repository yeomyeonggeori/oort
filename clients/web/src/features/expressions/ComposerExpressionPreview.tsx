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
// ## 크기 (#5487 M2, owner 11-07 웹 목업 `.w-preview`)
//
// 옅은 테두리 카드 안에 **56px 그림**이 서고 ✕ 는 그림 **옆**에 선다. 처음 판은 타임라인의 큰 그림과 같은 200×200 에 ✕ 를 모서리에 얹어서, 데스크탑 최소 창
// (720×480)에서 대화가 80px 만 남았다(검증 7a M2). 채널 입력창과 스레드 입력창이 이 한 부품을 같이 쓴다. 그림의 크기는 `expressions.css` 의 `.expression-preview-card`
// 규칙이 정한다(`ExpressionImage` 의 칸 예약 `<canvas>` 도 같은 규칙을 받아서, 그림이 오는 순간 카드가 자라지 않는다). 목업의 12px 반경·10px 간격은 이 시스템의
// 사다리(반경 10/14, 간격 8/12) 밖이라 가장 가까운 사다리 값(`rounded-md`·`gap-2`·`px-3 py-2`)으로 옮겼다.
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
      {/* 그림이 오기 전에도 56 칸이 서 있어 도착 순간에 입력창이 자라지 않는다(`expressions.css`). 아래 8은 카드와 입력 카드 사이다: 이 줄은 넓은 창에서
          아래 여백이 없는 띠(`attachment-tray`)라서 카드가 입력 카드 윗변에 바짝 붙는다. ✕ 는 그림 옆의 납작한 원이다(모서리에 얹지 않는다). */}
      <div className="expression-preview-card mb-2 inline-flex max-w-full items-center gap-2 rounded-md border border-line bg-surface-muted px-3 py-2">
        {gone ? (
          <p role="alert" className="max-w-pane-sm text-meta text-warn" data-testid={goneTestId}>
            {formatMessage("expressions.sheet.unavailable")}
          </p>
        ) : (
          <ExpressionImage item={expression} size="large" />
        )}
        <button
          type="button"
          aria-label={cancelLabel}
          className="tap-target flex size-control-sm shrink-0 items-center justify-center rounded-full text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
          onClick={onCancel}
          data-testid={cancelTestId}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
