import { useEffect, useState } from "react";

// 인가가 필요한 아바타 content 를 `<img>` 가 그릴 수 있는 `data:` URL 로 바꾸는
// 캐시 있는 훅 공장. 워크스페이스 아바타(ADR-0161 D5)와 멤버 아바타(증보 2026-10-01)
// 가 같은 길을 쓴다 — 이유는 `useWorkspaceAvatar.ts` 머리말 그대로다
// (`<img>` 는 Authorization 을 못 싣고, 배포 CSP `img-src 'self' data:` 는 blob: 을
// 거절한다). 캐시 키는 `avatarUrl` 의 `?v={media}` 이므로 교체되면 키가 바뀌고,
// 같은 아바타는 목록·메시지 수백 행이 써도 한 번만 받는다.

/** 세션 하나가 무한정 쌓지 않게 둔 상한. */
const PREVIEW_LIMIT = 128;

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

export function createAvatarImageHook(fetchBlob: (avatarUrl: string) => Promise<Blob>) {
  const previews = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();

  function remember(key: string, dataUrl: string): void {
    previews.delete(key);
    previews.set(key, dataUrl);
    while (previews.size > PREVIEW_LIMIT) {
      const oldest = previews.keys().next();
      if (oldest.done) break;
      previews.delete(oldest.value);
    }
  }

  /**
   * `avatarUrl` 의 `data:` URL, 불러오는 중이거나 실패하면 `null`. `null` 은 호출자가
   * 띄울 오류가 아니다 — 설계된 빈 상태(이니셜)로 물러난다. `undefined` 는 받을 것이
   * 없다는 뜻이라 아무것도 가져오지 않는다.
   */
  function useAvatar(avatarUrl: string | undefined): string | null {
    // 상태는 어느 주소의 결과인지 함께 든다 — 주소가 바뀐 첫 렌더에 앞 주소의
    // 이미지를 새 멤버 얼굴로 그리지 않게.
    const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);

    useEffect(() => {
      if (!avatarUrl) {
        setLoaded(null);
        return;
      }
      const hit = previews.get(avatarUrl);
      if (hit !== undefined) {
        setLoaded({ key: avatarUrl, url: hit });
        return;
      }
      let live = true;
      setLoaded(null);
      let request = inflight.get(avatarUrl);
      if (request === undefined) {
        request = fetchBlob(avatarUrl)
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
          if (live) setLoaded({ key: avatarUrl, url });
        })
        .catch(() => {
          // 이니셜이 정직한 폴백이다. 깨진 이미지는 더 나쁘다.
          if (live) setLoaded(null);
        });
      return () => {
        live = false;
      };
    }, [avatarUrl]);

    // 렌더 중에 캐시를 본다: 이미 받은 아바타는 effect 를 기다리지 않고 첫 그림부터
    // 이미지다(이니셜→이미지 깜박임 없음). 상태는 effect 가 따라온다.
    if (!avatarUrl) return null;
    return previews.get(avatarUrl) ?? (loaded?.key === avatarUrl ? loaded.url : null);
  }

  return {
    useAvatar,
    /**
     * 방금 올린 파일로 새 주소의 캐시를 미리 채운다. 사용자가 이미 가진 바이트이므로
     * 로스터가 새 `avatarUrl` 을 가져와도 이니셜로 되돌아갔다 이미지가 되는 깜박임이
     * 없고, 같은 바이트를 다시 받지도 않는다.
     */
    async prime(avatarUrl: string, blob: Blob): Promise<void> {
      remember(avatarUrl, await readAsDataUrl(blob));
    },
    /** 테스트 전용. */
    reset(): void {
      previews.clear();
      inflight.clear();
    },
  };
}
