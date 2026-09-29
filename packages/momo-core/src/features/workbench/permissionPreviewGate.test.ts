import { describe, expect, it } from "vitest";
import type { WorkPermissionPreviewResponse } from "../../lib/api";
import { permissionPreviewSha256, type PermissionPreview } from "./permissionPreview";
import {
  PERMISSION_ASK_UNVERIFIED,
  PERMISSION_PREVIEW_BLOCK_LINE,
  permissionAllowGone,
  permissionGateAsk,
  permissionPreviewGate,
  permissionPreviewRows,
} from "./permissionPreviewGate";
import vectors from "./__fixtures__/permission-preview.vectors.json";

// #3128: the card's allow door. Open only for the host's preview (hash checked
// against the request's), never for a swapped, cut or unreadable one.

const honest = vectors.cases[0]!.preview as PermissionPreview; // execute, not truncated
const honestHash = vectors.cases[0]!.preview_sha256;
const cut = vectors.cases[1]!.preview as PermissionPreview; // edit, truncated
const cutHash = vectors.cases[1]!.preview_sha256;

function read(preview: unknown, previewSha256?: string): { status: "ok"; data: WorkPermissionPreviewResponse } {
  return {
    status: "ok",
    data: {
      permissionRequest: {
        id: "r",
        sessionId: "s",
        requestEventId: "e",
        status: "pending",
        ...(previewSha256 ? { previewSha256 } : {}),
      },
      options: [],
      preview,
    },
  };
}

describe("permissionPreviewGate (#3128)", () => {
  it("opens for the host's preview and hands back the hash this app recomputed", () => {
    const gate = permissionPreviewGate(honestHash, read(honest, honestHash));
    expect(gate).toEqual({ state: "ready", preview: honest, sha256: honestHash });
    expect(permissionGateAsk(gate)).toBe("명령을 실행해도 될까요?");
  });

  it("sabotage: a server that swaps the preview (a harmless read over the real command) is refused", () => {
    const swapped: PermissionPreview = { ...honest, kind: "read", title: "Read README.md", input: '{"path":"README.md"}' };
    // The event carries the host's hash; the read hands back another preview.
    const gate = permissionPreviewGate(honestHash, read(swapped, honestHash));
    expect(gate).toMatchObject({ state: "blocked", reason: "mismatch", preview: null });
    // Nothing of the swapped preview reaches the card, not even its question.
    expect(permissionGateAsk(gate)).toBe(PERMISSION_ASK_UNVERIFIED);
    // The read's own hash disagreeing with the event's is a swap too.
    expect(permissionPreviewGate(honestHash, read(swapped, permissionPreviewSha256(swapped)))).toMatchObject({
      state: "blocked",
      reason: "mismatch",
    });
  });

  it("a cut preview is shown (its hash is the host's) but cannot be allowed", () => {
    const gate = permissionPreviewGate(cutHash, read(cut, cutHash));
    expect(gate).toMatchObject({ state: "blocked", reason: "truncated", preview: cut });
    expect(permissionGateAsk(gate)).toBe("파일을 고쳐도 될까요?");
  });

  it.each([
    ["no preview (an old host)", null, honestHash, "missing"],
    ["no hash anywhere", honest, null, "missing"],
    ["not the closed object", { ...honest, extra: 1 }, honestHash, "malformed"],
    ["what the display would mask", { ...honest, input: '{"h":"Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"}' }, null, "display_altered"],
  ] as const)("%s: blocked with one honest sentence", (_what, preview, eventHash, reason) => {
    const expected = reason === "display_altered" ? permissionPreviewSha256(preview as PermissionPreview) : eventHash;
    const gate = permissionPreviewGate(expected, read(preview));
    expect(gate).toEqual({
      state: "blocked",
      reason,
      preview: null,
      line: PERMISSION_PREVIEW_BLOCK_LINE[reason],
    });
  });

  it("loading and a failed read never open the door", () => {
    expect(permissionPreviewGate(honestHash, { status: "loading" })).toEqual({ state: "loading" });
    expect(permissionPreviewGate(honestHash, { status: "error" })).toMatchObject({
      state: "blocked",
      reason: "unavailable",
    });
    expect(permissionGateAsk({ state: "loading" })).toBe(PERMISSION_ASK_UNVERIFIED);
  });

  it("every blocking sentence says why and that a reject still works", () => {
    for (const line of Object.values(PERMISSION_PREVIEW_BLOCK_LINE)) {
      expect(line).toMatch(/허락할 수 없어요/);
      expect(line).toMatch(/거부/);
      expect(line).toMatch(/요\.$/);
    }
  });

  it("rows are the fields verbatim, input first (the desktop sheet's order), empty ones left out", () => {
    expect(permissionPreviewRows(honest)).toEqual([
      { key: "input", label: "입력", text: honest.input },
      { key: "title", label: "제목", text: honest.title },
    ]);
    // Same order as `payload.rs` `preview_full_text` ([입력] → [위치] → [제목]),
    // pinned there by `a_field_cannot_fake_a_dialog_heading`.
    expect(permissionPreviewRows(cut).map((r) => r.label)).toEqual(["입력", "위치", "제목"]);
    expect(permissionPreviewRows(cut).map((r) => r.text)).toEqual([cut.input, cut.locations, cut.title]);
  });

  it("only a block that cannot lift takes the allow off the primary slot", () => {
    expect(permissionAllowGone({ state: "loading" })).toBe(false);
    expect(permissionAllowGone(permissionPreviewGate(honestHash, { status: "error" }))).toBe(false);
    expect(permissionAllowGone(permissionPreviewGate(cutHash, read(cut, cutHash)))).toBe(true);
    expect(permissionAllowGone(permissionPreviewGate(null, read(null)))).toBe(true);
  });
});
