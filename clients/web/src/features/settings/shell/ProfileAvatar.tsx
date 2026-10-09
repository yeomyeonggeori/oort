import { avatarIdentity } from "@momo/core/features/workspace/avatar";
import type { RosterMember } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { useMemberAvatar } from "@/features/sidebar/useMemberAvatar";

// 크기 변형이 있는 아바타 (#3578 S2). 타임라인 행의 `Avatar`(size-8 고정,
// `avatarSize.test.ts`가 32를 못 박는다)는 건드리지 않고, 같은 `avatarIdentity`와
// `useMemberAvatar`를 써서 같은 사람을 같은 얼굴로 그린다.
//   row   32. 행 아바타와 같다(여기서는 설정의 작은 자리용).
//   hero  112. 프로필 히어로. 사람의 사진 없는 얼굴은 바닥 그라데이션 위 잉크 이니셜이고,
//         에이전트는 둥근 사각 + `agent-soft` 규칙을 그대로 지킨다.
// 장식이다(`aria-hidden`): 이름은 바로 옆 글자가 말한다.

export function ProfileAvatar({
  member,
  size = "hero",
}: {
  member: RosterMember | null;
  size?: "row" | "hero";
}) {
  const identity = avatarIdentity(
    member,
    typeof location === "undefined" ? null : location.origin
  );
  const uploaded = useMemberAvatar(identity.contentPath ?? undefined);
  const imageSrc = identity.imageUrl ?? uploaded;
  const hero = size === "hero";
  return (
    <span
      aria-hidden="true"
      data-testid="profile-avatar"
      data-avatar-kind={identity.kind}
      data-avatar-size={size}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden font-semibold",
        hero ? "avatar-hero" : "size-8 text-meta",
        identity.kind === "agent" ? (hero ? "rounded-2xl" : "rounded-sm") : "rounded-full",
        identity.kind === "agent" && "bg-agent-soft text-agent",
        identity.kind === "human" && (hero ? "canvas-gradient text-ink" : "bg-surface-hover text-ink"),
        identity.kind === "unknown" && "bg-surface-hover text-ink-muted"
      )}
    >
      {imageSrc !== null ? (
        <img
          src={imageSrc}
          alt=""
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
      ) : identity.fallback.kind === "initial" ? (
        identity.fallback.text
      ) : (
        <span className="size-2 rounded-full bg-line-strong" />
      )}
    </span>
  );
}
