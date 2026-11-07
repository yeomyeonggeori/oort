import { useEffect, useReducer, useState } from "react";
import { EXPRESSION_SUGGEST_DEBOUNCE_MS, suggestExpressions, suggestionKeywords } from "@momo/core/features/expressions/suggest";
import { recentExpressions } from "@momo/core/features/expressions/usage";
import type { Expression } from "@momo/core/features/expressions/types";
import { useExpressions } from "./context";
import { useExpressionSuggestOn } from "./suggestSetting";
import { muteKeywords, mutedKeywords } from "@momo/core/features/expressions/suggestMute";

// =============================================================================
// 글을 치다 멈추면 입력창 위에 띄우는 이모티콘·GIF 추천 (#5476, 코어 #5454 1단계). 이 훅이 가진 것은 **시계와 기억**이다: 맞추는 일은 코어
// `suggestExpressions` 가 하고, 그것은 순수 함수라 입력한 글이 기기 밖으로 나갈 길이 없다(이 훅도 네트워크·서버 요청을 하지 않는다).
//
//   · 글이 바뀌면 줄은 **그 순간** 사라지고(아래 `shown.text` 와 지금 글을 비교한다) 기다림이 처음부터 다시 시작한다. 0.3초(`EXPRESSION_SUGGEST_DEBOUNCE_MS`)
//     동안 글이 그대로일 때만 맞춰 본다. 맞는 것이 없으면 줄은 없다.
//   · `close()`: Esc·고른 뒤. **이 글**에 대해서만 줄을 닫는다(글이 바뀌면 다시 맞춘다). 낱말을 끄는 것이 아니다.
//   · `mute()`: ✕. 지금 글의 낱말 **모두**(`suggestionKeywords`: 마지막 낱말과 짧은 글 전체)를 이 대화에서 끈다. 마지막 낱말만 끄면 줄이 글 전체 낱말로 떴을 때
//     (「킹 받네」 → 「킹받네」 꼬리표) 나중에 「킹받네」만 쳤을 때 줄이 다시 뜬다.
//   · `enabled` 가 거짓이면(오프라인·이미 미리 본 그림이 있음·멘션 목록이나 명령이 열려 있음) 줄이 없다. 보관함이 아직 안 왔거나 읽지 못했을 때도
//     없다: 그림이 없는 줄을 보이지 않는다. 보관함 상태의 안내는 이모티콘 창이 말하고, 이 줄은 맞는 것이 있을 때만 선다.
//   · 설정 › 모양 › 「이모티콘 추천」(#5493)을 끄면 줄이 **아예** 서지 않는다(`enabled` 와 같은 칸이지만 사람이 정한 것이라 이 훅이 직접 읽는다 - 이 훅을 쓰는 입력창은 모두 따라온다).
//     끄면 그 순간 줄이 걷히고 다시 켜면 이미 친 글에 대해 0.3초 뒤 다시 선다(`active` 가 효과의 의존이라 기다림이 처음부터 다시 시작한다) - 앱을 다시 켤 필요가 없다.
// 즐겨찾기·최근 쓴 차례는 맞는 것들의 **순서**만 바꾼다(코어가 채워 넣지 않는다).
// =============================================================================

const NONE: readonly Expression[] = [];

export interface ExpressionSuggest {
  /** 줄에 세울 그림들(1~5개). 줄이 없으면 빈 목록이다. */
  items: readonly Expression[];
  open: boolean;
  /** Esc·고른 뒤: 이 글에 대해 줄을 닫는다. 쓴 글과 끈 낱말은 그대로다. */
  close: () => void;
  /** ✕: 지금 글의 낱말들을 이 대화에서 끈다. */
  mute: () => void;
}

export function useExpressionSuggest({
  workspaceId,
  channelId,
  text,
  enabled,
}: {
  workspaceId: string;
  channelId: string;
  /** 입력칸의 지금 글(초안). */
  text: string;
  enabled: boolean;
}): ExpressionSuggest {
  const { store, cache, usage, favorites, failure, offline } = useExpressions();
  const scope = `${workspaceId}:${channelId}`;
  // 사람이 설정에서 정한 켬·끔(#5493). 이 기기 · 이 워크스페이스 · 이 사람 기준이라 보관함 저장소가 아는 사람 id 로 읽는다(저장소가 없으면 어차피 줄이 없다).
  const suggestOn = useExpressionSuggestOn(store?.workspaceId ?? "", store?.memberId ?? "");
  // 설정이 켜져 있고, 보관함을 한 번 받았고(`version`) 마지막 읽기가 실패하지 않았고(`failure` 가 비어 있다) 보관함 저장소가 오프라인이 아닐 때만 선다: 아직 안 왔거나, 읽지 못했거나,
  // 그림 바이트를 받을 수 없으면 보일 그림이 없다.
  const active = enabled && suggestOn && cache.version !== null && failure === null && !offline;
  const [shown, setShown] = useState<{ scope: string; text: string; items: readonly Expression[] } | null>(null);
  const [closed, setClosed] = useState<{ scope: string; text: string } | null>(null);
  // 끈 낱말은 모듈 기억에 있다(`suggestMute`): 바꾸면 이 훅을 다시 그리게 한다.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    setShown(null);
    if (!active || text.trim() === "") return;
    const timer = window.setTimeout(() => {
      const items = suggestExpressions(text, cache.items, {
        recent: recentExpressions(usage).map((entry) => entry.id),
        favorites: favorites.ids,
        muted: mutedKeywords(scope),
      });
      setShown(items.length > 0 ? { scope, text, items } : null);
    }, EXPRESSION_SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, active, scope, cache.items, usage, favorites]);

  // 닫은 글에서 한 글자라도 바뀌면 닫힘은 풀린다: 글을 지웠다가 같은 낱말을 다시 치면 새로 맞춘다(닫힘은 「이 글」에 대한 것이다).
  useEffect(() => {
    setClosed(null);
  }, [text, scope]);

  const current = active && shown !== null && shown.scope === scope && shown.text === text ? shown : null;
  const dismissed = closed !== null && closed.scope === scope && closed.text === text;
  const items = current !== null && !dismissed ? current.items : NONE;
  return {
    items,
    open: items.length > 0,
    close: () => setClosed({ scope, text }),
    mute: () => {
      muteKeywords(scope, suggestionKeywords(text));
      setShown(null);
      redraw();
    },
  };
}
