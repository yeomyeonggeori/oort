import { describe, expect, it } from "vitest";
import type { WorkHost, WorkSession } from "../../lib/api";
import type { AgentWorkingSignal } from "../agents/workingSignal";
import {
  ADE_STATE_LABEL,
  adeCounts,
  adeDiffLabel,
  adeItems,
  adeItemsFromSessions,
  adeItemsFromTurns,
  adeSummaryLabel,
  adeSummarySegments,
  adeSummarySentence,
  durabilityBadge,
  durabilityTone,
  hostDurability,
  itemDurabilityBadge,
  sessionAdeState,
  sessionDurability,
  turnAdeState,
} from "./adeControl";

const WS = "00000000-0000-7000-8000-000000000001";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const OWNER = "00000000-0000-7000-8000-000000000101";

function host(id: string, type: string, overrides: Partial<WorkHost> = {}): WorkHost {
  return {
    id,
    workspaceId: WS,
    scope: "member",
    ownerMemberId: OWNER,
    type,
    displayName: `${type} host`,
    capabilities: {},
    createdAtMs: 0,
    online: true,
    ...overrides,
  };
}

function session(
  id: string,
  status: WorkSession["status"],
  hostId: string,
  overrides: Partial<WorkSession> = {}
): WorkSession {
  return {
    id,
    workspaceId: WS,
    channelId: CHANNEL,
    memberId: OWNER,
    hostId,
    rootMessageId: `root-${id}`,
    tool: "codex",
    label: `작업 ${id}`,
    status,
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function turn(
  memberId: string,
  state: AgentWorkingSignal["state"],
  overrides: Partial<AgentWorkingSignal> = {}
): AgentWorkingSignal {
  return {
    memberId,
    channelId: CHANNEL,
    state,
    source: "run",
    headlines: [],
    lastActivityAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

const nameFor = (memberId: string) =>
  memberId === "agent-kim"
    ? { name: "김인턴", handle: "@kim-intern" }
    : { name: "Hermes" };

describe("생존성 등급은 host_type 파생이고, 모르면 지속이라고 말하지 않는다", () => {
  it("app 은 기기 종속, workd/cloud 는 지속", () => {
    expect(hostDurability("app")).toBe("device_bound");
    expect(hostDurability("workd")).toBe("persistent");
    expect(hostDurability("cloud")).toBe("persistent");
  });

  it("등록기가 모르는 타입도, 타입이 없는 것도 unknown 이다", () => {
    expect(hostDurability("t3-preview")).toBe("unknown");
    expect(hostDurability(undefined)).toBe("unknown");
  });

  it("호스트 목록이 아직 없거나 그 호스트를 못 찾으면 unknown", () => {
    const s = session("s1", "running", "h-cloud");
    expect(sessionDurability(s, undefined)).toBe("unknown");
    expect(sessionDurability(s, [])).toBe("unknown");
    expect(sessionDurability(s, [host("h-cloud", "cloud")])).toBe("persistent");
  });

  it("배지 문구는 ADR-0154 D1 원문 그대로이고, 모를 때는 약속하지 않는다", () => {
    expect(durabilityBadge("persistent")).toBe("기기를 꺼도 계속됩니다");
    expect(durabilityBadge("device_bound")).toBe("이 기기에서만");
    expect(durabilityBadge("unknown")).toBe("실행 위치 확인 필요");
    expect(durabilityBadge("unknown")).not.toContain("계속");
  });

  it("턴 카드는 배지를 세우지 않는다 — 경고가 기본값이 되면 경고가 아니다", () => {
    expect(
      itemDurabilityBadge({ kind: "run", durability: "unknown" })
    ).toBeNull();
  });

  it("세션의 unknown 은 그대로 말한다 — 그쪽은 진짜로 모르는 것이다", () => {
    expect(itemDurabilityBadge({ kind: "session", durability: "unknown" })).toBe(
      "실행 위치 확인 필요"
    );
    expect(
      itemDurabilityBadge({ kind: "session", durability: "persistent" })
    ).toBe("기기를 꺼도 계속됩니다");
  });

  it("톤은 문자열 비교가 아니라 등급에서 나온다", () => {
    expect(durabilityTone("persistent")).toBe("ok");
    expect(durabilityTone("device_bound")).toBe("muted");
    expect(durabilityTone("unknown")).toBe("warn");
  });
});

describe("상태 3분류", () => {
  it("원장 상태를 접는다: running=working, orphaned=blocked, idle=idle", () => {
    expect(sessionAdeState("running")).toBe("working");
    expect(sessionAdeState("orphaned")).toBe("blocked");
    expect(sessionAdeState("idle")).toBe("idle");
  });

  it("ended 와 모르는 상태는 어느 분류도 아니다 (활성으로 세지 않는다)", () => {
    expect(sessionAdeState("ended")).toBeNull();
    expect(sessionAdeState("resuming")).toBeNull();
  });

  it("승인 대기 턴은 blocked 다 — 사람을 기다리는 쪽이 강조축", () => {
    expect(turnAdeState(turn("agent-kim", "awaiting_approval"))).toBe("blocked");
    expect(turnAdeState(turn("agent-kim", "working"))).toBe("working");
  });

  it("3분류의 우리말은 원장 라벨과 낱말이 겹치지 않는다", () => {
    expect(ADE_STATE_LABEL.idle).toBe("유휴");
    expect(ADE_STATE_LABEL.blocked).toBe("대기");
    // 원장의 idle 라벨은 "완료 · 대기 중"이라 '대기'를 품는다. 3분류의 idle 이
    // 그 낱말을 다시 쓰면 요약 줄의 "대기 1"이 무엇을 센 것인지 알 수 없다.
    expect(ADE_STATE_LABEL.idle).not.toContain("대기");
  });
});

describe("카드 목록", () => {
  const hosts = [host("h-app", "app"), host("h-cloud", "cloud")];

  it("종료된 세션은 카드가 되지 않는다", () => {
    const items = adeItemsFromSessions(
      [
        session("s1", "running", "h-cloud"),
        session("s2", "ended", "h-cloud", { endedAtMs: 1_700_000_100_000 }),
      ],
      hosts
    );
    expect(items.map((i) => i.sessionId)).toEqual(["s1"]);
  });

  it("세션 카드는 3분류 칩과 원장의 정밀한 사실을 함께 나른다", () => {
    const [item] = adeItemsFromSessions(
      [session("s1", "orphaned", "h-app")],
      hosts
    );
    expect(item.state).toBe("blocked");
    expect(item.detail).toBe("호스트 연결 끊김");
    expect(item.durability).toBe("device_bound");
  });

  it("라벨이 빈 세션은 uuid 가 아니라 도구 이름으로 선다", () => {
    const [item] = adeItemsFromSessions(
      [session("s1", "running", "h-cloud", { label: "   " })],
      hosts
    );
    expect(item.title).toBe("codex");
  });

  it("턴 카드는 생존성을 모른다고 말한다 (호스트가 없다)", () => {
    const [item] = adeItemsFromTurns(
      [turn("agent-kim", "working", { runId: "RUN1", startedAtMs: 10 })],
      nameFor
    );
    expect(item.durability).toBe("unknown");
    expect(item.title).toBe("김인턴(@kim-intern)");
    expect(item.runId).toBe("RUN1");
  });

  it("승인 대기 턴은 헤드라인을 쓰지 않는다", () => {
    const [item] = adeItemsFromTurns(
      [turn("agent-kim", "awaiting_approval", { headlines: ["빌드 로그 확인"] })],
      nameFor
    );
    expect(item.detail).toBe("승인 대기");
  });

  it("두 레일의 키는 절대 충돌하지 않는다", () => {
    const items = adeItems(
      [session("shared-id", "running", "h-cloud")],
      hosts,
      [turn("agent-kim", "working", { runId: "shared-id" })],
      nameFor
    );
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });

  it("대기가 맨 위, 같은 분류 안에서는 오래된 것 먼저", () => {
    const items = adeItems(
      [
        session("old", "running", "h-cloud", { startedAtMs: 100 }),
        session("new", "running", "h-cloud", { startedAtMs: 900 }),
        session("idle", "idle", "h-app", { startedAtMs: 1 }),
        session("dead", "orphaned", "h-app", { startedAtMs: 500 }),
      ],
      hosts,
      [],
      nameFor
    );
    expect(items.map((i) => i.sessionId)).toEqual(["dead", "old", "new", "idle"]);
  });
});

describe("집계", () => {
  const hosts = [host("h-app", "app"), host("h-cloud", "cloud")];

  it("total 은 살아 있는 것만 센다 — 유휴는 줄을 켜지 않는다", () => {
    const counts = adeCounts(
      adeItems([session("i", "idle", "h-app")], hosts, [], nameFor)
    );
    expect(counts).toEqual({ working: 0, blocked: 0, idle: 1, total: 0 });
    expect(adeSummarySegments(counts)).toEqual([]);
    expect(adeSummarySentence(counts)).toBeNull();
    expect(adeSummaryLabel(counts)).toBeNull();
  });

  it("두 레일을 함께 센다", () => {
    const counts = adeCounts(
      adeItems(
        [
          session("s1", "running", "h-cloud"),
          session("s2", "orphaned", "h-app"),
          session("s3", "ended", "h-cloud"),
        ],
        hosts,
        [
          turn("agent-kim", "working", { runId: "R1" }),
          turn("hermes", "awaiting_approval", { runId: "R2" }),
        ],
        nameFor
      )
    );
    expect(counts).toEqual({ working: 2, blocked: 2, idle: 0, total: 4 });
  });
});

describe("요약 한 줄", () => {
  const counts = (working: number, blocked: number, idle = 0) => ({
    working,
    blocked,
    idle,
    total: working + blocked,
  });

  it("실행만 있으면 대기를 말하지 않는다", () => {
    expect(adeSummarySentence(counts(2, 0))).toBe("실행 중인 작업 2개");
    expect(
      adeSummarySegments(counts(2, 0)).some((s) => s.kind.startsWith("blocked"))
    ).toBe(false);
  });

  it("둘 다 있으면 ADR-0154 D2 의 원문 형태다", () => {
    expect(adeSummarySentence(counts(2, 1))).toBe("실행 중인 작업 2개 · 대기 1");
  });

  it("대기만 있으면 0 을 세지 않고 대기로 시작한다", () => {
    expect(adeSummarySentence(counts(0, 1))).toBe("대기 중인 작업 1개");
    expect(adeSummarySentence(counts(0, 1))).not.toContain("0개");
  });

  it("대기 조각은 언제나 강조 종류로 나온다 (화면이 문자열을 다시 뒤지지 않게)", () => {
    const emphasised = adeSummarySegments(counts(2, 3)).filter((s) =>
      s.kind === "blocked" || s.kind === "blockedCount"
    );
    expect(emphasised.map((s) => s.text)).toEqual(["대기 ", "3"]);
    const leading = adeSummarySegments(counts(0, 3)).filter((s) =>
      s.kind === "blocked" || s.kind === "blockedCount"
    );
    expect(leading).toHaveLength(3);
  });

  it("숫자는 자기 조각에 산다 — 산문과 섞이면 tabular-nums 를 걸 수 없다", () => {
    for (const segment of adeSummarySegments(counts(12, 7))) {
      if (segment.kind === "count" || segment.kind === "blockedCount") {
        expect(segment.text).toMatch(/^\d+$/);
      } else {
        expect(segment.text).not.toMatch(/\d/);
      }
    }
  });

  it("문장은 조각의 합이고, 접근 이름은 그 문장 + 여는 행동이다", () => {
    const c = counts(2, 1);
    expect(adeSummarySentence(c)).toBe(
      adeSummarySegments(c).map((s) => s.text).join("")
    );
    expect(adeSummaryLabel(c)).toBe("실행 중인 작업 2개 · 대기 1. 작업 목록 열기");
  });

  it("사용자에게 보이는 문구에 em-dash 가 없다", () => {
    const strings = [
      adeSummarySentence(counts(2, 1)),
      adeSummarySentence(counts(0, 1)),
      adeSummaryLabel(counts(1, 0)),
      durabilityBadge("persistent"),
      durabilityBadge("device_bound"),
      durabilityBadge("unknown"),
      ...Object.values(ADE_STATE_LABEL),
    ];
    for (const value of strings) {
      expect(value ?? "").not.toMatch(/[—–]/);
    }
  });
});

describe("diff 자리", () => {
  it("값이 없으면 라벨도 없다 — +0 -0 은 「모른다」가 아니다", () => {
    expect(adeDiffLabel(undefined)).toBeNull();
  });

  it("값이 오면 형태는 이미 정해져 있다", () => {
    expect(adeDiffLabel({ added: 42, removed: 18 })).toBe("+42 -18");
    expect(adeDiffLabel({ added: 0, removed: 0 })).toBe("+0 -0");
  });

  it("오늘의 빌더는 아무도 diff 를 채우지 않는다", () => {
    const items = adeItems(
      [session("s1", "running", "h-cloud")],
      [host("h-cloud", "cloud")],
      [turn("agent-kim", "working", { runId: "R1" })],
      nameFor
    );
    expect(items.every((item) => item.diff === undefined)).toBe(true);
  });
});

// ---- 이어하기 동사 (ADR-0154 D3, #1137) --------------------------------------

describe("카드의 이어하기 동사", () => {
  const hosts = [host("h-app", "app"), host("h-cloud", "cloud")];

  it("살아 있고 붙을 것이 있으면 재개", () => {
    const [card] = adeItemsFromSessions(
      [session("s1", "running", "h-app", { remoteAttachAvailable: true })],
      hosts
    );
    expect(card.handoff).toBe("resume");
  });

  it("고아 세션은 인수 — 대기 카드가 곧 행동 카드다", () => {
    const [card] = adeItemsFromSessions(
      [session("s1", "orphaned", "h-app")],
      hosts
    );
    expect(card.state).toBe("blocked");
    expect(card.handoff).toBe("takeover");
  });

  it("붙을 것이 없는 실행 중 세션에는 동사가 없다", () => {
    const [card] = adeItemsFromSessions(
      [session("s1", "running", "h-app", { remoteAttachAvailable: false })],
      hosts
    );
    expect(card.handoff).toBeUndefined();
  });

  it("명부가 아직이면 동사를 지어내지 않는다", () => {
    const [card] = adeItemsFromSessions(
      [session("s1", "running", "h-app", { remoteAttachAvailable: true })],
      undefined
    );
    expect(card.handoff).toBeUndefined();
  });

  // 턴은 호스트 위의 세션이 아니다. 재개할 히스토리도 인수할 원장 행도 없고,
  // 모든 턴 카드에 동사를 하나씩 달면 그 낱말은 목록의 배경이 된다.
  it("턴 카드에는 동사가 없다", () => {
    const cards = adeItemsFromTurns(
      [turn("agent-kim", "working", { runId: "R1" })],
      nameFor
    );
    expect(cards.every((card) => card.handoff === undefined)).toBe(true);
  });
});

describe("발원 대화 앵커 (#1193)", () => {
  const hosts = [host("h-app", "app"), host("h-cloud", "cloud")];

  it("세션 카드는 원장의 발원 메시지를 그대로 나른다", () => {
    const [card] = adeItemsFromSessions(
      [session("s1", "running", "h-cloud")],
      hosts
    );
    expect(card.anchorMessageId).toBe("root-s1");
  });

  // 유휴·고아도 카드로 서고, 그 카드에서도 「대화로」는 성립한다: 발원 메시지는
  // 세션이 살아 있는지와 무관하게 그 채널에 그대로 있다.
  it("실행 중이 아닌 카드도 앵커를 잃지 않는다", () => {
    const cards = adeItemsFromSessions(
      [
        session("idle", "idle", "h-app"),
        session("dead", "orphaned", "h-app"),
      ],
      hosts
    );
    expect(cards.map((card) => card.anchorMessageId)).toEqual([
      "root-idle",
      "root-dead",
    ]);
  });

  // 죽은 버튼 금지. 턴에는 원장 행이 없으므로 발원 메시지도 없고, 없는 것을
  // 빈 문자열로 채우면 화면은 눌러도 아무 데도 안 가는 동사를 그린다.
  it("턴 카드에는 앵커가 없다", () => {
    const cards = adeItemsFromTurns(
      [turn("agent-kim", "working", { runId: "R1" })],
      nameFor
    );
    expect(cards.every((card) => card.anchorMessageId === undefined)).toBe(true);
  });

  it("원장이 빈 문자열을 답하면 앵커가 아니다", () => {
    const [card] = adeItemsFromSessions(
      [session("s1", "running", "h-cloud", { rootMessageId: "   " })],
      hosts
    );
    expect(card.anchorMessageId).toBeUndefined();
  });
});

// 게이트의 red seam(#1193 ANCHOR)이 찾아낸 판. 원장이 그 칸을 아예 빼고 답했을 때
// 예전 판은 `.trim()` 에서 TypeError 를 던졌고, 그 예외는 요약 줄에서 시작해 셸
// 전체를 흰 화면으로 만들었다. 잃어도 되는 것은 동사 하나뿐이다.
describe("원장이 앵커 칸을 아예 빼고 답해도 목록은 선다 (#1193)", () => {
  const hosts = [host("h-cloud", "cloud")];

  it("칸이 없으면 동사가 없고, 카드는 그대로 있다", () => {
    const { rootMessageId: _dropped, ...rowWithoutAnchor } = session(
      "s1",
      "running",
      "h-cloud"
    );
    const items = adeItemsFromSessions(
      [rowWithoutAnchor as WorkSession],
      hosts
    );
    expect(items).toHaveLength(1);
    expect(items[0].anchorMessageId).toBeUndefined();
    expect(items[0].title).toBe("작업 s1");
  });
});
