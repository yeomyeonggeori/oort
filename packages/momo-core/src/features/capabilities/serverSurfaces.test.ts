import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import {
  ABSENT_STATUSES,
  HOST_GATED_SURFACE_IDS,
  allServerSurfaces,
  hasOnlineWorkHost,
  isWorkHostUsableBy,
  isSurfaceProvided,
  pluginInstallVerdict,
  surfaceProvidedWithHosts,
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
  it("2026-10-16 실측: 검색·승인 결정·작업 기록·팀 기억·앱 보기가 제공되고 나머지는 아직 없다", () => {
    // 승인은 2026-08-02에 false였고, goal SRV-T1(#979)이 서버 라우트 셋을 올린
    // 뒤 뒤집혔다(lib.rs:555-564). 작업 기록은 2026-08-04까지 false였고 #1223이
    // 읽기 3경로를 올린 뒤 뒤집혔다. 이 목록은 표의 값을 못으로 박아 두는 자리라,
    // 뒤집힌 줄을 지우지 않고 위 칸으로 옮긴다: 다음에 어떤 표면이 이식되면
    // 이 테스트가 이름을 부르며 실패해서 표와 함께 고쳐지게 된다.
    //
    // 이 줄이 재는 것은 **표의 값**이지 서버의 사실이 아니다. 그 사실을 못으로
    // 박는 것은 라우터 소스를 직접 읽는 웹 스위트(clients/web 의
    // `features/agents/agentRunHistoryRoutes.test.ts`)이고, 둘은 함께 읽어야 한다.
    //
    // `plugins`(앱 보기)는 2026-10-16에 뒤집혔다(#3861이 읽기 둘을 올렸다). 설치·권한
    // 네 경로는 아직 없어서 `pluginInstall`(앱 설치)은 거짓으로 남고, 그 줄은 표 대신
    // 서버가 보여 준 사실로 켜진다(아래 「앱 설치 탐지」).
    for (const id of [
      "messageSearch",
      "approvals",
      "agentRunHistory",
      "teamMemory",
      "plugins",
    ] as const) {
      expect(isSurfaceProvided(id)).toBe(true);
    }
    for (const id of [
      "workstreams",
      "workConsole",
      "work",
      "ade",
      "huddles",
      "pluginInstall",
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

describe("작업 표면 런타임 판정 (#2780)", () => {
  const self = "00000000-0000-7000-8000-000000000101";
  const other = "00000000-0000-7000-8000-000000000102";
  const online = { online: true };
  const offline = { online: false };
  const revoked = { online: true, revokedAtMs: 1_800_000_000_000 };

  it("온라인이고 해지되지 않은 호스트가 하나라도 있으면 참이다", () => {
    expect(hasOnlineWorkHost([offline, online])).toBe(true);
    expect(hasOnlineWorkHost([{ online: true, revokedAtMs: null }])).toBe(true);
  });

  it("호스트가 없거나, 전부 오프라인이거나, 해지됐거나, 아직 모르면 거짓이다", () => {
    expect(hasOnlineWorkHost([])).toBe(false);
    expect(hasOnlineWorkHost([offline, offline])).toBe(false);
    expect(hasOnlineWorkHost([revoked])).toBe(false);
    expect(hasOnlineWorkHost(undefined)).toBe(false);
    expect(hasOnlineWorkHost(null)).toBe(false);
  });

  it("일을 시킬 수 있는 호스트는 팀 공용이거나 내 것이다 (#2893 · #2854 결정 (a))", () => {
    expect(isWorkHostUsableBy({ scope: "workspace", ownerMemberId: other }, self)).toBe(true);
    expect(isWorkHostUsableBy({ scope: "member", ownerMemberId: self.toUpperCase() }, self)).toBe(true);
    expect(isWorkHostUsableBy({ scope: "member", ownerMemberId: other }, self)).toBe(false);
  });

  it("런타임으로 펼치는 표면은 작업 콘솔·코드 실행 호스트·관제 셋이다", () => {
    expect([...HOST_GATED_SURFACE_IDS]).toEqual(["workConsole", "work", "ade"]);
  });

  it("셋은 온라인 호스트가 있을 때만 펼친다", () => {
    for (const id of HOST_GATED_SURFACE_IDS) {
      expect(surfaceProvidedWithHosts(id, false, false)).toBe(false);
      expect(surfaceProvidedWithHosts(id, false, true)).toBe(true);
    }
  });

  it("작업 흐름과 앱 설치는 호스트가 있어도 펼치지 않는다(호스트가 정하는 표면이 아니다)", () => {
    expect(surfaceProvidedWithHosts("workstreams", false, true)).toBe(false);
    expect(surfaceProvidedWithHosts("pluginInstall", false, true)).toBe(false);
  });

  it("정적으로 제공되는 표면은 호스트와 무관하게 참이다", () => {
    expect(surfaceProvidedWithHosts("messageSearch", true, false)).toBe(true);
    expect(surfaceProvidedWithHosts("work", true, false)).toBe(true);
  });
});

describe("앱 설치 탐지 (#3860, ADR-0113 증보 P3)", () => {
  // 설치·권한 경로에 GET을 보낸 상태 코드 둘(설치, 권한)로 판정한다. 이 경로들은
  // POST·DELETE로만 등록되므로 서 있으면 405, 없으면 404다.

  it("둘 다 405면 경로가 서 있다: 이 판정은 405를 serverSaysAbsent와 반대로 읽는다", () => {
    expect(pluginInstallVerdict([405, 405])).toBe("present");
    // 같은 상태 코드, 반대 답. 405를 「없다」로 읽는 함수를 여기 쓰면 이 줄이 빨개진다.
    expect(serverSaysAbsent(new ApiError(405, "method not allowed"))).toBe(true);
  });

  it("2xx는 서 있다는 증거가 아니다: 모든 경로에 200을 답하는 가짜 서버가 설치를 열면 안 된다", () => {
    // 게이트·캡처 하네스는 모르는 경로에 `{}`와 200을 돌려준다. 그것이 「앱 설치」를
    // 열어 버리면 하네스가 오늘의 서버가 아닌 서버를 말하게 된다.
    expect(pluginInstallVerdict([200, 200])).toBe("unknown");
    expect(pluginInstallVerdict([200, 405])).toBe("unknown");
    expect(pluginInstallVerdict([204, 204])).toBe("unknown");
  });

  it("404와 501은 경로가 없다는 서버의 답이다", () => {
    expect(pluginInstallVerdict([404, 404])).toBe("absent");
    expect(pluginInstallVerdict([501, 501])).toBe("absent");
  });

  it("하나라도 없으면 반쪽이고 반쪽은 열지 않는다", () => {
    // 설치 경로만 서고 권한 경로가 없으면 한쪽 버튼은 눌러도 404다.
    expect(pluginInstallVerdict([405, 404])).toBe("absent");
    expect(pluginInstallVerdict([404, 405])).toBe("absent");
  });

  it("경로에 대한 진술이 아닌 답은 모른다고 하고, 모르면 닫는다", () => {
    for (const status of [400, 401, 403, 409, 429, 500, 502, 503]) {
      expect(pluginInstallVerdict([405, status])).toBe("unknown");
      expect(pluginInstallVerdict([status, status])).toBe("unknown");
    }
  });

  it("아직 답이 없으면 모른다", () => {
    expect(pluginInstallVerdict(undefined)).toBe("unknown");
    expect(pluginInstallVerdict([])).toBe("unknown");
  });

  it("앱 설치 줄은 정적으로 꺼져 있고 사람에게 할 말을 갖는다", () => {
    const surface = serverSurface("pluginInstall");
    expect(surface.provided).toBe(false);
    expect(surface.label).toBe("앱 설치");
    // 화면의 차분한 안내 줄이 이 문장을 그대로 쓴다.
    expect(surface.fallback).toContain("설치는 곧 열려요");
  });

  it("앱 보기 줄의 라벨은 사용자가 부르는 이름 「앱」이다", () => {
    // 「앱 보기」는 설치와 갈라 읽기만 말하려는 표면 이름이고 화면에 나가지 않는다.
    expect(serverSurface("plugins").label).toBe("앱");
  });
});
