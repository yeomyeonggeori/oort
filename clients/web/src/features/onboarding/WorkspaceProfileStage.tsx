import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  changeMyProfile,
  type Member,
} from "@momo/core/lib/api";
import {
  fetchWorkspace,
  renameWorkspace,
} from "@momo/core/features/settings/api";
import {
  displayNameFieldError,
  displayNameSaveMessage,
  normalizeHandle,
  workspaceNameError,
} from "@momo/core/features/settings/model";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { InlineBanner } from "@/features/common/States";
import { useBrowserOffline } from "@/features/common/useOffline";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { HandleField } from "./HandleField";
import {
  defaultWorkspaceName,
} from "./fallbackHandle";
import {
  handleFieldError,
  handleSaveMessage,
  isField400,
  isHandleTaken,
  isWorkspaceStale,
  workspaceNameSaveMessage,
} from "./identityCopy";
import { clearS1Draft, readS1Draft, resolveS1Seeds, writeS1Draft } from "./s1Draft";
import { StaleWorkspaceNameConflict } from "./StaleWorkspaceNameConflict";
import {
  S1_DISPLAY_ERROR_ID,
  S1_FAILURE,
  S1_HANDLE_ERROR_ID,
  S1_LEAD,
  S1_OFFLINE_NOTE_ID,
  S1_OFFLINE_REASON,
  S1_PRIMARY_BUSY,
  S1_PRIMARY_LABEL,
  S1_PRIMARY_RETRY,
  S1_REENTRY,
  S1_SKIP_LABEL,
  S1_STALE_MESSAGE_ID,
  S1_WORKSPACE_ERROR_ID,
} from "./s1Copy";
import {
  hasOwnerOnboardingSettingsDoor,
} from "./ownerOnboardingStore";

// Reading this as: onboarding S1 (내 워크스페이스·내 이름) for internal team
// users on web+Tauri, density 6/10, motion 2/10.

export function WorkspaceProfileStage({
  workspaceId,
  memberHandle,
  memberDisplayName,
  email,
  workspaceName,
  workspaceUpdatedAtMs,
  replaceSessionMember,
  onComplete,
  onSkip,
}: {
  workspaceId: string;
  memberHandle: string;
  memberDisplayName?: string;
  email?: string;
  workspaceName?: string;
  workspaceUpdatedAtMs?: number;
  replaceSessionMember: (member: Member) => void;
  onComplete: () => void;
  onSkip?: () => void;
}) {
  const offline = useBrowserOffline();
  const queryClient = useQueryClient();
  const workspaceEdited = useRef(false);
  const profileSaved = hasOwnerOnboardingSettingsDoor("profile");
  const workspaceSaved = hasOwnerOnboardingSettingsDoor("workspace");
  const renamedNameRef = useRef<string | null>(
    workspaceSaved ? (workspaceName?.trim() || null) : null
  );
  const profileSavedRef = useRef(profileSaved);
  const workspaceInputRef = useRef<HTMLInputElement>(null);
  const displayInputRef = useRef<HTMLInputElement>(null);
  const handleInputRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const focusNonce = useRef(0);
  const [focusTick, setFocusTick] = useState(0);
  const draft = readS1Draft();
  const seeds = resolveS1Seeds({
    draft,
    workspaceName,
    memberHandle,
    memberDisplayName,
    email,
    profileSaved,
    workspaceSaved,
  });
  const [workspaceDraft, setWorkspaceDraft] = useState(() => seeds.workspaceName);
  const [displayName, setDisplayName] = useState(() => seeds.displayName);
  const [handle, setHandle] = useState(() => seeds.handle);
  const [updatedAtMs, setUpdatedAtMs] = useState(workspaceUpdatedAtMs);
  const [busy, setBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [staleName, setStaleName] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceEdited.current) return;
    if (hasOwnerOnboardingSettingsDoor("workspace")) {
      setWorkspaceDraft(defaultWorkspaceName(workspaceName));
      renamedNameRef.current = workspaceName?.trim() || null;
      return;
    }
    if (draft?.workspaceName) return;
    setWorkspaceDraft(defaultWorkspaceName(workspaceName));
  }, [workspaceName, draft?.workspaceName]);

  useEffect(() => {
    if (workspaceUpdatedAtMs !== undefined) {
      setUpdatedAtMs(workspaceUpdatedAtMs);
    }
  }, [workspaceUpdatedAtMs]);

  useEffect(() => {
    writeS1Draft({
      workspaceName: workspaceDraft,
      displayName,
      handle,
    });
  }, [workspaceDraft, displayName, handle]);

  useEffect(() => {
    if (focusTick === 0) return;
    if (workspaceError) {
      workspaceInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (displayError) {
      displayInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (handleError) {
      handleInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (formError || staleName) {
      bannerRef.current?.focus({ preventScroll: true });
    }
  }, [focusTick, handleError, displayError, workspaceError, formError, staleName]);

  function requestFocus() {
    focusNonce.current += 1;
    setFocusTick(focusNonce.current);
  }

  async function refetchWorkspaceToken(keepDraft = false): Promise<
    { updatedAtMs: number; name: string } | undefined
  > {
    try {
      const latest = await fetchWorkspace(workspaceId);
      setUpdatedAtMs(latest.updatedAtMs);
      if (!keepDraft && !workspaceEdited.current) {
        setWorkspaceDraft(defaultWorkspaceName(latest.name));
      }
      queryClient.setQueryData(workspaceIdentityKey(workspaceId), latest);
      await queryClient.invalidateQueries({
        queryKey: workspaceIdentityKey(workspaceId),
      });
      return { updatedAtMs: latest.updatedAtMs, name: latest.name };
    } catch {
      return undefined;
    }
  }

  async function persistWorkspace(renamed: {
    updatedAtMs: number;
    name: string;
  }) {
    setUpdatedAtMs(renamed.updatedAtMs);
    renamedNameRef.current = renamed.name;
    queryClient.setQueryData(workspaceIdentityKey(workspaceId), (current) =>
      current ? { ...current, ...renamed } : current
    );
    await queryClient.invalidateQueries({
      queryKey: workspaceIdentityKey(workspaceId),
    });
  }

  async function attempt() {
    const nextWorkspaceError = workspaceNameError(workspaceDraft);
    const nextDisplayError = displayNameFieldError(displayName);
    const nextHandleError = handleFieldError(handle);
    setWorkspaceError(nextWorkspaceError);
    setDisplayError(nextDisplayError);
    setHandleError(nextHandleError);
    setFormError(null);
    if (nextWorkspaceError || nextDisplayError || nextHandleError) {
      requestFocus();
      return;
    }
    setBusy(true);
    try {
      const nextName = workspaceDraft.trim();
      const nextHandle = normalizeHandle(handle);
      const nextDisplay = displayName.trim();
      if (renamedNameRef.current !== nextName) {
        const token = updatedAtMs ?? (await refetchWorkspaceToken())?.updatedAtMs;
        if (token === undefined) {
          setFormError(S1_FAILURE);
          requestFocus();
          return;
        }
        const renamed = await renameWorkspace(workspaceId, nextName, token);
        await persistWorkspace(renamed);
      }
      if (!profileSavedRef.current) {
        const member = await changeMyProfile(workspaceId, {
          handle: nextHandle,
          displayName: nextDisplay,
        });
        profileSavedRef.current = true;
        replaceSessionMember(member);
      }
      clearS1Draft();
      onComplete();
    } catch (error) {
      if (isHandleTaken(error)) {
        setHandleError(handleSaveMessage(error));
        requestFocus();
        return;
      }
      if (isWorkspaceStale(error)) {
        const latest = await refetchWorkspaceToken(true);
        if (latest) {
          setStaleName(latest.name);
          renamedNameRef.current = null;
        } else {
          setFormError(S1_FAILURE);
        }
        requestFocus();
        return;
      }
      if (isField400(error)) {
        const message = error.message.toLowerCase();
        if (message.includes("handle")) {
          setHandleError(handleSaveMessage(error));
          requestFocus();
          return;
        }
        if (message.includes("displayname")) {
          setDisplayError(displayNameSaveMessage(error));
          requestFocus();
          return;
        }
        setWorkspaceError(workspaceNameSaveMessage(error));
        requestFocus();
        return;
      }
      setFormError(S1_FAILURE);
      requestFocus();
    } finally {
      setBusy(false);
    }
  }

  const handleKeepTheirs = () => {
    if (!staleName) return;
    workspaceEdited.current = true;
    setWorkspaceDraft(staleName);
    renamedNameRef.current = staleName;
    setStaleName(null);
    setWorkspaceError(null);
    workspaceInputRef.current?.focus({ preventScroll: true });
  };

  const handleKeepMine = () => {
    setStaleName(null);
    workspaceInputRef.current?.focus({ preventScroll: true });
    void attempt();
  };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (offline || busy) return;
    if (staleName) {
      handleKeepMine();
      return;
    }
    void attempt();
  }

  function handleFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (!staleName) return;
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (!(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    handleKeepMine();
  }

  const handleSkip = () => {
    onSkip?.();
  };

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="onboarding-s1"
      aria-busy={busy || undefined}
      onSubmit={onSubmit}
      onKeyDown={handleFormKeyDown}
    >
      <div className="flex break-keep flex-col gap-1">
        {S1_LEAD.map((line) => (
          <p key={line} className="break-keep text-body text-ink-muted">
            {line}
          </p>
        ))}
      </div>

      {offline && (
        <InlineBanner
          tone="neutral"
          message={S1_OFFLINE_REASON}
          messageId={S1_OFFLINE_NOTE_ID}
          testId="onboarding-s1-offline"
        />
      )}

      {staleName && (
        <StaleWorkspaceNameConflict
          otherName={staleName}
          onKeepTheirs={handleKeepTheirs}
          onKeepMine={handleKeepMine}
          messageId={S1_STALE_MESSAGE_ID}
          testIdPrefix="onboarding-s1"
          bannerRef={bannerRef}
        />
      )}

      {formError && (
        <div
          ref={bannerRef}
          tabIndex={-1}
          className="focus-visible:focus-ring"
        >
          <InlineBanner
            tone="error"
            message={formError}
            testId="onboarding-s1-error"
          />
        </div>
      )}

      <div className="flex flex-col gap-3">
        <label
          htmlFor="onboarding-s1-workspace-name"
          className="flex flex-col gap-1 text-body"
        >
          <span className="text-ink-muted">워크스페이스 이름</span>
          <Input
            ref={workspaceInputRef}
            id="onboarding-s1-workspace-name"
            name="workspaceName"
            value={workspaceDraft}
            autoComplete="organization"
            disabled={offline}
            aria-invalid={workspaceError || staleName ? true : undefined}
            aria-describedby={
              [
                workspaceError ? S1_WORKSPACE_ERROR_ID : null,
                staleName ? S1_STALE_MESSAGE_ID : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            data-testid="onboarding-s1-workspace-name"
            onChange={(event) => {
              workspaceEdited.current = true;
              setWorkspaceDraft(event.currentTarget.value);
              setWorkspaceError(null);
              setStaleName(null);
            }}
          />
          {workspaceError ? (
            <p
              id={S1_WORKSPACE_ERROR_ID}
              role="alert"
              className="text-meta text-danger"
              data-testid="onboarding-s1-workspace-error"
            >
              {workspaceError}
            </p>
          ) : null}
        </label>

        <label
          htmlFor="onboarding-s1-display-name"
          className="flex flex-col gap-1 text-body"
        >
          <span className="text-ink-muted">표시 이름</span>
          <Input
            ref={displayInputRef}
            id="onboarding-s1-display-name"
            name="displayName"
            value={displayName}
            autoComplete="nickname"
            disabled={offline}
            aria-invalid={displayError ? true : undefined}
            aria-describedby={
              displayError ? S1_DISPLAY_ERROR_ID : undefined
            }
            data-testid="onboarding-s1-display-name"
            onChange={(event) => {
              setDisplayName(event.currentTarget.value);
              setDisplayError(null);
              profileSavedRef.current = false;
            }}
          />
          {displayError ? (
            <p
              id={S1_DISPLAY_ERROR_ID}
              role="alert"
              className="text-meta text-danger"
              data-testid="onboarding-s1-display-error"
            >
              {displayError}
            </p>
          ) : null}
        </label>

        <HandleField
          id="onboarding-s1-handle"
          value={handle}
          onChange={(value) => {
            setHandle(value);
            setHandleError(null);
            profileSavedRef.current = false;
          }}
          error={handleError}
          errorId={S1_HANDLE_ERROR_ID}
          testId="onboarding-s1-handle"
          errorTestId="onboarding-s1-handle-error"
          previewTestId="onboarding-s1-handle-preview"
          offline={offline}
          inputRef={handleInputRef}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {staleName ? null : (
          <Button
            type="submit"
            aria-disabled={offline || undefined}
            aria-busy={busy || undefined}
            aria-describedby={offline ? S1_OFFLINE_NOTE_ID : undefined}
            className={cn(offline && "opacity-50")}
            data-testid="onboarding-s1-submit"
          >
            {busy ? S1_PRIMARY_BUSY : formError ? S1_PRIMARY_RETRY : S1_PRIMARY_LABEL}
          </Button>
        )}
        {formError && onSkip ? (
          <Button
            type="button"
            variant="ghost"
            onClick={handleSkip}
            data-testid="onboarding-s1-skip"
          >
            {S1_SKIP_LABEL}
          </Button>
        ) : null}
      </div>

      <p
        className="break-keep text-meta text-ink-muted"
        data-testid="onboarding-s1-reentry"
      >
        {S1_REENTRY}
      </p>
    </form>
  );
}
