import { useEffect, useId, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { desktopWorkHost } from "@/lib/tauri";
import { getAccessToken } from "@/lib/session";
import {
  resolveServerBaseUrl,
  revokeWorkHost,
  type WorkHost,
} from "@momo/core/features/settings/api";
import { relativeSince } from "@momo/core/features/settings/model";
import {
  thisMacErrorMessage,
  thisMacState,
  type LocalWorkHostStatus,
  type ThisMacState,
} from "@momo/core/features/settings/thisMacHost";
import {
  ConfirmButton,
  Field,
  KeyValueRows,
  StatusChip,
  Subsection,
} from "./SettingsFields";

// =============================================================================
// 이 맥 (ADR-0188 D2 · R1, #2778): the desktop's own door to becoming a work
// host. Always drawn in the desktop shell, whatever the registry says (planner
// decision on #2778): with zero hosts this block IS the way to the first one.
//
// Two sources, one state (`thisMacState`, core): the shell's `work_host_status`
// (is momo-workd here, registered as which host, running, heartbeat) and the
// server's registry (online, revoked). 「등록됐지만 오프라인」 and 「아직 없음」
// are different states with different sentences and different actions.
// =============================================================================

/** The shell answers from local files and one socket call; cheap to poll. */
const LOCAL_POLL_MS = 15_000;

const THIS_MAC_QUERY_KEY = ["settings", "this-mac-host"] as const;

const LINES = [
  "이 맥을 작업 호스트로 등록하면 폰이나 다른 기기에서 시킨 작업이 이 맥에서 돕니다. 결정과 승인은 등록한 본인만 합니다.",
];

function errorText(error: unknown): string {
  return thisMacErrorMessage(typeof error === "string" ? error : String(error));
}

export function ThisMacHostBlock({
  workspaceId,
  hosts,
  offline,
}: {
  workspaceId: string;
  hosts: UseQueryResult<WorkHost[], unknown>;
  offline: boolean;
}) {
  const client = useQueryClient();
  const local = useQuery({
    queryKey: THIS_MAC_QUERY_KEY,
    queryFn: async () => {
      const status = await desktopWorkHost.status();
      if (!status) throw "unsupported_platform";
      return status;
    },
    retry: false,
    staleTime: 0,
    refetchInterval: LOCAL_POLL_MS,
  });

  const settle = async (status: LocalWorkHostStatus) => {
    client.setQueryData(THIS_MAC_QUERY_KEY, status);
    await Promise.all([
      client.invalidateQueries({ queryKey: ["settings", "work-hosts", workspaceId] }),
      client.invalidateQueries({ queryKey: ["work-hosts", workspaceId] }),
    ]);
  };

  if (local.isPending) {
    return (
      <Subsection title="이 맥" lines={LINES}>
        <Skeleton ready={false} rows={2} />
      </Subsection>
    );
  }
  if (local.isError) {
    return (
      <Subsection title="이 맥" lines={LINES}>
        <InlineBanner
          message="이 맥의 작업 호스트 상태를 읽지 못했습니다. 다시 확인하세요."
          actionLabel="상태 다시 확인"
          onAction={() => void local.refetch()}
          testId="this-mac-error"
        />
      </Subsection>
    );
  }

  const state = thisMacState(
    local.data,
    hosts.data,
    workspaceId,
    resolveServerBaseUrl()
  );
  const row = local.data.registered
    ? hosts.data?.find(
        (host) => host.id.toLowerCase() === local.data.registered?.hostId.toLowerCase()
      )
    : undefined;

  return (
    <Subsection title="이 맥" lines={LINES}>
      <div data-testid="this-mac" data-this-mac-state={state.kind}>
        <ThisMacBody
          state={state}
          local={local.data}
          row={row}
          workspaceId={workspaceId}
          offline={offline}
          recheck={() => void local.refetch()}
          settle={settle}
        />
      </div>
    </Subsection>
  );
}

function RecheckButton({ recheck }: { recheck: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={recheck} data-testid="this-mac-recheck">
      다시 확인
    </Button>
  );
}

function ThisMacBody({
  state,
  local,
  row,
  workspaceId,
  offline,
  recheck,
  settle,
}: {
  state: ThisMacState;
  local: LocalWorkHostStatus;
  row: WorkHost | undefined;
  workspaceId: string;
  offline: boolean;
  recheck: () => void;
  settle: (status: LocalWorkHostStatus) => Promise<void>;
}) {
  switch (state.kind) {
    case "no_sidecar":
      return (
        <EmptyInvite
          className="px-0"
          headline="이 빌드에는 작업 호스트 프로그램이 들어 있지 않습니다."
          detail="배포된 oort 앱에는 들어 있습니다. 개발 빌드라면 작업 호스트 프로그램을 함께 빌드한 뒤 앱을 다시 여세요."
          actions={<RecheckButton recheck={recheck} />}
          testId="this-mac-no-sidecar"
        />
      );
    case "not_registered":
      return state.ready ? (
        <RegisterForm
          local={local}
          workspaceId={workspaceId}
          offline={offline}
          settle={settle}
        />
      ) : (
        // Same header grammar as the ready form (headline, muted chip): one
        // state, one look, whether or not an adapter was found (#2778 DR M-4).
        <div className="flex min-w-0 flex-col gap-2" data-testid="this-mac-no-adapter">
          <NotRegisteredHeader />
          <p className="break-keep text-meta text-ink-muted">
            등록하려면 ACP 어댑터(claude-agent-acp나 codex-acp)가 이 맥에 있어야 합니다. 설치한 뒤 다시 확인하세요.
          </p>
          <div>
            <RecheckButton recheck={recheck} />
          </div>
        </div>
      );
    case "elsewhere":
      return (
        <ForgetOnly
          headline="이 맥은 다른 워크스페이스나 서버의 호스트로 등록돼 있습니다."
          chip="다른 곳에 등록됨"
          detail="여기서 쓰려면 이 맥의 등록 정보를 지우고 새로 등록하세요. 다른 워크스페이스의 호스트 목록에는 남으니 그쪽에서 해지하세요."
          settle={settle}
          testId="this-mac-elsewhere"
        />
      );
    case "revoked":
      return (
        <ForgetOnly
          headline="이 맥의 호스트 등록이 해지되었습니다."
          chip="해지됨"
          detail="해지된 호스트로는 작업이 오지 않습니다. 다시 쓰려면 이 맥의 등록 정보를 지우고 새로 등록하세요."
          settle={settle}
          testId="this-mac-revoked"
        />
      );
    case "offline":
    case "online":
      return (
        <Registered
          state={state}
          local={local}
          row={row}
          workspaceId={workspaceId}
          offline={offline}
          settle={settle}
        />
      );
  }
}

function NotRegisteredHeader() {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <p className="text-body font-medium text-ink">이 맥은 아직 작업 호스트가 아닙니다.</p>
      <StatusChip tone="muted">등록 안 됨</StatusChip>
    </div>
  );
}

function adapterSummary(local: LocalWorkHostStatus): string {
  const found = local.adapters.filter((adapter) => adapter.found).map((adapter) => adapter.key);
  return found.length > 0 ? found.join(", ") : "없음";
}

function RegisterForm({
  local,
  workspaceId,
  offline,
  settle,
}: {
  local: LocalWorkHostStatus;
  workspaceId: string;
  offline: boolean;
  settle: (status: LocalWorkHostStatus) => Promise<void>;
}) {
  const nameId = useId();
  const reasonId = useId();
  const [name, setName] = useState(local.displayNameSuggestion);
  useEffect(() => {
    setName((current) => current || local.displayNameSuggestion);
  }, [local.displayNameSuggestion]);
  const trimmed = name.trim();
  const nameError =
    trimmed.length === 0
      ? "호스트 이름을 적어 주세요."
      : [...trimmed].length > 80
        ? "호스트 이름은 80자 이하로 적어 주세요."
        : null;

  const register = useMutation({
    mutationFn: () =>
      desktopWorkHost.register({
        serverUrl: resolveServerBaseUrl(),
        workspaceId,
        displayName: trimmed,
        accessToken: getAccessToken() ?? "",
      }),
    onSuccess: settle,
  });
  const canRegister = !offline && nameError === null;
  // A grey control says why (ConfirmButton's rule, PR 1203 R2 N-R4): the name
  // field already shows its own error, so only the offline reason is new here.

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="this-mac-register">
      <NotRegisteredHeader />
      <KeyValueRows
        rows={[
          { key: "쓸 수 있는 도구", value: adapterSummary(local) },
          { key: "작업 폴더", value: local.workFolder },
        ]}
      />
      <Field
        label="호스트 이름"
        htmlFor={nameId}
        hint="폰과 다른 기기의 호스트 목록에 이 이름으로 보입니다."
        error={nameError}
      >
        <Input
          id={nameId}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          data-testid="this-mac-name"
        />
      </Field>
      {register.isError && (
        <p className="text-meta text-danger" role="alert" data-testid="this-mac-register-error">
          {errorText(register.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          aria-disabled={!canRegister || undefined}
          aria-describedby={offline ? reasonId : undefined}
          aria-busy={register.isPending || undefined}
          className={canRegister ? undefined : "opacity-50"}
          onClick={() => {
            if (!canRegister || register.isPending) return;
            register.mutate();
          }}
          data-testid="this-mac-register-submit"
        >
          {register.isPending ? "등록 중" : "이 맥을 호스트로 등록"}
        </Button>
        {offline && (
          <span id={reasonId} className="text-meta text-ink-muted">
            연결이 끊겨 지금은 등록할 수 없습니다.
          </span>
        )}
      </div>
      <p className="text-meta text-ink-muted">
        등록하면 내 계정으로 로그인한 모든 기기에 알림이 갑니다. 원격 작업은 작업 폴더 안에서만 돕니다.
      </p>
    </div>
  );
}

function Registered({
  state,
  local,
  row,
  workspaceId,
  offline,
  settle,
}: {
  state: Extract<ThisMacState, { kind: "offline" | "online" }>;
  local: LocalWorkHostStatus;
  row: WorkHost | undefined;
  workspaceId: string;
  offline: boolean;
  settle: (status: LocalWorkHostStatus) => Promise<void>;
}) {
  const start = useMutation({ mutationFn: desktopWorkHost.start, onSuccess: settle });
  const stop = useMutation({ mutationFn: desktopWorkHost.stop, onSuccess: settle });
  const restart = useMutation({
    mutationFn: async () => {
      await desktopWorkHost.stop();
      return desktopWorkHost.start();
    },
    onSuccess: settle,
  });
  const unregister = useMutation({
    mutationFn: async () => {
      const hostId = local.registered?.hostId;
      // Server first: a host the server still accepts must not lose its only
      // local record, or nobody could stop it from this Mac again.
      if (hostId) await revokeWorkHost(workspaceId, hostId);
      return desktopWorkHost.forget();
    },
    onSuccess: settle,
  });
  const failed = [start, stop, restart, unregister].find((m) => m.isError);
  const offlineReasonId = useId();
  const name = row?.displayName ?? local.displayNameSuggestion;

  const chip =
    state.kind === "online" ? (
      <StatusChip tone="ok">온라인</StatusChip>
    ) : state.reason === "stopped" ? (
      <StatusChip tone="warn">등록됨, 꺼져 있음</StatusChip>
    ) : (
      <StatusChip tone="warn">등록됨, 오프라인</StatusChip>
    );
  const sentence =
    state.kind === "online"
      ? "작업을 받고 있습니다. 앱을 닫으면 작업 호스트도 꺼집니다."
      : state.reason === "stopped"
        ? "등록돼 있지만 작업 호스트가 꺼져 있어 작업을 받지 않습니다."
        : `작업 호스트가 켜져 있지만 서버에 닿지 못하고 있습니다.${
            state.lastSeenAtMs ? ` 마지막 연결 ${relativeSince(state.lastSeenAtMs)}.` : ""
          }`;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="this-mac-registered">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 break-words text-body font-medium text-ink">{name}</p>
          {chip}
        </div>
        <p className="break-keep text-meta text-ink-muted" data-testid="this-mac-sentence">
          {sentence}
        </p>
      </div>
      <KeyValueRows
        rows={[
          { key: "쓸 수 있는 도구", value: adapterSummary(local) },
          { key: "작업 폴더", value: local.workFolder },
        ]}
      />
      {failed && (
        <p className="text-meta text-danger" role="alert" data-testid="this-mac-action-error">
          {errorText(failed.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {state.kind === "offline" && state.reason === "stopped" && (
          <Button
            size="sm"
            aria-busy={start.isPending || undefined}
            onClick={() => {
              if (!start.isPending) start.mutate();
            }}
            data-testid="this-mac-start"
          >
            {start.isPending ? "켜는 중" : "작업 호스트 켜기"}
          </Button>
        )}
        {state.kind === "offline" && state.reason === "not_reaching_server" && (
          <Button
            size="sm"
            aria-busy={restart.isPending || undefined}
            onClick={() => {
              if (!restart.isPending) restart.mutate();
            }}
            data-testid="this-mac-restart"
          >
            {restart.isPending ? "다시 켜는 중" : "작업 호스트 다시 켜기"}
          </Button>
        )}
        {state.kind === "online" && (
          <Button
            variant="outline"
            size="sm"
            aria-busy={stop.isPending || undefined}
            onClick={() => {
              if (!stop.isPending) stop.mutate();
            }}
            data-testid="this-mac-stop"
          >
            {stop.isPending ? "끄는 중" : "작업 호스트 끄기"}
          </Button>
        )}
      </div>
      {/* Its own row: the two-step question and its 취소 stay together at the
          default window width (#2778 DR M-3). */}
      <div className="flex min-w-0 flex-col gap-1">
        <ConfirmButton
          label="등록 해제"
          subject={name}
          question="서버에서 해지하고 이 맥의 호스트 키를 지울까요? 돌고 있는 원격 작업은 끝납니다."
          confirmLabel="등록 해제"
          busy={unregister.isPending}
          busyLabel="해제 중"
          disabled={offline}
          describedBy={offline ? offlineReasonId : undefined}
          onConfirm={() => unregister.mutate()}
          testId="this-mac-unregister"
        />
        {offline && (
          <p id={offlineReasonId} className="text-meta text-ink-muted">
            연결이 끊겨 지금은 등록을 해제할 수 없습니다.
          </p>
        )}
      </div>
    </div>
  );
}

function ForgetOnly({
  headline,
  chip,
  detail,
  settle,
  testId,
}: {
  headline: string;
  chip: string;
  detail: string;
  settle: (status: LocalWorkHostStatus) => Promise<void>;
  testId: string;
}) {
  const forget = useMutation({ mutationFn: desktopWorkHost.forget, onSuccess: settle });
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="text-body font-medium text-ink">{headline}</p>
          <StatusChip tone="muted">{chip}</StatusChip>
        </div>
        <p className="break-keep text-meta text-ink-muted">{detail}</p>
      </div>
      {forget.isError && (
        <p className="text-meta text-danger" role="alert">
          {errorText(forget.error)}
        </p>
      )}
      <div>
        <ConfirmButton
          label="등록 정보 지우기"
          question="이 맥의 호스트 키와 등록 정보를 지울까요? 되돌릴 수 없습니다."
          confirmLabel="지우기"
          busy={forget.isPending}
          busyLabel="지우는 중"
          onConfirm={() => forget.mutate()}
          testId={`${testId}-forget`}
        />
      </div>
    </div>
  );
}
