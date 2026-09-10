import { useEffect, useRef, useState, type FocusEvent, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { changeMyProfile } from "@momo/core/lib/api";
import {
  displayNameFieldError,
  displayNameSaveMessage,
  handleFieldError,
  handleSaveMessage,
  normalizeHandle,
} from "@momo/core/features/settings/model";
import { useSession } from "@/app/session";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { HandleField } from "@/features/profile/shared/HandleField";
import {
  isField400,
  isHandleTaken,
} from "@/features/profile/shared/identityCopy";
import { recordOwnerOnboardingSettingsSave } from "@/features/profile/shared/onboardingSettingsSave";
import { Avatar } from "@/features/timeline/MessageRow";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { Field, SaveButton, SectionShell } from "./SettingsFields";

// Design Read: settings / Profile for internal team users on web+Tauri,
// density 7/10, motion 2/10.
//
// 표시 이름과 핸들(E2)을 S1과 같이 한 폼·한 PATCH로 저장한다. 아바타는
// 현행 표시, 업로드는 서버 표면이 없어 넣지 않는다. 검증은 제출/blur.
// 성공 시에만 roster와 세션을 갱신한다 (낙관 갱신 없음).

export function ProfileSection({ offline }: { offline: boolean }) {
  const { session, workspaceId, replaceSessionMember } = useSession();
  const { directory } = useDirectory(workspaceId);
  const client = useQueryClient();
  const me = memberFor(directory, session.member.id);
  const savedName = session.member.displayName;
  const shownName = me?.displayName ?? savedName;
  const savedHandle = me?.handle ?? session.member.handle;
  const [draft, setDraft] = useState(savedName);
  const [handleDraft, setHandleDraft] = useState(savedHandle);
  const [busy, setBusy] = useState(false);
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const saveStarted = useRef(false);
  const displayInputRef = useRef<HTMLInputElement>(null);
  const handleInputRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(savedName);
  }, [savedName]);

  useEffect(() => {
    setHandleDraft(savedHandle);
  }, [savedHandle]);

  useEffect(() => {
    if (!formError) return;
    bannerRef.current?.focus({ preventScroll: true });
  }, [formError]);

  const displayDirty = draft !== savedName;
  const handleDirty = normalizeHandle(handleDraft) !== savedHandle;
  const dirty = displayDirty || handleDirty;
  const canSave = !offline && !busy && dirty;

  const handleDisplayBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (!displayDirty) return;
    const next = event.relatedTarget;
    if (next instanceof HTMLElement && next.closest('[data-testid="profile-save"]')) {
      return;
    }
    setDisplayError(displayNameFieldError(draft));
  };

  const handleHandleBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (!handleDirty) return;
    const next = event.relatedTarget;
    if (next instanceof HTMLElement && next.closest('[data-testid="profile-save"]')) {
      return;
    }
    setHandleError(handleFieldError(handleDraft));
  };

  const focusFirstInvalid = (nextDisplay: string | null, nextHandle: string | null) => {
    if (nextDisplay) {
      displayInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (nextHandle) {
      handleInputRef.current?.focus({ preventScroll: true });
    }
  };

  async function save() {
    if (!canSave || saveStarted.current) return;
    const nextDisplayError = displayDirty ? displayNameFieldError(draft) : null;
    const nextHandleError = handleDirty ? handleFieldError(handleDraft) : null;
    setDisplayError(nextDisplayError);
    setHandleError(nextHandleError);
    setFormError(null);
    if (nextDisplayError || nextHandleError) {
      focusFirstInvalid(nextDisplayError, nextHandleError);
      return;
    }
    saveStarted.current = true;
    setBusy(true);
    try {
      const patch: { displayName?: string; handle?: string } = {};
      if (displayDirty) patch.displayName = draft.trim();
      if (handleDirty) patch.handle = normalizeHandle(handleDraft);
      const member = await changeMyProfile(workspaceId, patch);
      await client.invalidateQueries({ queryKey: ["roster", workspaceId] });
      replaceSessionMember(member);
      setDraft(member.displayName);
      setHandleDraft(member.handle);
      setFormError(null);
      recordOwnerOnboardingSettingsSave("profile");
    } catch (failure) {
      if (
        isHandleTaken(failure) ||
        (isField400(failure) && failure.message.toLowerCase().includes("handle"))
      ) {
        setHandleError(handleSaveMessage(failure));
        handleInputRef.current?.focus({ preventScroll: true });
        return;
      }
      if (
        isField400(failure) &&
        failure.message.toLowerCase().includes("displayname")
      ) {
        setDisplayError(displayNameSaveMessage(failure));
        displayInputRef.current?.focus({ preventScroll: true });
        return;
      }
      setFormError(displayNameSaveMessage(failure));
    } finally {
      saveStarted.current = false;
      setBusy(false);
    }
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  return (
    <SectionShell
      title="프로필"
      lines={["이 워크스페이스에서 다른 멤버에게 보이는 이름과 핸들입니다."]}
    >
      <div className="flex items-center gap-3">
        <Avatar member={me ?? null} />
        <p className="min-w-0 truncate text-body font-semibold text-ink">
          {shownName}
        </p>
      </div>
      {offline ? (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겨 지금은 표시 이름과 핸들을 저장할 수 없습니다."
          messageId="profile-offline-reason"
          testId="profile-offline-banner"
        />
      ) : null}
      {formError ? (
        <div
          ref={bannerRef}
          tabIndex={-1}
          className="focus-visible:focus-ring"
        >
          <InlineBanner
            tone="error"
            message={formError}
            testId="profile-save-error"
          />
        </div>
      ) : null}
      <form className="flex min-w-0 flex-col gap-4" onSubmit={handleSubmit}>
        <Field
          label="표시 이름"
          htmlFor="profile-display-name"
          error={displayError}
          reserveError
        >
          <Input
            ref={displayInputRef}
            id="profile-display-name"
            name="displayName"
            value={draft}
            autoComplete="nickname"
            disabled={offline}
            aria-invalid={displayError ? true : undefined}
            aria-describedby={
              [
                offline ? "profile-offline-reason" : null,
                displayError ? "profile-display-name-error" : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            data-testid="profile-display-name"
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setDisplayError(null);
              setFormError(null);
            }}
            onBlur={handleDisplayBlur}
          />
        </Field>
        <HandleField
          id="profile-handle"
          value={handleDraft}
          onChange={(value) => {
            setHandleDraft(value);
            setHandleError(null);
            setFormError(null);
          }}
          onBlur={handleHandleBlur}
          error={handleError}
          errorId="profile-handle-error"
          describedBy={offline ? "profile-offline-reason" : undefined}
          testId="profile-handle"
          errorTestId="profile-handle-error"
          previewTestId="profile-handle-preview"
          offline={offline}
          inputRef={handleInputRef}
          reserveErrorSlot
          label={<span className="text-meta text-ink-muted">핸들</span>}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SaveButton
            label="프로필 저장"
            canSave={canSave}
            busy={busy}
            size="default"
            onSave={() => {
              void save();
            }}
            testId="profile-save"
          />
        </div>
      </form>
    </SectionShell>
  );
}
