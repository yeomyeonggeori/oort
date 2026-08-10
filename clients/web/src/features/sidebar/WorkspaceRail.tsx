import { Plus } from "lucide-react";
import { useOpenAddWorkspace } from "@/features/workspace/useAddWorkspace";
import {
  workspaceRailTile,
  type WorkspaceNameState,
} from "./workspaceRailModel";

// 32px vertical rail (R-1 §1). A vertical workspace icon stack has no
// shadcn/Radix primitive, so it is hand-drawn; the switcher menu itself will
// use DropdownMenu when multi-workspace lands (ADR-0117 / ADR-0161 4b-3).

export function WorkspaceRail({
  workspace,
  workspaceId,
}: {
  // The tile draws the WORKSPACE (검수 피드백 #4a-1). It is a name-query object,
  // NOT a bare string, on purpose: a bare string is exactly what let the shell
  // wire in `selfName` (the reader's own display name), and this type makes that
  // regression a compile error rather than a screenshot someone has to catch.
  workspace: WorkspaceNameState;
  /** Bound workspace id, used only for the honest error fallback (never a name). */
  workspaceId: string;
}) {
  const tile = workspaceRailTile(workspace, workspaceId);
  const openAddWorkspace = useOpenAddWorkspace();
  return (
    <nav
      aria-label="워크스페이스"
      className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-line bg-surface-sidebar py-2"
    >
      {/* 현재 워크스페이스 (R-1 §1). Discord's grammar: the active tile wears the
          long left accent bar AND the lit (selected) surface, so it cannot be
          mistaken for a tile that merely happens to be under the cursor. The
          [+] below hovers to `surface-hover`; this one rests on `accent-soft`,
          the same "selected" surface a chosen 채널 만들기 range uses, and it
          carries `aria-current` so a screen reader knows which one is current
          without seeing the bar. */}
      <span
        aria-current="true"
        aria-busy={tile.loading || undefined}
        className="relative flex size-6 items-center justify-center rounded-sm bg-accent-soft text-meta font-semibold text-ink"
        title={tile.label}
        aria-label={tile.label}
        data-testid="workspace-current"
      >
        {/* 2R design-review: -left-2(-8px)는 아바타의 레일 인셋(4px)을 초과해
            마커가 뷰포트 밖으로 전량 클리핑됐다(0픽셀 렌더 실측). 레일 왼쪽
            가장자리(x=0)에 앵커한다 — R-1 §1 현재 WS 액센트 바(긴 pill). */}
        <span
          aria-hidden="true"
          className="absolute -left-1 h-4 w-marker rounded-sm bg-accent"
        />
        {/* 이름이 오기 전에는 글자를 그리지 않는다 (#4a-1): 근처의 아무 문자열이나
            첫 글자로 세우던 것이 이 결함의 시작이었다. 이름이 없으면 빈 타일이지
            대체 글자가 아니다. */}
        {tile.initial}
      </span>

      {/* [+] 는 이제 워크스페이스를 추가한다 (#4a-2). 이전엔 <Link to="/settings">
          라 레일을 떠나 생성 폼이 얹혀 있을 뿐인 설정 페이지로 샜다 — 채널
          만들기가 MOMO-614 전에 갖고 있던 그 막다른 길이다. 이제 셸이 소유한
          다이얼로그를 액션 자리에서 연다. 윤곽선은 컨트롤 윤곽선이라 --line이
          아니라 --line-strong(3:1)을 쓰고(tokens.md §2), 현재 타일과 같은 24px
          사각형이되 액센트 바도 채운 표면도 없어 "현재"로 오인되지 않는다. */}
      <button
        type="button"
        onClick={openAddWorkspace}
        aria-label="워크스페이스 추가"
        title="워크스페이스 추가"
        data-testid="add-workspace"
        className="flex size-6 items-center justify-center rounded-sm border border-line-strong text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring"
      >
        <Plus className="size-4" />
      </button>

      {/* 연결 상태 점은 하단 프로필 패널로 옮겨졌다(검수 #6 / 프레즌스 6a).
          "내가 붙어 있는가"는 "내가 누구인가"의 자리 옆이 더 맞는 집이고,
          끊김이라는 무거운 상태는 셸의 ConnectionBanner가 별도로 덮는다.
          이 점은 사용자 프레즌스(가용성/away/dnd, ADR-0160 6b)가 아니다. */}
    </nav>
  );
}
