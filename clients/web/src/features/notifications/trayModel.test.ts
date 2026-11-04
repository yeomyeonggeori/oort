import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLocaleService, loadMessageCatalog, resolveLocaleContext } from "@momo/core/i18n";
import type { AdeItem } from "@momo/core/features/work/adeControl";
import type { ReadState } from "@momo/core/lib/api";
import {
  buildTrayStatus,
  cleanTitle,
  createRowIds,
  readAllTargets,
  TRAY_MAX_ROWS,
  trayCopy,
  type StillWaiting,
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
    readAll: "Mark all as read",
    open: "Open oort",
    quit: "Quit oort",
  },
  stateWorking: "Working",
  stateBlocked: "Waiting",
  more: (count) => `${count} more`,
  // 셸 시험이 읽는 같은 JSON(`tray_status.json`)의 줄과 글자가 같아야 한다.
  remaining: ({ approvals }) => (approvals > 0 ? `${approvals} approvals are still waiting` : null),
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

function build(
  items: AdeItem[],
  over: { unread?: number; compose?: boolean; readAll?: boolean; left?: StillWaiting } = {}
) {
  return buildTrayStatus({
    unread: over.unread ?? 0,
    compose: over.compose ?? true,
    readAll: over.readAll ?? false,
    left: over.left ?? { approvals: 0, panes: 0 },
    items,
    copy,
    rowIds: createRowIds(),
  });
}

describe("메뉴 막대 상태 (#5193)", () => {
  it("보내는 상태는 셸 시험이 받아들이는 JSON 그대로다 (tests/fixtures/tray_status.json)", () => {
    const sent = build([blockedRun, workingSession], {
      unread: 3,
      readAll: true,
      left: { approvals: 2, panes: 0 },
    }).status;
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
      buildTrayStatus({
        unread: 0,
        compose: true,
        readAll: false,
        left: { approvals: 0, panes: 0 },
        items,
        copy,
        rowIds: ids,
      }).status.running.map((r) => r.id);
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

  it("「모두 읽음 처리」의 켜짐과 남은 일 줄은 그대로 가고, 남은 게 없으면 줄이 없다 (#5195)", () => {
    expect(build([], { readAll: true, left: { approvals: 2, panes: 0 } }).status).toMatchObject({
      readAll: true,
      remaining: "2 approvals are still waiting",
    });
    expect(build([]).status).toMatchObject({ readAll: false, remaining: null });
  });

  it("메뉴 낱말은 카탈로그에서 오고, 끝내기는 앱 메뉴의 ⌘Q와 같은 낱말이다", () => {
    const en = trayCopy(createLocaleService(resolveLocaleContext("en-US", { languages: [] })).formatMessage);
    expect(en.labels).toEqual(copy.labels);
    expect(en.stateWorking).toBe("Working");
    expect(en.stateBlocked).toBe("Waiting");
    expect(en.more(3)).toBe("3 more");
  });

  // 남은 일의 한 줄(#5195): 승인만 / 응답 필요 칸만 / 둘 다 — 어느 경우에도 눌러도 점이 남는 까닭을 정확히 말하고, 둘 다
  // 없으면 줄이 없다. 한국어는 owner가 정한 문장(「승인 N건은 남아 있어요」) 그대로다.
  it("남은 일 한 줄은 승인·응답 필요 칸의 수에 맞는 문장이고, 없으면 null이다 (ko·en)", async () => {
    const make = async (locale: "ko-KR" | "en-US") =>
      trayCopy(
        createLocaleService({
          ...resolveLocaleContext(locale, { languages: [locale], timeZone: "UTC" }),
          catalog: await loadMessageCatalog(locale),
        }).formatMessage
      ).remaining;
    const ko = await make("ko-KR");
    expect(ko({ approvals: 3, panes: 0 })).toBe("승인 3건은 남아 있어요");
    expect(ko({ approvals: 0, panes: 2 })).toBe("응답 필요 2칸은 남아 있어요");
    expect(ko({ approvals: 1, panes: 2 })).toBe("승인 1건, 응답 필요 2칸은 남아 있어요");
    expect(ko({ approvals: 0, panes: 0 })).toBeNull();
    const en = await make("en-US");
    expect(en({ approvals: 1, panes: 0 })).toBe("1 approval is still waiting for you");
    expect(en({ approvals: 2, panes: 0 })).toBe("2 approvals are still waiting for you");
    expect(en({ approvals: 0, panes: 1 })).toBe("1 pane is still waiting for you");
    expect(en({ approvals: 2, panes: 1 })).toBe("2 approvals and 1 pane are still waiting for you");
    expect(en({ approvals: 0, panes: 0 })).toBeNull();
  });
});

describe("「모두 읽음 처리」가 읽을 채널 (#5195)", () => {
  const row = (channelId: string, over: Partial<ReadState> = {}): ReadState => ({
    channelId,
    lastReadSeq: 10,
    latestSeq: 10,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    ...over,
  });
  const DM_A = "0a1b2c3d-0000-4000-8000-0000000000d1";
  const DM_B = "0a1b2c3d-0000-4000-8000-0000000000d2";
  const CH_MENTION = "0a1b2c3d-0000-4000-8000-0000000000c1";
  const CH_PLAIN = "0a1b2c3d-0000-4000-8000-0000000000c2";
  const dms = new Set([DM_A, DM_B]);

  it("멘션이 있는 채널과 안 읽은 DM만 든다. 그냥 안 읽은 채널은 두고, 위치는 지금까지 아는 최신까지다", () => {
    const targets = readAllTargets({
      readStates: [
        row(CH_MENTION, { latestSeq: 40, lastReadSeq: 30, unreadCount: 10, mentionCount: 2 }),
        row(CH_PLAIN, { latestSeq: 50, lastReadSeq: 20, unreadCount: 30 }),
        row(DM_A, { latestSeq: 7, lastReadSeq: 5, unreadCount: 2 }),
        row(DM_B), // 다 읽은 DM
      ],
      dmChannelIds: dms,
    });
    expect(targets).toEqual([
      { channelId: CH_MENTION, seq: 40 },
      { channelId: DM_A, seq: 7 },
    ]);
  });

  it("멘션이 있는 DM은 한 번만 들고, 「여기부터 안 읽음」으로 표시한 DM도 안 읽은 DM이다(사이드바와 같은 판정)", () => {
    const targets = readAllTargets({
      readStates: [
        row(DM_A, { latestSeq: 9, lastReadSeq: 5, unreadCount: 4, mentionCount: 1 }),
        row(DM_B, { latestSeq: 10, lastReadSeq: 10, unreadCount: 0, markedUnreadBeforeSeq: 8 }),
      ],
      dmChannelIds: dms,
    });
    expect(targets).toEqual([
      { channelId: DM_A, seq: 9 },
      { channelId: DM_B, seq: 10 },
    ]);
  });

  it("읽을 것이 없으면 비어 있다 — 메뉴의 「모두 읽음 처리」가 꺼지는 때다. 대소문자가 다른 id도 같은 채널이다", () => {
    expect(readAllTargets({ readStates: [row(CH_PLAIN, { unreadCount: 3, latestSeq: 13 }), row(DM_A)], dmChannelIds: dms })).toEqual([]);
    expect(readAllTargets({ readStates: [], dmChannelIds: dms })).toEqual([]);
    const upper = DM_A.toUpperCase();
    expect(
      readAllTargets({
        readStates: [row(upper, { latestSeq: 3, lastReadSeq: 1, unreadCount: 2 }), row(DM_A, { latestSeq: 3, lastReadSeq: 1, unreadCount: 2 })],
        dmChannelIds: dms,
      })
    ).toEqual([{ channelId: upper, seq: 3 }]);
  });
});
