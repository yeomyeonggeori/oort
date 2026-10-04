import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { cn } from "@/design/lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { AiPill } from "@/features/settings/aiAccountsParts";
import { useDirectory } from "@/features/workspace/useWorkspace";
import { glossaryEntry } from "@momo/core/features/ai/aiHubModel";
import {
  issuePersonalKey,
  listPersonalKeys,
  PERSONAL_KEYS_COPY as COPY,
  personalKeyErrorMessage,
  revokePersonalKey,
  type PersonalKey,
} from "@momo/core/features/ai/personalKeys";
import { teamKeyPresets } from "@momo/core/features/settings/teamKeyForm";
import type { ProviderLink } from "@momo/core/features/settings/api";
import {
  companyOfKey,
  issuableHolders,
  keyDate,
  personalKeysQueryKey,
  personalKeysQueryPrefix,
} from "./personalKeysShared";
import { PersonalKeyRevokeDialog } from "./PersonalKeyRevokeDialog";

// =============================================================================
// 「개인 API 키」 운영자 구획 (#3469, 서버 #3415). 팀 AI 키 화면 아래.
//
// 운영자가 멤버 한 사람에게 키를 발급하고, 목록(받는 사람 · 회사 · 발급일 · 상태)에서 회수한다.
// 이 구획은 운영자 판정(`GET /v1/provider/link` 200)이 난 뒤에만 그려지고, 그때만 목록을
// 읽는다: 비운영자가 403을 부르지 않는다.
//
// 키 값은 쓰기 전용이다. 키 칸은 비제어 password 칸이고(팀 키 폼과 같은 방식), 값은
// 제출하는 순간 ref로 옮겨 칸을 비우며 `mutationFn` 안에서 꺼내 쓰고 지운다. React 상태·
// 뮤테이션 변수·쿼리 캐시·로그·DOM 어디에도 남기지 않고, 다시 그려 보여 주지도 않는다.
// =============================================================================

const OFFLINE_NOTE_ID = "ai-personal-keys-offline";
const COLS = "sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)_4rem]";
const HINT_ID = "ai-personal-issue-key-hint";

export function PersonalKeysOperatorSection({
  workspaceId,
  offline,
  link,
}: {
  workspaceId: string;
  offline: boolean;
  link: ProviderLink;
}) {
  const client = useQueryClient();
  const keys = useQuery({
    queryKey: personalKeysQueryKey(workspaceId, "all"),
    queryFn: () => listPersonalKeys(workspaceId),
    retry: false,
  });
  const directory = useDirectory(workspaceId);
  const roster = directory.data ?? [];
  const nameOf = (id: string) => roster.find((member) => member.id.toLowerCase() === id)?.displayName ?? COPY.holderGone;

  const [issueOpen, setIssueOpen] = useState(false);
  const [revoking, setRevoking] = useState<PersonalKey | null>(null);
  const issueRef = useRef<HTMLButtonElement>(null);
  const revokeOpener = useRef<HTMLButtonElement | null>(null);

  const revoke = useMutation({
    mutationFn: (keyId: string) => revokePersonalKey(workspaceId, keyId),
    onSuccess: () => {
      setRevoking(null);
      void client.invalidateQueries({ queryKey: personalKeysQueryPrefix(workspaceId) });
    },
  });

  const list = keys.data ?? [];
  const holders = useMemo(() => issuableHolders(roster, list), [roster, list]);
  const presets = teamKeyPresets(link);
  const entry = glossaryEntry("personalKey");

  return (
    <section aria-labelledby="ai-personal-keys-title" className="flex min-w-0 flex-col" data-testid="ai-personal-keys">
      <div className="flex min-w-0 flex-wrap items-center gap-3 border-b border-line pb-2">
        <h3 id="ai-personal-keys-title" className="text-body font-bold text-ink">
          {COPY.heading}
        </h3>
        <span className="text-meta text-ink-muted">{COPY.operatorScope}</span>
        <span className="flex-1" />
        <Button
          ref={issueRef}
          type="button"
          size="sm"
          className={cn("tap-target", offline && "opacity-50 hover:opacity-50")}
          aria-disabled={offline || undefined}
          aria-haspopup="dialog"
          aria-describedby={offline ? OFFLINE_NOTE_ID : undefined}
          onClick={() => {
            if (!offline) setIssueOpen(true);
          }}
          data-testid="ai-personal-issue"
        >
          <Plus aria-hidden="true" />
          {COPY.issue}
        </Button>
      </div>
      <p className="max-w-2xl break-keep pt-3 text-meta text-ink-muted">
        <span className="me-1 inline-flex whitespace-nowrap rounded-sm bg-muted-soft px-1 py-px text-timestamp font-semibold">
          {entry.term}
        </span>
        {COPY.operatorBody}
      </p>
      {offline && (
        <p id={OFFLINE_NOTE_ID} className="break-keep pt-2 text-meta text-ink-muted">
          {COPY.form.offline}
        </p>
      )}

      {keys.isPending ? (
        <Skeleton ready={false} rows={2} className="py-3" />
      ) : keys.isError ? (
        <InlineBanner
          message={COPY.loadFailed}
          actionLabel={COPY.retry}
          onAction={() => void keys.refetch()}
          testId="ai-personal-keys-error"
        />
      ) : list.length === 0 ? (
        <p className="px-2 py-3 text-body text-ink" data-testid="ai-personal-keys-empty">
          {COPY.empty}
        </p>
      ) : (
        <>
          <div
            className={cn("hidden gap-3 border-b border-line px-2 py-2 text-meta text-ink-muted sm:grid", COLS)}
            aria-hidden="true"
          >
            <span>{COPY.columns.holder}</span>
            <span>{COPY.columns.company}</span>
            <span>{COPY.columns.issuedAt}</span>
            <span>{COPY.columns.status}</span>
            <span />
          </div>
          <ul className="flex min-w-0 flex-col" aria-label={COPY.heading} data-testid="ai-personal-keys-list">
            {list.map((key) => (
              <li
                key={key.id}
                className="flex min-w-0 flex-col gap-2 border-b border-line px-2 py-3"
                data-testid="ai-personal-key-row"
                data-status={key.status}
              >
                <div className={cn("grid min-w-0 grid-cols-1 gap-2 sm:items-start sm:gap-3", COLS)}>
                  <span className="break-keep text-body font-semibold text-ink [overflow-wrap:anywhere]">
                    {nameOf(key.ownerMemberId)}
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-body text-ink">{companyOfKey(key)}</span>
                    {key.label && <span className="break-keep text-meta text-ink-muted [overflow-wrap:anywhere]">{key.label}</span>}
                  </div>
                  <span className="text-meta text-ink-muted">{keyDate(key.issuedAtMs)}</span>
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <AiPill tone={key.status === "active" ? "ok" : "mute"}>{COPY.status[key.status]}</AiPill>
                    {key.revokedAtMs !== null && (
                      <span className="text-timestamp text-ink-muted">{COPY.revokedAt(keyDate(key.revokedAtMs))}</span>
                    )}
                  </div>
                  {key.status === "active" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-haspopup="dialog"
                      className="tap-target w-max text-danger sm:justify-self-end"
                      onClick={(event) => {
                        revokeOpener.current = event.currentTarget;
                        revoke.reset();
                        setRevoking(key);
                      }}
                      data-testid="ai-personal-key-revoke"
                    >
                      {COPY.revoke}
                    </Button>
                  ) : (
                    <span aria-hidden="true" className="hidden sm:block" />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <IssueDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        opener={issueRef}
        workspaceId={workspaceId}
        offline={offline}
        holders={holders.map((member) => ({ id: member.id.toLowerCase(), name: member.displayName }))}
        presets={presets}
      />
      <PersonalKeyRevokeDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        opener={revokeOpener}
        title={revoking ? COPY.revokeDialog.title(nameOf(revoking.ownerMemberId), companyOfKey(revoking)) : ""}
        body={revoking ? COPY.revokeDialog.body(nameOf(revoking.ownerMemberId)) : ""}
        busy={revoke.isPending}
        offline={offline}
        error={revoke.isError ? personalKeyErrorMessage(revoke.error, "revoke") : null}
        onConfirm={() => {
          if (revoking && !revoke.isPending && !offline) revoke.mutate(revoking.id);
        }}
      />
    </section>
  );
}

interface IssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: React.RefObject<HTMLButtonElement | null>;
  workspaceId: string;
  offline: boolean;
  holders: { id: string; name: string }[];
  presets: ReturnType<typeof teamKeyPresets>;
}

function IssueDialog(props: IssueDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && (
        <DialogContent opener={props.opener.current} className="gap-0" data-testid="ai-personal-issue-dialog">
          <IssueForm {...props} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function IssueForm({ onOpenChange, workspaceId, offline, holders, presets }: IssueDialogProps) {
  const client = useQueryClient();
  const [holder, setHolder] = useState("");
  const [presetId, setPresetId] = useState(presets[0]?.id ?? "");
  const [holderError, setHolderError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const holderRef = useRef<HTMLSelectElement>(null);
  const secretRef = useRef("");
  const mutationKey = useMemo(() => ["personal-key-issue", workspaceId], [workspaceId]);

  const issue = useMutation({
    mutationKey,
    // 누른 순간 한 번만 시도한다: 끊긴 동안 멈춰 두었다가 나중에 보내지 않는다.
    networkMode: "always",
    // 변수에는 키가 없다(react-query가 마지막 변수를 캐시에 든다). 키는 ref에서 꺼내 바로 비운다.
    mutationFn: (input: { ownerMemberId: string; format: "openai" | "anthropic"; baseUrl: string; label?: string }) => {
      const apiKey = secretRef.current;
      secretRef.current = "";
      return issuePersonalKey(workspaceId, { ...input, apiKey });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: personalKeysQueryPrefix(workspaceId) });
      onOpenChange(false);
    },
  });

  // 창이 사라지면 붙잡은 값과 멈춘 저장을 버린다.
  useEffect(
    () => () => {
      secretRef.current = "";
      const cache = client.getMutationCache();
      for (const mutation of cache.findAll({ mutationKey, exact: true })) {
        if (mutation.state.isPaused) cache.remove(mutation);
      }
    },
    [client, mutationKey]
  );

  const preset = presets.find((row) => row.id === presetId) ?? null;
  const locked = offline || issue.isPending || preset === null || holders.length === 0;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (offline || issue.isPending || preset === null) return;
    if (holder === "") {
      setHolderError(COPY.form.holderRequired);
      holderRef.current?.focus();
      return;
    }
    setHolderError(null);
    const field = keyRef.current;
    const value = field?.value.trim() ?? "";
    if (value === "") {
      setFieldError(COPY.form.keyRequired);
      field?.focus();
      return;
    }
    setFieldError(null);
    secretRef.current = value;
    if (field) field.value = "";
    const label = labelRef.current?.value.trim() ?? "";
    issue.mutate({
      ownerMemberId: holder,
      format: preset.format,
      baseUrl: preset.baseUrl,
      ...(label === "" ? {} : { label }),
    });
  }

  return (
    <>
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>{COPY.form.title}</DialogTitle>
        <DialogDescription className="break-keep">{COPY.operatorBody}</DialogDescription>
      </div>
      <form
        onSubmit={submit}
        noValidate
        autoComplete="off"
        data-form-type="other"
        aria-label={COPY.form.title}
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
        data-testid="ai-personal-issue-form"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="ai-personal-issue-holder" className="text-meta font-semibold text-ink">
            {COPY.form.holder}
          </label>
          {holders.length === 0 ? (
            <p className="break-keep text-meta text-ink-muted" data-testid="ai-personal-issue-no-holder">
              {COPY.form.noHolder}
            </p>
          ) : (
            <Select
              id="ai-personal-issue-holder"
              ref={holderRef}
              value={holder}
              onChange={(event) => {
                setHolder(event.target.value);
                setHolderError(null);
              }}
              aria-invalid={holderError ? true : undefined}
              data-testid="ai-personal-issue-holder"
            >
              <option value="">{COPY.form.holderPlaceholder}</option>
              {holders.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          )}
          {holderError && (
            <p className="break-keep text-meta text-danger" role="alert">
              {holderError}
            </p>
          )}
        </div>

        <fieldset className="flex min-w-0 flex-wrap gap-2">
          <legend className="mb-1 w-full text-meta font-semibold text-ink">{COPY.form.provider}</legend>
          {presets.length === 0 ? (
            <p className="break-keep text-meta text-ink-muted" data-testid="ai-personal-issue-no-presets">
              {COPY.form.noProviders}
            </p>
          ) : (
            presets.map((row) => (
              <label key={row.id} className="press relative inline-flex">
                <input
                  type="radio"
                  name="ai-personal-issue-provider"
                  value={row.id}
                  checked={presetId === row.id}
                  onChange={() => setPresetId(row.id)}
                  className="peer sr-only"
                  data-testid={`ai-personal-issue-preset-${row.id}`}
                />
                <span className="tap-target inline-flex h-control-sm min-w-0 max-w-full cursor-pointer items-center rounded-full border border-line px-3 text-meta font-semibold text-ink-muted peer-checked:border-ink peer-checked:bg-surface peer-checked:text-ink peer-focus-visible:focus-ring">
                  {row.label}
                </span>
              </label>
            ))
          )}
        </fieldset>

        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="ai-personal-issue-key" className="text-meta font-semibold text-ink">
            {COPY.form.key}
          </label>
          <Input
            id="ai-personal-issue-key"
            ref={keyRef}
            type="password"
            name="personal-api-key"
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            data-form-type="other"
            placeholder={COPY.form.keyPlaceholder}
            className="font-mono"
            aria-describedby={HINT_ID}
            aria-invalid={fieldError ? true : undefined}
            data-testid="ai-personal-issue-key"
          />
          {fieldError && (
            <p className="break-keep text-meta text-danger" role="alert">
              {fieldError}
            </p>
          )}
          <p id={HINT_ID} className="break-keep text-meta text-ink-muted">
            {COPY.form.keyHint}
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="ai-personal-issue-label" className="text-meta font-semibold text-ink">
            {COPY.form.label}
          </label>
          <Input
            id="ai-personal-issue-label"
            ref={labelRef}
            name="personal-key-label"
            autoComplete="off"
            maxLength={100}
            data-testid="ai-personal-issue-label"
          />
          <p className="break-keep text-meta text-ink-muted">{COPY.form.labelHint}</p>
        </div>

        <p className="break-keep text-meta text-ink-muted">{COPY.form.addressFixed}</p>

        {issue.isError && (
          <p className="break-keep text-meta text-danger" role="alert" data-testid="ai-personal-issue-error">
            {personalKeyErrorMessage(issue.error, "issue")} {COPY.form.keyCleared}
          </p>
        )}
        {offline && <p className="break-keep text-meta text-ink-muted">{COPY.form.offline}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="tap-target"
            onClick={() => onOpenChange(false)}
            data-testid="ai-personal-issue-cancel"
          >
            {COPY.form.cancel}
          </Button>
          <Button
            type="submit"
            size="sm"
            className={cn("tap-target", locked && !issue.isPending && "opacity-50 hover:opacity-50")}
            aria-disabled={locked || undefined}
            aria-busy={issue.isPending || undefined}
            data-testid="ai-personal-issue-submit"
          >
            {issue.isPending ? COPY.form.submitting : COPY.form.submit}
          </Button>
        </div>
      </form>
    </>
  );
}
