// =============================================================================
// 바이트가 이 서버를 지나지 않는 유일한 요청 (ADR-0151 D1 / #1202 첨부 축).
//
// 나머지 첨부 호출 셋은 코어의 `lib/api.ts`에 있다. 이 한 건만 여기 있는 이유가
// 셋이다.
//
// 1. **베어러를 실으면 안 된다.** `uploadUrl`은 Google이 발급한 capability이고
//    그 URL을 아는 것이 곧 인가다. momo의 액세스 토큰을 제3자 호스트로 보내는
//    것은 그 자체로 사고이고, mac 테스트가 그 부재를 단정한다
//    (`MomoMacTests.swift:3392`).
// 2. **진행률을 재려면 `XMLHttpRequest`여야 한다.** `fetch()`에는 업로드 진행
//    이벤트가 없다(`ReadableStream` 업로드는 HTTP/2 이상에 duplex 협상을 요구하고
//    Safari에 없다). 100 MB를 올리는 동안 화면이 아무 말도 못 하는 것과, 브라우저가
//    이미 세고 있는 수를 읽는 것 중에서 후자를 고른다.
// 3. **코어에 들어갈 수 없다.** 코어는 `File`도 XHR도 모르는 층이다(순수성 게이트).
//
// ## 진행률은 거짓말을 하기 쉬운 수다
//
// `xhr.upload.onprogress`가 세는 것은 **소켓에 건넨 바이트**지 상대가 받은
// 바이트가 아니다. 느린 회선에서 그 수는 실제보다 앞서 달리고, 마지막 청크를
// 건넨 순간 100%가 된다 — 그때 서버는 아직 Drive에게 아무것도 묻지 않았다.
// 그래서 이 함수는 **100%를 알리지 않는다**: 상한을 0.99로 자르고, 진짜 끝은
// 호출부가 `complete` 왕복을 마친 뒤 `verifying`을 지나 선언한다
// (`@momo/core/features/attachments/model`의 칸 하나가 그것이다).
//
// ## CSP는 소리 없이 막는다
//
// 이 PUT의 목적지는 배포에 따라 다르다. Tauri 셸의 정책은 `connect-src 'self'
// http: https: ws: wss:`라 어디로든 나가지만, **브라우저 배포의 정책은
// `connect-src 'self' wss://REALTIME https://REALTIME`이고 Google은 그 목록에
// 없다**(`infra/prod/Caddyfile:123`). 그때 XHR은 status 0으로 실패하고, 그것은
// 네트워크가 끊긴 것과 구별되지 않는다.
//
// 구별하는 방법은 이 레포가 이미 한 번 골랐다: 문서의 `securitypolicyviolation`
// 을 듣고 막힌 주소가 내가 부른 그 주소인지 본다(`observerStream.cspBlockedHost`
// 가 관전 소켓에 대고 같은 일을 한다). 그래야 화면이 호스트를 탓하거나 영원히
// 도는 대신 **배포 설정이 막았다**는 참말을 한다.
// =============================================================================

/** 진행률로 알릴 수 있는 최대. 1은 `complete`가 답한 뒤에만 참이다. */
const PROGRESS_CEILING = 0.99;

export type UploadFailure = "blocked" | "aborted" | "status" | "network";

export interface UploadResult {
  ok: boolean;
  /** 실패했을 때만. */
  failure?: UploadFailure;
  /** `failure === "status"`일 때 상대가 답한 코드. */
  status?: number;
}

export interface UploadHandle {
  /** 끝나거나 실패할 때까지. 던지지 않는다. */
  done: Promise<UploadResult>;
  /** 사람이 칩을 지웠거나 채널을 떠났다. 실패가 아니다. */
  abort: () => void;
}

/**
 * 막힌 주소의 호스트를 읽는다. 위반 이벤트는 `blockedURI`에 전체 URL을 싣고,
 * 정책에 따라 출처만 싣기도 한다. 어느 쪽이든 호스트만 비교하면 된다.
 */
function violationHost(blockedURI: string): string | null {
  try {
    return new URL(blockedURI).host;
  } catch {
    return null;
  }
}

function targetHost(url: string): string | null {
  try {
    return new URL(url, window.location.href).host;
  } catch {
    return null;
  }
}

/**
 * capability URL로 바이트를 올린다.
 *
 * `url`은 이 함수 밖으로 나가지 않는다. 실패를 알릴 때도 주소를 싣지 않는다 —
 * capability URL은 비밀이고, 진단 문자열에 섞여 로그로 새는 것이 mac 백엔드가
 * 자기 주석에 적어 둔 바로 그 사고다.
 */
export function putAttachmentBytes(
  url: string,
  file: Blob,
  mime: string,
  onProgress: (fraction: number) => void
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const host = targetHost(url);
  let cspBlocked = false;

  const onViolation = (event: Event) => {
    const violation = event as SecurityPolicyViolationEvent;
    if (!violation.effectiveDirective?.startsWith("connect-src")) return;
    const blocked = violationHost(violation.blockedURI ?? "");
    if (blocked !== null && host !== null && blocked !== host) return;
    cspBlocked = true;
  };
  document.addEventListener("securitypolicyviolation", onViolation);

  const done = new Promise<UploadResult>((resolve) => {
    const settle = (result: UploadResult) => {
      document.removeEventListener("securitypolicyviolation", onViolation);
      resolve(result);
    };

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total === 0) return;
      onProgress(Math.min(PROGRESS_CEILING, event.loaded / event.total));
    });
    xhr.addEventListener("load", () => {
      // Drive의 재개 가능 세션은 마지막 청크에 200 또는 201로 답한다. 그 밖의
      // 코드는 이 요청이 끝나지 않았다는 뜻이므로 성공으로 읽지 않는다.
      if (xhr.status === 200 || xhr.status === 201) settle({ ok: true });
      else settle({ ok: false, failure: "status", status: xhr.status });
    });
    xhr.addEventListener("error", () => {
      settle({ ok: false, failure: cspBlocked ? "blocked" : "network" });
    });
    xhr.addEventListener("timeout", () => {
      settle({ ok: false, failure: "network" });
    });
    xhr.addEventListener("abort", () => {
      settle({ ok: false, failure: "aborted" });
    });

    xhr.open("PUT", url, true);
    // 선언한 mime 그대로. 서버가 `complete`에서 Drive가 기록한 mime과 대조하므로,
    // 여기서 브라우저가 추측한 값을 쓰면 그 대조가 409로 떨어진다.
    xhr.setRequestHeader("Content-Type", mime);
    xhr.send(file);
  });

  return { done, abort: () => xhr.abort() };
}
