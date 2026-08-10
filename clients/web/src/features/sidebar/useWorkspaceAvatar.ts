import { useEffect, useState } from "react";
import { fetchWorkspaceAvatar } from "@momo/core/lib/api";

// =============================================================================
// 워크스페이스 아바타 바이트를 레일 타일로 (ADR-0161 D5).
//
// `<img src>` 는 Authorization 헤더를 실을 수 없고, content 프록시는 베어러를
// 요구한다(어느 워크스페이스 멤버든 읽되, 멤버여야 읽는다). 그래서 첨부 미리보기
// (`features/attachments/content.ts`)와 같은 길을 간다: 인가된 fetch 로 바이트를
// 받아 `data:` URL 로 건다. `blob:` 이 아니라 `data:` 인 이유도 같다 — 배포된
// CSP 가 `img-src 'self' data:` 라 blob 스킴은 깨진 상자로 그려진다.
//
// 캐시 키는 `avatarUrl`(그 안의 `?v={media}`)이다. 교체되면 URL 이 바뀌어 캐시가
// 저절로 무효화되고, 같은 아바타는 다시 받지 않는다. 서버가 `immutable` 을 실으므로
// 브라우저 HTTP 캐시도 같은 판정을 돕는다.
// =============================================================================

const previews = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** 세션 하나가 무한정 쌓지 않게. 레일은 워크스페이스 수만큼만 쓰지만 상한을 둔다. */
const PREVIEW_LIMIT = 32;

function remember(key: string, dataUrl: string): void {
  previews.set(key, dataUrl);
  while (previews.size > PREVIEW_LIMIT) {
    const oldest = previews.keys().next();
    if (oldest.done) break;
    previews.delete(oldest.value);
  }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("avatar preview"));
    };
    reader.onerror = () => reject(new Error("avatar preview"));
    reader.readAsDataURL(blob);
  });
}

/**
 * The avatar `data:` URL for `avatarUrl`, or `null` while it loads or on failure.
 *
 * A `null` result is not an error the caller must surface: the rail simply falls
 * back to the name initial, which is the designed empty state (ADR-0161 D5,
 * "없으면 텍스트 이니셜"). `avatarUrl === undefined` means the workspace has no
 * avatar at all, and nothing is fetched.
 */
export function useWorkspaceAvatar(avatarUrl: string | undefined): string | null {
  const cached = avatarUrl ? previews.get(avatarUrl) ?? null : null;
  const [dataUrl, setDataUrl] = useState<string | null>(cached);

  useEffect(() => {
    if (!avatarUrl) {
      setDataUrl(null);
      return;
    }
    const hit = previews.get(avatarUrl);
    if (hit !== undefined) {
      setDataUrl(hit);
      return;
    }
    let live = true;
    setDataUrl(null);
    let request = inflight.get(avatarUrl);
    if (request === undefined) {
      request = fetchWorkspaceAvatar(avatarUrl)
        .then(readAsDataUrl)
        .then((url) => {
          remember(avatarUrl, url);
          return url;
        })
        .finally(() => inflight.delete(avatarUrl));
      inflight.set(avatarUrl, request);
    }
    request
      .then((url) => {
        if (live) setDataUrl(url);
      })
      .catch(() => {
        // The initial is the honest fallback; a broken image would be worse.
        if (live) setDataUrl(null);
      });
    return () => {
      live = false;
    };
  }, [avatarUrl]);

  return dataUrl;
}

/** 테스트 전용. 모듈 전역 캐시가 테스트 사이를 넘어가지 않게 한다. */
export function resetWorkspaceAvatarsForTest(): void {
  previews.clear();
  inflight.clear();
}
