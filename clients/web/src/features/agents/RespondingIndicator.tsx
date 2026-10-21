import { avatarIdentity } from "@momo/core/features/workspace/avatar";
import { cn } from "@/design/lib/cn";
import { avatarSurfaceClass } from "@/features/common/avatarTone";
import { usePrefersReducedMotion } from "@/design/hooks/usePrefersReducedMotion";
import { useMemberAvatar } from "@/features/sidebar/useMemberAvatar";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 「답하는 중」 줄의 두 조각 (#4020): 에이전트의 작은 아바타와 점.
//
// 컴포저 위 활동 줄이 에이전트가 요청을 가져가 답을 쓰는 동안 「grok이 답하는 중…」
// 이라고 말할 때 이름 앞에 얼굴, 뒤에 점이 선다. 둘 다 보조기술에는 나가지 않는다 —
// 문장이 이미 이름과 상태를 읽어 주고, 아바타와 점은 눈으로 훑는 표지다.
// 줄을 그리는 판정(`isRespondingLine`)과 낱말은 core에 있다.
// =============================================================================

/** 줄 높이에 맞춘 작은 얼굴. 메시지 행의 `Avatar`(32)와 같은 모양 규칙을 따른다. */
export function RespondingAvatar({
  directory,
  memberId,
}: {
  directory: Directory;
  memberId: string;
}) {
  const member = memberFor(directory, memberId) ?? null;
  const identity = avatarIdentity(
    member,
    typeof location === "undefined" ? null : location.origin
  );
  const uploaded = useMemberAvatar(identity.contentPath ?? undefined);
  const imageSrc = identity.imageUrl ?? uploaded;
  return (
    <span
      aria-hidden="true"
      data-testid="responding-avatar"
      data-avatar-kind={identity.kind}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center self-center overflow-hidden text-timestamp font-semibold leading-none",
        identity.kind === "agent" ? "rounded-sm" : "rounded-full",
        avatarSurfaceClass(identity.kind, member?.id, imageSrc !== null)
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
      ) : null}
    </span>
  );
}

/** 점 셋. 동작 줄이기에서는 움직이지 않고 멈춘 채 선다. */
export function RespondingDots() {
  const reduced = usePrefersReducedMotion();
  return (
    <span
      aria-hidden="true"
      data-testid="responding-dots"
      data-motion={reduced ? "still" : "full"}
      className="ml-0.5 inline-flex shrink-0 items-center gap-0.5 self-center"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={cn(
            "size-1 rounded-full bg-agent",
            reduced ? "opacity-60" : "responding-dot"
          )}
        />
      ))}
    </span>
  );
}
