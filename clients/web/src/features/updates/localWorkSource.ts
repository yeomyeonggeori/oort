import { useEffect } from "react";
import type { LocalWorkFacts } from "@momo/core/features/workbench/localWork";
import type { PaneStatusInput } from "@momo/core/features/workbench/paneStatus";
import type { LocalWorkHostStatus } from "@momo/core/features/settings/thisMacHost";
import { uuidEq, type WorkSession } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { useWorkSessions } from "@/features/work/useWorkSessions";
import { localSessions, type LocalSessionView } from "@/features/workbench/local/localSessions";
import { desktopWorkHost, isDesktop } from "@/lib/tauri";
import { useUpdateState, type LocalWorkSource } from "./store";

// =============================================================================
// 업데이트 뒤 다시 시작이 기다릴 「이 맥의 로컬 작업」을 모은다 (#5661). 판정은 코어
// (`@momo/core/features/workbench/localWork`) 한 곳이고, 여기는 이미 있는 사실을 그 모양으로 옮기기만 한다:
//
//   터미널 칸   앱에 하나인 칸 관리자(`localSessions()`)의 지금 모습. 칸 상태 판정과 같은 입력(`paneAttention.ts`).
//   작업 데몬   셸의 `work_host_status`. 못 읽으면 모름.
//   그 세션     서버 원장(`useWorkSessions`)에서 이 맥 호스트(`registered.hostId`)의 세션만. 원장 읽기는 로그인한 셸에서
//               `RestartWorkWatch`가 새 판을 받는 동안·설치 뒤에만 켠다(15초). 다른 워크스페이스에 등록된 데몬, 1분 넘게
//               새로 못 읽은 원장, 로그인 전 연결 화면은 모름이다: 끊지 않는다.
//
// 다시 읽기(`refresh`)는 저장소의 판정 시계(5초)가 부른다. 두 가지를 직접 한다:
//   - 원장: 질의의 주기 읽기는 창이 숨으면 멈춘다(React Query 기본, 이 앱은 바꾸지 않는다). 창을 메뉴 막대로 치워 둔 채 작업이
//     끝나도 원장이 낡아 「모름」에 머물지 않게, 15초가 지났으면 여기서 다시 읽는다.
//   - 작업 데몬 상태: `work_host_status`는 부를 때마다 하네스 실행 파일을 찾는다(`find_adapters`). 데몬이 서고 지는 일은 드물어
//     30초에 한 번만 다시 묻는다. 못 읽었으면 다음 칸에 다시 묻는다.
// =============================================================================

/** 원장을 이만큼 새로 못 읽었으면 모름이다(읽기 주기의 네 배). */
export const LEDGER_FRESH_MS = 60_000;
/** 기다리는 동안의 원장 읽기 주기. */
export const LEDGER_POLL_WHILE_WAITING_MS = 15_000;
/** 작업 데몬 상태를 다시 묻는 간격. */
export const HOST_REFRESH_MS = 30_000;

/** `undefined` = 아직 읽지 않음, `null` = 읽지 못함. */
let host: LocalWorkHostStatus | null | undefined;
let hostReadAt: number | null = null;
let ledger: { workspaceId: string; sessions: readonly WorkSession[]; at: number } | null = null;
/** `RestartWorkWatch`가 걸어 두는 원장 다시 읽기. 로그인 전·지켜볼 때가 아니면 없다. */
let refetchLedger: (() => Promise<void>) | null = null;
let refreshing: Promise<void> | null = null;

function paneInput(view: LocalSessionView): PaneStatusInput {
  return {
    phase: view.phase,
    exitCode: view.exit?.code ?? null,
    exitSignal: view.exit?.signal ?? null,
    signal: view.signal,
  };
}

/** 원장에서 이 맥 호스트의 세션. 모르면 null. */
function hostSessionsOf(status: LocalWorkHostStatus, now: number): LocalWorkFacts["hostSessions"] {
  const registered = status.registered;
  if (registered === null || ledger === null) return null;
  if (!uuidEq(ledger.workspaceId, registered.workspaceId)) return null;
  if (now - ledger.at > LEDGER_FRESH_MS) return null;
  return ledger.sessions.filter((s) => uuidEq(s.hostId, registered.hostId));
}

export function readLocalWork(now: number = Date.now()): LocalWorkFacts {
  const panes = [...localSessions().getSnapshot().values()].map(paneInput);
  if (host === undefined || host === null) return { panes, workHost: null, hostSessions: null };
  const running = host.sidecar && host.running;
  return { panes, workHost: { running }, hostSessions: running ? hostSessionsOf(host, now) : [] };
}

async function readHost(): Promise<void> {
  try {
    // 셸 밖(브라우저 탭)은 데몬이 없다: `status`가 null을 준다. 셸 안에서 null이면 모름으로 둔다.
    host = isDesktop() ? ((await desktopWorkHost.status()) ?? null) : null;
  } catch {
    host = null;
  }
  hostReadAt = Date.now();
}

async function refreshNow(): Promise<void> {
  const now = Date.now();
  const jobs: Promise<void>[] = [];
  if (host === undefined || host === null || hostReadAt === null || now - hostReadAt >= HOST_REFRESH_MS) {
    jobs.push(readHost());
  }
  if (refetchLedger !== null && (ledger === null || now - ledger.at >= LEDGER_POLL_WHILE_WAITING_MS)) {
    jobs.push(refetchLedger().catch(() => undefined));
  }
  await Promise.all(jobs);
}

export const localWorkSource: LocalWorkSource = {
  refresh() {
    // 겹쳐 부르면(설치 시작의 미리 읽기와 설치 끝의 판정) 한 번만 읽는다.
    refreshing ??= refreshNow().finally(() => {
      refreshing = null;
    });
    return refreshing;
  },
  read: () => readLocalWork(),
};

/**
 * 로그인한 셸에서 이 맥의 작업 세션 원장을 저장소에 건넨다. 아무것도 그리지 않는다. 새 판을 받는 동안부터 읽어 두어,
 * 설치가 끝나는 순간의 판정이 「모름」으로 시작하지 않게 한다.
 */
export function RestartWorkWatch() {
  const state = useUpdateState();
  const { workspaceId } = useSession();
  const watching = isDesktop() && (state.kind === "installing" || state.kind === "installed");
  const sessions = useWorkSessions(workspaceId, LEDGER_POLL_WHILE_WAITING_MS, watching);
  const data = sessions.data;
  const at = sessions.dataUpdatedAt;
  const refetch = sessions.refetch;
  useEffect(() => {
    if (data !== undefined) ledger = { workspaceId, sessions: data, at };
  }, [data, at, workspaceId]);
  // 창이 숨어 질의의 주기 읽기가 멈춰도 판정 시계가 원장을 다시 읽을 수 있게 건다(위 머리말).
  useEffect(() => {
    if (!watching) return;
    refetchLedger = async () => {
      const result = await refetch();
      if (result.data !== undefined) ledger = { workspaceId, sessions: result.data, at: result.dataUpdatedAt };
    };
    return () => {
      refetchLedger = null;
    };
  }, [watching, refetch, workspaceId]);
  useEffect(
    () => () => {
      ledger = null;
    },
    []
  );
  return null;
}

/** 시험 이음새: 모은 것을 비운다. */
export function resetLocalWorkSourceForTest(): void {
  host = undefined;
  hostReadAt = null;
  ledger = null;
  refetchLedger = null;
  refreshing = null;
}
