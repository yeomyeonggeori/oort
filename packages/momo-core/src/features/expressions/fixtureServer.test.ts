import { describe, expect, it } from "vitest";
import { sha256 } from "../../lib/sha256";
import { assertExpressionContract } from "./contracts";
import { expressionChoice } from "./cards";
import { createExpressionFixtureServer } from "./fixtureServer";
import { FIXTURE_MEDIA } from "./fixtureMedia";
import { FIXTURE_CHANNEL_ID, FIXTURE_EXPRESSIONS, FIXTURE_NOW_MS, FIXTURE_WORKSPACE_ID } from "./fixtures";
import type { ExpressionDraft, ExpressionMutation } from "./types";

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
const metadata = { name: "new_dance", displayName: "신나는 춤", tags: ["축하"], subjectMemberId: null };

describe("S3 fake REST server (no network)", () => {
  it("imports a GIF-site single selection and registers exactly the viewed draft", () => {
    const server = createExpressionFixtureServer();
    const prepared = server.request({ method: "POST", path: `${base}/expressions/import`, body: { ...metadata, url: "https://giphy.com/gifs/example?tracking=removed" } });
    expect(prepared.status).toBe(201); assertExpressionContract("Draft", prepared.json);
    const draft = prepared.json as ExpressionDraft;
    expect(draft.origin.sourceUrl).toBe("https://giphy.com/gifs/example");
    const created = server.request({ method: "POST", path: `${base}/expressions`, body: expressionChoice(draft, FIXTURE_NOW_MS) });
    expect(created.status).toBe(201); assertExpressionContract("Mutation", created.json);
    expect((created.json as ExpressionMutation).expression.name).toBe("new_dance");
    const list = server.request({ method: "GET", path: `${base}/expressions` });
    assertExpressionContract("List", list.json);
    expect(server.request({ method: "POST", path: `${base}/expressions`, body: expressionChoice(draft, FIXTURE_NOW_MS) })).toEqual(created);
  });
  it("retains failed-fetch source, accepts direct upload, and invalidates stale revisions", () => {
    const server = createExpressionFixtureServer({ importFailure: "source_blocked" });
    const blocked = server.request({ method: "POST", path: `${base}/expressions/import`, body: { ...metadata, url: "https://tenor.com/view/example" } });
    expect(blocked.status).toBe(200); assertExpressionContract("Draft", blocked.json);
    const draft = blocked.json as ExpressionDraft;
    expect(expressionChoice(draft, FIXTURE_NOW_MS)).toBeNull();
    const upload = server.request({ method: "PUT", path: `${base}/expression-drafts/${draft.draftId}/file` });
    assertExpressionContract("Draft", upload.json);
    const ready = upload.json as ExpressionDraft;
    expect(ready.origin).toEqual(draft.origin);
    expect(ready.revision).toBe("2");
    const oldChoice = expressionChoice(ready, FIXTURE_NOW_MS)!;
    server.request({ method: "PUT", path: `${base}/expression-drafts/${draft.draftId}/file` });
    expect(server.request({ method: "POST", path: `${base}/expressions`, body: oldChoice }).status).toBe(409);
    const current = server.request({ method: "GET", path: `${base}/expression-drafts/${draft.draftId}` }).json as ExpressionDraft;
    expect(server.request({ method: "POST", path: `${base}/expressions`, body: expressionChoice(current, FIXTURE_NOW_MS) }).status).toBe(201);
  });
  it("serves schema-compatible upload/attachment/video-unavailable scenarios", () => {
    const server = createExpressionFixtureServer({ importFailure: "video_processing_unavailable" });
    for (const [path, body] of [
      ["uploads", metadata],
      ["from-attachment", { ...metadata, attachmentId: FIXTURE_EXPRESSIONS[0].id, channelId: FIXTURE_CHANNEL_ID }],
      ["import", { ...metadata, url: "https://example.org/clip.mp4" }],
    ] as const) {
      const response = server.request({ method: "POST", path: `${base}/expressions/${path}`, body });
      assertExpressionContract("Draft", response.json);
      if (path === "import") expect((response.json as ExpressionDraft).state).toBe("manual_upload_required");
    }
  });
  it("hides reported media immediately, returns tombstones, and reserves deleted names", () => {
    const server = createExpressionFixtureServer();
    const item = FIXTURE_EXPRESSIONS[0];
    const imagePath = `${base}/expressions/${item.id}/image?size=small&v=${item.media!.small.sha256}`;
    expect(server.request({ method: "GET", path: imagePath }).status).toBe(200);
    const hidden = server.request({ method: "POST", path: `${base}/expressions/${item.id}/report`, body: { reason: "copyright" } });
    assertExpressionContract("Mutation", hidden.json);
    expect((hidden.json as ExpressionMutation).expression).toMatchObject({ status: "hidden", media: null });
    expect(server.request({ method: "GET", path: imagePath }).status).toBe(404);
    const deleted = server.request({ method: "DELETE", path: `${base}/expressions/${item.id}` });
    assertExpressionContract("Mutation", deleted.json);
    expect((deleted.json as ExpressionMutation).expression.status).toBe("deleted");
    const prepared = server.request({ method: "POST", path: `${base}/expressions/uploads`, body: { ...metadata, name: item.name } });
    expect(server.request({ method: "POST", path: `${base}/expressions`, body: expressionChoice(prepared.json as ExpressionDraft, FIXTURE_NOW_MS) }).status).toBe(409);
    expect(server.request({ method: "POST", path: `${base}/expressions/${item.id}/report`, body: { reason: "face" } }).json).toEqual(deleted.json);
  });
  it("pins draft and registered image requests, without public media URLs", () => {
    const server = createExpressionFixtureServer();
    const prepared = server.request({ method: "POST", path: `${base}/expressions/uploads`, body: metadata }).json as ExpressionDraft;
    const previewPath = `${base}/expression-drafts/${prepared.draftId}/image?size=large&v=${prepared.media!.large.sha256}`;
    const image = server.request({ method: "GET", path: previewPath });
    expect(image.headers).toMatchObject({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "image/gif" });
    expect(image.bodyBase64).toBe(FIXTURE_MEDIA.gif.bodyBase64);
    expect(server.request({ method: "GET", path: previewPath.replace(prepared.media!.large.sha256, "0".repeat(64)) }).status).toBe(404);
    expect(server.request({ method: "GET", path: `${base}/expressions/${FIXTURE_EXPRESSIONS[0].id}/image?size=full&v=wrong` }).status).toBe(404);
  });
  it("rejects other-workspace paths and malformed wire inputs", () => {
    const server = createExpressionFixtureServer();
    expect(server.request({ method: "GET", path: "/v1/workspaces/other/expressions" }).status).toBe(404);
    expect(server.request({ method: "POST", path: `${base}/expressions/import`, body: { ...metadata, url: "http://bad.example/gif" } }).status).toBe(400);
    expect(server.request({ method: "POST", path: `${base}/expressions/import`, body: { ...metadata, url: "https://example.org:99999/file" } }).status).toBe(400);
    const ipv6 = server.request({ method: "POST", path: `${base}/expressions/import`, body: { ...metadata, url: "https://[2606:4700:4700::1111]/image.gif" } });
    assertExpressionContract("Draft", ipv6.json);
    expect(server.request({ method: "PATCH", path: `${base}/expressions/${FIXTURE_EXPRESSIONS[0].id}`, body: { name: "renamed" } }).status).toBe(400);
    const patched = server.request({ method: "PATCH", path: `${base}/expressions/${FIXTURE_EXPRESSIONS[0].id}`, body: { displayName: "새 이름" } });
    assertExpressionContract("Mutation", patched.json);
    expect((patched.json as ExpressionMutation).expression.name).toBe("party_parrot");
  });
  it("does not let caller mutations contaminate a later fixture response", () => {
    const server = createExpressionFixtureServer();
    const list = server.request({ method: "GET", path: `${base}/expressions` }).json as { items: { name: string }[] };
    list.items[0].name = "tampered";
    const next = server.request({ method: "GET", path: `${base}/expressions` });
    assertExpressionContract("List", next.json);
    expect((next.json as typeof list).items[0].name).toBe("party_parrot");
  });
});

// A synthetic descriptor must still describe exactly the supplied source bytes.
// Host adapters decode base64; the core hashes bytes without depending on Buffer.
describe("synthetic fixture media", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function decodeBase64(text: string): Uint8Array {
    let accumulator = 0; let bits = 0;
    const out: number[] = [];
    for (const char of text.replace(/=+$/, "")) {
      accumulator = (accumulator << 6) | alphabet.indexOf(char); bits += 6;
      if (bits >= 8) { bits -= 8; out.push((accumulator >>> bits) & 255); }
    }
    return new Uint8Array(out);
  }
  it("has exact size, hash, signature and a real second GIF frame", () => {
    for (const entry of Object.values(FIXTURE_MEDIA)) {
      const bytes = decodeBase64(entry.bodyBase64);
      expect(bytes.length).toBe(entry.image.bytes);
      expect(Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(entry.image.sha256);
    }
    const gif = decodeBase64(FIXTURE_MEDIA.gif.bodyBase64);
    expect(Array.from(gif.slice(0, 6))).toEqual([71, 73, 70, 56, 57, 97]);
    expect(Array.from(gif).filter((byte) => byte === 0x2c)).toHaveLength(2);
    expect(gif.at(-1)).toBe(0x3b);
    const netscape = Array.from(gif).findIndex((byte, index) => byte === 0x4e && gif[index + 1] === 0x45);
    expect(Array.from(gif.slice(netscape + 11, netscape + 16))).toEqual([3, 1, 3, 0, 0]);
  });
});
