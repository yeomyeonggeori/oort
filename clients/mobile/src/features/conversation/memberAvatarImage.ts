import {memberAvatarContentPath} from '@momo/core/features/workspace/avatar';
import {refreshSession} from '@momo/core/lib/api';
import {apiBase, coreSession} from '@momo/core/runtime/host';
import {Directory, File, Paths} from 'expo-file-system';
import {useEffect, useState} from 'react';

// =============================================================================
// 업로드된 멤버 아바타(ADR-0161 증보, #3277)를 폰에서 싣는 길 — 디스크 파일 캐시
//
// roster 의 `avatarUrl` 이 `…/members/{id}/avatar/content?v={media}` 이면 그것은
// **베어러가 있어야 읽히는** 인가 경로다. RN `Image` 는 헤더를 못 싣는 `uri` 로
// 그것을 읽으면 401 회색 상자가 남는다. 그래서 첨부와 같은 길로 받는다
// (`attachments/content.ts`): 네이티브 다운로더가 베어러를 실어 앱 캐시 디렉터리에
// **파일로** 쓰고, `Image` 에는 `file://` 주소를 준다. 5 MiB 짜리 사진이 JS 힙에
// 문자열로 남는 일이 없다.
//
// 경로 모양 검사는 코어 `memberAvatarContentPath` 가 한다 — 그 형태가 아니면 베어러를
// 싣지 않고 거절한다(임의 주소로 토큰이 새지 않게).
//
// ## 캐시
//
// 키는 서버 주소 + content 경로(멤버 id 와 `?v=` 포함)이고 파일명은 그 해시다.
// 사진을 바꾸면 `?v=` 가 달라져 새 파일이 된다. 같은 사진은 한 번만 받고 진행 중인
// 요청도 공유한다. 디스크 총량이 `MAX_DISK_BYTES` 를 넘으면 가장 오래 안 쓴 파일부터
// 지운다. 실패는 `FAILURE_TTL_MS` 동안만 기억한다(요청 폭풍 방지, 일시 오류는 곧
// 재시도). 앱을 다시 켜면 디렉터리에 남은 파일을 색인으로 거둔다.
//
// 로그아웃·세션 경계에서는 `clearMemberAvatarCache()` 가 메모리와 디스크를 비운다
// (앞 사람의 얼굴이 다음 사람 기기에 남지 않게).
//
// ## 레퍼러
//
// 받는 길은 네이티브 다운로더이고 레퍼러를 싣지 않는다.
// =============================================================================

export const MAX_DISK_BYTES = 64 * 1024 * 1024;
export const FAILURE_TTL_MS = 30_000;

const DIRECTORY_NAME = 'oort-member-avatars';

interface Indexed {
  file: File;
  size: number;
}

/** 삽입 순서 = 쓴 순서(LRU). 키는 파일명(`hashName(cacheKey)`) — 순수 계산이라 렌더 중에도 싸다. */
const index = new Map<string, Indexed>();
const inflight = new Map<string, Promise<string | null>>();
const failedUntil = new Map<string, number>();
let adopted = false;
/** 비우기 세대 — 비우는 사이 끝난 다운로드는 파일을 버리고 결과를 내지 않는다. */
let generation = 0;

let cachedDirectory: Directory | null = null;

/** 디렉터리는 한 번만 만들고 기억한다(렌더 경로에서 네이티브 호출을 반복하지 않는다). */
function directory(): Directory {
  if (cachedDirectory === null) {
    const dir = new Directory(Paths.cache, DIRECTORY_NAME);
    if (!dir.exists) dir.create({intermediates: true, idempotent: true});
    cachedDirectory = dir;
  }
  return cachedDirectory;
}

/* eslint-disable no-bitwise -- 파일명 해시는 비트 연산이 본업이다 */
/** 두 개의 32비트 FNV-1a 를 이어 붙인 16자 16진 — 파일명용(보안 용도가 아니다). */
function hashName(key: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ key.length;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c + i, 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}.img`;
}

/* eslint-enable no-bitwise */

export function memberAvatarCacheKey(path: string): string {
  return `${apiBase()}${path}`;
}

function totalBytes(): number {
  let sum = 0;
  for (const entry of index.values()) sum += entry.size;
  return sum;
}

function evict(): void {
  while (totalBytes() > MAX_DISK_BYTES && index.size > 1) {
    const oldest = index.keys().next();
    if (oldest.done) break;
    const entry = index.get(oldest.value);
    index.delete(oldest.value);
    try {
      if (entry?.file.exists) entry.file.delete();
    } catch {
      // 지우지 못한 파일은 다음 실행의 색인 거두기가 다시 센다.
    }
  }
}

/** 앱을 다시 켠 뒤 디렉터리에 남은 파일을 색인으로 거둔다(한 번). */
function adoptExisting(): void {
  if (adopted) return;
  adopted = true;
  try {
    for (const item of directory().list()) {
      if (!(item instanceof File)) continue;
      index.set(item.uri.slice(item.uri.lastIndexOf('/') + 1), {
        file: item,
        size: item.size ?? 0,
      });
    }
    evict();
  } catch {
    // 색인을 못 거두면 빈 캐시로 시작한다 — 받으면 그만이다.
  }
}

function fileFor(name: string): File {
  return new File(directory(), name);
}

/**
 * 이미 받아 둔 `file://` 주소(없으면 `null`). **메모리 색인만 본다** — 렌더 중에
 * 불리므로 디렉터리·파일 경로를 만들지 않는다(받아 둔 파일의 색인 거두기는 첫
 * `loadMemberAvatar` 에서 한 번 한다). 렌더 첫 프레임에 깜빡임 없이 쓴다.
 */
export function peekMemberAvatar(key: string): string | null {
  const name = hashName(key);
  const hit = index.get(name);
  if (hit === undefined) return null;
  index.delete(name);
  index.set(name, hit);
  return hit.file.uri;
}

function isUnauthorized(error: unknown): boolean {
  return /(?:status(?: code)?\s*[:=]?\s*401|http\s*401|unauthori[sz]ed)/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function download(path: string, destination: File): Promise<File> {
  const send = (): Promise<File> => {
    const token = coreSession().getAccessToken();
    return File.downloadFileAsync(`${apiBase()}${path}`, destination, {
      headers: token === null ? {} : {Authorization: `Bearer ${token}`},
      idempotent: true,
    });
  };
  try {
    return await send();
  } catch (error: unknown) {
    if (!isUnauthorized(error)) throw error;
    if (coreSession().getRefreshToken() !== null && (await refreshSession())) {
      return send();
    }
    coreSession().markAuthExpired();
    throw error;
  }
}

/** 같은 경로는 한 번만 받는다. 실패하면 `null`(이니셜이 선다). */
export function loadMemberAvatar(path: string): Promise<string | null> {
  if (memberAvatarContentPath(path) === null) return Promise.resolve(null);
  const key = memberAvatarCacheKey(path);
  adoptExisting(); // 렌더 밖(첫 사용)에서 한 번
  const known = peekMemberAvatar(key);
  if (known !== null) return Promise.resolve(known);
  const active = inflight.get(key);
  if (active !== undefined) return active;
  const until = failedUntil.get(key);
  if (until !== undefined && until > Date.now()) return Promise.resolve(null);

  const started = generation;
  const name = hashName(key);
  const destination = fileFor(name);
  const request = download(path, destination)
    .then((file): string | null => {
      if (started !== generation) {
        if (file.exists) file.delete();
        return null;
      }
      failedUntil.delete(key);
      index.delete(name);
      index.set(name, {file, size: file.size ?? 0});
      evict();
      return file.uri;
    })
    .catch((): string | null => {
      try {
        if (destination.exists) destination.delete();
      } catch {
        // 반쯤 쓰인 파일이 남아도 다음 성공이 덮는다(idempotent).
      }
      if (started === generation) failedUntil.set(key, Date.now() + FAILURE_TTL_MS);
      return null;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** 로그아웃·세션 경계: 메모리 색인과 디스크 파일을 모두 비운다. */
export function clearMemberAvatarCache(): void {
  generation += 1;
  inflight.clear();
  failedUntil.clear();
  const files = [...index.values()].map(entry => entry.file);
  index.clear();
  try {
    const dir = new Directory(Paths.cache, DIRECTORY_NAME);
    if (dir.exists) for (const item of dir.list()) if (item instanceof File) files.push(item);
  } catch {
    // 디렉터리를 못 읽어도 색인에 있던 파일은 지운다.
  }
  for (const file of files) {
    try {
      if (file.exists) file.delete();
    } catch {
      // 못 지운 파일은 다음 비우기가 다시 시도한다.
    }
  }
  adopted = true; // 방금 비웠으니 거둘 것이 없다.
}

/** 시험용: 모듈 상태 전체를 처음으로(디스크는 시험 mock 이 따로 비운다). */
export function __resetMemberAvatarCache(): void {
  generation += 1;
  index.clear();
  inflight.clear();
  failedUntil.clear();
  adopted = false;
  cachedDirectory = null;
}

/**
 * `path` 가 있으면 그 멤버 아바타의 `file://` 주소, 받는 중·실패면 `null`.
 * 호출한 쪽은 `null` 동안 같은 크기의 이니셜을 세운다(크기 변화 없음).
 *
 * 반환은 **현재 key 의 캐시 색인**뿐이다 — 경로가 바뀐 첫 렌더에 앞 사람의 사진을
 * 새 멤버 얼굴로 그리지 않고(DM A→B 전환), 이미 받은 것은 첫 프레임부터 이미지다
 * (이니셜→이미지 깜박임 없음). `loaded` 상태는 받기가 끝났을 때 다시 그리게 하는
 * 신호다.
 */
export function useMemberAvatarUri(path: string | null): string | null {
  const key = path === null ? null : memberAvatarCacheKey(path);
  const [loaded, setLoaded] = useState<{key: string; uri: string} | null>(null);
  const hit = key === null ? null : peekMemberAvatar(key);
  // 받았던 것이 캐시에서 밀려났다(축출·비우기): 낡은 `loaded` 는 쓰지 않고 다시 받는다.
  const stale = key !== null && hit === null && loaded?.key === key;
  useEffect(() => {
    if (path === null || key === null) return undefined;
    if (peekMemberAvatar(key) !== null) return undefined;
    let alive = true;
    void loadMemberAvatar(path).then(uri => {
      if (alive && uri !== null) setLoaded({key, uri});
    });
    return () => {
      alive = false;
    };
  }, [path, key, stale]);
  return hit;
}
