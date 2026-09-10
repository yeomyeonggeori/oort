import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { changeMyDisplayName, changeMyHandle } from "@momo/core/lib/api";
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
import { Avatar } from "@/features/timeline/MessageRow";
import { HandleField } from "@/features/onboarding/HandleField";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { Field, SaveButton, SectionShell } from "./SettingsFields";

// Design Read: settings / Profile for internal team users on web+Tauri,
// density 7/10, motion 2/10.
//
// 표시 이름과 핸들(E2). 아바타는 현행 표시, 업로드는 서버 표면이 없어
// 넣지 않는다. 저장은 PATCH 1회씩, 성공 시에만 roster와 세션을 갱신한다
// (낙관 갱신 없음). 핸들 카피·검증은 S1과 같다.

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
  const [handleBusy, setHandleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);
  const saveStarted = useRef(false);
  const handleSaveStarted = useRef(false);

  useEffect(() => {
    setDraft(savedName);
  }, [savedName]);

  useEffect(() => {
    setHandleDraft(savedHandle);
  }, [savedHandle]);

  const fieldError = displayNameFieldError(draft);
  const handleGate = handleFieldError(handleDraft);
  const canSave = !offline && !busy && draft !== savedName && fieldError === null;
  const canSaveHandle =
    !offline &&
    !handleBusy &&
    normalizeHandle(handleDraft) !== savedHandle &&
    handleGate === null;

  async function save() {
    if (!canSave || saveStarted.current) return;
    saveStarted.current = true;
    setError(null);
    setBusy(true);
    try {
      const member = await changeMyDisplayName(workspaceId, draft);
      await client.invalidateQueries({ queryKey: ["roster", workspaceId] });
      replaceSessionMember(member);
      setDraft(member.displayName);
    } catch (failure) {
      setError(displayNameSaveMessage(failure));
    } finally {
      saveStarted.current = false;
      setBusy(false);
    }
  }

  async function saveHandle() {
    if (!canSaveHandle || handleSaveStarted.current) return;
    handleSaveStarted.current = true;
    setHandleError(null);
    setHandleBusy(true);
    try {
      const member = await changeMyHandle(
        workspaceId,
        normalizeHandle(handleDraft)
      );
      await client.invalidateQueries({ queryKey: ["roster", workspaceId] });
      replaceSessionMember(member);
      setHandleDraft(member.handle);
    } catch (failure) {
      setHandleError(handleSaveMessage(failure));
    } finally {
      handleSaveStarted.current = false;
      setHandleBusy(false);
    }
  }

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
      {error ? (
        <InlineBanner
          tone="error"
          message={error}
          messageId="profile-display-name-error-text"
          testId="profile-display-name-error"
        />
      ) : null}
      {handleError ? (
        <InlineBanner
          tone="error"
          message={handleError}
          messageId="profile-handle-error-text"
          testId="profile-handle-error"
        />
      ) : null}
      {offline ? (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겨 지금은 표시 이름과 핸들을 저장할 수 없습니다."
          messageId="profile-offline-reason"
          testId="profile-offline-banner"
        />
      ) : null}
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="표시 이름" htmlFor="profile-display-name">
          <Input
            id="profile-display-name"
            name="displayName"
            value={draft}
            autoComplete="nickname"
            disabled={offline}
            aria-invalid={error || fieldError ? true : undefined}
            aria-describedby={
              [
                offline ? "profile-offline-reason" : null,
                error ? "profile-display-name-error-text" : null,
                fieldError ? "profile-display-name-field-error" : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            data-testid="profile-display-name"
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          {fieldError ? (
            <p
              id="profile-display-name-field-error"
              role="alert"
              className="text-meta text-danger"
              data-testid="profile-display-name-field-error"
            >
              {fieldError}
            </p>
          ) : null}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <SaveButton
            label="표시 이름 저장"
            canSave={canSave}
            busy={busy}
            size="default"
            onSave={() => {
              void save();
            }}
            testId="profile-display-name-save"
          />
        </div>
      </form>
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void saveHandle();
        }}
      >
        <HandleField
          id="profile-handle"
          value={handleDraft}
          onChange={(value) => {
            setHandleDraft(value);
            setHandleError(null);
          }}
          error={handleGate}
          errorId="profile-handle-field-error"
          describedBy={
            [
              offline ? "profile-offline-reason" : null,
              handleError ? "profile-handle-error-text" : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          testId="profile-handle"
          errorTestId="profile-handle-field-error"
          previewTestId="profile-handle-preview"
          offline={offline}
          label={<span className="text-meta text-ink-muted">핸들</span>}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SaveButton
            label="핸들 저장"
            canSave={canSaveHandle}
            busy={handleBusy}
            size="default"
            onSave={() => {
              void saveHandle();
            }}
            testId="profile-handle-save"
          />
        </div>
      </form>
    </SectionShell>
  );
}
