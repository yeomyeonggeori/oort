import {
  expressionSuggestSetting,
  restoreExpressionSuggestOn,
} from '@momo/core/features/expressions/suggestSetting';
import {useSyncExternalStore} from 'react';
import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';

// =============================================================================
// 「이모티콘 추천」 켜기·끄기 - 폰 (#5493, 웹 `suggestSetting.ts` 의 짝, owner 2026-11-07 「설정에서 다 끌 수도 있어요」). 입력창 위의 추천 줄(`useExpressionSuggest`)을 통째로 끄는
// 사람의 선택이다.
//
// 값의 모양과 읽는 법은 코어(`suggestSetting.ts`)가 갖는다: 기본은 켜짐이고 끈 것으로 분명히 적힌 값만 끔이다. 이 파일은 폰의 저장소(MMKV)에 읽고 쓰는 일과 바뀌었다는 소식만 한다.
// 저장 자리는 즐겨찾기(`useExpressionFavorites.ts`)와 같은 규칙이다: 한 키에 `워크스페이스:사람` → 값 지도 하나를 두어, 같은 기기에서 계정을 바꿔도 서로의 선택을 지우지 않는다.
// 이 기기 · 이 워크스페이스 · 이 사람 기준이고 서버로 가지 않는다. MMKV 는 동기로 읽히므로 첫 프레임부터 맞는 값으로 선다.
//
// 바꾸면 이 모듈을 쓰는 곳이 **바로** 따라온다(설정 화면의 스위치와 입력창의 추천 줄): 앱을 다시 켤 필요가 없다. 저장소가 막혀 쓰지 못해도 스위치는 눌린 대로 선다 - 이번 실행 동안만
// 사는 메모리 값(`unsaved`)이 대신 쥐고, 저장에 성공하면 그 값은 저장소가 다시 쥔다.
// =============================================================================

const listeners = new Set<() => void>();
/** 저장소가 막혀 못 남긴 선택. 이번 실행 동안만 산다. */
const unsaved = new Map<string, boolean>();

const scopeKey = (workspaceId: string, memberId: string) => `${workspaceId.toLowerCase()}:${memberId.toLowerCase()}`;

// 입력창이 글자마다 다시 그려지며 이 값을 읽는다: 저장소의 글이 그대로면 다시 풀지 않는다.
let parsedFrom: string | undefined;
let parsedMap: Record<string, unknown> = {};

function readMap(): Record<string, unknown> {
  try {
    const raw = nonSecretStore().getString(NON_SECRET_KEYS.expressionSuggest);
    if (raw !== parsedFrom) {
      const parsed: unknown = raw === undefined ? null : JSON.parse(raw);
      parsedMap = parsed instanceof Object && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      parsedFrom = raw;
    }
    return parsedMap;
  } catch {
    return {};
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 이 사람이 추천 줄을 켜 두었는가. 한 번도 안 바꿨거나 못 읽으면 켜짐이다. */
export function readExpressionSuggestOn(workspaceId: string, memberId: string): boolean {
  const key = scopeKey(workspaceId, memberId);
  return unsaved.get(key) ?? restoreExpressionSuggestOn(readMap()[key], workspaceId, memberId);
}

/** 켜고 끈다(다른 사람의 항목은 그대로). 같은 값이어도 쓴다(켠 것도 적는다). 구독자는 값이 바뀔 때만 깨운다. */
export function writeExpressionSuggestOn(workspaceId: string, memberId: string, on: boolean): void {
  const key = scopeKey(workspaceId, memberId);
  const changed = readExpressionSuggestOn(workspaceId, memberId) !== on;
  try {
    const next = {...readMap(), [key]: expressionSuggestSetting(workspaceId, memberId, on)};
    nonSecretStore().set(NON_SECRET_KEYS.expressionSuggest, JSON.stringify(next));
    unsaved.delete(key);
  } catch {
    unsaved.set(key, on);
  }
  if (changed) listeners.forEach(listener => listener());
}

export function useExpressionSuggestOn(workspaceId: string, memberId: string): boolean {
  const read = () => readExpressionSuggestOn(workspaceId, memberId);
  return useSyncExternalStore(subscribe, read, read);
}

/** 시험 사이에 저장소가 막혀 못 남긴 선택과 풀어 둔 글을 비운다. */
export function resetExpressionSuggestSettingForTest(): void {
  unsaved.clear();
  parsedFrom = undefined;
  parsedMap = {};
}
