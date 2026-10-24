import { useEffect, useState } from "react";
import { fetchApprovalAvatarPreview } from "@momo/core/lib/api";

// 승인 카드가 제안하는 사진(`avatar-preview`, ADR-0186 v3·v4)을 `<img>` 가 그릴 수 있는 `data:`
// URL 로 바꾸는 훅 (#4394). 길은 멤버 아바타와 같다(`sidebar/avatarImageStore.ts`): `<img>` 는
// Authorization 을 못 싣고 배포 CSP `img-src 'self' data:` 는 blob: 을 거절한다.
//
// 멤버 아바타 훅과 다른 점 하나: **실패를 따로 말한다.** 이 사진은 사진 주인 본인에게만 읽히고
// 나머지는 서버가 일부러 같은 404 로 답한다. 이니셜로 물러나면 되는 얼굴과 달리, 여기서는
// 「불러오는 중」과 「이 사람에게는 보이지 않는다」가 다른 문장이어야 한다.

export type ApprovalAvatarPreview =
  | { state: "loading" }
  | { state: "ready"; src: string }
  | { state: "unavailable" };

const CACHE_LIMIT = 32;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("avatar preview"));
    };
    reader.onerror = () => reject(new Error("avatar preview"));
    reader.readAsDataURL(blob);
  });
}

function load(path: string): Promise<string> {
  const hit = cache.get(path);
  if (hit !== undefined) return Promise.resolve(hit);
  let request = inflight.get(path);
  if (request === undefined) {
    request = fetchApprovalAvatarPreview(path)
      .then(readAsDataUrl)
      .then((url) => {
        cache.set(path, url);
        while (cache.size > CACHE_LIMIT) {
          const oldest = cache.keys().next();
          if (oldest.done) break;
          cache.delete(oldest.value);
        }
        return url;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, request);
  }
  return request;
}

/**
 * `previewPath` 는 코어 `approvalAvatarPreviewPath` 의 값이다. `null` 이면 받을 것이 없다
 * (재료가 모자란 카드) — 그때는 곧바로 `unavailable` 이다.
 */
export function useApprovalAvatarPreview(previewPath: string | null): ApprovalAvatarPreview {
  const [settled, setSettled] = useState<
    { path: string; result: "unavailable" | string } | null
  >(null);

  useEffect(() => {
    if (previewPath === null) return;
    let live = true;
    load(previewPath).then(
      (src) => {
        if (live) setSettled({ path: previewPath, result: src });
      },
      () => {
        if (live) setSettled({ path: previewPath, result: "unavailable" });
      }
    );
    return () => {
      live = false;
    };
  }, [previewPath]);

  if (previewPath === null) return { state: "unavailable" };
  // 주소가 바뀐 첫 렌더에 앞 카드의 사진을 그리지 않게 — 결과는 어느 주소의 것인지 함께 든다.
  const known = cache.get(previewPath) ?? (settled?.path === previewPath ? settled.result : null);
  if (known === null) return { state: "loading" };
  return known === "unavailable" ? { state: "unavailable" } : { state: "ready", src: known };
}

/** 테스트 전용. */
export function resetApprovalAvatarPreviewsForTest(): void {
  cache.clear();
  inflight.clear();
}
