import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { cn } from "@/design/lib/cn";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { putAttachmentBytes } from "@/features/attachments/uploadTransport";
import { useWorkspaceAvatar } from "@/features/sidebar/useWorkspaceAvatar";
import { useSession } from "@/app/session";
import {
  completeWorkspaceAvatarUpload,
  createWorkspaceAvatarUpload,
  fetchWorkspaceUnfurlSettings,
  leaveWorkspace,
  updateWorkspaceUnfurlSettings,
  uuidEq,
} from "@momo/core/lib/api";
import { ApiError } from "@momo/core/lib/api";
import {
  DEFAULT_ROLE_LABELS,
  ROLE_KEYS,
  type RoleKey,
  type RoleLabels,
} from "@momo/core/features/directory/model";
import {
  createWorkspace,
  fetchWorkspace,
  patchWorkspaceSettings,
  type CreatedWorkspace,
} from "@momo/core/features/settings/api";
import {
  buildRoleLabelsPayload,
  draftFromRoleLabels,
  errorMessage,
  isOperatorDenied,
  isSlugConflict,
  isWorkspaceOperator,
  normalizeSlug,
  roleLabelFieldError,
  roleLabelsEqual,
  roleLabelsSaveMessage,
  slugError,
  workspaceNameError,
} from "@momo/core/features/settings/model";
import { memberFor, useDirectory, workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import {
  WELCOME_PROMPT_MAX_CHARS,
  welcomePromptTooLong,
} from "@/features/welcome/welcomeKickoff";
import {
  ConfirmButton,
  Field,
  KeyValueRows,
  OperatorNotice,
  SaveButton,
  SectionShell,
  Subsection,
} from "./SettingsFields";

// =============================================================================
// 워크스페이스 (R-1 §5 / ADR-0117 · ADR-0161): read the current tenant, set its
// avatar, leave it, and provision a new one.
//
// Creating a workspace mints a tenant on the shared instance, so the server
// gates it on the instance operator, not on an ordinary owner. Setting the
// avatar and leaving are workspace-scoped: the avatar is an owner/admin write
// (ADR-0161 D5), self-leave is any member (D4) with the last-owner refused.
// =============================================================================

/** 5 MiB — server `workspace_avatar_size_ck`. Checked here so an oversize file
 *  is a clear message rather than a 413 after the bytes are read. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function WorkspaceUnfurlSetting({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const client = useQueryClient();
  const queryKey = ["settings", "workspace-unfurls", workspaceId];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchWorkspaceUnfurlSettings(workspaceId),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      updateWorkspaceUnfurlSettings(workspaceId, enabled),
    onSuccess: (saved) => client.setQueryData(queryKey, saved),
  });

  const denied =
    (query.isError && isOperatorDenied(query.error)) ||
    (save.isError && isOperatorDenied(save.error));
  const nameId = "workspace-unfurls-name";
  const descId = "workspace-unfurls-desc";
  const offlineId = "workspace-unfurls-offline";
  // A controlled checkbox must show the requested value while PUT is in
  // flight. Waiting for query.data makes the native toggle snap back and turns
  // a slow save into a dead-looking control.
  const shownEnabled =
    save.isPending && typeof save.variables === "boolean"
      ? save.variables
      : (query.data?.enabled ?? false);

  return (
    <Subsection
      title="링크 미리보기"
      lines={[
        "워크스페이스 전체에서 서버가 새 링크를 확인하고 미리보기를 만들지 정합니다.",
        "개인의 「링크 미리보기 접기」는 렌더만 바꾸며 이 서버 설정과 별개입니다.",
      ]}
    >
      {query.isPending && <Skeleton ready={false} rows={1} />}
      {denied && (
        <OperatorNotice
          who="링크 미리보기는 워크스페이스 오너와 관리자만 바꿀 수 있습니다."
          contact="바꿔야 한다면 이 워크스페이스의 오너에게 문의하세요."
        />
      )}
      {query.isError && !denied && (
        <InlineBanner
          message="링크 미리보기 설정을 불러오지 못했습니다."
          actionLabel="다시 시도"
          onAction={() => void query.refetch()}
          testId="workspace-unfurls-error"
        />
      )}
      {query.data && !denied && (
        <div className="flex min-w-0 items-start gap-3 rounded-md border border-line bg-surface-raised p-3">
          <input
            id="workspace-unfurls"
            type="checkbox"
            checked={shownEnabled}
            aria-disabled={offline || undefined}
            aria-busy={save.isPending || undefined}
            aria-labelledby={nameId}
            aria-describedby={offline ? `${descId} ${offlineId}` : descId}
            onChange={(event) => {
              if (offline || save.isPending) return;
              save.mutate(event.target.checked);
            }}
            className={cn(
              "mt-1 accent-accent focus-visible:focus-ring",
              offline && "opacity-50"
            )}
            data-testid="workspace-unfurls"
          />
          <label
            htmlFor="workspace-unfurls"
            className={cn(
              "flex min-w-0 cursor-pointer flex-col gap-px hover:bg-surface-hover active:bg-surface-pressed",
              offline && "opacity-50"
            )}
          >
            <span id={nameId} className="text-body text-ink" aria-live="polite">
              {save.isPending
                ? shownEnabled
                  ? "새 링크 미리보기 켜는 중"
                  : "새 링크 미리보기 끄는 중"
                : "새 링크 미리보기 만들기"}
            </span>
            <span id={descId} className="break-keep text-meta text-ink-muted">
              끄면 서버가 새 링크를 가져오지 않습니다. 이미 만들어진 카드는 남고,
              인스턴스 운영자가 기능을 꺼 둔 경우에는 이 설정이 켜져 있어도 카드가
              생기지 않습니다.
            </span>
          </label>
        </div>
      )}
      {offline && query.data && !denied && (
        <p id={offlineId} className="text-meta text-ink-muted">
          연결이 끊겨 지금은 이 설정을 바꿀 수 없습니다.
        </p>
      )}
      {save.isError && !denied && (
        <p className="text-meta text-danger" role="alert" data-testid="workspace-unfurls-save-error">
          설정을 저장하지 못했습니다. 연결을 확인하고 다시 시도하세요.
        </p>
      )}
    </Subsection>
  );
}

/**
 * The workspace avatar: a preview, and an owner/admin control to replace it.
 *
 * The client cannot know its own role without the roster, so it shows the
 * control and lets the server answer — a 403 becomes an inline notice (the same
 * "show then handle 403" the create form uses), never a dead `+` that always
 * fails. On success it invalidates the shared workspace query, so this card AND
 * the rail tile update from one write.
 */
function WorkspaceAvatarField({
  workspaceId,
  avatarUrl,
  offline,
}: {
  workspaceId: string;
  avatarUrl?: string;
  offline: boolean;
}) {
  const client = useQueryClient();
  const preview = useWorkspaceAvatar(avatarUrl);
  const inputRef = useRef<HTMLInputElement>(null);
  const [denied, setDenied] = useState(false);
  // 로컬 검증 실패(이미지 아님·5MB 초과)는 서버를 부르지 않으므로 mutation 오류
  // 자리에 실을 수 없다. 별도로 든다.
  const [localError, setLocalError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const created = await createWorkspaceAvatarUpload(workspaceId, {
        name: file.name,
        mime: file.type,
        size: file.size,
      });
      const put = putAttachmentBytes(created.uploadUrl, file, file.type, () => {});
      const result = await put.done;
      if (!result.ok) {
        throw new ApiError(result.status ?? 0, "이미지를 올리지 못했습니다. 다시 시도하세요.");
      }
      await completeWorkspaceAvatarUpload(workspaceId, created.id);
    },
    onSuccess: () => {
      setDenied(false);
      void client.invalidateQueries({
        queryKey: workspaceIdentityKey(workspaceId),
      });
    },
    onError: (error) => {
      if (isOperatorDenied(error)) setDenied(true);
    },
  });

  function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // 같은 파일을 다시 골라도 change 가 다시 뜨게.
    setLocalError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setLocalError("이미지 파일만 워크스페이스 아바타로 쓸 수 있습니다.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setLocalError("아바타는 5MB까지 올릴 수 있습니다.");
      return;
    }
    upload.mutate(file);
  }

  const serverError =
    upload.isError && !isOperatorDenied(upload.error)
      ? errorMessage(upload.error)
      : null;
  const uploading = upload.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {/* 미리보기: 있으면 이미지, 없으면 designed empty("아바타 없음"). 레일 타일과
            같은 44px·rounded-md 로, 설정에서 본 것이 레일에서 나오는 것과 같게. */}
        {preview ? (
          <img
            src={preview}
            alt=""
            className="size-rail-tile rounded-md object-cover"
            data-testid="workspace-avatar-preview"
          />
        ) : (
          <div
            className="flex size-rail-tile items-center justify-center rounded-md border border-line bg-surface text-meta text-ink-muted"
            data-testid="workspace-avatar-empty"
          >
            없음
          </div>
        )}
        {/* items-start: 열의 기본 stretch 는 버튼을 아래 설명 문장만큼(실측 316px)
            늘여 액션이 막대가 된다 (3R M-1). 버튼은 자기 라벨만 하다. */}
        <div className="flex flex-col items-start gap-1">
          {/* 진행은 잠금이 아니다 (#1486 문법 · #1541). 이 버튼은 `aria-busy` 와
              바뀐 낱말로 진행을 이미 말하면서, 같은 사실을 native `disabled` 로도
              말하고 있었다 — 그 겹침이 하나뿐인 진행 낱말을 opacity-50 아래에서
              죽이고(「올리는 중, 사용 안 함」), 파일 창을 연 손에서 초점을 <body>
              로 떨궜다. 잠그는 사실로 남는 것은 오프라인 하나다.
              (같은 파일 아래쪽 「워크스페이스 나가기」가 #1502 에서 받은 수리와
              같은 갈라내기다.) */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={offline || undefined}
            aria-busy={uploading || undefined}
            className={cn(offline && "opacity-50")}
            onClick={() => {
              if (offline || uploading) return;
              inputRef.current?.click();
            }}
            data-testid="workspace-avatar-change"
          >
            {uploading && (
              <Loader2 aria-hidden="true" className="spinner-busy" />
            )}
            {uploading ? "올리는 중" : "이미지 변경"}
          </Button>
          <p className="text-meta text-ink-muted">
            PNG, JPG, WebP. 5MB까지. 오너와 관리자가 바꿀 수 있습니다.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={onPick}
          data-testid="workspace-avatar-input"
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
      {denied && (
        <OperatorNotice
          who="워크스페이스 아바타는 오너와 관리자만 바꿀 수 있습니다."
          contact="바꿔야 한다면 이 워크스페이스의 오너에게 문의하세요."
        />
      )}
      {localError && (
        <p className="text-meta text-danger" role="alert" data-testid="workspace-avatar-local-error">
          {localError}
        </p>
      )}
      {serverError && (
        <p className="text-meta text-danger" role="alert" data-testid="workspace-avatar-error">
          {serverError}
        </p>
      )}
    </div>
  );
}

/**
 * Leave the current workspace (ADR-0161 D4).
 *
 * The confirmation is the house `ConfirmButton`, not a hand-rolled two-state
 * pair. The first cut here WAS hand-rolled, and design review measured the three
 * things this component exists to prevent (3R H-2): focus was born ON the
 * destructive button (the node was reused, so Enter-Enter left the workspace and
 * signed the reader out in one breath), Esc while the question stood closed the
 * whole settings surface instead of the question, and there was no question
 * sentence at all — the reused node just faded `danger-fill` in under
 * `transition-colors`, showing bare text on the first frame. `ConfirmButton`
 * answers all three (focus moves to the question group, `useEscapeLayer` claims
 * Esc, the question is its own named node), which is why four other settings
 * sections already use it.
 *
 * The pending signal USED TO ride a sibling status line, because the shared
 * component had no axis for it and adding one would have touched four other call
 * sites. #1490 added the axis (`busy` + `busyLabel`), so the word now rides the
 * trigger itself — which is both where the focus is when the write goes out and
 * the only node whose grey the reader was reading as a refusal (#1502).
 *
 * The last owner is refused by the server (409) and told to transfer ownership
 * first; on success the local session is cleared, since with a single session
 * leaving *is* signing out (multi-workspace switching is ADR-0161 4b-3). That
 * cost is stated in the question itself (3R M-2), not only in the body copy.
 */
/**
 * Four workspace role display names. Names only: the wire role and the
 * permission ladder stay the same. Empty field + save drops that override.
 */
function RoleLabelsEditor({
  workspaceId,
  labels,
  offline,
}: {
  workspaceId: string;
  labels: RoleLabels;
  offline: boolean;
}) {
  const { session } = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const client = useQueryClient();
  const self = memberFor(directoryQuery.directory, session.member.id);
  const canEdit = isWorkspaceOperator(self?.role);
  const [draft, setDraft] = useState(() => draftFromRoleLabels(labels));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RoleKey, string>>>(
    {}
  );
  // SaveButton is type=submit. A click fires onClick then the form submit, so
  // the same handler must no-op the second call in the same tick.
  const saveStarted = useRef(false);

  useEffect(() => {
    setDraft(draftFromRoleLabels(labels));
    setFieldErrors({});
  }, [labels]);

  const payload = buildRoleLabelsPayload(draft);
  const dirty = !roleLabelsEqual(payload, Object.keys(labels).length === 0 ? null : labels);
  const hasFieldError = ROLE_KEYS.some((key) => roleLabelFieldError(draft[key]));
  const canSave = canEdit && dirty && !hasFieldError && !offline;

  const save = useMutation({
    mutationFn: (next: RoleLabels | null) =>
      patchWorkspaceSettings(workspaceId, { role_labels: next }),
    onSuccess: (_result, next) => {
      saveStarted.current = false;
      const roleLabels = next ?? {};
      client.setQueryData(
        workspaceIdentityKey(workspaceId),
        (current: { roleLabels?: RoleLabels } | undefined) =>
          current ? { ...current, roleLabels } : current
      );
    },
    onError: () => {
      saveStarted.current = false;
    },
  });
  const denied = save.isError && isOperatorDenied(save.error);

  const handleChange = (key: RoleKey, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({
      ...current,
      [key]: roleLabelFieldError(value) ?? undefined,
    }));
  };

  const handleSave = () => {
    if (!canSave || save.isPending || saveStarted.current) return;
    const errors: Partial<Record<RoleKey, string>> = {};
    for (const key of ROLE_KEYS) {
      const error = roleLabelFieldError(draft[key]);
      if (error) errors[key] = error;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    saveStarted.current = true;
    save.mutate(payload);
  };

  const readOnly = !canEdit;
  const confirmedNonOperator = readOnly && directoryQuery.isSuccess;
  const locked = readOnly || offline;
  const effectiveRows = ROLE_KEYS.map((key) => {
    const override = labels[key]?.trim();
    return {
      key: DEFAULT_ROLE_LABELS[key],
      value: override || DEFAULT_ROLE_LABELS[key],
      prose: true,
    };
  });

  return (
    <Subsection
      title="역할 표시명"
      lines={[
        "이름만 바뀝니다. 권한은 그대로입니다. 소유자를 마스터로 불러도 권한 체계는 같습니다.",
        "칸을 비우고 저장하면 기본 이름으로 돌아갑니다.",
      ]}
    >
      {(confirmedNonOperator || denied) && (
        <OperatorNotice
          who={
            denied
              ? roleLabelsSaveMessage(save.error)
              : "역할 표시명은 워크스페이스 오너와 관리자만 바꿀 수 있습니다."
          }
          contact="바꿔야 한다면 이 워크스페이스의 오너에게 문의하세요."
        />
      )}
      {confirmedNonOperator ? (
        <div data-testid="workspace-role-labels">
          <KeyValueRows rows={effectiveRows} />
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
          data-testid="workspace-role-labels"
        >
          {ROLE_KEYS.map((key) => {
            const fieldId = `role-label-${key}`;
            const error = fieldErrors[key];
            return (
              <Field
                key={key}
                label={DEFAULT_ROLE_LABELS[key]}
                htmlFor={fieldId}
                hint={
                  locked
                    ? undefined
                    : `${DEFAULT_ROLE_LABELS[key]}의 표시 이름입니다. 비우면 이 기본 이름이 쓰입니다.`
                }
                error={error}
              >
                <Input
                  id={fieldId}
                  name={fieldId}
                  value={draft[key]}
                  placeholder={DEFAULT_ROLE_LABELS[key]}
                  readOnly={locked}
                  aria-readonly={locked || undefined}
                  className={cn(locked && "opacity-50")}
                  onChange={(event) => {
                    if (locked) return;
                    handleChange(key, event.target.value);
                  }}
                  data-testid={fieldId}
                />
              </Field>
            );
          })}
          {offline && canEdit && (
            <p className="text-meta text-ink-muted" id="workspace-role-labels-offline">
              연결이 끊겨 지금은 표시 이름을 저장할 수 없습니다.
            </p>
          )}
          {save.isError && !denied && (
            <p
              className="text-meta text-danger"
              role="alert"
              data-testid="workspace-role-labels-save-error"
            >
              {roleLabelsSaveMessage(save.error)}
            </p>
          )}
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <SaveButton
                label="표시명 저장"
                canSave={canSave}
                busy={save.isPending}
                onSave={handleSave}
                testId="workspace-role-labels-save"
              />
            </div>
          )}
        </form>
      )}
    </Subsection>
  );
}

const WELCOME_AGENT_DEFAULT_LABEL = "기본값 (첫 활성 에이전트)";

/**
 * Operator-only welcome kickoff fields (#1800 pattern: non-optimistic save,
 * in-place confirm, SaveButton/Field). Non-operators see KeyValueRows.
 */
function WelcomeKickoffEditor({
  workspaceId,
  agentMemberId,
  prompt,
  offline,
}: {
  workspaceId: string;
  agentMemberId: string | null;
  prompt: string;
  offline: boolean;
}) {
  const { session } = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const client = useQueryClient();
  const self = memberFor(directoryQuery.directory, session.member.id);
  const canEdit = isWorkspaceOperator(self?.role);
  const agents = directoryQuery.directory.members.filter(
    (member) => member.kind === "agent" && member.status === "active"
  );
  const [draftAgent, setDraftAgent] = useState(agentMemberId ?? "");
  const [draftPrompt, setDraftPrompt] = useState(prompt);
  const [promptError, setPromptError] = useState<string | null>(null);
  const saveStarted = useRef(false);

  useEffect(() => {
    setDraftAgent(agentMemberId ?? "");
    setDraftPrompt(prompt);
    setPromptError(null);
  }, [agentMemberId, prompt]);

  const savedAgent = agentMemberId ?? "";
  const dirty = draftAgent !== savedAgent || draftPrompt !== prompt;
  const canSave = canEdit && dirty && !promptError && !offline;

  const save = useMutation({
    mutationFn: () =>
      patchWorkspaceSettings(workspaceId, {
        welcome_agent_member_id: draftAgent === "" ? null : draftAgent,
        welcome_prompt: draftPrompt,
      }),
    onSuccess: () => {
      saveStarted.current = false;
      client.setQueryData(
        workspaceIdentityKey(workspaceId),
        (
          current:
            | { welcomeAgentMemberId?: string | null; welcomePrompt?: string }
            | undefined
        ) =>
          current
            ? {
                ...current,
                welcomeAgentMemberId: draftAgent === "" ? null : draftAgent,
                welcomePrompt: draftPrompt,
              }
            : current
      );
    },
    onError: () => {
      saveStarted.current = false;
    },
  });
  const denied = save.isError && isOperatorDenied(save.error);

  const handlePromptChange = (value: string) => {
    setDraftPrompt(value);
    setPromptError(welcomePromptTooLong(value));
  };

  const handleSave = () => {
    if (!canSave || save.isPending || saveStarted.current) return;
    const tooLong = welcomePromptTooLong(draftPrompt);
    setPromptError(tooLong);
    if (tooLong) return;
    saveStarted.current = true;
    save.mutate();
  };

  const readOnly = !canEdit;
  const confirmedNonOperator = readOnly && directoryQuery.isSuccess;
  const locked = readOnly || offline;
  const agentLabel =
    agents.find((member) => uuidEq(member.id, agentMemberId ?? ""))?.displayName ??
    WELCOME_AGENT_DEFAULT_LABEL;

  return (
    <Subsection
      title="웰컴 킥오프"
      lines={[
        "새로 들어온 사람에게 첫 메시지를 보내는 에이전트와 프롬프트입니다.",
        "비워 두면 첫 활성 에이전트와 서버 기본 프롬프트가 쓰입니다.",
      ]}
    >
      {(confirmedNonOperator || denied) && (
        <OperatorNotice
          who={
            denied
              ? errorMessage(save.error)
              : "웰컴 킥오프는 워크스페이스 오너와 관리자만 바꿀 수 있습니다."
          }
          contact="바꿔야 한다면 이 워크스페이스의 오너에게 문의하세요."
        />
      )}
      {confirmedNonOperator ? (
        <div data-testid="workspace-welcome-kickoff">
          <KeyValueRows
            rows={[
              { key: "웰컴 에이전트", value: agentLabel, prose: true },
              {
                key: "웰컴 프롬프트",
                value: prompt || WELCOME_AGENT_DEFAULT_LABEL,
                prose: true,
              },
            ]}
          />
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
          data-testid="workspace-welcome-kickoff"
        >
          <Field
            label="웰컴 에이전트"
            htmlFor="welcome-agent"
            hint={
              locked
                ? undefined
                : "비우면 첫 활성 에이전트가 웰컴을 보냅니다."
            }
          >
            <Select
              id="welcome-agent"
              name="welcome-agent"
              value={draftAgent}
              disabled={locked}
              onChange={(event) => {
                if (locked) return;
                setDraftAgent(event.target.value);
              }}
              data-testid="welcome-agent"
            >
              <option value="">{WELCOME_AGENT_DEFAULT_LABEL}</option>
              {agents.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="웰컴 프롬프트"
            htmlFor="welcome-prompt"
            hint={
              locked
                ? undefined
                : `${WELCOME_PROMPT_MAX_CHARS}자까지 쓸 수 있습니다.`
            }
            error={promptError}
          >
            <textarea
              id="welcome-prompt"
              name="welcome-prompt"
              value={draftPrompt}
              rows={4}
              readOnly={locked}
              aria-readonly={locked || undefined}
              className={cn(
                "w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                locked && "opacity-50"
              )}
              onChange={(event) => {
                if (locked) return;
                handlePromptChange(event.target.value);
              }}
              data-testid="welcome-prompt"
            />
          </Field>
          {offline && canEdit && (
            <p className="text-meta text-ink-muted" id="workspace-welcome-offline">
              연결이 끊겨 지금은 웰컴 설정을 저장할 수 없습니다.
            </p>
          )}
          {save.isError && !denied && (
            <p
              className="text-meta text-danger"
              role="alert"
              data-testid="workspace-welcome-save-error"
            >
              {errorMessage(save.error)}
            </p>
          )}
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <SaveButton
                label="웰컴 저장"
                canSave={canSave}
                busy={save.isPending}
                onSave={handleSave}
                testId="workspace-welcome-save"
              />
            </div>
          )}
        </form>
      )}
    </Subsection>
  );
}

function LeaveWorkspace({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const session = useSession();

  const leave = useMutation({
    mutationFn: () => leaveWorkspace(workspaceId),
    onSuccess: () => {
      // 나가면 이 세션은 끝이다: 서버가 이미 토큰을 파기했고, 로컬도 정리한다.
      session.logout();
    },
  });

  const lastOwner =
    leave.isError && leave.error instanceof ApiError && leave.error.status === 409;
  const otherError = leave.isError && !lastOwner ? errorMessage(leave.error) : null;

  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-line bg-surface-raised p-4">
      <h3 className="text-body font-medium text-ink">워크스페이스 나가기</h3>
      <p className="text-meta text-ink-muted">
        이 워크스페이스에서 내 멤버십을 끝냅니다. 다시 들어오려면 초대가 필요합니다.
      </p>
      {lastOwner && (
        <p className="text-meta text-danger" role="alert" data-testid="workspace-leave-last-owner">
          마지막 오너는 나갈 수 없습니다. 먼저 다른 사람에게 오너를 넘기세요.
        </p>
      )}
      {otherError && (
        <p className="text-meta text-danger" role="alert" data-testid="workspace-leave-error">
          {otherError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* 진행은 잠금이 아니다 (#1403 리뷰 H-1 · #1486 문법). 이 버튼은 자기가
            낸 쓰기로 자신을 잠그고 있었고, 그래서 나가기를 누른 사람 앞의 트리거가
            회색이 됐다 — 「당신은 이걸 못 한다」로 읽히는 칠이다. 진행을 말하는
            일은 그 옆의 형제 상태 줄 하나가 대신 지고 있었다.

            #1490 이 `ConfirmButton` 에 `busy` 를 실은 뒤로는 그 줄이 있을 이유가
            없다. 낱말은 트리거 자신이 진다 — 확정이 질문을 먼저 닫으므로 쓰기가
            나가는 순간 초점이 서 있는 자리가 거기다. 잠그는 사실로 남는 것은
            오프라인 하나다. 형제 줄을 함께 두면 100px 안에 같은 낱말이 둘 서고,
            그중 하나는 회색 버튼 옆에서 자기가 무엇의 진행인지 말하지 못한다. */}
        <ConfirmButton
          label="워크스페이스 나가기"
          question="나가면 멤버십이 끝나고, 확인하면 바로 로그아웃됩니다. 다시 들어오려면 초대가 필요합니다."
          confirmLabel="나가기"
          disabled={offline}
          busy={leave.isPending}
          busyLabel="나가는 중"
          onConfirm={() => leave.mutate()}
          testId="workspace-leave"
        />
      </div>
    </div>
  );
}

export function WorkspaceSection({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const query = useQuery({
    queryKey: workspaceIdentityKey(workspaceId),
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
  });

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    slug?: string;
    name?: string;
  }>({});
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);

  const create = useMutation({
    mutationFn: () => createWorkspace(normalizeSlug(slug), name.trim()),
    onSuccess: (result) => {
      setCreated(result);
      setSlug("");
      setName("");
      setFieldErrors({});
    },
    onError: (error) => {
      if (isSlugConflict(error)) {
        setFieldErrors({ slug: "이미 쓰이는 슬러그입니다. 다른 값을 고르세요." });
      }
    },
  });

  const creating = create.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // 잠금이 `aria-disabled` 라 클릭도 Enter 도 막지 않는다 (그것이 요점이다 —
    // 초점을 잃지 않는다). 막는 일은 핸들러가 지고, 버튼이 아니라 폼이 지는
    // 이유는 슬러그 칸에서 누른 Enter 도 같은 쓰기를 내기 때문이다 (#1541).
    if (offline || creating) return;
    const errors = {
      slug: slugError(slug) ?? undefined,
      name: workspaceNameError(name) ?? undefined,
    };
    setFieldErrors(errors);
    if (errors.slug || errors.name) return;
    setCreated(null);
    create.mutate();
  }

  const lines = [
    "지금 열려 있는 워크스페이스를 확인하고, 새 워크스페이스를 만듭니다.",
    "새 워크스페이스는 만든 사람이 오너가 되고 #general 채널 하나로 시작합니다.",
  ];

  return (
    <SectionShell title="워크스페이스" lines={lines}>
      {query.isPending && <Skeleton ready={false} rows={3} />}
      {query.isError && (
        <InlineBanner
          message={errorMessage(query.error)}
          actionLabel="다시 시도"
          onAction={() => void query.refetch()}
          testId="workspace-error"
        />
      )}
      {query.data && (
        <div
          className="flex flex-col gap-3 rounded-md border border-line bg-surface-raised p-4"
          data-testid="workspace-card"
        >
          <h3 className="text-body font-medium text-ink">{query.data.name}</h3>
          <WorkspaceAvatarField
            workspaceId={workspaceId}
            avatarUrl={query.data.avatarUrl}
            offline={offline}
          />
          <KeyValueRows
            rows={[
              { key: "슬러그", value: query.data.slug },
              { key: "워크스페이스 ID", value: query.data.id, numeric: true },
            ]}
          />
        </div>
      )}

      {query.data && (
        <RoleLabelsEditor
          workspaceId={workspaceId}
          labels={query.data.roleLabels}
          offline={offline}
        />
      )}

      {query.data && (
        <WelcomeKickoffEditor
          workspaceId={workspaceId}
          agentMemberId={query.data.welcomeAgentMemberId}
          prompt={query.data.welcomePrompt}
          offline={offline}
        />
      )}

      <WorkspaceUnfurlSetting workspaceId={workspaceId} offline={offline} />

      {query.data && <LeaveWorkspace workspaceId={workspaceId} offline={offline} />}

      <h3 className="text-body font-medium text-ink">새 워크스페이스 만들기</h3>

      {create.isError && isOperatorDenied(create.error) ? (
        <OperatorNotice
          who="새 워크스페이스는 이 서버의 운영자만 만들 수 있습니다."
          contact="워크스페이스가 필요하면 이 서버를 운영하는 사람에게 문의하세요."
        />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={submit}
          data-testid="workspace-create-form"
        >
          <Field
            label="이름"
            htmlFor="workspace-name"
            hint="사람이 읽는 이름입니다. 80자까지 쓸 수 있습니다."
            error={fieldErrors.name}
          >
            <Input
              id="workspace-name"
              name="name"
              value={name}
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={
                fieldErrors.name ? "workspace-name-error" : undefined
              }
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field
            label="슬러그"
            htmlFor="workspace-slug"
            hint="영문 소문자, 숫자, 하이픈만 쓸 수 있습니다. 서버 전체에서 하나뿐이어야 합니다."
            error={fieldErrors.slug}
          >
            <Input
              id="workspace-slug"
              name="slug"
              value={slug}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={Boolean(fieldErrors.slug)}
              aria-describedby={
                fieldErrors.slug ? "workspace-slug-error" : undefined
              }
              onChange={(e) => setSlug(e.target.value)}
            />
          </Field>

          {create.isError && !isSlugConflict(create.error) && (
            <p className="text-meta text-danger" role="alert">
              {errorMessage(create.error)}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/* 낱말을 갈면서 그 낱말을 native `disabled` 로 함께 흐리고 있었다
                (#1541) — 만들기를 누른 사람 앞에서 「만드는 중」이 opacity-50
                아래로 들어가고, 방금 Enter 를 누른 손에서 초점이 <body> 로
                떨어졌다. 진행은 `aria-busy` 와 낱말이, 잠금은 오프라인 하나가
                진다. 위 「워크스페이스 나가기」와 같은 문법이다. */}
            <Button
              type="submit"
              size="sm"
              aria-disabled={offline || undefined}
              aria-busy={creating || undefined}
              className={cn(offline && "opacity-50")}
              data-testid="workspace-create"
            >
              {creating ? "만드는 중" : "워크스페이스 만들기"}
            </Button>
          </div>
        </form>
      )}

      {created && (
        <div
          className="flex flex-col gap-2 rounded-md border border-ok bg-surface-raised p-4"
          role="status"
          data-testid="workspace-created"
        >
          <p className="text-body text-ink">
            {created.name} 워크스페이스를 만들었습니다.
          </p>
          <KeyValueRows
            rows={[
              { key: "슬러그", value: created.slug },
              { key: "워크스페이스 ID", value: created.workspaceId, numeric: true },
            ]}
          />
          <p className="text-meta text-ink-muted">
            새 워크스페이스로는 그 슬러그로 다시 로그인해서 들어갑니다.
          </p>
        </div>
      )}
    </SectionShell>
  );
}
