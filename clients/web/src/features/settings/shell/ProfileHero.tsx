import { useRef } from "react";
import { Camera } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { Card } from "@/design/ui/card";
import { ProfileAvatarField } from "../ProfileAvatarField";
import { ProfileAvatar } from "./ProfileAvatar";

// 프로필 히어로 (#3578 S2): 큰 아바타 + 이름·핸들·역할 + 사진 올리기·지우기. 업로드·삭제
// 논리는 `ProfileAvatarField`가 그대로 지고(#3277), 여기는 그 위의 얼굴과 자리만 정한다.
// 아바타 우하단 둥근 카메라 단추는 같은 파일 입력을 여는 **포인터용 손잡이**다. 키보드·
// 보조기술은 옆의 「사진 올리기」 단추(같은 일을 하는 진짜 단추)로 가므로 이 손잡이는
// 탭 순서와 접근성 트리에서 뺀다(같은 동작이 두 번 읽히지 않게).

const ROLE_LABEL: Record<string, string> = {
  owner: "소유자",
  admin: "관리자",
  member: "멤버",
  guest: "게스트",
};

export function ProfileHero({
  workspaceId,
  me,
  name,
  handle,
  offline,
}: {
  workspaceId: string;
  me: RosterMember | null;
  name: string;
  handle: string;
  offline: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const role = me?.role ? ROLE_LABEL[me.role] : undefined;
  return (
    <Card className="@container p-6" data-testid="profile-hero">
     <div className="flex min-w-0 flex-col items-center gap-6 text-center @sm:flex-row @sm:text-start">
      <div className="relative shrink-0">
        <ProfileAvatar member={me} size="hero" />
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          disabled={offline}
          onClick={() => inputRef.current?.click()}
          data-testid="profile-hero-camera"
          className="press absolute bottom-0 end-0 flex size-icon-button items-center justify-center rounded-full bg-primary text-on-primary ring-2 ring-surface-raised hover:opacity-90 disabled:opacity-50"
        >
          <Camera aria-hidden className="size-4" />
        </button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-center gap-3 @sm:items-start">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="min-w-0 break-keep text-display font-bold text-ink"
            data-testid="profile-hero-name"
          >
            {name}
          </p>
          <p className="min-w-0 break-all text-body text-ink-muted" data-testid="profile-hero-handle">
            @{handle}
            {role ? (
              <span
                className="ms-2 inline-flex rounded-full bg-surface-muted px-2 py-px text-meta text-ink-muted"
                data-testid="profile-hero-role"
              >
                {role}
              </span>
            ) : null}
          </p>
        </div>
        <ProfileAvatarField
          workspaceId={workspaceId}
          me={me}
          offline={offline}
          inputRef={inputRef}
        />
      </div>
     </div>
    </Card>
  );
}
