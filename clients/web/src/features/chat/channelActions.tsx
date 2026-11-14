import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import { Fragment, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  BookOpen,
  Check,
  Copy,
  EyeOff,
  Fingerprint,
  FolderInput,
  GitPullRequest,
  Info,
  Link,
  DoorOpen,
  Mail,
  MailOpen,
  Star,
  StarOff,
  Type,
  type LucideIcon,
} from "lucide-react";
import {
  leaveChannel,
  setChannelNotificationPref,
  uuidEq,
  ApiError,
  type Channel,
  type MembershipRole,
  type ReadState,
} from "@momo/core/lib/api";
import { composedUnreadCount } from "@momo/core/features/readState/model";
import { useChannelNotificationMutation } from "./useChannelNotificationMutation";
import { advertiseReadState } from "@/features/chat/advertiseReadState";
import {
  channelLeaveConfirmBodyKey,
  channelLeaveFailure,
  CHANNEL_ACTION_ERROR_GROUP_LABEL,
  CHANNEL_COPY_FAILURE,
  CHANNEL_COPY_UNAVAILABLE,
  CHANNEL_MARK_READ_FAILURE,
  CHANNEL_MARK_UNREAD_FAILURE,
  CHANNEL_MUTE_FAILURE,
} from "@momo/core/features/channels/model";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/design/ui/dropdown-menu";
import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/design/ui/context-menu";
import { type DialogFocusTarget } from "@/design/ui/dialog";
import { InlineBanner } from "@/features/common/States";
import { ConfirmDialog } from "@/design/ui/confirm-dialog";
import { ROUTE_REGION_DOM_ID } from "@/app/shellNav";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { channelShareUrl } from "@/features/inbox/anchor";
import { openChannelId } from "@/features/sidebar/openChannel";
import { SECTION_MOVE_TO_BASE_LABEL } from "@momo/core/features/sidebar/sidebarSections";
import { absoluteApiBase } from "@/lib/serverBase";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import {
  applyReadStateToCache,
  useInvalidateReadStates,
} from "@/features/workspace/useWorkspace";
import {
  channelActionAvailability,
  channelActionClusterSubmenu,
  channelActionItemsForSurface,
  channelActionKeepsMenuOpen,
  type ChannelActionAvailability,
  type ChannelActionIcon,
  type ChannelActionItem,
  type ChannelActionKey,
  type ChannelActionState,
  type ChannelActionSurface,
  type ChannelSectionChoice,
} from "@momo/core/features/channels/actionModel";

// =============================================================================
// 채널 액션 **실행부** 하나 (BT-1 / #1929).
//
// 이 파일이 있는 이유는 코어 `channels/actionModel.ts` 가 있는 이유와 같지만, 값이
// 다르다: 모델은 「무엇을 그리는가」를 한 곳에 두고, 여기는 「누르면 무슨 일이
// 일어나는가」를 한 곳에 둔다. 헤더 ⋮ 메뉴가 갖고 있던 뮤테이션(알림 PUT ·
// 나가기 DELETE)을 사이드바 행 메뉴가 복사했다면 다음 수리는 한쪽에만 들어갔을
// 것이고, 그때 두 메뉴는 같은 낱말로 다른 일을 한다. 실제로 그 값을 방금 받았다:
// design-review #1937 H-1 이 잡은 「확인 다이얼로그 자살」은 두 표면의 결함이었고,
// 여기 한 곳을 고쳐 둘이 함께 닫혔다.
//
// 표면이 갖는 것은 **자기 열림 상태**와 **자기 그릇**뿐이다. 그래서 헤더는
// 드롭다운, 행은 컨텍스트 메뉴일 수 있으면서도 실행은 한 벌이다.
// =============================================================================

export interface ChannelActionTarget {
  workspaceId: string;
  channel: Channel;
  /** 화면에 보이는 채널 이름(labelParts.text ?? label). 확인 문장·이름 복사가 쓴다. */
  title: string;
  /** 로그인 멤버. 나가기가 본인 길(`…/members/me`)이 된 뒤로(#5778) 이 훅은 읽지 않는다 — 부르는 쪽의 모양만 남았다. */
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
  /**
   * 이 사람의 커스텀 섹션들과 이 채널이 지금 속한 곳 (ADR-0177 / BT-4 #1932).
   *
   * 옵션인 이유: 헤더 ⋮ 는 섹션을 다루지 않고(`SURFACE_KEYS.header`), 사이드바
   * 밖에서 이 훅을 쓰는 표면도 배치를 모른 채 나머지 액션을 그대로 쓸 수 있어야
   * 한다. 없으면 「섹션으로 이동」이 그냥 서지 않는다.
   */
  sections?: ChannelSectionChoice[];
  currentSectionId?: string | null;
  /** 목적지를 고르면 부른다. 저장은 사이드바가 디바운스로 뒤따른다. */
  onMoveToSection?: (sectionId: string | null) => void;
  /**
   * 별표 (ADR-0177 / BT-5 #1933). 낱말이 이 값으로 뒤집히고, 손이 없으면
   * 항목 자체가 서지 않는다 - 배치와 같은 규율이다.
   */
  starred?: boolean;
  onToggleStar?: () => void;
  /**
   * DM 을 이 기기의 사이드바에서 닫는다 (#3963). 손이 없으면 「목록에서 숨기기」가 서지
   * 않는다 - 별표·배치와 같은 규율이다. 닫는 일의 실행(원장 기록 · 열려 있으면 착지 · 이웃
   * 행으로 캐럿)은 사이드바가 지고, 여기서는 항목을 내고 부르기만 한다.
   */
  onCloseDm?: () => void;
}

export interface ChannelActions {
  available: ChannelActionAvailability;
  state: ChannelActionState;
  items: (surface: ChannelActionSurface) => ChannelActionItem[];
  /**
   * 이 항목의 왕복이 도는 중인가.
   *
   * 슬롯 하나(`pending: key | null`)가 아니라 항목별 물음이다 — 알림과 읽음은
   * 서로 다른 서버 표면이라 **동시에** 돌 수 있고, 슬롯 하나면 둘 중 하나만
   * 「하는 중」이라 말한다(design-review R2 M-2 의 형제 축).
   */
  isPending: (key: ChannelActionKey) => boolean;
  /** 항목 자리에서 하는 말(§5, 토스트가 아니다). 메뉴가 열려 있어야 읽힌다. */
  error: string | null;
  /**
   * 복사 실패는 배너가 아니라 **누른 그 줄**이 말한다(#5777 검수 M1). 배너가 판 맨 위에 서면 위 판이
   * 192 → 331px 로 넓어져 방금 누른 자리를 다른 줄이 차지했고, 「다시 눌러 보세요」대로 누르면 읽음·알림이
   * 실행됐다. 줄은 높이도 위치도 그대로이고 글자만 바뀐다(「복사됨」 영수증과 같은 자리).
   */
  copyFailure: { key: ChannelActionKey; message: string } | null;
  clearError: () => void;
  run: (key: ChannelActionKey) => void;
  /** 「섹션으로 이동」의 라디오 행이 고른 목적지. 표면이 없으면 아무 일도 없다. */
  moveToSection: (sectionId: string | null) => void;
  leave: {
    /** 확인 문장이 공개·비공개로 갈린다(`channelLeaveConfirmBodyKey`). */
    kind: Channel["kind"];
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
  selfRole,
  readState = null,
  onActionSucceeded,
  sections,
  currentSectionId = null,
  onMoveToSection,
  starred = false,
  onToggleStar,
  onCloseDm,
}: ChannelActionTarget): ChannelActions {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const formatMessage = useFormatMessage();
  const invalidateReadStates = useInvalidateReadStates(workspaceId);
  const [error, setErrorState] = useState<string | null>(null);
  const [copyFailure, setCopyFailure] = useState<{
    key: ChannelActionKey;
    message: string;
  } | null>(null);
  // 배너 쪽 오류를 비우거나 새로 세울 때 복사 실패 줄도 같이 쉰다 - 두 말이 한 메뉴에 겹치지 않는다.
  const setError = (next: string | null) => {
    setCopyFailure(null);
    setErrorState(next);
  };
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const linkCopy = useClipboardCopy(
    channelShareUrl(channel.id, {
      origin: absoluteApiBase(),
      pathname: window.location.pathname,
    })
  );
  const nameCopy = useClipboardCopy(title);
  const idCopy = useClipboardCopy(channel.id);

  // 알림의 낙관 갱신은 행을 지우지 않는다. 나가기와 달리 전용 훅이 상태·복구를 맡고,
  // API 호출은 여기 한 벌을 유지해 헤더와 사이드바가 같은 실행 경로를 쓴다.
  const {mutation: muteMutation, optimisticMute} = useChannelNotificationMutation({
    mutationFn: (target) =>
      setChannelNotificationPref(target.workspaceId, target.channelId, target.muted),
    onStart: () => setError(null),
    onSuccess: () => {
      setError(null);
      onActionSucceeded();
    },
    onError: () => setError(CHANNEL_MUTE_FAILURE),
  });

  // 「읽음 처리」는 새 서버 표면이 아니다: ChatShell 이 채널을 열었을 때 미는 것과
  // **같은** `PUT read-state` 이고, 같은 무효화를 뒤에 단다. 다른 것은 언제
  // 부르는가뿐이다 — 여기서는 채널을 열지 않고. 서버가 `max(current, min(요청,
  // latestSeq))` 로 죄므로 커서는 뒤로 가지 않는다(ADR-0178 D1 단조성).
  //
  // ADR-0178 D6: this path is `explicit_open`, same discriminator as opening
  // the channel. The ⋯ 「여기부터 안 읽음」 path is the opposite (background).
  const markReadMutation = useMutation({
    mutationFn: () => {
      if (!readState) throw new Error("no read state");
      return advertiseReadState(
        workspaceId,
        channel.id,
        readState.latestSeq,
        "mark_read_menu"
      );
    },
    onSuccess: (state) => {
      setError(null);
      onActionSucceeded();
      applyReadStateToCache(client, workspaceId, state);
      invalidateReadStates();
    },
    onError: () => setError(CHANNEL_MARK_READ_FAILURE),
  });

  // 「읽지 않음으로 표시」 (#3963). 다 읽은 채널의 **가장 최근 메시지**를 첫 안 읽음으로
  // 남긴다: `mark_unread_before_seq` 에 최신 seq 를 싣고, 읽음 커서는 그대로 광고한다(서버가
  // `max(current, min(요청, latestSeq))` 로 죄므로 뒤로 가지 않는다). 사유는 `mark_unread` 다 -
  // `read_intent` 를 싣지 않는다. `explicit_open` 을 실으면 표시를 세운 같은 트랜잭션이 그
  // 표시를 지운다(`advertiseReadState.ts` 머리말 5번). 메시지 ⋯ 의 「여기부터 안 읽음」과
  // 같은 와이어이고 다른 것은 어느 seq 를 고르는가뿐이다.
  const markUnreadMutation = useMutation({
    mutationFn: () => {
      if (!readState) throw new Error("no read state");
      return advertiseReadState(
        workspaceId,
        channel.id,
        readState.lastReadSeq,
        "mark_unread",
        { markUnreadBeforeSeq: readState.latestSeq }
      );
    },
    onSuccess: (state) => {
      setError(null);
      onActionSucceeded();
      applyReadStateToCache(client, workspaceId, state);
      invalidateReadStates();
    },
    onError: () => setError(CHANNEL_MARK_UNREAD_FAILURE),
  });

  // ## 목록에서 지우는 시점 — 낙관이 다이얼로그를 죽였다 (design-review #1937 H-1)
  //
  // 이 뮤테이션은 `onMutate` 에서 사이드바 목록을 낙관적으로 편집했다. 그런데
  // 그 편집이 **행을 언마운트**하고, 확인 다이얼로그는 그 행의 서브트리 안에
  // 살아서 함께 죽었다. 실측 시간축(DELETE 를 900ms 뒤 403):
  //
  //     13ms  dialog=1 busy=0        ← 확인 다이얼로그
  //    115ms  dialog=0 busy=0        ← 확인을 누르자마자 사라진다
  //    928ms  dialog=0 err=[]        ← 403 롤백. 채널이 말없이 되돌아온다
  //   2147ms  dialog=0 err=[]        ← 끝까지 아무 문장도 없다
  //
  // 그래서 코드에 있는 「나가는 중」(`aria-busy`)과 실패 배너가 **화면에 도달할
  // 수 없었다**. 사람이 본 것은 「눌렀더니 사라졌다 → 1초 뒤 되돌아왔다」뿐이고,
  // 그것은 화면이 성공을 말했다가 조용히 번복한 것이다. 헤더 ⋮ 도 같았다
  // (대조 실측 `{deletes:1, dialogStillMounted:0, errorBanner:0}`) — 이 파일이
  // 두 표면의 공용 정본이므로 한 곳을 고치면 둘이 함께 닫힌다.
  //
  // 셋 중 골랐다 — ①낙관을 왕복 뒤로 미루기 ②다이얼로그를 행 밖으로 올리기
  // ③행을 「나가는 중」으로 흐리게 두기.
  //
  // ①이다. **확인 다이얼로그가 있는 파괴 액션에서 낙관은 살 것이 없다**: 사람은
  // 이미 다이얼로그를 보고 있지 사이드바를 보고 있지 않으므로, 목록이 100ms 일찍
  // 줄어드는 것을 아무도 못 본다. 그 값을 치르고 얻은 것은 로딩 상태와 오류
  // 상태가 통째로 없어지는 것이었다. ②는 다이얼로그를 옮겨도 왕복 중 행이
  // 사라지는 것 자체는 남고, ③은 「지워졌다」와 「지우는 중」이라는 두 개의 참을
  // 한 행에 겹쳐 그린다. 스냅샷·롤백이 함께 사라지는 것은 덤이다 — 되돌릴 것을
  // 만들지 않으면 되돌리기가 필요 없다.
  // 이 채널이 내 것이 아니게 된 뒤의 정리 - 나가기 성공과 「이미 나간 것」(404)이 같은 길이다.
  const leftChannel = () => {
    // 서버가 답한 **뒤에** 목록에서 지운다. 무효화만 걸면 재조회가 도착할
    // 때까지 방금 나온 채널이 남아 있으므로, 캐시를 지금 한 번 편집하고
    // 서버가 마지막 말을 하게 둔다.
    client.setQueryData<Channel[]>(["channels", workspaceId], (current) =>
      current?.filter((c) => !uuidEq(c.id, channel.id))
    );
    void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
    // 명부의 channelIds 도 이 편집으로 바뀌었다.
    void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
    // 방금 나온 채널에 머무를 수 없다 — 열려 있었다면. 사이드바에서 **읽고
    // 있지 않은** 채널을 나갈 때까지 인덱스로 튕기면, 사람은 자기가 보고 있던
    // 대화를 잃는다. 헤더 메뉴는 정의상 열린 채널이라 예전 그대로 착지한다.
    const open = openChannelId(location.pathname, null);
    if (open !== null && uuidEq(open, channel.id)) navigate("/");
  };
  const leaveMutation = useMutation({
    // 본인 나가기 길(#5778). 관리자 전용 `removeChannelMember` 로 자기를 지우면 일반 멤버는 403 이다.
    mutationFn: () => leaveChannel(workspaceId, channel.id),
    onSuccess: () => {
      setLeaveError(null);
      setConfirmLeave(false);
      leftChannel();
    },
    onError: (mutationError) => {
      // 404 = 서버가 「이미 이 채널의 멤버가 아니다」(다른 탭·기기에서 먼저 나갔거나 채널이 보관됨)라고 답한 것이다. 낡은 화면이
      // 한 사실을 아직 모르는 것이므로 나간 것과 같게 거둔다: 줄을 걷고, 열려 있으면 옮기고, 초점을 돌려준다(#5818 검수 M2).
      // 확인 창은 닫는다 - 줄이 사라지면 그 서브트리의 창도 함께 죽는데(위 시간축), 사라지는 창 안에 문장을 세워 둘 이유가 없다.
      if (mutationError instanceof ApiError && mutationError.status === 404) {
        setLeaveError(null);
        setConfirmLeave(false);
        leftChannel();
        return;
      }
      // 목록을 건드리지 않았으므로 되돌릴 것이 없다. 다이얼로그는 그대로 서
      // 있고, 그 안에서 이유를 말한다.
      const failure = channelLeaveFailure(mutationError);
      setLeaveError(formatMessage(failure.key, failure.values as never));
    },
  });

  const available = useMemo(
    () =>
      channelActionAvailability({
        channel,
        selfRole,
        unreadCount: readState ? composedUnreadCount(readState) : 0,
        // 옮길 곳을 **부를 수 있는 표면**이 없으면 항목도 없다. 목적지 목록만
        // 있고 손잡이가 없으면 눌러도 아무 일이 없는 라디오가 된다.
        sectionCount: onMoveToSection ? sections?.length ?? 0 : 0,
        canStar: Boolean(onToggleStar),
        hasMemorySettings: isSurfaceProvided("teamMemory"),
        hasGithubNotifications: isSurfaceProvided("githubNotifications"),
        // 투영이 있고, 다 읽었고, 메시지가 하나라도 있을 때만(빈 채널에는 표시할 메시지가 없다).
        canMarkUnread:
          readState != null &&
          readState.latestSeq > 0 &&
          composedUnreadCount(readState) === 0,
        canCloseDm: Boolean(onCloseDm),
      }),
    [
      channel,
      selfRole,
      readState,
      sections?.length,
      onMoveToSection,
      onToggleStar,
      onCloseDm,
    ]
  );

  const state: ChannelActionState = {
    muted: optimisticMute?.workspaceId === workspaceId && optimisticMute.channelId === channel.id
      ? optimisticMute.muted : channel.muted,
    copiedLink: linkCopy.copied,
    copiedName: nameCopy.copied,
    copiedId: idCopy.copied,
    starred,
    sections,
    currentSectionId,
  };

  function runCopy(key: ChannelActionKey, copy: () => Promise<boolean>) {
    // 클립보드 API 자체가 없으면 다시 눌러도 같다. 「다시 시도」라고 말하지
    // 않는 이유이고, `MessageRow.onCopyLink` 가 이미 하는 판정이다.
    if (typeof navigator.clipboard?.writeText !== "function") {
      setCopyFailure({ key, message: CHANNEL_COPY_UNAVAILABLE });
      return;
    }
    setError(null);
    void copy().then((ok) => {
      if (!ok) setCopyFailure({ key, message: CHANNEL_COPY_FAILURE });
    });
  }

  function run(key: ChannelActionKey) {
    // 잠그지 않는 대신 여기서 막는다 (design-review #1937 N-1): 낱말이 「알림
    // 끄는 중」인 항목을 한 번 더 누르는 것은 두 번째 PUT 이 아니라 같은 한 번의
    // 재확인이다. 잠근 컨트롤은 「하면 안 된다」로 읽히지만, 받고 무시하는
    // 컨트롤은 아무 말도 하지 않는다 — 낱말이 이미 말하고 있다.
    //
    // **같은 열쇠에만 건다** (design-review R2 M-2). 처음에는 「둘 중 하나라도
    // 돌고 있으면 둘 다 막는다」였고, 그래서 알림이 도는 동안 「읽음 처리하기」가
    // **조용한 무동작**이었다(실측: 클릭해도 read-state PUT 0건, 낱말도 배너도
    // 변화 없음). 그 항목은 낱말도 `aria-busy` 도 쉬는 상태였으니 화면은 「눌러도
    // 된다」고 말하고 있었고, 잠금을 걷어낸 자리에 잠금보다 나쁜 것이 들어온
    // 것이다 — 회색은 최소한 말은 한다. 위 근거가 든 것은 「같은 항목의
    // 재확인」뿐이므로 가드도 딱 거기까지다. 두 왕복이 겹치는 것은 서로 다른
    // 서버 표면이라 문제가 없다.
    if (key === "mute" && muteMutation.isPending) return;
    if (key === "mark-read" && markReadMutation.isPending) return;
    if (key === "mark-unread" && markUnreadMutation.isPending) return;
    switch (key) {
      case "mute": {
        const previousMuted = client.getQueryData<Channel[]>(["channels", workspaceId])
          ?.find((row) => uuidEq(row.id, channel.id))?.muted ?? channel.muted;
        muteMutation.mutate({ workspaceId, channelId: channel.id, previousMuted, muted: !previousMuted });
        return;
      }
      case "mark-read":
        markReadMutation.mutate();
        return;
      case "mark-unread":
        markUnreadMutation.mutate();
        return;
      case "copy-link":
        runCopy(key, linkCopy.copy);
        return;
      case "copy-name":
        runCopy(key, nameCopy.copy);
        return;
      case "copy-id":
        runCopy(key, idCopy.copy);
        return;
      case "close-dm":
        // 왕복이 없다. 닫기는 이 기기의 원장 한 칸이고(`sidebarDmClosure.ts`), 서버도 상대 쪽
        // 멤버십도 건드리지 않는다. 그래서 되돌릴 것도 기다릴 것도 없다.
        setError(null);
        onCloseDm?.();
        return;
      case "star":
        // 왕복이 없다. 별표는 사이드바 payload 의 한 칸이고 저장은 디바운스가
        // 뒤따르므로(ADR-0177 D2), 여기서 기다릴 것도 되돌릴 것도 없다.
        setError(null);
        onToggleStar?.();
        return;
      case "topic":
      case "memory":
      case "github":
      case "leave":
      case "move-to-section":
        // 다이얼로그로 넘어가는 항목과 무리 항목은 표면이 자기 복귀를 챙긴다.
        // 「섹션으로 이동」은 **행 하나가 아니라 무리**라 고를 것이 여기 없다 -
        // 어느 목적지인지는 라디오 행이 알고, 그것을 `moveToSection` 이 받는다.
        return;
    }
  }

  function isPending(key: ChannelActionKey): boolean {
    if (key === "mute") return muteMutation.isPending;
    if (key === "mark-read") return markReadMutation.isPending;
    if (key === "mark-unread") return markUnreadMutation.isPending;
    return false;
  }

  return {
    available,
    state,
    items: (surface) => channelActionItemsForSurface(surface, available, state),
    isPending,
    error,
    copyFailure,
    clearError: () => setError(null),
    run,
    moveToSection: (sectionId) => {
      setError(null);
      onMoveToSection?.(sectionId);
    },
    leave: {
      kind: channel.kind,
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
 * 아이콘 뜻 낱말 → Lucide 글리프 (#5777, owner 2026-11-14 「알림 아이콘 정렬 잘 맞춰줘」).
 *
 * 모든 줄이 줄 앞에 16px(`size-4`, README §2.8) 글리프 하나를 든다. 줄의 안쪽 여백(`px-2`)과 간격(`gap-2`)이
 * 같으므로 아이콘은 한 세로 줄에, 글자는 그 오른쪽 한 세로 줄에 선다 - 아이콘 없는 줄이 섞이면 그 줄의 글자만
 * 왼쪽으로 24px 당겨져 들쭉날쭉해진다(예전 알림 줄만 아이콘이 있던 메뉴). 표가 낱말마다 하나를 요구하므로
 * (`Record<ChannelActionIcon, …>`) 새 낱말은 글리프를 고르지 않고는 컴파일되지 않는다. 고른 이유:
 *   topic        Info            채널에 대한 설명을 본다(헤더 전용)
 *   copy         Copy            복사 하위 메뉴(메시지 메뉴의 「메시지 복사」와 같은 글리프)
 *   copy-name    Type            글자(이름)를 가져간다
 *   copy-link    Link            메시지 메뉴의 「링크 복사하기」와 같다
 *   copy-id      Fingerprint     하나뿐인 식별값
 *   section      FolderInput     폴더(섹션)로 넣는다. 사이드바의 「새 섹션」이 `FolderPlus` 다
 *   mark-read    MailOpen        열린 봉투 = 읽음. 메시지 메뉴의 「여기부터 안 읽음」(닫힌 봉투 `Mail`)과 짝
 *   mark-unread  Mail            닫힌 봉투 = 안 읽음(BT-6 의 읽음 상태 문법, README §6 Buzz 대응표)
 *   bell(-off)   Bell / BellOff  알림 상태 그대로(낱말 「알림 켜짐 / 꺼짐」과 같은 상태를 그린다)
 *   memory       BookOpen        기억 표지(`MemoryReceiptChip`)와 같다
 *   github       GitPullRequest  앱이 GitHub 를 그리는 글리프(작업 보드 · 실행 보고)
 *   star/unstar  Star / StarOff  별표 붙이기 / 떼기
 *   hide         EyeOff          「목록에서 숨기기」(대화를 지우지 않고 목록에서 안 보이게 한다)
 *   leave        DoorOpen        나가기. 위험 줄이라 글자와 함께 `--danger` 를 입는다(`currentColor`)
 * 색은 따로 주지 않는다: 메시지 메뉴(`MessageActions.tsx` `actionIcon`)처럼 줄 글자색을 물려받는다.
 */
const ACTION_ICON: Record<ChannelActionIcon, LucideIcon> = {
  topic: Info,
  copy: Copy,
  "copy-name": Type,
  "copy-link": Link,
  "copy-id": Fingerprint,
  section: FolderInput,
  "mark-read": MailOpen,
  "mark-unread": Mail,
  bell: Bell,
  "bell-off": BellOff,
  memory: BookOpen,
  github: GitPullRequest,
  star: Star,
  unstar: StarOff,
  hide: EyeOff,
  leave: DoorOpen,
};

function ActionIcon({ name }: { name: ChannelActionIcon }) {
  const Glyph = ACTION_ICON[name];
  return (
    <Glyph className="size-4 shrink-0" aria-hidden="true" data-menu-icon={name} />
  );
}

/**
 * 「섹션으로 이동 ›」 하위 판의 목적지들 — 라디오 행 (ADR-0177 D4 / BT-4 #1932 → #5777).
 *
 * 이 무리는 웹에서 하위 메뉴로 접힌다(코어 `channelActionClusterSubmenu`, 규칙은 「고를 수 없는 줄이 없는
 * 묶음에만」). 목적지는 언제나 고를 수 있는 줄이라 그 규칙 안에 든다. 예전의 제목 줄(「섹션으로 이동」)은
 * 하위 메뉴를 여는 줄이 되었고, 하위 판은 Radix 가 그 줄을 이름으로 단다(`aria-labelledby`). 라디오인
 * 이유는 배치가 **여럿 중 하나**라서다 - 지금 속한 섹션이 `aria-checked` 로 들려야 하고, 그것은 체크
 * 표시가 눈에 말하는 것과 같은 사실이다.
 *
 * 그릇은 **표면이 고른다** (design-review #1932 N-1). 오늘 이 무리는 행 메뉴에만 서고(`SURFACE_KEYS.header`
 * 가 이 열쇠를 주지 않는다), 그런데도 갈라 두는 것은 코어가 확장점을 「열쇠 하나·분기 하나·SURFACE_KEYS 항목
 * 하나」라고 광고하기 때문이다. 그 한 줄을 믿고 헤더에 이 열쇠를 넣는 사람이 Radix 루트 없는 컨텍스트 메뉴
 * 조각을 렌더하지 않게 한다.
 */
function ChannelSectionMoveChoices({
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
  const choices = item.sections ?? [];
  // 값은 문자열이어야 한다(Radix RadioGroup). 기본 섹션의 `null` 은 채널 id 가
  // 될 수 없는 낱말 하나로 적는다 - 커스텀 섹션 id 는 `sec-<수>` 꼴이라 절대
  // 겹치지 않는다.
  const BASE = "\u0000base";
  const current = item.currentSectionId ?? BASE;
  const RadioGroup =
    surface === "header" ? DropdownMenuRadioGroup : ContextMenuRadioGroup;
  const RadioItem =
    surface === "header" ? DropdownMenuRadioItem : ContextMenuRadioItem;
  return (
    <RadioGroup
      value={current}
      onValueChange={(next) => {
        onHandOff(item.key);
        actions.moveToSection(next === BASE ? null : next);
      }}
    >
      {[{ id: null, label: SECTION_MOVE_TO_BASE_LABEL }, ...choices].map(
        (choice) => {
          const value = choice.id ?? BASE;
          return (
            <RadioItem
              key={value}
              value={value}
              data-testid={`${prefix}-section-${choice.id ?? "base"}`}
            >
              {/* 긴 한글 섹션 이름(최대 80자)이 판을 창 밖으로 밀지 않는다.
                  `max-w-pane`(320) 은 이 레포가 이미 목록 하나의 폭으로 들고
                  있는 수이고, 자른 자리의 전체 이름은 title 이 든다 - 사이드바
                  행이 같은 축에서 같은 것을 한다. */}
              <span
                className="min-w-0 max-w-pane flex-1 truncate"
                title={choice.label}
              >
                {choice.label}
              </span>
              {/* 체크는 **캘러가 그린다** (`DropdownMenuRadioItem` 독스트링:
                  "It does NOT reserve an indicator gutter"). `aria-checked` 가
                  귀에 말하는 것과 같은 사실을 눈에 말하는 자리이고, 없으면
                  스크린리더만 지금 자리를 안다. `PresenceControl` 이 같은 것을
                  같은 아이콘·같은 잉크로 그린다. 하위 판 안의 줄은 모두 아이콘이
                  없어 글자 시작이 한 세로 줄이다. */}
              {value === current && (
                <Check
                  className="size-4 shrink-0 text-ink-muted"
                  aria-hidden="true"
                />
              )}
            </RadioItem>
          );
        }
      )}
    </RadioGroup>
  );
}

/**
 * 복사 실패 문장의 첫 문장(「복사하지 못했습니다」). 줄은 한 줄·32px 로 고정이라 전체 문장은 `title` 과
 * 스크린리더용 알림이 맡는다. 새 문구를 코드에 적지 않고 코어가 가진 문장에서 가져온다.
 */
function copyFailureRowLabel(message: string): string {
  const first = message.split(". ")[0];
  return first.endsWith(".") ? first.slice(0, -1) : first;
}

/**
 * 한 줄. 아이콘(`ActionIcon`) + 낱말. 그릇만 다르고(드롭다운 / 컨텍스트) 나머지는 같다 —
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
  const busy = actions.isPending(item.key);
  const failure =
    actions.copyFailure?.key === item.key ? actions.copyFailure : null;
  const props = {
    "data-testid": `${prefix}-${item.testKey}`,
    "data-muted":
      item.key === "mute" && actions.state.muted ? "" : undefined,
    tone: failure ? ("danger" as const) : item.tone,
    // 눌린 줄이 실패를 말할 때 전체 문장(다시 눌러 보세요 / 클립보드를 쓸 수 없습니다)은 title 에 둔다.
    title: failure?.message,
    "data-copy-failed": failure ? "" : undefined,
    // 왕복 중에도 잠그지도 흐리지도 않는다 (design-review #1937 N-1).
    // `States.tsx` 가 같은 축에 「`aria-busy` 와 바뀐 낱말, never `disabled`
    // and never dimmed」라 적어 두었다 — 회색이 된 컨트롤은 「지금 일어나는
    // 중」이 아니라 「너는 이걸 하면 안 된다」로 읽힌다. 두 번 눌리는 것은
    // 아래 `run` 이 막는다(왕복 중인 항목은 다시 발화하지 않는다).
    "aria-busy": busy || undefined,
    onSelect: (event: Event) => {
      // 한 번의 REST 왕복 동안 메뉴를 열어 둔다: 성공하면 표면이 닫고, 실패하면
      // 위 배너를 읽을 수 있게 열린 채로 둔다. 파괴적 액션은 한 번의 무방비
      // 클릭으로 발화하지 않는다(§6) — 표면이 다이얼로그로 넘긴다.
      event.preventDefault();
      // 메뉴를 닫는 항목도 **여기서** 발화한다 (BT-5 #1933). 앞 판은 닫는 쪽을
      // `onHandOff` 에게만 넘겼고, 그래서 「닫고 나서 무엇을 하는가」가 표면마다
      // 흩어져 있었다 - 별표가 그 자리에 들어오면 사이드바 행 메뉴 안에 실행이
      // 하나 더 생겼을 것이고, 이 파일의 존재 이유(실행부 하나)가 그만큼 깎인다.
      // `run` 은 다이얼로그로 넘기는 열쇠(주제·나가기·배치 무리)에 대해 아무
      // 일도 하지 않으므로(그 파일의 `switch`), 이 한 줄은 오늘의 동작을 바꾸지
      // 않으면서 실행의 자리를 하나로 되돌린다.
      if (!channelActionKeepsMenuOpen(item.key)) onHandOff(item.key);
      actions.run(item.key);
    },
    children: (
      <>
        <ActionIcon name={item.icon} />
        {failure
          ? copyFailureRowLabel(failure.message)
          : busy
            ? item.busyLabel ?? item.label
            : item.label}
      </>
    ),
  };
  return surface === "header" ? (
    <DropdownMenuItem {...props} />
  ) : (
    <ContextMenuItem {...props} />
  );
}

/**
 * 같은 무리의 연속 항목을 한 덩어리로 묶는다. 정본 차례가 무리 단위로 단조라서 한 무리가
 * 둘로 갈라지는 일은 없다.
 */
function clusterRuns(items: ChannelActionItem[]): ChannelActionItem[][] {
  const runs: ChannelActionItem[][] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last && last[0].cluster === item.cluster) last.push(item);
    else runs.push([item]);
  }
  return runs;
}

/**
 * 한 무리의 줄들. 하위 메뉴로 접는 무리(복사 · 섹션 이동, 코어 `channelActionClusterSubmenu`)는 **여는 줄
 * 하나 + 하위 판**으로, 나머지는 줄만 선다 (#5777, owner 2026-11-14 「버즈에선 우클릭했을 때 라벨 섹션없이」).
 *
 * 예전에는 복사가 「제목 + 화면에 남는 세 줄」이었다(하위 메뉴 금지, #1383). 그 규칙은 「고를 수 없는 줄이
 * 없는 묶음에만 하위 메뉴」로 좁혀졌고(`dropdown-menu.tsx` 머리말), 이 두 무리는 잠긴 줄이 없다. 여는 줄은
 * 다른 줄처럼 아이콘을 앞에 들어 아이콘 세로 줄이 끊기지 않고, 끝에 › 가 선다(`submenuChevron`).
 *
 * 하위 판의 접근 이름은 여는 줄의 글자다(Radix 가 판에 `aria-labelledby` 로 단다). 복사 줄은 「복사됨」
 * 영수증 동안 두 판이 다 열려 있고(`channelActionKeepsMenuOpen`), 목적지를 고르면 표면이 메뉴를 통째로 닫는다.
 */
function ChannelActionClusterRows({
  surface,
  prefix,
  run,
  actions,
  onHandOff,
}: {
  surface: ChannelActionSurface;
  prefix: string;
  run: ChannelActionItem[];
  actions: ChannelActions;
  onHandOff: (key: ChannelActionKey) => void;
}) {
  const rows = run.map((item) =>
    item.sections ? (
      <ChannelSectionMoveChoices
        key={item.key}
        surface={surface}
        prefix={prefix}
        item={item}
        actions={actions}
        onHandOff={onHandOff}
      />
    ) : (
      <ChannelActionMenuRow
        key={item.key}
        surface={surface}
        prefix={prefix}
        item={item}
        actions={actions}
        onHandOff={onHandOff}
      />
    )
  );
  const submenu = channelActionClusterSubmenu(run[0].cluster);
  if (submenu === undefined) return <>{rows}</>;
  const Sub = surface === "header" ? DropdownMenuSub : ContextMenuSub;
  const SubTrigger =
    surface === "header" ? DropdownMenuSubTrigger : ContextMenuSubTrigger;
  const SubContent =
    surface === "header" ? DropdownMenuSubContent : ContextMenuSubContent;
  return (
    <Sub>
      <SubTrigger data-testid={`${prefix}-${submenu.testKey}`}>
        <ActionIcon name={submenu.icon} />
        {submenu.label}
      </SubTrigger>
      <SubContent data-testid={`${prefix}-${submenu.testKey}-menu`}>
        {rows}
      </SubContent>
    </Sub>
  );
}

/**
 * 이 무리 위에 구분선을 세우는가. 코어가 무리가 바뀌는 자리에 단 `separatorBefore` 를 따르되, **하위 메뉴를
 * 여는 줄끼리는 한 띠로 붙인다**(#5777): Buzz 의 행 메뉴처럼 `복사 ›` 바로 아래 `섹션으로 이동 ›` 이 선다.
 * 여는 줄 하나짜리 무리마다 선이 서면 줄 하나를 선 둘이 감싸 메뉴가 토막 난다. 폰 시트는 무리마다 카드라
 * 이 규칙을 쓰지 않는다(코어의 구분선 값은 그대로다).
 */
function separatesFrom(
  previous: ChannelActionItem[] | undefined,
  run: ChannelActionItem[]
): boolean {
  if (!run[0].separatorBefore) return false;
  return !(
    previous !== undefined &&
    channelActionClusterSubmenu(previous[0].cluster) !== undefined &&
    channelActionClusterSubmenu(run[0].cluster) !== undefined
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
  const runs = clusterRuns(actions.items(surface));
  return (
    <>
      {/* 실패는 항목 위에 그 자리에서 선다(§5, 토스트가 아니다). 메뉴가 열려
          있어야 읽히므로, 아래 항목들은 왕복 중에 메뉴를 닫지 않는다. 하위 판의
          복사 줄이 실패해도 이 배너는 위 판 맨 위에 선다 - 복사 영수증 동안 두
          판이 다 열려 있으므로 보이고, `role="alert"` 라 초점이 하위 판에 있어도
          읽힌다(#5777).

          `role="group"` 으로 한 겹 감싼다 (design-review #1937 N-5): `menu` 의
          직계 자식은 menuitem/group/separator 여야 하는데 `InlineBanner` 는
          `role="alert"` 이라 그 목록에 없다. `group` 은 목록에 있고 라이브
          리전은 그 안에서 그대로 읽히므로, 문장을 잃지 않고 구조만 맞춘다.
          Radix 의 항목 수집은 `[data-radix-collection-item]` 기준이라 화살표
          순회는 이 상자를 그냥 지나간다.

          `px-2`: 배너의 기본 `px-4` 는 메뉴 행(`px-2`)과 다른 축이라 첫 글자가
          8px 오른쪽으로 밀려 섰다(실측 21px 대 13px, N-3). 같은 왼쪽 자를 쓴다. */}
      {actions.copyFailure && (
        // 눈에는 누른 줄이 말하고(위 `ChannelActionMenuRow`), 귀에는 여기가 문장 전체를 읽는다. `sr-only`
        // 는 자리를 차지하지 않으므로 판의 폭도 줄 위치도 움직이지 않는다.
        <div role="group" aria-label={CHANNEL_ACTION_ERROR_GROUP_LABEL}>
          <p
            role="alert"
            className="sr-only"
            data-testid={`${prefix}-action-error`}
          >
            {actions.copyFailure.message}
          </p>
        </div>
      )}
      {actions.error && (
        <div role="group" aria-label={CHANNEL_ACTION_ERROR_GROUP_LABEL}>
          <InlineBanner
            className="px-2"
            message={actions.error}
            testId={`${prefix}-action-error`}
          />
        </div>
      )}
      {runs.map((run, index) => (
        <Fragment key={run[0].cluster}>
          {separatesFrom(runs[index - 1], run) && <Separator />}
          <ChannelActionClusterRows
            surface={surface}
            prefix={prefix}
            run={run}
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
  opener,
}: {
  actions: ChannelActions;
  title: string;
  /** 표면별 접두사를 붙인 id. 게이트가 표면을 구별해 누른다(`<id>`·`<id>-confirm`·`<id>-cancel`·`<id>-error`). */
  testId: string;
  opener?: DialogFocusTarget | null;
}) {
  const { leave } = actions;
  const formatMessage = useFormatMessage();
  // 닫힐 때 초점을 돌려줄 곳: 연 단추·줄이 아직 있으면 그곳, 나가서 사라졌으면 옮겨 간 화면의 본문 자리(`ROUTE_REGION_DOM_ID`,
  // `tabIndex=-1`) - 문서 몸통으로 떨어지지 않게(#5818 검수 M3). 닫히는 순간(퇴장 모션 뒤)에 읽으므로 그때의 사실로 정한다.
  const focusLanding: DialogFocusTarget = {
    get isConnected() {
      return (opener?.isConnected ?? false) || document.getElementById(ROUTE_REGION_DOM_ID) !== null;
    },
    focus: () => {
      if (opener?.isConnected) {
        opener.focus();
        return;
      }
      // 폰 폭에서는 줄 메뉴가 서랍 안에 있고, 서랍이 열려 있는 동안 본문 자리는 `inert` 라 `focus()` 가 조용히 거절된다
      // (그 뒤 서랍이 닫히며 초점은 몸통으로 떨어진다, #5818 검수 r2 N2). 받을 때까지 몇 프레임 다시 시도한다.
      let tries = 30;
      const land = () => {
        const region = document.getElementById(ROUTE_REGION_DOM_ID);
        if (region === null) return;
        region.focus({ preventScroll: true });
        if (document.activeElement !== region && (tries -= 1) > 0) requestAnimationFrame(land);
      };
      land();
    },
  };
  // 공용 확인 창(`ConfirmDialog`)의 몸을 쓴다: 확정은 서고 나서 500ms 동안 눌림을 받지 않는다(메뉴 줄을 누른 자리에 위험 확정이
  // 서도 둘째 누름이 확정을 누르지 못한다, #5818 검수 High), 진행 중에는 Esc·바깥 누름·취소가 잠긴다. 자기 단추를 따로 그리지 않는다.
  return (
    <ConfirmDialog
      open={leave.confirmOpen}
      onOpenChange={(next) => {
        if (!next) leave.close();
      }}
      // `ConfirmDialog` 는 `HTMLElement` 로 받지만 `DialogContent` 가 쓰는 것은 `isConnected`·`focus` 둘뿐이다(`DialogFocusTarget`).
      opener={focusLanding as unknown as HTMLElement}
      testId={testId}
      tone="destructive"
      title={formatMessage("timeline.channelLeave.title")}
      description={formatMessage(channelLeaveConfirmBodyKey(leave.kind), { name: title })}
      cancelLabel={formatMessage("timeline.channelLeave.cancel")}
      confirmLabel={formatMessage("timeline.channelLeave.confirm")}
      busyLabel={formatMessage("timeline.channelLeave.busy")}
      busy={leave.pending}
      error={leave.error}
      onConfirm={() => leave.confirm()}
    />
  );
}
