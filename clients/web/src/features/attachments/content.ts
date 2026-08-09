import { useEffect, useState } from "react";
import { fetchAttachmentContent } from "@momo/core/lib/api";

// =============================================================================
// 첨부 바이트를 화면으로 (ADR-0151 D2 / #1202 첨부 축).
//
// 바이트로 가는 길은 하나다: `GET …/attachments/{id}/content`, 베어러를 실은
// 인가 프록시. Drive URL 은 클라에 오지 않고, 서버가 채널 멤버십을 확인한 뒤에야
// 스트림을 연다. 그래서 이 파일이 하는 일은 「받아서 화면에 거는 것」뿐이고,
// 「누가 볼 수 있는가」는 한 줄도 여기서 판정하지 않는다 — 서버가 404 로 답하면
// 카드가 실패를 말하고 끝이다(클라가 임의로 잠그면 서버 판정과 두 개의 답이 생긴다).
//
// ## 왜 `data:` URL 인가 — 고른 것이 아니라 남은 것이다
//
// 세 제약이 동시에 걸린다.
//
//   1. `<img src>` 는 `Authorization` 헤더를 실을 수 없다. 그래서 프록시 주소를
//      그대로 걸 수 없고, 바이트를 먼저 받아야 한다.
//   2. 받은 `Blob` 을 `URL.createObjectURL` 로 걸면 `blob:` 스킴이 되는데,
//      배포된 CSP 는 `img-src 'self' data:` 다 — `blob:` 은 `'self'` 가 아니고
//      (스킴이 다르다) 목록에도 없다. 깨진 상자로 그려진다.
//   3. CSP 를 넓히는 것은 이 티켓의 권한이 아니다(보안 경계 = ADR 사안).
//
// 남는 것이 `data:` 다. 대가는 base64 의 약 1.33배 메모리이고, 그래서 코어가
// `INLINE_PREVIEW_MAX_BYTES` 로 상한을 둔다. 상한을 넘는 이미지는 미리보기 대신
// 파일 카드로 서고, 그것은 잘린 미리보기보다 정직하다.
//
// 내려받기는 다른 이야기다. `<a download>` 는 `img-src` 의 관할이 아니므로
// `blob:` 을 그대로 쓸 수 있고, 100 MB 를 base64 로 만들 이유가 없다.
// =============================================================================

/**
 * 이미 만든 미리보기. **모듈 전역**인 이유는 react-virtuoso 가 화면 밖 행을
 * 언마운트하기 때문이다: 컴포넌트 상태에 두면 스크롤을 올렸다 내릴 때마다 같은
 * 이미지를 다시 받는다. 서버가 `Cache-Control: private, no-store` 를 붙이므로
 * 브라우저 캐시는 그것을 대신해 주지 않는다.
 */
const previews = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** 세션 하나가 무한정 쌓지 않게. 오래된 것부터 놓는다(Map 은 삽입 순서를 안다). */
const PREVIEW_LIMIT = 60;

function remember(id: string, dataUrl: string): void {
  previews.set(id, dataUrl);
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
      else reject(new Error("preview"));
    };
    reader.onerror = () => reject(new Error("preview"));
    reader.readAsDataURL(blob);
  });
}

export type PreviewState =
  | { status: "loading" }
  | { status: "ready"; dataUrl: string }
  | { status: "failed" };

/**
 * 인라인 미리보기 한 장. `enabled` 가 거짓이면 요청 자체를 하지 않는다 — 미리보기를
 * 안 여는 첨부까지 바이트를 받아 오면 타임라인 한 화면이 수십 MB 를 긷는다.
 */
export function useAttachmentPreview(
  workspaceId: string,
  channelId: string,
  attachmentId: string,
  enabled: boolean
): PreviewState {
  const cached = previews.get(attachmentId);
  const [state, setState] = useState<PreviewState>(
    cached === undefined
      ? { status: "loading" }
      : { status: "ready", dataUrl: cached }
  );

  useEffect(() => {
    if (!enabled) return;
    const hit = previews.get(attachmentId);
    if (hit !== undefined) {
      setState({ status: "ready", dataUrl: hit });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    // 같은 첨부를 두 행이 동시에 그릴 수 있다(스레드 패널과 채널). 요청은 하나다.
    let request = inflight.get(attachmentId);
    if (request === undefined) {
      request = fetchAttachmentContent(workspaceId, channelId, attachmentId)
        .then(readAsDataUrl)
        .then((dataUrl) => {
          remember(attachmentId, dataUrl);
          return dataUrl;
        })
        .finally(() => inflight.delete(attachmentId));
      inflight.set(attachmentId, request);
    }
    request
      .then((dataUrl) => {
        if (live) setState({ status: "ready", dataUrl });
      })
      .catch(() => {
        if (live) setState({ status: "failed" });
      });
    return () => {
      live = false;
    };
  }, [workspaceId, channelId, attachmentId, enabled]);

  return state;
}

/**
 * 파일을 디스크로.
 *
 * `<a href download>` 를 만들어 누르고 곧바로 치운다. 서버가 이미
 * `Content-Disposition: attachment` 를 붙이지만 그 헤더는 **주소로 이동할 때만**
 * 뜻이 있고, 여기서는 바이트가 이미 손에 있다 — 이름을 붙이는 것은 이 쪽이다.
 *
 * 실패는 던진다. 부르는 카드가 자기 자리에서 문장으로 말한다.
 */
export async function downloadAttachment(
  workspaceId: string,
  channelId: string,
  attachment: { id: string; name: string }
): Promise<void> {
  const blob = await fetchAttachmentContent(
    workspaceId,
    channelId,
    attachment.id
  );
  const href = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = attachment.name;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // 즉시 놓으면 Safari 가 저장을 시작하기 전에 주소가 죽는다. 한 틱 뒤에.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
}

/** 테스트 전용. 모듈 전역 캐시가 테스트 사이를 넘어가지 않게 한다. */
export function resetAttachmentPreviewsForTest(): void {
  previews.clear();
  inflight.clear();
}
