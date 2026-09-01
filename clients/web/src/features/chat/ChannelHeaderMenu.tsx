import { useRef, useState } from "react";
import { EllipsisVertical } from "lucide-react";
import { type Channel, type MembershipRole } from "@momo/core/lib/api";
import { normalizeChannelTopic } from "@momo/core/features/channels/model";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { ChannelTopicDialog } from "@/features/channels/ChannelContextControls";
import { channelHeaderControlClass } from "@/features/chat/channelHeaderControl";
import {
  ChannelActionMenuItems,
  ChannelLeaveConfirmDialog,
  useChannelActions,
} from "./channelActions";

// =============================================================================
// 채널 헤더 ⋮ 메뉴 (검수 피드백 #3 · #1865). 트리거는 헤더 우측 라운드 버튼
// 그룹의 마지막이다. 헤더의 다른 버튼(고정 목록·터미널)이 이미 `dropdown-menu`로
// 여닫히므로 같은 프리미티브를 쓴다 — 새 컨트롤 문법을 만들 이유가 없다.
//
// 항목:
//   * 주제 보기       — 토픽이 있을 때만. 기존 읽기 다이얼로그를 연다. 갱신
//                       라우트가 없어 「편집」은 그리지 않는다.
//   * 알림 끄기/켜기  — 누구나(활성 멤버). `notification_pref`는 자기 자신의
//                       설정이라 권한을 묻지 않는다. 한 번의 왕복 동안 메뉴를
//                       열어 두고(실패를 그 자리에서 말해야 하므로), 성공하면
//                       닫는다. 낱말은 상태다: 켜져 있으면 「끄기」.
//   * 채널 나가기     — 오너/관리자에게만(`canLeaveChannel`). 서버 `remove_member`가
//                       오너/관리자만 멤버십을 지울 수 있게 막으므로, 일반 멤버에게
//                       내놓으면 확인 뒤 403으로 끝나는 막다른 길이다. 파괴적이라
//                       확인 다이얼로그를 거치고, 사이드바에서는 낙관적으로 지운
//                       뒤 실패하면 되돌린다.
//
// 「이름 수정」은 없다. 서버에 채널 이름을 바꾸는 라우트가 없어(2026-08-10 실측)
// 누를 수 없는 항목을 그리지 않는다 — 코어 model.ts 머리말에 그 실측을 남겨 두었고
// 별도 티켓으로 뺀다.
//
// ## 이 파일에 실행부가 없는 이유 (BT-1 / #1929)
//
// 위 세 항목의 인벤토리는 `channelActionModel.ts`, 그 실행(알림 PUT · 나가기
// DELETE + 낙관 삭제 + 되돌리기 · 확인 다이얼로그)은 `channelActions.tsx`가
// 갖는다. 같은 일을 하는 두 번째 표면(사이드바 행 우클릭)이 생겼기 때문이고,
// 두 표면이 실행을 각자 들면 다음 수리는 한쪽에만 들어간다. 이 파일에 남는 것은
// **헤더가 헤더인 부분**뿐이다: ⋮ 트리거, 주제 다이얼로그로 넘기는 손, 그리고
// 다이얼로그로 넘어가는 동안의 포커스 복귀 억제(#1865 H-3).
//
// 헤더의 항목이 늘지 않은 것도 판정이다. 「읽음 처리」는 지금 읽고 있는 채널에
// 대고 할 말이 아니고(ChatShell이 이미 커서를 민다), 「이름 복사」는 행에서
// 목록을 훑는 사람의 물음이다. 표면별 열쇠 집합은 모델의 표 하나에 있다.
// =============================================================================

export function ChannelHeaderMenu({
  workspaceId,
  channel,
  title,
  selfMemberId,
  selfRole,
}: {
  workspaceId: string;
  channel: Channel;
  /** 화면에 보이는 채널 이름(labelParts.text ?? label). ⋮ 의 접근 이름과
   *  나가기 확인 다이얼로그가 이름을 넣어 문장을 짓는 값. */
  title: string;
  selfMemberId: string;
  /** 로그인 멤버의 워크스페이스 역할. undefined면 아직 안 온 것이고, 그때는
   *  나가기를 내놓고 서버가 답하게 둔다(`canLeaveChannel`). */
  selfRole: MembershipRole | undefined;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const handingOffRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [topicOpen, setTopicOpen] = useState(false);
  const topic = normalizeChannelTopic(channel.topic ?? "");
  const menuLabel = `${title} 채널 메뉴`;

  const actions = useChannelActions({
    workspaceId,
    channel,
    title,
    selfMemberId,
    selfRole,
    onActionSucceeded: () => setOpen(false),
  });

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // 닫히면 이전 실패는 다음 열기까지 따라오지 않는다.
          if (!next) actions.clearError();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            data-testid="channel-title-menu"
            aria-label={menuLabel}
            title={menuLabel}
            className={channelHeaderControlClass()}
          >
            <EllipsisVertical className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          data-testid="channel-title-menu-content"
          onCloseAutoFocus={(event) => {
            // 주제/나가기 다이얼로그로 넘기는 동안 트리거로 되돌리면, 닫힘
            // 복귀가 다이얼로그 auto-focus와 같은 틱에서 싸운다 (#1865 H-3).
            if (handingOffRef.current) {
              event.preventDefault();
              handingOffRef.current = false;
            }
          }}
        >
          <ChannelActionMenuItems
            surface="header"
            prefix="channel"
            actions={actions}
            onHandOff={(key) => {
              handingOffRef.current = true;
              setOpen(false);
              if (key === "topic") setTopicOpen(true);
              if (key === "leave") actions.leave.open();
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <ChannelLeaveConfirmDialog
        actions={actions}
        title={title}
        testId="channel-leave-confirm"
      />

      {topic !== "" && (
        <ChannelTopicDialog
          topic={topic}
          open={topicOpen}
          onOpenChange={setTopicOpen}
          opener={triggerRef}
        />
      )}
    </>
  );
}
