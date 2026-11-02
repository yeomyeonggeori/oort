import { describe, expect, it } from "vitest";
import type { AdeItem } from "./adeControl";
import { adeItemLanding } from "./adeLanding";

const base: AdeItem = {
  key: "k",
  kind: "run",
  state: "working",
  durability: "unknown",
  channelId: "c1",
  title: "김인턴",
  detail: "",
};

describe("adeItemLanding (#5193)", () => {
  it("턴은 작업 패널로 간다: run id·에이전트·채널과 서랍과 같은 origin, 시작 시각은 있을 때만", () => {
    const turn = { ...base, runId: "r1", memberId: "m1" };
    expect(adeItemLanding(turn)).toEqual({
      panel: { runId: "r1", memberId: "m1", channelId: "c1", origin: "ade" },
    });
    expect(adeItemLanding({ ...turn, startedAtMs: 1234 })).toEqual({
      panel: { runId: "r1", memberId: "m1", channelId: "c1", origin: "ade", startedAtMs: 1234 },
    });
  });

  it("세션은 채널과 세션 id로 간다(주소는 호출한 쪽이 짓는다)", () => {
    const session: AdeItem = { ...base, kind: "session", sessionId: "s1" };
    expect(adeItemLanding(session)).toEqual({ session: { channelId: "c1", sessionId: "s1" } });
  });

  it("갈 곳이 없는 카드는 null이다: run id나 에이전트가 빠진 턴, id 없는 세션", () => {
    expect(adeItemLanding({ ...base, runId: "r1" })).toBeNull();
    expect(adeItemLanding({ ...base, memberId: "m1" })).toBeNull();
    expect(adeItemLanding(base)).toBeNull();
    expect(adeItemLanding({ ...base, kind: "session" })).toBeNull();
  });
});
