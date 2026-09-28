import { describe, expect, it } from "vitest";
import {
  AI_DEFAULT_ROWS,
  AI_DEFAULT_ROW_IDS,
  PERSONAL_ROW_IDS,
  forgetAccount,
  modelLine,
  optionsFor,
  parseAiDefaults,
  resolveRow,
  rowsUsingAccount,
  serializeAiDefaults,
  unlinkImpactLead,
  type AiDefaultsInput,
  type AiDefaultsPrefs,
} from "./aiDefaults";

const accounts: AiDefaultsInput["accounts"] = [
  { harness: "claude", label: null, auth: "logged_in" },
  { harness: "claude", label: "개인", auth: "logged_in" },
  { harness: "claude", label: "회사", auth: "needs_login" },
  { harness: "codex", label: "회사 메인", auth: "logged_in" },
];

const input = (over: Partial<AiDefaultsInput> = {}): AiDefaultsInput => ({
  accounts,
  teamKey: { status: "present", name: "OpenAI", failed: false, modelCount: 12 },
  browserTab: false,
  ...over,
});

describe("기본 AI 표: 팀이 보는 행에 개인 구독은 선택지로 뜨지 않는다 (#2881 수용 기준)", () => {
  const teamRows = AI_DEFAULT_ROWS.filter((row) => row.audience === "team");

  it("팀 행은 셋이다(팀 에이전트·요약·가드레일)", () => {
    expect(teamRows.map((row) => row.id)).toEqual(["teamAgent", "summary", "guardrail"]);
  });

  it.each(teamRows.map((row) => row.id))("%s: 구독이 넷 있어도 구독 선택지 0개", (id) => {
    const options = optionsFor(id, input());
    expect(options.filter((option) => option.ref.kind === "profile")).toEqual([]);
  });

  it("팀 행의 선택지는 팀 키뿐이다(가드레일은 채팅 자격이 하나도 없다)", () => {
    expect(optionsFor("teamAgent", input()).map((o) => o.key)).toEqual(["teamKey"]);
    expect(optionsFor("summary", input()).map((o) => o.key)).toEqual(["teamKey"]);
    expect(optionsFor("guardrail", input())).toEqual([]);
  });

  it("같은 입력에서 개인 행은 구독을 받는다(거르는 것이 입력 결함이 아님을 보인다)", () => {
    const local = optionsFor("localTerminal", input());
    expect(local.filter((o) => o.ref.kind === "profile")).toHaveLength(4);
  });

  it("팀 키가 없을 때 팀 에이전트는 구독으로 넘어가지 않고 대답할 수 없다고 말한다", () => {
    const result = resolveRow("teamAgent", {}, input({ teamKey: { status: "absent" } }));
    expect(result.state).toBe("blocked");
    expect(result.using).toBe("대답할 수 없음");
    if (result.state !== "ok") expect(result.sentence).toContain("내 구독으로 넘어가지 않아요");
    expect(JSON.stringify(result)).not.toMatch(/Claude|ChatGPT|개인|회사/);
  });

  it("앱 명령은 결재(Q4) 전이라 구독이 선택지에 없다", () => {
    expect(optionsFor("appCommand", input()).map((o) => o.key)).toEqual(["teamKey"]);
  });
});

describe("개인 행 선택지와 모델 줄", () => {
  it("기본 로그인이 먼저, 라벨은 가나다순, 로그인 필요는 이유를 단다", () => {
    const names = optionsFor("localTerminal", input()).map((o) => [o.name, o.unavailable]);
    expect(names).toEqual([
      ["Claude · 이 맥 기본 로그인", null],
      ["Claude · 개인", null],
      ["Claude · 회사", "로그인 필요"],
      ["ChatGPT · 회사 메인", null],
    ]);
  });

  it("브라우저 탭에는 구독 선택지가 없다", () => {
    expect(optionsFor("localTerminal", input({ browserTab: true }))).toEqual([]);
  });

  it("운영자가 아니면(403) 팀 키가 있다고도 없다고도 하지 않는다", () => {
    const hidden = input({ teamKey: { status: "hidden" } });
    expect(optionsFor("appCommand", hidden)[0]?.name).toBe("팀 API 키");
    expect(resolveRow("summary", {}, hidden)).toEqual({ state: "ok", using: "팀 API 키", note: null });
  });

  it("모델 이름을 지어내지 않는다: 구독은 CLI 기본값, 팀 키는 서버가 준 개수만", () => {
    const team = { status: "present", name: "OpenAI", failed: false, modelCount: 12 } as const;
    expect(modelLine({ kind: "profile", harness: "claude", label: "개인" }, team)).toBe("모델은 CLI 기본값");
    expect(modelLine({ kind: "teamKey" }, team)).toBe("모델은 서버가 정함 · 이 키로 쓸 수 있는 모델 12개");
    expect(modelLine({ kind: "teamKey" }, { ...team, modelCount: null })).toBe("모델은 서버가 정함");
  });
});

describe("폴백: 저장 값을 조용히 바꾸지 않고 문장으로 말한다", () => {
  const prefs: AiDefaultsPrefs = {
    localTerminal: { kind: "profile", harness: "claude", label: "회사" },
    remoteWork: { kind: "profile", harness: "claude", label: "지운 계정" },
  };

  it("로그인 필요 계정 → 셸로 넘어간다고 이름과 함께 말한다", () => {
    const result = resolveRow("localTerminal", prefs, input());
    expect(result).toEqual({
      state: "fallback",
      using: "셸",
      sentence: "「Claude · 회사」 계정이 로그인 필요라 새 세션은 셸로 열어요. 다시 로그인하면 돌아와요.",
    });
  });

  it("목록에서 사라진 계정 → 매번 묻기", () => {
    const result = resolveRow("remoteWork", prefs, input());
    expect(result.state).toBe("fallback");
    expect(result.using).toBe("매번 묻기");
  });

  it("쓸 수 있으면 그 계정 이름을 쓴다", () => {
    const ok = resolveRow("localTerminal", { localTerminal: { kind: "profile", harness: "claude", label: "개인" } }, input());
    expect(ok).toEqual({ state: "ok", using: "Claude · 개인", note: null });
  });

  it("팀 키 없음: 앱 명령은 막히고 요약은 정적 문구", () => {
    const none = input({ teamKey: { status: "absent" } });
    expect(resolveRow("appCommand", {}, none).state).toBe("blocked");
    expect(resolveRow("summary", {}, none)).toMatchObject({ state: "fallback", using: "정적 문구" });
    expect(optionsFor("appCommand", none)).toEqual([]);
  });
});

describe("이 기기 저장: 닫힌 형식, 비밀값 없음", () => {
  const full: AiDefaultsPrefs = {
    appCommand: { kind: "teamKey" },
    localTerminal: { kind: "profile", harness: "claude", label: "개인" },
    remoteWork: { kind: "profile", harness: "codex", label: null },
  };

  it("왕복한다", () => {
    expect(parseAiDefaults(serializeAiDefaults(full))).toEqual(full);
  });

  it("저장 값의 필드는 kind·harness·label뿐이고 경로·토큰 모양이 없다", () => {
    const stored = JSON.parse(serializeAiDefaults(full)) as Record<string, Record<string, unknown>>;
    expect(Object.keys(stored).sort()).toEqual([...PERSONAL_ROW_IDS].sort());
    for (const value of Object.values(stored)) {
      for (const key of Object.keys(value)) expect(["kind", "harness", "label"]).toContain(key);
    }
    const text = serializeAiDefaults(full);
    expect(text).not.toMatch(/[/\\]|sk-|token|secret|bearer|CLAUDE_CONFIG_DIR|CODEX_HOME/i);
  });

  it("저장 값에 섞여 들어온 다른 필드(경로·토큰)는 읽을 때 버린다", () => {
    const dirty = JSON.stringify({
      localTerminal: { kind: "profile", harness: "claude", label: "개인", dir: "/Users/x/.claude", token: "sk-1" },
      teamAgent: { kind: "profile", harness: "claude", label: "개인" },
    });
    const parsed = parseAiDefaults(dirty);
    expect(parsed).toEqual({ localTerminal: { kind: "profile", harness: "claude", label: "개인" } });
    expect(serializeAiDefaults(parsed)).not.toContain("/Users");
  });

  it("팀 행과 자격이 맞지 않는 선택은 읽지 않는다(앱 명령에 구독, 터미널에 팀 키)", () => {
    const wrong = JSON.stringify({
      appCommand: { kind: "profile", harness: "claude", label: "개인" },
      localTerminal: { kind: "teamKey" },
    });
    expect(parseAiDefaults(wrong)).toEqual({});
  });

  it("깨진 값은 빈 설정이다", () => {
    expect(parseAiDefaults("{")).toEqual({});
    expect(parseAiDefaults("[]")).toEqual({});
    expect(parseAiDefaults(null)).toEqual({});
  });
});

describe("계정 해제의 영향", () => {
  const prefs: AiDefaultsPrefs = {
    localTerminal: { kind: "profile", harness: "claude", label: "회사" },
    remoteWork: { kind: "profile", harness: "claude", label: "회사" },
  };

  it("그 계정을 고른 행을 이름과 폴백으로", () => {
    const impact = rowsUsingAccount(prefs, { harness: "claude", label: "회사" });
    expect(impact.map((item) => [item.title, item.fallback])).toEqual([
      ["로컬 터미널 새 세션", "셸"],
      ["원격 작업 기본 계정", "매번 묻기"],
    ]);
    expect(unlinkImpactLead(impact)).not.toBeNull();
  });

  it("다른 계정·기본 로그인은 영향이 없다", () => {
    expect(rowsUsingAccount(prefs, { harness: "claude", label: "개인" })).toEqual([]);
    expect(rowsUsingAccount(prefs, { harness: "claude", label: null })).toEqual([]);
    expect(unlinkImpactLead([])).toBeNull();
  });

  it("해제가 끝나면 그 계정 선택만 지운다", () => {
    const next = forgetAccount(
      { ...prefs, appCommand: { kind: "teamKey" } },
      { harness: "claude", label: "회사" }
    );
    expect(next).toEqual({ appCommand: { kind: "teamKey" } });
  });

  it("표의 행 id는 여섯이고 개인 행은 셋이다", () => {
    expect(AI_DEFAULT_ROW_IDS).toHaveLength(6);
    expect(AI_DEFAULT_ROWS.filter((row) => row.audience === "me").map((r) => r.id)).toEqual([
      ...PERSONAL_ROW_IDS,
    ]);
  });
});
