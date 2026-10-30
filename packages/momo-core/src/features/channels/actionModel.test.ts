import { describe, expect, it } from "vitest";
import {
  CHANNEL_COPY_GROUP_LABEL,
  CHANNEL_COPY_ID_DONE_LABEL,
  CHANNEL_COPY_ID_LABEL,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_READ_LABEL,
  CHANNEL_MARK_UNREAD_LABEL,
  CHANNEL_MUTE_LABEL,
  CHANNEL_TOPIC_VIEW_LABEL,
  CHANNEL_UNMUTE_LABEL,
} from "./model";
import {
  COPY_LINK_ACTION_LABEL,
  COPY_LINK_DONE_LABEL,
} from "../timeline/copyLabels";
import type { Channel } from "../../lib/api";
import {
  channelActionAvailability,
  channelActionClusterTitle,
  channelActionItems,
  channelActionItemsForSurface,
  channelActionKeepsMenuOpen,
  channelActionMenuLabel,
  type ChannelActionKey,
  type ChannelActionState,
} from "./actionModel";

const WS = "00000000-0000-7000-8000-000000000001";

function channel(over: Partial<Channel> = {}): Channel {
  return {
    id: "00000000-0000-7000-8000-000000000201",
    workspaceId: WS,
    kind: "public",
    name: "general",
    muted: false,
    ...over,
  };
}

const REST: ChannelActionState = {
  muted: false,
  copiedLink: false,
  copiedName: false,
};

function keysOf(items: { key: ChannelActionKey }[]): ChannelActionKey[] {
  return items.map((item) => item.key);
}

describe("channelActionAvailability", () => {
  it("안 읽음이 없는 채널에는 「읽음 처리」를 내놓지 않는다", () => {
    expect(
      channelActionAvailability({
        channel: channel(),
        selfRole: "owner",
        unreadCount: 0,
      }).markRead
    ).toBe(false);
    expect(
      channelActionAvailability({
        channel: channel(),
        selfRole: "owner",
        unreadCount: 3,
      }).markRead
    ).toBe(true);
  });

  it("토픽이 비었으면 「주제 보기」가 없다. 공백만 있어도 없다", () => {
    expect(
      channelActionAvailability({
        channel: channel({ topic: "   " }),
        selfRole: "owner",
        unreadCount: 0,
      }).topic
    ).toBe(false);
    expect(
      channelActionAvailability({
        channel: channel({ topic: "배포 로그" }),
        selfRole: "owner",
        unreadCount: 0,
      }).topic
    ).toBe(true);
  });

  it("일반 멤버에게 나가기는 막다른 길이라 그리지 않는다", () => {
    // 서버 remove_member 는 소유자/관리자만 통과시킨다. 확인 다이얼로그 뒤의
    // 403 은 없는 항목보다 나쁘다.
    expect(
      channelActionAvailability({
        channel: channel(),
        selfRole: "member",
        unreadCount: 0,
      }).leave
    ).toBe(false);
    expect(
      channelActionAvailability({
        channel: channel(),
        selfRole: undefined,
        unreadCount: 0,
      }).leave
    ).toBe(true);
  });

  it("DM 에는 나가기도 주제도 없다 — 서버에 그 문이 없다", () => {
    const dm = channelActionAvailability({
      channel: channel({ kind: "dm", name: undefined, topic: "무시된다" }),
      selfRole: "owner",
      unreadCount: 4,
    });
    expect(dm.leave).toBe(false);
    expect(dm.topic).toBe(false);
    // DM 에서도 여전히 할 수 있는 것은 남는다.
    expect(dm.markRead).toBe(true);
    expect(dm.mute).toBe(true);
    expect(dm.copyLink).toBe(true);
    expect(dm.copyName).toBe(true);
    expect(dm.copyId).toBe(true);
  });

  // ---- #3963 ---------------------------------------------------------------

  it("읽지 않음으로 표시는 읽음 처리의 반대 방향이다 — 둘이 함께 서지 않는다", () => {
    const read = channelActionAvailability({
      channel: channel(),
      selfRole: "owner",
      unreadCount: 0,
      canMarkUnread: true,
    });
    expect(read.markUnread).toBe(true);
    expect(read.markRead).toBe(false);
    // 안 읽음이 이미 있으면 「읽음 처리」가 서고, 호출부가 true 를 넘겨도 겹치지 않는다.
    const unread = channelActionAvailability({
      channel: channel(),
      selfRole: "owner",
      unreadCount: 3,
      canMarkUnread: true,
    });
    expect(unread.markRead).toBe(true);
    expect(unread.markUnread).toBe(false);
    // 투영을 든 호출부가 허락하지 않으면(투영 없음 · 빈 채널) 서지 않는다.
    expect(
      channelActionAvailability({
        channel: channel(),
        selfRole: "owner",
        unreadCount: 0,
      }).markUnread
    ).toBe(false);
  });

  it("DM 닫기는 DM 이고 닫을 손이 있을 때만 선다", () => {
    const dmChannel = channel({ kind: "dm", name: undefined });
    const base = { selfRole: "owner" as const, unreadCount: 0 };
    expect(
      channelActionAvailability({ channel: dmChannel, ...base, canCloseDm: true })
        .closeDm
    ).toBe(true);
    // 손이 없으면 눌러도 아무 일이 없는 항목이 된다.
    expect(channelActionAvailability({ channel: dmChannel, ...base }).closeDm).toBe(
      false
    );
    // 채널에는 닫기가 없다 - 채널을 사이드바에서 치우는 문은 「나가기」다.
    expect(
      channelActionAvailability({ channel: channel(), ...base, canCloseDm: true })
        .closeDm
    ).toBe(false);
  });

  it("ID 복사는 어느 채널에든 있다", () => {
    expect(
      channelActionAvailability({
        channel: channel({ kind: "private" }),
        selfRole: "member",
        unreadCount: 0,
      }).copyId
    ).toBe(true);
  });
});

describe("channelActionItems", () => {
  const ALL = channelActionAvailability({
    channel: channel({ topic: "배포 로그" }),
    selfRole: "owner",
    unreadCount: 2,
  });

  it("정본 순서: 주제 → 복사 → 상태 → 파괴", () => {
    expect(keysOf(channelActionItems(ALL, REST))).toEqual([
      "topic",
      "copy-name",
      "copy-link",
      "copy-id",
      "mark-read",
      "mute",
      "leave",
    ]);
  });

  it("낱말이 상태다: 알림도 복사도 지금을 읽는다", () => {
    const idle = channelActionItems(ALL, REST);
    expect(idle.find((i) => i.key === "mute")?.label).toBe(CHANNEL_MUTE_LABEL);
    expect(idle.find((i) => i.key === "copy-link")?.label).toBe(
      COPY_LINK_ACTION_LABEL
    );
    expect(idle.find((i) => i.key === "copy-id")?.label).toBe(CHANNEL_COPY_ID_LABEL);

    const after = channelActionItems(ALL, {
      muted: true,
      copiedLink: true,
      copiedName: true,
      copiedId: true,
    });
    expect(after.find((i) => i.key === "mute")?.label).toBe(CHANNEL_UNMUTE_LABEL);
    expect(after.find((i) => i.key === "copy-link")?.label).toBe(
      COPY_LINK_DONE_LABEL
    );
    expect(after.find((i) => i.key === "copy-name")?.label).toContain("복사됨");
    expect(after.find((i) => i.key === "copy-id")?.label).toBe(
      CHANNEL_COPY_ID_DONE_LABEL
    );
  });

  it("나가기만 파괴적이다", () => {
    const items = channelActionItems(ALL, REST);
    expect(items.filter((i) => i.tone === "danger").map((i) => i.key)).toEqual([
      "leave",
    ]);
    expect(items.find((i) => i.key === "leave")?.label).toBe(CHANNEL_LEAVE_LABEL);
  });

  it("구분선은 무리가 바뀌는 자리에만 선다", () => {
    const items = channelActionItems(ALL, REST);
    const separated = items.filter((i) => i.separatorBefore).map((i) => i.key);
    // 주제 → 복사, 복사 → 상태, 상태 → 파괴. 같은 무리 안(복사 셋 · 읽음/알림)에는 선이 없다.
    expect(separated).toEqual(["copy-name", "mark-read", "leave"]);
  });

  it("모든 항목이 무리를 든다 — 구분선의 단위가 항목마다 있다", () => {
    expect(
      channelActionItems(ALL, REST).map((i) => [i.key, i.cluster])
    ).toEqual([
      ["topic", "info"],
      ["copy-name", "copy"],
      ["copy-link", "copy"],
      ["copy-id", "copy"],
      ["mark-read", "state"],
      ["mute", "state"],
      ["leave", "danger"],
    ]);
    expect(channelActionClusterTitle("copy")).toBe(CHANNEL_COPY_GROUP_LABEL);
    // 제목이 없는 무리는 행만 선다. 섹션 이동은 항목이 자기 제목을 든다.
    expect(channelActionClusterTitle("state")).toBeUndefined();
    expect(channelActionClusterTitle("place")).toBeUndefined();
  });
});

describe("channelActionItemsForSurface", () => {
  const ALL = channelActionAvailability({
    channel: channel({ topic: "배포 로그" }),
    selfRole: "owner",
    unreadCount: 2,
  });

  it("헤더 ⋮ 는 BZ-2 가 세운 세 항목 그대로다", () => {
    expect(keysOf(channelActionItemsForSurface("header", ALL, REST))).toEqual([
      "topic",
      "mute",
      "leave",
    ]);
    expect(
      channelActionItemsForSurface("header", ALL, REST).find(
        (i) => i.key === "topic"
      )?.label
    ).toBe(CHANNEL_TOPIC_VIEW_LABEL);
  });

  it("헤더 ⋮ 의 구분선은 예전 그대로다: 주제 │ 알림 · 기억 │ 나가기", () => {
    const withMemory = channelActionAvailability({
      channel: channel({ topic: "배포 로그" }),
      selfRole: "owner",
      unreadCount: 2,
      hasMemorySettings: true,
    });
    const header = channelActionItemsForSurface("header", withMemory, REST);
    expect(keysOf(header)).toEqual(["topic", "mute", "memory", "leave"]);
    expect(header.map((i) => [i.key, Boolean(i.separatorBefore)])).toEqual([
      ["topic", false],
      ["mute", true],
      ["memory", false],
      ["leave", true],
    ]);
  });

  it("항목의 열쇠는 표면이 짓는 testid 의 절반이다", () => {
    // `channel-topic`·`channel-row-mark-read` 는 접두사 + testKey 다. 게이트가
    // 그 이름으로 누르므로 열쇠가 조용히 바뀌면 안 된다.
    expect(
      channelActionItemsForSurface("header", ALL, REST).map((i) => i.testKey)
    ).toEqual(["topic", "mute-toggle", "leave"]);
    expect(
      channelActionItemsForSurface("row", ALL, REST).map((i) => i.testKey)
    ).toEqual([
      "copy-name",
      "copy-link",
      "copy-id",
      "mark-read",
      "mute-toggle",
      "leave",
    ]);
  });

  it("행 우클릭은 「열지 않고 조작한다」만 든다", () => {
    expect(keysOf(channelActionItemsForSurface("row", ALL, REST))).toEqual([
      "copy-name",
      "copy-link",
      "copy-id",
      "mark-read",
      "mute",
      "leave",
    ]);
    expect(
      channelActionItemsForSurface("row", ALL, REST).find(
        (i) => i.key === "mark-read"
      )?.label
    ).toBe(CHANNEL_MARK_READ_LABEL);
  });

  it("행 메뉴는 Buzz 의 차례다: 복사 │ 섹션 │ 읽음·알림·별표 │ 나가기", () => {
    const full = channelActionAvailability({
      channel: channel({ topic: "배포 로그" }),
      selfRole: "owner",
      unreadCount: 0,
      sectionCount: 1,
      canStar: true,
      canMarkUnread: true,
    });
    const items = channelActionItemsForSurface("row", full, {
      ...REST,
      sections: [{ id: "sec-1", label: "출시 준비" }],
    });
    expect(items.map((i) => [i.key, Boolean(i.separatorBefore)])).toEqual([
      ["copy-name", false],
      ["copy-link", false],
      ["copy-id", false],
      ["move-to-section", true],
      ["mark-unread", true],
      ["mute", false],
      ["star", false],
      ["leave", true],
    ]);
  });

  it("DM 행 메뉴: 복사 │ 읽음·알림 │ 닫기. 나가기·섹션·별표는 없다", () => {
    const dm = channelActionAvailability({
      channel: channel({ kind: "dm", name: undefined }),
      selfRole: "owner",
      unreadCount: 1,
      sectionCount: 3,
      canStar: true,
      canCloseDm: true,
    });
    const items = channelActionItemsForSurface("row", dm, REST);
    expect(items.map((i) => [i.key, Boolean(i.separatorBefore)])).toEqual([
      ["copy-name", false],
      ["copy-link", false],
      ["copy-id", false],
      ["mark-read", true],
      ["mute", false],
      ["close-dm", true],
    ]);
    expect(items.find((i) => i.key === "close-dm")?.label).toBe("대화 닫기");
    // 닫기는 파괴적이지 않다(대화가 지워지지 않는다): 빨강 행이 아니다.
    expect(items.find((i) => i.key === "close-dm")?.tone).toBeUndefined();
  });

  it("두 표면이 같은 순서를 읽는다 — 겹치는 항목의 차례가 뒤집히지 않는다", () => {
    const header = keysOf(channelActionItemsForSurface("header", ALL, REST));
    const row = keysOf(channelActionItemsForSurface("row", ALL, REST));
    const shared = header.filter((key) => row.includes(key));
    expect(shared).toEqual(row.filter((key) => header.includes(key)));
    expect(shared.length).toBeGreaterThan(1);
  });

  it("걸러낸 뒤 맨 위 항목은 구분선을 이지 않는다", () => {
    const row = channelActionItemsForSurface("row", ALL, REST);
    expect(row[0].key).toBe("copy-name");
    expect(row[0].separatorBefore).toBeFalsy();
    // 헤더는 주제가 빠지면 알림이 맨 위가 된다. 거르기 **전**에 선을 정했다면 그 알림이
    // 선을 이고 섰을 자리다.
    const noTopic = channelActionItemsForSurface(
      "header",
      channelActionAvailability({
        channel: channel(),
        selfRole: "owner",
        unreadCount: 0,
      }),
      REST
    );
    expect(noTopic[0].key).toBe("mute");
    expect(noTopic[0].separatorBefore).toBeFalsy();
  });

  it("거른 뒤 이웃한 항목이 같은 무리면 선이 없고, 무리가 통째로 빠져도 선이 겹치지 않는다", () => {
    // 행 메뉴에서 읽음 처리가 빠져도(= 다 읽음) 복사 │ 알림 │ 나가기 로 선은 둘이다.
    const read = channelActionItemsForSurface(
      "row",
      channelActionAvailability({
        channel: channel(),
        selfRole: "owner",
        unreadCount: 0,
      }),
      REST
    );
    expect(keysOf(read)).toEqual(["copy-name", "copy-link", "copy-id", "mute", "leave"]);
    expect(read.filter((i) => i.separatorBefore).map((i) => i.key)).toEqual([
      "mute",
      "leave",
    ]);
  });

  it("DM 행에는 나가기가 없다", () => {
    const dm = channelActionItemsForSurface(
      "row",
      channelActionAvailability({
        channel: channel({ kind: "dm", name: undefined }),
        selfRole: "owner",
        unreadCount: 1,
      }),
      REST
    );
    expect(keysOf(dm)).toEqual([
      "copy-name",
      "copy-link",
      "copy-id",
      "mark-read",
      "mute",
    ]);
  });
});

describe("진행 낱말과 메뉴 이름 (design-review #1937)", () => {
  const ALL = channelActionAvailability({
    channel: channel({ topic: "배포 로그" }),
    selfRole: "owner",
    unreadCount: 2,
  });

  it("왕복이 있는 항목만 진행 낱말을 든다", () => {
    const busy = new Map(
      channelActionItems(ALL, REST).map((i) => [i.key, i.busyLabel])
    );
    expect(busy.get("mark-read")).toBe("읽음 처리 중");
    expect(busy.get("mute")).toBeUndefined();
    // 복사는 영수증이 낱말을 바꾸고, 다이얼로그 인계는 왕복이 아니다.
    expect(busy.get("copy-link")).toBeUndefined();
    expect(busy.get("copy-name")).toBeUndefined();
    expect(busy.get("copy-id")).toBeUndefined();
    expect(busy.get("topic")).toBeUndefined();
    expect(busy.get("leave")).toBeUndefined();
  });

  it("읽지 않음으로 표시도 왕복이라 진행 낱말을 든다 (#3963)", () => {
    const unread = channelActionItems(
      channelActionAvailability({
        channel: channel(),
        selfRole: "owner",
        unreadCount: 0,
        canMarkUnread: true,
      }),
      REST
    ).find((i) => i.key === "mark-unread");
    expect(unread?.label).toBe(CHANNEL_MARK_UNREAD_LABEL);
    expect(unread?.busyLabel).toBe("읽지 않음으로 표시 중");
  });

  it("알림은 두 상태의 이름과 아이콘만 쓰며 진행 낱말은 없다", () => {
    for (const muted of [false, true]) {
      const item = channelActionItems(ALL, { ...REST, muted }).find(i => i.key === "mute");
      expect(item?.label).toBe(muted ? "알림 꺼짐" : "알림 켜짐");
      expect(item?.icon).toBe(muted ? "🔕" : "🔔");
      expect(item?.busyLabel).toBeUndefined();
    }
  });

  it("메뉴 이름이 DM 을 「채널」이라 부르지 않는다", () => {
    expect(channelActionMenuLabel("이도현", { kind: "dm" })).toBe(
      "이도현 다이렉트 메시지 메뉴"
    );
    expect(channelActionMenuLabel("general", { kind: "public" })).toBe(
      "general 채널 메뉴"
    );
    expect(channelActionMenuLabel("비밀", { kind: "private" })).toContain("채널");
  });
});

describe("channelActionKeepsMenuOpen", () => {
  it("왕복과 영수증은 메뉴를 열어 둔다", () => {
    expect(channelActionKeepsMenuOpen("mute")).toBe(true);
    expect(channelActionKeepsMenuOpen("mark-read")).toBe(true);
    expect(channelActionKeepsMenuOpen("copy-link")).toBe(true);
    expect(channelActionKeepsMenuOpen("copy-name")).toBe(true);
  });

  it("다이얼로그로 넘기는 것은 메뉴를 닫는다", () => {
    expect(channelActionKeepsMenuOpen("leave")).toBe(false);
    expect(channelActionKeepsMenuOpen("topic")).toBe(false);
  });

  it("ID 복사는 영수증이 항목 자신의 낱말이라 열어 둔다 (#3963)", () => {
    expect(channelActionKeepsMenuOpen("copy-id")).toBe(true);
  });

  it("읽지 않음으로 표시는 실패 배너를 읽도록 열어 두고, DM 닫기는 행이 사라지므로 닫는다 (#3963)", () => {
    expect(channelActionKeepsMenuOpen("mark-unread")).toBe(true);
    // 닫는 순간 이 행과 메뉴를 이고 있던 트리거가 함께 언마운트된다 - 남기려 해도 남지 않는다.
    expect(channelActionKeepsMenuOpen("close-dm")).toBe(false);
  });
});

// =============================================================================
// 섹션 이동 — 예약해 둔 자리에 들어온 것 (ADR-0177 D4 / BT-4 #1932)
// =============================================================================

describe("섹션으로 이동", () => {
  const SECTIONS = [
    { id: "sec-1", label: "출시 준비" },
    { id: "sec-2", label: "읽은 것" },
  ];
  const WITH_SECTIONS: ChannelActionState = {
    ...REST,
    sections: SECTIONS,
    currentSectionId: "sec-1",
  };

  it("섹션이 없으면 어포던스도 없다", () => {
    const available = channelActionAvailability({
      channel: channel(),
      selfRole: "member",
      unreadCount: 0,
      sectionCount: 0,
    });
    expect(available.moveToSection).toBe(false);
    expect(
      channelActionItems(available, REST).map((item) => item.key)
    ).not.toContain("move-to-section");
  });

  it("DM 은 옮기지 않는다", () => {
    // 기본 섹션 두 종 중 DM 은 고정이다(ADR-0177 D4). 코어의 파생이 커스텀
    // 섹션의 DM id 를 무시하므로 문을 열면 눌러도 아무 일이 없는 항목이 된다.
    expect(
      channelActionAvailability({
        channel: channel({ kind: "dm", name: undefined }),
        selfRole: "member",
        unreadCount: 0,
        sectionCount: 3,
      }).moveToSection
    ).toBe(false);
  });

  it("행 메뉴에만 서고 헤더 ⋮ 에는 서지 않는다", () => {
    const available = channelActionAvailability({
      channel: channel(),
      selfRole: "member",
      unreadCount: 0,
      sectionCount: 2,
    });
    const rowKeys = channelActionItemsForSurface(
      "row",
      available,
      WITH_SECTIONS
    ).map((item) => item.key);
    const headerKeys = channelActionItemsForSurface(
      "header",
      available,
      WITH_SECTIONS
    ).map((item) => item.key);
    expect(rowKeys).toContain("move-to-section");
    // 채널을 열어 둔 사람에게 「이 채널을 어디에 둘까」는 다른 물음이다.
    expect(headerKeys).not.toContain("move-to-section");
  });

  it("항목이 목적지와 지금 자리를 함께 싣는다", () => {
    const available = channelActionAvailability({
      channel: channel(),
      selfRole: "member",
      unreadCount: 0,
      sectionCount: 2,
    });
    const move = channelActionItems(available, WITH_SECTIONS).find(
      (item) => item.key === "move-to-section"
    );
    expect(move?.label).toBe("섹션으로 이동");
    expect(move?.sections).toEqual(SECTIONS);
    expect(move?.currentSectionId).toBe("sec-1");
  });

  it("정본 차례에서 복사 다음, 상태 무리 앞에 선다", () => {
    // Buzz 의 차례다(#3963): 복사 │ 섹션 이동 │ 읽음·알림·별표. 앞 판은 상태 무리의 끝이었다.
    const available = channelActionAvailability({
      channel: channel({ topic: "출시 일정" }),
      selfRole: "owner",
      unreadCount: 3,
      sectionCount: 1,
    });
    expect(channelActionItems(available, WITH_SECTIONS).map((i) => i.key)).toEqual([
      "topic",
      "copy-name",
      "copy-link",
      "copy-id",
      "move-to-section",
      "mark-read",
      "mute",
      "leave",
    ]);
  });

  it("목적지를 고르면 메뉴가 닫힌다", () => {
    // 저장은 디바운스로 뒤따르므로(ADR-0177 D2 - 이벤트가 없어 기다릴 답이 없다)
    // 메뉴가 남아 봐야 방금 고른 답만 다시 보여 준다. 실패는 사이드바가 말한다.
    expect(channelActionKeepsMenuOpen("move-to-section")).toBe(false);
  });
});

describe("기억 설정 항목 (ADR-0196 D9, #3165)", () => {
  const base = { selfRole: "member" as const, unreadCount: 0 };

  it("서버가 팀 기억을 싣지 않으면 항목이 없다", () => {
    const off = channelActionAvailability({ channel: channel(), ...base });
    expect(off.memory).toBe(false);
    expect(keysOf(channelActionItemsForSurface("header", off, REST))).not.toContain("memory");
  });

  it("싣는 서버에서는 헤더 메뉴에만, 알림과 나가기 사이에 선다", () => {
    const on = channelActionAvailability({
      channel: channel({ topic: "결제 팀 공지" }),
      selfRole: "owner",
      unreadCount: 2,
      hasMemorySettings: true,
    });
    expect(keysOf(channelActionItemsForSurface("header", on, REST))).toEqual([
      "topic",
      "mute",
      "memory",
      "leave",
    ]);
    expect(keysOf(channelActionItemsForSurface("row", on, REST))).not.toContain("memory");
    const item = channelActionItemsForSurface("header", on, REST).find((i) => i.key === "memory");
    expect(item?.label).toBe("기억 설정");
    expect(item?.testKey).toBe("memory-settings");
  });

  it("DM에는 내놓지 않는다: 사람끼리의 DM은 요약에서 빠지는 게 기본이다", () => {
    const dm = channelActionAvailability({
      channel: channel({ kind: "dm" }),
      ...base,
      hasMemorySettings: true,
    });
    expect(dm.memory).toBe(false);
  });

  it("다이얼로그로 넘기는 항목이라 고르면 메뉴가 닫힌다", () => {
    expect(channelActionKeepsMenuOpen("memory")).toBe(false);
  });
});
