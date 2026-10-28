import { describe, expect, it } from "vitest";
import type { AgentLivenessState, RosterMember } from "../../lib/api";
import { livenessView } from "../agents/liveness";
import {
  AGENT_HOST_ONLINE_LABEL,
  agentDotTone,
  agentHostDot,
  agentLivenessDot,
  dmPeerStatusDot,
  humanPresenceDot,
  statusDotTooltip,
  withOwnConnection,
  type StatusDotTone,
} from "./statusDot";

const NOW = 1_800_000_000_000;

describe("에이전트 생존 판정 → 점 (대응표)", () => {
  // 이 표가 PR 본문의 대응표다. 톤은 `livenessView` 가 정하고(서버 판정을 다시 판정하지 않는다), 점은 그것을 옮긴다.
  // Buzz식(소유자 결정 2026-10-17 「Buzz식: 초록=살아 있음, 회색 고리=꺼짐」): 채운 초록 = 살아 있음(응답함·살아 있음·대기),
  // 속 빈 고리 = 꺼짐(조용함·꺼짐). warn 은 다시 깨울 수 있는 사람(owner/admin)에게만 채운 주황이고 그 밖의 멤버에게는
  // 속 빈 고리로 내려간다.
  const TABLE: ReadonlyArray<
    readonly [AgentLivenessState, StatusDotTone, StatusDotTone]
  > = [
    // 상태, owner/admin 에게, 일반 멤버에게
    ["responsive", "ok", "ok"],
    ["alive_idle", "ok", "ok"],
    ["quiet", "muted", "muted"],
    ["inactive", "muted", "muted"],
    ["work_waiting", "warn", "muted"],
    ["woken_not_collected", "warn", "muted"],
    ["unresponsive", "warn", "muted"],
    ["error", "warn", "muted"],
  ];

  it.each(TABLE)("%s → 관리자 %s · 일반 멤버 %s", (state, forAdmin, forMember) => {
    expect(agentLivenessDot({ state }, NOW, true).tone).toBe(forAdmin);
    expect(agentLivenessDot({ state }, NOW, false).tone).toBe(forMember);
  });

  it("여덟 상태가 전부 표에 있다(서버가 새 상태를 더하면 여기가 빨개진다)", () => {
    const all: AgentLivenessState[] = [
      "responsive",
      "alive_idle",
      "work_waiting",
      "woken_not_collected",
      "quiet",
      "unresponsive",
      "error",
      "inactive",
    ];
    expect(TABLE.map(([state]) => state).sort()).toEqual([...all].sort());
  });

  it("낱말은 생존 라벨의 낱말 그대로이고 뜻을 함께 싣는다", () => {
    const dot = agentLivenessDot({ state: "inactive" }, NOW, false);
    const view = livenessView({ state: "inactive" }, NOW);
    expect(dot.label).toBe(view.text);
    expect(dot.label).toBe("연결이 꺼져 있어요");
    expect(dot.meaning).toBe(view.meaning);
    expect(statusDotTooltip(dot)).toBe(`${view.text}. ${view.meaning}`);
  });

  it("응답함과 살아 있음·대기는 같은 초록이다 — 소유자 결정 2026-10-17 「Buzz식: 초록=살아 있음, 회색 고리=꺼짐」", () => {
    for (const mayAct of [true, false]) {
      expect(agentLivenessDot({ state: "responsive" }, NOW, mayAct).tone).toBe("ok");
      expect(agentLivenessDot({ state: "alive_idle" }, NOW, mayAct).tone).toBe("ok");
    }
    // 둘의 차이는 낱말이 말한다.
    expect(agentLivenessDot({ state: "alive_idle" }, NOW, true).label).toBe("살아 있음 · 대기 중");
    expect(agentLivenessDot({ state: "responsive" }, NOW, true).label).not.toBe("살아 있음 · 대기 중");
  });

  it("**살아 있음과 꺼짐은 다른 점이다** — 낱말이 없는 자리에서 한 점이 되면 「꺼져 있다는 거야?」에 답하지 못한다 (design-review H1)", () => {
    for (const mayAct of [true, false]) {
      const alive = agentLivenessDot({ state: "alive_idle" }, NOW, mayAct);
      const off = agentLivenessDot({ state: "inactive" }, NOW, mayAct);
      expect(alive.tone).toBe("ok");
      expect(off.tone).toBe("muted");
      expect(alive.tone).not.toBe(off.tone);
    }
  });

  it("조용함·꺼짐은 보는 사람과 무관하게 속 빈 고리(꺼짐)다", () => {
    for (const state of ["quiet", "inactive"] as const) {
      for (const mayAct of [true, false]) {
        expect(agentLivenessDot({ state }, NOW, mayAct).tone).toBe("muted");
      }
    }
  });

  it("채운 점은 살아 있는 상태(응답함·살아 있음)뿐이고, 나머지는 전부 속 빈 고리다(일반 멤버 시점)", () => {
    const filled: AgentLivenessState[] = [];
    const hollow: AgentLivenessState[] = [];
    for (const [state, , forMember] of TABLE) {
      (forMember === "muted" ? hollow : filled).push(state);
    }
    expect(filled.sort()).toEqual(["alive_idle", "responsive"]);
    expect(hollow.sort()).toEqual(
      ["error", "inactive", "quiet", "unresponsive", "woken_not_collected", "work_waiting"].sort()
    );
  });

  it("생존 칩이 읽는 함수(agentDotTone)와 점이 같은 톤을 낸다 — 한 상태가 두 자리에서 다른 색이 되지 않는다", () => {
    for (const [state] of TABLE) {
      for (const mayAct of [true, false]) {
        const view = livenessView({ state }, NOW);
        expect(agentDotTone(view, mayAct)).toBe(agentLivenessDot({ state }, NOW, mayAct).tone);
      }
    }
  });

  it("n분은 서버가 알린 마지막 신호에서 온다", () => {
    const dot = agentLivenessDot(
      { state: "responsive", lastSignalAtMs: NOW - 3 * 60_000 },
      NOW,
      false
    );
    expect(dot.label).toBe("응답함 3분 전");
  });
});

describe("생존 판정이 없는 에이전트: 호스트 연결 폴백", () => {
  it("닿아 있을 때만 초록 점이다", () => {
    expect(agentHostDot(true)).toEqual({ tone: "ok", label: AGENT_HOST_ONLINE_LABEL });
    expect(AGENT_HOST_ONLINE_LABEL).toBe("연결됨");
  });

  it("닿아 있지 않거나 모르면 점이 없다 — 근거 없는 회색 오프라인 점을 만들지 않는다", () => {
    expect(agentHostDot(false)).toBeNull();
    expect(agentHostDot(undefined)).toBeNull();
  });
});

describe("사람: 선언 상태가 먼저이고, 선언이 없으면 접속 여부가 정한다 (#4692)", () => {
  it("자리 비움은 warn, 방해 금지는 danger — 접속 여부와 무관하다(선언이 이긴다)", () => {
    for (const online of [undefined, true, false]) {
      expect(humanPresenceDot({ presenceStatus: "away", online }, NOW)).toEqual({
        tone: "warn",
        label: "자리 비움",
      });
      expect(humanPresenceDot({ presenceStatus: "dnd", online }, NOW)).toEqual({
        tone: "danger",
        label: "방해 금지",
      });
    }
  });

  it("방해 금지는 접속 중이어도 방해 금지다 — 「지금 핑 금지」라는 뜻이다(ADR-0160 D3)", () => {
    expect(humanPresenceDot({ presenceStatus: "dnd", online: true }, NOW)?.tone).toBe("danger");
  });

  it("auto 이고 접속 중이면 채운 초록, 접속이 없으면 속 빈 고리 — 에이전트 점과 같은 문법", () => {
    for (const presenceStatus of ["auto", undefined] as const) {
      expect(humanPresenceDot({ presenceStatus, online: true }, NOW)).toEqual({
        tone: "ok",
        label: "온라인",
      });
      expect(humanPresenceDot({ presenceStatus, online: false }, NOW)).toEqual({
        tone: "muted",
        label: "오프라인",
      });
    }
    // 같은 문법이라는 말의 뜻: 초록 = 살아 있다, 고리 = 꺼져 있다. 에이전트의 두 끝과 같은 톤이다.
    expect(humanPresenceDot({ online: true }, NOW)?.tone).toBe(
      agentLivenessDot({ state: "responsive", lastSignalAtMs: NOW }, NOW, false).tone
    );
    expect(humanPresenceDot({ online: false }, NOW)?.tone).toBe(
      agentLivenessDot({ state: "inactive" }, NOW, false).tone
    );
  });

  it("만료된 방해 금지는 선언이 아니다 — 서버는 만료 때 이벤트를 보내지 않으므로 접속 여부로 내려간다", () => {
    const expired = (dndUntilMs: number, online?: boolean) =>
      humanPresenceDot({ presenceStatus: "dnd", dndUntilMs, online }, NOW);
    expect(expired(NOW - 1, true)?.tone).toBe("ok");
    expect(expired(NOW, true)?.tone).toBe("ok"); // 지금 이 순간이 끝이다
    expect(expired(NOW - 1, false)?.tone).toBe("muted");
    expect(expired(NOW + 1, true)?.tone).toBe("danger"); // 아직 진행 중
    // 접속 여부를 모르면 만료된 방해 금지는 점이 없다(예전과 같다).
    expect(expired(NOW - 1)).toBeNull();
    expect(expired(NOW)).toBeNull();
  });

  it("접속 여부를 모르면 점이 없다 — 모름은 꺼짐이 아니다(브로커가 느린 것만으로 모두가 꺼져 보이면 안 된다)", () => {
    expect(humanPresenceDot({ presenceStatus: "auto" }, NOW)).toBeNull();
    expect(humanPresenceDot({ presenceStatus: "auto", online: undefined }, NOW)).toBeNull();
    expect(humanPresenceDot({}, NOW)).toBeNull();
  });
});

describe("withOwnConnection: 자기 행의 접속 여부는 이 클라이언트의 연결이다 (#4692)", () => {
  const SELF = "00000000-0000-7000-8000-0000000000aa";
  const OTHER = "00000000-0000-7000-8000-0000000000bb";

  it("자기 행만 바뀐다: 서버의 online 이 비어 있거나 틀려도 내 연결이 이긴다", () => {
    expect(withOwnConnection({ id: SELF, online: undefined }, SELF, true).online).toBe(true);
    expect(withOwnConnection({ id: SELF, online: false }, SELF, true).online).toBe(true);
    expect(withOwnConnection({ id: SELF, online: true }, SELF, false).online).toBe(false);
  });

  it("남의 행은 그대로다 — 남의 접속은 서버 말이 전부이고, 내 연결 상태가 새어 들어가지 않는다", () => {
    const row = { id: OTHER, online: undefined };
    expect(withOwnConnection(row, SELF, true)).toBe(row);
    expect(withOwnConnection({ id: OTHER, online: false }, SELF, true).online).toBe(false);
  });

  it("id 비교는 대소문자를 따지지 않는다(서버는 대문자, 세션은 소문자일 수 있다)", () => {
    expect(withOwnConnection({ id: SELF.toUpperCase(), online: false }, SELF, true).online).toBe(
      true
    );
  });

  it("그 위에서 점이 그려진다: 내 연결이 끊기면 내 행은 속 빈 고리, 모르는 남의 행은 점이 없다", () => {
    expect(
      humanPresenceDot(withOwnConnection({ id: SELF, online: undefined }, SELF, false), NOW)?.tone
    ).toBe("muted");
    expect(
      humanPresenceDot(withOwnConnection({ id: OTHER, online: undefined }, SELF, false), NOW)
    ).toBeNull();
  });
});

describe("dmPeerStatusDot: DM 상대 한 명", () => {
  const human = (extra: Partial<RosterMember> = {}) =>
    ({ kind: "human", ...extra }) as RosterMember;
  const agent = (extra: Partial<RosterMember> = {}) =>
    ({ kind: "agent", ...extra }) as RosterMember;
  const base = { mayAct: true, nowMs: NOW };

  it("상대를 모르면(나간 멤버) 점이 없다", () => {
    expect(dmPeerStatusDot({ ...base, member: null, liveness: undefined })).toBeNull();
  });

  it("사람은 생존 판정을 보지 않는다", () => {
    expect(
      dmPeerStatusDot({
        ...base,
        member: human({ presenceStatus: "away" }),
        // 사람에게 생존 판정이 실려 와도 읽지 않는다.
        liveness: { state: "inactive" },
      })?.tone
    ).toBe("warn");
  });

  it("사람의 회색(속 빈 고리)은 접속 여부가 `false` 로 **알려졌고** 살아 있는 선언이 없을 때만 선다 — 생존 판정·호스트 연결과 무관하다", () => {
    // 예전 단정은 「회색은 에이전트에만」이었다. 그 전제는 명부가 접속 여부를 몰랐다는 것이었고(design-review
    // #1889 H-3), 명부가 `online` 을 싣게 된 지금은 사람도 「꺼짐」을 말할 수 있다. 지키는 규칙은 더 좁아졌을 뿐
    // 그대로다: 근거(`online === false`)가 없으면 어떤 입력으로도 사람에게 회색이 나오지 않는다.
    const livenessInputs = [undefined, null, { state: "inactive" as const }];
    for (const presenceStatus of [undefined, "auto", "away", "dnd"] as const) {
      for (const dndUntilMs of [undefined, NOW - 1, NOW + 1]) {
        for (const liveness of livenessInputs) {
          for (const online of [undefined, true]) {
            const dot = dmPeerStatusDot({
              ...base,
              member: human({ presenceStatus, dndUntilMs, hostOnline: false, online }),
              liveness,
            });
            expect(dot?.tone).not.toBe("muted");
          }
          // 접속 없음이 알려졌을 때: 선언이 없거나 만료됐을 때만 회색, 살아 있는 선언이 있으면 선언이 이긴다.
          const offline = dmPeerStatusDot({
            ...base,
            member: human({ presenceStatus, dndUntilMs, hostOnline: true, online: false }),
            liveness,
          });
          const declaredAndLive =
            presenceStatus === "away" ||
            (presenceStatus === "dnd" && !(dndUntilMs !== undefined && dndUntilMs <= NOW));
          expect(offline?.tone === "muted").toBe(!declaredAndLive);
        }
      }
    }
  });

  it("사람: 접속 중이면 초록, 접속 없음이면 고리 — DM 줄·머리가 읽는 같은 함수의 답이다", () => {
    const input = { ...base, liveness: undefined };
    expect(dmPeerStatusDot({ ...input, member: human({ online: true }) })).toEqual({
      tone: "ok",
      label: "온라인",
    });
    expect(dmPeerStatusDot({ ...input, member: human({ online: false }) })).toEqual({
      tone: "muted",
      label: "오프라인",
    });
    expect(dmPeerStatusDot({ ...input, member: human({}) })).toBeNull();
  });

  it("에이전트는 `online` 을 읽지 않는다 — 에이전트의 생존감은 서버의 생존 판정이다(ADR-0160 D4)", () => {
    expect(
      dmPeerStatusDot({
        ...base,
        member: agent({ online: true, hostOnline: false }),
        liveness: undefined,
      })
    ).toBeNull();
    expect(
      dmPeerStatusDot({
        ...base,
        member: agent({ online: false, hostOnline: true }),
        liveness: null,
      })
    ).toEqual({ tone: "ok", label: "연결됨" });
  });

  it("에이전트: 판정이 있으면 판정이 이긴다 — 호스트가 닿아 있어도 꺼짐은 회색이다", () => {
    expect(
      dmPeerStatusDot({
        ...base,
        member: agent({ hostOnline: true }),
        liveness: { state: "inactive" },
      })
    ).toMatchObject({ tone: "muted", label: "연결이 꺼져 있어요" });
  });

  it("에이전트: 판정을 아직 모르면 점이 없다 — 호스트 폴백을 먼저 그리면 거짓을 한 번 그렸다 지운다", () => {
    expect(
      dmPeerStatusDot({ ...base, member: agent({ hostOnline: true }), liveness: undefined })
    ).toBeNull();
  });

  it("에이전트: 판정이 없다고 확정되면(null) 호스트 연결만으로", () => {
    expect(
      dmPeerStatusDot({ ...base, member: agent({ hostOnline: true }), liveness: null })
    ).toEqual({ tone: "ok", label: "연결됨" });
    expect(
      dmPeerStatusDot({ ...base, member: agent({ hostOnline: false }), liveness: null })
    ).toBeNull();
  });

  it("에이전트: 경고색은 보는 사람이 할 수 있는 일이 있을 때만", () => {
    const input = {
      member: agent(),
      liveness: { state: "woken_not_collected" as const },
      nowMs: NOW,
    };
    expect(dmPeerStatusDot({ ...input, mayAct: true })?.tone).toBe("warn");
    expect(dmPeerStatusDot({ ...input, mayAct: false })?.tone).toBe("muted");
  });
});
