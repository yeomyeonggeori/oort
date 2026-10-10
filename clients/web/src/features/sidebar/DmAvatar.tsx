import { avatarIdentity } from "@momo/core/features/workspace/avatar";
import type { RosterMember } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { PEER_DOT_LABEL, peerDot } from "@/features/directory/newDmModel";
import { useMemberAvatar } from "./useMemberAvatar";

// 사이드바 DM 행의 상대 아바타 (#3662). 행의 아이콘 자리(18px)에 맞춘 20px 판이다 — 타임라인의
// `Avatar`(32px)와 같은 정체 문법(사람 원 · 에이전트 둥근 사각 + agent 토큰, 사진이 없거나
// 받는 중이면 이니셜)을 쓰되 크기만 다르다. 이 상자는 고정 크기라 사진이 들어와도 행이
// 움직이지 않는다. 상태 점은 `peerDot`이 아는 것만 그린다(근거 없는 초록 점 금지).
export function DmAvatar({
  member,
  nowMs,
}: {
  member: RosterMember | null;
  nowMs: number;
}) {
  const identity = avatarIdentity(
    member,
    typeof location === "undefined" ? null : location.origin
  );
  const uploaded = useMemberAvatar(identity.contentPath ?? undefined);
  const imageSrc = identity.imageUrl ?? uploaded;
  const dot = peerDot(member, nowMs);
  return (
    <span
      className="relative flex size-5 shrink-0"
      data-testid="dm-avatar"
      data-avatar-kind={identity.kind}
      data-peer-dot={dot ?? undefined}
    >
      <span
        className={cn(
          "flex size-5 items-center justify-center overflow-hidden text-meta font-semibold",
          identity.kind === "agent" ? "rounded-sm" : "rounded-full",
          identity.kind === "agent" && "bg-agent-soft text-agent",
          identity.kind === "human" && "bg-surface-hover text-ink",
          identity.kind === "unknown" && "bg-surface-hover text-ink-muted"
        )}
      >
        {imageSrc !== null ? (
          <img
            src={imageSrc}
            alt=""
            referrerPolicy="no-referrer"
            className="size-full object-cover"
            data-testid="dm-avatar-image"
          />
        ) : identity.fallback.kind === "initial" ? (
          identity.fallback.text
        ) : (
          <span className="size-1.5 rounded-full bg-line-strong" />
        )}
      </span>
      {dot ? (
        <span
          title={PEER_DOT_LABEL[dot]}
          data-testid="dm-peer-dot"
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-surface",
            dot === "online" && "bg-ok",
            dot === "away" && "bg-warn",
            dot === "dnd" && "bg-danger"
          )}
        />
      ) : null}
    </span>
  );
}
