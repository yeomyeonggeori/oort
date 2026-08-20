import { describe, expect, it } from "vitest";
import { asWorkSessionControlFrame } from "../../lib/realtimeEvents";
import type { WorkSessionControlFrame } from "../../lib/realtimeEvents";
import {
  CONTROL_CLOSED_HEADLINE,
  CONTROL_OPEN_DETAIL,
  CONTROL_OPEN_HEADLINE,
  controlWindowLabel,
  controlWindowNotice,
  latestControlNotice,
} from "./controlWindow";

const SESSION = "019FA1C4-3B21-7D0E-9AA1-5E6C82F41B77";

function frame(
  over: Partial<WorkSessionControlFrame["payload"]> = {},
  ts = 1_785_180_100_000
): WorkSessionControlFrame {
  return {
    type: "work.session.control",
    v: 1,
    ts,
    payload: {
      session_id: SESSION,
      state: "opened",
      started_at: 1_785_180_100_000,
      ...over,
    },
  };
}

describe("경계 봉투를 읽는 규칙", () => {
  it("서버가 만드는 봉투 그대로를 읽는다", () => {
    // `control_window_payload` 가 쓰는 모양. 필드 이름이 어긋나면 여기서 빨개진다.
    const parsed = asWorkSessionControlFrame({
      type: "work.session.control",
      v: 1,
      ts: 1_785_180_200_000,
      payload: {
        session_id: SESSION,
        state: "closed",
        started_at: 1_785_180_100_000,
        ended_at: 1_785_180_200_000,
        end_reason: "returned",
      },
    });
    expect(parsed?.payload.end_reason).toBe("returned");
  });

  it("정지 시각 없는 봉투는 계약 밖이다", () => {
    expect(
      asWorkSessionControlFrame({
        type: "work.session.control",
        v: 1,
        ts: 1,
        payload: { session_id: SESSION, state: "opened" },
      })
    ).toBeNull();
  });

  it("모르는 state 는 읽지 않는다", () => {
    expect(
      asWorkSessionControlFrame({
        type: "work.session.control",
        v: 1,
        ts: 1,
        payload: { session_id: SESSION, state: "renewed", started_at: 1 },
      })
    ).toBeNull();
  });

  it("다른 봉투를 이 봉투로 읽지 않는다", () => {
    expect(
      asWorkSessionControlFrame({
        type: "work.session.observer",
        v: 1,
        ts: 1,
        seq: 1,
        payload: { session_id: SESSION, observer_count: 2 },
      })
    ).toBeNull();
  });

  it("봉투에 누가 잡고 있는지는 없다 (증보 3 D3)", () => {
    const parsed = asWorkSessionControlFrame(frame());
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!.payload)).not.toContain("grantee_member_id");
    expect(Object.keys(parsed!.payload)).not.toContain("grantee");
  });
});

describe("세션 표면이 말할 것", () => {
  it("다른 세션의 창은 이 세션에 그리지 않는다", () => {
    expect(
      controlWindowNotice(
        frame({ session_id: "019FA1C4-0000-0000-0000-000000000000" }),
        SESSION
      )
    ).toBeNull();
  });

  it("uuid 대소문자는 판정을 바꾸지 않는다", () => {
    expect(
      controlWindowNotice(frame({ session_id: SESSION.toLowerCase() }), SESSION)
    ).not.toBeNull();
  });

  it("열린 창은 왜 조용한지와 무엇이 여전히 참인지를 함께 말한다", () => {
    const notice = controlWindowNotice(frame(), SESSION);
    expect(notice).toEqual({
      state: "open",
      startedAtMs: 1_785_180_100_000,
      endedAtMs: null,
      outcome: null,
      headline: CONTROL_OPEN_HEADLINE,
      detail: CONTROL_OPEN_DETAIL,
    });
    // 증보 3 D6: 멈춘 것은 에이전트 런 층이지 VM 이 아니다. 「멈췄다」가
    // 「꺼졌다」로 읽히지 않게 하는 문장.
    expect(CONTROL_OPEN_DETAIL).toContain("호스트는 계속 실행 중");
    expect(CONTROL_OPEN_DETAIL).toContain("사용 시간도 계속");
  });

  it("닫힌 창은 카드와 같은 결과 문장을 쓴다", () => {
    const notice = controlWindowNotice(
      frame(
        { state: "closed", ended_at: 1_785_180_200_000, end_reason: "expired" },
        1_785_180_200_000
      ),
      SESSION
    );
    expect(notice?.headline).toBe(CONTROL_CLOSED_HEADLINE);
    expect(notice?.outcome).toBe("expired");
    expect(notice?.detail).toContain("완료를 가정하지 않고");
    expect(controlWindowLabel(notice!)).toBe("완료 불확실");
  });

  it("원장 어휘 밖의 사유는 문장을 지어내지 않는다", () => {
    const notice = controlWindowNotice(
      frame({ state: "closed", ended_at: 2, end_reason: "revoked" }),
      SESSION
    );
    expect(notice?.outcome).toBeNull();
    expect(notice?.detail).toBe("에이전트가 이 세션에서 다시 실행됩니다.");
    expect(controlWindowLabel(notice!)).toBe("종료됨");
  });

  it("한 창은 한 줄이다 — 가장 최근 사실만 선다", () => {
    const opened = frame();
    const closed = frame(
      { state: "closed", ended_at: 1_785_180_200_000, end_reason: "returned" },
      1_785_180_200_000
    );
    expect(latestControlNotice([opened, closed], SESSION)?.state).toBe("closed");
    // 도착 순서가 뒤집혀도 답은 같다.
    expect(latestControlNotice([closed, opened], SESSION)?.state).toBe("closed");
  });

  it("같은 밀리초에 열리고 닫힌 창은 닫힘이 이긴다", () => {
    const at = 1_785_180_100_000;
    const opened = frame({}, at);
    const closed = frame(
      { state: "closed", ended_at: at, end_reason: "expired" },
      at
    );
    expect(latestControlNotice([closed, opened], SESSION)?.state).toBe("closed");
  });

  it("들은 것이 없으면 없다고 단언하지 않는다", () => {
    // `null`은 「창이 없다」가 아니라 「이 화면이 아는 것이 없다」이고, 그 구분은
    // 화면이 `stale`로 지는 것이지 이 함수가 문장으로 지는 것이 아니다.
    expect(latestControlNotice([], SESSION)).toBeNull();
  });
});
