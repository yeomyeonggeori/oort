import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import { expressionForState, type GuideState } from "@momo/core/features/onboarding/guide";
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
import { HandleField } from "@/features/profile/shared/HandleField";
import {
  handleFieldError,
  handleSaveMessage,
  isField400,
  isHandleTaken,
  isWorkspaceStale,
  workspaceNameSaveMessage,
} from "@/features/profile/shared/identityCopy";
import { StaleWorkspaceNameConflict } from "@/features/workspace/shared/StaleWorkspaceNameConflict";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { defaultWorkspaceName } from "./fallbackHandle";
import { KomettoGuide } from "./guide/KomettoGuide";
import {
  ONBOARDING_ACTION_CLASS,
  ONBOARDING_FIELD_CLASS,
} from "./guide/OnboardingFrame";
import { hasOwnerOnboardingSettingsDoor } from "./ownerOnboardingStore";
import {
  S1_DETAIL,
  S1_DISPLAY_ERROR_ID,
  S1_FAILURE,
  S1_HANDLE_ERROR_ID,
  S1_OFFLINE_LINE,
  S1_OFFLINE_NOTE_ID,
  S1_OFFLINE_REASON,
  S1_PRIMARY_BUSY,
  S1_PRIMARY_LABEL,
  S1_PRIMARY_RETRY,
  S1_REENTRY,
  S1_SKIP_LABEL,
  S1_STALE_MESSAGE_ID,
  S1_TITLE,
  S1_TROUBLE_LINE,
  S1_WORKSPACE_ERROR_ID,
} from "./s1Copy";
import { clearS1Draft, readS1Draft, resolveS1Seeds, writeS1Draft } from "./s1Draft";

// Reading this as: onboarding S1 (우리 팀 이름, 온보딩 2.0 D2) for internal
// team users on web+Tauri, density 5/10, motion 2/10.
//
// 카드 대신 바닥 위 질문(ADR-0193 D11). 코메토가 질문을 말하고, 필드·저장·
// 건너뛰기 규칙은 ADR-0185 D-A 그대로다(건너뛰기는 저장 실패 뒤에만).

/** 미리보기 타일의 첫 글자. 한글·이모지도 한 글자로 센다. */
function initialOf(value: string): string {
  return Array.from(value.trim())[0] ?? "";
}

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
  headingRef,
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
  /** 단계 착지 포커스(OwnerOnboarding). 코메토의 문장이 받는다. */
  headingRef?: Ref<HTMLHeadingElement>;
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

  const guideState: GuideState = offline || formError ? "trouble" : "awaiting";
  const guideLine = offline
    ? S1_OFFLINE_LINE
    : formError
      ? S1_TROUBLE_LINE
      : S1_TITLE;
  const previewName = workspaceDraft.trim();
  const previewDisplay = displayName.trim();
  const previewHandle = normalizeHandle(handle);

  // 시안 D2: 왼쪽 질문 열 + 오른쪽 250 「사이드바 미리보기」. 좁은 창(768 미만)에서는
  // 미리보기가 물러나고 질문 열만 남는다(tokens.css `.onboarding-wide`).
  return (
    <div className="onboarding-wide" data-testid="onboarding-s1-layout">
      <form
        className="flex min-w-0 flex-col gap-4"
        data-testid="onboarding-s1"
        aria-busy={busy || undefined}
        onSubmit={onSubmit}
        onKeyDown={handleFormKeyDown}
      >
        <KomettoGuide
          as="h1"
          expression={expressionForState(guideState)}
          line={guideLine}
          detail={guideState === "awaiting" ? S1_DETAIL : undefined}
          lineRef={headingRef}
          lineTestId="onboarding-s1-title"
        />

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

        <label
          htmlFor="onboarding-s1-workspace-name"
          className="flex flex-col gap-1 text-body"
        >
          <span className="text-ink-muted">워크스페이스 이름</span>
          <Input
            ref={workspaceInputRef}
            id="onboarding-s1-workspace-name"
            name="workspaceName"
            className={ONBOARDING_FIELD_CLASS}
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

        <div className="onboarding-pair">
          <label
            htmlFor="onboarding-s1-display-name"
            className="flex min-w-0 flex-col gap-1 text-body"
          >
            <span className="text-ink-muted">표시 이름</span>
            <Input
              ref={displayInputRef}
              id="onboarding-s1-display-name"
              name="displayName"
              className={ONBOARDING_FIELD_CLASS}
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
            inputClassName={ONBOARDING_FIELD_CLASS}
          />
        </div>

        {staleName ? null : (
          <Button
            type="submit"
            aria-disabled={offline || undefined}
            aria-busy={busy || undefined}
            aria-describedby={offline ? S1_OFFLINE_NOTE_ID : undefined}
            className={cn(ONBOARDING_ACTION_CLASS, offline && "opacity-50")}
            data-testid="onboarding-s1-submit"
          >
            {busy ? S1_PRIMARY_BUSY : formError ? S1_PRIMARY_RETRY : S1_PRIMARY_LABEL}
          </Button>
        )}

        <p className="onboarding-reentry" data-testid="onboarding-s1-reentry">
          {formError && onSkip ? (
            <>
              <Button
                type="button"
                variant="ghost"
                className="onboarding-skip"
                onClick={handleSkip}
                data-testid="onboarding-s1-skip"
              >
                {S1_SKIP_LABEL}
              </Button>
              <span className="onboarding-reentry-sep" aria-hidden="true"> · </span>
            </>
          ) : null}
          {S1_REENTRY}
        </p>
      </form>

      {/* 입력이 어디에 보이는지 보여 주는 그림이다. 글자는 왼쪽 칸이 이미 말하므로
          보조기술에는 숨긴다. */}
      <div
        className="onboarding-preview glass"
        aria-hidden="true"
        data-testid="onboarding-s1-preview"
      >
        <p className="text-meta font-bold text-ink-muted">사이드바 미리보기</p>
        <div className="flex min-w-0 items-center gap-2 font-bold text-ink">
          <span className="onboarding-preview-ws">
            {initialOf(previewName)}
          </span>
          <span
            className={cn("truncate", !previewName && "font-normal text-ink-muted")}
            data-testid="onboarding-s1-preview-workspace"
          >
            {previewName || "워크스페이스 이름"}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="onboarding-preview-me">{initialOf(previewDisplay)}</span>
          <span className="flex min-w-0 flex-col">
            <b
              className={cn(
                "truncate text-body",
                previewDisplay ? "text-ink" : "font-normal text-ink-muted"
              )}
              data-testid="onboarding-s1-preview-name"
            >
              {previewDisplay || "표시 이름"}
            </b>
            <span className="truncate font-mono text-meta text-ink-muted">
              @{previewHandle || "핸들"}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
