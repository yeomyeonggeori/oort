import type { ReactNode } from "react";
import {
  serverSurface,
  type SurfaceId,
} from "@momo/core/features/capabilities/serverSurfaces";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { useSession } from "@/app/session";
import { InlineBanner } from "@/features/common/States";
import { useWorkHosts } from "@/features/work/useWorkSessions";
import { SurfaceUnavailableRoute } from "./SurfaceUnavailable";
import {
  WORK_HOST_PRESENCE_POLL_MS,
  useSurfaceProvided,
  useWorkHostPresence,
} from "./useSurfaceProvided";

/**
 * 표면이 제공될 때만 자식을 그린다 (#2780).
 *
 * 세션 공급자 안쪽에서만 판정할 수 있으므로(호스트 목록은 워크스페이스마다 다르다),
 * 공급자를 여는 셸 본문이 직접 훅을 부르지 않고 이 문을 둔다.
 */
export function SurfaceGate({
  surface,
  children,
}: {
  surface: SurfaceId;
  children: ReactNode;
}) {
  return useSurfaceProvided(surface) ? <>{children}</> : null;
}

/**
 * 라우트 전체를 표면 판정 뒤에 둔다.
 *
 * - 제공되면 자식을 그린다.
 * - 호스트 목록이 아직 오지 않았으면 머리(제목·서랍 손잡이)만 그리고 본문은
 *   비운다. 첫 프레임에 「호스트가 없습니다」를 보였다가 곧바로 화면을 바꾸면,
 *   링크로 들어온 사람은 없다는 말을 먼저 읽는다.
 * - 목록을 읽지 못했으면 「없다」가 아니라 「읽지 못했다」고 말하고 다시 시도를
 *   준다. 서버가 아프거나 연결이 끊긴 것을 호스트가 없는 것으로 말하면 거짓이다.
 * - 목록을 읽었고 온라인 호스트가 없으면 이유를 말하는 빈 상태로 간다.
 */
export function SurfaceRoute({
  surface,
  children,
}: {
  surface: SurfaceId;
  children: ReactNode;
}) {
  const provided = useSurfaceProvided(surface);
  const presence = useWorkHostPresence();
  if (provided) return <>{children}</>;
  if (presence === "absent" || presence === "present") {
    return <SurfaceUnavailableRoute surface={surface} />;
  }
  return <SurfaceRouteShell surface={surface} presence={presence} />;
}

function SurfaceRouteShell({
  surface,
  presence,
}: {
  surface: SurfaceId;
  presence: "unknown" | "error";
}) {
  const { workspaceId } = useSession();
  const hosts = useWorkHosts(workspaceId, WORK_HOST_PRESENCE_POLL_MS);
  const { label } = serverSurface(surface);
  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      data-testid={
        presence === "error" ? "surface-route-error" : "surface-route-pending"
      }
      data-surface={surface}
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarDrawerToggle />
          <h1 className="text-body font-semibold">{label}</h1>
        </div>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        aria-busy={presence === "unknown" ? true : undefined}
      >
        {presence === "error" && (
          <InlineBanner
            message="코드 실행 호스트 목록을 불러오지 못했습니다."
            actionLabel="다시 시도"
            actionBusy={hosts.isFetching}
            onAction={() => void hosts.refetch()}
            testId="surface-route-error-banner"
          />
        )}
      </div>
    </div>
  );
}
