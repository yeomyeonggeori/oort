import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Plus, Settings, Smile } from "lucide-react";
import { effectivePresence, type RosterMember } from "@momo/core/lib/api";
import { CUSTOM_STATUS_MENU_LABEL } from "@momo/core/features/presence/customStatus";
import { presenceTriggerLabel } from "@momo/core/features/presence/model";
import { useSession } from "@/app/session";
import { useOpenAddWorkspace } from "@/features/workspace/useAddWorkspace";
import { rememberSettingsOpener } from "@/features/settings/settingsFocus";
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
  const { logout } = useSession();
  const openAddWorkspace = useOpenAddWorkspace();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingWorkspaceRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [setStatusOpen, setSetStatusOpen] = useState(false);
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
      <DropdownMenu open={open} onOpenChange={setOpen}>
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
          className="max-w-pane-sm"
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
          {/* Title over a visible row, not a submenu (#1383). The one real
              verb is the rail's 추가; switching workspaces is accrued. */}
          <DropdownMenuLabel>워크스페이스</DropdownMenuLabel>
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
            워크스페이스 추가
          </DropdownMenuItem>
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
