import { describe, expect, it } from "vitest";
import {
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_READ_LABEL,
  CHANNEL_MUTE_LABEL,
  CHANNEL_TOPIC_VIEW_LABEL,
  CHANNEL_UNMUTE_LABEL,
} from "@momo/core/features/channels/model";
import {
  COPY_LINK_ACTION_LABEL,
  COPY_LINK_DONE_LABEL,
} from "@momo/core/features/timeline/copyLabels";
import type { Channel } from "@momo/core/lib/api";
import {
  channelActionAvailability,
  channelActionItems,
  channelActionItemsForSurface,
  channelActionKeepsMenuOpen,
  channelActionMenuLabel,
  type ChannelActionKey,
  type ChannelActionState,
} from "./channelActionModel";

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
    // 서버 remove_member 는 오너/관리자만 통과시킨다. 확인 다이얼로그 뒤의
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
  });
});

describe("channelActionItems", () => {
  const ALL = channelActionAvailability({
    channel: channel({ topic: "배포 로그" }),
    selfRole: "owner",
    unreadCount: 2,
  });

  it("정본 순서: 상태 → 꺼내기 → 파괴", () => {
    expect(keysOf(channelActionItems(ALL, REST))).toEqual([
      "topic",
      "mark-read",
      "mute",
      "copy-link",
      "copy-name",
      "leave",
    ]);
  });

  it("낱말이 상태다: 알림도 복사도 지금을 읽는다", () => {
    const idle = channelActionItems(ALL, REST);
    expect(idle.find((i) => i.key === "mute")?.label).toBe(CHANNEL_MUTE_LABEL);
    expect(idle.find((i) => i.key === "copy-link")?.label).toBe(
      COPY_LINK_ACTION_LABEL
    );

    const after = channelActionItems(ALL, {
      muted: true,
      copiedLink: true,
      copiedName: true,
    });
    expect(after.find((i) => i.key === "mute")?.label).toBe(CHANNEL_UNMUTE_LABEL);
    expect(after.find((i) => i.key === "copy-link")?.label).toBe(
      COPY_LINK_DONE_LABEL
    );
    expect(after.find((i) => i.key === "copy-name")?.label).toContain("복사됨");
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
    // 주제 → 상태 무리, 상태 → 꺼내기 무리, 꺼내기 → 파괴.
    expect(separated).toEqual(["mark-read", "copy-link", "leave"]);
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

  it("항목의 열쇠는 표면이 짓는 testid 의 절반이다", () => {
    // `channel-topic`·`channel-row-mark-read` 는 접두사 + testKey 다. 게이트가
    // 그 이름으로 누르므로 열쇠가 조용히 바뀌면 안 된다.
    expect(
      channelActionItemsForSurface("header", ALL, REST).map((i) => i.testKey)
    ).toEqual(["topic", "mute-toggle", "leave"]);
    expect(
      channelActionItemsForSurface("row", ALL, REST).map((i) => i.testKey)
    ).toEqual([
      "mark-read",
      "mute-toggle",
      "copy-link",
      "copy-name",
      "leave",
    ]);
  });

  it("행 우클릭은 「열지 않고 조작한다」만 든다", () => {
    expect(keysOf(channelActionItemsForSurface("row", ALL, REST))).toEqual([
      "mark-read",
      "mute",
      "copy-link",
      "copy-name",
      "leave",
    ]);
    expect(
      channelActionItemsForSurface("row", ALL, REST).find(
        (i) => i.key === "mark-read"
      )?.label
    ).toBe(CHANNEL_MARK_READ_LABEL);
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
    expect(row[0].key).toBe("mark-read");
    expect(row[0].separatorBefore).toBeFalsy();
    // 안 읽음이 없어 첫 항목이 알림으로 바뀌어도 마찬가지다.
    const read = channelActionItemsForSurface(
      "row",
      channelActionAvailability({
        channel: channel(),
        selfRole: "owner",
        unreadCount: 0,
      }),
      REST
    );
    expect(read[0].key).toBe("mute");
    expect(read[0].separatorBefore).toBeFalsy();
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
    expect(keysOf(dm)).toEqual(["mark-read", "mute", "copy-link", "copy-name"]);
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
    expect(busy.get("mute")).toBe("알림 끄는 중");
    // 복사는 영수증이 낱말을 바꾸고, 다이얼로그 인계는 왕복이 아니다.
    expect(busy.get("copy-link")).toBeUndefined();
    expect(busy.get("copy-name")).toBeUndefined();
    expect(busy.get("topic")).toBeUndefined();
    expect(busy.get("leave")).toBeUndefined();
  });

  it("진행 낱말도 방향을 지킨다", () => {
    const muted = channelActionItems(ALL, { ...REST, muted: true });
    expect(muted.find((i) => i.key === "mute")?.busyLabel).toBe("알림 켜는 중");
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

  it("정본 차례에서 상태 무리의 끝에 선다", () => {
    const available = channelActionAvailability({
      channel: channel({ topic: "출시 일정" }),
      selfRole: "owner",
      unreadCount: 3,
      sectionCount: 1,
    });
    expect(channelActionItems(available, WITH_SECTIONS).map((i) => i.key)).toEqual([
      "topic",
      "mark-read",
      "mute",
      "move-to-section",
      "copy-link",
      "copy-name",
      "leave",
    ]);
  });

  it("목적지를 고르면 메뉴가 닫힌다", () => {
    // 저장은 디바운스로 뒤따르므로(ADR-0177 D2 - 이벤트가 없어 기다릴 답이 없다)
    // 메뉴가 남아 봐야 방금 고른 답만 다시 보여 준다. 실패는 사이드바가 말한다.
    expect(channelActionKeepsMenuOpen("move-to-section")).toBe(false);
  });
});
