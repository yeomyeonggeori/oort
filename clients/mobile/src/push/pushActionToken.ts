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
 * 서버가 내주는 수명은 6시간이다. 이 상한은 그보다 한참 위(일주일)로, 정상 응답을 막으려는 것이
 * 아니라 터무니없는 값(수년짜리 수명, 지수 표기의 만료 시각)이 키퍼의 「남은 수명이 절반」 계산과
 * 폰에 놓이는 항목을 오염시키지 못하게 하는 문턱이다. 받은 값은 Swift 가 `Int64` 로 디코드하므로
 * 정수가 아닌 값이나 Int64 를 넘는 값은 거기서 「자격 없음」으로 조용히 죽는다 — 여기서 먼저
 * 거절해야 JS 가 「놓았다」고 믿는 일이 없다.
 */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 응답에서 폰이 놓아도 되는 값이 아닌 필드의 이름들. 값은 보지 않고 이름만 돌려준다. */
function rejectedFields(body: Partial<MintedPushActionToken>): string[] {
  const rejected: string[] = [];
  if (typeof body.token !== 'string' || body.token.length === 0) {
    rejected.push('token');
  }
  if (
    typeof body.expiresAtMs !== 'number' ||
    !Number.isSafeInteger(body.expiresAtMs) ||
    body.expiresAtMs <= 0
  ) {
    rejected.push('expiresAtMs');
  }
  if (
    typeof body.ttlSeconds !== 'number' ||
    !Number.isSafeInteger(body.ttlSeconds) ||
    body.ttlSeconds <= 0 ||
    body.ttlSeconds > MAX_TTL_SECONDS
  ) {
    rejected.push('ttlSeconds');
  }
  if (typeof body.workspaceId !== 'string' || body.workspaceId.length === 0) {
    rejected.push('workspaceId');
  }
  return rejected;
}

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
    const rejected = rejectedFields(body);
    if (rejected.length > 0) {
      // 서버는 이미 이 세션 계열의 칸 하나를 썼다(계열당 살아 있는 토큰 4개). 서버의 수명이 바뀌어 이
      // 문턱에 걸리기 시작하면 칸이 조용히 소진되므로, **필드 이름만** 남긴다 — 값(토큰)은 적지 않는다.
      console.warn(`[push] push-action token response rejected (${rejected.join(', ')})`);
      return null;
    }
    // `rejectedFields` has checked every one of these; only the four known fields are kept.
    const minted = body as MintedPushActionToken;
    return {
      token: minted.token,
      expiresAtMs: minted.expiresAtMs,
      ttlSeconds: minted.ttlSeconds,
      workspaceId: minted.workspaceId,
    };
  } catch {
    return null;
  }
}
