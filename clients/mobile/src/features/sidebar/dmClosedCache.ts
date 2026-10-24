import {useEffect, useState} from 'react';
import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';
import type {ReadProjectionPhase} from '@momo/core/features/sidebar/goneDm';
import type {DmVerdict} from './dmVerdicts';

// =============================================================================
// 닫힌 DM 의 첫 페인트 캐시 (#4367). 원장이 아니다.
//
// 콜드스타트에서 읽음 투영은 목록보다 늦게 온다. 그 사이 코어 판정은 `hold` 라 닫은 DM 이 첫 프레임에 보였다 사라졌다.
// 마지막 투영에서 닫힘(7번)이던 DM id 를 기기에 적어 두고 첫 프레임에만 쓴다. 투영이 오면(`ready`) 판정은 서버 것이고,
// 이 값은 그 결과로 통째로 덮어쓴다 - 기기마다 어긋나던 로컬 원장을 되풀이하지 않는다.
// =============================================================================

/** 저장값 → 워크스페이스별 닫힘 id. 망가진 값은 빈 표로 읽는다(보이는 쪽이 안전). */
export function parseDmClosedCache(raw: string | undefined): Record<string, string[]> {
  if (raw === undefined) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string[]> = {};
    for (const [workspace, ids] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      out[workspace] = ids.filter((id): id is string => typeof id === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

/** 판정 표에서 캐시에 적을 닫힘 id(7번 = 내가 닫았다). 나간 상대(6번)는 명부가 정하므로 적지 않는다. */
export function closedIdsOf(verdicts: ReadonlyMap<string, DmVerdict>): string[] {
  const out: string[] = [];
  for (const [id, verdict] of verdicts) {
    if (verdict.rule === 7 && !verdict.shown) out.push(id);
  }
  return out.sort();
}

/** 첫 프레임에 읽은 닫힘 id. 한 번만 읽고 바뀌지 않는다(판정이 되먹임으로 돌지 않게). */
export function useDmClosedCacheInitial(workspaceId: string): ReadonlySet<string> {
  const [initial] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        parseDmClosedCache(nonSecretStore().getString(NON_SECRET_KEYS.dmClosedCache))[
          workspaceId
        ] ?? [],
      ),
  );
  return initial;
}

/**
 * 투영이 `ready` 일 때마다 그 결과로 덮어쓴다. `writable` 은 서버가 닫기를 싣는 동안만 참이다(옛 서버는 닫힘이 없으니 적을
 * 것이 없다).
 */
export function useDmClosedCacheWrite(
  workspaceId: string,
  phase: ReadProjectionPhase,
  writable: boolean,
  verdicts: ReadonlyMap<string, DmVerdict>,
): void {
  useEffect(() => {
    if (phase !== 'ready' || !writable) return;
    const store = nonSecretStore();
    const all = parseDmClosedCache(store.getString(NON_SECRET_KEYS.dmClosedCache));
    const next = closedIdsOf(verdicts);
    if (JSON.stringify(all[workspaceId] ?? []) === JSON.stringify(next)) return;
    all[workspaceId] = next;
    store.set(NON_SECRET_KEYS.dmClosedCache, JSON.stringify(all));
  }, [workspaceId, phase, writable, verdicts]);
}
