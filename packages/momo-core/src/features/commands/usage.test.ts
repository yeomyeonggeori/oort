import { describe, expect, it } from "vitest";
import {
  COMMAND_RECENT_LIMIT,
  EMPTY_COMMAND_USAGE,
  parseCommandUsage,
  rankCommands,
  recordCommandUse,
  serializeCommandUsage,
} from "./usage";

const rows = [
  { id: "a" },
  { id: "b" },
  { id: "c" },
  { id: "d" },
] as const;

function ids(list: readonly { id: string }[]): string[] {
  return list.map((row) => row.id);
}

describe("명령 사용 기록", () => {
  it("저장이 비어 있거나 깨져 있어도 빈 값으로 읽는다", () => {
    expect(parseCommandUsage(null)).toEqual(EMPTY_COMMAND_USAGE);
    expect(parseCommandUsage("")).toEqual(EMPTY_COMMAND_USAGE);
    expect(parseCommandUsage("{")).toEqual(EMPTY_COMMAND_USAGE);
    expect(parseCommandUsage("[1,2,3]")).toEqual(EMPTY_COMMAND_USAGE);
    expect(parseCommandUsage('"nav.inbox"')).toEqual(EMPTY_COMMAND_USAGE);
  });

  it("남이 심어 둔 이상한 값은 걸러 내고 나머지는 살린다", () => {
    const usage = parseCommandUsage(
      JSON.stringify({
        v: 1,
        recent: ["a", 7, "", "b", null, "a"],
        counts: { a: 3, b: "많이", c: -1, d: 0, e: 2.7, "": 9 },
      })
    );
    expect(usage.recent).toEqual(["a", "b"]);
    expect(usage.counts).toEqual({ a: 3, e: 2 });
  });

  it("왕복해도 같다", () => {
    const usage = recordCommandUse(recordCommandUse(EMPTY_COMMAND_USAGE, "a"), "b");
    expect(parseCommandUsage(serializeCommandUsage(usage))).toEqual(usage);
  });

  it("최근 목록은 맨 앞으로 올라가고 상한을 넘지 않는다", () => {
    let usage = EMPTY_COMMAND_USAGE;
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      usage = recordCommandUse(usage, id);
    }
    expect(usage.recent).toHaveLength(COMMAND_RECENT_LIMIT);
    expect(usage.recent).toEqual(["f", "e", "d", "c", "b"]);

    usage = recordCommandUse(usage, "c");
    expect(usage.recent).toEqual(["c", "f", "e", "d", "b"]);
    expect(usage.counts.c).toBe(2);
  });

  it("기록이 없으면 표의 바닥 순서 그대로다", () => {
    expect(ids(rankCommands(rows, EMPTY_COMMAND_USAGE))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("최근이 빈도를 이긴다", () => {
    const usage = { recent: ["d"], counts: { c: 50, d: 1 } };
    expect(ids(rankCommands(rows, usage))).toEqual(["d", "c", "a", "b"]);
  });

  it("최근 밖에서는 빈도가, 빈도도 같으면 바닥 순서가 정한다", () => {
    const usage = { recent: [], counts: { c: 5, b: 5, d: 9 } };
    expect(ids(rankCommands(rows, usage))).toEqual(["d", "b", "c", "a"]);
  });

  it("레지스트리에서 사라진 id의 기록은 순서를 흔들지 않는다", () => {
    const usage = { recent: ["없는명령", "b"], counts: { 없는명령: 99 } };
    expect(ids(rankCommands(rows, usage))).toEqual(["b", "a", "c", "d"]);
  });

  it("같은 입력은 같은 출력을 준다 — 시계를 보지 않는다", () => {
    const usage = { recent: ["b", "a"], counts: { a: 2, b: 2, c: 2, d: 2 } };
    const once = ids(rankCommands(rows, usage));
    const twice = ids(rankCommands(rows, usage));
    expect(once).toEqual(twice);
    expect(once).toEqual(["b", "a", "c", "d"]);
  });

  it("입력 배열을 제자리에서 뒤집지 않는다", () => {
    const input = [...rows];
    rankCommands(input, { recent: ["d"], counts: {} });
    expect(ids(input)).toEqual(["a", "b", "c", "d"]);
  });
});
