import { UserRound } from "lucide-react";
import { useSession } from "@/app/session";
import {
  AVATAR_PREVIEW_ALT,
  AVATAR_PREVIEW_CAPTION,
  AVATAR_PREVIEW_UNAVAILABLE,
  approvalAvatarPreviewPath,
  profileAvatarHeadline,
} from "@momo/core/features/approvals/avatarPreview";
import type { AgentApprovalCard } from "@momo/core/features/timeline/agentCardModel";
import { useApprovalAvatarPreview } from "./useApprovalAvatarPreview";
import { useMemberAvatar } from "../sidebar/useMemberAvatar";

// =============================================================================
// `member.avatar.set` 승인 카드의 머리: 한 문장 + 제안된 사진 (#4394, ADR-0186 증보 v4)
//
// 서버 행(대상·프로필 사진·사진 출처)은 <dl> 안에 그대로 서고, 이 블록은 그 아래 버튼 바로
// 위에 선다 — 사진을 보고 곧바로 결정하는 자리다. 사진은 서버가 다시 인코딩한 것(≤512²)이고
// 에이전트가 쓴 바이트는 어디에도 없다.
//
// 사진 주인이 아닌 사람에게는 사진이 안 보이고(서버 404) 버튼도 결정되지 않는다(403). 그
// 사실을 숨기지 않고 사진 자리가 한 줄로 말한다. 클라이언트는 누가 주인인지 추측하지 않는다.
// =============================================================================
export function AvatarPreviewBlock({
  card,
  agentName,
}: {
  card: AgentApprovalCard;
  agentName: string | null;
}) {
  const { workspaceId } = useSession();
  const action = card.action;
  const preview = action?.preview ?? null;
  const path = approvalAvatarPreviewPath(workspaceId, card.approvalId, preview);
  const image = useApprovalAvatarPreview(path);
  const previous = useMemberAvatar(preview?.previousAvatarUrl ?? undefined);
  const headline = profileAvatarHeadline(action?.id, agentName);
  if (headline === null) return null;

  return (
    <div className="border-t border-line px-3 py-3" data-testid="approval-avatar-preview">
      <p className="break-keep text-body font-medium text-ink" data-testid="approval-avatar-headline">
        {headline}
      </p>
      <div className="mt-2 flex flex-wrap items-start gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-meta text-ink-muted">바꾸기 전</p>
          <span className="flex size-avatar-preview shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-pane text-ink-muted">
            {previous !== null ? (
              <img src={previous} alt="바꾸기 전 프로필 사진" referrerPolicy="no-referrer" className="size-full object-cover" />
            ) : (
              <UserRound className="size-6" aria-label={preview?.previousAvatarUrl ? "현재 사진을 불러와요" : "등록된 사진이 없어요"} />
            )}
          </span>
        </div>
        <div className="flex flex-col gap-1">
        <p className="text-meta text-ink-muted">바꾼 뒤</p>
        <span
          className="flex size-avatar-preview shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-pane text-ink-muted"
          data-testid="approval-avatar-frame"
          data-state={image.state}
        >
          {image.state === "ready" ? (
            <img
              src={image.src}
              alt={action?.id === "agent.profile.update" ? "에이전트의 프로필 사진으로 제안된 사진" : AVATAR_PREVIEW_ALT}
              referrerPolicy="no-referrer"
              className="size-full object-cover"
              data-testid="approval-avatar-image"
            />
          ) : (
            <UserRound className="size-6" aria-hidden="true" />
          )}
        </span>
        </div>
      </div>
        <p
          className="mt-2 break-keep text-meta text-ink-muted"
          data-testid="approval-avatar-caption"
        >
          {image.state === "unavailable" ?
            (action?.id === "agent.profile.update" ? "사진을 불러오지 못했어요. 다시 열어 확인해 주세요." : AVATAR_PREVIEW_UNAVAILABLE)
            : action?.id === "agent.profile.update" ? "승인하면 에이전트의 프로필 사진이 이 사진으로 바뀌어요." : AVATAR_PREVIEW_CAPTION}
        </p>
    </div>
  );
}
