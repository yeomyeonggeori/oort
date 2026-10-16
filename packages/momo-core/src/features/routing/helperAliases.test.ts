// ADR-0201 증보 v2 H2 (#3893): 도우미 별칭 `@oort`·`@오르트`·`@claude` 의 화면 쪽 규칙.
import { describe, expect, it } from "vitest";
import type { RosterMember } from "../../lib/api";
import {
  aliasHint,
  asciiAliases,
  matchedAlias,
  mentionableNames,
  mentionHandleLabel,
  parseAliases,
  preferredMentionName,
} from "./helperAliases";
import { mentionedAgents } from "./mentionTargets";

function member(over: Partial<RosterMember>): RosterMember {
  return {
    id: "m-x",
    workspaceId: "ws",
    kind: "human",
    status: "active",
    displayName: "김하늘",
    handle: "haneul",
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  };
}

const helper = member({
  id: "m-helper",
  kind: "agent",
  displayName: "oort 도우미",
  handle: "oort-helper",
  aliases: ["oort", "오르트", "claude"],
});
const grok = member({ id: "m-grok", kind: "agent", displayName: "그록봇", handle: "grokbot" });
const human = member({});

describe("parseAliases", () => {
  it("핸들 글자와 한글 음절 2~16자만 남기고 NFC·소문자로 맞춘다", () => {
    expect(parseAliases(["OORT", "오르트", "a", "has space", "x".repeat(17), 3, "oort"])).toEqual([
      "oort",
      "오르트",
    ]);
    // 분해된 한글(NFD)도 같은 별칭이다.
    expect(parseAliases(["오르트".normalize("NFD")])).toEqual(["오르트"]);
  });

  it("배열이 아니거나 남는 것이 없으면 null(칸 없음과 같다)", () => {
    expect(parseAliases("oort")).toBeNull();
    expect(parseAliases([])).toBeNull();
    expect(parseAliases(["!"])).toBeNull();
  });
});

describe("별칭이 없는 서버(옛 서버)", () => {
  const plain = member({ id: "m-helper", kind: "agent", handle: "oort-helper", displayName: "oort 도우미" });
  it("넣는 이름·힌트·멘션 이름이 핸들 그대로다", () => {
    expect(preferredMentionName(plain)).toBe("oort-helper");
    expect(aliasHint(plain, "oo")).toBe("oort 도우미");
    expect(mentionHandleLabel(plain, "oo")).toBe("@oort-helper");
    expect(matchedAlias(plain, "oo")).toBeNull();
    expect([...mentionableNames([plain, human])].sort()).toEqual(["haneul", "oort-helper"]);
  });
});

describe("별칭이 있는 도우미", () => {
  it("넣는 이름은 첫 ASCII 별칭이다(한글 별칭은 멘션 문법이 못 읽는다)", () => {
    expect(preferredMentionName(helper)).toBe("oort");
    expect(asciiAliases(helper)).toEqual(["oort", "claude"]);
    const koreanOnly = { ...helper, aliases: ["오르트"] };
    expect(preferredMentionName(koreanOnly)).toBe("oort-helper");
  });

  it("질의가 한글 별칭을 맞추면 후보 줄이 그 별칭을 보인다", () => {
    expect(matchedAlias(helper, "오르")).toBe("오르트");
    expect(mentionHandleLabel(helper, "오르")).toBe("@oort · @오르트");
    expect(aliasHint(helper, "오르")).toBe("oort 도우미 · @오르트");
    expect(mentionHandleLabel(helper, "oo")).toBe("@oort");
  });

  it("빈 질의는 별칭을 맞추지 않는다", () => {
    expect(matchedAlias(helper, "")).toBeNull();
    expect(aliasHint(helper, "")).toBe("oort 도우미 · @오르트");
  });

  it("타임라인 멘션 색 집합에 ASCII 별칭이 든다", () => {
    expect(mentionableNames([helper]).has("oort")).toBe(true);
    expect(mentionableNames([helper]).has("claude")).toBe(true);
    expect(mentionableNames([helper]).has("오르트")).toBe(false);
  });

  it("멈춘(비활성) 도우미의 별칭은 아무도 부르지 않는다", () => {
    expect(asciiAliases({ ...helper, status: "suspended" })).toEqual([]);
  });
});

describe("mentionedAgents 와 별칭 (H2-6·H2-7)", () => {
  it("@oort 는 도우미를 부르고, 한 멤버를 두 이름으로 불러도 한 번이다", () => {
    const called = mentionedAgents("@oort @oort-helper 오늘 회의 요약해 줘", [helper, grok]);
    expect(called.map((row) => row.id)).toEqual(["m-helper"]);
  });

  it("@grokbot 만 부른 글에서 도우미는 불리지 않는다(부른 동료만)", () => {
    expect(mentionedAgents("@grokbot 이거 봐 줘", [helper, grok]).map((row) => row.id)).toEqual([
      "m-grok",
    ]);
  });

  it("실제 멤버가 그 이름을 핸들로 쓰면 별칭은 아무도 부르지 않는다(H2-4)", () => {
    const realClaude = member({ id: "m-claude", kind: "human", handle: "claude", displayName: "클로드 사람" });
    // 사람 핸들이라 에이전트 라우팅에는 아무도 안 걸린다. 도우미가 가로채면 실패한다.
    expect(mentionedAgents("@claude 안녕", [helper, realClaude])).toEqual([]);
    const agentClaude = member({ id: "m-claude-agent", kind: "agent", handle: "claude" });
    expect(mentionedAgents("@claude 안녕", [helper, agentClaude]).map((row) => row.id)).toEqual([
      "m-claude-agent",
    ]);
  });
});
