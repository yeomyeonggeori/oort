import { useId, useState } from "react";
import { Check } from "lucide-react";
import {
  type EffectivePresence,
  type PresenceStatus,
  type RosterMember,
} from "@momo/core/lib/api";
import {
  declaredStatusLabel,
  PRESENCE_MENU_LABEL,
  PRESENCE_OPTIONS,
} from "@momo/core/features/presence/model";
import {
  PAUSE_UNTIL_NONE_ACTION_LABEL,
  pauseUntilLabel,
} from "@momo/core/features/presence/pauseUntil";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/design/ui/dropdown-menu";
import { InlineBanner } from "@/features/common/States";
import { cn } from "@/design/lib/cn";
import { avatarSurfaceClass } from "@/features/common/avatarTone";
import {
  memberAvatarContentPath,
  renderableAvatarUrl,
} from "@momo/core/features/workspace/avatar";
import { useMemberAvatar } from "./useMemberAvatar";
import { useSelfPresenceWrite } from "./useSelfPresenceWrite";

// =============================================================================
// Self presence (ADR-0160 ③, 프레즌스 6b). UX-D4 (#1756) moved the trigger: the
// whole bottom identity row is now the profile card, and this file owns the
// two pieces that card composes — the avatar badge (effective dot) and the
// declared-status radio group inside that card's menu.
//
// This is the DECLARED-status control (③), a separate vocabulary from the
// connection indicator (①) further along the row: that one says "am I attached",
// this says "what did I choose to appear as". ADR-0160 keeps them apart (guard
// 6), and design-review H1 is what made the separation visible rather than
// merely intended: the connection indicator is now a BAR that appears only when
// the rail is unhealthy, while this is a round badge on the avatar — the
// universally read presence spot. Two circles on one row, one of them
// permanently green, was the collision (see connStatusIndicator.ts).
//
// The badge is bound to REAL state, never decorative (SKILL §8): its color and
// accessible name always derive from the effective value `f(declared, connected)`
// — dnd wins, then away, then auto resolves to online/offline by whether this
// client is connected. Availability(②) for OTHER members rides the ephemeral
// rail and is rendered on member surfaces elsewhere; for the self chip the
// availability input is simply this client's own connection, which it already
// knows, so this control needs no realtime subscription of its own.
//
// Declared options stay auto/away/dnd (온라인 / 자리 비움 / 방해 금지). Buzz's
// Online/Away/Offline is the *effective* vocabulary; Offline is not a durable
// intent and is not offered as a radio (ADR-0160 D2/D3).
// =============================================================================

/** The badge color for an effective value. Filled for a live status, a hollow
 *  muted ring for offline (which is a real state, not missing data). */
function effectiveBadgeClass(effective: EffectivePresence): string {
  switch (effective) {
    case "online":
      return "bg-ok border-surface";
    case "away":
      return "bg-warn border-surface";
    case "dnd":
      return "bg-danger border-surface";
    case "offline":
      // No fill, a muted outline: reads as "offline", distinct from a filled dot
      // and from nothing at all.
      return "bg-surface border-line-strong";
  }
}

/** The small dot beside a declared option in the menu. `auto` shows as its
 *  online color, since online is what auto renders as. */
function optionDotClass(status: PresenceStatus): string {
  switch (status) {
    case "auto":
      return "bg-ok";
    case "away":
      return "bg-warn";
    case "dnd":
      return "bg-danger";
  }
}

export function PresenceBadge({
  selfName,
  effective,
  avatarUrl,
  memberId,
  size = "sm",
}: {
  selfName: string;
  effective: EffectivePresence;
  /** roster 가 준 내 `avatarUrl`. 없거나 못 받으면 이니셜이다. */
  avatarUrl?: string;
  /** 내 멤버 id. 사진이 없을 때 목록·타임라인과 같은 색조 채움을 고른다(#4162). */
  memberId?: string;
  /** `sm` 24px(접힘 레일), `md` 32px(목록 끝 프로필 줄, #3574). 점은 아바타와 함께 자란다. */
  size?: "sm" | "md";
}) {
  const direct = renderableAvatarUrl(
    avatarUrl,
    typeof location === "undefined" ? null : location.origin
  );
  const uploaded = useMemberAvatar(memberAvatarContentPath(avatarUrl) ?? undefined);
  const imageSrc = direct ?? uploaded;
  return (
    <span
      data-testid="presence-control"
      data-effective={effective}
      // #4162: 목록·타임라인 아바타와 같은 문법이다 - 얇은 테두리 + 멤버 id 가 고르는 색조 채움. 사이드바 바닥에
      // 녹던 DS2-6 의 옅은 채움 대신 테두리가 윤곽을 지키고, 채움·글자가 한 쌍(4.5:1)이라 띠 위에서도 읽힌다.
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full font-semibold",
        avatarSurfaceClass("human", memberId, imageSrc !== null),
        size === "md" ? "size-8 text-body" : "size-6 text-meta",
        // 이 배지는 늘 나(사람)다: 원(AVATAR_SHAPE.human). 사진을 지워 이니셜로
        // 돌아가도 모양이 바뀌지 않는다.
      )}
      aria-hidden="true"
    >
      {imageSrc !== null ? (
        // 배지 점은 이 span 에 붙어 있으므로(위 주석) 이미지는 그 안쪽 자리만 채운다.
        // 상자는 size-6 으로 고정이라 사진이 들어와도 레이아웃은 움직이지 않는다.
        <img
          src={imageSrc}
          alt=""
          referrerPolicy="no-referrer"
          className="size-full rounded-full object-cover"
          data-testid="presence-avatar-image"
        />
      ) : (
        selfName.slice(0, 1)
      )}
      {/* The presence badge. Bound to `effective`, ringed in the sidebar
          surface so it reads as a badge sitting on the avatar rather than a
          hole punched through it. Anchored to THIS span, not to the profile
          trigger: enlarging the hit area must not float the dot off the
          avatar (presence 6b H2). */}
      <span
        className={cn(
          "absolute bottom-0 right-0 rounded-full border",
          size === "md" ? "size-3" : "size-2",
          effectiveBadgeClass(effective)
        )}
      />
    </span>
  );
}

export function PresenceStatusItems({
  workspaceId,
  selfMemberId,
  selfMember,
  onWrote,
  onChooseDnd,
}: {
  workspaceId: string;
  selfMemberId: string;
  selfMember: RosterMember | null | undefined;
  /** Called after a successful durable write so the owning card can close. */
  onWrote?: () => void;
  /**
   * 방해 금지는 기한을 고르고 나서야 켜진다(ADR-0204 D2). 이 항목은 쓰지 않고 이 콜백으로
   * 기한 다이얼로그를 열게 한다. 이미 방해 금지인 때도 연다: 기한을 바꾸는 길이 이것뿐이다.
   */
  onChooseDnd: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const menuLabelId = useId();

  const declared = selfMember?.presenceStatus;
  const current: PresenceStatus = declared ?? "auto";

  // The write (optimistic paint, rollback, roster and notification-rules refresh)
  // is shared with the do-not-disturb dialog: see `useSelfPresenceWrite`.
  const mutation = useSelfPresenceWrite(workspaceId, selfMemberId);

  return (
    <>
      {/* The menu's title (이슈 #1383). The trigger is an avatar, so nothing
          in the open panel said what the three words are *about* — a person
          arriving at 온라인 / 자리 비움 / 방해 금지 had to infer the question
          from the answers. The title is the same name the trigger already
          speaks (`PRESENCE_MENU_LABEL`), and it is a real name rather than
          decoration: the radio group points back at it with
          `aria-labelledby`, the idiom `HostPicker` already uses.

          **It stands first, above the failure banner** (design-review M1). */}
      <DropdownMenuLabel id={menuLabelId}>
        {PRESENCE_MENU_LABEL}
      </DropdownMenuLabel>
      {failed && (
        <InlineBanner
          message="상태를 바꾸지 못했습니다. 다시 시도하세요."
          testId="presence-error"
        />
      )}
      {/* A single choice among three, so the rows are `menuitemradio` and the
          group's `value` is what computes `aria-checked` (design-review M1).
          Selection is still handled per-row in `onSelect` (not `onValueChange`)
          so a failed write can hold the menu open with its banner; the group's
          value is the a11y state, not a second event path. */}
      <DropdownMenuRadioGroup value={current} aria-labelledby={menuLabelId}>
        {PRESENCE_OPTIONS.map((status) => {
          const isCurrent = status === current;
          // 방해 금지가 켜져 있으면 끝나는 때를 둘째 줄에 말한다(기한 없는 행은 「기한 없음 ·
          // 기한 정하기」). 줄을 누르면 기한 다이얼로그가 열리므로 그 문장이 곧 안내다.
          const dndNote =
            status === "dnd" && isCurrent
              ? selfMember?.dndUntilMs === undefined
                ? PAUSE_UNTIL_NONE_ACTION_LABEL
                : pauseUntilLabel(selfMember.dndUntilMs, Date.now())
              : null;
          return (
            <DropdownMenuRadioItem
              key={status}
              value={status}
              data-testid={`presence-option-${status}`}
              disabled={mutation.isPending}
              className={dndNote ? "h-auto min-h-control py-1" : undefined}
              onSelect={(event) => {
                // One REST round trip; keep the menu open on failure so the
                // banner above is readable (the mute toggle's discipline).
                event.preventDefault();
                if (status === "dnd") {
                  onChooseDnd();
                  return;
                }
                if (isCurrent) {
                  onWrote?.();
                  return;
                }
                mutation.mutate(
                  { status },
                  {
                    onSuccess: () => {
                      setFailed(false);
                      onWrote?.();
                    },
                    onError: () => setFailed(true),
                  }
                );
              }}
            >
              <span
                aria-hidden="true"
                className={cn("size-2 shrink-0 rounded-full", optionDotClass(status))}
              />
              {dndNote ? (
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{declaredStatusLabel(status)}</span>
                  {/* 말줄임을 쓰지 않는다: 메뉴 폭은 192px 라 「10월 19일(월) 오전 9:00까지」(다음 주
                      월요일 항목이 만드는 라벨)가 한 줄에 못 든다. 행 높이는 가변이고, 어절 단위로
                      접어(`break-keep`) 날짜와 시각이 비슷한 길이의 두 줄이 되게 한다(`text-balance`). */}
                  <span
                    className="break-keep text-balance text-meta text-ink-muted"
                    data-testid="presence-dnd-until"
                  >
                    {dndNote}
                  </span>
                </span>
              ) : (
                <span className="flex-1">{declaredStatusLabel(status)}</span>
              )}
              {isCurrent && (
                <Check className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              )}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </>
  );
}
