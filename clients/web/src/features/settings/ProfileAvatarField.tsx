import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { removeMyAvatar } from "@momo/core/lib/api";
import type { RosterMember } from "@momo/core/lib/api";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { primeMemberAvatar } from "@/features/sidebar/useMemberAvatar";
import {
  memberAvatarPickError,
  memberAvatarRemoveError,
  memberAvatarUploadError,
} from "./memberAvatarCopy";
import { uploadMyAvatar } from "./uploadMyAvatar";

// 내 프로필 사진: 고르고, 올리고, 지운다(#3277, ADR-0161 증보 2026-10-01).
//
// 진행은 잠금이 아니다(#1486 문법): 버튼은 `aria-busy` 와 바뀐 낱말로 진행을 말하고
// native `disabled` 로 초점을 떨구지 않는다. 버튼 폭은 진행 낱말에서도 같아야 한다
// (min-w) — 프로필 줄이 올리는 동안 흔들리면 안 된다(#3276).
// 성공하면 로스터를 다시 받는다 — 그 한 번의 쓰기로 사이드바·멤버 목록·메시지의
// 내 아바타가 함께 바뀐다. 새 주소의 캐시는 방금 올린 파일로 미리 채운다.

export function ProfileAvatarField({
  workspaceId,
  me,
  offline,
}: {
  workspaceId: string;
  me: RosterMember | null;
  offline: boolean;
}) {
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refreshRoster = () =>
    client.invalidateQueries({ queryKey: ["roster", workspaceId] });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      setProgress(0);
      const media = await uploadMyAvatar(workspaceId, file, setProgress);
      await primeMemberAvatar(media.avatarUrl, file).catch(() => undefined);
    },
    onSuccess: refreshRoster,
    onError: (failure) => setError(memberAvatarUploadError(failure)),
  });

  const remove = useMutation({
    mutationFn: () => removeMyAvatar(workspaceId),
    onSuccess: refreshRoster,
    onError: () => setError(memberAvatarRemoveError()),
  });

  const uploading = upload.isPending;
  const removing = remove.isPending;
  const busy = uploading || removing;
  const hasAvatar = Boolean(me?.avatarUrl);

  function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // 같은 파일을 다시 골라도 change 가 다시 뜨게.
    setError(null);
    if (!file || busy || offline) return;
    const problem = memberAvatarPickError(file);
    if (problem) {
      setError(problem);
      return;
    }
    upload.mutate(file);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="profile-avatar-field">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={offline || removing || undefined}
          aria-busy={uploading || undefined}
          className={cn("min-w-28 tabular-nums", (offline || removing) && "opacity-50")}
          onClick={() => {
            if (offline || busy) return;
            inputRef.current?.click();
          }}
          data-testid="profile-avatar-change"
        >
          {uploading && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {uploading
            ? progress > 0
              ? `올리는 중 ${Math.round(progress * 100)}%`
              : "올리는 중"
            : hasAvatar
              ? "사진 바꾸기"
              : "사진 올리기"}
        </Button>
        {hasAvatar ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-disabled={offline || uploading || undefined}
            aria-busy={removing || undefined}
            className={cn("min-w-20", (offline || uploading) && "opacity-50")}
            onClick={() => {
              if (offline || busy) return;
              setError(null);
              remove.mutate();
            }}
            data-testid="profile-avatar-remove"
          >
            {removing && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {removing ? "지우는 중" : "사진 지우기"}
          </Button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="sr-only"
          onChange={onPick}
          data-testid="profile-avatar-input"
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
      <p className="text-meta text-ink-muted">
        PNG, JPG, GIF, WebP. 5MB까지 올릴 수 있어요.
      </p>
      {error ? (
        <p
          className="text-meta text-danger"
          role="alert"
          data-testid="profile-avatar-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

