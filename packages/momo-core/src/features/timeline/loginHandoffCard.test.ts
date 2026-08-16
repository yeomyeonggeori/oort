import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { agentCardModel, cardKeepsBody } from "./agentCardModel";
import { APPROVAL_NOTE_TONE_ORDER, approvalNoteRank } from "./approvalNote";
import { rowPresentation } from "./rowModel";
import {
  LOGIN_HANDOFF_DEPLOYMENT_COPY,
  LOGIN_HANDOFF_ELSEWHERE_COPY,
  LOGIN_HANDOFF_IN_CONTROL_COPY,
  LOGIN_HANDOFF_IN_CONTROL_LEAD,
  LOGIN_HANDOFF_KIND,
  LOGIN_HANDOFF_OFFLINE_COPY,
  LOGIN_HANDOFF_OUTCOME_DETAIL,
  LOGIN_HANDOFF_OUTCOME_LABEL,
  LOGIN_HANDOFF_PHASE_LABEL,
  LOGIN_HANDOFF_RETURNED_WITHOUT_WINDOW_DETAIL,
  LOGIN_HANDOFF_STOPPED_COPY,
  LOGIN_HANDOFF_TITLE,
  LOGIN_HANDOFF_WAITING_COPY,
  LOGIN_HANDOFF_WAITING_WINDOW_CLOSED,
  loginHandoffCard,
  loginHandoffNote,
  loginHandoffOutcomeDetail,
  loginHandoffStateFor,
  loginHandoffStoppedCopy,
  loginHandoffWaitingCopy,
  parseLoginHandoffControl,
  parseLoginHandoffOutcome,
  type LoginHandoffNoteInput,
  type LoginHandoffOutcome,
} from "./loginHandoffCard";

const APPROVAL_ID = "5f0d2a1e-1c4b-4c9a-9f2a-0d3c8b7e6a11";
const SESSION_ID = "9a1b2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d";

function message(props: Record<string, unknown> = {}): Message {
  return {
    id: "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5b",
    channelId: "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5c",
    seq: 42,
    hlcTs: 1_760_000_000_000,
    hlcCount: 0,
    authorMemberId: "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5d",
    type: "approval_request",
    body: "Approval required: work.session.login_handoff",
    createdAtMs: 1_760_000_000_000,
    props: {
      kind: LOGIN_HANDOFF_KIND,
      approval_id: APPROVAL_ID,
      session_id: SESSION_ID,
      title: LOGIN_HANDOFF_TITLE,
      summary: "배포 콘솔이 로그인 화면으로 돌아갔습니다. 사람이 직접 로그인해 주세요.",
      status: "pending",
      ...props,
    },
  };
}

function noteInput(over: Partial<LoginHandoffNoteInput> = {}): LoginHandoffNoteInput {
  return {
    hasTarget: true,
    settled: false,
    underControl: false,
    decidableHere: true,
    offline: false,
    approvalsProvided: true,
    ...over,
  };
}

describe("이 메시지가 로그인 핸드오프 카드인가", () => {
  it("승인 카드와 같은 메시지 타입을 쓰고, props.kind 하나로 갈라진다", () => {
    const card = agentCardModel(message());
    expect(card?.kind).toBe("login_handoff");
    // 새 message_type 을 만들지 않았다는 것이 계약이다 (schema_v0 불가침).
    expect(message().type).toBe("approval_request");
  });

  it("kind 가 없는 승인 요청은 예전처럼 승인 카드로 남는다", () => {
    const plain = message();
    delete (plain.props as Record<string, unknown>).kind;
    expect(agentCardModel(plain)?.kind).toBe("approval");
  });

  it("kind 가 다른 승인 요청도 승인 카드로 남는다", () => {
    expect(agentCardModel(message({ kind: "resume_offer" }))?.kind).toBe(
      "approval"
    );
  });

  it("지워진 행은 카드를 만들지 않는다", () => {
    expect(agentCardModel({ ...message(), state: "deleted" })).toBeNull();
  });

  it("props 가 없으면 카드가 아니다", () => {
    expect(loginHandoffCard(undefined)).toBeNull();
  });

  it("본문을 카드 위에 다시 그리지 않는다", () => {
    const card = agentCardModel(message());
    expect(card).not.toBeNull();
    expect(cardKeepsBody(card!)).toBe(false);
    expect(rowPresentation(message()).keepsBody).toBe(false);
  });

  it("사람의 결정을 기다리는 카드이므로 아티팩트보다 앞선다", () => {
    const presentation = rowPresentation(message());
    expect(presentation.card?.kind).toBe("login_handoff");
    expect(presentation.artifact).toBeNull();
    expect(presentation.artifactState).toBeNull();
  });
});

describe("카드가 읽는 것과 읽지 않는 것", () => {
  it("에이전트가 쓴 사유는 summary 에서 읽는다, 서버가 쓴 본문이 아니라", () => {
    const card = loginHandoffCard(message().props);
    expect(card?.reason).toContain("사람이 직접 로그인");
    expect(card?.reason).not.toContain("Approval required");
  });

  it("세션 id 는 딥링크용으로 읽되 그리는 값이 아니다", () => {
    const card = loginHandoffCard(message().props);
    expect(card?.sessionId).toBe(SESSION_ID);
    // 화면에 서는 행(detail.rows)에는 id 가 없다.
    for (const row of card!.detail.rows) {
      expect(row.value).not.toContain(SESSION_ID);
    }
  });

  it("카드가 그리는 키는 숨김 개수에 들어가지 않는다", () => {
    const card = loginHandoffCard(
      message({
        control_started_at_ms: 1_760_000_100_000,
        control_ended_at_ms: 1_760_000_200_000,
        control_end_reason: "returned",
      }).props
    );
    expect(card?.detail.withheld).toBe(0);
  });

  it("서버가 더 보낸 키는 숨김으로 센다", () => {
    const props = { ...message().props, arguments: { password: "x" } };
    const card = loginHandoffCard(props);
    expect(card?.detail.withheld).toBe(1);
    expect(JSON.stringify(card?.detail.rows)).not.toContain("password");
  });

  it("결정할 대상이 없어도 카드는 서고, 누를 것만 없다", () => {
    const props = { ...message().props };
    delete props.approval_id;
    const card = loginHandoffCard(props);
    expect(card?.approvalId).toBeNull();
    expect(card?.phase).toBe("waiting");
  });
});

describe("경계 사실은 반쪽으로 읽지 않는다", () => {
  it("정지 시각이 없으면 창이 없는 것이다", () => {
    expect(parseLoginHandoffControl({ control_end_reason: "returned" })).toBeNull();
    expect(parseLoginHandoffControl({})).toBeNull();
    expect(parseLoginHandoffControl(undefined)).toBeNull();
  });

  it("정지 시각만 있으면 창은 열려 있는 것이다", () => {
    expect(parseLoginHandoffControl({ control_started_at_ms: 1_000 })).toEqual({
      startedAtMs: 1_000,
      endedAtMs: null,
      endReason: null,
    });
  });

  it("닫힌 시각 없이 사유만 온 봉투는 사유를 채택하지 않는다", () => {
    expect(
      parseLoginHandoffControl({
        control_started_at_ms: 1_000,
        control_end_reason: "expired",
      })
    ).toEqual({ startedAtMs: 1_000, endedAtMs: null, endReason: null });
  });

  it("문자열로 온 epoch 도 읽는다", () => {
    expect(
      parseLoginHandoffControl({
        control_started_at_ms: "1000",
        control_ended_at_ms: "2000",
        control_end_reason: "session_ended",
      })
    ).toEqual({ startedAtMs: 1_000, endedAtMs: 2_000, endReason: "session_ended" });
  });

  it("원장 어휘 밖의 사유는 읽지 않는다", () => {
    expect(parseLoginHandoffOutcome("revoked")).toBeNull();
    expect(parseLoginHandoffOutcome("Returned")).toBeNull();
    expect(parseLoginHandoffOutcome(undefined)).toBeNull();
    for (const reason of ["returned", "expired", "session_ended"]) {
      expect(parseLoginHandoffOutcome(reason)).toBe(reason);
    }
  });
});

describe("국면과 결과 — 승인 축과 창 축", () => {
  it("대기 중인 승인은 대기다", () => {
    expect(loginHandoffStateFor("pending", null)).toEqual({
      phase: "waiting",
      outcome: null,
    });
  });

  it("거부와 취소는 run 을 멈춘 것이라 핸드오프 터미널이 아니다", () => {
    for (const status of ["rejected", "cancelled"] as const) {
      expect(loginHandoffStateFor(status, null)).toEqual({
        phase: "stopped",
        outcome: null,
      });
    }
  });

  it("창이 닫힌 뒤 run 을 멈춰도 멈춘 것이 이긴다", () => {
    expect(
      loginHandoffStateFor("rejected", {
        startedAtMs: 1,
        endedAtMs: 2,
        endReason: "returned",
      })
    ).toEqual({ phase: "stopped", outcome: null });
  });

  it("원장이 사유를 갖고 있으면 그 낱말을 그대로 쓴다", () => {
    for (const reason of [
      "returned",
      "expired",
      "session_ended",
    ] as LoginHandoffOutcome[]) {
      expect(
        loginHandoffStateFor("approved", {
          startedAtMs: 1,
          endedAtMs: 2,
          endReason: reason,
        })
      ).toEqual({ phase: "resolved", outcome: reason });
    }
  });

  it("아무도 답하지 않아 만료된 hold 는 완료 불확실이다", () => {
    expect(loginHandoffStateFor("expired", null)).toEqual({
      phase: "resolved",
      outcome: "expired",
    });
  });

  it("창 기록 없이 재개를 누른 것은 명시된 개입 완료다", () => {
    expect(loginHandoffStateFor("approved", null)).toEqual({
      phase: "resolved",
      outcome: "returned",
    });
  });

  it("창이 아직 열려 있는 동안 승인되면 사유를 지어내지 않는다", () => {
    expect(
      loginHandoffStateFor("approved", {
        startedAtMs: 1,
        endedAtMs: null,
        endReason: null,
      })
    ).toEqual({ phase: "resolved", outcome: "returned" });
  });

  it("카드 전체가 원장 두 축을 함께 나른다", () => {
    const props = {
      ...message().props,
      approval_status: "approved",
      decided_by: "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5e",
      decided_at_ms: 1_760_000_300_000,
      control_started_at_ms: 1_760_000_100_000,
      control_ended_at_ms: 1_760_000_200_000,
      control_end_reason: "expired",
    };
    const card = loginHandoffCard(props);
    expect(card?.phase).toBe("resolved");
    expect(card?.outcome).toBe("expired");
    expect(card?.control).toEqual({
      startedAtMs: 1_760_000_100_000,
      endedAtMs: 1_760_000_200_000,
      endReason: "expired",
    });
    expect(card?.decidedAtMs).toBe(1_760_000_300_000);
  });
});

describe("컨트롤 대신 서는 줄", () => {
  it("영수증이 가장 먼저다", () => {
    const note = loginHandoffNote(
      noteInput({
        receiptNote: "재개를 기록했습니다.",
        underControl: true,
        offline: true,
        decidableHere: false,
      })
    );
    expect(note).toEqual({
      kind: "receipt",
      tone: "receipt",
      text: "재개를 기록했습니다.",
    });
  });

  it("누군가 화면을 잡고 있으면 컨트롤을 세우지 않는다", () => {
    expect(loginHandoffNote(noteInput({ underControl: true }))).toEqual({
      kind: "in-control",
      tone: "blocked",
      text: LOGIN_HANDOFF_IN_CONTROL_COPY,
    });
  });

  it("끝난 카드는 여기서 할 말이 없다", () => {
    expect(loginHandoffNote(noteInput({ settled: true }))).toBeNull();
    expect(
      loginHandoffNote(noteInput({ settled: true, underControl: true }))
    ).toBeNull();
  });

  it("결정할 대상이 없으면 할 말이 없다", () => {
    expect(loginHandoffNote(noteInput({ hasTarget: false }))).toBeNull();
  });

  it("원장 없는 서버가 다른 안내보다 앞이다", () => {
    expect(
      loginHandoffNote(
        noteInput({
          approvalsProvided: false,
          decidableHere: false,
          offline: true,
          unsupportedText: "이 서버에는 승인 원장이 없습니다.",
        })
      )
    ).toEqual({
      kind: "unsupported",
      tone: "guidance",
      text: "이 서버에는 승인 원장이 없습니다.",
    });
  });

  it("자리의 문제가 때의 문제보다 앞이다", () => {
    expect(
      loginHandoffNote(noteInput({ decidableHere: false, offline: true }))
    ).toEqual({
      kind: "elsewhere",
      tone: "guidance",
      text: LOGIN_HANDOFF_ELSEWHERE_COPY,
    });
  });

  it("보낼 수 없을 때는 때의 문제로 말한다", () => {
    expect(loginHandoffNote(noteInput({ offline: true }))).toEqual({
      kind: "offline",
      tone: "blocked",
      text: LOGIN_HANDOFF_OFFLINE_COPY,
    });
  });

  it("아무것도 막지 않으면 컨트롤이 선다", () => {
    expect(loginHandoffNote(noteInput())).toBeNull();
  });

  it("승인 카드와 같은 격 체계를 쓴다", () => {
    const tones = [
      loginHandoffNote(noteInput({ receiptNote: "기록했습니다." }))!.tone,
      loginHandoffNote(noteInput({ underControl: true }))!.tone,
      loginHandoffNote(noteInput({ decidableHere: false }))!.tone,
    ];
    for (const tone of tones) {
      expect(APPROVAL_NOTE_TONE_ORDER).toContain(tone);
    }
    // 영수증이 가장 앞, 안내가 가장 뒤. 이 카드가 순서를 뒤집지 않는다.
    expect(approvalNoteRank(tones[0])).toBeLessThan(approvalNoteRank(tones[1]));
    expect(approvalNoteRank(tones[1])).toBeLessThan(approvalNoteRank(tones[2]));
  });
});

describe("멈춘 카드가 말하는 것", () => {
  it("창이 열린 적이 없으면 개입이 시작되지 않았다고 말한다", () => {
    expect(loginHandoffStoppedCopy({ control: null })).toBe(
      `${LOGIN_HANDOFF_STOPPED_COPY.cancelled} ${LOGIN_HANDOFF_STOPPED_COPY.neverStarted}`
    );
  });

  it("창이 있었으면 개입이 없었다고 말하지 않는다", () => {
    // 이 모듈이 **명시적으로 허용한** 갈래다: 「창이 닫힌 뒤 run 을 멈춰도 멈춘
    // 것이 이긴다」. 그 카드는 자기 화면 윗줄에 정지 시각 행을 세워 두고 있고,
    // 아랫줄이 그것을 부정하면 한 카드가 자기 자신과 싸운다.
    for (const control of [
      { startedAtMs: 1_000, endedAtMs: null, endReason: null },
      {
        startedAtMs: 1_000,
        endedAtMs: 2_000,
        endReason: "returned" as LoginHandoffOutcome,
      },
    ]) {
      const text = loginHandoffStoppedCopy({ control });
      expect(text).toBe(LOGIN_HANDOFF_STOPPED_COPY.cancelled);
      expect(text).not.toContain(LOGIN_HANDOFF_STOPPED_COPY.neverStarted);
    }
  });

  it("코어가 세우는 stopped 카드와 실제로 짝을 이룬다", () => {
    // 합성한 입력이 아니라 파서가 만든 카드로 잰다. 갈래가 도달 불가능하면
    // 위의 두 시험은 아무것도 지키지 않는다.
    const card = loginHandoffCard(
      message({
        approval_status: "rejected",
        control_started_at_ms: 1_760_000_100_000,
        control_ended_at_ms: 1_760_000_200_000,
        control_end_reason: "returned",
      }).props
    );
    expect(card?.phase).toBe("stopped");
    expect(card?.control).not.toBeNull();
    expect(loginHandoffStoppedCopy(card!)).toBe(
      LOGIN_HANDOFF_STOPPED_COPY.cancelled
    );
  });

  it("창 없이 멈춘 카드는 두 문장을 다 말한다", () => {
    const card = loginHandoffCard(
      message({ approval_status: "cancelled" }).props
    );
    expect(card?.phase).toBe("stopped");
    expect(card?.control).toBeNull();
    expect(loginHandoffStoppedCopy(card!)).toContain(
      LOGIN_HANDOFF_STOPPED_COPY.neverStarted
    );
  });
});

describe("대기 중인데 창은 이미 닫혔을 때 (freeze M1)", () => {
  it("국면은 여전히 대기다 — 원장이 답한 것을 화면이 뒤집지 않는다", () => {
    // 두 축이 독립이라는 것의 나머지 절반. 승인 원장은 아직 아무 답도 받지
    // 않았고(pending), 그것이 이 카드가 서 있는 이유다.
    for (const reason of [
      "returned",
      "expired",
      "session_ended",
    ] as LoginHandoffOutcome[]) {
      expect(
        loginHandoffStateFor("pending", {
          startedAtMs: 1_000,
          endedAtMs: 2_000,
          endReason: reason,
        })
      ).toEqual({ phase: "waiting", outcome: null });
    }
  });

  it("대기 카피가 창이 닫힌 사실을 접합한다", () => {
    // 앞 판은 대기 카피만 세웠다. 그래서 랩톱을 덮어 창이 lapse 로 닫힌 뒤에도
    // 카드는 「지금 조작 중」과 구별되지 않았고, 화면이 모르는 것을 아는 척했다.
    const lapsed = loginHandoffWaitingCopy({
      control: { startedAtMs: 1_000, endedAtMs: 2_000, endReason: "expired" },
    });
    expect(lapsed.startsWith(LOGIN_HANDOFF_WAITING_COPY)).toBe(true);
    expect(lapsed).toContain(LOGIN_HANDOFF_WAITING_WINDOW_CLOSED.expired);
  });

  it("창이 열려 있거나 없었으면 부탁 문장 그대로다", () => {
    expect(loginHandoffWaitingCopy({ control: null })).toBe(
      LOGIN_HANDOFF_WAITING_COPY
    );
    expect(
      loginHandoffWaitingCopy({
        control: { startedAtMs: 1_000, endedAtMs: null, endReason: null },
      })
    ).toBe(LOGIN_HANDOFF_WAITING_COPY);
  });

  it("사유마다 문장이 다르고, 끝난 세션에 다시 열라고 하지 않는다", () => {
    expect(new Set(Object.values(LOGIN_HANDOFF_WAITING_WINDOW_CLOSED)).size).toBe(3);
    expect(LOGIN_HANDOFF_WAITING_WINDOW_CLOSED.session_ended).not.toMatch(
      /다시 열/
    );
    expect(LOGIN_HANDOFF_WAITING_WINDOW_CLOSED.expired).toContain("연결이 끊겨");
  });

  it("코어가 세우는 대기 카드와 실제로 짝을 이룬다", () => {
    // 파서가 만든 카드로 잰다. 갈래가 도달 불가능하면 위의 시험들은 아무것도
    // 지키지 않는다.
    const card = loginHandoffCard(
      message({
        approval_status: "pending",
        control_started_at_ms: 1_760_000_100_000,
        control_ended_at_ms: 1_760_000_200_000,
        control_end_reason: "expired",
      }).props
    );
    expect(card?.phase).toBe("waiting");
    expect(card?.outcome).toBeNull();
    expect(loginHandoffWaitingCopy(card!)).toContain(
      LOGIN_HANDOFF_WAITING_WINDOW_CLOSED.expired
    );
  });
});

describe("결과 문장은 창이 있었는지에 따라 갈린다 (freeze M2)", () => {
  it("창 없이 재개를 누른 카드는 실행기와 같은 것을 말한다", () => {
    // `tool_exec.rs` 의 `None` 갈래: 「No control window was opened in this
    // deployment, so continue from the session's own screen state.」
    // 표의 `returned` 문장(「화면을 돌려주었습니다」)은 잡은 적 없는 화면을
    // 돌려주었다고 말한다.
    const card = loginHandoffCard(message({ approval_status: "approved" }).props);
    expect(card?.outcome).toBe("returned");
    expect(card?.control).toBeNull();
    expect(loginHandoffOutcomeDetail(card!)).toBe(
      LOGIN_HANDOFF_RETURNED_WITHOUT_WINDOW_DETAIL
    );
    expect(loginHandoffOutcomeDetail(card!)).not.toBe(
      LOGIN_HANDOFF_OUTCOME_DETAIL.returned
    );
  });

  it("창이 있었으면 표의 문장 그대로다", () => {
    for (const reason of [
      "returned",
      "expired",
      "session_ended",
    ] as LoginHandoffOutcome[]) {
      expect(
        loginHandoffOutcomeDetail({
          outcome: reason,
          control: { startedAtMs: 1_000, endedAtMs: 2_000, endReason: reason },
        })
      ).toBe(LOGIN_HANDOFF_OUTCOME_DETAIL[reason]);
    }
  });

  it("결과가 없으면 줄이 서지 않는다", () => {
    expect(
      loginHandoffOutcomeDetail({ outcome: null, control: null })
    ).toBeNull();
  });

  it("창 없는 returned 문장이 실행기의 서술과 어긋나지 않는다", () => {
    // 두 문장이 같은 사실을 다르게 말하면, 나란히 본 사람은 어느 쪽이 참인지
    // 물어야 한다. 실행기는 「세션 화면에서 상태를 확인한 뒤」 진행한다고 한다.
    expect(LOGIN_HANDOFF_RETURNED_WITHOUT_WINDOW_DETAIL).toContain(
      "세션 화면에서 상태를 확인한 뒤"
    );
    expect(LOGIN_HANDOFF_RETURNED_WITHOUT_WINDOW_DETAIL).not.toContain(
      "화면을 돌려주었습니다"
    );
  });
});

describe("문구", () => {
  const ALL_COPY = [
    LOGIN_HANDOFF_DEPLOYMENT_COPY,
    LOGIN_HANDOFF_IN_CONTROL_COPY,
    LOGIN_HANDOFF_IN_CONTROL_LEAD,
    LOGIN_HANDOFF_ELSEWHERE_COPY,
    LOGIN_HANDOFF_OFFLINE_COPY,
    LOGIN_HANDOFF_WAITING_COPY,
    LOGIN_HANDOFF_TITLE,
    LOGIN_HANDOFF_RETURNED_WITHOUT_WINDOW_DETAIL,
    ...Object.values(LOGIN_HANDOFF_WAITING_WINDOW_CLOSED),
    ...Object.values(LOGIN_HANDOFF_STOPPED_COPY),
    ...Object.values(LOGIN_HANDOFF_OUTCOME_LABEL),
    ...Object.values(LOGIN_HANDOFF_OUTCOME_DETAIL),
    ...Object.values(LOGIN_HANDOFF_PHASE_LABEL),
  ];

  it("in-control 문장은 사실 한 문장 위에 결정 동선을 얹은 것이다", () => {
    // 폰이 부분열을 손으로 베끼지 않으려면 자를 곳이 코어에 있어야 한다.
    expect(LOGIN_HANDOFF_IN_CONTROL_COPY.startsWith(
      LOGIN_HANDOFF_IN_CONTROL_LEAD
    )).toBe(true);
    // 사실 문장만은 결정 동선이 없는 표면에서도 참이어야 한다.
    expect(LOGIN_HANDOFF_IN_CONTROL_LEAD).not.toMatch(/재개|중단/);
    expect(LOGIN_HANDOFF_IN_CONTROL_COPY).toMatch(/재개하거나 중단할 수/);
  });

  it("인수라고 말하지 않는다 (ADR-0004 증보 3 D1)", () => {
    for (const text of ALL_COPY) expect(text).not.toContain("인수");
  });

  it("사과하지 않고, em-dash 를 쓰지 않는다 (SKILL §7)", () => {
    for (const text of ALL_COPY) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/죄송|양해|잠시 후 다시/);
      expect(text).not.toMatch(/원활|손쉽게|매끄러운/);
    }
  });

  it("배포 사실과 세션 사실이 같은 문장이 아니다", () => {
    // 배포 사실은 재시도를 권하지 않는다.
    expect(LOGIN_HANDOFF_DEPLOYMENT_COPY).toContain("이 배포에서는");
    expect(LOGIN_HANDOFF_DEPLOYMENT_COPY).not.toMatch(/다시 시도|새로고침/);
    // 세션 사실은 다시 될 수 있다고 말한다.
    expect(LOGIN_HANDOFF_OFFLINE_COPY).toContain("다시 연결되면");
  });

  it("자격증명을 채팅에 넣으라고 말하지 않는다 (증보 3 D2)", () => {
    for (const text of ALL_COPY) {
      expect(text).not.toMatch(/비밀번호를 (여기|이곳|채팅)/);
    }
    expect(LOGIN_HANDOFF_WAITING_COPY).toContain(
      "비밀번호는 에이전트에게 전달되지 않고"
    );
  });

  it("세 결과가 서로 다른 문장을 말한다", () => {
    const details = Object.values(LOGIN_HANDOFF_OUTCOME_DETAIL);
    expect(new Set(details).size).toBe(3);
    // 완료 불확실을 완료로 읽히게 두지 않는다.
    expect(LOGIN_HANDOFF_OUTCOME_DETAIL.expired).toContain("완료를 가정하지 않고");
  });

  it("결과 낱말은 원장 어휘 셋과 정확히 짝을 이룬다", () => {
    expect(Object.keys(LOGIN_HANDOFF_OUTCOME_LABEL).sort()).toEqual([
      "expired",
      "returned",
      "session_ended",
    ]);
    expect(Object.keys(LOGIN_HANDOFF_OUTCOME_DETAIL).sort()).toEqual([
      "expired",
      "returned",
      "session_ended",
    ]);
  });
});
