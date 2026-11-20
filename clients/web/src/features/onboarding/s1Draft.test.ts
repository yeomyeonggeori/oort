import { describe, expect, it } from "vitest";
import { resolveS1Seeds } from "./s1Draft";

describe("resolveS1Seeds (H-R3-1)", () => {
  it("prefers the current member handle over a stale draft when the profile door is saved", () => {
    const seeds = resolveS1Seeds({
      draft: {
        workspaceName: "여명거리",
        displayName: "한지후",
        handle: "jihu",
      },
      workspaceName: "여명거리",
      memberHandle: "han",
      memberDisplayName: "한지후",
      profileSaved: true,
      workspaceSaved: false,
    });
    expect(seeds.handle).toBe("han");
    expect(seeds.displayName).toBe("한지후");
    expect(seeds.workspaceName).toBe("여명거리");
  });

  it("keeps the draft for a door that has not been saved", () => {
    const seeds = resolveS1Seeds({
      draft: {
        workspaceName: "새벽 팀",
        displayName: "성재",
        handle: "jihu",
      },
      workspaceName: "여명거리",
      memberHandle: "han",
      memberDisplayName: "한지후",
      profileSaved: false,
      workspaceSaved: false,
    });
    expect(seeds).toEqual({
      workspaceName: "새벽 팀",
      displayName: "성재",
      handle: "jihu",
    });
  });

  it("uses the current workspace name when that door is saved", () => {
    const seeds = resolveS1Seeds({
      draft: {
        workspaceName: "여명거리",
        displayName: "성재",
        handle: "jihu",
      },
      workspaceName: "새벽 팀",
      memberHandle: "jihu",
      memberDisplayName: "한지후",
      profileSaved: false,
      workspaceSaved: true,
    });
    expect(seeds.workspaceName).toBe("새벽 팀");
    expect(seeds.handle).toBe("jihu");
  });
});
