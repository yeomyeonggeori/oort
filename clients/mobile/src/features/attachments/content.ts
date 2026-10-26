import { rotateAfterUnauthorized, type MessageAttachment } from '@momo/core/lib/api';
import { NetworkError } from '@momo/core/lib/http';
import { apiBase, coreSession } from '@momo/core/runtime/host';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';

// =============================================================================
// 첨부 바이트의 폰 어댑터 (ADR-0151 D2 / #1681).
//
// 권한 판정은 서버의 인가 프록시가 한다. 이 파일은 Drive 주소를 알지 못하고,
// `GET …/attachments/{id}/content`에 현재 bearer를 실어 앱 캐시로 스트리밍한다.
// `fetch().arrayBuffer()`를 쓰지 않는 이유는 100MB 상한 전체를 JS heap에 한 번 더
// 올리지 않기 위해서다. ExpoFileSystem은 이 bare 앱에 Expo가 이미 링크해 둔 모듈
// (Podfile.lock의 ExpoFileSystem)이고, 이 티켓은 그 모듈을 직접 소비할 뿐 새 native
// surface를 추가하지 않는다.
// =============================================================================

const CACHE_DIRECTORY_NAME = 'oort-attachments';
const PREVIEW_CACHE_LIMIT = 60;

const cached = new Map<string, File>();
const inflight = new Map<string, Promise<File>>();

// =============================================================================
// 첨부 그림의 **잰 크기** (#4455 design-review r2 H2).
//
// 한 장짜리 사진 타일(`AttachmentList` 의 `ImageTile`)은 마운트 때 비율을 모른다. 그래서 폭 280 · 16:9 자리표시로 서고,
// `Image.getSize` 가 돌아온 뒤에야 실제 비율(가로 4:3 은 280x210, 세로 3:4 는 240x320)이 된다. 같은 사진을 그리는 **새 마운트**는
// 전부 이 한 걸음을 다시 밟는다 — 보낸 사진의 메아리가 서버 사본으로 교체될 때(키가 `p-…` → `m-…` 라 새 마운트다), 기록을 읽다가
// 화면 밖에서 돌아온 행, 방에 다시 들어왔을 때. 메아리 타일이 이미 잰 크기를 서버 사본이 이어받지 못하면 교체 순간 행이
// 53~163pt 줄었다가(목록이 꼬리에 붙어 있으면 스크롤 오프셋이 되감긴다) 약 300ms 뒤 다시 자란다.
//
// 그래서 잰 크기를 **첨부 id 별로** 모듈에 둔다. 새 마운트는 첫 프레임부터 그 크기로 선다(`ImageTile` 의 `useState` 초기값).
// 미리보기 캐시(`cached`)와 같은 수명이다(앱이 사는 동안, 시험은 `resetAttachmentContentForTest`).
//
// - 키는 **첨부 id 의 소문자**다. 첨부 id 는 서버가 만든 uuid 라 워크스페이스·채널 없이도 유일하고, 코어의 `confirmsPending` 이 id 를
//   소문자로 맞춰 대조하는 것처럼(대소문자가 갈려도 같은 첨부다) 같은 규칙을 따른다. 메아리의 채널 id 와 서버 사본의 채널 id 는 쓰는 쪽이
//   다르니(경로 인자 대 서버 응답) 키에 넣지 않는다.
// - 항목은 숫자 두 개라 미리보기 캐시(파일 60개)보다 훨씬 넉넉히 둔다. 오래된 것부터 잊는다 — 잊히면 한 번 더 재면 되는 값이다.
// - 실패는 적지 않는다. 못 잰 그림은 다음 마운트가 다시 시도한다.
// =============================================================================

/** 잰 크기 저장소의 상한(항목은 숫자 둘이라 미리보기 캐시보다 넉넉하다). 시험이 경계를 읽는다. */
export const MEASURED_SIZE_LIMIT = 500;

export interface MeasuredSize {
  readonly width: number;
  readonly height: number;
}

const measuredSizes = new Map<string, MeasuredSize>();

const sizeKey = (attachmentId: string): string => attachmentId.toLowerCase();

/** 이 첨부의 잰 크기. 아직 못 쟀으면 `null`. 같은 크기는 **같은 객체**를 돌려준다(상태 갱신이 비교만으로 끝난다). */
export function measuredAttachmentSize(attachmentId: string): MeasuredSize | null {
  return measuredSizes.get(sizeKey(attachmentId)) ?? null;
}

/** 잰 크기를 적는다. 유한하고 0보다 큰 가로·세로만 받는다(그림이 아닌 값이 자리를 굳히지 않게). */
export function rememberAttachmentSize(
  attachmentId: string,
  width: number,
  height: number,
): MeasuredSize | null {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    return null;
  }
  const key = sizeKey(attachmentId);
  const earlier = measuredSizes.get(key);
  if (earlier !== undefined && earlier.width === width && earlier.height === height) {
    return earlier;
  }
  const size: MeasuredSize = { width, height };
  measuredSizes.delete(key);
  measuredSizes.set(key, size);
  while (measuredSizes.size > MEASURED_SIZE_LIMIT) {
    const oldest = measuredSizes.keys().next();
    if (oldest.done) break;
    measuredSizes.delete(oldest.value);
  }
  return size;
}

export type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; uri: string }
  | { status: 'failed' };

function cacheKey(
  workspaceId: string,
  channelId: string,
  attachmentId: string,
): string {
  // 대소문자를 가리지 않는다(#4455 design-review r3 L13). 워크스페이스·채널·첨부 id 는 uuid 이고, 같은 사진을 그리는 두 마운트가 이 값을
  // 서로 다른 곳에서 받는다 — 보낸 사진의 메아리는 화면의 경로 인자에서, 서버 사본은 서버 응답에서. 대소문자만 달라도 같은 파일이다
  // (코어 `confirmsPending` 이 첨부 id 를 소문자로 맞춰 대조하는 것과 같은 규칙). 위 「잰 크기」 저장소의 키와 같은 정규화다 —
  // 둘이 어긋나면 서버 사본은 크기만 이어받고 바이트는 못 찾아 「불러오는 중」 칸으로 서서 다시 내려받는다.
  return `${workspaceId}:${channelId}:${attachmentId}`.toLowerCase();
}

function safeFileName(name: string): string {
  const cleaned = Array.from(name.normalize('NFC').replace(/[\\/:]/g, '-'))
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? '-' : character;
    })
    .join('')
    .trim();
  return cleaned === '' ? 'attachment' : cleaned.slice(0, 120);
}

function contentUrl(
  workspaceId: string,
  channelId: string,
  attachmentId: string,
): string {
  return `${apiBase()}/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(
    attachmentId,
  )}/content`;
}

function destinationFor(attachment: MessageAttachment): File {
  const directory = new Directory(Paths.cache, CACHE_DIRECTORY_NAME);
  if (!directory.exists) {
    directory.create({ intermediates: true, idempotent: true });
  }
  return new File(
    directory,
    `${attachment.id}-${safeFileName(attachment.name)}`,
  );
}

function authHeaders(): Record<string, string> {
  const token = coreSession().getAccessToken();
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

function isUnauthorized(error: unknown): boolean {
  // 서버에 닿지 못한 실패(코어 `rotateAfterUnauthorized` 가 던지는 연결 오류)는 문구가 무엇이든
  // 인가 판정이 아니다. 아래 정규식은 메시지를 읽으므로, 그 문구가 훗날 바뀌어 401 처럼
  // 읽혀도 바깥 catch 의 선언으로 새지 않게 종류로 먼저 거른다(#3997).
  if (error instanceof NetworkError) return false;
  return /(?:status(?: code)?\s*[:=]?\s*401|http\s*401|unauthori[sz]ed)/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function streamToFile(
  workspaceId: string,
  channelId: string,
  attachment: MessageAttachment,
  destination: File,
  onProgress?: (progress: number | null) => void,
): Promise<File> {
  const downloaded = await File.downloadFileAsync(
    contentUrl(workspaceId, channelId, attachment.id),
    destination,
    {
      headers: authHeaders(),
      idempotent: true,
      onProgress: ({ bytesWritten, totalBytes }) => {
        onProgress?.(
          totalBytes > 0 ? Math.min(1, bytesWritten / totalBytes) : null,
        );
      },
    },
  );
  onProgress?.(1);
  return downloaded;
}

/**
 * 첨부 한 건을 캐시로 받는다. 미리보기와 공유시트가 같은 파일을 재사용하고,
 * 채널 타임라인과 스레드가 동시에 같은 첨부를 그려도 네트워크 요청은 하나다.
 */
export async function downloadAttachmentFile(
  workspaceId: string,
  channelId: string,
  attachment: MessageAttachment,
  onProgress?: (progress: number | null) => void,
): Promise<File> {
  const key = cacheKey(workspaceId, channelId, attachment.id);
  const hit = cached.get(key);
  if (hit?.exists) {
    onProgress?.(1);
    return hit;
  }

  const active = inflight.get(key);
  if (active !== undefined) return active;

  const destination = destinationFor(attachment);
  const request = (async () => {
    try {
      try {
        return await streamToFile(
          workspaceId,
          channelId,
          attachment,
          destination,
          onProgress,
        );
      } catch (error: unknown) {
        if (
          !isUnauthorized(error) ||
          coreSession().getRefreshToken() === null
        ) {
          throw error;
        }
        // 회전이 어떻게 끝났는지 읽는 규칙은 코어의 것이다(#3997): 거절이면 `false` 라서
        // 원래의 401 이 바깥 catch 로 가 선언되고, 서버에 닿지 못했으면 코어가 연결
        // 오류를 던진다. 그 문구는 401 로 읽히지 않으므로 바깥 catch 가 선언하지 않고,
        // 이 다운로드만 실패한다(다음 요청이 다시 갱신한다).
        if (!(await rotateAfterUnauthorized())) throw error;
        return await streamToFile(
          workspaceId,
          channelId,
          attachment,
          destination,
          onProgress,
        );
      }
    } catch (error: unknown) {
      if (destination.exists) destination.delete();
      if (isUnauthorized(error)) coreSession().markAuthExpired();
      throw error;
    }
  })()
    .then(file => {
      cached.set(key, file);
      while (cached.size > PREVIEW_CACHE_LIMIT) {
        const oldest = cached.keys().next();
        if (oldest.done) break;
        cached.delete(oldest.value);
      }
      return file;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
}

/** 이미지 미리보기의 고정된 세 상태. 비활성일 때는 요청하지 않는다. */
export function useAttachmentPreview(
  workspaceId: string,
  channelId: string,
  attachment: MessageAttachment,
  enabled: boolean,
): PreviewState {
  const key = cacheKey(workspaceId, channelId, attachment.id);
  const hit = cached.get(key);
  const [state, setState] = useState<PreviewState>(
    hit?.exists ? { status: 'ready', uri: hit.uri } : { status: 'loading' },
  );

  useEffect(() => {
    if (!enabled) return;
    const current = cached.get(key);
    if (current?.exists) {
      setState({ status: 'ready', uri: current.uri });
      return;
    }

    let live = true;
    setState({ status: 'loading' });
    void downloadAttachmentFile(workspaceId, channelId, attachment)
      .then(file => {
        if (live) setState({ status: 'ready', uri: file.uri });
      })
      .catch(() => {
        if (live) setState({ status: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [workspaceId, channelId, attachment, enabled, key]);

  return state;
}

/** 테스트 사이에 모듈 전역 캐시가 바이트 상태를 흘리지 않게 한다. */
export function resetAttachmentContentForTest(): void {
  cached.clear();
  inflight.clear();
  measuredSizes.clear();
}
