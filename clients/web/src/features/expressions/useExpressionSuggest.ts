import { useEffect, useReducer, useRef, useState } from "react";
import { EXPRESSION_SUGGEST_DEBOUNCE_MS, planExpressionSuggest, type ExpressionSuggestTrigger } from "@momo/core/features/expressions/suggest";
import { recentExpressions } from "@momo/core/features/expressions/usage";
import type { Expression } from "@momo/core/features/expressions/types";
import { useExpressions } from "./context";
import { useExpressionSuggestOn } from "./suggestSetting";
import { muteKeywords, mutedKeywords } from "@momo/core/features/expressions/suggestMute";

// =============================================================================
// 글을 치다 멈추면 입력창 위에 띄우는 이모티콘·GIF 추천 (#5476, 코어 #5454 1단계). 이 훅이 가진 것은 **시계와 입력 연결**이다: 줄을 띄울지·무엇을 보일지·
// 닫힘이 풀리는지는 코어 `planExpressionSuggest` 한 곳이 정하고(#5602, 규칙은 코어 `suggest.ts` 머리말 「언제 띄우는가」), 그것은 순수 함수라 입력한 글이 기기 밖으로
// 나갈 길이 없다(이 훅도 네트워크·서버 요청을 하지 않는다).
//
//   · 글이 바뀌면 줄은 **그 순간** 사라지고(아래 `shown.text` 와 지금 글을 비교한다) 기다림이 처음부터 다시 시작한다. 0.3초(`EXPRESSION_SUGGEST_DEBOUNCE_MS`)
//     동안 글이 그대로일 때 코어에 묻는다. 캐럿은 그 순간 입력칸에서 읽는다(`readCaret`) — 캐럿만 옮긴 것(클릭·화살표)은 다시 묻지 않는다: 방금 **친** 낱말이 기준이다.
//     글이 비면 기다리지 않고 바로 묻는다 — 줄이 설 수 없는 때에도(보냈거나 다 지웠으면 닫힘이 그 자리에서 풀린다: 곧바로 같은 낱말을 다시 쳐도 선다).
//   · 줄은 **방금 친 낱말이 키워드일 때만** 선다(#5602 M1). 서면 문구 안에서 맞은 낱말 모두의 그림이 낱말이 나온 차례로 한 줄에 선다(#5588).
//   · `close()`: Esc·고른 뒤. 줄을 띄운 낱말을 닫힘으로 기억하고 다음 물음에 넘긴다 — **다음 키워드까지** 닫혀 있다(「ㅋㅋ」에서 닫고 「ㅋㅋㅋ」로 늘려도 안 선다).
//     닫힘은 이 대화의 것이다(대화를 옮기면 놓는다).
//   · `mute()`: ✕. 줄을 띄운 **그 낱말 하나만** 이 대화에서 끈다(`suggestMute`, #5602 M2 — 이름 「이 낱말 추천 끄기」와 같은 수).
//   · `enabled` 가 거짓이면(오프라인·이미 미리 본 그림이 있음·멘션 목록이나 명령이 열려 있음) 줄이 없다. 보관함이 아직 안 왔거나 읽지 못했을 때도
//     없다: 그림이 없는 줄을 보이지 않는다. 보관함 상태의 안내는 이모티콘 창이 말하고, 이 줄은 맞는 것이 있을 때만 선다.
//   · 설정 › 모양 › 「이모티콘 추천」(#5493)을 끄면 줄이 **아예** 서지 않는다(`enabled` 와 같은 칸이지만 사람이 정한 것이라 이 훅이 직접 읽는다 - 이 훅을 쓰는 입력창은 모두 따라온다).
//     끄면 그 순간 줄이 걷히고 다시 켜면 이미 친 글에 대해 0.3초 뒤 다시 선다(`active` 가 효과의 의존이라 기다림이 처음부터 다시 시작한다) - 앱을 다시 켤 필요가 없다.
// 즐겨찾기·최근 쓴 차례는 맞는 것들의 **순서**만 바꾼다(코어가 채워 넣지 않는다).
// =============================================================================

const NONE: readonly Expression[] = [];

export interface ExpressionSuggest {
  /** 줄에 세울 그림들(1~5개, 낱말이 나온 차례로 묶음). 줄이 없으면 빈 목록이다. */
  items: readonly Expression[];
  open: boolean;
  /** Esc·고른 뒤: 줄을 닫고 다음 키워드까지 닫아 둔다. 쓴 글과 끈 낱말은 그대로다. */
  close: () => void;
  /** ✕: 줄을 띄운 낱말 하나를 이 대화에서 끈다. */
  mute: () => void;
}

export function useExpressionSuggest({
  workspaceId,
  channelId,
  text,
  readCaret,
  enabled,
}: {
  workspaceId: string;
  channelId: string;
  /** 입력칸의 지금 글(초안). */
  text: string;
  /** 쉼이 끝나는 순간의 캐럿(입력칸의 `selectionStart`). 모르면 `null` 이고 코어가 글 끝으로 본다. */
  readCaret?: () => number | null;
  enabled: boolean;
}): ExpressionSuggest {
  const { store, cache, usage, favorites, failure, offline } = useExpressions();
  const scope = `${workspaceId}:${channelId}`;
  // 사람이 설정에서 정한 켬·끔(#5493). 이 기기 · 이 워크스페이스 · 이 사람 기준이라 보관함 저장소가 아는 사람 id 로 읽는다(저장소가 없으면 어차피 줄이 없다).
  const suggestOn = useExpressionSuggestOn(store?.workspaceId ?? "", store?.memberId ?? "");
  // 설정이 켜져 있고, 보관함을 한 번 받았고(`version`) 마지막 읽기가 실패하지 않았고(`failure` 가 비어 있다) 보관함 저장소가 오프라인이 아닐 때만 선다: 아직 안 왔거나, 읽지 못했거나,
  // 그림 바이트를 받을 수 없으면 보일 그림이 없다.
  const active = enabled && suggestOn && cache.version !== null && failure === null && !offline;
  const [shown, setShown] = useState<{ scope: string; text: string; items: readonly Expression[]; trigger: ExpressionSuggestTrigger } | null>(null);
  // Esc·고른 뒤의 닫힘(코어가 돌려준 값을 다음 물음에 그대로 넘긴다). 효과의 의존이 아니라 기다림이 끝나는 순간 읽는다 — 닫힘이 바뀌었다고 다시 묻지 않는다.
  const [dismissed, setDismissed] = useState<{ scope: string; trigger: ExpressionSuggestTrigger } | null>(null);
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;
  const readCaretRef = useRef(readCaret);
  readCaretRef.current = readCaret;
  // 끈 낱말은 모듈 기억에 있다(`suggestMute`): 바꾸면 이 훅을 다시 그리게 한다.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    setShown(null);
    // 빈 글(보냈거나 다 지웠다)은 기다리지 않고, 줄이 설 수 없는 때(미리 보기가 있음·오프라인 따위)에도 바로 묻는다: 닫힘이 풀리는 것은 그 순간이어야 한다 -
    // 미리 보기를 올린 채 보내고 같은 낱말을 다시 쳐도 선다. 빈 글에는 그림이 없으니 보관함을 넘기지 않는다.
    if (text.trim() === "") {
      const plan = planExpressionSuggest({ text, dismissal: dismissedRef.current?.trigger ?? null }, NONE);
      if (plan.dismissal === null && dismissedRef.current !== null) setDismissed(null);
      return;
    }
    if (!active) return;
    const timer = window.setTimeout(() => {
      const held = dismissedRef.current;
      const plan = planExpressionSuggest(
        { text, caret: readCaretRef.current?.() ?? null, dismissal: held !== null && held.scope === scope ? held.trigger : null },
        cache.items,
        { recent: recentExpressions(usage).map((entry) => entry.id), favorites: favorites.ids, muted: mutedKeywords(scope) }
      );
      const next = plan.dismissal === null ? null : { scope, trigger: plan.dismissal };
      if (next?.trigger !== held?.trigger || next?.scope !== held?.scope) setDismissed(next);
      setShown(plan.trigger !== null && plan.items.length > 0 ? { scope, text, items: plan.items, trigger: plan.trigger } : null);
    }, EXPRESSION_SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, active, scope, cache.items, usage, favorites]);

  const current = active && shown !== null && shown.scope === scope && shown.text === text ? shown : null;
  const items = current !== null ? current.items : NONE;
  return {
    items,
    open: items.length > 0,
    close: () => {
      if (current !== null) setDismissed({ scope, trigger: current.trigger });
      setShown(null);
    },
    mute: () => {
      if (current !== null) muteKeywords(scope, [current.trigger.keyword]);
      setShown(null);
      redraw();
    },
  };
}
