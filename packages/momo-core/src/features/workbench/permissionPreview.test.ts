import { describe, expect, it } from "vitest";
import {
  checkPermissionPreview,
  parsePermissionPreview,
  permissionPreviewCanonical,
  permissionPreviewSha256,
  type PermissionPreview,
} from "./permissionPreview";
import { pendingPermission } from "./agentPane";
import type { WorkSessionEvent } from "../work/workSessionModel";
// The cross-language contract (#3118): the v3 vectors' permission previews —
// host-built, canonical bytes and hash written by Rust
// (`momo_wire::permission_preview`). Rust checks this copy equals the vectors.
import vectors from "./__fixtures__/permission-preview.vectors.json";

const honest: PermissionPreview = {
  schema: "momo.work_permission.preview.v1",
  kind: "execute",
  title: "Run `cat ~/.ssh/id_ed25519`",
  locations: "",
  input: '{"command":"cat ~/.ssh/id_ed25519"}',
  truncated: false,
};

describe("permission preview hash (#3118)", () => {
  it("matches the bytes and hashes the host wrote into the shared vectors", () => {
    expect(vectors.cases).toHaveLength(2);
    for (const tc of vectors.cases) {
      const preview = parsePermissionPreview(tc.preview);
      expect(preview, tc.name).not.toBeNull();
      expect(permissionPreviewCanonical(preview!), tc.name).toBe(tc.preview_canonical);
      expect(permissionPreviewSha256(preview!), tc.name).toBe(tc.preview_sha256);
    }
  });

  it("signs only the preview the host relayed — a swapped one is refused", () => {
    const hostHash = permissionPreviewSha256(honest);
    const ok = checkPermissionPreview(honest, hostHash);
    expect(ok).toEqual({ ok: true, preview: honest, sha256: hostHash });

    // A server shows another preview under the host's hash: refused.
    const shown = { ...honest, kind: "read", title: "Read README.md", input: "" };
    expect(checkPermissionPreview(shown, hostHash)).toEqual({ ok: false, reason: "mismatch" });
    // It could swap the hash too — then this check passes and the hash it
    // yields is the swapped preview's, which the host refuses (Rust inv_35).
    const swapped = checkPermissionPreview(shown, permissionPreviewSha256(shown as PermissionPreview));
    expect(swapped.ok && swapped.sha256).not.toBe(hostHash);
  });

  it("refuses what the screen would not show byte for byte, or shows cut", () => {
    const withMark = { ...honest, title: "Run ‮`cat x`" };
    expect(checkPermissionPreview(withMark, permissionPreviewSha256(withMark))).toEqual({
      ok: false,
      reason: "display_altered",
    });
    const withSecret = { ...honest, input: "ghp_0123456789abcdefghijklmnop" };
    expect(checkPermissionPreview(withSecret, permissionPreviewSha256(withSecret))).toEqual({
      ok: false,
      reason: "display_altered",
    });
    const cut = { ...honest, truncated: true };
    expect(checkPermissionPreview(cut, permissionPreviewSha256(cut))).toEqual({
      ok: false,
      reason: "truncated",
    });
  });

  it("takes only the closed object", () => {
    const hash = permissionPreviewSha256(honest);
    expect(checkPermissionPreview(null, hash)).toEqual({ ok: false, reason: "missing" });
    expect(checkPermissionPreview(honest, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(checkPermissionPreview({ ...honest, note: "x" }, hash)).toEqual({ ok: false, reason: "malformed" });
    expect(checkPermissionPreview({ ...honest, kind: "sudo" }, hash)).toEqual({ ok: false, reason: "malformed" });
    expect(checkPermissionPreview({ ...honest, truncated: 0 }, hash)).toEqual({ ok: false, reason: "malformed" });
    expect(checkPermissionPreview(honest, hash.toUpperCase())).toEqual({ ok: false, reason: "malformed" });
  });

  it("the pending card carries the request's preview hash, not the inferred tool", () => {
    const hash = permissionPreviewSha256(honest);
    const events = [
      { eventId: "s1", atMs: 1, type: "agent.status", payload: { tool_call_name: "read", detail: "README.md" } },
      {
        eventId: "req-1",
        atMs: 2,
        type: "approval.requested",
        payload: {
          options: [{ option_id: "allow-once", kind: "allow_once" }],
          preview_sha256: hash,
        },
      },
    ] as unknown as WorkSessionEvent[];
    const pending = pendingPermission(events, { status: "running" });
    expect(pending?.previewSha256).toBe(hash);
    const legacy = pendingPermission(
      [{ ...events[1], payload: { options: [{ option_id: "a", kind: "allow_once" }] } }] as WorkSessionEvent[],
      { status: "running" }
    );
    expect(legacy?.previewSha256).toBeNull();
  });
});
