import { useMemo } from "react";
import type { RosterMember } from "@momo/core/lib/api";
import { AVATAR_EDITOR_COPY } from "@momo/core/features/workspace/avatarEditor";
import { DmAvatar } from "@/features/sidebar/DmAvatar";
import { Avatar } from "@/features/timeline/MessageRow";
import { ProfileAvatar } from "../shell/ProfileAvatar";

// 실제 크기 미리보기 (#4261): 사이드바 24 · 메시지 32 · 프로필 큰 원.
//
// 손으로 그린 흉내가 아니라 **진짜 아바타 컴포넌트**(`DmAvatar`, `Avatar`, `ProfileAvatar`)에 구운 PNG 의 `data:`
// 주소를 `avatarUrl` 로 실어 보인다. 그래서 둥근 자르기, 사진 테두리(`--avatar-edge`), 크기가 앱이 실제로 그리는 그대로이고,
// 코어의 `renderableAvatarUrl` 이 통과시키는 `data:image/` 길(배포 CSP `img-src 'self' data:`)을 그대로 걷는다.
// `src` 가 없으면 지금의 내 아바타를 그대로 보인다(고른 것이 아직 없다).
//
// 장식이다(`aria-hidden`): 고르는 값은 아래 컨트롤이 글자로 말한다.

export function AvatarEditorPreview({
  me,
  src,
  nowMs,
}: {
  me: RosterMember | null;
  src: string | null;
  nowMs: number;
}) {
  const shown = useMemo<RosterMember | null>(
    () => (me === null ? null : src === null ? me : { ...me, avatarUrl: src }),
    [me, src]
  );
  return (
    <div
      aria-hidden="true"
      data-testid="avatar-editor-preview"
      data-source={src === null ? "current" : "draft"}
      className="flex items-end justify-center gap-8 rounded-lg bg-surface-muted p-3"
    >
      <figure className="m-0 flex flex-col items-center gap-2">
        <ProfileAvatar member={shown} size="hero" />
        <figcaption className="text-meta text-ink-muted">{AVATAR_EDITOR_COPY.previewSizes.profile}</figcaption>
      </figure>
      <figure className="m-0 flex flex-col items-center gap-2">
        <Avatar member={shown} />
        <figcaption className="text-meta text-ink-muted">{AVATAR_EDITOR_COPY.previewSizes.message}</figcaption>
      </figure>
      <figure className="m-0 flex flex-col items-center gap-2">
        <DmAvatar member={shown} nowMs={nowMs} viewerMayAct={false} />
        <figcaption className="text-meta text-ink-muted">{AVATAR_EDITOR_COPY.previewSizes.sidebar}</figcaption>
      </figure>
    </div>
  );
}
