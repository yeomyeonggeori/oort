import { useEffect, useState } from "react";
import { fetchUnfurlImage } from "@momo/core/lib/api";

// `<img>` cannot carry Authorization, and CSP admits `data:` but not `blob:`.
// Fetch the server proxy as bytes, then cache the safe display URL. A missing
// image is a valid card shape and stays silent.
const previews = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const PREVIEW_LIMIT = 48;

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

function remember(key: string, value: string): void {
  previews.set(key, value);
  while (previews.size > PREVIEW_LIMIT) {
    const oldest = previews.keys().next();
    if (oldest.done) break;
    previews.delete(oldest.value);
  }
}

export function useUnfurlImage(imageUrl: string | undefined): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(
    imageUrl ? previews.get(imageUrl) ?? null : null
  );

  useEffect(() => {
    if (!imageUrl) {
      setDataUrl(null);
      return;
    }
    const cached = previews.get(imageUrl);
    if (cached) {
      setDataUrl(cached);
      return;
    }
    let live = true;
    setDataUrl(null);
    let request = inflight.get(imageUrl);
    if (!request) {
      request = fetchUnfurlImage(imageUrl)
        .then(readAsDataUrl)
        .then((url) => {
          remember(imageUrl, url);
          return url;
        })
        .finally(() => inflight.delete(imageUrl));
      inflight.set(imageUrl, request);
    }
    request
      .then((url) => {
        if (live) setDataUrl(url);
      })
      .catch(() => {
        if (live) setDataUrl(null);
      });
    return () => {
      live = false;
    };
  }, [imageUrl]);

  return dataUrl;
}

export function resetUnfurlImagesForTest(): void {
  previews.clear();
  inflight.clear();
}
