import { refreshSession, type MessageAttachment } from '@momo/core/lib/api';
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

export type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; uri: string }
  | { status: 'failed' };

function cacheKey(
  workspaceId: string,
  channelId: string,
  attachmentId: string,
): string {
  return `${workspaceId}:${channelId}:${attachmentId}`;
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
        if (!(await refreshSession())) throw error;
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
}
