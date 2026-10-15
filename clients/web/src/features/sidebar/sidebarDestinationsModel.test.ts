import { describe, expect, it } from "vitest";
import { destinationActive } from "./sidebarDestinationsModel";
import { filterTeamSessions } from "./teamSessionsModel";
import type { SharedWorkSession } from "@momo/core/lib/api";

describe("목적지 선택 판정 (#3334, ADR-0202 D6)", () => {
  const only = (a: ReturnType<typeof destinationActive>) =>
    Object.entries(a)
      .filter(([, v]) => v)
      .map(([k]) => k);

  it.each([
    ["/", null, ["chat"]],
    ["/c/abc", null, ["chat"]],
    ["/inbox", null, ["inbox"]],
    ["/agents", null, ["agents"]],
    ["/ai", null, ["ai"]],
    ["/ai/accounts", null, ["ai"]],
    ["/ai/external", null, ["ai"]],
    ["/ai-connect", null, []],
    ["/directory", null, ["directory"]],
    // 숨긴 진입점의 옛 주소는 열리지만(라우트 유지) 어느 줄도 고르지 않는다.
    ["/activity", null, []],
    ["/workstreams", null, []],
    // 「작업」 한 줄: 「작업」 화면·터미널 격자·콘솔 모두 이 줄이다.
    ["/work", "jobs", ["work"]],
    ["/work", "terminals", ["work"]],
    ["/work", "console", ["work"]],
    ["/settings", null, []],
    ["/channels-archive", null, []],
  ] as const)("%s %s → %j", (path, view, expected) => {
    expect(only(destinationActive(path, view))).toEqual(expected);
  });
});

describe("팀 세션 거르기 (#3334)", () => {
  const item = (id: string, owner: string, state: SharedWorkSession["state"]) =>
    ({ sessionId: id, owner: { memberId: owner, displayName: owner }, state }) as unknown as SharedWorkSession;
  const items = [
    item("a", "me", "running"),
    item("b", "other", "waiting"),
    item("c", "me", "waiting"),
    item("d", "me", "done"),
  ];
  it("전체는 끝난 세션을 뺀다", () => {
    expect(filterTeamSessions(items, "all", "me").map((i) => i.sessionId)).toEqual(["a", "b", "c"]);
  });
  it("내 것은 내가 시작한 진행 중 세션만, 응답 필요는 waiting만", () => {
    expect(filterTeamSessions(items, "mine", "me").map((i) => i.sessionId)).toEqual(["a", "c"]);
    expect(filterTeamSessions(items, "waiting", "me").map((i) => i.sessionId)).toEqual(["b", "c"]);
  });
});
