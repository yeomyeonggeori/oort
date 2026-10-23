import { describe, expect, it } from "vitest";
import type { RosterMember } from "../../lib/api";
import {
  personalCallTarget,
  type PersonalCallCandidate,
  type PersonalCallReach,
} from "./personalCall";

// 웹과 폰은 보내기에서 「내 개인 에이전트 호출」을 가르는 규칙이 이미 다르고, 두 트리의 기존 시험이 각각
// 그것을 고정하고 있다(웹 `personalAgentCalling.test.ts`: 문장 속 `@별칭`도 호출이다 / 폰
// `personalAgentCall.test.tsx`: 문장 속 언급은 부름이 아니다). 이 시험은 두 기대값을 그대로 옮겨 코어의
// 두 `reach`가 각각을 정확히 재현함을 잰다. 한쪽 규칙으로 통일하는 것은 제품 결정이라 여기서 하지 않는다.

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-00000000000a";
const TEAMMATE = "00000000-0000-7000-8000-00000000000b";
const MY_AGENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const THEIR_AGENT = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const PLAIN_AGENT = "cccccccc-1111-4111-8111-cccccccccccc";

function member(fields: Partial<RosterMember> & { id: string; handle: string }): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: fields.handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...fields,
  };
}

const MEMBERS: RosterMember[] = [
  member({ id: ME, handle: "seongjae" }),
  member({ id: TEAMMATE, handle: "mate" }),
  member({ id: MY_AGENT, kind: "agent", handle: "my-claude", aliases: ["claude", "클로드"] }),
  member({ id: THEIR_AGENT, kind: "agent", handle: "mate-claude" }),
  member({ id: PLAIN_AGENT, kind: "agent", handle: "hermes" }),
];

// 호출부가 자기 규칙으로 좁힌 후보: 내 개인 에이전트 하나뿐이다.
const MINE: PersonalCallCandidate = { memberId: MY_AGENT, handle: "my-claude", harness: "claude" };

function target(
  body: string,
  reach: PersonalCallReach,
  options: { dmAgentId?: string | null; candidates?: PersonalCallCandidate[]; members?: RosterMember[] } = {}
): PersonalCallCandidate | null {
  return personalCallTarget({
    body,
    members: options.members ?? MEMBERS,
    candidates: options.candidates ?? [MINE],
    dmAgentId: options.dmAgentId ?? null,
    reach,
  });
}

describe("reach: leading (the phone's rule)", () => {
  it("calls my agent for a handle at the very start of the text", () => {
    expect(target("@my-claude 로그인 버그 봐줘", "leading")).toEqual(MINE);
    expect(target("  @my-claude 앞의 공백은 괜찮다", "leading")).toEqual(MINE);
    expect(target("@MY-CLAUDE 대소문자는 접힌다", "leading")).toEqual(MINE);
  });

  it("does not call for a mention inside a sentence: 「저는 @별칭 쓰는 중」 must not raise the signature", () => {
    expect(target("이거 @my-claude 가 봐줘", "leading")).toBeNull();
    expect(target("먼저 @my-claude 에게 로그를 물어봐", "leading")).toBeNull();
  });

  it("does not read an alias as a handle, only the exact handle", () => {
    expect(target("@claude 봐줘", "leading")).toBeNull();
    expect(target("@클로드 봐줘", "leading")).toBeNull();
  });

  it("calls my agent in a 1:1 DM without any mention, and not a teammate's agent", () => {
    expect(target("봐줘", "leading", { dmAgentId: MY_AGENT })).toEqual(MINE);
    expect(target("봐줘", "leading", { dmAgentId: THEIR_AGENT })).toBeNull();
  });

  it("answers the DM peer before a leading mention (the phone checks the peer first)", () => {
    const other: PersonalCallCandidate = { memberId: PLAIN_AGENT, handle: "hermes", harness: "codex" };
    const result = target("@hermes 봐줘", "leading", {
      dmAgentId: MY_AGENT,
      candidates: [MINE, other],
    });
    expect(result).toEqual(MINE);
  });

  it("never calls for a teammate's agent, a general agent or a person, however it is mentioned", () => {
    expect(target("@mate-claude 봐줘", "leading")).toBeNull();
    expect(target("@hermes 봐줘", "leading")).toBeNull();
    expect(target("@mate 봐줘", "leading")).toBeNull();
    expect(target("멘션 없음", "leading")).toBeNull();
  });
});

describe("reach: anywhere (the web's rule)", () => {
  it("calls my agent for a mention anywhere in the text, aliases included", () => {
    expect(target("@my-claude 빌드를 봐 줘", "anywhere")).toEqual(MINE);
    expect(target("먼저 @my-claude 에게 로그를 물어봐", "anywhere")).toEqual(MINE);
    // 서버가 등록한 별칭도 그 멤버를 부른다(ADR-0201 v2 H2).
    expect(target("먼저 @claude 에게 물어봐", "anywhere")).toEqual(MINE);
  });

  it("does not call for a teammate's agent, a general agent, a person or an unknown handle", () => {
    expect(target("@mate-claude 빌드를 봐 줘", "anywhere")).toBeNull();
    expect(target("@hermes 안녕", "anywhere")).toBeNull();
    expect(target("@mate 안녕", "anywhere")).toBeNull();
    expect(target("@nobody 안녕", "anywhere")).toBeNull();
    expect(target("그냥 대화", "anywhere")).toBeNull();
  });

  it("falls back to the DM peer when the text names nobody, and not for a teammate's agent", () => {
    expect(target("빌드를 봐 줘", "anywhere", { dmAgentId: MY_AGENT })).toEqual(MINE);
    expect(target("빌드를 봐 줘", "anywhere", { dmAgentId: THEIR_AGENT })).toBeNull();
  });

  it("lets a mention win over the DM peer when both are mine (the web reads mentions first)", () => {
    const other: PersonalCallCandidate = { memberId: PLAIN_AGENT, handle: "hermes", harness: "codex" };
    const result = target("@hermes 봐줘", "anywhere", { dmAgentId: MY_AGENT, candidates: [MINE, other] });
    expect(result).toEqual(other);
  });
});

describe("both reaches", () => {
  it("never calls for an empty or blank text, even in a DM with my agent (the empty reason is the honest one)", () => {
    for (const reach of ["anywhere", "leading"] as const) {
      expect(target("", reach, { dmAgentId: MY_AGENT }), reach).toBeNull();
      expect(target("   \n ", reach, { dmAgentId: MY_AGENT }), reach).toBeNull();
    }
  });

  it("calls nobody when the host narrowed the candidates to none", () => {
    for (const reach of ["anywhere", "leading"] as const) {
      expect(target("@my-claude 봐줘", reach, { candidates: [], dmAgentId: MY_AGENT }), reach).toBeNull();
    }
  });

  it("compares member ids ignoring letter case, like every id on the wire", () => {
    for (const reach of ["anywhere", "leading"] as const) {
      expect(
        target("@my-claude 봐줘", reach, {
          candidates: [{ ...MINE, memberId: MY_AGENT.toUpperCase() }],
          dmAgentId: MY_AGENT.toLowerCase(),
        })?.handle,
        reach
      ).toBe("my-claude");
    }
  });

  it("only judges: it returns the target and sends nothing (the judgment the phone's tryCall mixed with sending)", () => {
    const result = target("@my-claude 봐줘", "leading");
    expect(result).toEqual({ memberId: MY_AGENT, handle: "my-claude", harness: "claude" });
  });
});
