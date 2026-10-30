import { matchesExpressionContract } from "./contracts";
import { matchesExpressionChoice } from "./cards";
import { FIXTURE_MEDIA } from "./fixtureMedia";
import { FIXTURE_LIST, FIXTURE_MEMBER_ID, FIXTURE_NOW_MS, FIXTURE_READY_DRAFT, FIXTURE_WORKSPACE_ID } from "./fixtures";
import type { Expression, ExpressionChoice, ExpressionDraft, ExpressionMetadata, ExpressionPatch, ManualUploadCode } from "./types";

export interface ExpressionFixtureRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** For multipart uploads, supply the metadata part here; bytes are fixtureMedia. */
  body?: unknown;
}
export interface ExpressionFixtureResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  bodyBase64?: string;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/**
 * In-memory REST fixture for S3 host transport adapters. This simulates wire and
 * preview revisions, not auth, RLS, fetching, conversion, or security enforcement.
 */
export function createExpressionFixtureServer(options: { importFailure?: ManualUploadCode; nowMs?: number } = {}) {
  const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
  const catalogue = new Map(FIXTURE_LIST.items.map((item) => [item.id, clone(item)]));
  const drafts = new Map<string, ExpressionDraft>();
  const receipts = new Map<string, { choice: ExpressionChoice; response: ExpressionFixtureResponse }>();
  let version = 3;
  let serial = 30;
  const now = options.nowMs ?? FIXTURE_NOW_MS;
  const error = (status: number, code: string): ExpressionFixtureResponse => ({ status, json: { error: { code, message: code } } });
  const mutation = (expression: Expression): ExpressionFixtureResponse => ({ status: 200, json: clone({ workspaceId: FIXTURE_WORKSPACE_ID, version: String(version), expression }) });
  return {
    request(request: ExpressionFixtureRequest): ExpressionFixtureResponse {
      let url: URL;
      try { url = new URL(request.path, "https://fixture.invalid"); }
      catch { return error(400, "expression_invalid"); }
      const path = url.pathname;
      if (!path.startsWith(`${base}/`)) return error(404, "not_found");
      if (request.method === "GET" && path === `${base}/expressions`) {
        const since = url.searchParams.get("since");
        // The fixture always returns a safe full reset when `since` is stale.
        return { status: 200, json: clone({ ...FIXTURE_LIST, version: String(version),
          reset: since !== String(version), baseVersion: since === String(version) ? since : null,
          items: since === String(version) ? [] : [...catalogue.values()].filter((item) => item.status === "active") }) };
      }
      const prepare = request.method === "POST" && ["uploads", "import", "from-attachment"].some((suffix) => path === `${base}/expressions/${suffix}`);
      if (prepare) {
        const schema = path.endsWith("/import") ? "ImportRequest" : path.endsWith("/from-attachment") ? "AttachmentRequest" : "Metadata";
        if (!matchesExpressionContract(schema, request.body)) return error(400, "expression_invalid");
        const metadata = request.body as ExpressionMetadata & { url?: string };
        let source: URL | null;
        try { source = metadata.url ? new URL(metadata.url) : null; }
        catch { return error(400, "expression_invalid"); }
        const sourceUrl = source ? `${source.origin}${source.pathname}` : null;
        const draftId = `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`;
        const common = { ...clone(FIXTURE_READY_DRAFT), draftId, name: metadata.name,
          displayName: metadata.displayName, tags: metadata.tags, subjectMemberId: metadata.subjectMemberId,
          expiresAtMs: now + 3600000, origin: { kind: metadata.url ? "url" as const : schema === "AttachmentRequest" ? "attachment" as const : "upload" as const, sourceUrl, prompt: null } };
        const code = metadata.url ? options.importFailure : undefined;
        const draft: ExpressionDraft = code ? { ...common, state: "manual_upload_required", code, media: null } : { ...common, state: "ready", code: null, media: clone(FIXTURE_READY_DRAFT.media!) };
        drafts.set(draftId, draft);
        return { status: code ? 200 : 201, json: clone(draft) };
      }
      const draftMatch = new RegExp(`^${base}/expression-drafts/([^/]+)(/file|/image)?$`).exec(path);
      if (draftMatch) {
        const draft = drafts.get(draftMatch[1]);
        if (!draft) return error(404, "not_found");
        if (now >= draft.expiresAtMs) return error(410, "expression_draft_expired");
        if (request.method === "GET" && !draftMatch[2]) return { status: 200, json: clone(draft) };
        if (request.method === "GET" && draftMatch[2] === "/image") {
          const variant = url.searchParams.get("size");
          if (draft.state !== "ready" || !["small", "large", "thumb"].includes(variant ?? "")) return error(404, "not_found");
          const image = draft.media[variant as "small" | "large" | "thumb"];
          if (url.searchParams.get("v") !== image.sha256) return error(404, "not_found");
          return { status: 200, headers: { "Content-Type": image.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
            bodyBase64: image.mime === "image/png" ? FIXTURE_MEDIA.png.bodyBase64 : FIXTURE_MEDIA.gif.bodyBase64 };
        }
        if (request.method === "PUT" && draftMatch[2]) {
          const ready: ExpressionDraft = { ...draft, revision: String(Number(draft.revision) + 1), state: "ready", code: null, media: clone(FIXTURE_READY_DRAFT.media!) };
          drafts.set(ready.draftId, ready);
          return { status: 200, json: clone(ready) };
        }
      }
      if (request.method === "POST" && path === `${base}/expressions`) {
        if (!matchesExpressionContract("Choice", request.body)) return error(400, "expression_invalid");
        const choice = request.body as ExpressionChoice;
        const receipt = receipts.get(choice.draftId);
        if (receipt) return receipt.choice.revision === choice.revision && receipt.choice.sha256 === choice.sha256 ? clone(receipt.response) : error(409, "expression_preview_stale");
        const draft = drafts.get(choice.draftId);
        if (!draft || !matchesExpressionChoice(draft, choice, now) || draft.state !== "ready") return error(409, "expression_preview_stale");
        if ([...catalogue.values()].some((item) => item.name === draft.name)) return error(409, "expression_name_reserved");
        if ([...catalogue.values()].filter((item) => item.status !== "deleted").length >= 1000) return error(409, "expression_quota");
        version += 1;
        const item: Expression = { id: draft.draftId, workspaceId: FIXTURE_WORKSPACE_ID,
          name: draft.name, displayName: draft.displayName, tags: draft.tags, subjectMemberId: draft.subjectMemberId,
          version: String(version), status: "active", origin: draft.origin, media: draft.media,
          createdBy: FIXTURE_MEMBER_ID, createdAtMs: now };
        catalogue.set(item.id, clone(item)); drafts.delete(draft.draftId);
        const response = { ...mutation(item), status: 201 };
        receipts.set(choice.draftId, { choice: clone(choice), response: clone(response) });
        return response;
      }
      const expressionMatch = new RegExp(`^${base}/expressions/([^/]+)(/image|/report)?$`).exec(path);
      if (expressionMatch) {
        const item = catalogue.get(expressionMatch[1]);
        if (!item) return error(404, "not_found");
        if (request.method === "GET" && expressionMatch[2] === "/image") {
          const variant = url.searchParams.get("size");
          if (item.status !== "active" || !item.media || !["small", "large", "thumb"].includes(variant ?? "")) return error(404, "not_found");
          const media = item.media[variant as "small" | "large" | "thumb"];
          if (url.searchParams.get("v") !== media.sha256) return error(404, "not_found");
          return { status: 200, headers: { "Content-Type": media.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
            bodyBase64: media.mime === "image/png" ? FIXTURE_MEDIA.png.bodyBase64 : FIXTURE_MEDIA.gif.bodyBase64 };
        }
        if (request.method === "PATCH" && !expressionMatch[2]) {
          if (!matchesExpressionContract("Patch", request.body)) return error(400, "expression_invalid");
          if (item.status !== "active") return error(404, "not_found");
          version += 1; Object.assign(item, request.body as ExpressionPatch, { version: String(version) });
          return mutation(item);
        }
        if ((request.method === "DELETE" && !expressionMatch[2]) || (request.method === "POST" && expressionMatch[2] === "/report")) {
          const report = expressionMatch[2] === "/report";
          if (report && !matchesExpressionContract("ReportRequest", request.body)) return error(400, "expression_invalid");
          if (item.status === "active" || (!report && item.status === "hidden")) {
            version += 1; item.version = String(version); item.status = report ? "hidden" : "deleted"; item.media = null;
          }
          return mutation(item);
        }
      }
      return error(404, "not_found");
    },
  };
}
