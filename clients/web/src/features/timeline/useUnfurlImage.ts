import { useEffect, useState } from "react";
import { fetchUnfurlImage } from "@momo/core/lib/api";

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

function statusFor(imageUrl: string | undefined): UnfurlImageStatus {
  if (!imageUrl) return { kind: "absent" };
  const cached = previews.peek(imageUrl);
  if (cached) return { kind: "ready", dataUrl: cached };
  return { kind: "loading" };
}

export function useUnfurlImage(imageUrl: string | undefined): UnfurlImageStatus {
  const [status, setStatus] = useState<UnfurlImageStatus>(() =>
    statusFor(imageUrl)
  );
  const [trackedUrl, setTrackedUrl] = useState(imageUrl);
  if (imageUrl !== trackedUrl) {
    setTrackedUrl(imageUrl);
    setStatus(statusFor(imageUrl));
  }

  useEffect(() => {
    if (!imageUrl) return;
    const cached = previews.get(imageUrl);
    if (cached) {
      setStatus({ kind: "ready", dataUrl: cached });
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
        .finally(() => inflight.delete(imageUrl));
      inflight.set(imageUrl, request);
    }
    request
      .then((url) => {
        if (live) setStatus({ kind: "ready", dataUrl: url });
      })
      .catch(() => {
        if (live) setStatus({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, [imageUrl]);

  return status;
}

export function resetUnfurlImagesForTest(): void {
  previews.clear();
  inflight.clear();
}
