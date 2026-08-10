import { describe, expect, it } from "vitest";
import { workspaceRailTile } from "./workspaceRailModel";

const WS_ID = "9f2a1c00-0000-4000-8000-000000000000";

describe("workspaceRailTile", () => {
  it("draws the workspace name's initial once the name resolves", () => {
    const tile = workspaceRailTile(
      { name: "디자인팀", isPending: false, isError: false },
      WS_ID
    );
    expect(tile).toEqual({ initial: "디", label: "디자인팀", loading: false });
  });

  it("trims the name before taking the initial and the label", () => {
    const tile = workspaceRailTile(
      { name: "  Momo HQ  ", isPending: false, isError: false },
      WS_ID
    );
    expect(tile.initial).toBe("M");
    expect(tile.label).toBe("Momo HQ");
  });

  it("shows no letter while the name is still loading (no stand-in glyph)", () => {
    const tile = workspaceRailTile(
      { name: undefined, isPending: true, isError: false },
      WS_ID
    );
    expect(tile.initial).toBeNull();
    expect(tile.loading).toBe(true);
    expect(tile.label).toBe("워크스페이스 불러오는 중");
  });

  it("falls back to the workspace id, never a person, on error", () => {
    const tile = workspaceRailTile(
      { name: undefined, isPending: false, isError: true },
      WS_ID
    );
    // First id glyph, upper-cased. The point of the assertion is the negative:
    // the tile never borrows a name it was not given.
    expect(tile.initial).toBe("9");
    expect(tile.label).toBe("워크스페이스");
    expect(tile.loading).toBe(false);
  });

  it("falls back the same way when the fetch resolves to an empty name", () => {
    const tile = workspaceRailTile(
      { name: "   ", isPending: false, isError: false },
      WS_ID
    );
    expect(tile.initial).toBe("9");
    expect(tile.label).toBe("워크스페이스");
  });

  // The regression this whole module exists to stop: the tile used to be fed
  // `selfName` (the member's display name). There is no parameter here that
  // could carry it, so the closest a caller can get is passing it as `name`,
  // and even then the function is doing what it is told to render "the
  // workspace name" — the wiring guard is the prop TYPE at the call site
  // (WorkspaceRail takes a name-query object, not a bare string), and this test
  // pins the id-derived fallback so a resolved-but-nameless workspace lands on
  // the id, not on whatever string was nearest.
  it("uppercases a lowercase id fallback glyph", () => {
    const tile = workspaceRailTile(
      { name: undefined, isPending: false, isError: true },
      "abcd-ef"
    );
    expect(tile.initial).toBe("A");
  });
});
