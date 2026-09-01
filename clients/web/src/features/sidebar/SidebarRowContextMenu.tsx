import { useState, type ReactElement } from "react";
import type { Channel, MembershipRole, ReadState } from "@momo/core/lib/api";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/design/ui/context-menu";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { useHoverNone } from "@/features/emoji/useHoverNone";
import {
  ChannelActionMenuItems,
  ChannelLeaveConfirmDialog,
  useChannelActions,
} from "@/features/chat/channelActions";

// =============================================================================
// 사이드바 행의 우클릭 메뉴 (BT-1 / #1929).
//
// oort 에는 「채널을 열지 않고 조작한다」는 문법이 아예 없었다: 알림도 나가기도
// 그 채널을 **열어서** 헤더 ⋮ 를 눌러야 했고, 목록을 훑다가 하나를 음소거하려면
// 읽고 있던 대화를 떠나야 했다. 이 표면이 그 문이다.
//
// 항목·낱말·실행은 헤더 ⋮ 와 한 정본을 쓴다(`features/chat/channelActions`).
// 여기 있는 것은 **행이 행인 부분**뿐이다: 어떤 입력이 이 메뉴를 부르는가.
//
// ## 그릇
//
// `design/ui/context-menu` — 이미 있는 것이다(메시지 행이 쓴다). 새 라이브러리도
// 새 시각 언어도 들이지 않는다: 패널·행·포커스 링·구분선이 드롭다운 메뉴의
// 클래스를 그대로 입고, 자리잡기·화살표 순회·Esc·포커스 복귀는 Radix 것이다.
//
// ## 무엇이 이 메뉴를 부르는가
//
//   * **우클릭** — 포인터의 모국어다. Radix 트리거가 `contextmenu` 를 듣는다.
//   * **메뉴 키 / Shift+F10** — 키보드에도 같은 문이 있어야 한다. 브라우저는 이
//     둘에 네이티브 `contextmenu` 를 쏘지만 그 매핑은 플랫폼마다 다르고 jsdom 에는
//     아예 없다. 그래서 이 파일이 **직접** 듣고, 행의 사각형 위에 `contextmenu`
//     하나를 합성해 쏜다 — 경로가 하나로 합쳐지므로 키보드로 연 메뉴와 우클릭으로
//     연 메뉴가 같은 자리에 같은 상태로 선다. keydown 을 preventDefault 해서
//     브라우저가 자기 것을 한 번 더 열지 않게 한다.
//   * **터치 롱프레스 — 이번에는 없다.** Radix 트리거는 700ms 롱프레스를 공짜로
//     주지만, 폰에서 이 사이드바는 **서랍**이고 그 서랍의 세로 스크롤은 손가락이
//     행을 누른 채 시작한다. 스크롤하려던 손이 메뉴를 여는 것은 회귀다. 메시지
//     행이 같은 축에서 이미 판정한 것도 같다(`MessageActions`: 손가락에는 컨텍스트
//     메뉴 대신 바텀 시트). 시트는 자기 표면이라 이 티켓 몫이 아니고, 그동안 폰의
//     문은 채널을 연 뒤의 헤더 ⋮ 로 그대로 있다. 그래서 `(hover: none)` 에서는
//     트리거를 아예 `disabled` 로 둔다 — 반쯤 열리는 문을 만들지 않는다.
//
// ## 로빙 tabindex 와 ⌥↑↓
//
// 트리거는 링크를 감싸는 `block` 상자이고, **탭 정거장이 아니다**(span). 링크는
// 그대로 하나뿐인 정거장이라 Sidebar 의 `[data-sidebar-row]` 순회와 ⌥↑↓ 안 읽음
// 항법은 손대지 않은 그대로다. 메뉴가 열려 있는 동안 그 상자가 배경을 입어,
// 포털로 떠 있는 패널이 어느 행의 것인지 행 자리에서 말한다.
// =============================================================================

/**
 * 키보드로 이 행의 메뉴를 부르는 키인가.
 *
 * `ContextMenu` 는 전용 메뉴 키(윈도·리눅스 키보드), Shift+F10 은 그 키가 없는
 * 자판의 표준 대체다. 둘 다 WAI-ARIA 의 컨텍스트 메뉴 관용이다.
 */
function isContextMenuSummonKey(event: {
  key: string;
  shiftKey: boolean;
}): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

/**
 * 트리거 상자 위에 `contextmenu` 하나를 합성한다. 좌표는 그 상자의 왼쪽 아래 —
 * 브라우저가 키보드 소환에서 쓰는 자리와 같고, 메뉴가 그 행에 붙어 선다.
 */
function summonAt(row: HTMLElement): void {
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + 16),
      clientY: Math.round(rect.bottom),
    })
  );
}

export function SidebarRowContextMenu({
  children,
  workspaceId,
  channel,
  title,
  selfMemberId,
  selfRole,
  readState,
}: {
  /** 이 행의 링크. 트리거 상자가 이것을 감싼다. */
  children: ReactElement;
  workspaceId: string;
  channel: Channel;
  /** 화면에 보이는 행 이름(`channelLabelParts.text`). DM 이면 사람 이름이다. */
  title: string;
  selfMemberId: string;
  selfRole: MembershipRole | undefined;
  /** 서버 read-state 투영의 이 채널 항목. 없으면 「읽음 처리」가 서지 않는다. */
  readState: ReadState | null;
}) {
  const [open, setOpen] = useState(false);
  const touchSurface = useHoverNone();
  const enabled = !touchSurface;
  const actions = useChannelActions({
    workspaceId,
    channel,
    title,
    selfMemberId,
    selfRole,
    readState,
    onActionSucceeded: () => setOpen(false),
  });
  // 메뉴가 열려 있는 동안 Esc 의 임자는 이 메뉴다. 아래 층(폰 서랍·작업 패널)이
  // 같은 한 번으로 함께 닫히지 않게 층을 세운다 — 메시지 행과 같은 규율.
  useEscapeLayer(open, () => setOpen(false));

  return (
    <>
      <ContextMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // 닫히면 이전 실패는 다음 열기까지 따라오지 않는다.
          if (!next) actions.clearError();
        }}
        modal={false}
      >
        {/* `asChild` 를 쓰지 않는다 — 실측 결함이다. Radix 의 Slot 은 자식과
            프롭을 합치면서 `className` 을 문자열로 이어 붙이는데, 이 행의
            링크는 `NavLink` 라 className 이 **함수**다(`({isActive}) => …`).
            합쳐지는 순간 그 함수가 문자열이 되어 클래스 목록 자리에 함수 소스가
            꽂히고, 행은 flex 도 패딩도 잘림도 전부 잃는다(캡처 실측: 아이콘과
            이름이 두 줄로 흩어졌다). 그래서 트리거는 자기 요소를 갖되 `block`
            으로 행과 같은 상자를 쓴다 — 링크의 클래스에는 아무도 손대지 않고,
            우클릭·키다운은 링크에서 여기로 버블링해 온다. */}
        <ContextMenuTrigger
          disabled={!enabled}
          data-row-menu-trigger=""
          className="block rounded-sm data-[state=open]:bg-surface-hover"
          onKeyDown={(event) => {
            if (!enabled || !isContextMenuSummonKey(event)) return;
            // 브라우저의 네이티브 소환을 막고 같은 문으로 들어간다. 막지 않으면
            // 같은 한 번의 키가 메뉴를 두 번 연다.
            event.preventDefault();
            summonAt(event.currentTarget);
          }}
        >
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent
          data-testid="channel-row-menu"
          aria-label={`${title} 채널 메뉴`}
        >
          <ChannelActionMenuItems
            surface="row"
            prefix="channel-row"
            actions={actions}
            onHandOff={(key) => {
              setOpen(false);
              if (key === "leave") actions.leave.open();
            }}
          />
        </ContextMenuContent>
      </ContextMenu>

      <ChannelLeaveConfirmDialog
        actions={actions}
        title={title}
        testId="channel-row-leave-confirm"
      />
    </>
  );
}
