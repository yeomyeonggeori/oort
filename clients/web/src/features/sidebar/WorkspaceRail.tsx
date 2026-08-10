import { Plus } from "lucide-react";
import { useOpenAddWorkspace } from "@/features/workspace/useAddWorkspace";
import { useWorkspaceAvatar } from "./useWorkspaceAvatar";
import {
  workspaceRailTile,
  type WorkspaceNameState,
} from "./workspaceRailModel";

// 워크스페이스 레일 (검수 #4b / ADR-0161). 32px 레일을 디스코드형 스위처가 설 만큼
// 넓혔다: 폭·타일·현재 마커가 전부 이름 토큰(--spacing-rail{,-tile,-marker})이라,
// 리듬 스케일(최대 32) 밖의 셸 기하를 tokens.css 한 자리에서 근거와 함께 진다.
// 타일은 44px(=--tap-target)라 그 크기가 곧 히트영역이다. 세로 아이콘 스택에는
// shadcn/Radix 프리미티브가 없어 손으로 그린다; 스위처 메뉴 자체는 멀티 워크스페이스
// 세션 스왑(ADR-0161 4b-3)이 랜딩할 때 DropdownMenu 로 온다.

export function WorkspaceRail({
  workspace,
  workspaceId,
  avatarUrl,
}: {
  // The tile draws the WORKSPACE (검수 피드백 #4a-1). It is a name-query object,
  // NOT a bare string, on purpose: a bare string is exactly what let the shell
  // wire in `selfName` (the reader's own display name), and this type makes that
  // regression a compile error rather than a screenshot someone has to catch.
  workspace: WorkspaceNameState;
  /** Bound workspace id, used only for the honest error fallback (never a name). */
  workspaceId: string;
  /**
   * The workspace avatar content path (ADR-0161 D5), or undefined for the
   * initial fallback. The bytes are fetched with the bearer and rendered as a
   * `data:` URL — an `<img src>` to the proxy cannot authenticate.
   */
  avatarUrl?: string;
}) {
  const tile = workspaceRailTile(workspace, workspaceId);
  const avatarDataUrl = useWorkspaceAvatar(avatarUrl);
  const openAddWorkspace = useOpenAddWorkspace();
  return (
    <nav
      aria-label="워크스페이스"
      className="flex h-full w-rail shrink-0 flex-col items-center gap-2 border-r border-line bg-surface-sidebar py-2"
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
        className="relative flex size-rail-tile items-center justify-center rounded-md bg-accent-soft text-title font-semibold text-ink"
        title={tile.label}
        aria-label={tile.label}
        data-testid="workspace-current"
      >
        {/* 마커는 타일 상자 **밖**(-left-1 → x −4..−2px)에 선다. 그래서 이 상자는
            자르면 안 된다 — 3R design-review 실측: 아바타 모서리를 자르려 타일에
            overflow-hidden 을 얹었더니 마커가 전량 클리핑돼(가시 폭 0px, 두 스킴)
            아바타가 걸린 워크스페이스에서 「현재」 신호가 사라졌다. 앞 판 주석이
            말한 "온전히 선다"의 기준은 뷰포트였는데, 클리핑 상자가 부모로 바뀌면서
            그 문장이 거짓이 된 것이다.
            자르는 일은 이미지가 자기 border-radius 로 한다(아래 img 의 rounded-md).
            부모가 자를 이유는 처음부터 없었다.
            56px 레일 안 44px 타일은 좌우 인셋이 6px이라 −4px 는 레일 **안쪽**
            (x 2..4px)에 떨어진다. 높이는 타일보다 짧은 pill
            (--spacing-rail-marker 24px)이라 「선택됨」을 말하되 타일을 다 덮지
            않는다 — R-1 §1 현재 WS 액센트 바. z 순서는 아바타 위. */}
        <span
          aria-hidden="true"
          className="absolute -left-1 z-10 h-rail-marker w-marker rounded-sm bg-accent"
        />
        {avatarDataUrl ? (
          // 아바타가 있으면 이미지가 타일을 채운다(object-cover). 모서리는 이미지
          // 자신의 rounded-md 가 자른다(부모는 자르지 않는다 — 위 마커 주석).
          // 없거나 아직 받는 중이면 아래 이니셜이 designed empty state 다
          // (D5 "없으면 이니셜").
          <img
            src={avatarDataUrl}
            alt=""
            className="size-full rounded-md object-cover"
            data-testid="workspace-avatar-image"
          />
        ) : (
          // 이름이 오기 전에는 글자를 그리지 않는다 (#4a-1): 근처의 아무 문자열이나
          // 첫 글자로 세우던 것이 이 결함의 시작이었다. 이름이 없으면 빈 타일이지
          // 대체 글자가 아니다.
          tile.initial
        )}
      </span>

      {/* [+] 는 워크스페이스를 추가한다 (#4a-2). 셸이 소유한 다이얼로그를 액션
          자리에서 연다. 윤곽선은 컨트롤 윤곽선이라 --line 이 아니라 --line-strong(3:1)
          을 쓰고, 현재 타일과 같은 44px 사각형이되 액센트 바도 채운 표면도 없어
          "현재"로 오인되지 않는다. */}
      <button
        type="button"
        onClick={openAddWorkspace}
        aria-label="워크스페이스 추가"
        title="워크스페이스 추가"
        data-testid="add-workspace"
        className="flex size-rail-tile items-center justify-center rounded-md border border-line-strong text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring"
      >
        <Plus className="size-6" />
      </button>

      {/* 연결 상태 점은 하단 프로필 패널로 옮겨졌다(검수 #6 / 프레즌스 6a).
          "내가 붙어 있는가"는 "내가 누구인가"의 자리 옆이 더 맞는 집이고,
          끊김이라는 무거운 상태는 셸의 ConnectionBanner가 별도로 덮는다.
          이 점은 사용자 프레즌스(가용성/away/dnd, ADR-0160 6b)가 아니다. */}
    </nav>
  );
}
