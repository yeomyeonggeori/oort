import { avatarIdentity } from "@momo/core/features/workspace/avatar";
import type { RosterMember } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { avatarSurfaceClass } from "@/features/common/avatarTone";
import { useMemberAvatar } from "@/features/sidebar/useMemberAvatar";

// 사람과 에이전트를 같은 문법으로 그리는 크기 가변 아바타 (#3821).
//
// 타임라인의 `Avatar`(32)와 사이드바 `DmAvatar`(24)가 쓰는 정체 문법을 그대로 따른다:
// 사람은 원, 에이전트는 둥근 사각 + agent 토큰, 사진이 없거나 받는 중이면 이니셜,
// 명부에 없으면 글자 없이 자리만 지킨다. 크기만 목록 밀도에 맞춰 고른다.
//   · sm 24: 멘션 목록처럼 촘촘한 줄
//   · md 32: 목록 행(에이전트 목록 등), 타임라인 아바타와 같다
//   · lg 40: 프로필 카드
// 상자는 고정 크기라 사진이 들어와도 행이 움직이지 않는다. 장식이므로 `aria-hidden`이고
// 이름은 바로 옆 글자가 말한다.
const SIZE_CLASS = {
  sm: "size-6 text-meta",
  md: "size-8 text-meta",
  lg: "size-control-lg text-label",
} as const;

export type MemberAvatarSize = keyof typeof SIZE_CLASS;

export function MemberAvatar({
  member,
  size = "md",
  className,
}: {
  member: RosterMember | null;
  size?: MemberAvatarSize;
  className?: string;
}) {
  const identity = avatarIdentity(
    member,
    typeof location === "undefined" ? null : location.origin
  );
  const uploaded = useMemberAvatar(identity.contentPath ?? undefined);
  const imageSrc = identity.imageUrl ?? uploaded;
  return (
    <span
      aria-hidden="true"
      data-testid="member-avatar"
      data-avatar-kind={identity.kind}
      data-avatar-size={size}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden font-semibold",
        SIZE_CLASS[size],
        identity.kind === "agent" ? "rounded-sm" : "rounded-full",
        avatarSurfaceClass(identity.kind, member?.id, imageSrc !== null),
        className
      )}
    >
      {imageSrc !== null ? (
        <img
          src={imageSrc}
          alt=""
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          data-testid="member-avatar-image"
        />
      ) : identity.fallback.kind === "initial" ? (
        identity.fallback.text
      ) : (
        <span className="size-2 rounded-full bg-line-strong" />
      )}
    </span>
  );
}
