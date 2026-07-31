import { describe, expect, it } from "vitest";
import { ApiError, uuidEq, type Channel, type RosterMember } from "@/lib/api";
import { NetworkError } from "@/lib/http";
import {
  countLabel,
  dmAvailability,
  groupDirectory,
  hasOtherMembers,
  matchesQuery,
  memberRowLabel,
  normalizeQuery,
  openDmErrorMessage,
  roleLabel,
  statusLabel,
  switcherPeople,
  upsertChannel,
} from "./model";

// Real momowebqa shapes, including the pair this workspace actually has: two
// members displayed as 김인턴, one human and one agent, told apart only by the
// handle. Ids are the demo workspace's, in the case the server sends them.
const WS = "00000000-0000-7000-8000-000000000001";

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이름",
    handle: "handle",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const DEMO = member({
  id: "00000000-0000-7000-8000-000000000101",
  displayName: "데모 사용자",
  handle: "demo",
  role: "owner",
});
const SEONGJAE = member({
  id: "00000000-0000-7000-8000-0000000005d1",
  displayName: "곽성재",
  handle: "seongjae",
  role: "admin",
});
const INTERN_HUMAN = member({
  id: "00000000-0000-7000-8000-0000000005d2",
  displayName: "김인턴",
  handle: "intern-kim",
  role: "member",
});
const INTERN_AGENT = member({
  id: "00000000-0000-7000-8000-000000000102",
  displayName: "김인턴",
  handle: "kim-intern",
  kind: "agent",
  role: "member",
  ownerHumanId: DEMO.id,
});
const HERMES = member({
  id: "00000000-0000-7000-8000-000000000103",
  displayName: "Hermes",
  handle: "hermes",
  kind: "agent",
  role: "member",
  ownerHumanId: DEMO.id,
});

const ROSTER = [HERMES, INTERN_AGENT, DEMO, INTERN_HUMAN, SEONGJAE];

describe("roleLabel", () => {
  it("names the human workspace role in Korean", () => {
    expect(roleLabel(DEMO)).toBe("소유자");
    expect(roleLabel(SEONGJAE)).toBe("관리자");
    expect(roleLabel(INTERN_HUMAN)).toBe("멤버");
    expect(roleLabel(member({ id: "g", role: "guest" }))).toBe("게스트");
  });

  it("says nothing when the roster row carries no role", () => {
    expect(roleLabel(member({ id: "x" }))).toBeNull();
  });

  it("leaves agents unlabelled: the 에이전트 section already says it", () => {
    expect(roleLabel(HERMES)).toBeNull();
    expect(roleLabel(INTERN_AGENT)).toBeNull();
  });
});

describe("statusLabel", () => {
  it("labels only the statuses worth saying", () => {
    expect(statusLabel(DEMO)).toBeNull();
    expect(statusLabel(member({ id: "a", status: "invited" }))).toBe("초대됨");
    expect(statusLabel(member({ id: "b", status: "suspended" }))).toBe("정지됨");
    expect(statusLabel(member({ id: "c", status: "deleted" }))).toBe("삭제됨");
  });
});

describe("normalizeQuery / matchesQuery", () => {
  it("trims and lowercases once", () => {
    expect(normalizeQuery("  Hermes  ")).toBe("hermes");
    expect(normalizeQuery("   ")).toBe("");
  });

  it("matches everything on an empty query", () => {
    expect(matchesQuery(DEMO, "")).toBe(true);
  });

  it("matches a partial display name", () => {
    expect(matchesQuery(SEONGJAE, "성재")).toBe(true);
    expect(matchesQuery(SEONGJAE, "곽")).toBe(true);
    expect(matchesQuery(SEONGJAE, "인턴")).toBe(false);
  });

  it("matches the handle case-insensitively, which is what separates the two 김인턴", () => {
    expect(matchesQuery(INTERN_HUMAN, "intern-kim")).toBe(true);
    expect(matchesQuery(INTERN_AGENT, "intern-kim")).toBe(false);
    expect(matchesQuery(INTERN_AGENT, "KIM-INTERN")).toBe(true);
    expect(matchesQuery(HERMES, "HERM")).toBe(true);
  });
});

describe("groupDirectory", () => {
  it("splits humans from agents and orders each by name", () => {
    const groups = groupDirectory(ROSTER, "");
    // 곽 → 김 → 데, Korean collation, not code points.
    expect(groups.people.map((m) => m.handle)).toEqual([
      "seongjae",
      "intern-kim",
      "demo",
    ]);
    // `ko` collation puts Hangul ahead of Latin, so 김인턴 precedes Hermes.
    expect(groups.agents.map((m) => m.handle)).toEqual([
      "kim-intern",
      "hermes",
    ]);
    expect(groups.matched).toBe(5);
    expect(groups.total).toBe(5);
  });

  it("keeps both 김인턴 rows and separates them by kind", () => {
    const groups = groupDirectory(ROSTER, "김인턴");
    expect(groups.people.map((m) => m.handle)).toEqual(["intern-kim"]);
    expect(groups.agents.map((m) => m.handle)).toEqual(["kim-intern"]);
    expect(groups.matched).toBe(2);
    expect(groups.total).toBe(5);
  });

  it("reports a miss without losing the roster size", () => {
    const groups = groupDirectory(ROSTER, "없는사람");
    expect(groups.matched).toBe(0);
    expect(groups.total).toBe(5);
    expect(groups.people).toEqual([]);
    expect(groups.agents).toEqual([]);
  });

  it("does not mutate the roster it was handed", () => {
    const input = [...ROSTER];
    groupDirectory(input, "");
    expect(input).toEqual(ROSTER);
  });
});

describe("countLabel", () => {
  const LOADED = { pending: false, failed: false };

  it("reports the roster split, not an invented metric", () => {
    expect(countLabel(groupDirectory(ROSTER, ""), LOADED)).toBe(
      "사람 3 · 에이전트 2"
    );
    expect(countLabel(groupDirectory([], ""), LOADED)).toBe(
      "사람 0 · 에이전트 0"
    );
  });

  it("counts what the search left on screen, not the roster behind it", () => {
    expect(countLabel(groupDirectory(ROSTER, "김인턴"), LOADED)).toBe(
      "사람 1 · 에이전트 1"
    );
  });

  it("says nothing while the roster is still being fetched", () => {
    // The list is a skeleton at this moment; a header counting to zero beside
    // it would be the screen answering a question it has not heard back on.
    expect(
      countLabel(groupDirectory([], ""), { pending: true, failed: false })
    ).toBeNull();
  });

  it("says nothing when the roster failed to load", () => {
    // The list says 명부를 불러오지 못했습니다. "사람 0 · 에이전트 0" beside it
    // is not a smaller truth, it is a contradicting claim.
    expect(
      countLabel(groupDirectory([], ""), { pending: false, failed: true })
    ).toBeNull();
  });

  it("keeps counting a roster already in hand through a refresh or its failure", () => {
    // Cached members keep rendering (P15), so the number beside them is still
    // the number on screen.
    for (const state of [
      { pending: true, failed: false },
      { pending: false, failed: true },
    ]) {
      expect(countLabel(groupDirectory(ROSTER, ""), state)).toBe(
        "사람 3 · 에이전트 2"
      );
    }
  });
});

describe("memberRowLabel", () => {
  it("names the human, the handle and the workspace role before the action", () => {
    expect(memberRowLabel(SEONGJAE, null)).toBe(
      "곽성재 @seongjae, 관리자, 다이렉트 메시지 열기"
    );
  });

  it("gives the two 김인턴 two different accessible names", () => {
    // The whole point: aria-label replaces the subtree, so a label of the
    // display name alone would offer a screen reader the same action twice.
    const human = memberRowLabel(INTERN_HUMAN, null);
    const agent = memberRowLabel(INTERN_AGENT, DEMO.displayName);
    expect(human).not.toBe(agent);
    expect(human).toContain("@intern-kim");
    expect(agent).toContain("@kim-intern");
  });

  it("says an agent is an agent and who it is attributed to", () => {
    // Colour (--agent) reaches no screen reader, and "managed by 데모 사용자" is
    // on screen, so both are in the name (WCAG 2.5.3).
    expect(memberRowLabel(INTERN_AGENT, DEMO.displayName)).toBe(
      "김인턴 @kim-intern, 에이전트, managed by 데모 사용자, 다이렉트 메시지 열기"
    );
  });

  it("still says 에이전트 when the roster has no row for the owner", () => {
    expect(memberRowLabel(HERMES, null)).toBe(
      "Hermes @hermes, 에이전트, 다이렉트 메시지 열기"
    );
  });

  it("carries a status the row shows beside the name", () => {
    const invited = member({
      id: "00000000-0000-7000-8000-0000000009a3",
      displayName: "이서연",
      handle: "seoyeon",
      role: "member",
      status: "invited",
    });
    expect(memberRowLabel(invited, null)).toBe(
      "이서연 @seoyeon, 멤버, 초대됨, 다이렉트 메시지 열기"
    );
  });

  it("ends with the action, so the row reads as a thing then a verb", () => {
    for (const m of ROSTER) {
      expect(memberRowLabel(m, DEMO.displayName)).toMatch(
        /, 다이렉트 메시지 열기$/
      );
    }
  });
});

describe("hasOtherMembers", () => {
  it("is false for an empty roster and for a roster of only me", () => {
    expect(hasOtherMembers([], DEMO.id)).toBe(false);
    expect(hasOtherMembers([DEMO], DEMO.id)).toBe(false);
  });

  it("ignores uuid case when deciding who is me", () => {
    expect(hasOtherMembers([member({ id: DEMO.id.toUpperCase() })], DEMO.id)).toBe(
      false
    );
  });

  it("is true as soon as anyone else is listed, agents included", () => {
    expect(hasOtherMembers([DEMO, HERMES], DEMO.id)).toBe(true);
  });
});

describe("dmAvailability", () => {
  it("refuses a DM with yourself", () => {
    expect(dmAvailability(DEMO, DEMO.id)).toEqual({ kind: "self" });
  });

  it("recognises yourself through mixed-case uuids", () => {
    expect(dmAvailability(DEMO, DEMO.id.toUpperCase())).toEqual({
      kind: "self",
    });
    expect(
      dmAvailability(member({ ...DEMO, id: DEMO.id.toUpperCase() }), DEMO.id)
    ).toEqual({ kind: "self" });
  });

  it("offers a DM to any other active member, agent or human", () => {
    expect(dmAvailability(HERMES, DEMO.id)).toEqual({ kind: "ready" });
    expect(dmAvailability(SEONGJAE, DEMO.id)).toEqual({ kind: "ready" });
  });

  it("states why an inactive member cannot be a DM target", () => {
    expect(
      dmAvailability(member({ id: "z", status: "invited" }), DEMO.id)
    ).toEqual({ kind: "inactive", label: "초대됨" });
  });
});

describe("switcherPeople", () => {
  const INVITED = member({
    id: "00000000-0000-7000-8000-0000000009a1",
    displayName: "이서연",
    handle: "seoyeon",
    role: "member",
    status: "invited",
  });
  const SUSPENDED = member({
    id: "00000000-0000-7000-8000-0000000009a2",
    displayName: "최민우",
    handle: "minwoo",
    role: "member",
    status: "suspended",
  });

  it("drops only yourself, ignoring uuid case", () => {
    const rows = switcherPeople(ROSTER, DEMO.id.toUpperCase());
    expect(rows.map((r) => r.member.handle)).toEqual([
      "hermes",
      "kim-intern",
      "intern-kim",
      "seongjae",
    ]);
  });

  it("offers every active member, agents included", () => {
    const rows = switcherPeople([HERMES, SEONGJAE], DEMO.id);
    expect(rows.every((r) => r.selectable)).toBe(true);
    expect(rows.every((r) => r.reason === null)).toBe(true);
  });

  it("drops a member the palette already lists as a DM row, uuid case aside", () => {
    // The DM row above IS this conversation, so a second row under 사람 would
    // offer one destination twice (and pay a POST to learn what it knew).
    const rows = switcherPeople(ROSTER, DEMO.id, [
      INTERN_AGENT.id.toUpperCase(),
      SEONGJAE.id,
    ]);
    expect(rows.map((r) => r.member.handle)).toEqual(["hermes", "intern-kim"]);
  });

  it("keeps an inactive member visible but unselectable, with the reason", () => {
    const rows = switcherPeople([INVITED, SUSPENDED], DEMO.id);
    expect(rows).toEqual([
      { member: INVITED, selectable: false, reason: "초대됨" },
      { member: SUSPENDED, selectable: false, reason: "정지됨" },
    ]);
  });

  it("agrees with the directory row on every member of the roster", () => {
    // The whole point of this helper: one rule, two surfaces. Whatever the row
    // renders as a plain non-button, the palette must render unselectable.
    const roster = [...ROSTER, INVITED, SUSPENDED];
    for (const m of roster) {
      const availability = dmAvailability(m, DEMO.id);
      const row = switcherPeople(roster, DEMO.id).find((r) =>
        uuidEq(r.member.id, m.id)
      );
      if (availability.kind === "self") {
        expect(row).toBeUndefined();
        continue;
      }
      expect(row?.selectable).toBe(availability.kind === "ready");
    }
  });

  it("does not mutate or reorder the roster it was handed", () => {
    const input = [...ROSTER];
    switcherPeople(input, DEMO.id);
    expect(input).toEqual(ROSTER);
  });
});

describe("upsertChannel", () => {
  const dm: Channel = {
    id: "019f984d-b4a8-76fd-8fba-3b6e3390072d",
    workspaceId: WS,
    kind: "dm",
    memberIds: [DEMO.id, INTERN_AGENT.id],
    muted: false,
  };

  it("appends a channel the cache has never seen", () => {
    expect(upsertChannel([], dm)).toEqual([dm]);
  });

  it("replaces the existing row when the server answers in another case", () => {
    const cached: Channel = { ...dm, id: dm.id.toUpperCase(), muted: true };
    const merged = upsertChannel([cached], dm);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(dm);
  });

  it("leaves the other channels alone and does not mutate the input", () => {
    const general: Channel = {
      id: "00000000-0000-7000-8000-000000000201",
      workspaceId: WS,
      kind: "public",
      name: "general",
      muted: false,
    };
    const input = [general];
    const merged = upsertChannel(input, dm);
    expect(merged).toEqual([general, dm]);
    expect(input).toEqual([general]);
  });
});

describe("openDmErrorMessage", () => {
  it("says who is missing and what to do about it", () => {
    expect(openDmErrorMessage(new ApiError(404, "not found"), "곽성재")).toBe(
      "곽성재님은 이 워크스페이스의 활성 멤버가 아닙니다. 명부를 새로 고친 뒤 다시 시도하세요."
    );
  });

  it("separates a refusal from a rate limit", () => {
    expect(openDmErrorMessage(new ApiError(403, "no"), "곽성재")).toContain(
      "권한이 없습니다"
    );
    expect(openDmErrorMessage(new ApiError(429, "slow"), "곽성재")).toContain(
      "잠시 뒤에 다시 시도"
    );
    expect(openDmErrorMessage(new ApiError(400, "self"), "곽성재")).toContain(
      "자기 자신과는"
    );
  });

  it("does not report a dead network as a server refusal", () => {
    const message = openDmErrorMessage(
      new NetworkError("timeout", 15_000),
      "Hermes"
    );
    expect(message).toContain("Hermes님과의 대화를 열지 못했습니다");
    // The transport's own measured copy, deadline included, not a second one.
    expect(message).toContain("15초 안에 응답하지 않았습니다");
  });

  it("still says what failed and what to do for an unknown error", () => {
    expect(openDmErrorMessage(new Error("boom"), "Hermes")).toBe(
      "Hermes님과의 다이렉트 메시지를 열지 못했습니다. 다시 시도하세요."
    );
  });

  it("never apologises and never says 알 수 없는", () => {
    for (const error of [
      new ApiError(500, "x"),
      new NetworkError("unreachable", 15_000),
      new Error("x"),
    ]) {
      const message = openDmErrorMessage(error, "곽성재");
      expect(message).not.toContain("죄송");
      expect(message).not.toContain("알 수 없");
    }
  });
});
