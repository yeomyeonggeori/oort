import {fetchWithDeadline, type HttpResponse} from '@momo/core/lib/http';
import {apiBase, coreSession} from '@momo/core/runtime/host';

// =============================================================================
// The notification extension's token (#3121, ADR-0188 §8.7).
//
// The extension used to be handed the app's full access token. It is now handed
// what `POST /v1/auth/push-fetch-token` returns: a token that can make exactly
// two GETs (a channel's messages, the roster) and cannot be refreshed. The app
// mints it from its ordinary session — which is why it can only be minted while
// the app runs and has a live session — and parks it in the shared keychain
// group (`pushFetchSession.ts`).
// =============================================================================

export interface MintedPushFetchToken {
  token: string;
  expiresAtMs: number;
  ttlSeconds: number;
  workspaceId: string;
}

/**
 * Ask for a push-fetch token. Null on ANY failure — offline, 401 (the access
 * token is between rotations), 409 (a session that has no lineage yet), an
 * older server without the route. The caller must then publish nothing and try
 * again at the next session change; it must never fall back to publishing the
 * access token, which is the thing this exists to stop.
 */
export async function mintPushFetchToken(): Promise<MintedPushFetchToken | null> {
  const access = coreSession().getAccessToken();
  if (!access) {
    return null;
  }
  let response: HttpResponse;
  try {
    response = await fetchWithDeadline(`${apiBase()}/v1/auth/push-fetch-token`, {
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
    const body = (await response.json()) as Partial<MintedPushFetchToken>;
    if (
      typeof body.token !== 'string' ||
      body.token.length === 0 ||
      typeof body.expiresAtMs !== 'number' ||
      typeof body.ttlSeconds !== 'number' ||
      typeof body.workspaceId !== 'string'
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
