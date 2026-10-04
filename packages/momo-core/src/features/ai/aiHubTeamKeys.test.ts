import { describe, expect, it } from "vitest";
import {
  AI_DEFAULT_UNSET_LABEL,
  resolveRow,
  type AiDefaultRowId,
  type AiDefaultsInput,
  type AiDefaultsTeamKey,
} from "../settings/aiDefaults";
import {
  AI_HUB_DEFAULT_ROWS,
  AI_TEAM_KEYS_COPY,
  defaultAiUnsetSentence,
  findLegacyTerms,
  teamKeyCompany,
  teamKeyFeatureUses,
} from "./aiHubModel";

// AIH-6 (#3400): 「고르지 않으면」 문장이 코어 판정(resolveRow)과 서버 코드가 실제로 하는 일에서
// 어긋나지 않는지 고정한다.

const PRESENT: AiDefaultsTeamKey = { status: "present", name: "https://api.anthropic.com/v1", failed: false, modelCount: null };
const STATES: Record<AiDefaultsTeamKey["status"], AiDefaultsTeamKey> = {
  present: PRESENT,
  absent: { status: "absent" },
  mock: { status: "mock" },
  hidden: { status: "hidden" },
  loading: { status: "loading" },
  error: { status: "error" },
};

function input(teamKey: AiDefaultsTeamKey): AiDefaultsInput {
  return { accounts: [], teamKey, browserTab: false };
}

describe("기본 AI 표의 「고르지 않으면」 문장은 코어 판정과 같은 말을 한다", () => {
  it("여섯 줄이 코어 행 전부를 덮고 순서에 중복이 없다", () => {
    const ids = AI_HUB_DEFAULT_ROWS.map((row) => row.rowId).sort();
    expect(ids).toEqual(["appCommand", "guardrail", "localTerminal", "remoteWork", "summary", "teamAgent"]);
  });

  it("개인 줄: 코어가 말하는 기본값 이름이 문장에 들어 있다", () => {
    for (const id of ["localTerminal", "remoteWork"] as const) {
      const resolved = resolveRow(id, {}, input(PRESENT));
      expect(resolved.state).toBe("ok");
      expect(resolved.using).toBe(AI_DEFAULT_UNSET_LABEL[id]);
      expect(defaultAiUnsetSentence(id, "present")).toContain(AI_DEFAULT_UNSET_LABEL[id]);
    }
  });

  it("앱 명령: 코어가 막으면(팀 키 없음) 문장도 쓸 수 없다고 말한다", () => {
    for (const status of ["absent", "mock"] as const) {
      expect(resolveRow("appCommand", {}, input(STATES[status])).state).toBe("blocked");
      expect(defaultAiUnsetSentence("appCommand", status)).toContain("쓸 수 없어요");
    }
    expect(resolveRow("appCommand", {}, input(PRESENT)).state).toBe("ok");
    expect(defaultAiUnsetSentence("appCommand", "present")).toContain("팀 AI 키");
  });

  it("팀 에이전트: 키가 없으면 코어처럼 대답하지 못하거나 모의 응답, 내 구독으로 넘어가지 않는다", () => {
    const absent = resolveRow("teamAgent", {}, input(STATES.absent));
    expect(absent.state).toBe("blocked");
    expect(defaultAiUnsetSentence("teamAgent", "absent")).toContain("대답하지 못해요");
    const mock = resolveRow("teamAgent", {}, input(STATES.mock));
    expect(mock.using).toBe("모의 응답");
    expect(defaultAiUnsetSentence("teamAgent", "mock")).toContain("모의 응답");
    for (const status of ["absent", "mock", "present"] as const) {
      expect(defaultAiUnsetSentence("teamAgent", status)).toContain("내 구독으로 넘어가지 않아요");
    }
    // 키가 있으면 팀 AI 키로 답한다.
    expect(defaultAiUnsetSentence("teamAgent", "present")).toContain("팀 AI 키 맨 위 키");
  });

  it("첫 인사 · 채널 요약: 키가 없으면 코어 문장과 같고, 키가 있어도 채널 요약은 돌지 않는다고 말한다", () => {
    const coreAbsent = resolveRow("summary", {}, input(STATES.absent));
    expect(coreAbsent.state).toBe("fallback");
    const sentence = defaultAiUnsetSentence("summary", "absent");
    expect(sentence).toContain("요약은 쉬고");
    expect(sentence).toContain("정해진 문구");
    const withKey = defaultAiUnsetSentence("summary", "present");
    expect(withKey).toContain("첫 인사는 팀 AI 키 맨 위 키로");
    expect(withKey).toContain("채널 요약은 여기서 고를 때까지 만들지 않아요");
    // 채널 요약이 팀 키로 답한다는 말이 어디에도 없다.
    expect(withKey).not.toMatch(/채널 요약[^.]*팀 AI 키로 (답|나)/);
  });

  it("모르는 상태(hidden·loading·error)에서는 키가 있다 없다를 단정하지 않는다", () => {
    for (const status of ["hidden", "loading", "error"] as const) {
      expect(defaultAiUnsetSentence("teamAgent", status)).not.toContain("없어");
      expect(defaultAiUnsetSentence("summary", status)).not.toContain("없어");
    }
  });
});

describe("키 표의 보조 계산", () => {
  it("회사 이름: 아는 주소만 이름을 붙이고 모르는 주소는 주소 그대로", () => {
    expect(teamKeyCompany("https://api.anthropic.com/v1")).toEqual({ name: "Anthropic", models: "Claude 모델" });
    expect(teamKeyCompany("https://api.openai.com/v1")).toEqual({ name: "OpenAI", models: "GPT 모델" });
    expect(teamKeyCompany("https://gateway.corp.example/v1")).toEqual({ name: "gateway.corp.example", models: null });
  });

  it("쓰는 곳: 맨 위 키는 고르지 않은 기능을 모두 받고, 채널 요약은 고른 자리에서만 돈다", () => {
    expect(teamKeyFeatureUses(0, { teamAgent: null, summary: null })).toEqual([
      "말로 앱 설정 바꾸기",
      "팀 에이전트의 답",
      "첫 인사",
    ]);
    expect(teamKeyFeatureUses(1, { teamAgent: null, summary: null })).toEqual([]);
    expect(teamKeyFeatureUses(1, { teamAgent: 1, summary: 1 })).toEqual(["팀 에이전트의 답", "첫 인사", "채널 요약"]);
    // 줄을 다른 자리로 옮기면 맨 위 키는 그 기능을 잃는다.
    expect(teamKeyFeatureUses(0, { teamAgent: 1, summary: 1 })).toEqual(["말로 앱 설정 바꾸기"]);
    expect(teamKeyFeatureUses(0, { teamAgent: 0, summary: 0 })).toContain("채널 요약");
  });
});

describe("문구 규칙", () => {
  it("옛 말·줄표·티켓 번호가 없다", () => {
    const rows: AiDefaultRowId[] = AI_HUB_DEFAULT_ROWS.map((row) => row.rowId);
    const texts: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") texts.push(value);
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
    };
    walk(AI_TEAM_KEYS_COPY);
    for (const row of AI_HUB_DEFAULT_ROWS) texts.push(row.feature, row.hint, row.servesText);
    for (const id of rows) {
      for (const status of Object.keys(STATES) as AiDefaultsTeamKey["status"][]) texts.push(defaultAiUnsetSentence(id, status));
    }
    for (const text of texts) {
      expect(findLegacyTerms(text), text).toEqual([]);
      expect(text, text).not.toMatch(/[—–]/);
      expect(text, text).not.toMatch(/#\d{3,}/);
    }
  });
});
