import { useSyncExternalStore } from "react";
import { compareReleaseVersions } from "@momo/core/features/releaseNotes/model";

// =============================================================================
// 「마지막으로 닫은 업데이트 소식」 (#4937). 이 기기(이 origin)에만 산다.
//
// 값은 소식의 **버전**(`0.1.41`) 하나다. 앱 버전이 아니다: 데스크탑 번호와 소식의 이름은 다른 체계일 수 있다
// (`@momo/core/features/releaseNotes/model` 머리말). 보일지 말지는 코어의 `shouldAnnounceNote`가 가린다.
//
// 키는 집의 기기 취향 저장소 규약(`momo.web.*`)을 따르고, 로그아웃·계정 전환이 지우지 않는다(테마·언어와 같은
// 종류: 사람 데이터가 아니라 기기 취향이라, 다른 계정으로 들어와도 같은 소식을 또 보이지 않는다).
//
// 저장소를 못 쓰는 창(사생활 보호·막힌 사이트 데이터)에서도 **이 실행 안에서는** 두 번 뜨지 않게 메모리 값을
// 함께 쥔다: 쓰기가 실패해도 닫은 사실은 이번 실행에서 지켜진다. 다음 실행은 다시 한 번 볼 수 있다(조용히 틀리는
// 것보다 낫다).
// =============================================================================

export const RELEASE_NOTES_SEEN_STORAGE_KEY = "momo.web.release-notes.seen.v1";

interface SeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): SeenStorage | null {
  // 저장소가 없거나(`undefined`) 접근이 막히면(`throw`) 쓰지 않는다. `typeof` 문자열 비교를 쓰지 않는 것은 직접 문구
  // 장부가 낱말 하나짜리 문자열을 문구로 세기 때문이다.
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let cache: { value: string | null } | null = null;
const listeners = new Set<() => void>();

function readStored(): string | null {
  try {
    return browserStorage()?.getItem(RELEASE_NOTES_SEEN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** 마지막으로 닫은 소식의 버전. 한 번도 닫지 않았거나 읽지 못하면 `null`. */
export function lastSeenReleaseNote(): string | null {
  if (cache === null) cache = { value: readStored() };
  return cache.value;
}

/**
 * 이 소식을 닫았다고 적는다. 이미 더 새 소식을 닫은 기기의 값은 낮추지 않는다(앱을 낮췄을 때 옛 소식이
 * 「마지막으로 본 것」을 되돌려 새 소식을 다시 부르지 않게).
 */
export function markReleaseNoteSeen(version: string): void {
  const current = lastSeenReleaseNote();
  if (current !== null && (compareReleaseVersions(version, current) ?? 1) <= 0) return;
  cache = { value: version };
  try {
    browserStorage()?.setItem(RELEASE_NOTES_SEEN_STORAGE_KEY, version);
  } catch {
    // 메모리 값이 이번 실행을 지킨다(머리말).
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeReleaseNotesSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLastSeenReleaseNote(): string | null {
  return useSyncExternalStore(subscribeReleaseNotesSeen, lastSeenReleaseNote, lastSeenReleaseNote);
}

/** 시험 이음새: 메모리 값을 버려 다음 읽기가 저장소를 다시 본다. */
export function resetReleaseNotesSeenForTest(): void {
  cache = null;
  listeners.clear();
}
