import {File, Paths} from 'expo-file-system';
import {authedResponse, rotateAfterUnauthorized} from '@momo/core/lib/api';
import {REQUEST_TIMEOUT_MS} from '@momo/core/lib/http';
import {apiBase, coreSession} from '@momo/core/runtime/host';
import type {
  ExpressionFixtureRequest,
  ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';

/** Both the core fixture and the live server enter through this port. */
export interface ExpressionTransport {
  request(
    request: ExpressionFixtureRequest,
  ): Promise<ExpressionFixtureResponse & {bytes?: Uint8Array}>;
}

export const expressionTransport: ExpressionTransport = {
  async request(request) {
    if (!/^\/v1\/workspaces\/[^/]+\/expressions(?:[/?]|$)/.test(request.path)) {
      throw new Error('Invalid expression path');
    }
    if (!request.path.includes('/image?')) {
      const response = await authedResponse(request.path, {
        method: request.method,
        ...(request.body === undefined
          ? {}
          : {
              body: JSON.stringify(request.body),
              headers: {'Content-Type': 'application/json'},
            }),
      });
      return {status: response.status, json: response.jsonOrNull()};
    }
    // Native download, matching the avatar/attachment adapters. Nothing survives
    // this exchange except bytes returned to the session-owned file cache.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const temporary = new File(
      Paths.cache,
      `oort-expression-transfer-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    const unauthorized = (error: unknown) =>
      /(?:status(?: code)?\s*[:=]?\s*401|http\s*401|unauthori[sz]ed)/i.test(
        error instanceof Error ? error.message : String(error),
      );
    const send = async () => {
      const file = await File.downloadFileAsync(
        `${apiBase()}${request.path}`,
        temporary,
        {
          headers: {
            Authorization: `Bearer ${coreSession().getAccessToken() ?? ''}`,
          },
          signal: controller.signal,
          idempotent: true,
          onProgress: progress => {
            if (progress.bytesWritten > 1024 * 1024) controller.abort();
          },
        },
      );
      if (file.size > 1024 * 1024)
        throw new Error('Expression image too large');
      return {status: 200, bytes: await file.bytes()};
    };
    try {
      try {
        return await send();
      } catch (error) {
        if (!unauthorized(error)) throw error;
        if (
          coreSession().getRefreshToken() &&
          (await rotateAfterUnauthorized())
        ) {
          try {
            return await send();
          } catch (retried) {
            if (unauthorized(retried)) coreSession().markAuthExpired();
            throw retried;
          }
        }
        coreSession().markAuthExpired();
        return {status: 401};
      }
    } finally {
      clearTimeout(timer);
      if (temporary.exists) temporary.delete();
    }
  },
};
