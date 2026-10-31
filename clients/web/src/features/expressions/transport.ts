import { authedRequest, rotateAfterUnauthorized } from "@momo/core/lib/api";
import { apiBase, coreSession } from "@momo/core/runtime/host";
import { createExpressionFixtureServer } from "@momo/core/features/expressions/fixtureServer";
import { FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import type { ExpressionFixtureRequest } from "@momo/core/features/expressions/fixtureServer";
import type { ManualUploadCode } from "@momo/core/features/expressions/types";

export interface ExpressionRequest extends ExpressionFixtureRequest { file?: File }
export interface ExpressionTransport {
  json(request: ExpressionRequest): Promise<unknown>;
  image(path: string): Promise<string>;
}
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("image"));
    reader.onerror = () => reject(new Error("image"));
    reader.readAsDataURL(blob);
  });
}
// Binary/multipart exchanges share the core's single rotation rule. Paths are
// constructed by the library, never supplied by media metadata or an external URL.
async function binaryRequest(path: string, init: RequestInit = {}) {
  if (!/^\/v1\/workspaces\/[^/]+\/(expressions|expression-drafts)(\/|\?|$)/.test(path)) throw new Error("expression path");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  const send = () => {
    const headers = new Headers(init.headers);
    const token = coreSession().getAccessToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${apiBase()}${path}`, { ...init, headers, signal: controller.signal, cache: "no-store" });
  };
  try {
    let response = await send();
    if (response.status === 401 && coreSession().getRefreshToken() && await rotateAfterUnauthorized()) response = await send();
    if (response.status === 401) coreSession().markAuthExpired();
    if (!response.ok) throw new Error(`expression HTTP ${response.status}`);
    // Read bytes inside the request deadline as well.
    return await response.blob();
  } finally { window.clearTimeout(timeout); }
}
export const expressionHttpTransport: ExpressionTransport = {
  async json(request) {
    if (request.file) {
      const form = new FormData();
      if (request.body) form.append("metadata", new Blob([JSON.stringify(request.body)], { type: "application/json" }));
      form.append("file", request.file);
      const blob = await binaryRequest(request.path, { method: request.method, body: form });
      return JSON.parse(await blob.text()) as unknown;
    }
    const response = await authedRequest(request.path, { method: request.method, body: request.body === undefined ? undefined : JSON.stringify(request.body) });
    return response.json<unknown>();
  },
  async image(path) {
    const blob = await binaryRequest(path);
    if (!["image/png", "image/gif"].includes(blob.type)) throw new Error("expression image type");
    return dataUrl(blob);
  },
};

/** Same port and paths as production; only the transport is replaced. */
export function createExpressionFixtureTransport(workspaceId: string, memberId: string, importFailure?: ManualUploadCode): ExpressionTransport {
  const server = createExpressionFixtureServer({ nowMs: Date.now(), importFailure });
  const pathFor = (path: string) => path.replace(`/workspaces/${workspaceId}/`, `/workspaces/${FIXTURE_WORKSPACE_ID}/`);
  return {
    async json(request) {
      const response = server.request({ ...request, path: pathFor(request.path) });
      if (response.status >= 400) throw new Error(`expression HTTP ${response.status}`);
      return JSON.parse(JSON.stringify(response.json).replaceAll(FIXTURE_WORKSPACE_ID, workspaceId).replaceAll(FIXTURE_MEMBER_ID, memberId)) as unknown;
    },
    async image(path) {
      const response = server.request({ method: "GET", path: pathFor(path) });
      if (response.status !== 200 || !response.bodyBase64) throw new Error("expression image");
      return `data:${response.headers?.["Content-Type"]};base64,${response.bodyBase64}`;
    },
  };
}
