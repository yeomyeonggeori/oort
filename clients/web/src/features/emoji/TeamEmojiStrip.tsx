import { orderExpressionsForTab } from "@momo/core/features/expressions/browse";
import type { ExpressionPickerTab } from "@momo/core/features/expressions/kind";
import { expressionToken } from "@momo/core/features/expressions/message";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import { LoadFailureNote } from "@/features/common/LoadFailureBox";
import { loadCauseOf } from "@/features/common/loadFailure";
import { useExpressions } from "@/features/expressions/context";
import { ExpressionImage } from "@/features/expressions/ExpressionImage";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// 이모지 탭의 팀 이모지 줄 (#5453, owner 2026-11-07).
//
// 이모지 탭은 표준 유니코드 표에 팀의 작은 이모지(`team` 칸, 코어 `expressionsForPickerTab`)를 한 탭으로 합친다. 우리 팀 것과 기본을 가르지 않으므로
// 이 줄에는 머리글이 없다 - 낭독 이름(`expressions.picker.teamGroup`)만 있다. 검색어는 표와 같은 검색 칸의 것이다(그 칸이 `query`를 준다).
//
// 고르면 `:이름:` 을 돌려준다(입력칸에 넣거나 반응으로). 이 줄에서는 미리 보기나 보내기가 없다: 작은 그림은 글 사이에 들어가는 쓰임이다.
//
// 네 상태: 있음(그림 줄) · 비어 있음(줄이 서지 않는다 - 표가 이 탭의 본문이다) · 불러오는 중(줄이 서지 않는다, 표가 이미 서 있다) ·
// 오류(받아 둔 것이 없을 때만 한 줄과 다시 시도). 이미 받아 둔 목록이 있으면 읽기가 실패해도 목록을 그대로 둔다(#5279 규칙).
// =============================================================================

// 시험 열쇠는 컴포넌트 밖에서 만든다: 직접 문구 장부는 JSX 표현식 안(콜백 본문 포함)의 문자열 조각을 문구로 센다.
const itemTestId = (name: string) => `team-emoji-${name}`;

export function TeamEmojiStrip({ tab, query, onPick }: {
  /** 이 줄이 서는 탭(이모지). 호스트가 준다 - 탭 분류의 정본은 코어 표 하나다. */
  tab: ExpressionPickerTab;
  query: string;
  onPick: (token: string) => void;
}) {
  const { store, cache, usage, offline, failure } = useExpressions();
  const formatMessage = useFormatMessage();
  if (!store) return null;
  const items = orderExpressionsForTab(cache.items, tab, { query, usage });
  if (items.length === 0) {
    // 읽기가 실패했고(`failure`는 성공하면 비워진다) 받아 둔 것이 없을 때만 한 줄이다.
    if (failure !== null && cache.items.length === 0) {
      return (
        <LoadFailureNote
          titleKey={CONNECTION_KEYS.loadTeamExpressionsTitle}
          cause={loadCauseOf(failure)}
          onRetry={() => void store.refresh()}
          separator={false}
          testId="team-emoji-strip-error"
        />
      );
    }
    return null;
  }
  return (
    <div
      role="group"
      aria-label={formatMessage("expressions.picker.teamGroup")}
      className="flex flex-wrap gap-1"
      data-testid="team-emoji-strip"
    >
      {items.map((item) => {
        return (
          <button
            key={item.id}
            type="button"
            disabled={offline}
            aria-label={item.displayName}
            data-testid={itemTestId(item.name)}
            className="tap-target flex size-control items-center justify-center rounded-sm press hover:bg-surface-hover focus-visible:focus-ring disabled:opacity-50"
            onClick={() => {
              // 눌린 순간의 목록에서 다시 찾는다: 그 사이 숨겨졌거나 지워졌으면 고르지 않는다(`TeamExpressionsPanel` 과 같다).
              // 줄에 선 등록은 모두 활성이었으므로, 지금도 같은 상태인 등록이 있으면 살아 있는 것이다.
              const live = store.getSnapshot().cache.items.find((entry) => entry.id === item.id && entry.name === item.name);
              if (live?.status === item.status) onPick(expressionToken(live.name));
            }}
          >
            <ExpressionImage item={item} size="reaction" still />
          </button>
        );
      })}
    </div>
  );
}
