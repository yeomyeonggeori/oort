import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { EmptyInvite } from "@/features/common/States";
import { serverSurface, type SurfaceId } from "./serverSurfaces";

// =============================================================================
// "이 서버는 아직 그걸 못 합니다"를 말하는 한 벌 (goal B12 / QA H1).
//
// 두 모양이 있고, 차이는 **이것이 페이지 전체인가**뿐이다:
//   - `SurfaceUnavailableRoute` — 라우트 하나가 통째로 미제공. 헤더와 h1을 갖는다.
//   - `SurfaceUnavailableSection` — 살아 있는 화면 안의 한 구획만 미제공.
//
// 문구는 컴포넌트가 짓지 않고 판정표(serverSurfaces.ts)에서 받아 온다. 문장을
// 화면마다 새로 쓰면 같은 사실이 화면 수만큼의 다른 말이 되고, 이식된 뒤에 어떤
// 화면이 아직 옛말을 하고 있는지 아무도 모른다.
//
// 왜 오류 배너가 아니라 빈 상태인가: `InlineBanner tone="error"`는 `role="alert"`
// 과 --danger를 쓴다. 둘 다 "지금 뭔가 잘못됐다"는 뜻이고, 아직 만들지 않은 기능은
// 잘못된 것이 아니다. 스크린리더에 alert로 끼어들 이유도 없다.
// =============================================================================

/**
 * 라우트 전체가 미제공일 때.
 *
 * 헤더에 `SidebarDrawerToggle`이 반드시 있어야 한다. 폰에서 사이드바는 서랍이고
 * 그것을 여는 손잡이는 각 표면의 헤더가 그린다(app/shellNav.tsx). 손잡이 없는
 * 화면을 세우면 그 주소를 북마크해 둔 사람은 **다른 곳으로 갈 방법이 없는 화면**에
 * 도착한다: 기능이 없다고 정직하게 말한 뒤 사용자를 가둬 두는 셈이라, 정직화가
 * 아니라 더 나쁜 고장이다.
 */
export function SurfaceUnavailableRoute({ surface }: { surface: SurfaceId }) {
  const { label, absentReason, fallback } = serverSurface(surface);
  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      data-testid="surface-unavailable-route"
      data-surface={surface}
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarDrawerToggle />
          {/* h1은 여기 한 번뿐이다. 아래 EmptyInvite는 `heading`을 받지 않으므로
              두 번째 h1이 서지 않는다. */}
          <h1 className="text-body font-semibold">{label}</h1>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyInvite
          headline={absentReason}
          detail={fallback}
          testId="surface-unavailable"
          dataAttrs={{ "data-surface": surface }}
        />
      </div>
    </div>
  );
}

/**
 * 살아 있는 화면 안의 한 구획만 미제공일 때 (설정 > 앱, 에이전트 허브의 기억 등).
 *
 * 스켈레톤이 영원히 도는 자리나 빈 껍데기를 남기지 않는 것이 이 컴포넌트의 일이다.
 */
export function SurfaceUnavailableSection({
  surface,
  testId,
  flush = false,
}: {
  surface: SurfaceId;
  testId?: string;
  /**
   * 이미 자기 여백을 가진 상자 안에 들어갈 때. `SectionShell`의 제목은 그 상자
   * 왼쪽 끝에 붙으므로, 기본 여백을 그대로 두면 빈 상태만 제목보다 16px 안으로
   * 들어가 앉는다.
   */
  flush?: boolean;
}) {
  const { absentReason, fallback } = serverSurface(surface);
  return (
    <EmptyInvite
      headline={absentReason}
      detail={fallback}
      className={flush ? "px-0" : undefined}
      testId={testId ?? "surface-unavailable"}
      dataAttrs={{ "data-surface": surface }}
    />
  );
}
