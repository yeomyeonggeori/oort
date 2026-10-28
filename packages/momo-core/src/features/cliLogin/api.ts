import { fetchWithDeadline } from "../../lib/http";
import { record, responseRecord } from "../../lib/wire";
import { apiBase, coreSession } from "../../runtime/host";
import {
  CliLoginApiError,
  type CliApproveRequest,
  type CliDenyRequest,
} from "./consent";

// =============================================================================
// REST client for the oort CLI browser login consent (ADR-0216 D6-나, #4700).
//
//   GET  /v1/workspaces/{ws}/dev-access/authorization-requests/preview?request=
//   POST /v1/workspaces/{ws}/dev-access/authorization-requests/approve
//   POST /v1/workspaces/{ws}/dev-access/authorization-requests/deny
//
// 세 경로 모두 사람 세션 전용이다(개발자 토큰은 문에서 403). 응답은 어느 것도 두
// 번째 브라우저에 재생돼서는 안 되므로 `cache: "no-store"`로 보낸다: preview는
// 요청 사실을, decision 응답은 CLI로 갈 코드를 담은 redirectTo를 싣는다.
//
// ## 이 파일은 아무것도 로그하지 않는다
//
// 본문에는 현재 비밀번호가, 쿼리와 본문에는 서명된 요청 봉투가 흐른다. 실패에
// `console.warn(error)` 한 줄이 들어가면 그 값이 화면보다 오래 사는 devtools
// 버퍼로 간다. 오류에 남는 것은 상태·서버 문장·코드와 `Retry-After`뿐이다.
// =============================================================================

/** `Retry-After`의 초 값. 정수 초만 읽고(서버는 그것만 보낸다) 날짜 꼴은 모른 척한다. */
function retryAfterSeconds(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return seconds >= 1 ? seconds : undefined;
}

/**
 * 헤더가 없을 때만 보는 보조 경로: 오류 본문이 초를 싣는 서버(`error.retry_after_seconds`
 * 또는 최상위 `retry_after_seconds`)도 같은 값으로 읽는다. 지금 서버의 429·503은 헤더만
 * 보내고, 이 길은 그 약속이 본문으로 옮겨 가도 화면이 초를 잃지 않게 하는 것이다.
 */
function bodyRetryAfterSeconds(body: unknown): number | undefined {
  const row = record(body);
  const nested = record(row?.error);
  for (const value of [nested?.retry_after_seconds, row?.retry_after_seconds]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
      return Math.ceil(value);
    }
  }
  return undefined;
}

async function cliLoginRequest(
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const token = coreSession().getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetchWithDeadline(`${apiBase()}${path}`, {
    ...init,
    cache: "no-store",
    headers,
  });
  if (!res.ok) {
    // 화면은 STATUS와 `error.code`로 문장을 짓는다. 서버 문장은 진단용으로만 남는다.
    const body = res.jsonOrNull<{ error?: { message?: string; code?: unknown } }>();
    const code = body?.error?.code;
    throw new CliLoginApiError(
      res.status,
      body?.error?.message ?? `HTTP ${res.status}`,
      typeof code === "string" && code !== "" ? code : undefined,
      retryAfterSeconds(res.retryAfter) ?? bodyRetryAfterSeconds(body)
    );
  }
  return responseRecord(res.json<unknown>());
}

function collection(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId
  )}/dev-access/authorization-requests`;
}

/**
 * 동의 화면이 그릴 사실을 서버에서 되받는다. `request` 봉투를 제시하면 서버가
 * 클라이언트·서버 호스트·워크스페이스·승인하는 나·기기 이름·요청 범위·만료를
 * 돌려준다. 위조·만료·꺼짐·다른 종류의 봉투는 전부 같은 404다(non-enumerable).
 */
export function previewCliConsent(
  workspaceId: string,
  request: string
): Promise<unknown> {
  return cliLoginRequest(
    `${collection(workspaceId)}/preview?request=${encodeURIComponent(request)}`
  );
}

/**
 * 현재 비밀번호를 다시 확인하고 허용을 기록한다. 서버가 CLI의 루프백 콜백(코드·
 * state·iss)으로 갈 곳(redirectTo)을 돌려준다. 같은 요청의 두 번째 결정은 409다.
 */
export function approveCliConsent(
  workspaceId: string,
  body: CliApproveRequest
): Promise<unknown> {
  return cliLoginRequest(`${collection(workspaceId)}/approve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 거절을 기록한다. 서버는 `error=access_denied` 콜백을 돌려준다. 비밀번호는 필요 없다. */
export function denyCliConsent(
  workspaceId: string,
  body: CliDenyRequest
): Promise<unknown> {
  return cliLoginRequest(`${collection(workspaceId)}/deny`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
