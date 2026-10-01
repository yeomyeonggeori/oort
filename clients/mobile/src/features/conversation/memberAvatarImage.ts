import {fetchMemberAvatar} from '@momo/core/lib/api';
import {useEffect, useState} from 'react';

// =============================================================================
// 업로드된 멤버 아바타(ADR-0161 증보, #3277)를 폰에서 싣는 길
//
// roster 의 `avatarUrl` 이 `…/members/{id}/avatar/content?v={media}` 이면 그것은
// **베어러가 있어야 읽히는** 인가 경로다. RN `Image` 는 헤더를 못 싣는 `uri` 로
// 그것을 읽으면 401 회색 상자가 남는다. 그래서 코어 `fetchMemberAvatar`(베어러·
// 401 갱신·경로 모양 검사까지 코어가 한다)로 받아 `data:` 주소로 바꿔 싣는다.
//
// ## 캐시
//
// 키는 content 경로 그대로다 — 멤버 id 와 `?v=` 가 모두 들어 있어, 사진을 바꾸면
// 키가 바뀌고 같은 사진은 한 번만 받는다. 한 화면에 같은 사람의 행이 수십 개여도
// 요청은 하나다(진행 중인 약속을 공유한다). 항목은 최대 `MAX_ENTRIES` 개(가장 오래
// 안 쓴 것부터 버린다 — 5 MiB 상한 이미지의 data 주소가 메모리를 먹는다).
// 실패는 `FAILURE_TTL_MS` 동안만 기억한다: 그 사이 같은 행이 다시 그려져도 요청
// 폭풍이 없고, 일시 오류는 곧 다시 시도된다.
//
// ## 레퍼러
//
// 이 길은 서버 주소로 `fetch` 하는 것이 전부라 웹의 `<img>` 처럼 레퍼러가 실리지
// 않는다. 옛 `avatarUrl`(절대 http 주소)은 RN `Image` 가 읽는데, RN `Image` 에는
// 레퍼러 정책을 정하는 속성이 없다 — 코어가 이 서버 오리진의 주소만 통과시키므로
// 새는 곳은 이 서버뿐이다(후속 아님, 기록만).
// =============================================================================

export const MAX_ENTRIES = 64;
export const FAILURE_TTL_MS = 30_000;

type Entry =
  | {state: 'pending'; promise: Promise<string | null>}
  | {state: 'ready'; uri: string}
  | {state: 'failed'; until: number};

const cache = new Map<string, Entry>();

/** 시험·로그아웃·워크스페이스 전환 때 비운다. */
export function __resetMemberAvatarCache(): void {
  cache.clear();
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result === 'string' && result.startsWith('data:')) resolve(result);
      else reject(new Error('avatar blob did not decode'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('avatar read failed'));
    reader.readAsDataURL(blob);
  });
}

function remember(path: string, entry: Entry): void {
  // Map 은 삽입 순서를 지킨다 — 지우고 다시 넣어 가장 최근으로 올린다.
  cache.delete(path);
  cache.set(path, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 이미 받아 둔 주소(없으면 `null`). 렌더 첫 프레임에 깜빡임 없이 쓴다. */
export function peekMemberAvatar(path: string): string | null {
  const hit = cache.get(path);
  if (hit?.state === 'ready') {
    remember(path, hit);
    return hit.uri;
  }
  return null;
}

/** 같은 경로는 한 번만 받는다. 실패하면 `null`(이니셜이 선다). */
export function loadMemberAvatar(path: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit?.state === 'ready') return Promise.resolve(hit.uri);
  if (hit?.state === 'pending') return hit.promise;
  if (hit?.state === 'failed' && hit.until > Date.now()) return Promise.resolve(null);

  const promise = fetchMemberAvatar(path)
    .then(blobToDataUri)
    .then(
      (uri): string | null => {
        remember(path, {state: 'ready', uri});
        return uri;
      },
      (): string | null => {
        remember(path, {state: 'failed', until: Date.now() + FAILURE_TTL_MS});
        return null;
      },
    );
  remember(path, {state: 'pending', promise});
  return promise;
}

/**
 * `path` 가 있으면 그 멤버 아바타의 `data:` 주소, 받는 중·실패면 `null`.
 * 호출한 쪽은 `null` 동안 같은 크기의 이니셜을 세운다(크기 변화 없음).
 */
export function useMemberAvatarUri(path: string | null): string | null {
  const [uri, setUri] = useState<string | null>(() =>
    path === null ? null : peekMemberAvatar(path),
  );
  useEffect(() => {
    if (path === null) {
      setUri(null);
      return undefined;
    }
    const known = peekMemberAvatar(path);
    setUri(known);
    if (known !== null) return undefined;
    let alive = true;
    void loadMemberAvatar(path).then(next => {
      if (alive) setUri(next);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return uri;
}
