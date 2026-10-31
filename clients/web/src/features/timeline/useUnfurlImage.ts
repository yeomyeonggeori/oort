import { useEffect, useState } from "react";
import { ApiError, fetchUnfurlImage } from "@momo/core/lib/api";

// `<img>` cannot carry Authorization, and CSP admits `data:` but not `blob:`.
// Fetch the server proxy as bytes, then cache the safe display URL. A missing
// image is a valid card shape and stays silent.
const inflight = new Map<string, Promise<string>>();
export const UNFURL_IMAGE_CACHE_ENTRY_LIMIT = 48;
// ADR-0170 caps an original image at 5 MiB. FileReader's base64 data URL can
// expand that to about 6.7 MiB, so 32 MiB keeps four worst-case previews while
// preventing the old 48-entry ceiling from retaining roughly 300 MiB. The
// entry limit remains useful for channels containing many small thumbnails.
export const UNFURL_IMAGE_CACHE_BYTE_LIMIT = 32 * 1024 * 1024;

type CachedPreview = { dataUrl: string; bytes: number };

export class UnfurlImageCache {
  private readonly previews = new Map<string, CachedPreview>();
  private usedBytes = 0;

  constructor(
    private readonly entryLimit = UNFURL_IMAGE_CACHE_ENTRY_LIMIT,
    private readonly byteLimit = UNFURL_IMAGE_CACHE_BYTE_LIMIT
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
    // Map iteration order is the LRU ledger. A cache hit becomes newest.
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
    // FileReader produces an ASCII `data:<mime>;base64,...` string, so its
    // code-unit length is also its encoded byte length.
    const cached = { dataUrl, bytes: dataUrl.length };
    this.previews.set(key, cached);
    this.usedBytes += cached.bytes;
    while (
      this.previews.size > this.entryLimit ||
      this.usedBytes > this.byteLimit
    ) {
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

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("unfurl image"));
    reader.onerror = () => reject(new Error("unfurl image"));
    reader.readAsDataURL(blob);
  });
}

export type UnfurlImageStatus =
  | { kind: "absent" }
  | { kind: "loading" }
  | { kind: "ready"; dataUrl: string }
  | { kind: "failed" };

// One shared value, so "failed" is written once in this file.
const FAILED: UnfurlImageStatus = { kind: "failed" };

// An answer that says "not now" or "not here" is remembered, so a card that scrolls out and back
// in does not ask the proxy again. The proxy keeps a 404 for ten minutes itself, and a 429 comes
// with the wait it wants (#4956); asking sooner only spends the member's budget. A network error
// is not remembered: the next mount may succeed.
export const UNFURL_FAILURE_MEMORY_MS = 10 * 60 * 1000;
// A server that asks for a very long wait is obeyed, but not for longer than this per page life.
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
  if (!imageUrl) return { kind: "absent" };
  const cached = previews.peek(imageUrl);
  if (cached) return { kind: "ready", dataUrl: cached };
  if (recentlyFailed(imageUrl)) return FAILED;
  return { kind: "loading" };
}

/**
 * `enabled` is the lazy-loading gate: until it is true nothing is requested (a copy already in
 * the cache is still shown). A site icon passes "this card is on screen", because the proxy goes
 * out to the site the first time anyone asks for it.
 */
export function useUnfurlImage(
  imageUrl: string | undefined,
  { enabled = true }: { enabled?: boolean } = {}
): UnfurlImageStatus {
  const [status, setStatus] = useState<UnfurlImageStatus>(() =>
    statusFor(imageUrl)
  );
  const [trackedUrl, setTrackedUrl] = useState(imageUrl);
  if (imageUrl !== trackedUrl) {
    setTrackedUrl(imageUrl);
    setStatus(statusFor(imageUrl));
  }

  useEffect(() => {
    if (!imageUrl || !enabled) return;
    const cached = previews.get(imageUrl);
    if (cached) {
      setStatus({ kind: "ready", dataUrl: cached });
      return;
    }
    if (recentlyFailed(imageUrl)) {
      setStatus(FAILED);
      return;
    }
    let live = true;
    let request = inflight.get(imageUrl);
    if (!request) {
      request = fetchUnfurlImage(imageUrl)
        .then(readAsDataUrl)
        .then((url) => {
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
      .then((url) => {
        if (live) setStatus({ kind: "ready", dataUrl: url });
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

/**
 * True from the first moment the element is on screen, and it stays true. Without an
 * IntersectionObserver (an engine that old does not ship in any browser or webview we run)
 * the element counts as visible, so the icon is never held back for good.
 */
export function useVisibleOnce(): [(element: Element | null) => void, boolean] {
  const [element, setElement] = useState<Element | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible || !element) return;
    const Observer: typeof IntersectionObserver | undefined =
      globalThis.IntersectionObserver;
    if (!Observer) {
      setVisible(true);
      return;
    }
    const observer = new Observer((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, visible]);
  return [setElement, visible];
}

export function resetUnfurlImagesForTest(): void {
  previews.clear();
  inflight.clear();
  failures.clear();
}
