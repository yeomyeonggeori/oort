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
import {
  channelActionMenuLabel,
  type ChannelSectionChoice,
} from "@/features/chat/channelActionModel";

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
  sections,
  currentSectionId = null,
  onMoveToSection,
  starred = false,
  onToggleStar,
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
  /**
   * 이 사람의 커스텀 섹션들과 이 채널이 지금 속한 곳 (ADR-0177 / BT-4 #1932).
   * 「섹션으로 이동」은 이 셋이 다 있을 때만 선다 - 목적지가 없거나 옮길 손이
   * 없으면 눌러도 아무 일이 없는 라디오가 된다.
   */
  sections?: ChannelSectionChoice[];
  currentSectionId?: string | null;
  onMoveToSection?: (sectionId: string | null) => void;
  /**
   * 별표 (ADR-0177 / BT-5 #1933). 배치와 같은 규율: 손이 없으면 항목도 없다.
   * 실행은 `channelActions` 가 갖는다 - 이 파일은 그릇과 입력만 정한다.
   */
  starred?: boolean;
  onToggleStar?: () => void;
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
    sections,
    currentSectionId,
    onMoveToSection,
    starred,
    onToggleStar,
  });
  // 층을 세우지만, **이 층의 handle 은 결코 불리지 않는다** (design-review
  // #1937 N-2). 아래 층(폰 서랍·작업 패널)을 실제로 지키는 것은 이 줄이 아니라
  // `escapeLayer.ts` 의 `dialogIsOpen()` 술어다: 그것이
  // `[role="menu"][data-state="open"]` 을 이미 「가장 위」로 판정해
  // `runTopEscapeLayer(blocked=true)` 가 즉시 물러나고, Esc 는 Radix 가 가져간다.
  //
  // 그런데도 세우는 이유는 하나다. `escapeIsClaimed()` — 층을 열지 **않는**
  // 표면(설정 라우트의 뒤로 가기)이 「지금 화면에 층이 있나」를 묻는 그 술어 —
  // 는 스택 길이도 함께 읽는다. 이 줄은 그 원장의 한 항목이고, 앞 문단이 그
  // 사실을 적어 두는 자리다. `MessageActions.tsx` 가 같은 줄을 갖고 있다.
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
          // 열림 표식이 **두 겹**이다 (design-review #1937 N-4). 배경만으로는
          // 활성 행에서 사라진다: 링크의 `bg-accent-soft` 는 알파가 없어 이
          // 상자의 배경을 통째로 덮고, 하필 그때가 **키보드로 연 메뉴가 어느
          // 행의 것인지 말하는 유일한 표식**이 필요한 순간이다(포인터는 hover
          // 가 대신 말해 준다). 그래서 배경 위에 인셋 아웃라인을 함께 세운다 —
          // 아웃라인은 자식의 배경 위에 그려진다.
          //
          // ## 선 색이 `--ink-muted` 인 이유 (design-review R2 M-1)
          //
          // 처음에는 `--line-strong` 이었고, 그 자리에 「어느 표면 위에서도 3:1
          // 을 지킨다」고 적었다. **거짓이었다.** 이 레포가 그 반례를 이미 이름
          // 대어 적어 두고 있다 — `tokens.contrast.test.ts` 의 `CONTROL_SURFACES`
          // 산문: *"`--line-strong` lands at 2.90:1 on `--accent-soft` … under
          // the 3:1 non-text minimum"*. 그 문장이 `--accent-soft` 를 컨트롤 경계
          // 표에서 뺀 이유이고, 이 표식은 하필 **그 표면 위에** 서는 것이 존재
          // 이유다. 다크 실측 2.90:1(라이트 3.18:1)로, 자를 못 넘긴 상태 표시였다.
          //
          // 세 갈래(①3:1 넘는 선 ②헤어라인 아닌 표식 ③분류표 편입) 중 ①이다.
          // 값이 옆 파일에 이미 있었기 때문이다: `--ink-muted` 는 **모든**
          // `SURFACES` 위에서 4.5:1 을 넘어야 한다는 단정을 이미 지고 있고
          // (`accent-soft` 도 그 목록에 있다), 실측은 accent-soft 위 라이트
          // 4.74 · 다크 5.17 이다. ②는 새 시각 언어를 하나 만들고, ③은 이 표식
          // 하나 때문에 컨트롤 경계 분류표의 뜻을 바꾼다 — 둘 다 값이 크다.
          //
          // 포커스 링(--accent · 2px)과는 색도 두께도 달라 「캐럿이 여기 있다」와
          // 「이 행의 메뉴가 열려 있다」가 섞이지 않는다. 이 선택은 주석이 아니라
          // `tokens.contrast.test.ts` 의 `describe("행 메뉴 열림 표식")` 이 이
          // 파일의 클래스에서 토큰을 읽어 잰다.
          className="block rounded-sm data-[state=open]:bg-surface-hover data-[state=open]:outline data-[state=open]:outline-1 data-[state=open]:-outline-offset-1 data-[state=open]:outline-ink-muted"
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
          aria-label={channelActionMenuLabel(title, channel)}
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
