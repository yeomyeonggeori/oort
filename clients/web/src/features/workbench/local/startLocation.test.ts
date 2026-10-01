import { describe, expect, it } from "vitest";
import {
  RECENT_MAX,
  START_STORAGE_KEY,
  forgetFolder,
  parentName,
  readStartState,
  rememberFolder,
  startErrorMessage,
  worktreeAvailability,
  writeStartState,
  type StartFolder,
  type StartStorage,
} from "./startLocation";

const f = (name: string, repo: StartFolder["repo"] = "none"): StartFolder => ({
  path: `/Users/t/projects/${name}`,
  name,
  repo,
});

function storage(initial?: string): StartStorage & { raw: () => string | null } {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_k, v) => {
      value = v;
    },
    raw: () => value,
  };
}

describe("시작 위치 저장 (#2775)", () => {
  it("처음에는 홈이고 최근이 없다", () => {
    expect(readStartState(storage())).toEqual({ choice: { kind: "home" }, recent: [] });
  });

  it("쓴 것을 그대로 읽는다", () => {
    const s = storage();
    writeStartState({ choice: { kind: "folder", folder: f("a", "ready") }, recent: [f("a", "ready"), f("b")] }, s);
    expect(readStartState(s)).toEqual({
      choice: { kind: "folder", folder: f("a", "ready") },
      recent: [f("a", "ready"), f("b")],
    });
  });

  it("깨진 저장 값·상대 경로·모르는 repo 값은 안전하게 버린다", () => {
    expect(readStartState(storage("{not json"))).toEqual({ choice: { kind: "home" }, recent: [] });
    const bad = JSON.stringify({
      choice: { kind: "folder", folder: { path: "relative/dir", name: "x", repo: "ready" } },
      recent: [{ path: "relative", name: "x" }, { path: "/ok", name: "ok", repo: "weird" }, 3, null],
    });
    expect(readStartState(storage(bad))).toEqual({
      choice: { kind: "home" },
      recent: [{ path: "/ok", name: "ok", repo: "none" }],
    });
  });

  it("저장소가 없거나 던져도 읽고 쓰기가 터지지 않는다", () => {
    const throwing: StartStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStartState(throwing)).toEqual({ choice: { kind: "home" }, recent: [] });
    expect(() => writeStartState({ choice: { kind: "home" }, recent: [] }, throwing)).not.toThrow();
    expect(() => writeStartState({ choice: { kind: "home" }, recent: [] }, null)).not.toThrow();
    expect(START_STORAGE_KEY).toContain("startLocation");
  });
});

describe("최근 프로젝트", () => {
  it("쓴 폴더가 맨 앞으로 오고, 같은 경로는 하나이며, 다섯 개까지다", () => {
    let recent: StartFolder[] = [];
    for (const name of ["a", "b", "c", "d", "e", "g"]) recent = rememberFolder(recent, f(name));
    expect(recent.map((r) => r.name)).toEqual(["g", "e", "d", "c", "b"]);
    expect(recent).toHaveLength(RECENT_MAX);
    expect(rememberFolder(recent, f("c")).map((r) => r.name)).toEqual(["c", "g", "e", "d", "b"]);
    expect(forgetFolder(recent, f("e").path).map((r) => r.name)).toEqual(["g", "d", "c", "b"]);
  });

  it("같은 이름의 프로젝트는 부모 이름으로 가른다", () => {
    expect(parentName("/Users/t/projects/oort")).toBe("projects");
    expect(parentName("/oort")).toBe("");
  });
});

describe("worktree 격리를 켤 수 있는가", () => {
  it("git 저장소(커밋 있음)에서만 켠다. 아니면 이유를 준다", () => {
    expect(worktreeAvailability({ kind: "folder", folder: f("a", "ready") })).toEqual({ enabled: true });
    for (const choice of [
      { kind: "home" } as const,
      { kind: "folder", folder: f("a", "none") } as const,
      { kind: "folder", folder: f("a", "empty") } as const,
    ]) {
      const result = worktreeAvailability(choice);
      expect(result.enabled).toBe(false);
      if (!result.enabled) expect(result.reason.length).toBeGreaterThan(5);
    }
  });
});

describe("셸의 거부 문구를 사람이 읽는 말로", () => {
  it.each([
    ["refused: folder does not exist", "폴더를 찾을 수 없어요"],
    ["refused: folder is not a directory", "폴더가 아니에요"],
    ["refused: folder is outside the home directory", "홈 폴더 안의 폴더만"],
    ["refused: folder is not readable", "읽을 권한이 없어요"],
    ["refused: folder path must not contain '..'", "경로가 올바르지 않아요"],
    ["refused: folder must be an absolute path", "경로가 올바르지 않아요"],
    ["worktree_failed: not a repository", "git 저장소가 아니라서"],
    ["worktree_failed: no commit yet", "아직 커밋이 없어서"],
    ["worktree_failed: unsupported filter", "필터 설정"],
    ["worktree_failed: git refused", "worktree를 만들지 못했어요"],
  ])("%s", (raw, expected) => {
    expect(startErrorMessage(new Error(raw))).toContain(expected);
  });

  it("모르는 문구는 그대로 둔다", () => {
    expect(startErrorMessage(new Error("something else"))).toBe("something else");
    expect(startErrorMessage("plain")).toBe("plain");
  });
});
