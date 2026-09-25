import { useCallback, useEffect, useState } from "react";
import {
  ATTACH_COPY,
  hasPdfSignature,
} from "@momo/core/features/attachments/model";
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
const previewListeners = new Map<string, Set<(state: PreviewState) => void>>();

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

function publishPreviewState(id: string, state: PreviewState): void {
  for (const listener of previewListeners.get(id) ?? []) listener(state);
}

function subscribePreviewState(
  id: string,
  listener: (state: PreviewState) => void
): () => void {
  let listeners = previewListeners.get(id);
  if (listeners === undefined) {
    listeners = new Set();
    previewListeners.set(id, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) previewListeners.delete(id);
  };
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

export type AttachmentPreviewState = PreviewState & { retry: () => void };

function loadAttachmentPreview(
  workspaceId: string,
  channelId: string,
  attachmentId: string
): Promise<string> {
  const hit = previews.get(attachmentId);
  if (hit !== undefined) {
    publishPreviewState(attachmentId, { status: "ready", dataUrl: hit });
    return Promise.resolve(hit);
  }

  let request = inflight.get(attachmentId);
  if (request !== undefined) return request;

  publishPreviewState(attachmentId, { status: "loading" });
  request = fetchAttachmentContent(workspaceId, channelId, attachmentId)
    .then(readAsDataUrl)
    .then((dataUrl) => {
      remember(attachmentId, dataUrl);
      publishPreviewState(attachmentId, { status: "ready", dataUrl });
      return dataUrl;
    })
    .catch((error: unknown) => {
      publishPreviewState(attachmentId, { status: "failed" });
      throw error;
    })
    .finally(() => inflight.delete(attachmentId));
  inflight.set(attachmentId, request);
  return request;
}

/**
 * 인라인 미리보기 한 장. `enabled` 가 거짓이면 요청 자체를 하지 않는다 — 미리보기를
 * 안 여는 첨부까지 바이트를 받아 오면 타임라인 한 화면이 수십 MB 를 긷는다.
 */
export function useAttachmentPreview(
  workspaceId: string,
  channelId: string,
  attachmentId: string,
  enabled: boolean
): AttachmentPreviewState {
  const cached = previews.get(attachmentId);
  const [state, setState] = useState<PreviewState>(
    cached === undefined
      ? { status: "loading" }
      : { status: "ready", dataUrl: cached }
  );

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribePreviewState(attachmentId, setState);
    const hit = previews.get(attachmentId);
    if (hit !== undefined) {
      setState({ status: "ready", dataUrl: hit });
      return unsubscribe;
    }
    setState({ status: "loading" });
    // 같은 첨부를 두 행이 동시에 그릴 수 있다(스레드 패널과 채널). 요청은 하나고,
    // 라이트박스의 재시도 결과도 이 구독으로 타임라인 미리보기에 함께 돌아온다.
    void loadAttachmentPreview(workspaceId, channelId, attachmentId).catch(() => {});
    return unsubscribe;
  }, [workspaceId, channelId, attachmentId, enabled]);

  const retry = useCallback(() => {
    if (!enabled) return;
    setState({ status: "loading" });
    void loadAttachmentPreview(workspaceId, channelId, attachmentId).catch(() => {});
  }, [workspaceId, channelId, attachmentId, enabled]);

  return { ...state, retry };
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

// ---- PDF 열기 (#2701) ------------------------------------------------------
//
// 임베드 뷰어가 아니라 새 창인 이유는 CSP 다. 웹은 `default-src 'self'`(그래서
// `frame-src`·`object-src` 도 'self'), 데스크탑은 `frame-src 'none'; object-src
// 'none'` 이다. 받은 바이트는 `blob:` 이나 `data:` 로만 화면에 걸 수 있는데 둘 다
// 'self' 가 아니므로 `<iframe>`·`<embed>` 는 빈 상자가 된다. CSP 를 넓히는 것은
// 보안 경계 변경이라 이 티켓의 권한이 아니다.
//
// 새 **최상위** 창의 탐색은 CSP 의 관할이 아니므로 `blob:` 을 걸 수 있다. 그 대신
// 그 창은 이 앱과 같은 출처의 문서다. 그래서 두 가지를 못 박는다:
//   1. Blob 타입은 서버가 준 타입이 아니라 이 쪽이 정한 `application/pdf` 다.
//      브라우저는 그것을 PDF 뷰어로 열지 HTML 로 해석하지 않는다.
//   2. 바이트 머리가 `%PDF-` 가 아니면 열지 않는다(`hasPdfSignature`).
//
// 창은 **클릭 순간** 먼저 연다(`window.open("")`). 바이트를 기다린 뒤에 열면
// 사용자 활성화가 만료돼 팝업 차단에 걸린다. 그 빈 창은 같은 출처라 `opener` 를
// 끊고, 바이트가 오면 `location.replace` 로 주소만 바꾼다.

export type PdfOpenFailure = "blocked" | "not-pdf" | "failed";

export class PdfOpenError extends Error {
  readonly reason: PdfOpenFailure;
  constructor(reason: PdfOpenFailure) {
    super(`pdf open ${reason}`);
    this.name = "PdfOpenError";
    this.reason = reason;
  }
}

/**
 * 새 창에 걸린 `blob:` 주소를 놓을 때까지의 시간. 즉시 놓으면 뷰어가 문서를 읽기
 * 전에 주소가 죽는다. 1분이면 느린 뷰어도 읽고, 탭 하나가 PDF 를 무한정 쥐지 않는다.
 */
const PDF_URL_LIFETIME_MS = 60_000;

/** 머리 판정에 읽는 바이트 수. `hasPdfSignature` 의 창과 같다. */
const PDF_HEAD_BYTES = 1024;

function readAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(result);
      else reject(new Error("pdf head"));
    };
    reader.onerror = () => reject(new Error("pdf head"));
    reader.readAsArrayBuffer(blob);
  });
}

/** 클릭 순간 부른다. 막혔으면 null 이다. */
export function openPdfWindow(): Window | null {
  const target = window.open("", "_blank");
  if (target === null) return null;
  try {
    target.opener = null;
  } catch {
    /* 교차 출처가 되는 브라우저는 없지만, 끊지 못해도 열기는 계속한다. */
  }
  try {
    // 바이트가 오기 전의 빈 창이 흰 면으로만 서 있지 않게 한 줄을 적는다.
    // 마크업이 아니라 텍스트 노드다: 이 문서는 이 앱과 같은 출처다.
    target.document.title = ATTACH_COPY.openingPdf;
    target.document.body.textContent = ATTACH_COPY.openingPdf;
  } catch {
    /* 적지 못해도 열기는 계속한다. */
  }
  return target;
}

/**
 * 열어 둔 창에 PDF 를 건다. 실패하면 그 창을 닫고 `PdfOpenError` 를 던진다 —
 * 빈 창을 남겨 두는 것은 화면이 아무 말도 안 하는 것과 같다.
 */
export async function openPdfAttachment(
  workspaceId: string,
  channelId: string,
  attachment: { id: string; name: string },
  target: Window
): Promise<void> {
  try {
    target.opener = null;
  } catch {
    /* openPdfWindow 와 같은 이유 */
  }
  let body: Blob;
  let head: ArrayBuffer;
  try {
    body = await fetchAttachmentContent(workspaceId, channelId, attachment.id);
    // 머리만 읽는다. 판정에 필요한 것은 앞 1 KB 이고, 본문은 Blob 째로 다시
    // 감싸면 된다 — 100 MB PDF 를 ArrayBuffer 로 한 번 더 복사할 이유가 없다.
    head = await readAsArrayBuffer(body.slice(0, PDF_HEAD_BYTES));
  } catch {
    target.close();
    throw new PdfOpenError("failed");
  }
  if (!hasPdfSignature(new Uint8Array(head))) {
    target.close();
    throw new PdfOpenError("not-pdf");
  }
  const href = URL.createObjectURL(new Blob([body], { type: "application/pdf" }));
  target.location.replace(href);
  setTimeout(() => URL.revokeObjectURL(href), PDF_URL_LIFETIME_MS);
}

/** 테스트 전용. 모듈 전역 캐시가 테스트 사이를 넘어가지 않게 한다. */
export function resetAttachmentPreviewsForTest(): void {
  previews.clear();
  inflight.clear();
  previewListeners.clear();
}
