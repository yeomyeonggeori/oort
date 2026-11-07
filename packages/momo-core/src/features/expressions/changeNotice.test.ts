import { describe, expect, it } from "vitest";
import { EXPRESSION_CONTRACTS, assertExpressionContract, matchesExpressionContract } from "./contracts";
import {
  EXPRESSION_NOTICE_MEMORY,
  createExpressionNoticeGate,
  decideExpressionChanged,
  readExpressionChangedVersion,
  decideExpressionDetail,
  emptyExpressionNoticeState,
  readExpressionChangeDetail,
} from "./changeNotice";
import { FIXTURE_EXPRESSIONS, FIXTURE_WORKSPACE_ID } from "./fixtures";
import { EXPRESSION_CHANGE_ACTIONS, EXPRESSION_CHANGE_MAX_IDS, type ExpressionChangedDetail } from "./types";

// ADR-0218 §15 (#5491). 두 가지를 값으로 잰다: ① 새 알림 `expression.changed.detail` 의 계약(닫힌 것은 닫고, 열 곳만 연다)과 옛 `Changed` 가 한 바이트도
// 바뀌지 않았다는 것, ② 알림 하나를 어떻게 처리하는가(그림을 내릴 id·그대로 둘지·건너뛸지)가 순서와 유실에 상관없이 안전한 쪽인가.

const [first, second] = FIXTURE_EXPRESSIONS;
const detail = (over: Partial<ExpressionChangedDetail> = {}): ExpressionChangedDetail => ({
  type: "expression.changed.detail",
  workspaceId: FIXTURE_WORKSPACE_ID,
  version: "4",
  action: "hidden",
  expressionIds: [first.id],
  ...over,
});

/** 계약이 바뀌기 전(v0.1.44)의 `Changed` 정의 그대로 — 옛 웹·데스크탑이 이 모양으로 알림을 엄격하게 읽는다(`additionalProperties: false`). */
const V1_CHANGED = {
  type: "object",
  additionalProperties: false,
  required: ["type", "workspaceId", "version"],
  properties: {
    type: { const: "expression.changed" },
    workspaceId: { type: "string", minLength: 36, maxLength: 36, pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
    version: { type: "string", minLength: 1, maxLength: 19, pattern: "^(0|[1-9][0-9]*)$" },
  },
};

describe("ADR-0218 §15 contract: ChangedDetail", () => {
  it("keeps the v1 `Changed` definition exactly as the old web and desktop read it", () => {
    expect(EXPRESSION_CONTRACTS.$defs.Changed).toEqual(V1_CHANGED);
    // 옛 판이 알림을 버리는 두 모양이 그대로다: 모르는 필드가 있어도, 다른 type 이어도 `Changed` 가 아니다.
    const v1 = { type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: "4" };
    assertExpressionContract("Changed", v1);
    expect(matchesExpressionContract("Changed", { ...v1, action: "created" })).toBe(false);
    expect(matchesExpressionContract("Changed", { ...v1, type: "expression.changed.detail" })).toBe(false);
  });

  it("accepts every action with the ids it needs", () => {
    for (const action of ["created", "edited", "hidden", "deleted"] as const) assertExpressionContract("ChangedDetail", detail({ action }));
    assertExpressionContract("ChangedDetail", detail({ action: "created", expressionIds: [first.id, second.id] }));
    assertExpressionContract("ChangedDetail", detail({ action: "policy_changed", expressionIds: [] }));
    expect([...EXPRESSION_CHANGE_ACTIONS]).toEqual(["created", "edited", "hidden", "deleted", "policy_changed"]);
    // 한 번의 세트 승인(§12 L4, 40칸)까지는 한 알림에 담긴다.
    const many = Array.from({ length: EXPRESSION_CHANGE_MAX_IDS }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    assertExpressionContract("ChangedDetail", detail({ action: "created", expressionIds: many }));
    expect(matchesExpressionContract("ChangedDetail", detail({ action: "created", expressionIds: [...many, first.id] }))).toBe(false);
  });

  it("is open to fields it does not know — a later addition must not make a client drop the notice (the v1 mistake)", () => {
    expect(matchesExpressionContract("ChangedDetail", { ...detail(), actorKind: "member", extra: { a: 1 } })).toBe(true);
  });

  it("refuses what a client could misread as a smaller change than it was", () => {
    const bad: Array<[string, unknown]> = [
      ["unknown action", detail({ action: "restored" as never })],
      ["hidden with no id", detail({ action: "hidden", expressionIds: [] })],
      ["deleted with no id", detail({ action: "deleted", expressionIds: [] })],
      ["created with no id", detail({ action: "created", expressionIds: [] })],
      ["policy with ids", detail({ action: "policy_changed", expressionIds: [first.id] })],
      ["duplicate ids", detail({ expressionIds: [first.id, first.id] })],
      ["upper-case id", detail({ expressionIds: [first.id.toUpperCase().replace(/^0/, "A")] })],
      ["not a uuid", detail({ expressionIds: ["x"] })],
      ["numeric version", detail({ version: 4 as never })],
      ["leading-zero version", detail({ version: "04" })],
      ["missing ids", (() => { const value: Record<string, unknown> = { ...detail() }; delete value.expressionIds; return value; })()],
      ["missing action", (() => { const value: Record<string, unknown> = { ...detail() }; delete value.action; return value; })()],
      ["other type", { ...detail(), type: "expression.changed" }],
      ["upper-case workspace", detail({ workspaceId: FIXTURE_WORKSPACE_ID.toUpperCase().replace(/^0/, "A") })],
      ["null", null],
      ["a string", "expression.changed.detail"],
    ];
    for (const [name, value] of bad) expect(matchesExpressionContract("ChangedDetail", value), name).toBe(false);
  });

  it("is not a `Changed`, and a `Changed` is not a detail — so the old readers drop the new notice and the new reader keeps the old one apart", () => {
    for (const action of EXPRESSION_CHANGE_ACTIONS) {
      const value = detail({ action, expressionIds: action === "policy_changed" ? [] : [first.id] });
      // 옛 웹·데스크탑(`matchesExpressionContract("Changed", data)`)은 이 프레임을 알림으로 읽지 않는다.
      expect(matchesExpressionContract("Changed", value), action).toBe(false);
      // 옛 폰(`frame.type === "expression.changed"`)도 같다.
      expect((value.type as string) === "expression.changed", action).toBe(false);
    }
    expect(matchesExpressionContract("ChangedDetail", { type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: "4" })).toBe(false);
  });
});

describe("ADR-0218 §15 reading a plain notice's version", () => {
  it("returns the version only for a frame that matches the old contract exactly", () => {
    expect(readExpressionChangedVersion({ type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: "4" })).toBe("4");
    expect(readExpressionChangedVersion({ type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID })).toBeNull();
    expect(readExpressionChangedVersion({ type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: 4 })).toBeNull();
    expect(readExpressionChangedVersion({ type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: "4", extra: 1 })).toBeNull();
    expect(readExpressionChangedVersion(detail())).toBeNull();
    expect(readExpressionChangedVersion(null)).toBeNull();
  });
});

describe("ADR-0218 §15 reading a detail frame", () => {
  it("returns the detail only for this workspace and only when it matches the contract", () => {
    expect(readExpressionChangeDetail(FIXTURE_WORKSPACE_ID, detail())).toEqual(detail());
    expect(readExpressionChangeDetail(FIXTURE_WORKSPACE_ID.toUpperCase(), detail())).toEqual(detail()); // 방 이름은 대문자다
    expect(readExpressionChangeDetail("00000000-0000-4000-8000-0000000000aa", detail())).toBeNull();
    expect(readExpressionChangeDetail(FIXTURE_WORKSPACE_ID, detail({ action: "hidden", expressionIds: [] }))).toBeNull();
    expect(readExpressionChangeDetail(FIXTURE_WORKSPACE_ID, { type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: "4" })).toBeNull();
    expect(readExpressionChangeDetail(FIXTURE_WORKSPACE_ID, undefined)).toBeNull();
  });
});

describe("ADR-0218 §15 decision: which pictures a notice takes down", () => {
  const act = (action: ExpressionChangedDetail["action"], ids: string[]) => decideExpressionDetail(emptyExpressionNoticeState, detail({ action, expressionIds: ids })).verdict;

  it("hidden and deleted take down exactly the named ids", () => {
    expect(act("hidden", [first.id])).toEqual({ kind: "revoke-ids", ids: [first.id] });
    expect(act("deleted", [first.id, second.id])).toEqual({ kind: "revoke-ids", ids: [first.id, second.id] });
  });

  it("created, edited and a policy change take nothing down", () => {
    expect(act("created", [first.id])).toEqual({ kind: "keep-all" });
    expect(act("edited", [first.id])).toEqual({ kind: "keep-all" });
    expect(act("policy_changed", [])).toEqual({ kind: "keep-all" });
  });

  it("a hide or delete that names nothing falls back to taking everything down (never to keeping)", () => {
    expect(act("hidden", [])).toEqual({ kind: "revoke-all" });
    expect(act("deleted", [])).toEqual({ kind: "revoke-all" });
  });

  it("a plain notice with no detail before it takes everything down — today's behaviour", () => {
    expect(decideExpressionChanged(emptyExpressionNoticeState, "4").verdict).toEqual({ kind: "revoke-all" });
    expect(decideExpressionChanged(emptyExpressionNoticeState, null).verdict).toEqual({ kind: "revoke-all" });
  });

  it("a detail takes the plain notice of the same version out of the way, in either order", () => {
    // 상세 → v1: v1 은 건너뛴다(그림을 전부 내리지 않는다).
    const gate = createExpressionNoticeGate();
    expect(gate.detail(detail({ action: "created", version: "9" }))).toEqual({ kind: "keep-all" });
    expect(gate.changed("9")).toEqual({ kind: "already-handled" });
    // v1 → 상세: v1 이 이미 전부 내렸으니 뒤늦은 등록·고치기·정책 상세는 할 일이 없다(숨김·삭제 상세는 아래 시험이 따로 잰다).
    const late = createExpressionNoticeGate();
    expect(late.changed("10")).toEqual({ kind: "revoke-all" });
    expect(late.detail(detail({ action: "created", version: "10" }))).toEqual({ kind: "already-handled" });
  });

  it("a hide or delete detail is never skipped, even after the plain notice of its version — it names the ids the plain notice could not (#5491 review 1, H-5491-1)", () => {
    for (const action of ["hidden", "deleted"] as const) {
      const gate = createExpressionNoticeGate();
      expect(gate.changed("10")).toEqual({ kind: "revoke-all" });
      expect(gate.detail(detail({ action, version: "10" })), action).toEqual({ kind: "revoke-ids", ids: [first.id] });
      // 두 번 걷어도 안전하다: 같은 상세가 다시 와도 같은 판정이다.
      expect(gate.detail(detail({ action, version: "10" })), action).toEqual({ kind: "revoke-ids", ids: [first.id] });
    }
    // 건너뛰는 것은 등록·고치기·정책 상세뿐이다.
    const gate = createExpressionNoticeGate();
    gate.changed("11");
    for (const action of ["created", "edited"] as const) expect(gate.detail(detail({ action, version: "11" })), action).toEqual({ kind: "already-handled" });
    expect(gate.detail(detail({ action: "policy_changed", expressionIds: [], version: "11" }))).toEqual({ kind: "already-handled" });
    // 같은 version 을 기억에 두 번 적지 않는다.
    const once = decideExpressionDetail(emptyExpressionNoticeState, detail({ version: "12" }));
    expect(decideExpressionDetail(once.state, detail({ version: "12" })).state.handled).toEqual(["12"]);
  });

  it("only the same version is skipped: a plain notice of another version, or with a version it cannot read, still takes everything down", () => {
    const gate = createExpressionNoticeGate();
    gate.detail(detail({ action: "created", version: "9" }));
    expect(gate.changed("10")).toEqual({ kind: "revoke-all" });
    expect(gate.changed(null)).toEqual({ kind: "revoke-all" });
    expect(gate.changed(null)).toEqual({ kind: "revoke-all" }); // 읽을 수 없는 판은 기억하지 않는다
  });

  it("a detail that was lost leaves the plain notice to take everything down; a duplicate registration detail is skipped", () => {
    const gate = createExpressionNoticeGate();
    expect(gate.changed("11")).toEqual({ kind: "revoke-all" });
    const other = createExpressionNoticeGate();
    expect(other.detail(detail({ action: "created", version: "12" })).kind).toBe("keep-all");
    expect(other.detail(detail({ action: "created", version: "12" }))).toEqual({ kind: "already-handled" });
  });

  it("two changes whose notices interleave still pair up by version", () => {
    const gate = createExpressionNoticeGate();
    expect(gate.detail(detail({ action: "created", version: "20" }))).toEqual({ kind: "keep-all" });
    expect(gate.detail(detail({ action: "hidden", version: "21" })).kind).toBe("revoke-ids");
    expect(gate.changed("20")).toEqual({ kind: "already-handled" });
    expect(gate.changed("21")).toEqual({ kind: "already-handled" });
  });

  it("a fresh subscription starts over: a version seen before the gap says nothing about after it", () => {
    const gate = createExpressionNoticeGate();
    gate.detail(detail({ version: "30" }));
    gate.reset();
    expect(gate.changed("30")).toEqual({ kind: "revoke-all" });
    expect(gate.detail(detail({ version: "30", action: "created" }))).toEqual({ kind: "already-handled" }); // v1 이 이미 했다
  });

  it("remembers a bounded number of versions", () => {
    let state = emptyExpressionNoticeState;
    for (let version = 1; version <= EXPRESSION_NOTICE_MEMORY + 5; version += 1) state = decideExpressionChanged(state, String(version)).state;
    expect(state.handled).toHaveLength(EXPRESSION_NOTICE_MEMORY);
    expect(decideExpressionChanged(state, "1").verdict).toEqual({ kind: "revoke-all" }); // 밀려난 판은 건너뛰지 않는다(안전한 쪽)
    expect(decideExpressionChanged(state, String(EXPRESSION_NOTICE_MEMORY + 5)).verdict).toEqual({ kind: "already-handled" });
  });
});
