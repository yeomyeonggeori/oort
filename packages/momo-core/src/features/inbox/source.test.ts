import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "../../lib/api";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit/i18n";
import { makeDirectory } from "../workspace/directory";
import { serverEntry, taskEntry } from "./mailbox";
import { parseInboxItem } from "./serverInbox";
import {
  mailboxPlace,
  mailboxSource,
  mailboxSourceLine,
  sourceSaysKind,
  type MailboxPlace,
} from "./source";

// =============================================================================
// 받은함 출처 한 줄 (#5696). 판정(장소·출처)과 문장(사전 키)을 따로 잰다. 이름은 모두 가상 인물이다.
// =============================================================================

const SELF = "00000000-0000-7000-8000-000000000101";
const DOHYUN = "00000000-0000-7000-8000-000000000102";
const SEOYEON = "00000000-0000-7000-8000-000000000103";
const JUNHO = "00000000-0000-7000-8000-000000000104";
const MINJI = "00000000-0000-7000-8000-000000000105";
const GONE = "00000000-0000-7000-8000-0000000009ff";
const CH = "00000000-0000-7000-8000-000000000201";
const DM = "00000000-0000-7000-8000-000000000401";

const copyKo = createMessageCopy({ messageLocale: "ko-KR", catalog: ko });
const copyEn = createMessageCopy({ messageLocale: "en-US" });

function member(id: string, name: string): RosterMember {
  return {
    id,
    workspaceId: "w",
    kind: "human",
    status: "active",
    displayName: name,
    handle: name,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const directory = makeDirectory([
  member(SELF, "구민수"),
  member(DOHYUN, "김도현"),
  member(SEOYEON, "이서연"),
  member(JUNHO, "박준호"),
  member(MINJI, "최민지"),
]);

function channel(over: Partial<Channel>): Channel {
  return { id: CH, workspaceId: "w", kind: "public", muted: false, ...over };
}

const place = (input: Parameters<typeof mailboxPlace>[0]) => mailboxPlace(input);
const line = (p: MailboxPlace, kind: Parameters<typeof mailboxSource>[0], inThread = false) =>
  mailboxSourceLine(mailboxSource(kind, p, inThread), copyKo);

describe("장소: 내 채널 목록에 있는 채널", () => {
  it("채널은 이름 하나, 「#」는 출처 문장이 한 번만 붙인다", () => {
    const p = place({ channel: channel({ name: "agent-lab" }), directory, selfMemberId: SELF });
    expect(p).toEqual({ kind: "channel", name: "agent-lab" });
    expect(line(p, "mention")).toBe("#agent-lab");
    expect(line(p, "thread", true)).toBe("스레드 · #agent-lab");
    // 서버 이름이 따로 와도 목록의 이름이 이긴다(같은 채널이면 같은 이름이다).
    expect(place({ channel: channel({ name: "agent-lab" }), wire: { name: "옛이름", kind: "public" }, directory, selfMemberId: SELF }))
      .toEqual({ kind: "channel", name: "agent-lab" });
  });

  it("1:1 DM은 상대 이름, 여럿인 DM은 둘까지 세우고 「외 N명」", () => {
    const one = place({
      channel: channel({ id: DM, kind: "dm", memberIds: [SELF, DOHYUN] }),
      directory,
      selfMemberId: SELF,
    });
    expect(line(one, "dm")).toBe("DM · 김도현");

    const three = place({
      channel: channel({ id: DM, kind: "dm", memberIds: [SELF, DOHYUN, SEOYEON] }),
      directory,
      selfMemberId: SELF,
    });
    expect(line(three, "dm")).toBe("DM · 김도현, 이서연");

    const five = place({
      channel: channel({ id: DM, kind: "dm", memberIds: [SELF, DOHYUN, SEOYEON, JUNHO, MINJI] }),
      directory,
      selfMemberId: SELF,
    });
    expect(line(five, "dm")).toBe("DM · 김도현, 이서연 외 2명");
    expect(mailboxSourceLine(mailboxSource("dm", five, false), copyEn)).toBe("DM · 김도현, 이서연 and 2 others");
  });

  it("명부에서 빠진 상대·나 혼자인 DM은 대화 이름을 정하는 한 함수의 말을 그대로 쓴다", () => {
    const gone = place({
      channel: channel({ id: DM, kind: "dm", memberIds: [SELF, GONE] }),
      directory,
      selfMemberId: SELF,
    });
    expect(line(gone, "dm")).toBe("DM · 나간 멤버");
    const self = place({ channel: channel({ id: DM, kind: "dm", memberIds: [SELF] }), directory, selfMemberId: SELF });
    expect(line(self, "dm")).toBe("DM · 구민수 (나)");
  });
});

describe("장소: 내 목록에 없는 채널은 서버가 준 값만 (보이는 범위 그대로)", () => {
  it("떠난 DM은 이름 없이 「DM」이다 — 명부에 있는 글쓴이 이름으로 DM 이름을 짓지 않는다", () => {
    // 글쓴이(김도현)는 명부에 있고 줄의 첫 줄에 이미 선다. 출처 줄이 그 이름을 다시 끌어오면 안 된다.
    const p = place({ channel: undefined, wire: { name: null, kind: "dm" }, directory, selfMemberId: SELF });
    expect(p).toEqual({ kind: "dm", names: [] });
    const text = line(p, "dm");
    expect(text).toBe("DM");
    for (const name of ["김도현", "이서연", "박준호", "최민지", "구민수"]) expect(text).not.toContain(name);

    const entry = serverEntry(
      parseInboxItem({
        id: "i-dm",
        kind: "dm",
        reasons: ["dm"],
        channel: { id: DM, name: null, kind: "dm" },
        message: { id: "m1", seq: 3, authorMemberId: DOHYUN, preview: "안녕하세요", deleted: false },
        actorMemberId: DOHYUN,
        createdAt: "2026-11-13T01:00:00Z",
      })!,
      { channelLabel: DM.slice(0, 8), place: p, actor: { name: "김도현", isAgent: false }, nowMs: 0 }
    );
    expect(mailboxSourceLine(entry.source, copyKo)).toBe("DM");
  });

  it("볼 수 없게 된 채널은 서버가 준 이름, 그것도 없으면 「채널」(id 조각을 이름처럼 내지 않는다)", () => {
    const named = place({ channel: undefined, wire: { name: "release-notes", kind: "private" }, directory, selfMemberId: SELF });
    expect(line(named, "mention")).toBe("#release-notes");
    const nameless = place({ channel: undefined, wire: { name: null, kind: "private" }, directory, selfMemberId: SELF });
    expect(line(nameless, "mention")).toBe("채널");
    expect(line(nameless, "thread", true)).toBe("스레드");
    // 구 서버 경로(서버 사실이 없다)도 같은 말을 한다.
    expect(line(place({ channel: undefined, directory, selfMemberId: SELF }), "mention")).toBe("채널");
  });
});

describe("출처 판정", () => {
  const ch: MailboxPlace = { kind: "channel", name: "workbench" };
  const dm: MailboxPlace = { kind: "dm", names: ["김도현"] };

  it("스레드 안의 글은 종류와 무관하게 「스레드 · #채널」, 아니면 「#채널」", () => {
    expect(line(ch, "thread", true)).toBe("스레드 · #workbench");
    expect(line(ch, "mention", true)).toBe("스레드 · #workbench");
    expect(line(ch, "reply", true)).toBe("스레드 · #workbench");
    expect(line(ch, "mention", false)).toBe("#workbench");
    expect(line(ch, "reply", false)).toBe("#workbench");
  });

  it("DM은 스레드 안이어도 「DM · 이름」(장소가 그 대화다)", () => {
    expect(line(dm, "dm", false)).toBe("DM · 김도현");
    expect(line(dm, "thread", true)).toBe("DM · 김도현");
    expect(line(dm, "mention", true)).toBe("DM · 김도현");
  });

  it("처리할 일은 지금의 종류 표시를 그 자리에 둔다", () => {
    const task = taskEntry(
      {
        key: "approval:a1", kind: "approval", approvalId: "a1", pending: true, actor: "@kim-intern",
        actorIsAgent: true, predicate: "배포 승인 요청", channelId: CH, channelLabel: "workbench",
        timeLabel: "방금", sortAtMs: 1, reason: "r", outcome: null, outcomeTone: "muted", tone: "warn",
      } as Parameters<typeof taskEntry>[0],
      1
    );
    expect(task).not.toBeNull();
    expect(mailboxSourceLine(task!.source, copyKo)).toBe("처리할 일 · 승인 요청");
    expect(mailboxSourceLine(task!.source, copyEn)).toBe("To do · Approval request");
  });

  it("서버 항목: 스레드 답글과 `rootId`가 있는 멘션은 스레드, 채널의 답글은 「#채널」", () => {
    const wire = (over: Record<string, unknown>) =>
      parseInboxItem({
        id: "i1",
        kind: "mention",
        reasons: ["mention"],
        channel: { id: CH, name: "workbench", kind: "public" },
        message: { id: "m1", seq: 3, authorMemberId: DOHYUN, preview: "확인 부탁", deleted: false },
        actorMemberId: DOHYUN,
        createdAt: "2026-11-13T01:00:00Z",
        ...over,
      })!;
    const input = { channelLabel: "workbench", place: ch, actor: { name: "김도현", isAgent: false }, nowMs: 0 };
    const of = (over: Record<string, unknown>) => mailboxSourceLine(serverEntry(wire(over), input).source, copyKo);
    expect(of({ kind: "thread_reply", reasons: ["thread_reply"], rootId: "r1" })).toBe("스레드 · #workbench");
    expect(of({ rootId: "r1" })).toBe("스레드 · #workbench");
    expect(of({})).toBe("#workbench");
    expect(of({ kind: "reply_to_me", reasons: ["reply_to_me"] })).toBe("#workbench");
  });

  it("모든 출처가 빈 줄 없이 글을 낸다(줄 높이가 출처에 따라 달라지지 않는다)", () => {
    const places: MailboxPlace[] = [
      ch,
      dm,
      { kind: "channel", name: null },
      { kind: "dm", names: [] },
      { kind: "dm", names: ["가", "나", "다"] },
    ];
    const kinds = ["dm", "mention", "reply", "thread", "task"] as const;
    for (const p of places) {
      for (const kind of kinds) {
        for (const inThread of [false, true]) {
          for (const copy of [copyKo, copyEn]) {
            expect(mailboxSourceLine(mailboxSource(kind, p, inThread), copy).trim()).not.toBe("");
          }
        }
      }
    }
  });

  it("출처 줄이 종류를 말하는지: 스레드·DM·처리할 일은 말하고, 채널의 멘션·답글과 DM 안의 스레드는 말하지 않는다", () => {
    expect(sourceSaysKind("thread", mailboxSource("thread", ch, true))).toBe(true);
    expect(sourceSaysKind("dm", mailboxSource("dm", dm, false))).toBe(true);
    expect(sourceSaysKind("task", mailboxSource("task", ch, false))).toBe(true);
    expect(sourceSaysKind("mention", mailboxSource("mention", ch, false))).toBe(false);
    expect(sourceSaysKind("reply", mailboxSource("reply", ch, false))).toBe(false);
    expect(sourceSaysKind("thread", mailboxSource("thread", dm, true))).toBe(false);
  });
});
