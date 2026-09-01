import { Fragment, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  removeChannelMember,
  setChannelNotificationPref,
  updateReadState,
  uuidEq,
  type Channel,
  type MembershipRole,
  type ReadState,
} from "@momo/core/lib/api";
import {
  channelLeaveConfirmBody,
  channelLeaveFailureMessage,
  CHANNEL_COPY_FAILURE,
  CHANNEL_COPY_UNAVAILABLE,
  CHANNEL_LEAVE_CONFIRM_TITLE,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_READ_FAILURE,
  CHANNEL_MUTE_FAILURE,
} from "@momo/core/features/channels/model";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/design/ui/dropdown-menu";
import { ContextMenuItem, ContextMenuSeparator } from "@/design/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { channelShareUrl } from "@/features/inbox/anchor";
import { openChannelId } from "@/features/sidebar/openChannel";
import { absoluteApiBase } from "@/lib/serverBase";
import { useInvalidateReadStates } from "@/features/workspace/useWorkspace";
import {
  channelActionAvailability,
  channelActionItemsForSurface,
  channelActionKeepsMenuOpen,
  type ChannelActionAvailability,
  type ChannelActionItem,
  type ChannelActionKey,
  type ChannelActionState,
  type ChannelActionSurface,
} from "./channelActionModel";

// =============================================================================
// 채널 액션 **실행부** 하나 (BT-1 / #1929).
//
// 이 파일이 있는 이유는 `channelActionModel.ts` 가 있는 이유와 같지만, 값이
// 다르다: 모델은 「무엇을 그리는가」를 한 곳에 두고, 여기는 「누르면 무슨 일이
// 일어나는가」를 한 곳에 둔다. 헤더 ⋮ 메뉴가 갖고 있던 뮤테이션(알림 PUT ·
// 나가기 DELETE + 낙관 삭제 + 되돌리기)을 사이드바 행 메뉴가 복사했다면 다음
// 수리는 한쪽에만 들어갔을 것이고, 그때 두 메뉴는 같은 낱말로 다른 일을 한다.
//
// 표면이 갖는 것은 **자기 열림 상태**와 **자기 그릇**뿐이다. 그래서 헤더는
// 드롭다운, 행은 컨텍스트 메뉴일 수 있으면서도 실행은 한 벌이다.
// =============================================================================

export interface ChannelActionTarget {
  workspaceId: string;
  channel: Channel;
  /** 화면에 보이는 채널 이름(labelParts.text ?? label). 확인 문장·이름 복사가 쓴다. */
  title: string;
  selfMemberId: string;
  /** 로그인 멤버의 워크스페이스 역할. undefined 면 내놓고 서버가 답하게 둔다. */
  selfRole: MembershipRole | undefined;
  /**
   * 서버 read-state 투영의 이 채널 항목. 없으면 「읽음 처리」를 그리지 않는다 —
   * 광고할 자리(`latestSeq`)를 모르면서 항목을 내놓을 수는 없다.
   */
  readState?: ReadState | null;
  /** 왕복이 성공했을 때 표면이 자기 메뉴를 닫는다. */
  onActionSucceeded: () => void;
}

export interface ChannelActions {
  available: ChannelActionAvailability;
  state: ChannelActionState;
  items: (surface: ChannelActionSurface) => ChannelActionItem[];
  /** 왕복 중인 항목. 그 행만 잠근다(메뉴 전체가 아니라). */
  pending: ChannelActionKey | null;
  /** 항목 자리에서 하는 말(§5, 토스트가 아니다). 메뉴가 열려 있어야 읽힌다. */
  error: string | null;
  clearError: () => void;
  run: (key: ChannelActionKey) => void;
  leave: {
    confirmOpen: boolean;
    open: () => void;
    close: () => void;
    error: string | null;
    pending: boolean;
    confirm: () => void;
  };
}

export function useChannelActions({
  workspaceId,
  channel,
  title,
  selfMemberId,
  selfRole,
  readState = null,
  onActionSucceeded,
}: ChannelActionTarget): ChannelActions {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const invalidateReadStates = useInvalidateReadStates(workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const linkCopy = useClipboardCopy(
    channelShareUrl(channel.id, {
      origin: absoluteApiBase(),
      pathname: window.location.pathname,
    })
  );
  const nameCopy = useClipboardCopy(title);

  const muteMutation = useMutation({
    mutationFn: (muted: boolean) =>
      setChannelNotificationPref(workspaceId, channel.id, muted),
    onSuccess: () => {
      setError(null);
      onActionSucceeded();
      // 서버가 진실이다: 무효화하면 새 muted 가 흘러 내려와 다음에 열 때 낱말이
      // 뒤집힌다.
      void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
    },
    onError: () => setError(CHANNEL_MUTE_FAILURE),
  });

  // 「읽음 처리」는 새 서버 표면이 아니다: ChatShell 이 채널을 열었을 때 미는 것과
  // **같은** `PUT read-state` 이고, 같은 무효화를 뒤에 단다. 다른 것은 언제
  // 부르는가뿐이다 — 여기서는 채널을 열지 않고. 서버가 `max(current, min(요청,
  // latestSeq))` 로 죄므로 커서는 뒤로 가지 않는다(ADR-0178 D1 단조성).
  //
  // 되돌리기(mark-unread)는 여기 없다. 그 신호는 ADR-0178 이 Proposed 이고 서버
  // 컬럼이 아직 없다 — 없는 것을 그리지 않는다.
  const markReadMutation = useMutation({
    mutationFn: () => {
      if (!readState) throw new Error("no read state");
      return updateReadState(workspaceId, channel.id, readState.latestSeq);
    },
    onSuccess: () => {
      setError(null);
      onActionSucceeded();
      invalidateReadStates();
    },
    onError: () => setError(CHANNEL_MARK_READ_FAILURE),
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
      // 명부의 channelIds 도 이 편집으로 바뀌었다.
      void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
      void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
      // 방금 나온 채널에 머무를 수 없다 — 열려 있었다면. 사이드바에서 **읽고
      // 있지 않은** 채널을 나갈 때까지 인덱스로 튕기면, 사람은 자기가 보고 있던
      // 대화를 잃는다. 헤더 메뉴는 정의상 열린 채널이라 예전 그대로 착지한다.
      const open = openChannelId(location.pathname, null);
      if (open !== null && uuidEq(open, channel.id)) navigate("/");
    },
    onError: (mutationError, _variables, context) => {
      if (context?.previous) {
        client.setQueryData(["channels", workspaceId], context.previous);
      }
      setLeaveError(channelLeaveFailureMessage(mutationError));
    },
  });

  const available = useMemo(
    () =>
      channelActionAvailability({
        channel,
        selfRole,
        unreadCount: readState?.unreadCount ?? 0,
      }),
    [channel, selfRole, readState?.unreadCount]
  );

  const state: ChannelActionState = {
    muted: channel.muted,
    copiedLink: linkCopy.copied,
    copiedName: nameCopy.copied,
  };

  function runCopy(copy: () => Promise<boolean>) {
    // 클립보드 API 자체가 없으면 다시 눌러도 같다. 「다시 시도」라고 말하지
    // 않는 이유이고, `MessageRow.onCopyLink` 가 이미 하는 판정이다.
    if (typeof navigator.clipboard?.writeText !== "function") {
      setError(CHANNEL_COPY_UNAVAILABLE);
      return;
    }
    setError(null);
    void copy().then((ok) => {
      if (!ok) setError(CHANNEL_COPY_FAILURE);
    });
  }

  function run(key: ChannelActionKey) {
    switch (key) {
      case "mute":
        muteMutation.mutate(!channel.muted);
        return;
      case "mark-read":
        markReadMutation.mutate();
        return;
      case "copy-link":
        runCopy(linkCopy.copy);
        return;
      case "copy-name":
        runCopy(nameCopy.copy);
        return;
      case "topic":
      case "leave":
        // 다이얼로그로 넘어가는 항목은 표면이 자기 복귀를 챙긴다.
        return;
    }
  }

  const pending: ChannelActionKey | null = muteMutation.isPending
    ? "mute"
    : markReadMutation.isPending
      ? "mark-read"
      : null;

  return {
    available,
    state,
    items: (surface) => channelActionItemsForSurface(surface, available, state),
    pending,
    error,
    clearError: () => setError(null),
    run,
    leave: {
      confirmOpen: confirmLeave,
      open: () => {
        setLeaveError(null);
        setConfirmLeave(true);
      },
      close: () => {
        setConfirmLeave(false);
        setLeaveError(null);
      },
      error: leaveError,
      pending: leaveMutation.isPending,
      confirm: () => leaveMutation.mutate(),
    },
  };
}

/**
 * 한 메뉴의 항목 전량. 그릇만 다르고(드롭다운 / 컨텍스트) 나머지는 같다 —
 * `MessageActionMenuItems` 와 같은 갈래이고, 같은 이유다.
 */
function ChannelActionMenuRow({
  surface,
  prefix,
  item,
  actions,
  onHandOff,
}: {
  surface: ChannelActionSurface;
  prefix: string;
  item: ChannelActionItem;
  actions: ChannelActions;
  onHandOff: (key: ChannelActionKey) => void;
}) {
  const props = {
    "data-testid": `${prefix}-${item.testKey}`,
    "data-muted":
      item.key === "mute" && actions.state.muted ? "" : undefined,
    tone: item.tone,
    disabled: actions.pending === item.key,
    onSelect: (event: Event) => {
      // 한 번의 REST 왕복 동안 메뉴를 열어 둔다: 성공하면 표면이 닫고, 실패하면
      // 위 배너를 읽을 수 있게 열린 채로 둔다. 파괴적 액션은 한 번의 무방비
      // 클릭으로 발화하지 않는다(§6) — 표면이 다이얼로그로 넘긴다.
      event.preventDefault();
      if (channelActionKeepsMenuOpen(item.key)) {
        actions.run(item.key);
      } else {
        onHandOff(item.key);
      }
    },
    children: item.label,
  };
  return surface === "header" ? (
    <DropdownMenuItem {...props} />
  ) : (
    <ContextMenuItem {...props} />
  );
}

/**
 * 한 메뉴의 항목 전량. 그릇만 다르고(드롭다운 / 컨텍스트) 나머지는 같다 —
 * `MessageActionMenuItems` 와 같은 갈래이고, 같은 이유다.
 */
export function ChannelActionMenuItems({
  surface,
  prefix,
  actions,
  onHandOff,
}: {
  surface: ChannelActionSurface;
  /** `data-testid` 접두사. 헤더는 `channel`, 행은 `channel-row`. */
  prefix: string;
  actions: ChannelActions;
  /**
   * 다이얼로그로 넘기는 항목(주제·나가기)에서 표면이 할 일: 메뉴를 닫고, 닫힘
   * 복귀가 다이얼로그의 auto-focus 와 같은 틱에서 싸우지 않게 막는다.
   */
  onHandOff: (key: ChannelActionKey) => void;
}) {
  const Separator =
    surface === "header" ? DropdownMenuSeparator : ContextMenuSeparator;
  return (
    <>
      {/* 실패는 항목 위에 그 자리에서 선다(§5, 토스트가 아니다). 메뉴가 열려
          있어야 읽히므로, 아래 항목들은 왕복 중에 메뉴를 닫지 않는다. */}
      {actions.error && (
        <InlineBanner
          message={actions.error}
          testId={`${prefix}-action-error`}
        />
      )}
      {actions.items(surface).map((item) => (
        <Fragment key={item.key}>
          {item.separatorBefore && <Separator />}
          <ChannelActionMenuRow
            surface={surface}
            prefix={prefix}
            item={item}
            actions={actions}
            onHandOff={onHandOff}
          />
        </Fragment>
      ))}
    </>
  );
}

/**
 * 나가기 확인. 헤더 ⋮ 와 행 우클릭이 같은 문장·같은 버튼 차례를 쓴다 — 파괴적
 * 액션의 확인 문구가 표면마다 다르면 그중 하나는 덜 무섭게 읽힌다.
 */
export function ChannelLeaveConfirmDialog({
  actions,
  title,
  testId,
}: {
  actions: ChannelActions;
  title: string;
  /** 표면별 접두사를 붙인 id. 게이트가 표면을 구별해 누른다. */
  testId: string;
}) {
  const { leave } = actions;
  return (
    <Dialog
      open={leave.confirmOpen}
      onOpenChange={(next) => {
        if (!next) leave.close();
      }}
    >
      {leave.confirmOpen && (
        <DialogContent
          className="gap-4 p-4"
          data-testid={testId}
          onEscapeKeyDown={(event) => {
            if (leave.pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (leave.pending) event.preventDefault();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{CHANNEL_LEAVE_CONFIRM_TITLE}</DialogTitle>
            <DialogDescription>{channelLeaveConfirmBody(title)}</DialogDescription>
          </div>
          {leave.error && (
            <InlineBanner
              separator={false}
              message={leave.error}
              testId={`${testId}-error`}
            />
          )}
          {/* 표준 테두리 버튼, 후행 정렬, 기본(파괴) 액션이 마지막(§8). */}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={leave.pending}
              onClick={() => leave.close()}
              data-testid={`${testId}-cancel`}
            >
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              aria-busy={leave.pending || undefined}
              onClick={() => leave.confirm()}
              data-testid={`${testId}-action`}
            >
              {leave.pending && (
                <Loader2 aria-hidden="true" className="spinner-busy" />
              )}
              {leave.pending ? "나가는 중" : CHANNEL_LEAVE_LABEL}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
