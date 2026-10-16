import { OortLoader } from "@/design/brand/OortLoader";
import { Skeleton } from "@/features/common/States";

// =============================================================================
// 세션을 되살리는 동안의 화면 (새로고침·앱 재시작 직후, 첫 로딩).
//
// 뼈대는 그대로다: 높이를 지키는 막대. 곧 나타날 셸이 이 자리를 차지하므로 셸이
// 뜰 때 아무것도 튀지 않는다. 옛 주석은 「스피너도 스플래시도 아니다」라고 적었는데,
// 성재(2026-10-16, #3961)가 새로고침과 첫 로딩에도 오르트가 빙글빙글 도는 로더를
// 원했다. 그래서 막대는 두고 **그 위에** 로더를 얹는다. 막대의 높이는 건드리지 않고
// (`fixed`라 흐름 밖), 시험 여섯 곳이 보는 `session-restoring` 도 그대로 둔다.
//
// 로더는 CSS 지연(사다리 한 칸)만큼 늦게 나타난다. 복원이 그보다 빨리 끝나면 로더는
// 한 번도 보이지 않는다. 상태 타이머가 아니라서 언마운트가 곧 정리다.
// =============================================================================

export function RestoringScreen() {
  return (
    <div data-testid="session-restoring">
      <Skeleton ready={false} rows={4} className="p-6" />
      <div
        role="status"
        className="pointer-events-none fixed inset-0 grid place-content-center justify-items-center gap-3"
      >
        <OortLoader variant="hero" />
        <span className="oort-loader-caption text-meta text-ink-muted">불러오는 중</span>
      </div>
    </div>
  );
}
