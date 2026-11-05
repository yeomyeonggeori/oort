import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {loadPhoneEmojiCatalog} from './catalog';

// =============================================================================
// 표준 목록의 기억 (#5330, owner 11-05 「자꾸 불러오는중이 뜨는데」).
//
// 「기본」 탭(표준 그림 문자 격자)은 탭을 옮겼다 돌아올 때와 시트를 다시 열 때마다 새로 서고, 새로 설 때마다 목록 상태가
// `null` 로 시작해서 한 번은 「불러오는 중이에요」를 그렸다. 목록은 앱에 실린 파일이라 기다릴 것이 없다 — 한 번 푼 목록을 모듈이
// 쥐고, 격자가 **처음 그리는 순간부터** 서도록 초기값으로 준다. 앱이 켜진 뒤 한가한 때(`ExpressionProvider`)에 미리 한 번 푼다.
// 실패한 읽기는 기억하지 않는다(다시 시도가 실제로 다시 읽는다).
// =============================================================================

let remembered: CatalogEmoji[] | null = null;

/** 이미 푼 목록. 아직 풀지 않았으면 `null` — 그때만 격자가 읽는 동안 안내를 그린다. */
export const rememberedEmojiCatalog = (): CatalogEmoji[] | null => remembered;

export function rememberEmojiCatalog(entries: CatalogEmoji[] | null): void {
  remembered = entries;
}

/** 미리 한 번 푼다. 실패는 삼킨다 — 격자가 설 때 다시 읽고, 거기서 오류를 보인다. */
export function warmEmojiCatalog(): Promise<void> {
  return Promise.resolve()
    .then(loadPhoneEmojiCatalog)
    .then(
      entries => {
        if (entries) rememberEmojiCatalog(entries);
      },
      () => {},
    );
}
