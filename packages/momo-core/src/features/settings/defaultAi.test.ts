import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  defaultAiFromWire,
  defaultAiPutBody,
  linkUnresolvedSentence,
  probeModelLists,
  TEAM_DEFAULT_UNSET_LABEL,
  teamDefaultSaveMessage,
  teamModelNote,
  teamOptions,
  type TeamDefaultAiRow,
} from "./defaultAi";

// #3042: 기본 AI 표의 팀 줄이 서버(#3009)에 저장된다. 판정이 지는 것:
// 선택지는 연결 확인의 modelIds 에서만, 팀 줄 본문에 개인 구독 자리가 없음,
// linkResolved:false 는 문장으로.

const PROBE = {
  schema: "momo.provider_link.test.v0",
  ok: true,
  entries: [
    {
      position: 0,
      endpointLabel: "https://api.openai.com/v1",
      probe: { outcome: "ok", method: "models", modelIds: ["gpt-4o", "gpt-4o-mini", "gpt-4o"] },
    },
    {
      position: 2,
      endpointLabel: "https://openrouter.ai/api/v1",
      probe: { outcome: "ok", method: "key" },
    },
    {
      position: 1,
      endpointLabel: "https://api.anthropic.com/v1",
      probe: {
        outcome: "ok",
        method: "models",
        // 모양이 틀린 id(공백·href 모양·너무 긺)는 화면에 오지 않는다.
        modelIds: ["claude-sonnet-4", "bad id", "javascript:alert(1)x".repeat(5), 7],
        modelIdsTruncated: true,
      },
    },
  ],
};

const SAVED: TeamDefaultAiRow = {
  linkPosition: 0,
  endpointLabel: "https://api.openai.com/v1",
  linkResolved: true,
  modelId: "gpt-4o",
};

describe("defaultAiFromWire", () => {
  it("reads both rows and a null row", () => {
    expect(
      defaultAiFromWire({
        schema: "momo.provider.default_ai.v0",
        teamAgent: { ...SAVED, source: "team_link", updatedBy: null, updatedAtMs: 1 },
        summary: null,
        guardrail: { mode: "off", available: false },
      })
    ).toEqual({ teamAgent: SAVED, summary: null });
  });

  it("refuses a body it cannot read rather than calling it 'nothing chosen'", () => {
    expect(defaultAiFromWire({ teamAgent: null, summary: null })).toBeNull();
    expect(
      defaultAiFromWire({
        schema: "momo.provider.default_ai.v0",
        teamAgent: { ...SAVED, source: "profile" },
        summary: null,
      })
    ).toBeNull();
    expect(defaultAiFromWire("nope")).toBeNull();
  });
});

describe("model lists come from the connection check only", () => {
  it("keeps sanitized ids per link, in position order, and says when there is no list", () => {
    expect(probeModelLists(PROBE)).toEqual([
      { position: 0, label: "https://api.openai.com/v1", modelIds: ["gpt-4o", "gpt-4o-mini"], truncated: false },
      { position: 1, label: "https://api.anthropic.com/v1", modelIds: ["claude-sonnet-4"], truncated: true },
      { position: 2, label: "https://openrouter.ai/api/v1", modelIds: null, truncated: false },
    ]);
    expect(probeModelLists(null)).toEqual([]);
    expect(probeModelLists({ ok: true })).toEqual([]);
  });

  it("offers only server-named models plus the link default, never an invented name", () => {
    const options = teamOptions("teamAgent", null, probeModelLists(PROBE));
    expect(options.map((option) => option.text)).toEqual([
      TEAM_DEFAULT_UNSET_LABEL.teamAgent,
      "api.openai.com · 기본 모델",
      "api.openai.com · gpt-4o",
      "api.openai.com · gpt-4o-mini",
      "api.anthropic.com · 기본 모델",
      "api.anthropic.com · claude-sonnet-4",
      "openrouter.ai · 기본 모델",
    ]);
    // 확인 전이면 「고르지 않음」 하나뿐이다.
    expect(teamOptions("summary", null, [])).toHaveLength(1);
  });

  it("keeps a saved value that is not in the list, and says why", () => {
    expect(teamOptions("teamAgent", SAVED, []).at(-1)?.text).toBe("api.openai.com · gpt-4o (목록 확인 전)");
    expect(
      teamOptions("teamAgent", { ...SAVED, linkResolved: false }, []).at(-1)?.text
    ).toBe("api.openai.com · gpt-4o (연결이 바뀜)");
    // 목록에 있으면 한 번만.
    const listed = teamOptions("teamAgent", SAVED, probeModelLists(PROBE));
    expect(listed.filter((option) => option.key === "link:0:gpt-4o")).toHaveLength(1);
  });

  it("notes a link with no list and a truncated list", () => {
    const links = probeModelLists(PROBE);
    expect(teamModelNote({ linkPosition: 2, modelId: null }, links)).toBe(
      "이 연결은 모델 목록을 알려 주지 않아요. 기본 모델만 고를 수 있어요."
    );
    expect(teamModelNote({ linkPosition: 1, modelId: null }, links)).toBe("모델이 많아 앞의 1개만 보여요.");
    expect(teamModelNote({ linkPosition: 0, modelId: "gpt-4o" }, links)).toBeNull();
    expect(teamModelNote(null, links)).toBeNull();
  });
});

describe("a team row never carries a personal subscription", () => {
  it("builds the PUT body as a one-row patch with the team_link source only", () => {
    expect(defaultAiPutBody("teamAgent", { linkPosition: 1, modelId: "claude-sonnet-4" })).toEqual({
      teamAgent: { source: "team_link", linkPosition: 1, modelId: "claude-sonnet-4" },
    });
    expect(defaultAiPutBody("summary", null)).toEqual({ summary: null });
  });

  it("has no option whose key or text names a subscription", () => {
    for (const rowId of ["teamAgent", "summary"] as const) {
      for (const option of teamOptions(rowId, SAVED, probeModelLists(PROBE))) {
        expect(option.key).not.toMatch(/profile/);
        expect(option.text).not.toMatch(/구독|Claude ·|ChatGPT/);
      }
    }
  });
});

describe("sentences", () => {
  it("says a moved link out loud", () => {
    expect(linkUnresolvedSentence({ ...SAVED, linkResolved: false })).toBe(
      "고른 연결(api.openai.com)이 연결 순서에서 바뀌었거나 빠졌어요. 다시 골라 주세요."
    );
  });

  it("answers a 403 with who can", () => {
    expect(teamDefaultSaveMessage(new ApiError(403, "forbidden"))).toBe("팀 줄은 이 서버의 운영자만 바꿀 수 있어요.");
    expect(teamDefaultSaveMessage(new Error("x"))).toContain("잠시 뒤에");
  });
});
