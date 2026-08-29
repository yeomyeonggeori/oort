import { describe, expect, it } from "vitest";
import {
  EMPTY_ADD_MEMBER_ACTION_LABEL,
  EMPTY_WRITE_ACTION_LABEL,
} from "@momo/core/features/timeline/model";
import {
  buildChannelIntro,
  channelIntroMeta,
  shouldShowChannelIntro,
} from "./channelIntro";

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
  it("titles a channel with a hash, quotes the topic, and offers write then add", () => {
    const intro = buildChannelIntro({
      kind: "public",
      name: "엔진",
      topic: "  서버와 클라가 만나는 자리  ",
      peer: null,
      canAddMember: true,
    });
    expect(intro.surface).toBe("channel");
    expect(intro.icon).toBe("hash");
    expect(intro.title).toBe("#엔진");
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
    });
    expect(intro.actions.map((a) => a.kind)).toEqual(["write"]);
  });

  it("names a DM after the peer and never offers add-member", () => {
    const intro = buildChannelIntro({
      kind: "dm",
      name: "unused",
      peer: { displayName: "곽성재", kind: "human" },
      canAddMember: true,
    });
    expect(intro.surface).toBe("dm");
    expect(intro.icon).toBe("dm");
    expect(intro.title).toBe("곽성재");
    expect(intro.title.startsWith("#")).toBe(false);
    expect(intro.body).toBe("곽성재님과의 대화를 시작하세요.");
    expect(intro.actions.map((a) => a.kind)).toEqual(["write"]);
  });

  it("frames an agent DM as work handed over", () => {
    const intro = buildChannelIntro({
      kind: "dm",
      name: "",
      peer: { displayName: "김인턴", kind: "agent" },
      canAddMember: false,
    });
    expect(intro.title).toBe("김인턴");
    expect(intro.body).toBe("김인턴님에게 첫 일을 맡겨보세요.");
  });

  it("does not invent a created line the client does not have", () => {
    expect(channelIntroMeta(undefined, undefined)).toBeNull();
    expect(channelIntroMeta(undefined, "  ")).toBeNull();
    expect(channelIntroMeta(new Date(2026, 2, 12).getTime(), "곽성재")).toBe(
      "곽성재님이 2026.03.12에 만들었습니다."
    );
  });
});
