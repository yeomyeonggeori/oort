import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { changeMyDisplayName } from "@momo/core/lib/api";
import { displayNameSaveMessage } from "@momo/core/features/settings/model";
import { useSession } from "@/app/session";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { Avatar } from "@/features/timeline/MessageRow";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { Field, KeyValueRows, SaveButton, SectionShell } from "./SettingsFields";

// Design Read: settings / Profile for internal team users on web+Tauri,
// density 7/10, motion 2/10.
//
// 표시 이름만 쓴다 (#1867). 아바타는 현행 표시, 업로드는 서버 표면이 없어
// 넣지 않는다. 핸들은 읽기 전용 Fact. 저장은 PATCH 1회, 성공 시에만 roster와
// 세션 표시 이름을 갱신한다 (낙관 갱신 없음).

export function ProfileSection({ offline }: { offline: boolean }) {
  const { session, workspaceId, replaceSessionMember } = useSession();
  const { directory } = useDirectory(workspaceId);
  const client = useQueryClient();
  const me = memberFor(directory, session.member.id);
  const savedName = session.member.displayName;
  const shownName = me?.displayName ?? savedName;
  const handle = me?.handle ?? session.member.handle;
  const [draft, setDraft] = useState(savedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // SaveButton is type=submit. A click fires onClick then the form submit, so
  // the same handler must no-op the second call in the same tick.
  const saveStarted = useRef(false);

  useEffect(() => {
    setDraft(savedName);
  }, [savedName]);

  const canSave = !offline && !busy && draft !== savedName;

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

  return (
    <SectionShell
      title="프로필"
      lines={["이 워크스페이스에서 다른 멤버에게 보이는 이름입니다."]}
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
      {offline ? (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겨 지금은 표시 이름을 저장할 수 없습니다."
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
            aria-invalid={error ? true : undefined}
            aria-describedby={
              [
                offline ? "profile-offline-reason" : null,
                error ? "profile-display-name-error-text" : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            data-testid="profile-display-name"
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
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
      <KeyValueRows rows={[{ key: "핸들", value: `@${handle}` }]} />
    </SectionShell>
  );
}
