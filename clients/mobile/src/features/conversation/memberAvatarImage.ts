import {isApprovalAvatarPreviewPath} from '@momo/core/features/approvals/avatarPreview';
import {memberAvatarContentPath} from '@momo/core/features/workspace/avatar';
import {rotateAfterUnauthorized} from '@momo/core/lib/api';
import {apiBase, coreSession} from '@momo/core/runtime/host';
import {Directory, File, Paths} from 'expo-file-system';
import {useEffect, useState} from 'react';

import {exportAvatarForPush, usePushShowSender} from '../../push/presentation';

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

/**
 * 올린 직후: 로컬 파일(줄인 JPEG)을 이 경로의 캐시 파일로 복사해 색인에 올린다(#4384). 키는 서버가
 * complete 로 준 `?v=` 주소라 roster 가 같은 주소를 주면 내려받기 없이 그대로 맞고, 다르면
 * 새 키로 받는다(시드는 덮이지 않고 LRU 로 밀려난다). 베어러를 쓰지 않으므로 경로 모양만 검사한다.
 */
export function seedMemberAvatar(
  path: string,
  sourceUri: string,
  /** `memberAvatarGeneration()` 을 올리기 시작할 때 읽은 값. 그 사이 비우기(로그아웃·계정 교체)가 있었으면 쓰지 않는다. */
  startedGeneration: number = generation,
): boolean {
  if (startedGeneration !== generation) return false;
  if (memberAvatarContentPath(path) === null) return false;
  try {
    adoptExisting();
    const key = memberAvatarCacheKey(path);
    const name = hashName(key);
    const source = new File(sourceUri);
    if (!source.exists) return false;
    const destination = fileFor(name);
    if (destination.exists) destination.delete();
    source.copy(destination);
    index.delete(name);
    index.set(name, {file: destination, size: destination.size ?? 0});
    failedUntil.delete(key);
    evict();
    return true;
  } catch {
    return false;
  }
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
    // 401 한 번에 회전 한 번. 어떻게 끝났는지를 읽는 규칙은 코어의 것이고(#3997,
    // `rotateAfterUnauthorized`) 여기서 다시 적지 않는다.
    //   회전됨        → 새 토큰으로 한 번 더 받는다.
    //   거절·토큰 없음 → 세션이 끝났다. 여기서 선언하고 이 다운로드는 실패로 던진다.
    //   닿지 못함      → 코어가 연결 오류를 던진다. 선언하지 않고 이 다운로드만 실패한다
    //                    (이니셜이 서고, 잠금 화면에서 돌아와 무선이 깨는 사이의 끊김이
    //                    로그아웃이 되지 않는다. 다음 요청이 다시 갱신한다. 같은 아바타는
    //                    실패 기억 `FAILURE_TTL_MS` 가 지난 뒤에 다시 묻는다).
    if (coreSession().getRefreshToken() !== null && (await rotateAfterUnauthorized())) {
      try {
        return await send();
      } catch (retried: unknown) {
        // 새 토큰도 거절됐다: 서버가 방금 세션을 끝냈다(재사용 탐지로 계보가 쓸려
        // 나간 경우 등). 코어 `authedResponse`·바이트 헬퍼, 첨부(`content.ts`)가
        // 이미 이 401 을 세션 종료로 선언한다 — 이 길만 조용히 지나치지 않는다.
        if (isUnauthorized(retried)) coreSession().markAuthExpired();
        throw retried;
      }
    }
    coreSession().markAuthExpired();
    throw error;
  }
}

/**
 * 베어러를 실어도 되는 경로인가: 멤버 아바타 content 이거나, 승인 카드가 제안하는 사진의
 * 미리보기(`avatar-preview?v={sha256}`, #4394)다. 두 모양 밖의 주소로는 토큰이 나가지 않는다.
 * 미리보기 키에는 해시가 들어 있어 바이트가 바뀌면 새 파일이 되고, 로그아웃 때 비우기는
 * 두 가지를 같은 디렉터리에서 함께 지운다.
 */
function isBearerAvatarPath(path: string): boolean {
  return memberAvatarContentPath(path) !== null || isApprovalAvatarPreviewPath(path);
}

/** 같은 경로는 한 번만 받는다. 실패하면 `null`(이니셜이 선다). */
export function loadMemberAvatar(path: string, reload = false): Promise<string | null> {
  if (!isBearerAvatarPath(path)) return Promise.resolve(null);
  const key = memberAvatarCacheKey(path);
  adoptExisting(); // 렌더 밖(첫 사용)에서 한 번
  // 명시적인 재시도는 이 사진의 실패 유예·표시하지 못한 파일만 비운다.
  // 진행 중인 요청은 아래에서 공유해 연속 탭도 다운로드를 겹치지 않는다.
  if (reload) {
    failedUntil.delete(key);
    const name = hashName(key);
    const cached = index.get(name);
    index.delete(name);
    try {
      if (cached?.file.exists) cached.file.delete();
    } catch {
      // 다운로드의 idempotent 덮어쓰기가 다시 시도한다.
    }
  }
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

/** 비우기 세대. 올리기 같은 긴 일이 시작할 때 읽어 두었다가 끝에 `seedMemberAvatar` 로 넘긴다. */
export function memberAvatarGeneration(): number {
  return generation;
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
  // 그려진 얼굴은 알림 확장에게도 한 번 건넨다(#4316): 화면이 이미 받아 둔 파일이라 요청이 늘지 않고,
  // 같은 (서버·멤버·버전)은 이 실행에서 한 번만 간다. 「보낸 사람 표시」를 다시 켜면 그려진 얼굴이 다시 간다.
  const showSender = usePushShowSender();
  useEffect(() => {
    if (path !== null && hit !== null && showSender) exportAvatarForPush(path, hit);
  }, [path, hit, showSender]);
  return hit;
}
