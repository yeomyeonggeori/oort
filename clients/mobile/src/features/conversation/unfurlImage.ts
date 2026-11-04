import {ApiError, fetchUnfurlImage} from '@momo/core/lib/api';
import {useEffect, useState} from 'react';

// =============================================================================
// 링크 카드의 그림·사이트 아이콘을 싣는 길 (ADR-0170 D5·D9, #4883).
//
// 웹 `clients/web/src/features/timeline/useUnfurlImage.ts` 와 **같은 규칙**이다: 주소는 서버 프록시 경로
// (`…/unfurls/{id}/image`·`…/icon`)뿐이고 코어 `fetchUnfurlImage` 가 그 모양이 아니면 토큰을 싣지 않고 거절한다.
// 원격 주소는 이 앱이 한 번도 부르지 않는다. 받은 바이트는 `data:` 주소로 바꿔 `<Image>` 에 준다 — 헤더를 못 싣는
// `uri` 로 인가 경로를 읽으면 401 회색 상자가 남기 때문이다. 실패는 **조용히** `failed` 가 되고(오류 문구 없음),
// 카드는 코어 모델이 정한 타일로 내려앉는다.
//
//   - 같은 주소는 한 번만 받고(진행 중인 요청도 나눈다), 메모리 캐시는 항목 수와 바이트 둘 다 상한이 있다.
//   - 프록시가 **404**(사이트에 없음, 서버가 10분 기억)나 **429**(남용 막이, `Retry-After`)로 답하면 같은 시간 동안
//     다시 묻지 않는다 — 카드가 화면을 나갔다 들어와도 예산을 쓰지 않는다. 429 의 기다림은 서버가 말한 초(상한 1시간)다.
//     네트워크 오류는 기억하지 않는다: 다음에 카드가 서는 때 다시 묻는다.
//   - `enabled` 가 거짓인 동안은 **아무것도 요청하지 않는다**(이미 캐시에 있는 사본은 보인다). 사이트 아이콘은 「카드가
//     화면에 보인 뒤」에만 켠다 — 프록시가 처음 묻는 그때 사이트로 나가기 때문이다(`rowViewability.ts`).
//
// 웹과 달리 이 길은 폰의 JS 힙에 문자열을 든다. 그래서 상한은 웹과 같은 값(항목 48 · 32 MiB, 원본 상한 5 MiB 가
// base64 로 ≈6.7 MiB)이고, 더 키우려면 디스크 캐시(`memberAvatarImage.ts`)로 가야 한다.
// =============================================================================

export const UNFURL_IMAGE_CACHE_ENTRY_LIMIT = 48;
export const UNFURL_IMAGE_CACHE_BYTE_LIMIT = 32 * 1024 * 1024;

interface CachedPreview {
  dataUrl: string;
  bytes: number;
}

export class UnfurlImageCache {
  private readonly previews = new Map<string, CachedPreview>();
  private usedBytes = 0;

  constructor(
    private readonly entryLimit = UNFURL_IMAGE_CACHE_ENTRY_LIMIT,
    private readonly byteLimit = UNFURL_IMAGE_CACHE_BYTE_LIMIT,
  ) {}

  get size(): number {
    return this.previews.size;
  }

  get bytes(): number {
    return this.usedBytes;
  }

  peek(key: string): string | undefined {
    return this.previews.get(key)?.dataUrl;
  }

  get(key: string): string | undefined {
    const cached = this.previews.get(key);
    if (!cached) return undefined;
    // 삽입 순서가 LRU 장부다. 읽힌 것은 가장 새것이 된다.
    this.previews.delete(key);
    this.previews.set(key, cached);
    return cached.dataUrl;
  }

  remember(key: string, dataUrl: string): void {
    const replaced = this.previews.get(key);
    if (replaced) {
      this.previews.delete(key);
      this.usedBytes -= replaced.bytes;
    }
    // `data:<mime>;base64,…` 는 ASCII 라 문자열 길이가 곧 바이트 수다.
    const cached = {dataUrl, bytes: dataUrl.length};
    this.previews.set(key, cached);
    this.usedBytes += cached.bytes;
    while (this.previews.size > this.entryLimit || this.usedBytes > this.byteLimit) {
      const oldest = this.previews.entries().next();
      if (oldest.done) break;
      this.previews.delete(oldest.value[0]);
      this.usedBytes -= oldest.value[1].bytes;
    }
  }

  clear(): void {
    this.previews.clear();
    this.usedBytes = 0;
  }
}

const previews = new UnfurlImageCache();
const inflight = new Map<string, Promise<string>>();

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('unfurl image'));
    reader.onerror = () => reject(new Error('unfurl image'));
    reader.readAsDataURL(blob);
  });
}

/** 프록시에서 바이트를 받아 `data:` 주소로. 시험이 가짜로 바꿀 수 있는 이음매다. */
async function defaultLoad(imageUrl: string): Promise<string> {
  return readAsDataUrl(await fetchUnfurlImage(imageUrl));
}

let load: (imageUrl: string) => Promise<string> = defaultLoad;

export type UnfurlImageStatus =
  | {kind: 'absent'}
  | {kind: 'loading'}
  | {kind: 'ready'; dataUrl: string}
  | {kind: 'failed'};

const FAILED: UnfurlImageStatus = {kind: 'failed'};

// 「지금은 아니다」「여기엔 없다」라는 답은 기억한다. 네트워크 오류는 기억하지 않는다(다음 마운트가 성공할 수 있다).
export const UNFURL_FAILURE_MEMORY_MS = 10 * 60 * 1000;
const FAILURE_MEMORY_CEILING_MS = 60 * 60 * 1000;
const FAILURE_MEMORY_LIMIT = 256;
const REMEMBERED_STATUSES: readonly number[] = [404, 429];
const failures = new Map<string, number>();

function recentlyFailed(imageUrl: string): boolean {
  const until = failures.get(imageUrl);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  failures.delete(imageUrl);
  return false;
}

function rememberFailure(imageUrl: string, error: unknown): void {
  if (!(error instanceof ApiError) || !REMEMBERED_STATUSES.includes(error.status)) return;
  const wait =
    error.retryAfterSeconds !== undefined
      ? Math.min(error.retryAfterSeconds * 1000, FAILURE_MEMORY_CEILING_MS)
      : UNFURL_FAILURE_MEMORY_MS;
  failures.delete(imageUrl);
  failures.set(imageUrl, Date.now() + wait);
  while (failures.size > FAILURE_MEMORY_LIMIT) {
    const oldest = failures.keys().next();
    if (oldest.done) break;
    failures.delete(oldest.value);
  }
}

function statusFor(imageUrl: string | undefined): UnfurlImageStatus {
  if (!imageUrl) return {kind: 'absent'};
  const cached = previews.peek(imageUrl);
  if (cached) return {kind: 'ready', dataUrl: cached};
  if (recentlyFailed(imageUrl)) return FAILED;
  return {kind: 'loading'};
}

/** 받아 둔 `data:` 주소, 아니면 `null`. 화면이 상태 낱말을 직접 비교하지 않게 이 파일이 답한다. */
export function readyUri(status: UnfurlImageStatus): string | null {
  return status.kind === 'ready' ? status.dataUrl : null;
}

/** 받기가 실패했다(404·429 기억 포함). 카드는 이때 코어 모델대로 타일로 내려앉는다. */
export function hasFailed(status: UnfurlImageStatus): boolean {
  return status.kind === 'failed';
}

/**
 * `enabled` 는 게으른 적재의 문이다: 참이 되기 전에는 아무것도 요청하지 않는다(캐시에 이미 있는 사본은 보인다).
 * 사이트 아이콘은 「카드가 화면에 보였다」를 준다.
 */
export function useUnfurlImage(
  imageUrl: string | undefined,
  {enabled = true}: {enabled?: boolean} = {},
): UnfurlImageStatus {
  const [status, setStatus] = useState<UnfurlImageStatus>(() => statusFor(imageUrl));
  const [trackedUrl, setTrackedUrl] = useState(imageUrl);
  if (imageUrl !== trackedUrl) {
    setTrackedUrl(imageUrl);
    setStatus(statusFor(imageUrl));
  }

  useEffect(() => {
    if (!imageUrl || !enabled) return undefined;
    const cached = previews.get(imageUrl);
    if (cached) {
      setStatus({kind: 'ready', dataUrl: cached});
      return undefined;
    }
    if (recentlyFailed(imageUrl)) {
      setStatus(FAILED);
      return undefined;
    }
    let live = true;
    let request = inflight.get(imageUrl);
    if (!request) {
      request = load(imageUrl)
        .then(url => {
          previews.remember(imageUrl, url);
          return url;
        })
        .catch((error: unknown) => {
          rememberFailure(imageUrl, error);
          throw error;
        })
        .finally(() => inflight.delete(imageUrl));
      inflight.set(imageUrl, request);
    }
    request
      .then(url => {
        if (live) setStatus({kind: 'ready', dataUrl: url});
      })
      .catch(() => {
        if (live) setStatus(FAILED);
      });
    return () => {
      live = false;
    };
  }, [imageUrl, enabled]);

  return status;
}

/** 시험용: 모듈 상태를 처음으로. 받는 길을 가짜로 바꿨다면 `loader` 로 넘기고, 비우면 진짜 길로 돌아간다. */
export function resetUnfurlImagesForTest(
  loader?: (imageUrl: string) => Promise<string>,
): void {
  previews.clear();
  inflight.clear();
  failures.clear();
  load = loader ?? defaultLoad;
}
