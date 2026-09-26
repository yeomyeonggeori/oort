import type { ReactNode } from "react";
import type { SurfaceId } from "@momo/core/features/capabilities/serverSurfaces";
import { SurfaceUnavailableRoute } from "./SurfaceUnavailable";
import { useSurfaceProvided, useWorkHostPresence } from "./useSurfaceProvided";

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
 * 라우트 전체를 표면 판정 뒤에 둔다. 미제공이면 이유를 말하는 빈 상태로 간다.
 *
 * 호스트 목록이 아직 오지 않았으면 아무것도 그리지 않는다: 첫 프레임에 「호스트가
 * 없습니다」를 보였다가 곧바로 화면을 바꾸면, 링크로 들어온 사람은 없다는 말을
 * 먼저 읽는다.
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
  if (presence === "unknown") {
    return (
      <div
        className="flex min-w-0 flex-1"
        aria-busy="true"
        data-testid="surface-route-pending"
        data-surface={surface}
      />
    );
  }
  return <SurfaceUnavailableRoute surface={surface} />;
}
