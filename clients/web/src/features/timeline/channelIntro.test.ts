import { describe, expect, it } from "vitest";
import {
  EMPTY_ADD_MEMBER_ACTION_LABEL,
  EMPTY_WRITE_ACTION_LABEL,
} from "@momo/core/features/timeline/model";
import {
  buildChannelIntro,
  CHANNEL_INTRO_STARTED,
  DM_INTRO_STARTED,
  shouldShowChannelIntro,
} from "./channelIntro";

const DM_DETAIL = "여기 쓴 메시지는 둘만 봅니다. 참여자는 이 둘로 고정됩니다.";

describe("shouldShowChannelIntro", () => {
  it("hides while the channel is still loading", () => {
    expect(
      shouldShowChannelIntro({
        status: "loading",
        reachedStart: true,
        messageCount: 0,
      })
    ).toBe(false);
  });

  it("shows on a ready empty channel even before reachedStart is known", () => {
    expect(
      shouldShowChannelIntro({
        status: "ready",
        reachedStart: false,
        messageCount: 0,
      })
    ).toBe(true);
  });

  it("hides mid-history while older pages are still loading", () => {
    expect(
      shouldShowChannelIntro({
        status: "ready",
        reachedStart: false,
        messageCount: 20,
      })
    ).toBe(false);
  });

  it("stays at the start of history once older pages are exhausted", () => {
    expect(
      shouldShowChannelIntro({
        status: "ready",
        reachedStart: true,
        messageCount: 20,
      })
    ).toBe(true);
  });
});

describe("buildChannelIntro", () => {
  it("titles a channel without a hash, quotes the topic, and offers write then add when empty", () => {
    const intro = buildChannelIntro({
      kind: "public",
      name: "엔진",
      topic: "  서버와 클라가 만나는 자리  ",
      peer: null,
      canAddMember: true,
      empty: true,
    });
    expect(intro.surface).toBe("channel");
    expect(intro.icon).toBe("hash");
    expect(intro.title).toBe("엔진");
    expect(intro.title.startsWith("#")).toBe(false);
    expect(intro.body).toBe("서버와 클라가 만나는 자리");
    expect(intro.actions.map((a) => a.kind)).toEqual(["write", "add-member"]);
    expect(intro.actions[0]?.label).toBe(EMPTY_WRITE_ACTION_LABEL);
    expect(intro.actions[1]?.label).toBe(EMPTY_ADD_MEMBER_ACTION_LABEL);
  });

  it("uses the lock glyph on a private channel and generic copy when there is no topic", () => {
    const intro = buildChannelIntro({
      kind: "private",
      name: "김인턴작업",
      peer: null,
      canAddMember: true,
      empty: true,
    });
    expect(intro.icon).toBe("lock");
    expect(intro.body).toContain("나중에 들어올");
    expect(intro.body).not.toMatch(/[—–]/);
  });

  it("hides the add-member card when the role cannot add", () => {
    const intro = buildChannelIntro({
      kind: "public",
      name: "general",
      peer: null,
      canAddMember: false,
      empty: true,
    });
    expect(intro.actions.map((a) => a.kind)).toEqual(["write"]);
  });

  it("drops actions and first-message copy once the channel has history", () => {
    const intro = buildChannelIntro({
      kind: "public",
      name: "general",
      peer: null,
      canAddMember: true,
      empty: false,
    });
    expect(intro.actions).toEqual([]);
    expect(intro.body).toBe(CHANNEL_INTRO_STARTED);
    expect(intro.body).not.toContain("첫");
    expect(intro.title).toBe("general");
  });

  it("keeps a topic as the known fact on a non-empty channel", () => {
    const intro = buildChannelIntro({
      kind: "public",
      name: "엔진",
      topic: "서버와 클라가 만나는 자리",
      peer: null,
      canAddMember: true,
      empty: false,
    });
    expect(intro.actions).toEqual([]);
    expect(intro.body).toBe("서버와 클라가 만나는 자리");
  });

  it("names a DM from channelName (handle included) and restores the DM contract", () => {
    const intro = buildChannelIntro({
      kind: "dm",
      name: "김인턴 @intern-kim",
      peer: { displayName: "김인턴", kind: "human" },
      canAddMember: true,
      empty: true,
    });
    expect(intro.surface).toBe("dm");
    expect(intro.icon).toBe("dm");
    expect(intro.title).toBe("김인턴 @intern-kim");
    expect(intro.title.startsWith("#")).toBe(false);
    expect(intro.isAgent).toBe(false);
    expect(intro.body).toContain("김인턴님과의 대화를 시작하세요.");
    expect(intro.body).toContain(DM_DETAIL);
    expect(intro.actions.map((a) => a.kind)).toEqual(["write"]);
  });

  it("frames an agent DM as work handed over and marks agent identity", () => {
    const intro = buildChannelIntro({
      kind: "dm",
      name: "김인턴 @kim-intern",
      peer: { displayName: "김인턴", kind: "agent" },
      canAddMember: false,
      empty: true,
    });
    expect(intro.title).toBe("김인턴 @kim-intern");
    expect(intro.isAgent).toBe(true);
    expect(intro.body).toContain("김인턴님에게 첫 일을 맡겨보세요.");
    expect(intro.body).toContain(DM_DETAIL);
  });

  it("drops first-message copy on a non-empty DM and keeps the contract", () => {
    const intro = buildChannelIntro({
      kind: "dm",
      name: "곽성재",
      peer: { displayName: "곽성재", kind: "human" },
      canAddMember: false,
      empty: false,
    });
    expect(intro.actions).toEqual([]);
    expect(intro.body).toContain(DM_INTRO_STARTED);
    expect(intro.body).toContain(DM_DETAIL);
    expect(intro.body).not.toContain("첫");
    expect(intro.body).not.toContain("시작하세요");
  });

  it("falls back to the header's unnamed-channel label, not a dead '이 채널'", () => {
    const intro = buildChannelIntro({
      kind: "public",
      name: "",
      peer: null,
      canAddMember: false,
      empty: true,
    });
    expect(intro.title).toBe("이름 없는 채널");
    expect(intro.title).not.toContain("이 채널");
  });
});
