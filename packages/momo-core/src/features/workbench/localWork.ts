import type { WorkSessionStatusWire } from "../../lib/api";
import { agentSessionStatus } from "./agentPane";
import { derivePaneStatus, type PaneStatusInput } from "./paneStatus";

// =============================================================================
// 이 맥에서 도는 로컬 작업이 있나 — 업데이트 뒤 자동 다시 시작의 문 (#5661, owner 2026-11-11
// 「다시 시작까지 자동으로, 다만 돌고 있는 로컬 작업은 끊지 않는다」).
//
// 다시 시작은 정상 종료를 지나므로(`request_restart()` → `RunEvent::Exit`) 작업 데몬(workd)과
// 모든 터미널 칸이 함께 꺼진다. 그래서 끊기는 것이 있으면 기다린다. 판정은 **이미 있는 사실만**
// 쓴다. 새로 재는 것은 없다:
//
//   터미널 칸   칸 상태 판정 그대로(`derivePaneStatus`: 생명주기 + hook·OSC 7501 보고). 「실행 중」·
//               「응답 필요」면 끊긴다. 하네스가 「대기」·「끝남」을 알린 칸은 쉬는 중이다. 뜨는 중(`starting`)인
//               칸은 곧 프로그램이 돈다.
//               **셸 칸은 늘 「실행 중」이다**: 프롬프트에서 쉬는지 명령을 돌리는지 알려 주는 구조 신호가 없고
//               (`paneStatus.ts`: 「추측하지 않는다」), 모르면 끊지 않는다. 그래서 살아 있는 셸 칸이 하나라도 있으면
//               자동으로 다시 시작하지 않는다. 도크를 닫아도 칸은 돈다.
//   작업 세션   서버 원장의 세션 상태를 칸 머리와 같은 말로 읽는다(`agentSessionStatus`). 이 맥 호스트의 세션만
//               센다. 원장의 `running`은 프로세스가 살아 있는 세션이다: 턴 사이에 쉬는지는 원장이 말하지 않으므로
//               「실행 중」으로 본다(권한 요청을 기다리는 세션도 이 상태다). `idle`은 확인된 일시 중지(주차)라
//               쉬는 중이다.
//   모름        작업 데몬 상태를 읽지 못했거나, 데몬이 도는데 그 세션 목록을 읽지 못했으면(오프라인, 다른 워크스페이스에
//               등록됨, 아직 못 받음) 끊지 않는 쪽이다.
//
// 이 파일은 판정과 「쉬는 상태가 얼마나 이어졌나」의 시계만 진다. 사실을 모으는 일(칸 목록, 데몬 상태, 원장 읽기)과
// 다시 시작은 웹(`clients/web/src/features/updates/`)이 한다. 순수하다: 시계는 인자다.
// =============================================================================

/** 판정의 재료. 모르는 것은 null이다. */
export interface LocalWorkFacts {
  /** 이 앱의 터미널 칸. 같은 프로세스 안의 사실이라 늘 안다(칸이 없으면 빈 목록). */
  readonly panes: readonly PaneStatusInput[];
  /** 이 맥의 작업 데몬. null = 상태를 읽지 못했다. */
  readonly workHost: { readonly running: boolean } | null;
  /**
   * 서버 원장에서 이 맥 호스트에 걸린 세션들. null = 읽지 못했다(데몬이 돌지 않으면 보지 않는다).
   */
  readonly hostSessions: readonly { readonly status: WorkSessionStatusWire }[] | null;
}

export type LocalWorkVerdict =
  | { readonly kind: "clear" }
  | {
      readonly kind: "busy";
      /** 끊길 터미널 칸 수. */
      readonly panes: number;
      /** 끊길 작업 세션 수. */
      readonly sessions: number;
      /** 작업 데몬이나 그 세션을 확인하지 못했다. */
      readonly unknown: boolean;
    };

export const LOCAL_WORK_CLEAR: LocalWorkVerdict = { kind: "clear" };

/** 칸 하나가 다시 시작에 끊기는가. */
export function paneHoldsRestart(pane: PaneStatusInput): boolean {
  if (pane.phase === "starting") return true;
  if (pane.phase !== "running") return false;
  const status = derivePaneStatus(pane);
  return status === "running" || status === "waiting";
}

/** 작업 세션 하나가 다시 시작에 끊기는가. 소유자 화면과 같은 말(`agentSessionStatus`)로 읽는다. */
export function sessionHoldsRestart(session: { readonly status: WorkSessionStatusWire }): boolean {
  const status = agentSessionStatus(session, false, true);
  return status === "running" || status === "waiting";
}

/** 지금 다시 시작하면 끊기는 것. 하나도 없고 모르는 것도 없을 때만 `clear`다. */
export function localWorkVerdict(facts: LocalWorkFacts): LocalWorkVerdict {
  const panes = facts.panes.filter(paneHoldsRestart).length;
  let sessions = 0;
  let unknown = false;
  if (facts.workHost === null) {
    unknown = true;
  } else if (facts.workHost.running) {
    if (facts.hostSessions === null) unknown = true;
    else sessions = facts.hostSessions.filter(sessionHoldsRestart).length;
  }
  if (panes === 0 && sessions === 0 && !unknown) return LOCAL_WORK_CLEAR;
  return { kind: "busy", panes, sessions, unknown };
}

// ---- 쉬는 상태가 이어졌나 -----------------------------------------------------

/**
 * 작업이 끝난 뒤 이만큼 쉬는 상태가 이어져야 다시 시작한다. 하네스가 턴 사이에 「대기」를 알렸다가 곧 다음 턴을 받는
 * 일, 원장 읽기가 한 번 늦게 오는 일(세션 목록은 15초마다 읽는다)을 견딘다.
 */
export const RESTART_QUIET_MS = 2 * 60 * 1000;

export type RestartGate =
  /** 끊길 것이 없다: 짧은 카운트다운 뒤 다시 시작한다. */
  | { readonly kind: "go" }
  /** 끊길 것이 있다(또는 모른다): 기다린다. */
  | { readonly kind: "hold"; readonly verdict: Extract<LocalWorkVerdict, { kind: "busy" }> }
  /** 기다리던 작업이 끝났다: `quietSince`부터 쉬는 상태가 `RESTART_QUIET_MS` 이어지면 다시 시작한다. */
  | { readonly kind: "settling"; readonly quietSince: number };

/**
 * 판정 한 번을 문에 더한다. `prev`가 null이면 설치가 막 끝난 것이다: 끊길 것이 없으면 곧바로 `go`(쉬는 시간을
 * 기다리지 않는다), 있으면 `hold`. 한 번이라도 기다렸으면 쉬는 상태가 벽시계로 `RESTART_QUIET_MS` 이어진 **새 판정**이
 * 와야 `go`다(타이머만으로 풀리지 않는다: 잠에서 깬 직후에도 새로 읽은 사실이 맑아야 한다). `go` 뒤에 끊길 것이
 * 생기면(카운트다운 중에 칸을 열었다) 다시 `hold`다. 시계가 뒤로 가면 그때부터 다시 잰다.
 */
export function restartGateStep(
  prev: RestartGate | null,
  verdict: LocalWorkVerdict,
  now: number
): RestartGate {
  if (verdict.kind === "busy") return { kind: "hold", verdict };
  if (prev === null || prev.kind === "go") return { kind: "go" };
  if (prev.kind === "hold") return { kind: "settling", quietSince: now };
  if (now < prev.quietSince) return { kind: "settling", quietSince: now };
  return now - prev.quietSince >= RESTART_QUIET_MS ? { kind: "go" } : prev;
}
