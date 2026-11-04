import {
  attachmentMediaOf,
  type MessageAttachment,
} from '@momo/core/features/attachments/model';
import { probeAttachmentContent } from '@momo/core/lib/api';
import { apiBase } from '@momo/core/runtime/host';
import { Directory, File, Paths } from 'expo-file-system';
import type { VideoSource } from 'expo-video';
import { useEffect, useState } from 'react';
import { authHeaders, contentUrl, fetchToFile } from './content';

// =============================================================================
// 영상 첨부의 폰 어댑터 — 포스터와 재생 소스 (#5208, ADR-0151 증보 5 D3·D5).
//
// ## 재생의 인증 — 결정 (a): 지금 세션의 bearer 를 플레이어 소스의 `headers` 에 싣는다
//
// 서버의 스트림 주소(C3b #5120)는 아직 없다. 네이티브 플레이어가 `GET …/attachments/{id}/content` 를 부르는 길은 둘이다.
//   (a) `VideoSource.headers` 에 bearer 를 싣는다 → 플레이어가 **구간 읽기(`Range` 206)로 바로 시작한다**(수용기준: 전부 받기 전에).
//   (b) 받은 로컬 파일을 재생한다 → 전부 받은 뒤에야 시작한다. 수용기준을 어기므로 고르지 않는다(공유·저장은 이 길을 이미 쓴다).
//
// (a)의 위험은 ADR-0151 증보 5 D4 가 이미 적었다: access 토큰은 15분이고 네이티브 플레이어는 헤더를 에셋을 만들 때 **고정**한다.
// ADR 은 폰도 스트림 주소를 쓰는 쪽을 [권장]했지만 그 길(#5120)이 아직 없어서 (a) 로 간다(ADR-0168 증보 2 에 이 이탈과 되돌릴 조건을 적었다).
// 지키는 것은 넷이다.
//   · 소스를 만들기 **직전에** 코어의 `probeAttachmentContent`(`HEAD`)로 토큰이 살아 있는지 묻는다. 401 이면 코어의 단 한 번의
//     회전을 거친 새 토큰으로 소스를 만든다 → 열 때 만료된 토큰이 플레이어까지 가지 않는다. 회전이 거절되면 코어가 세션 만료를 선언한다.
//     403·404·410 은 「더는 볼 수 없는 영상」으로 따로 답한다.
//   · 재생 중 토큰이 만료되면(탐색·재개의 다음 구간 요청이 401) 플레이어가 오류 상태가 된다. 그때 **한 번** 이 함수로 다시 열어 새 토큰의
//     소스로 바꾸고 위치·재생 여부를 되돌린다(`useVideoPlayback.ts`). AVPlayer 의 오류에서 401 만 가려낼 수 없어서 「어떤 오류든 한 번」이다.
//   · 토큰은 `authHeaders()`(`content.ts`)가 읽어 소스 객체의 `headers` 로만 나간다. **주소(`uri`)에는 넣지 않는다**(주소는 로그·크래시
//     리포트에 오르기 쉽다). 이 모듈은 토큰을 어떤 로그·모듈 변수·저장소에도 적지 않는다.
//   · `useCaching: false` 를 **명시**한다(expo-video 의 기본값이 false 이지만 기본값에 기대지 않는다). 플레이어 캐시가 꺼져 있어 영상
//     바이트가 디스크에 남지 않고, 서버도 `Cache-Control: private, no-store` 를 준다. 그래서 로그아웃 때 비울 영상 캐시가 없다.
//     포스터(≤256 KiB)는 사진 미리보기와 같은 앱 캐시 디렉터리(`oort-attachments`)에 받는다 — 같은 수명·같은 정책이다.
// =============================================================================

/** 재생이 어디까지 왔는가. 숫자인 것은 상태 이름을 문구처럼 흩어 적지 않기 위해서다(직접 문구 장부). */
export const PLAYBACK = { OPENING: 0, READY: 1, FAILED: 2, GONE: 3 } as const;
export type PlaybackPhase = (typeof PLAYBACK)[keyof typeof PLAYBACK];

const CACHE_DIRECTORY_NAME = 'oort-attachments';

/** 포스터 캐시의 상한(개). 영상 카드가 화면에 서는 만큼만 든다. */
const POSTER_CACHE_LIMIT = 60;

const posters = new Map<string, File>();
const posterRequests = new Map<string, Promise<File>>();

const posterKey = (workspaceId: string, channelId: string, attachmentId: string): string =>
  `poster:${workspaceId}:${channelId}:${attachmentId}`.toLowerCase();

function posterUrl(workspaceId: string, channelId: string, attachmentId: string): string {
  return `${apiBase()}/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(
    attachmentId,
  )}/poster`;
}

// ---- 포스터 -----------------------------------------------------------------

/**
 * 포스터를 앱 캐시로 받는다. 같은 포스터를 그리는 여러 카드(타임라인·스레드·전체 화면 썸네일)가 있어도 요청은 하나다.
 * 401 과 실패한 파일 정리는 사진·공유와 같은 길(`fetchToFile`)이다.
 */
export async function downloadAttachmentPoster(
  workspaceId: string,
  channelId: string,
  attachment: MessageAttachment,
): Promise<File> {
  const key = posterKey(workspaceId, channelId, attachment.id);
  const hit = posters.get(key);
  if (hit?.exists) return hit;
  const active = posterRequests.get(key);
  if (active !== undefined) return active;

  const directory = new Directory(Paths.cache, CACHE_DIRECTORY_NAME);
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  const destination = new File(directory, `${attachment.id}-poster`);

  const request = fetchToFile(posterUrl(workspaceId, channelId, attachment.id), destination)
    .then(file => {
      posters.set(key, file);
      while (posters.size > POSTER_CACHE_LIMIT) {
        const oldest = posters.keys().next();
        if (oldest.done) break;
        posters.delete(oldest.value);
      }
      return file;
    })
    .finally(() => posterRequests.delete(key));
  posterRequests.set(key, request);
  return request;
}

/**
 * 영상 카드·썸네일·전체 화면 쪽의 포스터 주소. 포스터가 없거나(보낸 기기가 프레임을 못 만들었다) 아직 받는 중이거나 못 받았으면 `null` —
 * 어느 쪽도 카드를 막지 않는다(카드는 제 크기와 재생 표지로 서고, 못 받은 포스터는 다음에 다시 그릴 때 다시 받는다).
 *
 * `media.hasPoster` 가 참일 때만 요청한다: 포스터가 없는 영상에 `GET …/poster` 를 보내면 서버는 404 만 답한다. `enabled` 가 거짓이면
 * (화면 밖 썸네일 등) 요청하지 않는다.
 */
export function useAttachmentPoster(
  workspaceId: string,
  channelId: string,
  attachment: MessageAttachment,
  enabled = true,
): string | null {
  const wants = enabled && attachmentMediaOf(attachment)?.hasPoster === true;
  const key = posterKey(workspaceId, channelId, attachment.id);
  const [uri, setUri] = useState<string | null>(() => {
    const hit = wants ? posters.get(key) : undefined;
    return hit?.exists ? hit.uri : null;
  });

  useEffect(() => {
    if (!wants) {
      setUri(null);
      return undefined;
    }
    const current = posters.get(key);
    if (current?.exists) {
      setUri(current.uri);
      return undefined;
    }
    let live = true;
    setUri(null);
    void downloadAttachmentPoster(workspaceId, channelId, attachment)
      .then(file => {
        if (live) setUri(file.uri);
      })
      .catch(() => {
        // 포스터가 없어도 카드는 선다 — 다음에 다시 그릴 때 다시 받는다.
      });
    return () => {
      live = false;
    };
    // `attachment` 객체가 아니라 id 로 건다: 같은 첨부가 다시 그려져도 요청을 새로 내지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, channelId, attachment.id, wants, key]);

  return uri;
}

// ---- 재생 소스 --------------------------------------------------------------

export type VideoOpenResult =
  /** 플레이어에 줄 소스. 헤더의 토큰은 방금 확인한 것이다. */
  | { phase: typeof PLAYBACK.READY; source: VideoSource }
  /** 서버가 더는 보여 주지 않는다(403·404·410) — 멤버가 아니거나 지워진 영상. 다시 시도해도 같다. */
  | { phase: typeof PLAYBACK.GONE }
  /** 서버에 닿지 못했거나 인가를 되살리지 못했거나 서버가 막혔다. 다시 시도해 볼 수 있다. */
  | { phase: typeof PLAYBACK.FAILED };

/**
 * 영상을 여는 한 길: 코어의 `HEAD` 확인(`probeAttachmentContent`)으로 이 세션이 그 파일을 읽을 수 있는지 묻고, 플레이어에 줄 소스를
 * 돌려준다. 처음 열 때와 재생 중 오류 뒤의 복구가 같은 이 함수를 쓴다(파일 머리 「재생의 인증」).
 *
 * `HEAD` 는 본문을 받지 않는다 — 구간 읽기를 쓰는 서버 기록에는 플레이어의 `Range` 요청만 남는다.
 */
export async function openVideoSource(
  workspaceId: string,
  channelId: string,
  attachment: MessageAttachment,
): Promise<VideoOpenResult> {
  let status: number;
  try {
    status = await probeAttachmentContent(workspaceId, channelId, attachment.id);
  } catch {
    // 서버에 닿지 못했다(연결 오류·시간 초과). 세션이 끝났다는 뜻이 아니다 — 코어가 만료를 선언하지 않았다.
    return { phase: PLAYBACK.FAILED };
  }
  if (status === 403 || status === 404 || status === 410) return { phase: PLAYBACK.GONE };
  // 401 은 여기서 소스를 만들지 않는 쪽이다: 코어가 이미 한 번의 회전을 거쳤고 세션 만료도 선언했다. `HEAD` 를 받지 않는 서버(405·501)는
  // 막힌 것이 아니라 확인하지 못한 것이므로 플레이어에게 맡긴다.
  const accepted = (status >= 200 && status < 300) || status === 405 || status === 501;
  if (!accepted) return { phase: PLAYBACK.FAILED };
  return {
    phase: PLAYBACK.READY,
    source: {
      uri: contentUrl(workspaceId, channelId, attachment.id),
      headers: authHeaders(),
      useCaching: false,
    },
  };
}

/** 테스트 사이에 모듈 전역 캐시가 상태를 흘리지 않게 한다. */
export function resetVideoContentForTest(): void {
  posters.clear();
  posterRequests.clear();
}
