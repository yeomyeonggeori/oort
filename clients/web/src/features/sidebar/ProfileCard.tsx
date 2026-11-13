import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Copy,
  DoorOpen,
  LogOut,
  Plus,
  Settings,
  SlidersHorizontal,
  Smile,
} from "lucide-react";
import { effectivePresence, type RosterMember } from "@momo/core/lib/api";
import { CUSTOM_STATUS_MENU_LABEL } from "@momo/core/features/presence/customStatus";
import { presenceTriggerLabel } from "@momo/core/features/presence/model";
import { useSession } from "@/app/session";
import { useOpenAddWorkspace } from "@/features/workspace/useAddWorkspace";
import { rememberSettingsOpener } from "@/features/settings/settingsFocus";
import { useRecheckWhenElapsed } from "@/features/settings/useRecheckWhenElapsed";
import { LeaveWorkspaceDialog } from "@/features/settings/LeaveWorkspaceDialog";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { absoluteApiBase } from "@/lib/serverBase";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { CustomStatusMark } from "./CustomStatusMark";
import {
  PresenceBadge,
  PresenceStatusItems,
} from "./PresenceControl";
import { PresenceDndDialog } from "./PresenceDndDialog";
import { SetStatusDialog } from "./SetStatusDialog";
import { useCustomStatusView } from "./useCustomStatusView";

// =============================================================================
// Bottom identity card (UX-D4 #1756, buzz 36; #3574 Buzz-style foot). The trigger is
// the identity cluster (avatar + name + status line). `tap-target` grows that button
// to the row under 600px; the help button sits outside it. #3574: the card is the
// natural last row of the list column (same `sidebar-row` inset, no band, no rule),
// and only while the list column is folded (⌘B) does it shrink to the avatar alone
// in the rail. The open panel is
// a DropdownMenu (not a submenu, house rule #1383): declared status radios,
// then custom status (#1889, a second axis, not a replacement), then the
// real workspace verb that already lives on the rail (+), then settings,
// then logout (#1858). The card rewires AccountSection's existing verb; it
// does not invent a second session path.
//
// Invented surfaces stay off this card:
//   * workspace session swap (ADR-0161 4b-3) has not landed. The rail's [+]
//     adds a workspace; this item rewires that same opener. A second
//     switcher here would duplicate a surface that does not exist.
//   * product feedback (buzz Send-feedback class) has no surface.
//
// The panel is portaled and anchored to THIS trigger. It opens upward from the
// identity row, which sits *below* the channel-list scroller, so the collision
// boundary is the viewport (Radix default) rather than that list — flipping
// against the list would pin the card inside a box the trigger is not in.
//
// #5785 (QA 14 1단, Buzz의 프로필 메뉴): 내 상태 → **워크스페이스 이름**(머리글) 아래 펼친 줄
// 「서버 주소 복사」 · 「워크스페이스 설정」 · 「워크스페이스 나가기」(위험색, 확인 창) · 「워크스페이스 추가」.
// 하위 메뉴가 아니라 머리글 + 보이는 줄이다(#1383, 하위 메뉴 부품은 따로 들어오는 중). 머리글은 자기 id를
// 갖고 줄 묶음이 `aria-labelledby`로 되짚는다(`DropdownMenuLabel` 머리말).
//   * 서버 주소 복사는 이 기기가 붙은 서버 주소(`absoluteApiBase`)다. 로그인 화면의 첫 칸이 그 글을 그대로
//     받는다. 워크스페이스 ID는 싣지 않는다: 로그인 화면의 그 칸이 ID를 읽지 않고, 클라이언트는 지금
//     워크스페이스가 서버의 기본 워크스페이스인지 모른다. 메뉴는 열린 채 줄 글이 「주소 복사됨」으로 바뀐다
//     (채널 메뉴의 복사 줄과 같은 문법, 토스트 없음).
//   * 아이콘은 README §2.8의 정본 낱말을 따른다(복사 = `Copy`). 나가기는 `DoorOpen`이다: 같은 메뉴 두 줄
//     아래 「로그아웃」이 `LogOut`이라, 두 다른 행동이 같은 글리프를 쓰지 않게 한다.
// =============================================================================

export function ProfileCard({
  workspaceId,
  selfMemberId,
  selfMember,
  selfName,
  connected,
  workspaceName,
  compact = false,
}: {
  workspaceId: string;
  selfMemberId: string;
  selfMember: RosterMember | null | undefined;
  selfName: string;
  connected: boolean;
  /**
   * 둘째 줄의 기본값(#3574). 상태 메시지가 없을 때 이 워크스페이스 이름이 선다. 이름이 아직
   * 오지 않았으면(없음) 줄을 그리지 않는다: 근처의 아무 글자로 대신하지 않는다.
   */
  workspaceName?: string;
  /**
   * 작업 탭 레일(#2854, 시안 ① `.rail`의 아바타)에서는 이름 없이 아바타만 선다.
   * 메뉴는 같다. 이름은 단추의 접근 이름과 툴팁이 말한다.
   */
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const formatMessage = useFormatMessage();
  const { logout } = useSession();
  const openAddWorkspace = useOpenAddWorkspace();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingWorkspaceRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [setStatusOpen, setSetStatusOpen] = useState(false);
  const [dndOpen, setDndOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const workspaceHeadId = useId();
  const copyNoteId = useId();
  const addressCopy = useClipboardCopy(absoluteApiBase());
  const addressLabel = copyFailed
    ? formatMessage("workspace.menu.copyFailed")
    : addressCopy.copied
      ? formatMessage("workspace.menu.copiedAddress")
      : formatMessage("workspace.menu.copyAddress");
  // 방해 금지의 기한이 지나면 서버에 다시 묻는다(아바타 점·메뉴가 서버의 새 답을 그린다, #2899 H3).
  useRecheckWhenElapsed(workspaceId, selfMember?.dndUntilMs);
  const effective = effectivePresence(selfMember?.presenceStatus, connected);
  const { visible: custom, accessible: customName } =
    useCustomStatusView(selfMember);
  const triggerName = customName
    ? `${selfName}. ${presenceTriggerLabel(effective)}. ${customName}`
    : `${selfName}. ${presenceTriggerLabel(effective)}`;
  const statusHead = custom
    ? [custom.emoji, custom.text].filter(Boolean).join(" ")
    : null;

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          // 다시 열 때 앞의 복사 실패 글이 남지 않는다.
          if (next) setCopyFailed(false);
          setOpen(next);
        }}
      >
        <DropdownMenuTrigger asChild>
          {/* #3276: no `press` here. `.press:active` is `scale(0.98)`, and on a
              row that holds an avatar, a name and a status emoji it shrank the
              whole identity cluster by up to 4px on every click (measured with
              scripts/capture-profile-jitter.mjs: hover, focus ring, menu open
              and close are all 0px; the press is the only mover). The pressed
              state is a fill (`press-instant-fill`), never geometry.
              `tap-target` (44px under 600px) is the whole row now: the old
              24×24 avatar-only hit sat next to a 44px gear (6b H2). The avatar
              is 32px in the list-end row (24px in the rail); the badge stays on that span. */}
          <button
            ref={triggerRef}
            type="button"
            data-testid="profile-card"
            aria-label={triggerName}
            title={triggerName}
            className={
              compact
                ? "flex size-rail-tile shrink-0 items-center justify-center rounded-md press-instant-fill hover:bg-surface-hover focus-visible:focus-ring"
                : "sidebar-row tap-target min-w-0 flex-1 py-2 text-left press-instant-fill hover:bg-surface-hover data-[state=open]:bg-surface-hover focus-visible:focus-ring"
            }
          >
            <PresenceBadge
              selfName={selfName}
              effective={effective}
              avatarUrl={selfMember?.avatarUrl}
              memberId={selfMember?.id}
              size={compact ? "sm" : "md"}
            />
            <span className={compact ? "hidden" : "flex min-w-0 flex-1 flex-col"}>
              <span className="truncate font-semibold" data-testid="self-name">
                {selfName}
              </span>
              {/* 둘째 줄: 상태 메시지(이모지+글)가 있으면 그것, 없으면 워크스페이스 이름. */}
              {custom ? (
                <CustomStatusMark
                  status={custom}
                  className="text-meta text-ink-muted"
                />
              ) : workspaceName ? (
                <span
                  className="truncate text-meta text-ink-muted"
                  data-testid="self-subline"
                >
                  {workspaceName}
                </span>
              ) : null}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={8}
          data-testid="profile-card-menu"
          // Menu measure is the menu's (pane-sm), not the user's status
          // sentence. Without a cap the head's wrap never fires and an
          // 80-char status pushes the panel past a 390 viewport (#1889 R2-B1).
          // #5785: 워크스페이스 줄 넷이 더해져 메뉴가 길어졌다. 낮은 창(200% 확대 640×400)에서 위쪽
          // 「내 상태」가 창 밖으로 잘리던 것을 판 안 스크롤로 받는다(컨텍스트 메뉴와 같은 유틸, #3963).
          className="max-w-pane-sm max-h-menu-available overscroll-contain scrollbar-visible"
          onCloseAutoFocus={(event) => {
            // The add-workspace item hands the next layer a dialog. If this
            // menu yanks focus back to the card, Esc lands on the trigger and
            // the form stays up (H-2).
            if (openingWorkspaceRef.current) {
              event.preventDefault();
              openingWorkspaceRef.current = false;
            }
          }}
        >
          {statusHead ? (
            <DropdownMenuLabel
              data-testid="profile-card-status-head"
              className="max-w-full min-w-0 break-words whitespace-normal font-normal"
            >
              {statusHead}
            </DropdownMenuLabel>
          ) : null}
          <PresenceStatusItems
            workspaceId={workspaceId}
            selfMemberId={selfMemberId}
            selfMember={selfMember}
            onWrote={() => setOpen(false)}
            onChooseDnd={() => {
              // 방해 금지는 기한을 고르고 나서야 켜진다(ADR-0204 D2): 메뉴를 닫고
              // 기한 다이얼로그에 넘긴다. 쓰기는 거기서 한 번 난다.
              setOpen(false);
              setDndOpen(true);
            }}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="profile-set-status"
            onSelect={() => setSetStatusOpen(true)}
          >
            <Smile className="size-4" aria-hidden="true" />
            {CUSTOM_STATUS_MENU_LABEL}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Title over visible rows, not a submenu (#1383). The title is this
              workspace's own name (Buzz: the community name heads its rows);
              switching workspaces is accrued (ADR-0161 4b-3). */}
          <DropdownMenuLabel
            id={workspaceHeadId}
            data-testid="profile-workspace-head"
            className="max-w-full min-w-0 break-keep [overflow-wrap:anywhere] whitespace-normal"
          >
            {workspaceName ?? formatMessage("workspace.menu.fallbackTitle")}
          </DropdownMenuLabel>
          <DropdownMenuGroup aria-labelledby={workspaceHeadId}>
            <DropdownMenuItem
              data-testid="profile-copy-address"
              aria-describedby={copyNoteId}
              onSelect={(event) => {
                // 메뉴를 열어 둔 채 줄 글이 결과를 말한다(복사됨 / 복사하지 못했어요).
                event.preventDefault();
                setCopyFailed(false);
                void addressCopy.copy().then((ok) => {
                  if (!ok) setCopyFailed(true);
                });
              }}
            >
              <Copy className="size-4" aria-hidden="true" />
              {addressLabel}
            </DropdownMenuItem>
            {/* 서버 주소만으로는 같은 서버의 기본이 아닌 워크스페이스에 못 들어온다(로그인 화면이 따로 ID를 받는다,
                `loginWorkspaceEntry.ts`). 클라이언트는 지금 워크스페이스가 기본인지 몰라서 늘 말한다.
                줄이 아니라 줄 아래 글이다: 초점도 선택도 받지 않고, 글자 시작은 아이콘 줄과 같은 세로 줄(pl-8)이다. */}
            <p
              id={copyNoteId}
              className="select-none break-keep pb-1 pl-8 pr-2 text-meta text-ink-muted"
              data-testid="profile-copy-address-note"
            >
              {formatMessage("workspace.menu.copyAddressNote")}
            </p>
            <DropdownMenuItem
              data-testid="profile-workspace-settings"
              onSelect={() => {
                rememberSettingsOpener(
                  triggerRef.current ??
                    document.querySelector<HTMLElement>(
                      '[data-testid="profile-card"]'
                    )
                );
                navigate("/settings?section=workspace");
              }}
            >
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              {formatMessage("workspace.menu.settings")}
            </DropdownMenuItem>
            <DropdownMenuItem
              tone="danger"
              data-testid="profile-leave-workspace"
              onSelect={(event) => {
                // 파괴적 액션은 한 번의 무방비 클릭으로 발화하지 않는다(§6). 로그아웃과 같은 자리:
                // 메뉴를 닫고 확인 창으로 넘긴다.
                event.preventDefault();
                setOpen(false);
                setLeaveOpen(true);
              }}
            >
              <DoorOpen className="size-4" aria-hidden="true" />
              {formatMessage("workspace.menu.leave")}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="profile-add-workspace"
              onSelect={() => {
                openingWorkspaceRef.current = true;
                const trigger =
                  triggerRef.current ??
                  document.querySelector<HTMLElement>('[data-testid="profile-card"]');
                openAddWorkspace(trigger);
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              {formatMessage("workspace.add.title")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="nav-settings"
            title="설정 (⌘,)"
            onSelect={() => {
              rememberSettingsOpener(
                triggerRef.current ??
                  document.querySelector<HTMLElement>(
                    '[data-testid="profile-card"]'
                  )
              );
              navigate("/settings");
            }}
          >
            <Settings className="size-4" aria-hidden="true" />
            설정
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            tone="danger"
            data-testid="profile-logout"
            onSelect={(event) => {
              // 파괴적 액션은 한 번의 무방비 클릭으로 발화하지 않는다(§6).
              // 메뉴를 닫고 확인 다이얼로그로 넘긴다. 채널 나가기와 같은 자리.
              event.preventDefault();
              setOpen(false);
              setConfirmLogout(true);
            }}
          >
            <LogOut className="size-4" aria-hidden="true" />
            로그아웃
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PresenceDndDialog
        open={dndOpen}
        onOpenChange={setDndOpen}
        workspaceId={workspaceId}
        selfMemberId={selfMemberId}
        selfMember={selfMember}
        opener={triggerRef.current}
      />

      <LeaveWorkspaceDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        opener={triggerRef.current}
      />

      <SetStatusDialog
        open={setStatusOpen}
        onOpenChange={setSetStatusOpen}
        workspaceId={workspaceId}
        selfMemberId={selfMemberId}
        selfMember={selfMember}
        opener={triggerRef.current}
      />

      <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <DialogContent
          opener={triggerRef.current}
          className="gap-4 p-4"
          data-testid="profile-logout-confirm"
        >
            <div className="flex flex-col gap-1">
              <DialogTitle>로그아웃할까요?</DialogTitle>
              <DialogDescription>
                로그아웃하면 이 기기에 쓰다 만 초안이 지워집니다.
              </DialogDescription>
            </div>
            {/* 표준 테두리 버튼, 후행 정렬, 기본(파괴) 액션이 마지막(§8). */}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmLogout(false)}
                data-testid="profile-logout-cancel"
              >
                취소
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => logout()}
                data-testid="profile-logout-confirm-action"
              >
                로그아웃
              </Button>
            </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
