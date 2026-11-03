import {compareReleaseVersions} from '@momo/core/features/releaseNotes/model';
import {useSyncExternalStore} from 'react';

import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';

// =============================================================================
// 「마지막으로 닫은 업데이트 소식」 (#4937). 이 폰에만 산다(MMKV `NON_SECRET_KEYS.releaseNotesSeen`).
//
// 값은 소식의 **버전**(`0.1.41`) 하나다. 폰은 빌드 번호로 소식을 고르지만(`noteForPhoneBuild`) 기기에는 소식의 이름을
// 적는다: 보일지 말지는 코어의 `shouldAnnounceNote` 가 가린다. 로그아웃·계정 전환이 지우지 않는다(테마와 같은 종류).
//
// 저장소를 못 써도 **이 실행 안에서는** 두 번 뜨지 않게 메모리 값을 함께 쥔다. 다음 실행은 다시 한 번 볼 수 있다
// (조용히 틀리는 것보다 낫다).
// =============================================================================

let cache: {value: string | null} | null = null;
const listeners = new Set<() => void>();

function readStored(): string | null {
  try {
    return nonSecretStore().getString(NON_SECRET_KEYS.releaseNotesSeen) ?? null;
  } catch {
    return null;
  }
}

/** 마지막으로 닫은 소식의 버전. 한 번도 닫지 않았거나 읽지 못하면 `null`. */
export function lastSeenReleaseNote(): string | null {
  if (cache === null) cache = {value: readStored()};
  return cache.value;
}

/** 이 소식을 닫았다고 적는다. 이미 더 새 소식을 닫은 기기의 값은 낮추지 않는다(앱을 낮춘 뒤 새 소식을 다시 부르지 않게). */
export function markReleaseNoteSeen(version: string): void {
  const current = lastSeenReleaseNote();
  if (current !== null && (compareReleaseVersions(version, current) ?? 1) <= 0) return;
  cache = {value: version};
  try {
    nonSecretStore().set(NON_SECRET_KEYS.releaseNotesSeen, version);
  } catch {
    // 메모리 값이 이번 실행을 지킨다(머리말).
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLastSeenReleaseNote(): string | null {
  return useSyncExternalStore(subscribe, lastSeenReleaseNote, lastSeenReleaseNote);
}

/** 시험 이음새: 메모리 값을 버려 다음 읽기가 저장소를 다시 본다. */
export function resetReleaseNotesSeenForTest(): void {
  cache = null;
  listeners.clear();
}
