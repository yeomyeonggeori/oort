import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useTickingNow } from "@/features/agents/agentWorkingSignal";
import {
  ConfirmButton,
  Field,
  KeyValueRows,
  StatusChip,
} from "@/features/settings/SettingsFields";
import { ApiError } from "@momo/core/lib/api";
import { relativeLabel } from "@momo/core/features/inbox/model";
import {
  registerHostedDoorbell,
  unregisterHostedDoorbell,
} from "@momo/core/features/hostedAgents/api";
import {
  applyDoorbellRegistration,
  doorbellFailureMessage,
  doorbellLastStatusLabel,
  doorbellLastStatusTone,
  doorbellProjection,
  doorbellSecretIssue,
  doorbellUrlIssue,
  isDoorbellGateClosed,
  parseHostedDoorbellResponse,
  DOORBELL_BUSY_NOTE,
  DOORBELL_EMPTY_DETAIL,
  DOORBELL_EMPTY_HEADLINE,
  DOORBELL_FIRED_LABEL,
  DOORBELL_GATE_OFF_DETAIL,
  DOORBELL_GATE_OFF_HEADLINE,
  DOORBELL_HEADLINE,
  DOORBELL_LEAD,
  DOORBELL_LOADING_LABEL,
  DOORBELL_MASK_LABEL,
  DOORBELL_NEVER_FIRED,
  DOORBELL_NOT_ACTIVE,
  DOORBELL_OFFLINE_NOTE,
  DOORBELL_REGISTER_LABEL,
  DOORBELL_REGISTERED_LIVE,
  DOORBELL_REPLACE_LABEL,
  DOORBELL_RETRY_GATE,
  DOORBELL_SECRET_HINT,
  DOORBELL_SECRET_LABEL,
  DOORBELL_SECRET_REPLACE_LABEL,
  DOORBELL_STATUS_LABEL,
  DOORBELL_UNREGISTER_CONFIRM,
  DOORBELL_UNREGISTER_LABEL,
  DOORBELL_UNREGISTER_QUESTION,
  DOORBELL_UNREGISTERED_LIVE,
  DOORBELL_URL_HINT,
  DOORBELL_URL_LABEL,
  DOORBELL_URL_REPLACE_LABEL,
} from "@momo/core/features/hostedAgents/doorbell";
import type { HostedAgentConnection } from "@momo/core/features/hostedAgents/model";
import { normalizedId } from "@momo/core/features/agents/hubModel";
import {
  HOSTED_DOORBELL_MUTATION_SCOPE,
  purgeHostedDoorbellMutations,
} from "./doorbellScope";
import {
  hostedConnectionDetailQueryKey,
  invalidateHostedConnection,
} from "./hostedDisconnectScope";

// =============================================================================
// 호스티드 연결의 도어벨 등록 (ADR-0171 / WD-2 / #1735).
//
// Reading this as: connection panel doorbell section for internal team users
// on web+Tauri, density 7/10, motion 2/10.
//
// 투영은 부모의 커넥션 단건 GET 에서 온다. 이 화면은 queryFn 을 짓지 않는다.
// sender key 는 입력 칸에만 살고, 저장이 끝나면 칸을 비운다. mutation 변수에도
// 넣지 않는다.
//
// 시험 발화 버튼은 없다. WD-1 에 그 엔드포인트가 없다.
// =============================================================================

const OFFLINE_NOTE_ID = "hosted-doorbell-offline-note";
const BUSY_NOTE_ID = "hosted-doorbell-busy-note";
const NOT_ACTIVE_NOTE_ID = "hosted-doorbell-not-active-note";

export function DoorbellSection({
  workspaceId,
  connectionId,
  connection,
  loading,
  offline,
  writesLocked,
}: {
  workspaceId: string;
  connectionId: string;
  connection: HostedAgentConnection | null;
  loading: boolean;
  offline: boolean;
  /** 이 화면 밖의 쓰기(해제 시작 등). 도어벨 자신의 진행은 여기 들지 않는다. */
  writesLocked: boolean;
}) {
  const client = useQueryClient();
  const urlFieldId = useId();
  const secretFieldId = useId();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [gateClosed, setGateClosed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const secretRef = useRef("");
  secretRef.current = secret;

  useEffect(() => () => {
    secretRef.current = "";
    purgeHostedDoorbellMutations(client);
  }, [client]);

  const projection = connection === null ? null : doorbellProjection(connection);
  const nowMs = useTickingNow(projection?.lastFiredAtMs !== undefined);
  const active = connection?.status === "active";

  function writeConnection(next: HostedAgentConnection) {
    const key = hostedConnectionDetailQueryKey(
      workspaceId,
      normalizedId(next.id)
    );
    const current = client.getQueryData<{
      connection: HostedAgentConnection;
      artifacts: unknown;
    }>(key);
    if (current !== undefined) {
      client.setQueryData(key, { ...current, connection: next });
    }
    invalidateHostedConnection(client, workspaceId, normalizedId(next.id));
  }

  const register = useMutation({
    ...HOSTED_DOORBELL_MUTATION_SCOPE,
    mutationFn: async () => {
      const secretValue = secretRef.current;
      return parseHostedDoorbellResponse(
        await registerHostedDoorbell(workspaceId, connectionId, {
          url: url.trim(),
          secret: secretValue,
        })
      );
    },
    onSuccess: (registered) => {
      setSecret("");
      secretRef.current = "";
      setUrl("");
      setAttempted(false);
      setGateClosed(false);
      setFailure(null);
      setLive(DOORBELL_REGISTERED_LIVE);
      if (connection !== null) {
        writeConnection(applyDoorbellRegistration(connection, registered));
      } else {
        invalidateHostedConnection(client, workspaceId, connectionId);
      }
      purgeHostedDoorbellMutations(client);
    },
    onError: (error) => {
      if (isDoorbellGateClosed(error)) {
        setSecret("");
        secretRef.current = "";
        setGateClosed(true);
        setFailure(null);
        return;
      }
      setFailure(doorbellFailureMessage("register", error));
    },
  });

  const unregister = useMutation({
    ...HOSTED_DOORBELL_MUTATION_SCOPE,
    mutationFn: async () =>
      parseHostedDoorbellResponse(
        await unregisterHostedDoorbell(workspaceId, connectionId)
      ),
    onSuccess: () => {
      setSecret("");
      secretRef.current = "";
      setUrl("");
      setAttempted(false);
      setGateClosed(false);
      setFailure(null);
      setLive(DOORBELL_UNREGISTERED_LIVE);
      if (connection !== null) {
        writeConnection(applyDoorbellRegistration(connection, null));
      } else {
        invalidateHostedConnection(client, workspaceId, connectionId);
      }
      purgeHostedDoorbellMutations(client);
    },
    onError: (error) => {
      if (isDoorbellGateClosed(error)) {
        setGateClosed(true);
        setFailure(null);
        return;
      }
      if (
        error instanceof ApiError &&
        error.status === 404 &&
        error.message === "doorbell is not registered" &&
        connection !== null
      ) {
        writeConnection(applyDoorbellRegistration(connection, null));
      }
      setFailure(doorbellFailureMessage("unregister", error));
    },
  });

  const registering = register.isPending;
  const unregistering = unregister.isPending;
  const ownBusy = registering || unregistering;
  const blocked = offline || writesLocked;
  const registerLocked =
    blocked || !active || (ownBusy && !registering);
  const unregisterLocked = blocked || (ownBusy && !unregistering);
  const lockReasonId = offline
    ? OFFLINE_NOTE_ID
    : writesLocked || ownBusy
      ? BUSY_NOTE_ID
      : !active
        ? NOT_ACTIVE_NOTE_ID
        : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (registerLocked || registering) return;
    setAttempted(true);
    setLive("");
    if (doorbellUrlIssue(url) !== null || doorbellSecretIssue(secret) !== null) {
      return;
    }
    setFailure(null);
    register.mutate();
  }

  const urlError = attempted ? doorbellUrlIssue(url) : null;
  const secretError = attempted ? doorbellSecretIssue(secret) : null;
  const registerLabel = projection === null ? DOORBELL_REGISTER_LABEL : DOORBELL_REPLACE_LABEL;

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3"
      aria-label={DOORBELL_HEADLINE}
      data-testid="hosted-doorbell-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h4 className="text-body font-semibold text-ink">{DOORBELL_HEADLINE}</h4>
        <p className="break-keep text-meta text-ink-muted">{DOORBELL_LEAD}</p>
        <p role="status" aria-live="polite" className="sr-only">
          {live}
        </p>
      </div>

      {loading && (
        <div role="status" data-testid="hosted-doorbell-loading">
          <span className="sr-only">{DOORBELL_LOADING_LABEL}</span>
          <Skeleton ready={false} rows={2} className="p-0" />
        </div>
      )}

      {!loading && gateClosed && (
        <EmptyInvite
          className="px-0 py-2"
          headline={DOORBELL_GATE_OFF_HEADLINE}
          detail={DOORBELL_GATE_OFF_DETAIL}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setGateClosed(false)}
              data-testid="hosted-doorbell-gate-retry"
            >
              {DOORBELL_RETRY_GATE}
            </Button>
          }
          testId="hosted-doorbell-gate-off"
        />
      )}

      {!loading && !gateClosed && (
        <>
          {projection === null ? (
            <EmptyInvite
              className="px-0 py-2"
              headline={DOORBELL_EMPTY_HEADLINE}
              detail={DOORBELL_EMPTY_DETAIL}
              testId="hosted-doorbell-empty"
            />
          ) : (
            <div
              className="flex min-w-0 flex-col gap-2"
              data-testid="hosted-doorbell-registered"
            >
              <KeyValueRows
                rows={[
                  { key: DOORBELL_URL_LABEL, value: projection.url },
                  { key: DOORBELL_MASK_LABEL, value: projection.secretMasked },
                  {
                    key: DOORBELL_FIRED_LABEL,
                    value:
                      projection.lastFiredAtMs === undefined
                        ? DOORBELL_NEVER_FIRED
                        : relativeLabel(projection.lastFiredAtMs, nowMs),
                    prose: projection.lastFiredAtMs === undefined,
                  },
                ]}
              />
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-meta text-ink-muted">
                  {DOORBELL_STATUS_LABEL}
                </span>
                <StatusChip tone={doorbellLastStatusTone(projection.lastStatus)}>
                  {doorbellLastStatusLabel(projection.lastStatus)}
                </StatusChip>
                {projection.lastStatus !== undefined && (
                  <span className="font-mono text-meta text-ink-muted">
                    {projection.lastStatus}
                  </span>
                )}
              </div>
            </div>
          )}

          {failure !== null && (
            <InlineBanner
              separator={false}
              message={failure}
              actionLabel="닫기"
              onAction={() => setFailure(null)}
              testId="hosted-doorbell-failure"
            />
          )}

          <form
            className="flex min-w-0 flex-col gap-3"
            onSubmit={submit}
            data-testid="hosted-doorbell-form"
          >
            <Field
              label={
                projection === null ? DOORBELL_URL_LABEL : DOORBELL_URL_REPLACE_LABEL
              }
              htmlFor={urlFieldId}
              hint={DOORBELL_URL_HINT}
              error={urlError}
            >
              <Input
                id={urlFieldId}
                name="doorbell-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://example.com/webhook"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                className="font-mono"
                data-testid="hosted-doorbell-url"
              />
            </Field>
            <Field
              label={
                projection === null
                  ? DOORBELL_SECRET_LABEL
                  : DOORBELL_SECRET_REPLACE_LABEL
              }
              htmlFor={secretFieldId}
              hint={DOORBELL_SECRET_HINT}
              error={secretError}
            >
              <Input
                id={secretFieldId}
                name="doorbell-secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                data-testid="hosted-doorbell-secret"
              />
            </Field>

            {offline && (
              <p
                id={OFFLINE_NOTE_ID}
                className="break-keep text-meta text-ink-muted"
                data-testid="hosted-doorbell-offline"
              >
                {DOORBELL_OFFLINE_NOTE}
              </p>
            )}
            {!offline && (writesLocked || ownBusy) && (
              <p
                id={BUSY_NOTE_ID}
                className="break-keep text-meta text-ink-muted"
                data-testid="hosted-doorbell-busy"
              >
                {DOORBELL_BUSY_NOTE}
              </p>
            )}
            {!offline && !writesLocked && !active && (
              <p
                id={NOT_ACTIVE_NOTE_ID}
                className="break-keep text-meta text-ink-muted"
                data-testid="hosted-doorbell-not-active"
              >
                {DOORBELL_NOT_ACTIVE}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              {projection !== null && (
                <ConfirmButton
                  label={DOORBELL_UNREGISTER_LABEL}
                  question={DOORBELL_UNREGISTER_QUESTION}
                  confirmLabel={DOORBELL_UNREGISTER_CONFIRM}
                  describedBy={unregisterLocked ? lockReasonId : undefined}
                  disabled={unregisterLocked}
                  busy={unregistering}
                  busyLabel="해제 중"
                  onConfirm={() => {
                    if (unregisterLocked || unregistering) return;
                    setFailure(null);
                    setLive("");
                    unregister.mutate();
                  }}
                  testId="hosted-doorbell-unregister"
                />
              )}
              <Button
                type="submit"
                size="sm"
                aria-disabled={registerLocked || undefined}
                aria-busy={registering || undefined}
                aria-describedby={registerLocked ? lockReasonId : undefined}
                className={cn(registerLocked && "opacity-50")}
                data-testid="hosted-doorbell-register"
              >
                {registering
                  ? projection === null
                    ? "등록 중"
                    : "교체 중"
                  : registerLabel}
              </Button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
