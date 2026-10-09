import { describe, expect, it } from "vitest";
import type { HostedAgentConnection } from "@momo/core/features/hostedAgents/model";
import type { RosterMember } from "@momo/core/lib/api";
import {
  READ_LOADING,
  accountsCard,
  agentsCard,
  externalAgentCount,
  externalCard,
  loginNudge,
  teamKeysCard,
} from "./aiHubOverviewModel";

const texts = (card: { chips: { text: string }[] }) => card.chips.map((chip) => chip.text);

function agent(id: string): RosterMember {
  return { id, kind: "agent", displayName: id, handle: id } as unknown as RosterMember;
}
function conn(agentMemberId: string, extra: Partial<HostedAgentConnection> = {}): HostedAgentConnection {
  return { id: `c-${agentMemberId}`, agentMemberId, ...extra } as unknown as HostedAgentConnection;
}

describe("내 AI 계정 카드", () => {
  it("웹은 로그인을 데스크탑에서 한다고 말하고 상태 칩을 지어내지 않는다", () => {
    expect(texts(accountsCard({ kind: "web" }))).toEqual(["로그인은 데스크탑 앱에서 해요"]);
    expect(loginNudge({ kind: "web" })).toBe(false);
  });

  it("데스크탑은 감지 결과를 그대로 말한다", () => {
    const input = {
      kind: "desktop" as const,
      probes: [
        { id: "claude" as const, installed: true, auth: "logged_in" as const },
        { id: "codex" as const, installed: true, auth: "needs_login" as const },
      ],
    };
    expect(texts(accountsCard(input))).toEqual(["Claude Code 연결됨", "Codex 다시 인증"]);
    expect(loginNudge(input)).toBe(true);
  });

  it("미설치와 모름은 로그인 필요로 읽지 않는다", () => {
    const input = {
      kind: "desktop" as const,
      probes: [
        { id: "claude" as const, installed: false, auth: "unknown" as const },
        { id: "codex" as const, installed: true, auth: "unknown" as const },
      ],
    };
    expect(texts(accountsCard(input))).toEqual(["Claude Code 설치 안 됨", "Codex 확인 못 했어요"]);
    expect(loginNudge(input)).toBe(false);
  });

  it("감지 전에는 확인하는 중이라고만 한다", () => {
    expect(texts(accountsCard({ kind: "desktop", probes: null }))).toEqual(["확인하는 중이에요"]);
  });
});

describe("팀 AI 키 카드", () => {
  it("권한이 없으면 숫자나 상태 대신 운영자 안내를 낸다", () => {
    const card = teamKeysCard({ state: "denied" });
    expect(card.chips).toEqual([]);
    expect(card.note).toContain("운영자만 보고 바꿀 수 있어요");
  });
  it("연결됨과 없음", () => {
    expect(texts(teamKeysCard({ state: "ok", value: { configured: true, format: "anthropic" } }))).toEqual(["Anthropic 연결됨"]);
    expect(texts(teamKeysCard({ state: "ok", value: { configured: true, format: null } }))).toEqual(["연결됨"]);
    expect(texts(teamKeysCard({ state: "ok", value: { configured: false, format: null } }))).toEqual(["아직 없어요"]);
  });
  it("못 읽으면 없다고 하지 않고 못 읽었다고 한다", () => {
    expect(texts(teamKeysCard({ state: "error" }))).toEqual(["읽지 못했어요"]);
    expect(texts(teamKeysCard(READ_LOADING))).toEqual(["확인하는 중이에요"]);
  });
});

describe("에이전트 카드", () => {
  const roster = { state: "ok" as const, value: [agent("a"), agent("b"), agent("c")] };

  it("연결 목록으로 나만 부름과 모두 부름을 센다. 맥 꺼짐 칩은 만들지 않는다", () => {
    const card = agentsCard({
      roster,
      connections: {
        state: "ok",
        value: [conn("a", { invocationScope: "owner_only", subscriptionHarness: "claude_code" }), conn("b", { invocationScope: "workspace" })],
      },
    });
    expect(card.badge).toBe("3명");
    expect(texts(card)).toEqual(["나만 부름 1", "모두 부름 2"]);
  });

  it("연결 목록을 못 읽으면 누가 부르는지 모르고, 모두 부름으로 세지 않는다", () => {
    const card = agentsCard({ roster, connections: { state: "denied" } });
    expect(texts(card)).toEqual(["쓰는 AI를 아직 몰라요 3"]);
  });

  it("명부를 못 읽으면 인원 숫자를 내지 않는다", () => {
    const card = agentsCard({ roster: { state: "error" }, connections: READ_LOADING });
    expect(card.badge).toBeNull();
    expect(texts(card)).toEqual(["읽지 못했어요"]);
  });
});

describe("외부 연결 카드", () => {
  it("모두 읽었을 때만 합계를 낸다", () => {
    const ok = (n: number) => ({ state: "ok" as const, value: n });
    const card = externalCard({ apps: ok(2), incoming: ok(1), outgoing: ok(2), externalAgents: ok(1) });
    expect(card.badge).toBe("6개");
    expect(texts(card)).toEqual(["앱 2", "채널로 들어오는 주소 1", "밖으로 보내는 알림 2", "외부 에이전트 연결 1"]);
  });

  it("권한 없음과 못 읽음은 0이 아니고 합계도 막는다", () => {
    const ok = (n: number) => ({ state: "ok" as const, value: n });
    const card = externalCard({ apps: ok(2), incoming: { state: "denied" }, outgoing: { state: "error" }, externalAgents: READ_LOADING });
    expect(card.badge).toBeNull();
    expect(texts(card)).toEqual(["앱 2", "채널로 들어오는 주소 소유자·관리자만 볼 수 있어요", "밖으로 보내는 알림 읽지 못했어요", "외부 에이전트 연결 확인하는 중이에요"]);
  });

  it("내 구독 연결은 외부 에이전트로 세지 않는다", () => {
    const live = { status: "active" as const };
    expect(
      externalAgentCount([
        conn("a", { ...live, invocationScope: "owner_only" }),
        conn("b", { ...live, invocationScope: "workspace" }),
        conn("c", live),
        conn("d", { status: "expired" }),
      ])
    ).toBe(2);
  });
});
