import { useCallback, useEffect, useState } from "react";
import {
  HOST_GATED_SURFACE_IDS,
  hasOnlineWorkHost,
  isSurfaceProvided,
  surfaceProvidedWithHosts,
  type SurfaceId,
} from "@momo/core/features/capabilities/serverSurfaces";
import { useSession } from "@/app/session";
import { useWorkHosts } from "@/features/work/useWorkSessions";

// =============================================================================
// 작업 표면의 런타임 판정 (#2780, 작업 공간 M2).
//
// 코어 표(`isSurfaceProvided`)는 「이 서버가 그 경로를 싣는가」를 말한다. 작업
// 콘솔·코드 실행 호스트·관제 셋은 그 답이 이미 참이고, 모자란 것은 이 워크스페이스에
// 붙은 호스트다. 그래서 셋은 표 대신 「지금 온라인인 호스트가 있는가」로 펼친다.
//
// 정적 절반은 여기서 가져온 `isSurfaceProvided`로 묻는다(코어 결합기 안에서 부르지
// 않는다). 화면 시험이 그 절반을 모듈 경계에서 바꿔 끼우고 런타임 절반만 잴 수
// 있게 하려는 것이다.
// =============================================================================

/** 호스트가 켜지고 꺼지는 것을 다시 보는 주기. heartbeat 창(90초)보다 짧다. */
export const WORK_HOST_PRESENCE_POLL_MS = 60_000;

/**
 * 열린 작업 표면이 호스트를 잃고도 서 있는 시간 (#2893).
 *
 * 폴 두 번(120초)이다. heartbeat 90초 창 경계에서 한 번 흔들린 답(폴 한 번)에
 * 보던 콘솔·관제 서랍·관전 도크가 사라지지 않게 한다.
 */
export const WORK_HOST_OFFLINE_GRACE_MS = 2 * WORK_HOST_PRESENCE_POLL_MS;

export type WorkHostPresence = "unknown" | "present" | "absent" | "error";

function needsHostProbe(): boolean {
  return HOST_GATED_SURFACE_IDS.some((id) => !isSurfaceProvided(id));
}

/**
 * 이 워크스페이스에 온라인 호스트가 있는가. 첫 답이 오기 전에는 `unknown`이다.
 *
 * 조회가 실패하면 마지막으로 받은 목록을 그대로 쓴다(React Query가 `data`를
 * 지우지 않는다). 한 번도 받지 못했으면 `error`다. 진입점(사이드바·⌘K·도크)은
 * `present`가 아니면 모두 접는다: 모르는 채 문을 세우면 누른 뒤에야 빈 화면을
 * 만난다. 그러나 `error`는 「호스트가 없다」가 아니다. 라우트는 그 둘을 다른
 * 문장으로 말한다(`SurfaceRoute`).
 */
export function useWorkHostPresence(): WorkHostPresence {
  const { workspaceId } = useSession();
  const probe = needsHostProbe();
  const query = useWorkHosts(workspaceId, WORK_HOST_PRESENCE_POLL_MS, probe);
  if (!probe) return "present";
  if (query.data !== undefined) {
    // 관전·관제 표면의 판정이라 누구의 호스트든 센다(#2854 planner 결정 (a)).
    // 일을 시키는 표면만 `isWorkHostUsableBy`로 좁힌다(세션 이어받기 대상).
    return hasOnlineWorkHost(query.data) ? "present" : "absent";
  }
  return query.isError ? "error" : "unknown";
}

/** 표면 판정 함수. 목록을 걸러야 하는 쪽(팔레트·설정 목차)이 쓴다. */
export function useSurfaceProvidedPredicate(): (id: SurfaceId) => boolean {
  const onlineHost = useWorkHostPresence() === "present";
  return useCallback(
    (id: SurfaceId) =>
      surfaceProvidedWithHosts(id, isSurfaceProvided(id), onlineHost),
    [onlineHost],
  );
}

/** 표면 하나의 판정. 진입점 하나를 세울지 정하는 쪽이 쓴다. */
export function useSurfaceProvided(id: SurfaceId): boolean {
  return useSurfaceProvidedPredicate()(id);
}

/**
 * **열린** 표면의 판정 (#2893).
 *
 * 열려 있는 동안 한 번 제공됐으면, 제공이 끊긴 뒤에도 `WORK_HOST_OFFLINE_GRACE_MS`
 * 동안 참이다. 그 안에 호스트가 돌아오면 유예를 거두고, 다시 끊기면 처음부터
 * 센다. 닫혀 있으면(`open=false`) 유예가 없다: 진입점은 지금 판정을 그대로 따른다
 * (누른 뒤에야 빈 화면을 만나지 않게, #2780).
 *
 * 쓰는 곳: 작업 콘솔 라우트(`SurfaceRoute`), 관제 줄·관제 서랍(`SurfaceGate`),
 * 채널 헤더의 관전 도크(`ChatShell`, 도크가 열려 있을 때만).
 */
export function useSurfaceProvidedWhileOpen(
  id: SurfaceId,
  open: boolean = true,
): boolean {
  const live = useSurfaceProvided(id);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!open) {
      setHeld(false);
      return;
    }
    if (live) {
      setHeld(true);
      return;
    }
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), WORK_HOST_OFFLINE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [open, live, held]);
  return live || (open && held);
}
