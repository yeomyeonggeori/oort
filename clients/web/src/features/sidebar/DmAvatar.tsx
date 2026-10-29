import { User } from "lucide-react";
import { avatarIdentity } from "@momo/core/features/workspace/avatar";
import { statusDotTooltip } from "@momo/core/features/presence/statusDot";
import type { RosterMember } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { STATUS_DOT_BADGE_CLASS } from "@/design/statusDot";
import { avatarSurfaceClass } from "@/features/common/avatarTone";
import { useDmStatusDot } from "./useDmStatusDot";
import { useMemberAvatar } from "./useMemberAvatar";

// 사이드바 DM 행의 상대 아바타 (#3662). 행의 아이콘 자리(18px)보다 조금 큰 24px 판이다 — 타임라인의
// `Avatar`(32px)와 같은 정체 문법(사람 원 · 에이전트 둥근 사각 + agent 토큰, 사진이 없거나
// 받는 중이면 이니셜)을 쓰되 크기만 다르다. 이 상자는 고정 크기라 사진이 들어와도 행이
// 움직이지 않는다.
//
// 상태 점 (#3964): 사람은 스스로 정한 자리 비움·방해 금지가 먼저이고 그 밖에는 서버가 명부에 실은 접속 여부(#4692)를,
// 에이전트는 서버의 생존 판정을 점 색으로 말한다
// (`useDmStatusDot` → 코어 `dmPeerStatusDot`). 글자 라벨(「꺼짐」)은 행에서 뺐다: 낱말은 툴팁(이 상자의
// `title`)과 행의 숨은 글(`DmStatusText`)이 말한다. **모르면 점이 없다** - 근거 없는 초록 점 금지.
//
// 상대를 아바타로 알아볼 수 없는 행(「나간 멤버」: 명부에서 빠진 상대)은 점 하나가 아니라 **기본 아바타**(사람
// 윤곽)를 그린다. 모를 때 이니셜을 지어내지 않는다는 코어의 규칙(`avatar.ts`)은 그대로이고, 이니셜이
// 아닌 것이 서는 자리가 빈 원이 아니게 할 뿐이다.
export function DmAvatar({
  member,
  nowMs,
  viewerMayAct,
}: {
  member: RosterMember | null;
  nowMs: number;
  /** 보는 사람이 생존 경고에 할 수 있는 일이 있는가(owner/admin). 경고색은 그 사람에게만 경고다. */
  viewerMayAct: boolean;
}) {
  const identity = avatarIdentity(
    member,
    typeof location === "undefined" ? null : location.origin
  );
  const uploaded = useMemberAvatar(identity.contentPath ?? undefined);
  const imageSrc = identity.imageUrl ?? uploaded;
  const dot = useDmStatusDot(member, viewerMayAct, nowMs);
  return (
    <span
      className="relative flex size-6 shrink-0"
      data-testid="dm-avatar"
      data-avatar-kind={identity.kind}
      data-status-tone={dot?.tone}
      title={dot ? statusDotTooltip(dot) : undefined}
    >
      <span
        className={cn(
          "flex size-6 items-center justify-center overflow-hidden text-meta font-semibold",
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
            data-testid="dm-avatar-image"
          />
        ) : identity.fallback.kind === "initial" ? (
          identity.fallback.text
        ) : (
          <User
            className="size-4"
            aria-hidden="true"
            data-testid="dm-avatar-default"
          />
        )}
      </span>
      {dot ? (
        <span
          data-testid="dm-peer-dot"
          data-tone={dot.tone}
          className={cn(
            "absolute bottom-0 right-0 size-2 rounded-full border",
            STATUS_DOT_BADGE_CLASS[dot.tone]
          )}
        />
      ) : null}
    </span>
  );
}

/**
 * 행의 링크가 읽는 **숨은 글**: 상태 점이 눈에 보이는 말을 대신하므로(글자 라벨은 행에서 뺐다) 접근 가능한 이름이 그
 * 사실을 이어서 말한다. 쉼표로 이어 `이도현, 자리 비움` 꼴이다(행의 `이름, 뜻` 이름 꼴과 같다). 점과 같은 훅을 읽는다.
 */
export function DmStatusText({
  member,
  mayAct,
  nowMs,
}: {
  member: RosterMember | null;
  mayAct: boolean;
  nowMs: number;
}) {
  const dot = useDmStatusDot(member, mayAct, nowMs);
  return dot ? <span className="sr-only">{`, ${dot.label}`}</span> : null;
}
