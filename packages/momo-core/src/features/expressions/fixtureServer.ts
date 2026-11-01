import { matchesExpressionContract } from "./contracts";
import { matchesExpressionChoice } from "./cards";
import { recommendExpressionKind } from "./kind";
import { FIXTURE_MEDIA } from "./fixtureMedia";
import { PHOTO_BRANCHES, PHOTO_FAILURE_STATUS, PHOTO_PROVIDERS, type PhotoBranch, type PhotoFailureCode, type PhotoProvider } from "./photo";
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
/** The server's own two sentences (momo-expressions `PHOTO_PROMPTS`; a test pins the pair against the Rust source). */
export const PHOTO_FIXTURE_PROMPTS: Record<PhotoBranch, string> = {
  cutout: "사진에서 피사체만 남기고 배경을 지운 그림",
  caricature: "사진을 바탕으로 새로 그린 캐리커처",
};

export function createExpressionFixtureServer(options: {
  importFailure?: ManualUploadCode;
  nowMs?: number;
  /** Opt in to the photo routes: which image model the fake team has (`none`: no model connected). */
  photoModel?: "none" | PhotoProvider;
  /** With a model: answer every photo request with this closed failure. */
  photoFailure?: PhotoFailureCode;
} = {}) {
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
      if (options.photoModel !== undefined && request.method === "GET" && path === `${base}/expressions/photo-model`) {
        const provider = options.photoModel === "none" ? null : options.photoModel;
        return { status: 200, json: { available: provider !== null, provider, branches: [...PHOTO_BRANCHES], canManage: true } };
      }
      if (options.photoModel !== undefined && request.method === "POST" && path === `${base}/expressions/photo-drafts`) {
        const body = request.body as (ExpressionMetadata & { branch?: string; acknowledgedProvider?: string }) | undefined;
        if (!body || !matchesExpressionContract("Metadata", { name: body.name, displayName: body.displayName, tags: body.tags, subjectMemberId: body.subjectMemberId })
          || !(PHOTO_BRANCHES as readonly string[]).includes(body.branch ?? "") || !(PHOTO_PROVIDERS as readonly string[]).includes(body.acknowledgedProvider ?? "")) return error(400, "expression_invalid");
        if (options.photoModel === "none") return error(409, "image_model_unavailable");
        if (body.acknowledgedProvider !== options.photoModel) return error(409, "image_model_changed");
        if (options.photoFailure) return error(PHOTO_FAILURE_STATUS[options.photoFailure], options.photoFailure);
        const branch = body.branch as PhotoBranch;
        const draftId = `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`;
        const draft: ExpressionDraft = { ...clone(FIXTURE_READY_DRAFT), draftId, name: body.name, displayName: body.displayName, tags: body.tags,
          subjectMemberId: body.subjectMemberId, expiresAtMs: now + 3600000, state: "ready", code: null, media: clone(FIXTURE_READY_DRAFT.media!),
          origin: { kind: "generated", sourceUrl: null, prompt: PHOTO_FIXTURE_PROMPTS[branch], sourceAttachmentId: null } };
        drafts.set(draftId, draft);
        return { status: 201, json: clone({ draft, cutout: branch === "cutout" ? "erased" : null }) };
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
        // ADR-0218 §10 J3, as the real server does it: the person's word, else the recommendation for the stored
        // large picture (`draft.media` is non-null here: the state was checked above).
        const item: Expression = { id: draft.draftId, workspaceId: FIXTURE_WORKSPACE_ID,
          name: draft.name, displayName: draft.displayName, tags: draft.tags, subjectMemberId: draft.subjectMemberId,
          kind: choice.kind ?? recommendExpressionKind(draft.media.large),
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
