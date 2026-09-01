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
