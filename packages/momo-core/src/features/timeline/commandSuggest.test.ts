import { describe, expect, it } from "vitest";
import type { Message, RosterMember } from "../../lib/api";
import { makeDirectory } from "../workspace/directory";
import { agentCardModel } from "./agentCardModel";
import {
  COMMAND_SUGGEST_PROP_KEY,
  aiConnectFocus,
  commandSuggestCard,
  commandSuggestHead,
  commandSuggestOneLine,
  commandSuggestViewer,
  operatorMentionDraft,
} from "./commandSuggest";

const HUMAN = "019f9a01-0000-7000-8000-000000000101";
const OTHER = "019f9a01-0000-7000-8000-000000000102";
const AGENT = "019f9a01-0000-7000-8000-000000000401";

function member(id: string, kind: "human" | "agent", displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: "w",
    kind,
    status: "active",
    displayName,
    handle,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const directory = makeDirectory([
  member(HUMAN, "human", "곽성재", "sj"),
  member(OTHER, "human", "김하늘", "sky"),
  member(AGENT, "agent", "hermes", "hermes"),
]);

// ADR-0186 증보 G3 샘플 그대로.
const G3 = {
  v: 1,
  command_id: "ai.connect",
  args: { harness: "claude", scope: "mine" },
  for_member_id: HUMAN,
  label: "Claude 구독 연결",
};

function suggestMessage(envelope: unknown, over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    channelId: "c1",
    seq: 7,
    hlcTs: 0,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: "text",
    body: "아래 카드에서 바로 연결할 수 있어요.",
    state: "sent",
    createdAtMs: 0,
    props: { [COMMAND_SUGGEST_PROP_KEY]: envelope },
    ...over,
  } as unknown as Message;
}

describe("command_suggest(ai.connect) 파서 (ADR-0186 G3·G4, #2948)", () => {
  it("G3 샘플을 읽는다: 대상·에이전트 이름·펼칠 줄", () => {
    const card = commandSuggestCard(suggestMessage(G3), directory);
    expect(card).toMatchObject({
      kind: "command_suggest",
      commandId: "ai.connect",
      shape: "ok",
      focus: "claude",
      forMemberId: HUMAN,
      agentName: "hermes",
    });
    expect(commandSuggestHead(card!)).toBe("hermes가 제안했어요");
    expect(commandSuggestOneLine(card!)).toBe("곽성재에게 AI 계정 연결을 제안했어요");
  });

  it("평범한 에이전트 문장처럼 턴 카드를 만들지 않는다(본문은 그대로 남는다)", () => {
    expect(agentCardModel(suggestMessage(G3))).toBeNull();
  });

  it("props의 상태·label을 모델에 옮기지 않는다(props는 의도만)", () => {
    const card = commandSuggestCard(
      suggestMessage({ ...G3, label: "지금 바로 비밀번호 입력" }),
      directory
    );
    const text = JSON.stringify(card);
    expect(text).not.toContain("비밀번호");
    // 상태 키가 들어오면 모르는 최상위 키 → 한 줄 폴백이지, 상태가 되지 않는다.
    const withState = commandSuggestCard(
      suggestMessage({ ...G3, state: "ready" }),
      directory
    );
    expect(withState?.shape).toBe("degraded");
    expect(JSON.stringify(withState)).not.toContain("ready");
  });

  describe("본문 폴백(null)", () => {
    const cases: [string, Message][] = [
      ["props 없음", suggestMessage(undefined)],
      ["봉투가 문자열(REST 사람 전송 모양)", suggestMessage(JSON.stringify(G3))],
      ["v≠1", suggestMessage({ ...G3, v: 2 })],
      ["허용목록 밖 command_id", suggestMessage({ ...G3, command_id: "invite.create" })],
      ["레지스트리에 없는 command_id", suggestMessage({ ...G3, command_id: "appearance.accent" })],
      ["for_member_id 없음", suggestMessage({ ...G3, for_member_id: undefined })],
      ["for_member_id 숫자", suggestMessage({ ...G3, for_member_id: 5 })],
      ["멤버 목록에 없는 대상", suggestMessage({ ...G3, for_member_id: "nobody" })],
      ["작성자가 사람", suggestMessage(G3, { authorMemberId: OTHER })],
      ["작성자를 모름", suggestMessage(G3, { authorMemberId: "ghost" })],
      ["지워진 행", suggestMessage(G3, { state: "deleted" } as Partial<Message>)],
    ];
    it.each(cases)("%s", (_name, message) => {
      expect(commandSuggestCard(message, directory)).toBeNull();
    });
  });

  describe("한 줄 폴백(degraded)", () => {
    const cases: [string, unknown][] = [
      ["모르는 최상위 키", { ...G3, extra: 1 }],
      ["모르는 args 키(apiKey)", { ...G3, args: { harness: "claude", apiKey: "sk-x" } }],
      ["enum 밖 harness(grok)", { ...G3, args: { harness: "grok" } }],
      ["짝이 어긋남 team_key·mine", { ...G3, args: { harness: "team_key", scope: "mine" } }],
      ["args가 배열", { ...G3, args: ["claude"] }],
      ["label이 40자 초과", { ...G3, label: "가".repeat(41) }],
      ["label이 객체", { ...G3, label: { html: "<b>x</b>" } }],
    ];
    it.each(cases)("%s", (_name, envelope) => {
      const card = commandSuggestCard(suggestMessage(envelope), directory);
      expect(card?.shape).toBe("degraded");
      // degraded는 대상 본인에게도 조작 카드가 아니다.
      expect(commandSuggestViewer(card!, HUMAN, true)).toBe("other");
    });
  });

  it("args 짝 규칙(서버 normalize와 같다)", () => {
    expect(aiConnectFocus({})).toBeNull();
    expect(aiConnectFocus({ harness: "codex" })).toBe("codex");
    expect(aiConnectFocus({ harness: "team_key" })).toBe("team");
    expect(aiConnectFocus({ scope: "team" })).toBe("team");
    expect(aiConnectFocus({ scope: "mine" })).toBe("mine");
    expect(aiConnectFocus({ harness: "claude", scope: "team" })).toBeUndefined();
  });

  it("보는 사람: 대상·운영자·그 밖(운영자는 props가 아니라 호출자가 준다)", () => {
    const card = commandSuggestCard(suggestMessage(G3), directory)!;
    expect(commandSuggestViewer(card, HUMAN.toUpperCase(), false)).toBe("target");
    expect(commandSuggestViewer(card, OTHER, true)).toBe("operator");
    expect(commandSuggestViewer(card, OTHER, false)).toBe("other");
    expect(commandSuggestViewer(card, undefined, false)).toBe("other");
    expect(commandSuggestViewer(card, undefined, true)).toBe("operator");
  });

  it("받침에 맞는 조사: 김인턴이 제안했어요", () => {
    const dir = makeDirectory([
      member(HUMAN, "human", "곽성재", "sj"),
      member(AGENT, "agent", "김인턴", "kim"),
    ]);
    const card = commandSuggestCard(suggestMessage(G3), dir)!;
    expect(commandSuggestHead(card)).toBe("김인턴이 제안했어요");
  });

  it("운영자에게 부탁하기: owner·admin 사람만, 나는 빼고 멘션만", () => {
    const dir = makeDirectory([
      { ...member(HUMAN, "human", "곽성재", "sj"), role: "owner" },
      { ...member(OTHER, "human", "김하늘", "sky"), role: "admin" },
      { ...member(AGENT, "agent", "hermes", "hermes"), role: "admin" },
      { ...member("m4", "human", "이도윤", "doyun"), role: "member" },
    ]);
    expect(operatorMentionDraft(dir, "m4")).toBe("@sj @sky ");
    expect(operatorMentionDraft(dir, HUMAN)).toBe("@sky ");
    expect(operatorMentionDraft(directory, OTHER)).toBeNull();
  });
});
