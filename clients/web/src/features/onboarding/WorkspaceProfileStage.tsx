import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  changeMyDisplayName,
  changeMyHandle,
} from "@momo/core/lib/api";
import {
  fetchWorkspace,
  renameWorkspace,
} from "@momo/core/features/settings/api";
import {
  displayNameFieldError,
  displayNameSaveMessage,
  workspaceNameError,
} from "@momo/core/features/settings/model";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { useBrowserOffline } from "@/features/common/useOffline";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import {
  defaultWorkspaceName,
  fallbackHandle,
  handleFieldError,
} from "./fallbackHandle";
import {
  S1_DISPLAY_ERROR_ID,
  S1_FAILURE,
  S1_HANDLE_ERROR_ID,
  S1_LEAD,
  S1_OFFLINE_NOTE_ID,
  S1_OFFLINE_REASON,
  S1_PRIMARY_BUSY,
  S1_PRIMARY_LABEL,
  S1_REENTRY,
  S1_STALE_RETRY,
  S1_WORKSPACE_ERROR_ID,
} from "./s1Copy";

// Reading this as: onboarding S1 (내 워크스페이스·내 이름) for internal team
// users on web+Tauri, density 6/10, motion 2/10.

const HANDLE_TAKEN = "handle is already in use";
const WORKSPACE_STALE = "workspace has been updated; refetch and retry";

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-ink-muted">{children}</span>
      <span className="text-meta text-ink-muted">필수</span>
    </span>
  );
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function WorkspaceProfileStage({
  workspaceId,
  memberHandle,
  workspaceName,
  workspaceUpdatedAtMs,
  onComplete,
}: {
  workspaceId: string;
  memberHandle: string;
  workspaceName?: string;
  workspaceUpdatedAtMs?: number;
  onComplete: () => void;
}) {
  const offline = useBrowserOffline();
  const queryClient = useQueryClient();
  const workspaceEdited = useRef(false);
  const [workspaceDraft, setWorkspaceDraft] = useState(() =>
    defaultWorkspaceName(workspaceName)
  );
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState(() => fallbackHandle(memberHandle));
  const [updatedAtMs, setUpdatedAtMs] = useState(workspaceUpdatedAtMs);
  const [busy, setBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [staleRetry, setStaleRetry] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceEdited.current) return;
    setWorkspaceDraft(defaultWorkspaceName(workspaceName));
  }, [workspaceName]);

  useEffect(() => {
    if (workspaceUpdatedAtMs !== undefined) {
      setUpdatedAtMs(workspaceUpdatedAtMs);
    }
  }, [workspaceUpdatedAtMs]);

  async function refetchWorkspaceToken(): Promise<number | undefined> {
    try {
      const latest = await fetchWorkspace(workspaceId);
      setUpdatedAtMs(latest.updatedAtMs);
      if (!workspaceEdited.current) {
        setWorkspaceDraft(defaultWorkspaceName(latest.name));
      }
      await queryClient.invalidateQueries({
        queryKey: workspaceIdentityKey(workspaceId),
      });
      return latest.updatedAtMs;
    } catch {
      return undefined;
    }
  }

  async function attempt() {
    const nextWorkspaceError = workspaceNameError(workspaceDraft);
    const nextDisplayError = displayNameFieldError(displayName);
    const nextHandleError = handleFieldError(handle);
    setWorkspaceError(nextWorkspaceError);
    setDisplayError(nextDisplayError);
    setHandleError(nextHandleError);
    setFormError(null);
    setStaleRetry(false);
    if (nextWorkspaceError || nextDisplayError || nextHandleError) return;
    setBusy(true);
    try {
      const token = updatedAtMs ?? (await refetchWorkspaceToken());
      if (token === undefined) {
        setFormError(S1_FAILURE);
        return;
      }
      const renamed = await renameWorkspace(
        workspaceId,
        workspaceDraft.trim(),
        token
      );
      setUpdatedAtMs(renamed.updatedAtMs);
      await queryClient.invalidateQueries({
        queryKey: workspaceIdentityKey(workspaceId),
      });
      await changeMyHandle(workspaceId, handle.trim().toLowerCase());
      await changeMyDisplayName(workspaceId, displayName.trim());
      onComplete();
    } catch (error) {
      if (isApiError(error) && error.status === 409 && error.message === HANDLE_TAKEN) {
        setHandleError(error.message);
        return;
      }
      if (
        isApiError(error) &&
        error.status === 409 &&
        error.message === WORKSPACE_STALE
      ) {
        await refetchWorkspaceToken();
        setStaleRetry(true);
        return;
      }
      if (isApiError(error) && error.status === 400) {
        if (error.message.toLowerCase().includes("handle")) {
          setHandleError(error.message);
          return;
        }
        if (error.message.toLowerCase().includes("displayname")) {
          setDisplayError(displayNameSaveMessage(error));
          return;
        }
        setWorkspaceError(error.message);
        return;
      }
      setFormError(S1_FAILURE);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void attempt();
  }

  const shownWorkspaceError = workspaceError;
  const shownDisplayError = displayError;
  const shownHandleError = handleError;

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="onboarding-s1"
      onSubmit={onSubmit}
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

      {staleRetry && (
        <InlineBanner
          tone="error"
          message={S1_STALE_RETRY}
          testId="onboarding-s1-stale"
        />
      )}

      {formError && (
        <InlineBanner
          tone="error"
          message={formError}
          testId="onboarding-s1-error"
        />
      )}

      <div className="flex flex-col gap-3">
        <label
          htmlFor="onboarding-s1-workspace-name"
          className="flex flex-col gap-1 text-body"
        >
          <FieldLabel>워크스페이스 이름</FieldLabel>
          <Input
            id="onboarding-s1-workspace-name"
            name="workspaceName"
            value={workspaceDraft}
            autoComplete="organization"
            disabled={offline || busy}
            aria-invalid={shownWorkspaceError ? true : undefined}
            aria-describedby={
              shownWorkspaceError ? S1_WORKSPACE_ERROR_ID : undefined
            }
            data-testid="onboarding-s1-workspace-name"
            onChange={(event) => {
              workspaceEdited.current = true;
              setWorkspaceDraft(event.currentTarget.value);
              setWorkspaceError(null);
              setStaleRetry(false);
            }}
          />
          {shownWorkspaceError ? (
            <p
              id={S1_WORKSPACE_ERROR_ID}
              role="alert"
              className="text-meta text-danger"
              data-testid="onboarding-s1-workspace-error"
            >
              {shownWorkspaceError}
            </p>
          ) : null}
        </label>

        <label
          htmlFor="onboarding-s1-display-name"
          className="flex flex-col gap-1 text-body"
        >
          <FieldLabel>표시 이름</FieldLabel>
          <Input
            id="onboarding-s1-display-name"
            name="displayName"
            value={displayName}
            autoComplete="nickname"
            disabled={offline || busy}
            aria-invalid={shownDisplayError ? true : undefined}
            aria-describedby={
              shownDisplayError ? S1_DISPLAY_ERROR_ID : undefined
            }
            data-testid="onboarding-s1-display-name"
            onChange={(event) => {
              setDisplayName(event.currentTarget.value);
              setDisplayError(null);
            }}
          />
          {shownDisplayError ? (
            <p
              id={S1_DISPLAY_ERROR_ID}
              role="alert"
              className="text-meta text-danger"
              data-testid="onboarding-s1-display-error"
            >
              {shownDisplayError}
            </p>
          ) : null}
        </label>

        <label
          htmlFor="onboarding-s1-handle"
          className="flex flex-col gap-1 text-body"
        >
          <FieldLabel>핸들</FieldLabel>
          <div className="flex items-center gap-2">
            <span className="text-ink-muted" aria-hidden="true">
              @
            </span>
            <Input
              id="onboarding-s1-handle"
              name="handle"
              value={handle}
              autoComplete="username"
              spellCheck={false}
              disabled={offline || busy}
              aria-invalid={shownHandleError ? true : undefined}
              aria-describedby={
                shownHandleError ? S1_HANDLE_ERROR_ID : undefined
              }
              data-testid="onboarding-s1-handle"
              onChange={(event) => {
                setHandle(event.currentTarget.value);
                setHandleError(null);
              }}
            />
          </div>
          {shownHandleError ? (
            <p
              id={S1_HANDLE_ERROR_ID}
              role="alert"
              className="text-meta text-danger"
              data-testid="onboarding-s1-handle-error"
            >
              {shownHandleError}
            </p>
          ) : null}
        </label>
      </div>

      <Button
        type="submit"
        disabled={busy || offline}
        aria-describedby={offline ? S1_OFFLINE_NOTE_ID : undefined}
        data-testid="onboarding-s1-submit"
      >
        {busy ? S1_PRIMARY_BUSY : S1_PRIMARY_LABEL}
      </Button>

      <p
        className="break-keep text-meta text-ink-muted"
        data-testid="onboarding-s1-reentry"
      >
        {S1_REENTRY}
      </p>
    </form>
  );
}
