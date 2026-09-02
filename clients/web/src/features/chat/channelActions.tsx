import { Fragment, useId, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import {
  removeChannelMember,
  setChannelNotificationPref,
  uuidEq,
  type Channel,
  type MembershipRole,
  type ReadState,
} from "@momo/core/lib/api";
import { composedUnreadCount } from "@momo/core/features/readState/model";
import { advertiseReadState } from "@/features/chat/advertiseReadState";
import {
  channelLeaveConfirmBody,
  channelLeaveFailureMessage,
  CHANNEL_ACTION_ERROR_GROUP_LABEL,
  CHANNEL_COPY_FAILURE,
  CHANNEL_COPY_UNAVAILABLE,
  CHANNEL_LEAVE_CONFIRM_TITLE,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_READ_FAILURE,
  CHANNEL_MUTE_FAILURE,
} from "@momo/core/features/channels/model";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/design/ui/dropdown-menu";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
} from "@/design/ui/context-menu";
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
import { SECTION_MOVE_TO_BASE_LABEL } from "@momo/core/features/sidebar/sidebarSections";
import { absoluteApiBase } from "@/lib/serverBase";
import {
  applyReadStateToCache,
  useInvalidateReadStates,
} from "@/features/workspace/useWorkspace";
import {
  channelActionAvailability,
  channelActionItemsForSurface,
  channelActionKeepsMenuOpen,
  type ChannelActionAvailability,
  type ChannelActionItem,
  type ChannelActionKey,
  type ChannelActionState,
  type ChannelActionSurface,
  type ChannelSectionChoice,
} from "./channelActionModel";

// =============================================================================
// 채널 액션 **실행부** 하나 (BT-1 / #1929).
//
// 이 파일이 있는 이유는 `channelActionModel.ts` 가 있는 이유와 같지만, 값이
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
  clearError: () => void;
  run: (key: ChannelActionKey) => void;
  /** 「섹션으로 이동」의 라디오 행이 고른 목적지. 표면이 없으면 아무 일도 없다. */
  moveToSection: (sectionId: string | null) => void;
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
  sections,
  currentSectionId = null,
  onMoveToSection,
  starred = false,
  onToggleStar,
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
  const leaveMutation = useMutation({
    mutationFn: () => removeChannelMember(workspaceId, channel.id, selfMemberId),
    onSuccess: () => {
      setLeaveError(null);
      setConfirmLeave(false);
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
    },
    onError: (mutationError) => {
      // 목록을 건드리지 않았으므로 되돌릴 것이 없다. 다이얼로그는 그대로 서
      // 있고, 그 안에서 이유를 말한다.
      setLeaveError(channelLeaveFailureMessage(mutationError));
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
      }),
    [
      channel,
      selfRole,
      readState,
      sections?.length,
      onMoveToSection,
      onToggleStar,
    ]
  );

  const state: ChannelActionState = {
    muted: channel.muted,
    copiedLink: linkCopy.copied,
    copiedName: nameCopy.copied,
    starred,
    sections,
    currentSectionId,
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
      case "star":
        // 왕복이 없다. 별표는 사이드바 payload 의 한 칸이고 저장은 디바운스가
        // 뒤따르므로(ADR-0177 D2), 여기서 기다릴 것도 되돌릴 것도 없다.
        setError(null);
        onToggleStar?.();
        return;
      case "topic":
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
    return false;
  }

  return {
    available,
    state,
    items: (surface) => channelActionItemsForSurface(surface, available, state),
    isPending,
    error,
    clearError: () => setError(null),
    run,
    moveToSection: (sectionId) => {
      setError(null);
      onMoveToSection?.(sectionId);
    },
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
 * 「섹션으로 이동」 — 제목 하나와 그 아래 라디오 행들 (ADR-0177 D4 / BT-4 #1932).
 *
 * 서브메뉴가 아닌 이유는 `channelActionModel.ts` 머리말에 있다(요약: 이 레포는
 * 서브메뉴를 이슈 번호까지 달아 금지하고, 그 문단이 대체물로 「화면에 남는 행들
 * 위의 제목」을 지정한다). 라디오인 이유는 배치가 **여럿 중 하나**라서다 -
 * 지금 속한 섹션이 `aria-checked` 로 들려야 하고, 그것은 체크 표시가 눈에
 * 말하는 것과 같은 사실이다.
 *
 * 제목은 `useId` 로 자기 id 를 갖고 그룹이 `aria-labelledby` 로 되짚는다.
 * Radix 의 Label 은 aria 를 하나도 걸어 주지 않으므로(`DropdownMenuLabel`
 * 독스트링), 이 두 줄이 없으면 무리가 스크린리더에 이름 없이 선다.
 *
 * 그릇은 **표면이 고른다** (design-review #1932 N-1). 오늘 이 무리는 행 메뉴에만
 * 서고(`SURFACE_KEYS.header` 가 이 열쇠를 주지 않는다) 그래서 컨텍스트 메뉴를
 * 하드코딩해도 안전했다. 그런데 이 파일의 형제 컴포넌트는 전부 `surface` 로 갈라
 * 그릇을 고르고, `channelActionModel.ts` 는 확장점을 「열쇠 하나·분기 하나·
 * SURFACE_KEYS 항목 하나」라고 광고한다. 그 한 줄을 믿고 헤더에 이 열쇠를 넣는
 * 사람은 Radix 루트 없는 컨텍스트 메뉴 조각을 렌더하게 된다 - 광고한 확장점이
 * 실제로 그만큼만 드는 것이 이 분기의 값이다.
 */
function ChannelSectionMoveGroup({
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
  const labelId = useId();
  const choices = item.sections ?? [];
  // 값은 문자열이어야 한다(Radix RadioGroup). 기본 섹션의 `null` 은 채널 id 가
  // 될 수 없는 낱말 하나로 적는다 - 커스텀 섹션 id 는 `sec-<수>` 꼴이라 절대
  // 겹치지 않는다.
  const BASE = "\u0000base";
  const current = item.currentSectionId ?? BASE;
  const Label = surface === "header" ? DropdownMenuLabel : ContextMenuLabel;
  const RadioGroup =
    surface === "header" ? DropdownMenuRadioGroup : ContextMenuRadioGroup;
  const RadioItem =
    surface === "header" ? DropdownMenuRadioItem : ContextMenuRadioItem;
  return (
    <>
      <Label id={labelId} data-testid={`${prefix}-${item.testKey}`}>
        {item.label}
      </Label>
      <RadioGroup
        aria-labelledby={labelId}
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
                {/* 긴 한글 섹션 이름(최대 80자)이 메뉴를 창 밖으로 밀지 않는다.
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
                    같은 아이콘·같은 잉크로 그린다. */}
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
    </>
  );
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
  const busy = actions.isPending(item.key);
  const props = {
    "data-testid": `${prefix}-${item.testKey}`,
    "data-muted":
      item.key === "mute" && actions.state.muted ? "" : undefined,
    tone: item.tone,
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
    children: busy ? item.busyLabel ?? item.label : item.label,
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
          있어야 읽히므로, 아래 항목들은 왕복 중에 메뉴를 닫지 않는다.

          `role="group"` 으로 한 겹 감싼다 (design-review #1937 N-5): `menu` 의
          직계 자식은 menuitem/group/separator 여야 하는데 `InlineBanner` 는
          `role="alert"` 이라 그 목록에 없다. `group` 은 목록에 있고 라이브
          리전은 그 안에서 그대로 읽히므로, 문장을 잃지 않고 구조만 맞춘다.
          Radix 의 항목 수집은 `[data-radix-collection-item]` 기준이라 화살표
          순회는 이 상자를 그냥 지나간다.

          `px-2`: 배너의 기본 `px-4` 는 메뉴 행(`px-2`)과 다른 축이라 첫 글자가
          8px 오른쪽으로 밀려 섰다(실측 21px 대 13px, N-3). 같은 왼쪽 자를 쓴다. */}
      {actions.error && (
        <div role="group" aria-label={CHANNEL_ACTION_ERROR_GROUP_LABEL}>
          <InlineBanner
            className="px-2"
            message={actions.error}
            testId={`${prefix}-action-error`}
          />
        </div>
      )}
      {actions.items(surface).map((item) => (
        <Fragment key={item.key}>
          {item.separatorBefore && <Separator />}
          {item.sections ? (
            <ChannelSectionMoveGroup
              surface={surface}
              prefix={prefix}
              item={item}
              actions={actions}
              onHandOff={onHandOff}
            />
          ) : (
            <ChannelActionMenuRow
              surface={surface}
              prefix={prefix}
              item={item}
              actions={actions}
              onHandOff={onHandOff}
            />
          )}
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
