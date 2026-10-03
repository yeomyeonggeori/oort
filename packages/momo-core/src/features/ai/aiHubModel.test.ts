import { describe, expect, it } from "vitest";
import {
  AI_GLOSSARY,
  AI_HUB_COPY,
  AI_HUB_FROM_SETTINGS,
  AI_HUB_NAV_COPY,
  AI_HUB_OVERVIEW_COPY,
  AI_HUB_SECTIONS,
  LEGACY_TERM_MAP,
  aiAgentLabels,
  classifyAiAgent,
  defaultAgentName,
  findLegacyTerms,
  glossaryEntry,
  hostOfflineNotice,
  nonOwnerComposerNotice,
  nonOwnerNotice,
  teamKeyOperatorOnlyNotice,
  type AiAgentFacts,
  type AiGlossaryId,
  type AiViewer,
} from "./aiHubModel";

const ME: AiViewer = { humanId: "h-me" };
const OTHER: AiViewer = { humanId: "h-other" };

function labelsFor(facts: AiAgentFacts, viewer: AiViewer = ME) {
  return aiAgentLabels(classifyAiAgent(facts, viewer));
}

describe("용어집", () => {
  it("용어 8개, 시안 순서, id 중복 없음", () => {
    expect(AI_GLOSSARY.map((e) => e.term)).toEqual([
      "내 AI 계정",
      "팀 AI 키",
      "기본 AI",
      "에이전트",
      "부를 수 있는 사람",
      "비용",
      "외부 연결",
      "내 작업",
    ]);
    expect(new Set(AI_GLOSSARY.map((e) => e.id)).size).toBe(8);
  });

  it("모든 id 를 조회할 수 있고 한 줄 뜻은 해요체 문장이다", () => {
    const ids: AiGlossaryId[] = [
      "myAiAccount", "teamAiKey", "defaultAi", "agent",
      "callableBy", "cost", "externalConnection", "myWork",
    ];
    for (const id of ids) {
      const entry = glossaryEntry(id);
      expect(entry.id).toBe(id);
      expect(entry.meaning).toMatch(/[요.]$/);
    }
  });

  it("뜻 문장은 옛 말(grep 게이트 대상)을 되살리지 않는다", () => {
    for (const entry of AI_GLOSSARY) {
      expect(findLegacyTerms(entry.term)).toEqual([]);
      expect(findLegacyTerms(entry.meaning)).toEqual([]);
    }
  });

  it("허브 상수 문구도 옛 말이 없다", () => {
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(AI_HUB_COPY);
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) expect(findLegacyTerms(s), s).toEqual([]);
  });
});

describe("분류: 서버 값이 있을 때", () => {
  it("brain 세 값과 callable_by 를 그대로 읽는다", () => {
    expect(classifyAiAgent({ brain: "team_key", callableBy: "everyone" })).toMatchObject({
      brain: "team_key", brainSource: "server", callableBy: "everyone", cost: "team",
    });
    expect(classifyAiAgent({ brain: "external", callableBy: "everyone" })).toMatchObject({
      brain: "external", cost: "external",
    });
    expect(classifyAiAgent({ brain: "subscription", callableBy: "owner" })).toMatchObject({
      brain: "subscription", callableBy: "owner", cost: "owner",
    });
  });

  it("서버가 구독 에이전트를 everyone 으로 내려도 owner 로 읽는다(약관 선)", () => {
    expect(classifyAiAgent({ brain: "subscription", callableBy: "everyone" }).callableBy).toBe("owner");
    expect(classifyAiAgent({ brain: "subscription", invocationScope: "workspace" }).callableBy).toBe("owner");
  });

  it("서버 brain 이 오늘 값보다 먼저다", () => {
    const c = classifyAiAgent({ brain: "team_key", invocationScope: "owner_only", subscriptionHarness: "codex" });
    expect(c.brain).toBe("team_key");
    expect(c.brainSource).toBe("server");
  });

  it("모르는 brain 문자열은 부재와 같다", () => {
    expect(classifyAiAgent({ brain: "grok" }).brain).toBe("unknown");
    expect(classifyAiAgent({ brain: "" }).brain).toBe("unknown");
    expect(classifyAiAgent({ brain: "grok", invocationScope: "owner_only" }).brainSource).toBe("inferred");
  });
});

describe("분류: 오늘 서버 값만 있을 때(미래 필드 부재)", () => {
  const cases: Array<[string, AiAgentFacts, string, string, string]> = [
    ["owner_only 범위", { invocationScope: "owner_only" }, "subscription", "owner", "owner"],
    ["구독 하니스만", { subscriptionHarness: "claude_code" }, "subscription", "owner", "owner"],
    ["하니스 codex", { subscriptionHarness: "codex" }, "subscription", "owner", "owner"],
    ["호스티드 연결 있음(workspace)", { hostedConnection: true, invocationScope: "workspace" }, "external", "everyone", "external"],
    ["호스티드 연결 있음(범위 부재)", { hostedConnection: true }, "external", "everyone", "external"],
    ["연결 없음이 확인됨", { hostedConnection: false }, "team_key", "everyone", "team"],
    ["아무 것도 모름", {}, "unknown", "unknown", "unknown"],
    ["연결 목록을 못 읽음", { hostedConnection: null }, "unknown", "unknown", "unknown"],
    ["workspace 범위만", { invocationScope: "workspace" }, "unknown", "everyone", "unknown"],
  ];
  it.each(cases)("%s", (_name, facts, brain, callableBy, cost) => {
    const c = classifyAiAgent(facts);
    expect([c.brain, c.callableBy, c.cost]).toEqual([brain, callableBy, cost]);
  });

  it("추론한 brain 은 brainSource=inferred, 모르면 unknown", () => {
    expect(classifyAiAgent({ invocationScope: "owner_only" }).brainSource).toBe("inferred");
    expect(classifyAiAgent({}).brainSource).toBe("unknown");
  });

  it("모르는 하니스 값은 하니스 없음으로 읽는다", () => {
    expect(classifyAiAgent({ subscriptionHarness: "gemini" }).harness).toBeNull();
    expect(classifyAiAgent({ subscriptionHarness: "gemini" }).brain).toBe("unknown");
  });
});

describe("소유 여부", () => {
  it("대소문자를 가리지 않고 같은 id 면 mine", () => {
    expect(classifyAiAgent({ ownerHumanId: "H-ME" }, ME).ownership).toBe("mine");
    expect(classifyAiAgent({ ownerHumanId: "h-me" }, OTHER).ownership).toBe("other");
  });
  it("소유자나 보는 사람 중 하나라도 모르면 unknown", () => {
    expect(classifyAiAgent({}, ME).ownership).toBe("unknown");
    expect(classifyAiAgent({ ownerHumanId: "h-me" }, {}).ownership).toBe("unknown");
    expect(classifyAiAgent({ ownerHumanId: "  " }, ME).ownership).toBe("unknown");
    expect(classifyAiAgent({ ownerHumanId: "h-me" }, { humanId: null }).ownership).toBe("unknown");
  });
});

// 라벨 정답표. 구현과 독립으로 문장을 손으로 적었다.
describe("라벨 표(손으로 적은 정답)", () => {
  const sub = { brain: "subscription", callableBy: "owner", subscriptionHarness: "claude_code" } as const;
  const rows: Array<{
    name: string;
    facts: AiAgentFacts;
    viewer: AiViewer;
    brain: string | null;
    callable: string | null;
    cost: string | null;
    line: string | null;
    badge: string | null;
    locked: boolean;
    host: string | null;
  }> = [
    {
      name: "내 구독, 맥 켜짐",
      facts: { ...sub, ownerHumanId: "h-me", ownerDisplayName: "성재", hostOnline: true },
      viewer: ME,
      brain: "내 구독 (Claude Code)", callable: "나만", cost: "내 구독",
      line: "내 구독 · 나만 부를 수 있어요", badge: "내 구독", locked: false, host: "내 맥 켜짐",
    },
    {
      name: "내 구독, 맥 꺼짐",
      facts: { ...sub, subscriptionHarness: "codex", ownerHumanId: "h-me", hostOnline: false },
      viewer: ME,
      brain: "내 구독 (Codex)", callable: "나만", cost: "내 구독",
      line: "내 구독 · 나만 부를 수 있어요 · 맥 꺼짐", badge: "내 구독", locked: false, host: "맥 꺼짐",
    },
    {
      name: "남의 구독, 맥 켜짐",
      facts: { ...sub, ownerHumanId: "h-me", ownerDisplayName: "성재", hostOnline: true },
      viewer: OTHER,
      brain: "개인 구독 (Claude Code)", callable: "성재 님만", cost: "성재 님 구독",
      line: "성재 님 개인 구독 · 성재 님만 부를 수 있어요", badge: "성재 님만", locked: true, host: "맥 켜짐",
    },
    {
      name: "남의 구독, 맥 꺼짐",
      facts: { ...sub, ownerHumanId: "h-me", ownerDisplayName: "성재", hostOnline: false },
      viewer: OTHER,
      brain: "개인 구독 (Claude Code)", callable: "성재 님만", cost: "성재 님 구독",
      line: "성재 님 개인 구독 · 성재 님만 부를 수 있어요 · 맥 꺼짐", badge: "성재 님만", locked: true, host: "맥 꺼짐",
    },
    {
      name: "남의 구독, 맥 상태 모름",
      facts: { ...sub, ownerHumanId: "h-me", ownerDisplayName: "성재" },
      viewer: OTHER,
      brain: "개인 구독 (Claude Code)", callable: "성재 님만", cost: "성재 님 구독",
      line: "성재 님 개인 구독 · 성재 님만 부를 수 있어요", badge: "성재 님만", locked: true, host: null,
    },
    {
      name: "남의 구독, 소유자 이름 모름",
      facts: { ...sub, ownerHumanId: "h-me" },
      viewer: OTHER,
      brain: "개인 구독 (Claude Code)", callable: "만든 사람만", cost: "만든 사람 구독",
      line: "만든 사람 개인 구독 · 만든 사람만 부를 수 있어요", badge: "만든 사람만", locked: true, host: null,
    },
    {
      name: "구독인데 소유자 관계 모름, 이름 앎: 누구에게나 참인 문장",
      facts: { ...sub, ownerDisplayName: "성재" },
      viewer: ME,
      brain: "개인 구독 (Claude Code)", callable: "성재 님만", cost: "성재 님 구독",
      line: "성재 님 개인 구독 · 성재 님만 부를 수 있어요", badge: "성재 님만", locked: false, host: null,
    },
    {
      name: "구독인데 소유자 관계도 이름도 모름: 중립",
      facts: { ...sub },
      viewer: ME,
      brain: "개인 구독 (Claude Code)", callable: "만든 사람만", cost: "만든 사람 구독",
      line: "개인 구독 · 만든 사람만 부를 수 있어요", badge: "개인 구독", locked: false, host: null,
    },
    {
      name: "팀 키(제공자 있음)",
      facts: { brain: "team_key", callableBy: "everyone", providerLabel: "Anthropic" },
      viewer: ME,
      brain: "팀 AI 키 (Anthropic)", callable: "누구나", cost: "팀",
      line: "팀 키 · 누구나", badge: "팀 키", locked: false, host: null,
    },
    {
      name: "팀 키(제공자 없음)",
      facts: { brain: "team_key" },
      viewer: OTHER,
      brain: "팀 AI 키", callable: "누구나", cost: "팀",
      line: "팀 키 · 누구나", badge: "팀 키", locked: false, host: null,
    },
    {
      name: "외부",
      facts: { brain: "external", callableBy: "everyone" },
      viewer: OTHER,
      brain: "외부 (직접 운영)", callable: "누구나", cost: "외부 운영자",
      line: "외부 · 누구나", badge: "외부", locked: false, host: null,
    },
    {
      name: "아무 것도 모름: 아무 문장도 만들지 않는다",
      facts: {},
      viewer: ME,
      brain: null, callable: null, cost: null,
      line: null, badge: null, locked: false, host: null,
    },
    {
      name: "callable 만 아는 경우: 표 칩만",
      facts: { callableBy: "everyone" },
      viewer: ME,
      brain: null, callable: "누구나", cost: null,
      line: null, badge: null, locked: false, host: null,
    },
  ];

  it.each(rows)("$name", (row) => {
    const l = labelsFor(row.facts, row.viewer);
    expect(l.brain).toBe(row.brain);
    expect(l.callable).toBe(row.callable);
    expect(l.cost).toBe(row.cost);
    expect(l.mentionLine).toBe(row.line);
    expect(l.mentionBadge).toBe(row.badge);
    expect(l.lockedForViewer).toBe(row.locked);
    expect(l.host?.label ?? null).toBe(row.host);
  });

  it("맥 꺼짐 상세는 팀 키로 대신하지 않는다고 말한다", () => {
    const l = labelsFor({ ...sub, ownerHumanId: "h-me", hostOnline: false });
    expect(l.host?.detail).toBe("켜지면 답해요. 팀 키로 대신하지 않아요.");
  });

  it("팀 키·외부 에이전트에는 맥 상태를 붙이지 않는다", () => {
    expect(labelsFor({ brain: "team_key", hostOnline: false }).host).toBeNull();
    expect(labelsFor({ brain: "external", hostOnline: false }).mentionLine).toBe("외부 · 누구나");
  });
});

// 조합 전수: brain 소스 × callable_by × 소유 × 맥 상태 × 소유자 이름.
describe("조합 전수 불변식", () => {
  const brainVariants: Array<[string, AiAgentFacts]> = [
    ["server:subscription", { brain: "subscription" }],
    ["server:team_key", { brain: "team_key" }],
    ["server:external", { brain: "external" }],
    ["today:owner_only", { invocationScope: "owner_only" }],
    ["today:harness", { subscriptionHarness: "codex" }],
    ["today:hosted", { hostedConnection: true }],
    ["today:not hosted", { hostedConnection: false }],
    ["none", {}],
  ];
  const callableVariants: Array<AiAgentFacts["callableBy"]> = ["owner", "everyone", "weird", null, undefined];
  const ownerVariants: Array<[string, Partial<AiAgentFacts>, AiViewer]> = [
    ["mine", { ownerHumanId: "h-me" }, ME],
    ["other", { ownerHumanId: "h-me" }, OTHER],
    ["no owner id", {}, ME],
    ["no viewer", { ownerHumanId: "h-me" }, {}],
  ];
  const hostVariants: Array<boolean | null | undefined> = [true, false, null, undefined];
  const nameVariants: Array<string | null | undefined> = ["성재", "  ", null, undefined];

  const all: Array<{ id: string; facts: AiAgentFacts; viewer: AiViewer }> = [];
  for (const [bn, bf] of brainVariants)
    for (const cb of callableVariants)
      for (const [on, of_, viewer] of ownerVariants)
        for (const host of hostVariants)
          for (const name of nameVariants)
            all.push({
              id: `${bn}|cb=${String(cb)}|${on}|host=${String(host)}|name=${String(name)}`,
              facts: { ...bf, ...of_, callableBy: cb, hostOnline: host, ownerDisplayName: name },
              viewer,
            });

  it("조합 수가 줄지 않았다(전수 범위 고정)", () => {
    expect(all.length).toBe(8 * 5 * 4 * 4 * 4);
  });

  it("구독 에이전트는 어떤 입력에서도 누구나로 읽히지 않는다", () => {
    for (const { id, facts, viewer } of all) {
      const c = classifyAiAgent(facts, viewer);
      if (c.brain !== "subscription") continue;
      const l = aiAgentLabels(c);
      expect(c.callableBy, id).toBe("owner");
      expect(l.callable, id).not.toBe("누구나");
      expect(l.mentionLine ?? "", id).not.toContain("누구나");
      expect(l.cost, id).toMatch(/구독$/);
    }
  });

  it("brain 이 unknown 이면 보조 줄·칩·비용·맥 상태가 없다", () => {
    for (const { id, facts, viewer } of all) {
      const c = classifyAiAgent(facts, viewer);
      if (c.brain !== "unknown") continue;
      const l = aiAgentLabels(c);
      expect([l.brain, l.cost, l.mentionLine, l.mentionBadge, l.host], id).toEqual([null, null, null, null, null]);
      expect(l.lockedForViewer, id).toBe(false);
    }
  });

  it("자물쇠와 비소유자 안내는 구독 + 남의 것일 때만, 같은 조건에서 함께", () => {
    for (const { id, facts, viewer } of all) {
      const c = classifyAiAgent(facts, viewer);
      const l = aiAgentLabels(c);
      const expected = c.brain === "subscription" && c.ownership === "other";
      expect(l.lockedForViewer, id).toBe(expected);
      expect(nonOwnerNotice(c, "에이전트") !== null, id).toBe(expected);
      expect(nonOwnerComposerNotice(c, "에이전트") !== null, id).toBe(expected);
    }
  });

  it("맥 꺼짐 안내와 접미사는 구독 + hostOnline=false 일 때만", () => {
    for (const { id, facts, viewer } of all) {
      const c = classifyAiAgent(facts, viewer);
      const l = aiAgentLabels(c);
      const expected = c.brain === "subscription" && c.hostOnline === false;
      expect(hostOfflineNotice(c) !== null, id).toBe(expected);
      expect(l.host?.label === "맥 꺼짐", id).toBe(expected);
      expect((l.mentionLine ?? "").endsWith(" · 맥 꺼짐"), id).toBe(expected);
    }
  });

  it("어떤 문장도 팀 키가 대신 답한다고 약속하지 않는다", () => {
    const promise = /팀 키로 (대신 )?(답해요|답합니다)(?!.*않)/;
    for (const { id, facts, viewer } of all) {
      const c = classifyAiAgent(facts, viewer);
      const l = aiAgentLabels(c);
      const texts = [
        l.brain, l.callable, l.cost, l.mentionLine, l.mentionBadge, l.host?.label, l.host?.detail,
        nonOwnerNotice(c, "에이전트"), nonOwnerComposerNotice(c, "에이전트"), hostOfflineNotice(c),
      ].filter((t): t is string => t !== null && t !== undefined);
      for (const t of texts) {
        if (c.brain === "subscription") expect(t, id).not.toMatch(promise);
      }
    }
  });

  it("생성된 모든 문장에 옛 말(grep 게이트 대상)이 없고, 줄표·빈 값도 없다", () => {
    for (const { id, facts, viewer } of all) {
      const c = classifyAiAgent(facts, viewer);
      const l = aiAgentLabels(c);
      const texts = [
        l.brain, l.callable, l.cost, l.mentionLine, l.mentionBadge, l.host?.label, l.host?.detail,
        nonOwnerNotice(c, "성재의 Claude Code", "김인턴"), nonOwnerNotice(c, "성재의 Claude Code"),
        nonOwnerComposerNotice(c, "성재의 Claude Code"), hostOfflineNotice(c),
      ].filter((t): t is string => t !== null && t !== undefined);
      for (const t of texts) {
        expect(t.trim(), id).not.toBe("");
        expect(findLegacyTerms(t), `${id}: ${t}`).toEqual([]);
        expect(t, id).not.toMatch(/[—–]/);
        expect(t, id).not.toMatch(/undefined|null|\[object/);
      }
    }
  });
});

describe("안내 문구", () => {
  const c = classifyAiAgent(
    { brain: "subscription", ownerHumanId: "h-me", ownerDisplayName: "성재", hostOnline: false },
    OTHER
  );

  it("비소유자 정적 안내(팀 에이전트 있음)", () => {
    expect(nonOwnerNotice(c, "성재의 Claude Code", "김인턴")).toBe(
      "성재의 Claude Code는 성재 님 개인 구독이라 성재 님만 부를 수 있어요. 팀 키로 답하는 @김인턴에게 물어보거나, 성재 님에게 부탁해 보세요."
    );
  });
  it("팀 에이전트가 없으면 앞 문장만", () => {
    const expected = "성재의 Claude Code는 성재 님 개인 구독이라 성재 님만 부를 수 있어요.";
    expect(nonOwnerNotice(c, "성재의 Claude Code")).toBe(expected);
    expect(nonOwnerNotice(c, "성재의 Claude Code", "  ")).toBe(expected);
    expect(nonOwnerNotice(c, "성재의 Claude Code", null)).toBe(expected);
  });
  it("주제 조사는 받침을 따른다", () => {
    expect(nonOwnerNotice(c, "코드봇")).toMatch(/^코드봇은 /);
    expect(nonOwnerNotice(c, "hermes")).toMatch(/^hermes는 /);
    expect(nonOwnerNotice(c, "성재의 Claude Code")).toMatch(/^성재의 Claude Code는 /);
  });
  it("composer 한 줄", () => {
    expect(nonOwnerComposerNotice(c, "성재의 Claude Code")).toBe(
      "성재의 Claude Code는 성재 님만 부를 수 있어요. 보내도 답하지 않아요."
    );
  });
  it("소유자 맥 꺼짐: 남/나/이름 모름", () => {
    expect(hostOfflineNotice(c)).toBe("성재 님 맥이 꺼져 있어요. 켜지면 답해요. 팀 키로 대신하지 않아요.");
    const mine = classifyAiAgent({ brain: "subscription", ownerHumanId: "h-me", hostOnline: false }, ME);
    expect(hostOfflineNotice(mine)).toBe("내 맥이 꺼져 있어요. 켜지면 답해요. 팀 키로 대신하지 않아요.");
    const anon = classifyAiAgent({ brain: "subscription", ownerHumanId: "h-me", hostOnline: false }, OTHER);
    expect(hostOfflineNotice(anon)).toBe("만든 사람 맥이 꺼져 있어요. 켜지면 답해요. 팀 키로 대신하지 않아요.");
  });
  it("내 구독에는 비소유자 안내가 없다", () => {
    const mine = classifyAiAgent({ brain: "subscription", ownerHumanId: "h-me" }, ME);
    expect(nonOwnerNotice(mine, "내 에이전트")).toBeNull();
    expect(nonOwnerComposerNotice(mine, "내 에이전트")).toBeNull();
  });
  it("팀 키 비운영자 안내", () => {
    expect(teamKeyOperatorOnlyNotice("하늘")).toBe("팀 키는 운영자만 보고 바꿀 수 있어요. 필요하면 하늘 님에게 요청하세요.");
    expect(teamKeyOperatorOnlyNotice()).toBe("팀 키는 운영자만 보고 바꿀 수 있어요. 필요하면 운영자에게 요청하세요.");
  });
});

describe("에이전트 기본 이름", () => {
  const base = { displayName: "성재", harness: "claude_code", takenNames: [] } as const;

  it("종류별 꼬리", () => {
    expect(defaultAgentName(base)).toBe("성재-claude");
    expect(defaultAgentName({ ...base, harness: "codex" })).toBe("성재-codex");
  });
  it("겹치면 -2, -3 (대소문자 무시, 앞뒤 공백 무시)", () => {
    expect(defaultAgentName({ ...base, takenNames: ["성재-claude"] })).toBe("성재-claude-2");
    expect(defaultAgentName({ ...base, takenNames: ["성재-claude", " 성재-claude-2 "] })).toBe("성재-claude-3");
    expect(defaultAgentName({ ...base, displayName: "Sj", takenNames: ["SJ-CLAUDE"] })).toBe("Sj-claude-2");
  });
  it("다른 종류의 같은 사람 이름은 겹침이 아니다", () => {
    expect(defaultAgentName({ ...base, takenNames: ["성재-codex"] })).toBe("성재-claude");
  });
  it("맥이 여러 대면 -기기이름, 그래도 겹치면 -2", () => {
    const multi = { ...base, multipleDevices: true, deviceName: "MacBook Pro" };
    expect(defaultAgentName(multi)).toBe("성재-claude-MacBook-Pro");
    expect(defaultAgentName({ ...multi, takenNames: ["성재-claude-macbook-pro"] })).toBe("성재-claude-MacBook-Pro-2");
  });
  it("맥이 한 대면 기기 이름을 붙이지 않는다", () => {
    expect(defaultAgentName({ ...base, multipleDevices: false, deviceName: "MacBook" })).toBe("성재-claude");
  });
  it("여러 대인데 기기 이름이 비면 붙이지 않는다", () => {
    expect(defaultAgentName({ ...base, multipleDevices: true, deviceName: "  " })).toBe("성재-claude");
    expect(defaultAgentName({ ...base, multipleDevices: true, deviceName: null })).toBe("성재-claude");
  });
  it("공백은 -, 앞의 @ 는 제거, 비면 me", () => {
    expect(defaultAgentName({ ...base, displayName: "  Kim  Ha " })).toBe("Kim-Ha-claude");
    expect(defaultAgentName({ ...base, displayName: "@sj" })).toBe("sj-claude");
    expect(defaultAgentName({ ...base, displayName: "   " })).toBe("me-claude");
  });
  it("100자 한도 안에서 표시이름을 깎고 꼬리는 지킨다", () => {
    const long = "가".repeat(300);
    const name = defaultAgentName({ ...base, displayName: long, takenNames: [] });
    expect([...name].length).toBeLessThanOrEqual(100);
    expect(name.endsWith("-claude")).toBe(true);
    const withCollisions = defaultAgentName({ ...base, displayName: long, takenNames: [name] });
    expect([...withCollisions].length).toBeLessThanOrEqual(100);
    expect(withCollisions).toBe(`${name}-2`);
  });
});

describe("옛 말 → 새 말 표", () => {
  it("옛 말 중복이 없고 새 말은 비어 있지 않다", () => {
    expect(new Set(LEGACY_TERM_MAP.map((e) => e.old)).size).toBe(LEGACY_TERM_MAP.length);
    for (const e of LEGACY_TERM_MAP) expect(e.next.trim(), e.old).not.toBe("");
  });

  it("grep 게이트 항목의 옛 말은 어떤 새 말에도 들어 있지 않다(스스로 걸리지 않는다)", () => {
    const gated = LEGACY_TERM_MAP.filter((e) => e.grepGate);
    const nexts = [...LEGACY_TERM_MAP.map((e) => e.next), ...AI_GLOSSARY.map((e) => e.term)];
    for (const g of gated) for (const n of nexts) expect(n.includes(g.old), `${g.old} in ${n}`).toBe(false);
  });

  it("글자 검사로 못 가르는 말은 게이트에서 빠져 있다(새 문구가 쓰는 말)", () => {
    const ungated = new Set(LEGACY_TERM_MAP.filter((e) => !e.grepGate).map((e) => e.old));
    for (const reused of ["팀 키", "개인 구독", "구독", "이 맥", "로그인"]) expect(ungated.has(reused), reused).toBe(true);
  });

  it("옛 문구는 걸리고 새 문구는 안 걸린다", () => {
    expect(findLegacyTerms("설정 › AI 연결에서 확인하세요").map((e) => e.old)).toEqual(["AI 연결"]);
    expect(findLegacyTerms("에이전트를 합류시켜요").map((e) => e.old)).toEqual(["합류"]);
    expect(findLegacyTerms("owner_only 에이전트의 과금").map((e) => e.old).sort()).toEqual(["owner_only", "과금"].sort());
    expect(findLegacyTerms("팀 키 · 누구나")).toEqual([]);
    expect(findLegacyTerms("성재 님 개인 구독 · 성재 님만 부를 수 있어요")).toEqual([]);
  });
});

describe("허브 구획과 옛 입구 (AIH-3)", () => {
  it("네 구획의 주소는 /ai 아래이고 제목은 용어집 이름이다", () => {
    expect(AI_HUB_SECTIONS.map((s) => [s.path, glossaryEntry(s.glossaryId).term])).toEqual([
      ["/ai/accounts", "내 AI 계정"],
      ["/ai/team-keys", "팀 AI 키"],
      ["/ai/agents", "에이전트"],
      ["/ai/external", "외부 연결"],
    ]);
  });

  it("옛 설정 섹션은 모두 존재하는 허브 구획을 가리킨다", () => {
    const ids = new Set(AI_HUB_SECTIONS.map((s) => s.id));
    for (const target of Object.values(AI_HUB_FROM_SETTINGS)) expect(ids.has(target)).toBe(true);
    expect(Object.keys(AI_HUB_FROM_SETTINGS).sort()).toEqual(["agents", "ai", "events", "plugins", "webhooks"]);
  });

  it("새 안내 문구가 옛 말을 되살리지 않는다", () => {
    const texts = [
      ...Object.values(AI_HUB_NAV_COPY),
      ...Object.values(AI_HUB_OVERVIEW_COPY.chip),
      ...Object.values(AI_HUB_OVERVIEW_COPY.nextAction),
      ...Object.values(AI_HUB_OVERVIEW_COPY.openLink),
      AI_HUB_OVERVIEW_COPY.webNote,
    ];
    for (const text of texts) expect(findLegacyTerms(text), text).toEqual([]);
  });
});
