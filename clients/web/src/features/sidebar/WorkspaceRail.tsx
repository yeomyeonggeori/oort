import { useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Inbox, MessageSquare, Plus, SquareKanban, SquareTerminal } from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  MY_WORK_PATH,
  TEAM_WORK_PATH,
  WORK_NAV,
} from "@momo/core/features/workbench/workTab";
import { useOpenAddWorkspace } from "@/features/workspace/useAddWorkspace";
import { useWorkspaceAvatar } from "./useWorkspaceAvatar";
import {
  workspaceRailTile,
  type WorkspaceNameState,
} from "./workspaceRailModel";

// 앱 레일 (#3280). 이 파일의 컴포넌트가 하나의 레일(56px)이다: 워크스페이스 타일과
// 「+」, 구분선, 목적지 넷(대화·인박스·내 작업·팀 작업), 아래 프로필. 모든 탭·라우트에서
// 같은 노드·같은 자리·같은 폭이고, 탭이 바뀌어도 언마운트하거나 숨기지 않는다(「내 작업」이
// 64px 작업 레일로 바꿔 끼우던 #2854 구조의 폐기). 탭마다 바뀌는 것은 오른쪽 목록 열의
// 내용뿐이다. 접힘도 목록 열만 접고 레일은 남는다(Cursor의 Activity Bar 방식).
//
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
  active,
  showMyWork,
  inboxUnread = 0,
  footer,
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
  /** 지금 있는 목적지(`aria-current`). 넷 밖의 화면(활동·멤버·설정 등)이면 null. */
  active: RailDestination | null;
  /** 「내 작업」은 이 기기의 격자라 데스크탑에만 선다(웹에는 로컬 터미널 레인이 없다, ADR-0190 D1). */
  showMyWork: boolean;
  /** 안 읽은 멘션 수. 인박스 타일의 배지로 선다(목록 줄에서 이사 온 자리). */
  inboxUnread?: number;
  /** 아래 프로필(연결 상태 막대 포함). */
  footer?: ReactNode;
}) {
  const tile = workspaceRailTile(workspace, workspaceId);
  const avatarDataUrl = useWorkspaceAvatar(avatarUrl);
  const openAddWorkspace = useOpenAddWorkspace();
  const addWorkspaceRef = useRef<HTMLButtonElement>(null);
  return (
    // 56px 레일 열 (`--spacing-rail`). 안쪽 nav 는 44px 타일만 감싸므로
    // 셸 게이트는 이 래퍼(`workspace-rail`)를 잰다 — nav 를 재면 44가 나온다.
    <div
      data-testid="workspace-rail"
      // DS2-6 (#2718): 레일은 창 바닥 위에 녹는다(시안 A에는 레일이 없다, ADR-0161
      // 표면이라 남긴다). 바탕도 경계선도 없다.
      className="flex h-full w-rail shrink-0 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden py-2"
    >
      <nav
        aria-label="워크스페이스"
        className="flex flex-col items-center gap-2"
      >
      {/* 현재 워크스페이스 (R-1 §1). Discord's grammar: the active tile wears the
          long left accent bar AND the lit (selected) surface, so it cannot be
          mistaken for a tile that merely happens to be under the cursor. The
          [+] below rests on a quiet fill; this one is lifted on the white
          surface with the rest shadow, the same "selected" grammar as the
          sidebar row (DS2-6, owner 2026-09-26: never amber), and it
          carries `aria-current` so a screen reader knows which one is current
          without seeing the bar. */}
      {/* `isolate` (#2485 R1 B-2): the marker below carries `z-10` so it stands
          over the avatar, and without a stacking context here that 10 resolved
          against the document root — measured punching through the D6 scrim as
          the one crisp amber edge in an otherwise blurred strip. The tile is
          what the marker competes inside, so the tile owns the context. It does
          not clip (that was the 3R regression the comment below records);
          `isolation` only scopes z. */}
      <span
        aria-current="true"
        aria-busy={tile.loading || undefined}
        // 현재 타일은 흰 면 + rest 그림자로 뜬다(DS2-6, 사이드바 선택 행과 같은
        // 문법 — owner 결정 2026-09-26: 선택을 호박색으로 칠하지 않는다). 띠
        // 위에서도 흰 면이라 원래 글자 역할을 쓴다.
        className="band-surface relative isolate flex size-rail-tile items-center justify-center rounded-md bg-surface text-title font-semibold text-ink shadow-sm"
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
          className="rail-marker absolute -left-1 z-10 h-rail-marker w-marker rounded-sm"
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
          "현재"로 오인되지 않는다. 패널 접기는 타이틀바에 한 자리만 산다 (#1864). */}
      <button
        ref={addWorkspaceRef}
        type="button"
        onClick={() => openAddWorkspace(addWorkspaceRef.current)}
        aria-label="워크스페이스 추가"
        title="워크스페이스 추가"
        data-testid="add-workspace"
        // DS2-6: 손으로 그린 3:1 테두리 대신 채움 문법(ADR-0189 D6 「버튼은 채움,
        // 테두리는 입력 그릇에만」). 쉴 때는 옅은 채움, 호버에서 한 단 짙다.
        className="flex size-rail-tile items-center justify-center rounded-md bg-surface-hover text-ink-muted press hover:bg-surface-pressed focus-visible:focus-ring"
      >
        <Plus className="size-6" aria-hidden="true" />
      </button>

      {/* 연결 상태 점은 하단 프로필 패널로 옮겨졌다(검수 #6 / 프레즌스 6a).
          "내가 붙어 있는가"는 "내가 누구인가"의 자리 옆이 더 맞는 집이고,
          끊김이라는 무거운 상태는 셸의 ConnectionBanner가 별도로 덮는다.
          이 점은 사용자 프레즌스(가용성/away/dnd, ADR-0160 6b)가 아니다. */}
    </nav>

      {/* 구분선: 위는 「어느 워크스페이스」, 아래는 「어디로」. */}
      <span aria-hidden="true" className="h-px w-6 shrink-0 bg-line" data-testid="rail-divider" />

      {/* 목적지 넷 (#3280). 항목은 44px 아이콘+11px 글자(`rail-item`), 선택은 사이드바
          선택 행과 같은 문법(흰 면 + rest 그림자)이다. */}
      <nav aria-label="앱 탐색" className="flex flex-col items-center">
        <ul className="flex flex-col items-center gap-2">
          <RailLink to="/" icon={<MessageSquare />} label="대화" testId="rail-chat" current={active === "chat"} />
          <RailLink
            to="/inbox"
            icon={<Inbox />}
            label="인박스"
            testId="rail-inbox"
            current={active === "inbox"}
            badge={inboxUnread}
          />
          {showMyWork && (
            <RailLink to={MY_WORK_PATH} icon={<SquareTerminal />} label={WORK_NAV.mine} testId="rail-mine" current={active === "mine"} />
          )}
          <RailLink to={TEAM_WORK_PATH} icon={<SquareKanban />} label={WORK_NAV.team} testId="rail-team" current={active === "team"} />
        </ul>
      </nav>
      <span className="min-h-0 flex-1" />
      {footer}
    </div>
  );
}

export type RailDestination = "chat" | "inbox" | "mine" | "team";

function RailLink({
  to,
  icon,
  label,
  testId,
  current,
  badge = 0,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  testId: string;
  current: boolean;
  badge?: number;
}) {
  return (
    <li>
      {/* NavLink가 아니라 Link다: NavLink는 경로만 봐서 「팀 작업」(`/work?view=team`)도
          `/work`에서 켜지고, 넘긴 aria-current도 자기 판정이 아니면 지운다. 선택은 셸이 정한다. */}
      <Link
        to={to}
        data-testid={testId}
        aria-current={current ? "page" : undefined}
        aria-label={badge > 0 ? `${label}, 안 읽은 멘션 ${badge}개` : undefined}
        className={cn(
          "rail-item relative focus-visible:focus-ring active:bg-surface-pressed",
          current
            ? "band-surface rail-item-selected"
            : "hover:bg-surface-hover hover:text-ink"
        )}
      >
        <span aria-hidden="true">{icon}</span>
        <span>{label}</span>
        {badge > 0 && (
          <span
            aria-hidden="true"
            data-testid="rail-inbox-badge"
            className="sidebar-badge absolute -right-1 -top-1 bg-signal text-on-signal"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </Link>
    </li>
  );
}
