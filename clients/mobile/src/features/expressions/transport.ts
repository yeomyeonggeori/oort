import {File, Paths, UploadType} from 'expo-file-system';
import {authedResponse, rotateAfterUnauthorized} from '@momo/core/lib/api';
import {REQUEST_TIMEOUT_MS} from '@momo/core/lib/http';
import {apiBase, coreSession} from '@momo/core/runtime/host';
import type {
  ExpressionFixtureRequest,
  ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';

/**
 * 올릴 그림 한 장. 바이트는 JS 로 읽지 않는다 — 네이티브 업로더가 이 주소에서 바로 읽는다
 * (사진 첨부의 `putAttachmentBytes` 와 같은 이유로 5 MiB 가 JS heap 에 한 벌 더 서지 않는다).
 */
export interface ExpressionUploadFile {
  uri: string;
  name: string;
  mime: string;
}

/** 코어 fixture 의 요청 모양에 그림 한 장을 더한 것. 그림이 있으면 multipart 이고, 본문은 `metadata` 부분이다. */
export interface ExpressionRequest extends ExpressionFixtureRequest {
  file?: ExpressionUploadFile;
  /**
   * 이 요청이 기다릴 수 있는 시간. 없으면 올리기 기본(60초)이다. 사진을 이미지 모델에 보내는 요청만 더 길다
   * (코어 `PHOTO_REQUEST_TIMEOUT_MS`: 서버가 모델에 최대 2분을 주므로 그보다 오래 기다린다). multipart 길에만 듣는다.
   */
  timeoutMs?: number;
  /** 부르는 쪽이 기다리기를 그만둘 때(「취소」·화면 닫힘): 올리기를 멈추고 약속은 거절로 끝난다. multipart 길에만 듣는다. */
  signal?: AbortSignal;
}

/** Both the core fixture and the live server enter through this port. */
export interface ExpressionTransport {
  request(
    request: ExpressionRequest,
  ): Promise<ExpressionFixtureResponse & {bytes?: Uint8Array}>;
}

/** 5 MiB 를 올리는 데 15초(JSON 한도)는 모자랄 수 있다. 넉넉하되 끝이 있다. */
const UPLOAD_TIMEOUT_MS = 60_000;
const EXPRESSION_PATH =
  /^\/v1\/workspaces\/[^/]+\/(?:expressions|expression-drafts)(?:[/?]|$)/;

function parsedJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * 베어러를 싣는 multipart 한 번 — 서버 경로(`POST …/expressions/uploads`·`PUT …/expression-drafts/{id}/file`)는
 * 웹과 같다. 401 은 코어의 회전 규칙대로 한 번만 돌려 다시 보낸다.
 */
async function uploadFile(
  request: ExpressionRequest,
  picked: ExpressionUploadFile,
): Promise<ExpressionFixtureResponse> {
  if (request.method !== 'POST' && request.method !== 'PUT') {
    throw new Error('Invalid expression upload method');
  }
  const method = request.method;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? UPLOAD_TIMEOUT_MS,
  );
  // 부르는 쪽의 신호를 이 요청의 컨트롤러에 잇는다 — 이미 멈춘 신호면 보내기 전에 멈춘다.
  const giveUp = () => controller.abort();
  if (request.signal?.aborted) giveUp();
  else request.signal?.addEventListener('abort', giveUp);
  const send = async () => {
    const task = new File(picked.uri).createUploadTask(
      `${apiBase()}${request.path}`,
      {
        httpMethod: method,
        uploadType: UploadType.MULTIPART,
        fieldName: 'file',
        mimeType: picked.mime,
        ...(request.body === undefined
          ? {}
          : {parameters: {metadata: JSON.stringify(request.body)}}),
        headers: {
          Authorization: `Bearer ${coreSession().getAccessToken() ?? ''}`,
        },
        sessionType: 'foreground',
        signal: controller.signal,
      },
    );
    try {
      return await task.uploadAsync();
    } finally {
      task.release();
    }
  };
  try {
    let result = await send();
    if (
      result.status === 401 &&
      coreSession().getRefreshToken() &&
      (await rotateAfterUnauthorized())
    ) {
      result = await send();
    }
    if (result.status === 401) coreSession().markAuthExpired();
    return {status: result.status, json: parsedJson(result.body)};
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', giveUp);
  }
}

export const expressionTransport: ExpressionTransport = {
  async request(request) {
    if (!EXPRESSION_PATH.test(request.path)) {
      throw new Error('Invalid expression path');
    }
    if (request.file) return uploadFile(request, request.file);
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
