import {fetchWithDeadline, type HttpResponse} from '@momo/core/lib/http';
import {apiBase, coreSession} from '@momo/core/runtime/host';

// =============================================================================
// 잠금 화면 승인의 자격 (#3931, ADR-0204 D6; 서버 #3927).
//
// 잠금 화면의 [승인]/[거절]은 화면도 JS 도 없이 깨어난 네이티브 코드가 받는다. 그
// 코드가 쓰는 bearer 는 앱의 access 토큰이 아니라 `POST /v1/auth/push-action-token` 이
// 내주는 토큰이다: 허용 경로가 **하나**(`POST /v1/workspaces/{ws}/approvals/{id}/decision`,
// 자기 워크스페이스에서만)이고, 갱신 절반이 없고, 6시간 뒤 만료되며, 다른 토큰을 발급하지
// 못한다. 권한을 더하지 않는다 — 결정 라우트의 검사(사람·채널 멤버·역할·만료·멱등)는
// 그대로 그 사람에게 걸린다.
//
// `pushFetchToken.ts` 와 같은 모양이고 같은 이유로 같은 규율이다: 앱이 돌고 세션이 있을 때만
// 받을 수 있고(그래서 `pushActionSession.ts` 가 폰에 놔둔다), **어떤 실패에도 access 토큰으로
// 대신하지 않는다** — 그게 이 자격이 막으려는 일이다.
// =============================================================================

export interface MintedPushActionToken {
  token: string;
  expiresAtMs: number;
  ttlSeconds: number;
  workspaceId: string;
}

export const PUSH_ACTION_TOKEN_PATH = '/v1/auth/push-action-token';

/**
 * 토큰을 받는다. **어떤 실패에도 null** 이다 — 오프라인, 401(access 토큰이 회전하는
 * 사이), 403(좁은 토큰으로 부른 경우), 409(계열이 아직 없는 세션), 429(세션당 살아 있는
 * 토큰 4개 상한), 이 라우트가 없는 옛 서버(404). 부른 쪽은 아무것도 놓지 말고 다음 세션
 * 변화에 다시 시도한다. 잠금 화면은 토큰이 없으면 「…하지 못했어요 / 눌러서 앱에서 마무리해 주세요」라고 말한다 —
 * 그것이 이 자격이 없을 때의 정직한 답이다.
 */
export async function mintPushActionToken(): Promise<MintedPushActionToken | null> {
  const access = coreSession().getAccessToken();
  if (!access) {
    return null;
  }
  let response: HttpResponse;
  try {
    response = await fetchWithDeadline(`${apiBase()}${PUSH_ACTION_TOKEN_PATH}`, {
      method: 'POST',
      headers: new Headers({Authorization: `Bearer ${access}`}),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  try {
    const body = (await response.json()) as Partial<MintedPushActionToken>;
    if (
      typeof body.token !== 'string' ||
      body.token.length === 0 ||
      typeof body.expiresAtMs !== 'number' ||
      !Number.isFinite(body.expiresAtMs) ||
      typeof body.ttlSeconds !== 'number' ||
      !Number.isFinite(body.ttlSeconds) ||
      body.ttlSeconds <= 0 ||
      typeof body.workspaceId !== 'string' ||
      body.workspaceId.length === 0
    ) {
      return null;
    }
    return {
      token: body.token,
      expiresAtMs: body.expiresAtMs,
      ttlSeconds: body.ttlSeconds,
      workspaceId: body.workspaceId,
    };
  } catch {
    return null;
  }
}
