import { useId, useRef, useState } from "react";
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
import { ConfirmButton } from "./SettingsFields";
import { uploadMyAvatar } from "./uploadMyAvatar";

// 내 프로필 사진: 고르고, 올리고, 지운다(#3277, ADR-0161 증보 2026-10-01).
//
// 진행은 잠금이 아니다(#1486 문법): 버튼은 `aria-busy` 와 바뀐 낱말로 진행을 말하고
// native `disabled` 로 초점을 떨구지 않는다. 버튼 폭은 모든 상태에서 같다
// (`min-w-avatar-action`, 이름 붙은 폭 — 닫힌 spacing 스케일은 `min-w-28` 을 만들지
// 않는다) — 프로필 줄이 올리는 동안 흔들리면 안 된다(#3276). 진행률은 버튼 안이
// 아니라 아래 상태 줄이 말한다(버튼 낱말이 퍼센트로 바뀌면 폭이 따라 움직인다).
// 지우기는 워크스페이스 나가기와 같은 `ConfirmButton`(제자리 확인) 이고, 성공하면
// 초점은 남는 「사진 올리기」로 간다(지운 단추는 사라지므로 <body> 로 떨어진다).
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
  const changeRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const statusId = useId();
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refreshRoster = () =>
    client.invalidateQueries({ queryKey: ["roster", workspaceId] });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      setProgress(0);
      const media = await uploadMyAvatar(workspaceId, file, setProgress);
      await primeMemberAvatar(media.avatarUrl, file).catch(() => undefined);
    },
    onSuccess: async () => {
      await refreshRoster();
      setDone("프로필 사진을 바꿨습니다.");
    },
    onError: (failure) => setError(memberAvatarUploadError(failure)),
  });

  const remove = useMutation({
    mutationFn: () => removeMyAvatar(workspaceId),
    onSuccess: async () => {
      await refreshRoster();
      setDone("프로필 사진을 지웠습니다.");
      // 지운 단추는 사라졌다. 초점이 거기(또는 <body>)에 있으면 남는 단추로 옮긴다.
      const active = document.activeElement;
      if (
        !active ||
        active === document.body ||
        active.closest('[data-testid="profile-avatar-remove"]')
      ) {
        changeRef.current?.focus();
      }
    },
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
    setDone(null);
    if (!file || busy || offline) return;
    const problem = memberAvatarPickError(file);
    if (problem) {
      setError(problem);
      return;
    }
    upload.mutate(file);
  }

  // 한 칸에 하나만 선다: 오류 > 진행 > 형제 잠금 사유 > 완료. 칸의 높이는 늘 예약해
  // 두므로(min-h-6) 문장이 나타나도 아래 폼이 밀리지 않는다.
  const status = uploading
    ? `올리는 중 ${Math.round(progress * 100)}%. 끝나면 지울 수 있습니다.`
    : removing
      ? "지우는 중입니다. 끝나면 다시 바꿀 수 있습니다."
      : done;
  const changeLocked = offline || removing;
  const describedBy =
    [hintId, offline ? "profile-offline-reason" : null, removing ? statusId : null]
      .filter(Boolean)
      .join(" ");

  return (
    <div className="flex flex-col gap-2" data-testid="profile-avatar-field">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={changeRef}
          type="button"
          variant="outline"
          size="sm"
          aria-label={
            uploading
              ? undefined
              : hasAvatar
                ? "프로필 사진 바꾸기"
                : "프로필 사진 올리기"
          }
          aria-describedby={describedBy}
          aria-disabled={changeLocked || undefined}
          aria-busy={uploading || undefined}
          className={cn("min-w-avatar-action", changeLocked && "opacity-50")}
          onClick={() => {
            if (changeLocked || busy) return;
            inputRef.current?.click();
          }}
          data-testid="profile-avatar-change"
        >
          {uploading && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {uploading ? "올리는 중" : hasAvatar ? "사진 바꾸기" : "사진 올리기"}
        </Button>
        {hasAvatar ? (
          <ConfirmButton
            label="사진 지우기"
            ariaLabel="프로필 사진 지우기"
            question="프로필 사진을 지우면 이름의 첫 글자로 돌아갑니다."
            confirmLabel="지우기"
            disabled={offline || uploading}
            describedBy={
              [offline ? "profile-offline-reason" : null, uploading ? statusId : null]
                .filter(Boolean)
                .join(" ") || undefined
            }
            busy={removing}
            busyLabel="지우는 중"
            onConfirm={() => {
              setError(null);
              setDone(null);
              remove.mutate();
            }}
            triggerClassName="min-w-avatar-action"
            testId="profile-avatar-remove"
          />
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
      <p id={hintId} className="text-meta text-ink-muted">
        PNG, JPG, GIF, WebP. 5MB까지 올릴 수 있습니다.
      </p>
      <div className="min-h-6">
        <p
          id={statusId}
          role="status"
          aria-live="polite"
          className="text-meta text-ink-muted"
          data-testid="profile-avatar-status"
        >
          {error ? null : status}
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
    </div>
  );
}
