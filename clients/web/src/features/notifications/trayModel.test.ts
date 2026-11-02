import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLocaleService, resolveLocaleContext } from "@momo/core/i18n";
import type { AdeItem } from "@momo/core/features/work/adeControl";
import {
  buildTrayStatus,
  cleanTitle,
  createRowIds,
  TRAY_MAX_ROWS,
  trayCopy,
  type TrayCopy,
} from "./trayModel";

// 셸 쪽의 정본(`tray.rs`)과 같은 파일을 읽는다 — 이 시험이 요구하는 것이 셸이 받는 것이다.
const shell = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../desktop/src-tauri/${path}`, import.meta.url)), "utf8");

const copy: TrayCopy = {
  labels: {
    running: "Running",
    none: "Nothing running",
    newMessage: "New message",
    open: "Open oort",
    quit: "Quit oort",
  },
  stateWorking: "Working",
  stateBlocked: "Waiting",
  more: (count) => `${count} more`,
};

const UUID = "0a1b2c3d-0000-4000-8000-";
function item(over: Partial<AdeItem> & { key: string; title: string }): AdeItem {
  return {
    kind: "run",
    state: "working",
    durability: "unknown",
    channelId: `${UUID}0000000000c1`,
    detail: "",
    ...over,
  };
}
const blockedRun = item({
  key: `run|${UUID}000000000001|${UUID}0000000000c1`,
  title: "김인턴",
  state: "blocked",
  runId: `${UUID}000000000001`,
  memberId: `${UUID}0000000000a1`,
});
const workingSession = item({
  key: `session|${UUID}0000000000e1`,
  title: "codex",
  kind: "session",
  sessionId: `${UUID}0000000000e1`,
});

function build(items: AdeItem[], over: { unread?: number; compose?: boolean } = {}) {
  return buildTrayStatus({
    unread: over.unread ?? 0,
    compose: over.compose ?? true,
    items,
    copy,
    rowIds: createRowIds(),
  });
}

describe("메뉴 막대 상태 (#5193)", () => {
  it("보내는 상태는 셸 시험이 받아들이는 JSON 그대로다 (tests/fixtures/tray_status.json)", () => {
    const sent = build([blockedRun, workingSession], { unread: 3 }).status;
    expect(sent).toEqual(JSON.parse(shell("tests/fixtures/tray_status.json")));
  });

  it("실행 중인 것만 싣는다: 유휴는 빠지고, 관제 서랍이 정한 순서가 그대로다", () => {
    const idle = item({ key: "session|idle", title: "쉬는 중", state: "idle", kind: "session", sessionId: "s" });
    const { status, byId } = build([blockedRun, idle, workingSession]);
    expect(status.running.map((r) => [r.title, r.state])).toEqual([
      ["김인턴", "Waiting"],
      ["codex", "Working"],
    ]);
    expect(status.more).toBeNull();
    expect([...byId.values()]).toEqual([blockedRun, workingSession]);
  });

  it("줄은 셸의 상한까지이고 넘치는 수는 한 줄로 말한다. 상한은 셸 시험이 같이 읽는 파일의 수다", () => {
    const limits = JSON.parse(shell("tests/fixtures/tray_limits.json")) as { maxRunRows: number };
    expect(TRAY_MAX_ROWS).toBe(limits.maxRunRows);

    const many = Array.from({ length: TRAY_MAX_ROWS + 3 }, (_, i) =>
      item({ key: `session|${i}`, title: `작업 ${i}`, kind: "session", sessionId: `s${i}` })
    );
    const { status, byId } = build(many);
    expect(status.running).toHaveLength(TRAY_MAX_ROWS);
    expect(byId.size).toBe(TRAY_MAX_ROWS);
    expect(status.more).toBe("3 more");
    // 정확히 상한이면 넘침 줄이 없다.
    expect(build(many.slice(0, TRAY_MAX_ROWS)).status.more).toBeNull();
  });

  it("같은 카드는 같은 id를 갖고, 끝난 카드의 id는 다시 쓰이지 않는다", () => {
    const ids = createRowIds();
    const run = (items: AdeItem[]) =>
      buildTrayStatus({ unread: 0, compose: true, items, copy, rowIds: ids }).status.running.map((r) => r.id);
    expect(run([blockedRun, workingSession])).toEqual(["0", "1"]);
    // 위가 끝났다: 남은 카드의 id는 그대로다.
    expect(run([workingSession])).toEqual(["1"]);
    // 새 카드는 새 id다(0을 물려받지 않는다). 메뉴에 남은 옛 0 줄을 눌러도 엉뚱한 작업으로 가지 않는다.
    const fresh = item({ key: "session|new", title: "새 작업", kind: "session", sessionId: "n" });
    expect(run([workingSession, fresh])).toEqual(["1", "2"]);
    // 끝났다가 돌아온 카드도 새 id를 받는다: 메뉴에 남은 옛 줄이 돌아온 카드로 가지 않는다.
    expect(run([blockedRun, workingSession])).toEqual(["3", "1"]);
  });

  it("이름의 제어·방향 문자는 걷고 공백은 접으며, 64 코드 포인트에서 자르되 서로게이트를 쪼개지 않는다", () => {
    expect(cleanTitle("  김\n인턴\u202Ex\u200By\t z  ")).toBe("김 인턴 x y z");
    const emoji = "😀".repeat(70);
    const cut = cleanTitle(emoji);
    expect(Array.from(cut)).toHaveLength(64);
    expect(cut).toBe("😀".repeat(64));
  });

  it("이름이 비어 보이는 작업은 줄에서 빠지지만 넘침의 수에는 든다", () => {
    const blank = item({ key: "session|blank", title: " \u200B\n", kind: "session", sessionId: "b" });
    const { status } = build([blank, workingSession]);
    expect(status.running.map((r) => r.title)).toEqual(["codex"]);
    expect(status.more).toBe("1 more");
  });

  it("수와 「새 메시지」 켜짐은 그대로 간다", () => {
    expect(build([], { unread: 7, compose: false }).status).toMatchObject({ unread: 7, compose: false });
    expect(build([]).status).toMatchObject({ unread: 0, compose: true, running: [], more: null });
  });

  it("메뉴 낱말은 카탈로그에서 오고, 끝내기는 앱 메뉴의 ⌘Q와 같은 낱말이다", () => {
    const en = trayCopy(createLocaleService(resolveLocaleContext("en-US", { languages: [] })).formatMessage);
    expect(en.labels).toEqual(copy.labels);
    expect(en.stateWorking).toBe("Working");
    expect(en.stateBlocked).toBe("Waiting");
    expect(en.more(3)).toBe("3 more");
  });
});
