import { forwardRef, useId, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { isComposingEvent, suggestRowKey } from "@momo/core/features/chat/composerKeys";
import type { Expression } from "@momo/core/features/expressions/types";
import { moveTarget, rovingStop } from "@/features/attachments/trayModel";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { ExpressionImage } from "./ExpressionImage";

// =============================================================================
// 입력창 위의 이모티콘 추천 줄 (#5476, owner 2026-11-07 「안내 글 없이 카카오톡처럼」). 글을 치다 0.3초 멈췄을 때 문구 안의 낱말(짧은 글이면 글 전체도)이 꼬리표·이름과
// 맞으면 그림 몇 개(1~5)가 입력창 바로 위에 **얇게 뜬다**. 여러 낱말이 맞으면 낱말이 나온 차례로 한 줄에 함께 선다(#5588: 「ㅋㅋ 개웃기네 진심」 → ㅋㅋ 쪽 + 진심 쪽). 이 줄에는 **그림과 끝의 작은 ✕ 뿐**이다: 안내 글도 힌트 글도 두지 않는다(이름은 낭독용 aria-label 에만).
// 무엇을 보일지(맞추기·순서·꺼 둔 낱말)는 코어 `suggestExpressions` 와 `useExpressionSuggest` 가 정한다. 이 파일이 더하는 것은 자리와 키보드다.
//
// 자리: **입력창 한 벌(독)의 맨 위**에 서는 절대 위치 창이다(#5489 H1). 줄이 서고 사라질 때마다 흐름 안에서 자리를 먹으면 글을 치다 멈출 때마다 대화 목록이
// 위아래로 흔들린다(#4619·#1749 의 「입력창이 움직이면 안 된다」). 그래서 대화 목록 위로 떠서 자리를 먹지 않는다. 기준 상자는 입력 폼이 아니라 이 부품이
// 그리는 높이 0 의 `relative` 상자이고, 호출한 쪽(`Composer`)이 그것을 **독의 첫 자식**으로 세운다: 폼 앞에는 에이전트 활동 레일·예약 배너·상태 줄·링크 카드·
// 미리 보기가 흐름 안에 서는데, 폼을 기준으로 하면 줄이 그것들(이번 Enter 로 함께 나갈 것·지금 에이전트가 하는 일)을 덮었다. 독 맨 위를 기준으로 하면 줄은 그 위의
// 대화 목록 위에만 선다. 가로는 입력 카드의 왼쪽 가장자리다(폰 폭 12, 넓은 창 24: `expressions.css`).
// 이미 고른 미리 보기가 있으면 줄이 서지 않는다(보내기 한 번에 큰 그림은 하나이고, 미리 보기 그림을 가리지 않는다) - 호출한 쪽이 `enabled` 로 정한다.
//
// 누르면 **고르기만** 한다(호출한 쪽이 입력창 위 미리 보기에 올린다): 저절로 보내지 않는다. 입력칸의 Enter 는 이 줄이 떠 있어도 보내기 그대로이고 이 줄을 고르지 않는다.
// 글이 그 낱말뿐이면 호출한 쪽이 글을 지워 그림으로 바꾸고, 낱말이 문구 안에 있으면 글을 두고 그림을 더한다(#5588, 코어 `suggestPickMode`).
//
// 키보드: 줄은 도구줄(`toolbar`)이고 탭 정거장이 하나다(로빙: 그림들과 ✕ 가 한 정거장을 나눠 쓴다). 입력칸에서 ↑(캐럿이 첫 **화면** 줄일 때: `caretLine`)나
// Shift+Tab(줄이 독 맨 위라 보이는 순서대로 사이에 있는 레일·카드 ✕ 를 먼저 지난다)으로 들어오고,
// ← → Home End 가 줄 안을 움직이고, Enter·Space 는 포커스가 놓인 단추를 누르고, ↓ 는 입력칸으로 돌아가고, Esc 는 줄을 닫는다. 키 이름은 코어
// (`suggestRowKey`)가 읽는다 - 이 파일은 키 이름을 적지 않는다. 호출한 쪽이 닫은 뒤 포커스를 입력칸으로 돌려준다(눌린 단추가 사라지므로).
//
// 포커스가 입력창 밖으로 나가면(대화 목록을 누르거나 다른 창으로 갈 때) 줄은 CSS 로 물러났다가(`expressions.css`) 돌아오면 다시 선다: 떠 있는 줄이 읽는 것을 가리지 않게.
//
// 그림은 `ExpressionImage` 그대로(`still`: 움직이는 GIF 도 줄에서는 멈춘 그림이다)고, 그림이 오기 전과 실패했을 때의 `:이름:` 자리표시는 칸 안에서 숨긴다(`expressions.css`).
// =============================================================================

export interface ExpressionSuggestHandle {
  /** 줄의 탭 정거장(기억해 둔 단추, 처음엔 첫 그림)으로 포커스를 옮긴다. */
  focus: () => void;
}

export const ComposerExpressionSuggest = forwardRef<
  ExpressionSuggestHandle,
  {
    items: readonly Expression[];
    /** 그림을 눌렀다(Enter·Space 도 같다). 보내지 않는다. */
    onPick: (item: Expression) => void;
    /** ✕: 이 대화에서 이 낱말 추천을 끈다. */
    onMute: () => void;
    /** Esc: 줄만 닫는다. */
    onDismiss: () => void;
    /** ↓: 줄을 닫지 않고 입력칸으로 돌아간다. */
    onReturn: () => void;
    testId?: string;
  }
>(function ComposerExpressionSuggest({ items, onPick, onMute, onDismiss, onReturn, testId = "composer-expression-suggest" }, ref) {
  const formatMessage = useFormatMessage();
  const muteStop = useId();
  const stops = useRef(new Map<string, HTMLButtonElement>());
  const [remembered, setRemembered] = useState<string | null>(null);
  const ids = [...items.map((item) => item.id), muteStop];
  const stop = rovingStop(ids, remembered);
  // 파생 열쇠는 JSX 밖에서 만든다: 직접 문구 장부는 JSX 표현식 안의 문자열 조각을 문구로 센다.
  const itemTestId = `${testId}-item`;
  const muteTestId = `${testId}-mute`;
  const anchorTestId = `${testId}-anchor`;
  const register = (id: string) => (node: HTMLButtonElement | null) => {
    if (node) stops.current.set(id, node);
    else stops.current.delete(id);
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (stop !== null) stops.current.get(stop)?.focus();
    },
  }));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const intent = suggestRowKey({
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      composing: isComposingEvent(event.nativeEvent),
    });
    if (intent === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (intent.dismiss) return onDismiss();
    if (intent.toInput) return onReturn();
    const from = ids.find((id) => stops.current.get(id) === event.target) ?? stop;
    if (from === null || intent.move === undefined) return;
    const target = moveTarget(ids, from, intent.move);
    if (target !== null) stops.current.get(target)?.focus();
  };

  return (
    // 기준 상자: 높이 0 이라 흐름에 자리를 먹지 않는다(독의 첫 자식). 줄은 이 상자의 맨 위(= 독의 맨 위)에서 `bottom-full` 로 위로 선다.
    <div className="relative" data-testid={anchorTestId}>
      {/* 줄 한 벌이 한 컨트롤이다: 누른 단추가 입력칸의 캐럿과 선택을 뺏지 않게 마우스를 누르는 순간의 포커스 이동을 막는다(멘션 목록 행과 같은 규율). */}
      <div
        role="toolbar"
        aria-label={formatMessage("expressions.suggest.group")}
        aria-orientation="horizontal"
        data-testid={testId}
        className="expression-suggest-row absolute bottom-full left-3 mb-2 flex max-w-full items-center gap-1 rounded-lg border border-line bg-surface-raised p-1 shadow-lg"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.preventDefault()}
      >
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {items.map((item) => (
            <button
              key={item.id}
              ref={register(item.id)}
              type="button"
              tabIndex={stop === item.id ? 0 : -1}
              aria-label={formatMessage("expressions.suggest.pick", { name: item.displayName })}
              data-testid={itemTestId}
              data-expression-id={item.id}
              className="expression-suggest-cell tap-target flex size-control-lg shrink-0 items-center justify-center overflow-hidden rounded-md p-1 press hover:bg-surface-hover focus-visible:focus-ring"
              onFocus={() => setRemembered(item.id)}
              onClick={() => onPick(item)}
            >
              <ExpressionImage item={item} size="medium" still />
            </button>
          ))}
        </div>
        <button
          ref={register(muteStop)}
          type="button"
          tabIndex={stop === muteStop ? 0 : -1}
          aria-label={formatMessage("expressions.suggest.mute")}
          data-testid={muteTestId}
          className="tap-target flex size-control-sm shrink-0 items-center justify-center rounded-full text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
          onFocus={() => setRemembered(muteStop)}
          onClick={onMute}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
});
