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
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { HandleField } from "@/features/profile/shared/HandleField";
import {
  isField400,
  isHandleTaken,
} from "@/features/profile/shared/identityCopy";
import { recordOwnerOnboardingSettingsSave } from "@/features/profile/shared/onboardingSettingsSave";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { LeaveWorkspaceRow } from "./LeaveWorkspaceRow";
import { Field, SaveButton } from "./SettingsFields";
import { ProfileHero } from "./shell/ProfileHero";
import { SettingsRow } from "./shell/SettingsRow";
import { SettingsSection } from "./shell/SettingsSection";

// Design Read: settings / Profile for internal team users on web+Tauri,
// density 7/10, motion 2/10.
//
// 프로필과 계정은 한 페이지다(#3578 S2, 성재 결재 2026-10-07): 히어로(얼굴·이름·사진),
// 프로필 폼 카드, 계정 정보 카드, 로그인 카드, 맨 아래 워크스페이스 나가기 위험 행.
// 옛 「계정」 페이지(`?section=account`)는 이 페이지의 별칭이다(`settingsNav`).
//
// 표시 이름과 핸들(E2)을 S1과 같이 한 폼·한 PATCH로 저장한다. 아바타는
// 사진은 별도 저장 단추 없이 고르는 즉시 올리고(ProfileAvatarField, #3277),
// 이름·핸들 폼과 독립이다. 검증은 제출/blur.
// 성공 시에만 roster와 세션을 갱신한다 (낙관 갱신 없음).

export function ProfileSection({ offline }: { offline: boolean }) {
  const { session, workspaceId, replaceSessionMember, logout } = useSession();
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
  // 서버가 거절한 핸들(정규화 값). 값이 그대로인 동안 blur의 로컬 검사가 서버 오류를 덮지 않는다.
  const serverRejectedHandle = useRef<string | null>(null);
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
    if (handleError && serverRejectedHandle.current === normalizeHandle(handleDraft)) {
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
        serverRejectedHandle.current = normalizeHandle(handleDraft);
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
    <>
      <ProfileHero
        workspaceId={workspaceId}
        me={me ?? null}
        name={shownName}
        handle={savedHandle}
        offline={offline}
      />
      {offline ? (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겨 지금은 표시 이름, 핸들, 프로필 사진을 바꿀 수 없어요."
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
      <SettingsSection
        title="프로필"
        description="이 워크스페이스에서 다른 멤버에게 보이는 이름, 핸들, 프로필 사진이에요."
        testId="profile-card"
      >
        <form className="flex min-w-0 flex-col divide-y divide-line" onSubmit={handleSubmit}>
          <div className="px-4 py-3">
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
          </div>
          <div className="px-4 py-3">
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
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
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
      </SettingsSection>

      <SettingsSection
        title="계정 정보"
        description="이 서버에서 나를 가리키는 번호예요. 문의할 때 알려 주면 찾기 쉬워요."
        testId="profile-account-card"
      >
        <SettingsRow label="워크스페이스 ID" stack>
          <p className="min-w-0 break-all font-mono text-meta text-ink-muted" data-numeric="">
            {workspaceId}
          </p>
        </SettingsRow>
        <SettingsRow label="멤버 ID" stack>
          <p className="min-w-0 break-all font-mono text-meta text-ink-muted" data-numeric="">
            {session.member.id}
          </p>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="로그인" testId="profile-login-card">
        <SettingsRow label="로그아웃" description="이 기기에서 로그아웃해요. 다시 로그인하면 돌아와요.">
          <Button
            variant="outline"
            size="sm"
            className="tap-target"
            onClick={logout}
            data-testid="logout"
          >
            로그아웃
          </Button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="나가기" testId="profile-danger-card">
        <LeaveWorkspaceRow workspaceId={workspaceId} offline={offline} />
      </SettingsSection>
    </>
  );
}
