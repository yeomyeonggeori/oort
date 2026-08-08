import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import {
  ABSENT_STATUSES,
  allServerSurfaces,
  isSurfaceProvided,
  serverSaysAbsent,
  serverSurface,
} from "./serverSurfaces";

// 판정표는 이 배치의 산출물 그 자체다. 표가 조용히 틀어지면 화면은 없는 기능을
// 있다고 하거나 있는 기능을 없다고 하게 되고, 둘 다 goal B12가 고치려는 것이다.

describe("미제공 판정", () => {
  it("서버가 '그런 경로 없다'고 답한 것만 미제공으로 읽는다", () => {
    for (const status of ABSENT_STATUSES) {
      expect(serverSaysAbsent(new ApiError(status, "nope"))).toBe(true);
    }
  });

  it("405가 포함된다: 경로가 POST 전용이면 GET은 404가 아니라 405로 돌아온다", () => {
    // 실측: GET /v1/workspaces/{ws}/channels/{ch}/agent-runs.
    // 404만 보는 판정은 이 표면을 '장애'로 그린다.
    expect(ABSENT_STATUSES).toContain(405);
    expect(serverSaysAbsent(new ApiError(405, "method not allowed"))).toBe(true);
  });

  it("권한·서버 오류·네트워크 실패는 기능 유무에 대한 진술이 아니다", () => {
    for (const status of [400, 401, 403, 409, 429, 500, 502, 503]) {
      expect(serverSaysAbsent(new ApiError(status, "no"))).toBe(false);
    }
    expect(serverSaysAbsent(new NetworkError("timeout", 15_000))).toBe(false);
    expect(serverSaysAbsent(new NetworkError("unreachable", 15_000))).toBe(false);
    expect(serverSaysAbsent(new Error("그냥 오류"))).toBe(false);
    expect(serverSaysAbsent(null)).toBe(false);
  });

  it("503은 미제공이 아니다: 잠깐 아픈 서버를 영영 없는 기능으로 만들면 안 된다", () => {
    // 허들만 503을 자기 표면에서 '미구성'으로 함께 읽는다(운영자가 LiveKit을 끄고
    // 올린 경우). 그것은 그 표면의 규칙이지 이 공용 판정의 규칙이 아니다.
    expect(ABSENT_STATUSES).not.toContain(503);
  });
});

describe("표면 판정표", () => {
  it("2026-08-04 실측: 검색과 승인 결정이 제공되고 나머지는 아직 없다", () => {
    // 승인은 2026-08-02에 false였고, goal SRV-T1(#979)이 서버 라우트 셋을 올린
    // 뒤 뒤집혔다(lib.rs:555-564). 이 목록은 표의 값을 못으로 박아 두는 자리라,
    // 뒤집힌 줄을 지우지 않고 위 칸으로 옮긴다: 다음에 어떤 표면이 이식되면
    // 이 테스트가 이름을 부르며 실패해서 표와 함께 고쳐지게 된다.
    for (const id of ["messageSearch", "approvals"] as const) {
      expect(isSurfaceProvided(id)).toBe(true);
    }
    for (const id of [
      "workstreams",
      "huddles",
      "agentRunHistory",
      "plugins",
      "agentMemory",
    ] as const) {
      expect(isSurfaceProvided(id)).toBe(false);
    }
  });

  it("모든 줄이 사람에게 할 말과 대체 행동을 갖는다", () => {
    for (const surface of allServerSurfaces()) {
      expect(surface.label).not.toBe("");
      expect(surface.absentReason).not.toBe("");
      expect(surface.fallback).not.toBe("");
      expect(surface.measured).not.toBe("");
    }
  });

  it("사용자 문구에 내부 용어·경로·상태 코드가 새지 않는다", () => {
    // 읽는 사람은 이 서버를 고르는 사람이지 만드는 사람이 아니다. `measured`는
    // 화면에 나가지 않으므로 이 규칙에서 제외된다.
    for (const surface of allServerSurfaces()) {
      const copy = `${surface.absentReason} ${surface.fallback}`;
      expect(copy).not.toMatch(/\/v1\//);
      expect(copy).not.toMatch(/\b(404|405|501|GET|POST|PUT|DELETE|REST|API)\b/);
      expect(copy).not.toMatch(/momo-server|server-rust|라우터|엔드포인트/);
    }
  });

  it("사용자 문구에 em-dash가 없다 (design-taste-web §7: 이진 실패)", () => {
    for (const surface of allServerSurfaces()) {
      expect(`${surface.label}${surface.absentReason}${surface.fallback}`).not.toMatch(
        /[—–]/
      );
    }
  });

  it("표의 키와 줄의 id가 어긋나지 않는다", () => {
    for (const surface of allServerSurfaces()) {
      expect(serverSurface(surface.id)).toBe(surface);
    }
  });
});
