import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { AiPill, AiSection, AiSectionHead } from "@/features/settings/aiAccountsParts";
import { rosterQueryKey, useDirectory } from "@/features/workspace/useWorkspace";
import {
  createPersonalKeyAgent,
  listMyPersonalKeys,
  PERSONAL_KEYS_COPY as COPY,
  personalAgentDefaults,
  personalAgentHandleValid,
  personalKeyErrorMessage,
  revokePersonalKey,
  type PersonalKey,
} from "@momo/core/features/ai/personalKeys";
import { companyOfKey, keyDate, personalKeysQueryKey, personalKeysQueryPrefix } from "./personalKeysShared";
import { PersonalKeyRevokeDialog } from "./PersonalKeyRevokeDialog";

// =============================================================================
// 「받은 개인 키」 (#3469). AI › 내 AI 계정 아래. 운영자가 나에게 발급한 키만 보인다
// (`GET …/personal-keys/mine`: 서버가 보는 사람을 정한다). 줄마다 「이 키로 에이전트
// 만들기」(내 전용 에이전트, 한 사람에 하나)와 「회수」(내 키는 내가 회수할 수 있다).
// 키 값은 어디에도 없다: 이 화면은 값을 받지도 보여 주지도 않는다.
// =============================================================================

export function MyPersonalKeysSection({ offline }: { offline: boolean }) {
  const { workspaceId, session } = useSession();
  const client = useQueryClient();
  const keys = useQuery({
    queryKey: personalKeysQueryKey(workspaceId, "mine"),
    queryFn: () => listMyPersonalKeys(workspaceId),
    retry: false,
  });
  const directory = useDirectory(workspaceId);
  const myAgent =
    (directory.data ?? []).find(
      (member) =>
        member.kind === "agent" &&
        member.brain === "personal_key" &&
        member.ownerHumanId?.toLowerCase() === session.member.id.toLowerCase()
    ) ?? null;

  const [creating, setCreating] = useState<PersonalKey | null>(null);
  const [revoking, setRevoking] = useState<PersonalKey | null>(null);
  const [createdHandle, setCreatedHandle] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  const revoke = useMutation({
    mutationFn: (keyId: string) => revokePersonalKey(workspaceId, keyId),
    onSuccess: () => {
      setRevoking(null);
      void client.invalidateQueries({ queryKey: personalKeysQueryPrefix(workspaceId) });
    },
  });

  const list = keys.data ?? [];
  return (
    <AiSection labelledBy="ai-my-personal-keys-title" testId="ai-my-personal-keys">
      <AiSectionHead id="ai-my-personal-keys-title" title={COPY.mine.heading} scope={COPY.mine.scope} />
      <p className="max-w-2xl break-keep pt-3 text-meta text-ink-muted">{COPY.mine.body}</p>
      {createdHandle && (
        <p className="break-keep pt-2 text-meta text-ink" role="status" data-testid="ai-my-personal-keys-created">
          {COPY.agentDialog.created(createdHandle)}
        </p>
      )}
      {keys.isPending ? (
        <Skeleton ready={false} rows={1} className="py-3" />
      ) : keys.isError ? (
        <InlineBanner
          message={COPY.mine.loadFailed}
          actionLabel={COPY.retry}
          onAction={() => void keys.refetch()}
          testId="ai-my-personal-keys-error"
        />
      ) : list.length === 0 ? (
        <p className="px-2 py-3 text-body text-ink-muted" data-testid="ai-my-personal-keys-empty">
          {COPY.mine.empty}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col" aria-label={COPY.mine.heading} data-testid="ai-my-personal-keys-list">
          {list.map((key) => (
            <li
              key={key.id}
              className="flex min-w-0 flex-col gap-2 border-b border-line px-2 py-3"
              data-testid="ai-my-personal-key-row"
              data-status={key.status}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-body font-semibold text-ink">{companyOfKey(key)}</span>
                <AiPill tone={key.status === "active" ? "ok" : "mute"}>{COPY.status[key.status]}</AiPill>
                <span className="text-meta text-ink-muted">
                  {key.revokedAtMs !== null
                    ? COPY.revokedAt(keyDate(key.revokedAtMs))
                    : COPY.mine.issuedOn(keyDate(key.issuedAtMs))}
                </span>
              </div>
              {key.label && <span className="break-keep text-meta text-ink-muted [overflow-wrap:anywhere]">{key.label}</span>}
              {key.status === "active" && (
                <div className="flex flex-wrap items-center gap-2">
                  {myAgent ? (
                    <span className="break-keep text-meta text-ink-muted" data-testid="ai-my-personal-key-agent">
                      {myAgent.handle ? COPY.mine.hasAgent(myAgent.handle) : COPY.mine.hasAgentUnnamed}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      aria-haspopup="dialog"
                      className={cn("tap-target", offline && "opacity-50 hover:opacity-50")}
                      aria-disabled={offline || undefined}
                      onClick={(event) => {
                        if (offline) return;
                        opener.current = event.currentTarget;
                        setCreating(key);
                      }}
                      data-testid="ai-my-personal-key-create-agent"
                    >
                      {COPY.mine.createAgent}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-haspopup="dialog"
                    className="tap-target bg-surface text-danger shadow-sm"
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      revoke.reset();
                      setRevoking(key);
                    }}
                    data-testid="ai-my-personal-key-revoke"
                  >
                    {COPY.mine.revoke}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={creating !== null} onOpenChange={(open) => !open && setCreating(null)}>
        {creating && (
          <DialogContent opener={opener.current} className="gap-0" data-testid="ai-my-personal-agent-dialog">
            <AgentForm
              key={creating.id}
              keyRow={creating}
              memberName={session.member.displayName}
              memberHandle={session.member.handle}
              workspaceId={workspaceId}
              offline={offline}
              onClose={() => setCreating(null)}
              onCreated={(handle) => {
                setCreatedHandle(handle);
                setCreating(null);
                void client.invalidateQueries({ queryKey: personalKeysQueryPrefix(workspaceId) });
                void client.invalidateQueries({ queryKey: rosterQueryKey(workspaceId) });
              }}
            />
          </DialogContent>
        )}
      </Dialog>
      <PersonalKeyRevokeDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        opener={opener}
        title={revoking ? COPY.revokeDialog.title(session.member.displayName, companyOfKey(revoking)) : ""}
        body={revoking ? COPY.revokeDialog.body(session.member.displayName) : ""}
        busy={revoke.isPending}
        offline={offline}
        error={revoke.isError ? personalKeyErrorMessage(revoke.error, "revoke") : null}
        onConfirm={() => {
          if (revoking && !revoke.isPending && !offline) revoke.mutate(revoking.id);
        }}
      />
    </AiSection>
  );
}

function AgentForm({
  keyRow,
  memberName,
  memberHandle,
  workspaceId,
  offline,
  onClose,
  onCreated,
}: {
  keyRow: PersonalKey;
  memberName: string;
  memberHandle: string;
  workspaceId: string;
  offline: boolean;
  onClose: () => void;
  onCreated: (handle: string) => void;
}) {
  const company = companyOfKey(keyRow);
  const initial = personalAgentDefaults({ memberName, memberHandle, company, format: keyRow.format });
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [handle, setHandle] = useState(initial.handle);
  const [model, setModel] = useState("");
  const [attempted, setAttempted] = useState(false);
  const create = useMutation({
    mutationFn: (input: { displayName: string; handle: string; model: string }) =>
      createPersonalKeyAgent(workspaceId, keyRow.id, input),
    onSuccess: (agent) => onCreated(agent.handle),
  });
  const copy = COPY.agentDialog;
  const nameBad = displayName.trim() === "";
  const handleBad = !personalAgentHandleValid(handle);
  const modelBad = model.trim() === "";
  const locked = offline || create.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (locked || nameBad || handleBad || modelBad) return;
    create.mutate({ displayName: displayName.trim(), handle: handle.trim().toLowerCase(), model: model.trim() });
  }

  return (
    <>
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription className="break-keep">{copy.body}</DialogDescription>
      </div>
      <form
        onSubmit={submit}
        noValidate
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
        data-testid="ai-my-personal-agent-form"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="ai-my-personal-agent-name" className="text-meta font-semibold text-ink">
            {copy.displayName}
          </label>
          <Input
            id="ai-my-personal-agent-name"
            value={displayName}
            maxLength={100}
            autoComplete="off"
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={attempted && nameBad ? true : undefined}
            data-testid="ai-my-personal-agent-name"
          />
          {attempted && nameBad && (
            <p className="break-keep text-meta text-danger" role="alert">
              {copy.nameRequired}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="ai-my-personal-agent-handle" className="text-meta font-semibold text-ink">
            {copy.handle}
          </label>
          <Input
            id="ai-my-personal-agent-handle"
            value={handle}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setHandle(event.target.value)}
            aria-invalid={attempted && handleBad ? true : undefined}
            data-testid="ai-my-personal-agent-handle"
          />
          {attempted && handleBad ? (
            <p className="break-keep text-meta text-danger" role="alert">
              {copy.handleInvalid}
            </p>
          ) : (
            <p className="break-keep text-meta text-ink-muted">{copy.handleHint}</p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="ai-my-personal-agent-model" className="text-meta font-semibold text-ink">
            {copy.model}
          </label>
          <Input
            id="ai-my-personal-agent-model"
            value={model}
            autoComplete="off"
            spellCheck={false}
            placeholder={copy.modelPlaceholder[keyRow.format]}
            onChange={(event) => setModel(event.target.value)}
            aria-invalid={attempted && modelBad ? true : undefined}
            data-testid="ai-my-personal-agent-model"
          />
          {attempted && modelBad ? (
            <p className="break-keep text-meta text-danger" role="alert">
              {copy.modelRequired}
            </p>
          ) : (
            <p className="break-keep text-meta text-ink-muted">{copy.modelHint}</p>
          )}
        </div>
        {create.isError && (
          <p className="break-keep text-meta text-danger" role="alert" data-testid="ai-my-personal-agent-error">
            {personalKeyErrorMessage(create.error, "agent")}
          </p>
        )}
        {offline && <p className="break-keep text-meta text-ink-muted">{COPY.form.offline}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" className="tap-target" onClick={onClose} data-testid="ai-my-personal-agent-cancel">
            {copy.cancel}
          </Button>
          <Button
            type="submit"
            size="sm"
            className={cn("tap-target", offline && !create.isPending && "opacity-50 hover:opacity-50")}
            aria-disabled={locked || undefined}
            aria-busy={create.isPending || undefined}
            data-testid="ai-my-personal-agent-submit"
          >
            {create.isPending ? copy.submitting : copy.submit}
          </Button>
        </div>
      </form>
    </>
  );
}
