import {EXPRESSION_SUGGEST_DEBOUNCE_MS, suggestExpressionRow} from '@momo/core/features/expressions/suggest';
import {muteKeywords, mutedKeywords} from '@momo/core/features/expressions/suggestMute';
import type {Expression} from '@momo/core/features/expressions/types';
import {emptyExpressionUsage, recentExpressions} from '@momo/core/features/expressions/usage';
import {useEffect, useReducer, useState} from 'react';
import {WORD} from '../../lib/techWords';
import {useExpressions} from './ExpressionProvider';
import {readExpressionFavorites} from './useExpressionFavorites';
import {useExpressionSuggestOn} from './useExpressionSuggestSetting';

// =============================================================================
// 글을 치다 멈추면 입력창 위에 띄우는 이모티콘·GIF 추천 - 폰 (#5478, 웹 `useExpressionSuggest.ts` #5476 의 짝, 코어 #5454 1단계).
//
// 이 훅이 가진 것은 **시계와 기억**이다. 맞추는 일은 코어 `suggestExpressions` 가 하고 그것은 순수 함수라, 입력한 글이 기기 밖으로 나갈 길이 없다(이 훅도 네트워크·서버 요청을
// 하지 않는다 - 맞추는 상대는 기기에 있는 보관함(`items`)뿐이다). 규칙은 웹과 같다:
//   · 글이 바뀌면 줄은 **그 순간** 사라지고(아래 `shown.text` 와 지금 글을 비교한다) 기다림이 처음부터 다시 시작한다. 0.3초(`EXPRESSION_SUGGEST_DEBOUNCE_MS`) 동안 글이 그대로일 때만
//     맞춰 본다. 맞는 것이 없으면 줄은 없다.
//   · 맞추는 말은 문구 안의 낱말 **모두**다(#5588, 코어 `suggestExpressionRow`): 「ㅋㅋ 개웃기네 진심」이면 ㅋㅋ 쪽과 진심 쪽 그림이 낱말이 나온 차례로 한 줄에 선다.
//   · `close()`: 고른 뒤. **이 글**에 대해서만 줄을 닫는다(글이 바뀌면 다시 맞춘다). 낱말을 끄는 것이 아니다.
//   · `mute()`: ✕. 지금 줄을 세운 낱말 **모두**(코어가 돌려준 `keywords`: 그림에 맞은 낱말들, 글 전체 낱말 포함)를 이 대화에서 끈다(`suggestMute`, 코어). 맞지 않은 낱말은
//     끄지 않는다. 한 낱말만 끄면 줄이 다른 낱말로 떴을 때(「킹 받네」 → 「킹받네」 꼬리표) 나중에 그 낱말만 쳤을 때 줄이 다시 뜬다.
//   · `enabled` 가 거짓이거나(오프라인·미리 보기가 있음·창이 열려 있음·멘션 목록이나 명령을 치는 중·입력창에 포커스가 없음) 방을 모르거나, 보관함을 아직 못 받았거나 읽지 못했을 때도
//     줄이 없다: 그림이 없는 줄을 보이지 않는다. 보관함 상태의 안내는 이모티콘 창이 말하고, 이 줄은 맞는 것이 있을 때만 선다.
//   · 설정 › 보기 › 「이모티콘 추천」(#5493)을 끄면 줄이 **아예** 서지 않는다(`enabled` 와 같은 칸이지만 사람이 정한 것이라 이 훅이 직접 읽는다 - 이 훅을 쓰는 입력창은 모두 따라온다: 대화·스레드).
//     끄면 그 순간 줄이 걷히고 다시 켜면 이미 친 글에 대해 0.3초 뒤 다시 선다(`active` 가 효과의 의존이라 기다림이 처음부터 다시 시작한다) - 앱을 다시 켤 필요가 없다.
// 맞추는 상대는 서버가 확인한 목록(`items`, 꼬리표가 있다)이다 - 그리기용 `shelf` 는 꼬리표를 기기에 남기지 않는다. 즐겨찾기는 쓰는 순간에 저장소에서 읽는다(이모티콘 창의 ★ 가 따로 쥔 값이
// 바뀌어도 이 입력창이 낡은 값으로 줄을 세우지 않게). 최근·즐겨찾기는 맞는 것들의 **순서**만 바꾼다(코어가 채워 넣지 않는다).
// =============================================================================

const NONE: readonly Expression[] = [];

export interface ExpressionSuggest {
  /** 줄에 세울 그림들(1~5개, 낱말이 나온 차례로 묶음). 줄이 없으면 빈 목록이다. */
  items: readonly Expression[];
  open: boolean;
  /** 고른 뒤: 이 글에 대해 줄을 닫는다. 쓴 글과 끈 낱말은 그대로다. */
  close: () => void;
  /** ✕: 지금 글의 낱말들을 이 대화에서 끈다. */
  mute: () => void;
}

export function useExpressionSuggest({
  scope,
  text,
  enabled,
}: {
  /** 「이 대화」 - 워크스페이스·채널. 모르면 `null` 이고 줄이 없다. */
  scope: string | null;
  /** 입력칸의 지금 글(초안). */
  text: string;
  enabled: boolean;
}): ExpressionSuggest {
  const {store, items: catalog, state, usage} = useExpressions();
  // 사람이 설정에서 정한 켬·끔(#5493). 이 기기 · 이 워크스페이스 · 이 사람 기준이라 보관함 저장소가 아는 사람 id 로 읽는다(저장소가 없으면 어차피 줄이 없다).
  const suggestOn = useExpressionSuggestOn(store?.workspaceId ?? '', store?.memberId ?? '');
  // 설정이 켜져 있고 보관함을 서버에서 받아 확인한 뒤(`ready`)에만 선다: 아직 받는 중이거나, 읽지 못했거나, 끊겼으면 보일 그림이 없다.
  const active = enabled && suggestOn && scope !== null && store !== null && state === WORD.ready;
  const [shown, setShown] = useState<{scope: string; text: string; items: readonly Expression[]; keywords: readonly string[]} | null>(null);
  const [closed, setClosed] = useState<{scope: string; text: string} | null>(null);
  // 끈 낱말은 모듈 기억에 있다(`suggestMute`): 바꾸면 이 훅을 다시 그리게 한다.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    setShown(null);
    if (!active || scope === null || store === null || text.trim() === '') return undefined;
    const timer = setTimeout(() => {
      const row = suggestExpressionRow(text, catalog, {
        recent: recentExpressions(usage ?? emptyExpressionUsage(store.workspaceId, store.memberId)).map(entry => entry.id),
        favorites: readExpressionFavorites(store.workspaceId, store.memberId).ids,
        muted: mutedKeywords(scope),
      });
      setShown(row.items.length > 0 ? {scope, text, items: row.items, keywords: row.keywords} : null);
    }, EXPRESSION_SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, active, scope, store, catalog, usage]);

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
    close: () => {
      if (scope !== null) setClosed({scope, text});
    },
    mute: () => {
      if (scope === null) return;
      muteKeywords(scope, current?.keywords ?? []);
      setShown(null);
      redraw();
    },
  };
}
