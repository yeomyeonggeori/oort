import { buildMode } from "../../runtime/host";
// =============================================================================
// 이 서버가 아직 싣지 않은 표면 (goal B12 / QA H1).
//
// 이 클라이언트는 Swift 서버의 계약을 보고 자랐고, 지금 이야기하는 상대는 그
// 계약의 일부만 이식한 Rust 서버다. 그래서 화면 여럿이 **없는 경로를 부르고 그
// 404를 장애로 그렸다**. 사용자 자리에서 그것은 "이 앱은 고장났다"로 읽힌다.
// 없는 기능을 장애라고 말하는 것은 있는 기능을 없다고 말하는 것과 같은 크기의
// 거짓말이라, 고칠 것은 배너의 문구가 아니라 판정이다.
//
// 여기는 **그 판정이 사는 한 곳**이다. 표면별 제공 여부가 코드 여기저기 흩어지면
// 다음 배치가 라우트를 이식하고도 화면은 계속 "준비 중"이라고 말한다. 이식하는
// 사람이 고쳐야 할 것은 아래 표의 `provided: false` 한 줄이어야 한다.
//
// ## 두 겹으로 막는다
//
//   (a) **정적 판정** — 아래 표. 진입점을 세울지 말지를 정한다. 요청을 한 번도
//       보내지 않고 답하므로, 없는 표면은 404를 만들지조차 않는다.
//   (b) **런타임 접기** — `serverSaysAbsent`. 표가 틀렸거나(서버가 우리보다
//       앞서 갔거나 뒤처졌거나) 표에 없는 경로가 404를 받으면, 그것을 오류가
//       아니라 "미제공"으로 접는다.
//
// (a)만 있으면 표가 곧 거짓말이 되고, (b)만 있으면 모든 화면이 일단 실패한 뒤에야
// 정직해진다. 둘 다 필요하다.
//
// ## 미제공과 장애는 다른 문장이다
//
// 사용자는 "내 인터넷 문제"와 "아직 없는 기능"을 구분할 수 있어야 한다. 전자는
// 다시 시도할 일이고 후자는 기다릴 일이다. 그래서 `serverSaysAbsent`가 참인
// 것만 미제공 문구를 받고, 네트워크 장애·5xx·401/403은 기존 오류/오프라인
// 문구를 그대로 쓴다. 이 규칙은 이 파일이 발명한 것이 아니라 이미 이 코드베이스가
// 쓰던 것이다(features/routing/capability.ts, features/huddles/huddleModel.ts).
//
// ## 실측 방법과 시점
//
// 2026-08-02, `server-rust/bins/momo-server/src/lib.rs`의 등록된 라우트 55개를
// 클라이언트가 부르는 모든 `/v1/` 경로와 **메서드까지 맞춰** 대조했다. 경로만
// 비교하면 아래 `agentRunHistory`를 놓친다: 그 경로는 POST로 등록돼 있어서 GET은
// 404가 아니라 **405**로 돌아온다.
// =============================================================================

import { ApiError } from "../../lib/api";

/**
 * 서버가 "그런 경로 없다"고 **직접 답한** 상태 코드.
 *
 * 이 셋만 "없다"로 읽는다. 401/403은 권한 이야기이고, 5xx는 서버가 아팠다는
 * 뜻이며, 네트워크 실패는 아무도 답하지 않은 것이라 셋 다 기능 유무에 대한
 * 진술이 아니다. 그것들을 "미제공"으로 접으면 이 파일은 반대 방향의 거짓말을
 * 하게 된다: 잠깐 아픈 서버를 영영 없는 기능으로 만든다.
 *
 * 405가 들어 있는 이유는 취향이 아니라 실측이다. `GET …/channels/{ch}/agent-runs`
 * 는 경로가 POST 전용으로 등록돼 있어 405로 돌아온다. 404만 보는 판정은 그 표면을
 * 장애로 그린다.
 */
export const ABSENT_STATUSES: readonly number[] = [404, 405, 501];

/**
 * 이 오류가 "이 서버에는 그 기능이 없다"는 서버의 답인가.
 *
 * 참이면 미제공 상태로 접고, 거짓이면 기존 오류 처리를 그대로 태운다.
 */
export function serverSaysAbsent(error: unknown): boolean {
  return error instanceof ApiError && ABSENT_STATUSES.includes(error.status);
}

export type SurfaceId =
  | "workstreams"
  | "approvals"
  | "huddles"
  | "agentRunHistory"
  | "plugins"
  | "agentMemory"
  | "messageSearch";

export interface ServerSurface {
  id: SurfaceId;
  /**
   * 사용자가 이 표면을 부르는 이름. 화면 문구가 이 말을 쓴다.
   *
   * **가는 길도 이 말을 쓴다** (이슈 #1146 N4). 진입점이 자기 낱말을 따로 적으면
   * 한 목적지에 이름이 둘 생기고, 그 순간 사람은 그것을 두 기능으로 센다 —
   * 팔레트가 이미 「멤버 ↔ 디렉터리」에서 같은 값을 치르고 한 이름으로 모았다
   * (`QuickSwitcher` R-1 어휘 계승). 그래서 이 필드는 「없을 때 할 말」의 재료가
   * 아니라 **그 표면의 이름 자체**이고, 사이드바 줄·팔레트 항목·라우트의 제목이
   * 함께 읽는다.
   */
  label: string;
  /** 이 서버가 이 표면의 REST를 싣고 있는가 (2026-08-02 실측). */
  provided: boolean;
  /**
   * 못 하는 이유 한 문장. 내부 용어·코드명·경로·상태 코드를 쓰지 않는다:
   * 읽는 사람은 이 서버를 고르는 사람이지 이 서버를 만드는 사람이 아니다.
   */
  absentReason: string;
  /** 대신 지금 할 수 있는 일. 없는 표면 앞에서 사용자를 막다른 길에 두지 않는다. */
  fallback: string;
  /**
   * 실측 근거. 사용자에게 보이지 않는다. 다음 배치가 이 줄을 다시 재지 않고
   * 믿을 수 있게, 무엇을 무엇과 대조했는지 남긴다.
   */
  measured: string;
}

/**
 * 표면 판정표. **이식하면 이 표의 `provided`만 바꾼다.**
 *
 * 순서는 사용자가 마주칠 확률 순이 아니라 이 배치가 실측한 순서다. 표가 짧게
 * 유지되는 한 순서는 중요하지 않고, 중요한 것은 **빠진 줄이 없는 것**이다.
 */
const SURFACES: Record<SurfaceId, ServerSurface> = {
  workstreams: {
    id: "workstreams",
    label: "작업 흐름",
    provided: false,
    absentReason: "이 서버는 아직 작업 흐름을 다루지 않습니다.",
    fallback: "채널에서 작업 세션을 열면 지금도 같은 일을 이어갈 수 있습니다.",
    measured:
      "GET/POST …/workstreams, …/workstreams/{id}, …/workstreams/{id}/runs: 라우터에 없음(404).",
  },
  approvals: {
    id: "approvals",
    label: "승인 결정",
    // 2026-08-04, 이 표에서 뒤집힌 첫 줄이다. 앞 값(false)은 2026-08-02에 참이었고
    // 지금은 아니다: goal SRV-T1(#979)이 승인 3라우트를 서버에 올렸다.
    //
    // 이 칸이 말하는 것은 **이 코드베이스의 서버가 그 경로를 싣고 있는가**이지,
    // 지금 이야기하는 서버가 그 경로를 답하는가가 아니다. 아직 배포되지 않은
    // 서버에 붙으면 404가 오고, 그것은 이 파일 상단이 설명하는 (b) 런타임 폴딩이
    // `serverSaysAbsent`로 접는다. 그래서 `absentReason`·`fallback`은 지우지 않고
    // 남겨 둔다 — 이제 그 문구를 쓰는 것은 정적 판정이 아니라 폴딩이다.
    provided: true,
    absentReason: "이 서버는 아직 승인 결정을 기록하지 않습니다.",
    fallback: "에이전트가 멈춰 서면 채널에서 직접 이야기해 진행 여부를 정하세요.",
    measured:
      "2026-08-04 실측: server-rust/bins/momo-server/src/lib.rs:555-564에 셋 다 등록됨 — " +
      "GET …/approvals(routes::approvals::list), " +
      "POST …/approvals/{approval}/decision(decide_by_approval), " +
      "POST /v1/agent-runs/{run}/approval-decisions(decide_by_run). " +
      "직전 줄은 'PR 947(B5.3b)은 클라이언트 22개 파일만 바꿨고 서버 라우트는 " +
      "올리지 않았다'였고, 그 뒤 goal SRV-T1이 그 라우트를 올렸다.",
  },
  huddles: {
    id: "huddles",
    label: "음성 허들",
    provided: false,
    absentReason: "이 서버에서는 음성 허들을 사용하지 않습니다.",
    fallback: "채널에서 글로 이야기하세요.",
    measured:
      "…/channels/{ch}/huddles, /active, …/huddles/{id}/join, /leave: 라우터에 없음(404). " +
      "허들 표면은 goal B6에서 이미 조용히 접히므로 이 줄은 기록용이다.",
  },
  agentRunHistory: {
    id: "agentRunHistory",
    label: "에이전트 작업 기록",
    provided: false,
    // 없는 것은 **읽는 경로뿐이다**. 기록 자체는 지금도 쌓인다:
    // `POST …/channels/{ch}/agent-runs`가 `agent_run` 행을 쓰고(agent_runs.rs의
    // `create_agent_run_in_tx`), 게이트웨이의 events/complete가 그 행을 이어서
    // 갱신한다. 그러니 "기록을 남기지 않습니다"는 틀린 문장이었다. 저장되고
    // 있는 것을 저장 안 된다고 말하는 것은 이 배치가 없애려던 오류를 반대
    // 방향으로 저지르는 일이다. 사람에게 참인 문장은 "아직 볼 수 없다"이다.
    absentReason: "이 서버는 에이전트가 한 일의 기록을 아직 보여주지 못합니다.",
    fallback:
      "기록은 쌓이고 있습니다. 지금 확인할 수 있는 것은 에이전트가 채널에 남긴 메시지입니다.",
    measured:
      "쓰기는 있다: POST …/channels/{ch}/agent-runs(agent_run 행 생성), " +
      "게이트웨이 events/complete. 없는 것은 읽기다: " +
      "GET …/channels/{ch}/agent-runs는 경로가 POST 전용이라 405, " +
      "GET …/agents/{id}/runs와 GET …/agent-runs/{id}는 라우터에 없음(404).",
  },
  plugins: {
    id: "plugins",
    label: "앱",
    provided: false,
    absentReason: "이 서버는 아직 앱 설치를 받지 않습니다.",
    fallback: "에이전트는 앱 없이도 채널에서 바로 일할 수 있습니다.",
    measured:
      "GET …/plugins 및 install/grants 6경로: 라우터에 없음(404).",
  },
  agentMemory: {
    id: "agentMemory",
    label: "에이전트 기억",
    provided: false,
    absentReason: "이 서버는 아직 에이전트의 기억을 보관하지 않습니다.",
    fallback: "필요한 맥락은 채널에서 다시 알려주면 에이전트가 그대로 씁니다.",
    measured:
      "GET …/memories, …/memories/search, …/memories/{id}/grants, " +
      "POST …/memories/{id}/invalidate: 라우터에 없음(404).",
  },
  messageSearch: {
    id: "messageSearch",
    label: "메시지 검색",
    // 있는 기능을 없다고 말하는 것도 이 파일이 막아야 할 거짓말이다. 이 줄은
    // 그 방향의 유일한 참 값이고, goal B12 H5가 배선하는 대상이다.
    provided: true,
    absentReason: "이 서버는 아직 메시지 검색을 제공하지 않습니다.",
    fallback: "채널을 열어 직접 찾아보세요.",
    measured:
      "GET …/search/messages: 라우터에 있음(routes::search::messages).",
  },
};

// ---- 게이트 빌드의 이음매 --------------------------------------------------
//
// 위 표는 **프로덕션 빌드가 이야기하는 서버**에 대한 사실이다. Playwright 게이트는
// 그 서버가 아니라 자기 픽스처를 띄우고, 그 픽스처는 해당 경로를 **실제로 답한다**
// (gates/gate-workstream.mjs, gates/gate-agent-hub.mjs). 그 빌드에서까지 표면을
// 접으면 게이트는 아무것도 검증하지 못한 채 초록으로 남고, 라우트가 이식되는 날
// 아무도 그 사실을 모른다.
//
// 그래서 게이트 모드만 자기 픽스처의 형상을 선언한다. 이것은 사용자에게 기능이
// 있는 척하는 것이 아니라 **테스트 하네스가 자기 서버를 진술하는 것**이고, 같은
// 이음매를 이 코드베이스가 이미 쓰고 있다(features/agents/turnFixture.ts).
//
// 프로덕션은 이 분기에 닿을 수 없다: `vite build`는 MODE=production으로 컴파일되고
// 아래 표에 그 이름이 없다. 게이트 모드 이름은 package.json의 `--mode` 값이다.
//
// goal RN-C1: 그 모드는 `import.meta.env.MODE` 였다. `import.meta` 는 Vite 전용이라
// Metro/Hermes 에는 없으므로, 값 자체는 그대로 두고 **읽는 경로만** 호스트 포트로
// 옮겼다(웹 호스트가 같은 `import.meta.env.MODE` 를 넘긴다 — clients/web/src/lib/
// coreHost.ts). 판정도 표도 바뀌지 않는다.
const GATE_FIXTURE_SURFACES: Record<string, readonly SurfaceId[]> = {
  "workstream-gate": ["workstreams"],
  "agent-hub-gate": ["agentMemory", "agentRunHistory"],
};

function gateProvided(id: SurfaceId): boolean {
  const mode = buildMode();
  if (mode === "production") return false;
  return GATE_FIXTURE_SURFACES[mode]?.includes(id) ?? false;
}

/** 이 서버가 그 표면을 싣고 있는가. 진입점을 세울지 말지를 이걸로 정한다. */
export function isSurfaceProvided(id: SurfaceId): boolean {
  return SURFACES[id].provided || gateProvided(id);
}

/** 표면 한 줄 전체. 화면이 문구를 직접 짓지 않고 여기서 받아 간다. */
export function serverSurface(id: SurfaceId): ServerSurface {
  return SURFACES[id];
}

/** 판정표 전체. 테스트와 진단 화면이 표를 통째로 훑을 때 쓴다. */
export function allServerSurfaces(): readonly ServerSurface[] {
  return Object.values(SURFACES);
}
