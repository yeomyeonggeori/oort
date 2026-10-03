import { describe, expect, it } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { agentTableRows, createKindOptions, rosterStatusView } from "./aiAgentsModel";

const WS = "w1";
const ME = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000102";

const agent = (id: string, name: string, extra: Partial<RosterMember> = {}): RosterMember => ({
  id, workspaceId: WS, kind: "agent", status: "active", displayName: name, handle: name,
  channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, paused: false, ...extra,
});

const MEMBERS: RosterMember[] = [
  agent("a-team", "김인턴", { brain: "team_key", callableBy: "everyone" }),
  agent("a-mine", "성재-codex", { brain: "subscription", callableBy: "owner_only", ownerHumanId: ME, owner: { id: ME, displayName: "성재" }, hostOnline: true }),
  agent("a-other", "서연-codex", { brain: "subscription", callableBy: "owner_only", ownerHumanId: OTHER, owner: { id: OTHER, displayName: "서연" }, hostOnline: false }),
  agent("a-key", "성재-키", { brain: "personal_key", callableBy: "owner_only", ownerHumanId: ME, owner: { id: ME, displayName: "성재" } }),
  agent("a-paused", "성재-claude", { brain: "subscription", callableBy: "owner_only", ownerHumanId: ME, owner: { id: ME, displayName: "성재" }, hostOnline: true, brainUnavailableReason: "claude_subscription_agent_paused" }),
  agent("a-ext", "hermes", { brain: "external", callableBy: "everyone" }),
];
const by = (rows: ReturnType<typeof agentTableRows>, handle: string) => {
  const row = rows.find((r) => r.handle === handle);
  if (!row) throw new Error(`no row ${handle}`);
  return row;
};

describe("에이전트 표 행: 서버 값 → core 라벨", () => {
  const rows = agentTableRows(MEMBERS, [], ME);

  it("팀 키는 누구나 · 팀 비용", () => {
    const r = by(rows, "김인턴");
    expect([r.labels.brain, r.labels.callable, r.labels.cost]).toEqual(["팀 AI 키", "누구나", "팀"]);
    expect(r.status).toMatchObject({ label: "활성", tone: "ok" });
  });

  it("내 구독은 나만 · 내 구독 비용 · 내 맥 켜짐", () => {
    const r = by(rows, "성재-codex");
    expect([r.labels.brain, r.labels.callable, r.labels.cost]).toEqual(["내 구독", "나만", "내 구독"]);
    expect(r.status).toMatchObject({ label: "내 맥 켜짐", tone: "ok" });
    expect(r.labels.lockedForViewer).toBe(false);
  });

  it("남의 구독은 소유자 이름으로 잠기고 맥 꺼짐은 팀 키 대신 답하지 않는다고 말한다", () => {
    const r = by(rows, "서연-codex");
    expect([r.labels.brain, r.labels.callable, r.labels.cost]).toEqual(["개인 구독", "서연 님만", "서연 님 구독"]);
    expect(r.labels.lockedForViewer).toBe(true);
    expect(r.status).toMatchObject({ label: "맥 꺼짐", tone: "warn" });
    expect(r.status?.detail).toContain("팀 키로 대신하지 않아요");
  });

  it("개인 키는 「개인 키 · 나만」이지 구독이 아니다", () => {
    const r = by(rows, "성재-키");
    expect([r.labels.brain, r.labels.callable, r.labels.cost]).toEqual(["개인 키", "나만", "개인 키"]);
    expect(r.labels.mentionLine).toBe("개인 키 · 나만");
    expect(r.status).toMatchObject({ label: "활성" });
  });

  it("Claude 구독 대행이 꺼진 에이전트는 회색 「문의 중」 + 설명이고 맥 켜짐은 말하지 않는다", () => {
    const r = by(rows, "성재-claude");
    expect(r.status).toMatchObject({ label: "문의 중", tone: "mute" });
    expect(r.status?.detail).toContain("Anthropic 약관 확인 전까지");
    expect(r.status?.label).not.toContain("맥");
  });

  it("외부는 누구나 · 외부 운영자 비용", () => {
    const r = by(rows, "hermes");
    expect([r.labels.brain, r.labels.callable, r.labels.cost]).toEqual(["외부 (직접 운영)", "누구나", "외부 운영자"]);
  });

  it("사람 멤버는 표에 없다", () => {
    const human: RosterMember = { ...agent("h", "곽성재"), kind: "human" };
    expect(agentTableRows([human, ...MEMBERS], [], ME)).toHaveLength(MEMBERS.length);
  });

  it("정지된 에이전트는 사용 중지가 문의 중보다 앞서고, paused 는 일시정지, paused 를 모르면 상태를 비운다", () => {
    const rows2 = agentTableRows(
      [
        agent("s", "정지", { brain: "team_key", status: "suspended" }),
        agent("p", "잠깐", { brain: "team_key", paused: true }),
        agent("u", "미상", { brain: "team_key", paused: undefined }),
      ],
      [],
      ME
    );
    expect(by(rows2, "정지").status?.label).toBe("사용 중지");
    expect(by(rows2, "잠깐").status?.label).toBe("일시정지");
    expect(by(rows2, "미상").status).toBeNull();
  });

  it("서버 필드가 없는 구서버: 연결 목록에서 추론하고, 목록도 못 읽으면 쓰는 AI를 비운다", () => {
    const old = [agent("o1", "옛구독", { ownerHumanId: ME }), agent("o2", "옛팀")];
    const conns = [
      { agentMemberId: "o1", invocationScope: "owner_only", subscriptionHarness: "codex" },
    ] as never;
    const known = agentTableRows(old, conns, ME);
    expect(by(known, "옛구독").labels.brain).toBe("내 구독 (Codex)");
    expect(by(known, "옛팀").labels.brain).toBe("팀 AI 키");
    const unknown = agentTableRows(old, null, ME);
    expect(by(unknown, "옛팀").labels.brain).toBeNull();
    expect(by(unknown, "옛팀").labels.callable).toBeNull();
  });
});

describe("만들기 3종 권한", () => {
  const ids = (o: ReturnType<typeof createKindOptions>) => o.map((x) => `${x.id}:${x.state}`);

  it("데스크탑 소유자·관리자는 셋 다 열린다", () => {
    expect(ids(createKindOptions({ mayCreate: true, subscription: "rows", externalProvided: true }))).toEqual([
      "team:available", "mySubscription:available", "external:available",
    ]);
  });

  it("웹에서 내 구독은 숨기지 않고 「데스크탑에서」 힌트로 잠근다", () => {
    const [, sub] = createKindOptions({ mayCreate: true, subscription: "desktop-only", externalProvided: true });
    expect(sub).toMatchObject({ state: "locked", desktopHint: true });
    expect(sub?.reason).toContain("데스크탑 앱에서");
  });

  it("대상 칩은 실제 관문과 같은 말이다: 팀·외부는 소유자·관리자, 거절 문장도 같은 낱말", () => {
    const opts = createKindOptions({ mayCreate: false, subscription: "denied", externalProvided: true });
    expect(opts[0]?.audience).toBe("소유자·관리자");
    expect(opts[2]?.audience).toBe("소유자·관리자");
    expect(opts[0]?.reason).toContain("소유자·관리자");
  });

  it("권한이 없으면 셋 다 사유와 함께 잠긴다", () => {
    const opts = createKindOptions({ mayCreate: false, subscription: "denied", externalProvided: true });
    expect(opts.every((o) => o.state === "locked" && o.reason !== null)).toBe(true);
  });

  it("서버가 구독 에이전트를 꺼 두면 사유를 말하고, 외부 초대가 없는 빌드는 외부만 잠긴다", () => {
    const off = createKindOptions({ mayCreate: true, subscription: "server-off", externalProvided: false });
    expect(off[1]?.reason).toContain("꺼져 있어요");
    expect(off[2]).toMatchObject({ state: "locked" });
    expect(off[0]?.state).toBe("available");
  });
});

describe("/agents 목록 칩과 같은 상태 우선순위", () => {
  it("문의 중·맥 꺼짐은 활성보다 앞서고, 서버 사유가 없으면 활성이라 호출부가 프로필 판정으로 돌아간다", () => {
    const get = (h: string) => rosterStatusView(MEMBERS.find((m) => m.handle === h) as RosterMember, ME);
    expect(get("성재-claude")).toMatchObject({ label: "문의 중", tone: "mute" });
    expect(get("서연-codex")).toMatchObject({ label: "맥 꺼짐", tone: "warn" });
    expect(get("성재-codex")?.label).toBe("내 맥 켜짐");
    expect(get("김인턴")?.label).toBe("활성");
    expect(rosterStatusView(agent("x", "구서버", { paused: undefined }), ME)).toBeNull();
  });
});
