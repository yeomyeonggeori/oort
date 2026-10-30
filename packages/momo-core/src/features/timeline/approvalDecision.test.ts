import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import { serverSurface } from "../capabilities/serverSurfaces";
import {
  decideApproval,
  interpretReceipt,
  unreadableAnswerOutcome,
  unsettledAnswerClause,
} from "./approvalDecision";

// goal B12: 승인 라우트가 없는 서버의 404를 원장의 답으로 읽지 않는다.
//
// 이 표면의 404는 두 가지다. 원장을 가진 서버의 404는 "그런 승인은 없다"이고
// 영수증 스키마를 싣고 온다. 라우트를 싣지 않은 서버의 404는 "그런 경로가 없다"
// 이고 라우터 기본 응답이라 본문이 없다. 둘을 한 칸에 넣어 두면 화면이 거짓말을
// 한다.

describe("읽을 수 없는 답", () => {
  it("본문 없는 404는 미제공이라고 말하고 재시도를 권하지 않는다", () => {
    const outcome = unreadableAnswerOutcome(404, "");
    expect(outcome.kind).toBe("error");
    expect(outcome.errorCopy).toBe(serverSurface("approvals").absentReason);
    // 예전 문구는 "다시 시도하세요"였다. 결코 성공할 수 없는 재시도를 시키는
    // 문장이었고, 사용자 자리에서는 앱이 고장난 것으로 읽혔다.
    expect(outcome.errorCopy).not.toMatch(/다시 시도/);
  });

  it("미제공은 이유를 코드로도 싣는다: 화면이 빨간 alert 대신 미제공으로 그릴 수 있게", () => {
    // 2R M1. `kind`는 여전히 error다 — 결정은 기록되지 않았고, 그것을 새 갈래로
    // 빼면 그 갈래를 모르는 호출자가 조용히 "결정됨" 쪽으로 떨어뜨린다.
    // 바뀌는 것은 **색**뿐이고, 그 판정에 필요한 것이 이 코드다.
    for (const status of [404, 405, 501]) {
      expect(unreadableAnswerOutcome(status, "").errorCode).toBe(
        "surface_absent"
      );
    }
  });

  it("진짜 실패에는 미제공 코드가 붙지 않는다", () => {
    expect(
      unreadableAnswerOutcome(404, "<html>gateway</html>").errorCode
    ).toBeUndefined();
    for (const status of [200, 403, 409, 500]) {
      expect(unreadableAnswerOutcome(status, "").errorCode).toBeUndefined();
    }
  });

  it("공백뿐인 본문도 같다", () => {
    expect(unreadableAnswerOutcome(404, "  \n ").errorCopy).toBe(
      serverSurface("approvals").absentReason
    );
  });

  it("405와 501도 같은 판정을 받는다", () => {
    for (const status of [405, 501]) {
      expect(unreadableAnswerOutcome(status, "").errorCopy).toBe(
        serverSurface("approvals").absentReason
      );
    }
  });

  it("본문이 있는데 못 읽은 것은 미제공이 아니다", () => {
    // 원장을 가진 서버가 깨진 JSON을 보낸 경우다. 그때는 다시 시도할 값이 있다.
    const outcome = unreadableAnswerOutcome(404, "<html>gateway</html>");
    expect(outcome.errorCopy).toMatch(/다시 눌러/);
    expect(outcome.errorCopy).not.toBe(serverSurface("approvals").absentReason);
  });

  it("미제공 코드가 아닌 상태는 기존 문구를 그대로 쓴다", () => {
    for (const status of [200, 403, 409, 500]) {
      expect(unreadableAnswerOutcome(status, "").errorCopy).toMatch(/다시 눌러/);
    }
  });
});

describe("영수증이 아닌 답 (2R, 리뷰 M5 이관)", () => {
  it("상태 코드가 사용자 문장에 새지 않는다", () => {
    for (const status of [500, 502, 503, 429, 418, 401]) {
      const clause = unsettledAnswerClause(status);
      expect(clause).not.toMatch(/\d{3}/);
      expect(clause).not.toMatch(/[—–]/);
    }
  });

  it("사람이 판단할 수 있는 세 갈래로 접는다", () => {
    expect(unsettledAnswerClause(429)).toMatch(/요청이 잦아/);
    expect(unsettledAnswerClause(503)).toMatch(/서버가 오류로 답했어요/);
    expect(unsettledAnswerClause(418)).toMatch(/받지 않았어요/);
  });

  it("모든 갈래가 다음에 할 일을 말한다", () => {
    for (const status of [429, 500, 418]) {
      expect(unsettledAnswerClause(status)).toMatch(/다시 눌러|받지 않았어요/);
    }
  });

  // 401은 세션을 한 번 갱신하고 다시 보낸 뒤에도 남은 답이다. 눌러서 될 일이
  // 아니므로 「다시 눌러 주세요」를 권하면 성공할 수 없는 재시도를 시킨다 (#3926).
  it("401은 다시 누르라고 하지 않고 다시 로그인하라고 말한다", () => {
    const clause = unsettledAnswerClause(401);
    expect(clause).toMatch(/로그인이 만료/);
    expect(clause).toMatch(/다시 로그인/);
    expect(clause).not.toMatch(/다시 눌러/);
  });
});

// 지금 이 레포에는 서버가 두 대 살고, 둘이 이 본문을 다른 표기로 낸다. Swift는
// snake_case(`ApprovalDecisionRoutes.swift`의 CodingKeys), Rust는 camelCase
// (`dto.rs:2269-2279` + 손으로 쓴 `approval.rs:638-644`). 그 차이가 조용했던 이유는
// `status`가 두 표기에서 같은 글자여서 **판정은 살아 있었기** 때문이고, 버려진 것은
// "누가, 언제"뿐이었다. 그 둘은 웹 카드의 「승인」 원장 줄이 서는 조건 그 자체라,
// 결정한 직후 그 줄이 통째로 사라진다 — 오류 하나 없이.
describe("영수증은 두 표기를 모두 읽는다 (2R N2)", () => {
  it("이미 취소된 승인의 200 영수증은 cancelled 상태를 보존한다 (ADR-0217)", () => {
    expect(interpretReceipt(200, {
      approvalId: "a",
      status: "cancelled",
      decidedBy: null,
      decidedAtMs: 1_700_000_000_000,
    })).toEqual({
      kind: "committed",
      status: "cancelled",
      decidedAtMs: 1_700_000_000_000,
    });
  });

  const snake = {
    approval_id: "a",
    status: "approved",
    decided_by: "member-1",
    decided_at_ms: 1_700_000_000_000,
  };
  const camel = {
    approvalId: "a",
    status: "approved",
    decidedBy: "member-1",
    decidedAtMs: 1_700_000_000_000,
  };

  it("두 표기가 같은 결과를 낸다", () => {
    expect(interpretReceipt(200, camel)).toEqual(interpretReceipt(200, snake));
  });

  it("camelCase 영수증에서도 누가·언제가 살아남는다", () => {
    const outcome = interpretReceipt(200, camel);
    expect(outcome.kind).toBe("committed");
    expect(outcome.decidedByMemberId).toBe("member-1");
    expect(outcome.decidedAtMs).toBe(1_700_000_000_000);
  });

  it("이미 결정된 요청도 camelCase에서 누가·언제를 싣는다", () => {
    const outcome = interpretReceipt(409, { ...camel, status: "rejected" });
    expect(outcome.kind).toBe("superseded");
    expect(outcome.decidedByMemberId).toBe("member-1");
    expect(outcome.decidedAtMs).toBe(1_700_000_000_000);
  });

  it("표기 판정은 필드마다 따로 한다", () => {
    // Rust는 `None`인 필드를 아예 뺀다(`skip_serializing_if`). 한 필드를 보고
    // 표기를 정한 뒤 나머지를 그 표기로 읽으면, 빠진 필드 하나가 나머지를 통째로
    // 버리게 만든다. 섞여 오든 절반만 오든 있는 것만 읽어야 한다.
    const mixed = interpretReceipt(200, {
      status: "approved",
      decided_by: "member-1",
      decidedAtMs: 1_700_000_000_000,
    });
    expect(mixed.decidedByMemberId).toBe("member-1");
    expect(mixed.decidedAtMs).toBe(1_700_000_000_000);

    const onlyTime = interpretReceipt(200, {
      status: "approved",
      decidedAtMs: 1_700_000_000_000,
    });
    expect(onlyTime.decidedAtMs).toBe(1_700_000_000_000);
    expect(onlyTime.decidedByMemberId).toBeUndefined();
  });

  it("정본 표기가 이긴다: 둘 다 오면 snake_case를 읽는다", () => {
    const outcome = interpretReceipt(200, {
      status: "approved",
      decided_by: "canonical",
      decidedBy: "ported",
      decided_at_ms: 1,
      decidedAtMs: 2,
    });
    expect(outcome.decidedByMemberId).toBe("canonical");
    expect(outcome.decidedAtMs).toBe(1);
  });

  it("빈 문자열은 값이 아니다: 두 표기 모두에서", () => {
    for (const receipt of [
      { status: "approved", decided_by: "" },
      { status: "approved", decidedBy: "" },
    ]) {
      expect(interpretReceipt(200, receipt).decidedByMemberId).toBeUndefined();
    }
  });
});

describe("영수증 해석은 그대로다", () => {
  it("200은 기록된 결정이다", () => {
    const outcome = interpretReceipt(200, {
      approval_id: "a",
      status: "approved",
      decided_at_ms: 1_700_000_000_000,
      decided_by: "member-1",
    });
    expect(outcome.kind).toBe("committed");
    expect(outcome.status).toBe("approved");
    expect(outcome.decidedAtMs).toBe(1_700_000_000_000);
    expect(outcome.decidedByMemberId).toBe("member-1");
  });

  it("409에 확정 상태가 실려 오면 다른 곳에서 이미 결정된 것이다", () => {
    const outcome = interpretReceipt(409, {
      approval_id: "a",
      status: "rejected",
    });
    expect(outcome.kind).toBe("superseded");
    expect(outcome.note).toBe("다른 곳에서 이미 결정됐어요.");
  });

  it("만료는 만료라고 말한다: 실패로 승격하지 않는다 (ADR-0132)", () => {
    const outcome = interpretReceipt(409, {
      approval_id: "a",
      status: "expired",
    });
    expect(outcome.kind).toBe("superseded");
    expect(outcome.note).toBe("결정 전에 만료됐어요.");
  });

  it("영수증을 실은 404는 여전히 '찾을 수 없다'로 읽는다", () => {
    // 원장을 가진 서버의 정당한 답. 위의 본문 없는 404와 갈라지는 지점이다.
    const outcome = interpretReceipt(404, {
      approval_id: "a",
      status: "unknown-to-this-client",
    });
    expect(outcome.kind).toBe("error");
    expect(outcome.errorCopy).toMatch(/찾지 못했어요/);
  });
});

// =============================================================================
// 결정 전송의 401 갱신 (#3926, ADR-0204 D6 마지막 줄).
//
// `decideApproval`은 401에 갱신하지 않는 raw fetch였다. 앱이 백그라운드에 오래 있었으면
// 접근 토큰이 죽어 있고, 잠금 화면에서 누른 결정은 화면을 보는 사람 없이 조용히
// 실패했다. 이제 `authedResponse`가 한 번 갱신하고 **같은 요청**을 다시 보낸다.
//
// 아래 시험이 못박는 것은 세 가지다.
//   1. 갱신 뒤 재시도는 같은 `client_decision_id`로 나가고(서버가 재생한다) 새 토큰을 쓴다.
//   2. 갱신이 안 되면 오류로 끝난다. 다시 보내지도, 갱신을 되풀이하지도 않는다.
//   3. 401이 아닌 답(403/404/409 영수증)은 갱신 없이 예전처럼 영수증으로 읽힌다.
// 세션 목은 상태를 가진다: `applyRotation`이 토큰을 바꾸고 `getAccessToken`이 그 값을
// 읽어야 재시도 헤더가 새 토큰이 된다. 상수를 돌려주는 목은 그 단정을 통과시킨다.
// =============================================================================

const WS = "019f9b10-0000-7000-8000-000000000001";
const APPROVAL = "019f9b10-0000-7000-8000-0000000000a1";
const KEY = "decision-key-1";
const DECISION_PATH = `/v1/workspaces/${WS}/approvals/${APPROVAL}/decision`;
const REFRESH_PATH = "/v1/auth/refresh";

interface Sent {
  path: string;
  method: string;
  bearer: string | null;
  body: Record<string, unknown> | null;
}

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UNAUTHORIZED = () => answer(401, { error: { message: "unauthorized" } });
const ROTATED = () =>
  answer(200, { accessToken: "access-new", refreshToken: "refresh-2" });
const RECEIPT = (status = "approved") =>
  answer(200, {
    approvalId: APPROVAL,
    status,
    decidedBy: "member-1",
    decidedAtMs: 1_800_000_000_000,
  });

/**
 * 호스트 세션과 fetch를 세운다. `answers`는 요청 순서대로 소비된다. 모자라면 그 요청은
 * 던지는데, 던지기 **전에** `sent`에 기록하므로 예상 밖의 추가 요청(루프)은 호출 수
 * 단정에서 드러난다.
 */
function stage(answers: Array<Response | Error>) {
  const session = { access: "access-old", refresh: "refresh-1", expired: 0 };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: {
      getAccessToken: () => session.access,
      getRefreshToken: () => session.refresh,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: (access, refresh) => {
        session.access = access;
        session.refresh = refresh;
      },
      markAuthExpired: () => {
        session.expired += 1;
      },
      clearSession: () => {},
    },
  });
  const sent: Sent[] = [];
  const queue = [...answers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({
        path: String(url).replace("https://oort.test", ""),
        method: init?.method ?? "GET",
        bearer: new Headers(init?.headers).get("Authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected request ${String(url)}`);
      if (next instanceof Error) throw next;
      return next;
    })
  );
  return { session, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

describe("결정 전송은 401이면 한 번 갱신하고 같은 요청을 다시 보낸다 (#3926)", () => {
  it("갱신 뒤 같은 멱등 키로, 새 토큰으로 다시 보내 200을 받는다", async () => {
    const { session, sent } = stage([UNAUTHORIZED(), ROTATED(), RECEIPT()]);

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("committed");
    expect(outcome.status).toBe("approved");
    // 결정 → 갱신 → 결정, 정확히 이 순서로 셋.
    expect(sent.map((request) => request.path)).toEqual([
      DECISION_PATH,
      REFRESH_PATH,
      DECISION_PATH,
    ]);
    // 첫 요청은 죽은 토큰, 재시도는 갱신이 돌려준 새 토큰.
    expect(sent[0]?.bearer).toBe("Bearer access-old");
    expect(sent[2]?.bearer).toBe("Bearer access-new");
    // 같은 결정이다: 본문 전체가 같고, 그 안의 멱등 키가 호출자가 쥔 그 키다.
    expect(sent[2]?.body).toEqual(sent[0]?.body);
    expect(sent[0]?.body?.client_decision_id).toBe(KEY);
    expect(sent[2]?.body?.client_decision_id).toBe(KEY);
    // 갱신은 단일 사용 토큰을 내밀었고, 세션은 후속 쌍을 받았다.
    expect(sent[1]?.body).toEqual({ refreshToken: "refresh-1" });
    expect(session.refresh).toBe("refresh-2");
    expect(session.expired).toBe(0);
  });

  it("거절 결정도 같은 경로를 탄다: 호스트는 거절에 실리지 않는다", async () => {
    const { sent } = stage([UNAUTHORIZED(), ROTATED(), RECEIPT("rejected")]);

    const outcome = await decideApproval(WS, APPROVAL, false, KEY, "host-1");

    expect(outcome.kind).toBe("committed");
    expect(outcome.status).toBe("rejected");
    expect(sent[2]?.body).toEqual({
      approval_id: APPROVAL,
      approve: false,
      client_decision_id: KEY,
    });
  });

  it("갱신이 거절되면 오류로 끝난다: 결정을 다시 보내지 않는다", async () => {
    const { session, sent } = stage([UNAUTHORIZED(), UNAUTHORIZED()]);

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("error");
    expect(outcome.errorCopy).toMatch(/로그인이 만료/);
    // 결정 한 번, 갱신 한 번. 갱신이 실패했으니 두 번째 결정은 없다.
    expect(sent.map((request) => request.path)).toEqual([
      DECISION_PATH,
      REFRESH_PATH,
    ]);
    // 세션이 끝났다는 선언은 이 경로의 주인(`authedResponse`)만 한다.
    expect(session.expired).toBeGreaterThan(0);
  });

  it("갱신에 닿지 못해도 오류로 끝난다: 되풀이하지 않는다", async () => {
    const { session, sent } = stage([UNAUTHORIZED(), new TypeError("network down")]);

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("error");
    expect(sent.map((request) => request.path)).toEqual([
      DECISION_PATH,
      REFRESH_PATH,
    ]);
    // 닿지 못한 것은 세션이 끝났다는 뜻이 아니다 (#3993). 잠금 화면에서 돌아와 누른 순간
    // 무선이 아직 깨는 중이었을 뿐이므로, 「다시 로그인」이 아니라 「연결을 확인하고 다시
    // 눌러 주세요」라고 말하고, 만료를 선언하지 않는다.
    expect(outcome.errorCopy).toMatch(/서버에 닿지 못했어요/);
    expect(outcome.errorCopy).not.toMatch(/로그인이 만료/);
    expect(session.expired).toBe(0);
  });

  it("갱신 서버가 오류(503)로 답해도 로그인 만료로 말하지 않는다", async () => {
    const { session } = stage([
      UNAUTHORIZED(),
      answer(503, { error: { message: "unavailable" } }),
    ]);

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("error");
    expect(outcome.errorCopy).toMatch(/서버에 닿지 못했어요/);
    expect(outcome.errorCopy).not.toMatch(/로그인이 만료/);
    expect(session.expired).toBe(0);
  });

  it("닿지 못한 뒤 같은 키로 다시 누르면 그때 갱신해서 결정된다", async () => {
    const { session, sent } = stage([
      // 첫 시도: 끊겨 있었다.
      UNAUTHORIZED(),
      new TypeError("network down"),
      // 다시 누름: 연결이 돌아왔다.
      UNAUTHORIZED(),
      ROTATED(),
      RECEIPT(),
    ]);

    const first = await decideApproval(WS, APPROVAL, true, KEY);
    const second = await decideApproval(WS, APPROVAL, true, KEY);

    expect(first.kind).toBe("error");
    expect(second.kind).toBe("committed");
    expect(sent.map((request) => request.path)).toEqual([
      DECISION_PATH,
      REFRESH_PATH,
      DECISION_PATH,
      REFRESH_PATH,
      DECISION_PATH,
    ]);
    // 두 번의 결정은 같은 결정이다: 같은 멱등 키가 두 번 나갔다.
    expect(sent[0]?.body?.client_decision_id).toBe(KEY);
    expect(sent[4]?.body?.client_decision_id).toBe(KEY);
    expect(sent[4]?.bearer).toBe("Bearer access-new");
    expect(session.refresh).toBe("refresh-2");
    expect(session.expired).toBe(0);
  });

  it("갱신은 됐는데 다시 보낸 것도 401이면 거기서 끝난다: 루프가 없다", async () => {
    const { session, sent } = stage([
      UNAUTHORIZED(),
      ROTATED(),
      UNAUTHORIZED(),
      // 이 아래는 소비돼서는 안 된다. 루프가 있으면 갱신 한 번과 결정 한 번이 더 나간다.
      ROTATED(),
      RECEIPT(),
    ]);

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("error");
    expect(outcome.errorCopy).toMatch(/로그인이 만료/);
    expect(sent.map((request) => request.path)).toEqual([
      DECISION_PATH,
      REFRESH_PATH,
      DECISION_PATH,
    ]);
    expect(session.expired).toBeGreaterThan(0);
  });

  it("갱신할 토큰이 없으면 갱신 요청 없이 오류로 끝난다", async () => {
    const { session, sent } = stage([UNAUTHORIZED()]);
    session.refresh = "";

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("error");
    expect(sent.map((request) => request.path)).toEqual([DECISION_PATH]);
  });
});

describe("401이 아닌 답은 갱신 없이 영수증으로 읽힌다 (#3926)", () => {
  it("200은 갱신하지 않는다", async () => {
    const { sent } = stage([RECEIPT()]);

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("committed");
    expect(sent.map((request) => request.path)).toEqual([DECISION_PATH]);
    expect(sent[0]?.bearer).toBe("Bearer access-old");
  });

  it("409에 실린 확정 영수증은 오류가 아니라 다른 곳의 결정으로 읽힌다", async () => {
    const { sent } = stage([
      answer(409, { approvalId: APPROVAL, status: "rejected" }),
    ]);

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("superseded");
    expect(outcome.status).toBe("rejected");
    expect(sent.map((request) => request.path)).toEqual([DECISION_PATH]);
  });

  it("403 영수증은 역할 부족으로 읽힌다: 갱신하지 않는다", async () => {
    const { sent } = stage([answer(403, { status: "role_required" })]);

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("error");
    expect(outcome.errorCode).toBe("role_required");
    expect(sent.map((request) => request.path)).toEqual([DECISION_PATH]);
  });

  it("5xx는 갱신 없이 서버 오류 문장으로 끝난다", async () => {
    const { sent } = stage([answer(503, { error: { message: "busy" } })]);

    const outcome = await decideApproval(WS, APPROVAL, true, KEY);

    expect(outcome.kind).toBe("error");
    expect(outcome.errorCopy).toMatch(/서버가 오류로 답했어요/);
    expect(sent).toHaveLength(1);
  });
});
