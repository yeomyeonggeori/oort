import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  removeChannelMember,
  setChannelNotificationPref,
  uuidEq,
  type Channel,
  type MembershipRole,
} from "@momo/core/lib/api";
import {
  canLeaveChannel,
  channelLeaveConfirmBody,
  channelLeaveFailureMessage,
  channelMuteToggleLabel,
  CHANNEL_LEAVE_CONFIRM_TITLE,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MUTE_FAILURE,
} from "@momo/core/features/channels/model";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 채널명 메뉴 (검수 피드백 #3). 채널 이름 자체가 트리거다 — 사람이 채널에 대해
// 무언가 하려 할 때 처음 보는 것이 이름이므로, 그 이름을 누르면 채널을 다루는
// 항목이 선다. 헤더의 다른 버튼(고정 목록·작업 세션)이 이미 `dropdown-menu`로
// 여닫히므로 같은 프리미티브를 쓴다 — 새 컨트롤 문법을 만들 이유가 없다.
//
// 세 항목 중 둘만 여기 있다:
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
  /** 화면에 보이는 채널 이름(labelParts.text ?? label). 트리거의 글자이자
   *  확인 다이얼로그가 이름을 넣어 문장을 짓는 값. */
  title: string;
  selfMemberId: string;
  /** 로그인 멤버의 워크스페이스 역할. undefined면 아직 안 온 것이고, 그때는
   *  나가기를 내놓고 서버가 답하게 둔다(`canLeaveChannel`). */
  selfRole: MembershipRole | undefined;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [muteError, setMuteError] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const muteMutation = useMutation({
    mutationFn: (muted: boolean) =>
      setChannelNotificationPref(workspaceId, channel.id, muted),
    onSuccess: () => {
      setMuteError(false);
      setOpen(false);
      // 서버가 진실이다: 무효화하면 새 muted가 흘러 내려와 다음에 열 때 낱말이
      // 뒤집힌다.
      void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
    },
    onError: () => setMuteError(true),
  });

  const leaveMutation = useMutation({
    mutationFn: () => removeChannelMember(workspaceId, channel.id, selfMemberId),
    onMutate: async () => {
      // 낙관적: 사이드바에서 이 채널을 지금 지운다. 실패하면 스냅샷으로 되돌린다.
      await client.cancelQueries({ queryKey: ["channels", workspaceId] });
      const previous = client.getQueryData<Channel[]>(["channels", workspaceId]);
      client.setQueryData<Channel[]>(["channels", workspaceId], (current) =>
        current?.filter((c) => !uuidEq(c.id, channel.id))
      );
      return { previous };
    },
    onSuccess: () => {
      setLeaveError(null);
      setConfirmLeave(false);
      // 명부의 channelIds도 이 편집으로 바뀌었다.
      void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
      void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
      // 방금 나온 채널에 머무를 수 없다. 인덱스가 남은 첫 채널로 착지시킨다.
      navigate("/");
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        client.setQueryData(["channels", workspaceId], context.previous);
      }
      setLeaveError(channelLeaveFailureMessage(error));
    },
  });

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // 닫히면 이전 알림 실패는 다음 열기까지 따라오지 않는다.
          if (!next) setMuteError(false);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="channel-title-menu"
            aria-label={`${title} 채널 메뉴`}
            className={cn(
              "group flex min-w-0 items-center gap-1 rounded-sm px-1 transition-colors",
              "hover:bg-surface-hover data-[state=open]:bg-surface-hover",
              "focus-visible:focus-ring"
            )}
          >
            <span className="min-w-0 truncate text-body font-semibold text-ink">
              {title}
            </span>
            <ChevronDown
              className="size-4 shrink-0 text-ink-muted"
              aria-hidden="true"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          data-testid="channel-title-menu-content"
        >
          {/* 알림 실패는 항목 위에 그 자리에서 선다(§5, 토스트가 아니다). 메뉴가
              열려 있어야 읽히므로, 아래 항목은 실패 시 preventDefault로 닫지
              않는다. */}
          {muteError && (
            <InlineBanner message={CHANNEL_MUTE_FAILURE} testId="channel-mute-error" />
          )}
          <DropdownMenuItem
            data-testid="channel-mute-toggle"
            data-muted={channel.muted ? "" : undefined}
            disabled={muteMutation.isPending}
            onSelect={(event) => {
              // 한 번의 REST 왕복 동안 메뉴를 열어 둔다(PinListMenu의 「다시
              // 시도」와 같은 규율): 성공하면 onSuccess가 닫고, 실패하면 위 배너를
              // 읽을 수 있게 열린 채로 둔다.
              event.preventDefault();
              muteMutation.mutate(!channel.muted);
            }}
          >
            {channelMuteToggleLabel(channel.muted)}
          </DropdownMenuItem>
          {canLeaveChannel(selfRole) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                tone="danger"
                data-testid="channel-leave"
                onSelect={(event) => {
                  // 파괴적 액션은 한 번의 무방비 클릭으로 발화하지 않는다(§6).
                  // 메뉴를 닫고 확인 다이얼로그로 넘긴다.
                  event.preventDefault();
                  setOpen(false);
                  setLeaveError(null);
                  setConfirmLeave(true);
                }}
              >
                {CHANNEL_LEAVE_LABEL}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={confirmLeave}
        onOpenChange={(next) => {
          setConfirmLeave(next);
          if (!next) setLeaveError(null);
        }}
      >
        {confirmLeave && (
          <DialogContent
            className="gap-4 p-4"
            data-testid="channel-leave-confirm"
            onEscapeKeyDown={(event) => {
              if (leaveMutation.isPending) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (leaveMutation.isPending) event.preventDefault();
            }}
          >
            <div className="flex flex-col gap-1">
              <DialogTitle>{CHANNEL_LEAVE_CONFIRM_TITLE}</DialogTitle>
              <DialogDescription>
                {channelLeaveConfirmBody(title)}
              </DialogDescription>
            </div>
            {leaveError && (
              <InlineBanner
                separator={false}
                message={leaveError}
                testId="channel-leave-error"
              />
            )}
            {/* 표준 테두리 버튼, 후행 정렬, 기본(파괴) 액션이 마지막(§8). */}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={leaveMutation.isPending}
                onClick={() => setConfirmLeave(false)}
                data-testid="channel-leave-cancel"
              >
                취소
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                aria-busy={leaveMutation.isPending || undefined}
                onClick={() => leaveMutation.mutate()}
                data-testid="channel-leave-confirm-action"
              >
                {leaveMutation.isPending && (
                  <Loader2 aria-hidden="true" className="spinner-busy" />
                )}
                {leaveMutation.isPending ? "나가는 중" : CHANNEL_LEAVE_LABEL}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
