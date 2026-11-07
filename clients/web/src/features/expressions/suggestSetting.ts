import { useSyncExternalStore } from "react";
import { expressionSuggestSetting, restoreExpressionSuggestOn } from "@momo/core/features/expressions/suggestSetting";

// =============================================================================
// 「이모티콘 추천」 켜기·끄기 - 웹·데스크탑 (#5493, owner 2026-11-07 「설정에서 다 끌 수도 있어요」). 입력창 위의 추천 줄(`useExpressionSuggest`)을 통째로 끄는 사람의 선택이다.
//
// 값의 모양과 읽는 법은 코어(`suggestSetting.ts`)가 갖는다: 기본은 켜짐이고 끈 것으로 분명히 적힌 값만 끔이다. 이 파일은 localStorage 에 읽고 쓰는 일과 바뀌었다는 소식만 한다.
// 저장 자리는 즐겨찾기와 같은 규칙이다(`oort.expressions.favorites:<워크스페이스>:<사람>` 옆의 `oort.expressions.suggest:<워크스페이스>:<사람>`): 이 기기 · 이 워크스페이스 · 이 사람,
// 서버로 가지 않는다. 읽을 때마다 저장소를 직접 본다(모듈에 값을 쥐지 않는다) - 시험이 저장소에 값을 미리 두고 입력창을 올려도 그대로 읽힌다.
//
// 바꾸면 이 모듈을 쓰는 곳이 **바로** 따라온다(설정 화면의 스위치와 입력창의 추천 줄): 앱을 다시 켤 필요가 없다. 저장소가 막혀 쓰지 못해도 스위치는 눌린 대로 선다 -
// 이번 실행 동안만 사는 메모리 값(`unsaved`)이 대신 쥔다(ADR-0189 증보 1: 눌러도 안 바뀌는 컨트롤을 내보내지 않는다). 저장에 성공하면 그 값은 저장소가 다시 쥔다.
// =============================================================================

const listeners = new Set<() => void>();
/** 저장소가 막혀 못 남긴 선택. 이번 실행 동안만 산다. */
const unsaved = new Map<string, boolean>();

const storageKey = (workspaceId: string, memberId: string) => `oort.expressions.suggest:${workspaceId}:${memberId}`;

/** 이 기기에 저장된 JSON 값. 저장소가 없거나 값이 깨졌으면 null 이다(코어 복원 함수가 기본값으로 바꾼다 - 저장소는 선택 사항이다). */
function storedJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
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
  const key = storageKey(workspaceId, memberId);
  return unsaved.get(key) ?? restoreExpressionSuggestOn(storedJson(key), workspaceId, memberId);
}

/** 켜고 끈다. 같은 값이어도 쓴다(켠 것도 적는다). 구독자는 값이 바뀔 때만 깨운다. */
export function writeExpressionSuggestOn(workspaceId: string, memberId: string, on: boolean): void {
  const key = storageKey(workspaceId, memberId);
  const changed = readExpressionSuggestOn(workspaceId, memberId) !== on;
  try {
    localStorage.setItem(key, JSON.stringify(expressionSuggestSetting(workspaceId, memberId, on)));
    unsaved.delete(key);
  } catch {
    unsaved.set(key, on);
  }
  if (changed) listeners.forEach((listener) => listener());
}

export function useExpressionSuggestOn(workspaceId: string, memberId: string): boolean {
  const read = () => readExpressionSuggestOn(workspaceId, memberId);
  return useSyncExternalStore(subscribe, read, read);
}

/** 시험 사이에 저장소가 막혀 못 남긴 선택을 비운다. */
export function resetExpressionSuggestOnForTest(): void {
  unsaved.clear();
}
