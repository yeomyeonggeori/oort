import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorSmartphone, Terminal } from "lucide-react";
import {
  devAccessError,
  revokeDevCredential,
  type DevCredential,
} from "@momo/core/features/auth/devAccess";
import {
  DEV_LIST_SCOPE_LABELS,
  DEV_NOTICES,
  devAccessErrorText,
  devCredentialRow,
  isOwnDevCredential,
  type DevCredentialRow,
} from "@momo/core/features/auth/devAccessModel";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { SegmentedControl } from "@/design/ui/segmented-control";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  GONE_MEMBER_LABEL,
  memberNameParts,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import {
  devCredentialsQuery,
  devCredentialsQueryKey,
  devCredentialsQueryPrefix,
  type DevListScope,
} from "./devAccessQuery";
import { ConfirmButton } from "./SettingsFields";
import { SettingsSection } from "./shell/SettingsSection";
import { CardBody } from "./workTierPolicy";

// Reading this as: settings for internal team users on web+Tauri,
// density 6/10, motion 2/10.

// =============================================================================
// 연결 목록 (#4663, ADR-0216 D7). 지금 내 계정으로 들어올 수 있는 연결을 한 줄씩 보이고, 쓰지 않는
// 연결은 지운다. 한 줄: 이름 · 종류 · 도구 · 범위 · (로그인 세션만) 기기 · 마지막 사용 · 만료.
// 값(문구·라벨)은 코어 `devCredentialRow`가 만든다. 카드 토큰의 기기 칸은 **접는다**: 기기 이름은
// 로그인 세션에만 오고, 카드 토큰의 값을 지어내서 채우지 않는다.
//
// 소유자·관리자(`canManageAll`)는 「내 연결 / 전체」를 바꿔 볼 수 있다. **전체 보기는 읽기만**이다:
// 남의 줄에는 지우기가 없다(관리자 강제 폐기는 이 화면 밖이다). 내 줄은 두 보기 모두 지울 수 있다.
//
// 지우기는 되돌릴 수 없고 그 도구가 바로 끊기므로 `ConfirmButton`이 한 번 묻는다. 서버가 성공을
// 말하면 그 줄을 캐시에서 빼고 목록을 다시 읽는다(낙관 갱신은 하지 않는다: 지워졌다고 먼저 말하지
// 않는다). 지운 뒤 초점은 이웃 줄의 지우기로, 이웃이 없으면 「연결 만들기」나 빈 문장으로 간다.
// =============================================================================

const ROSTER_LOADING_LABEL = "불러오는 중";
const OFFLINE_REVOKE_REASON =
  "연결이 끊겨 지금은 연결을 지울 수 없어요. 다시 연결되면 지울 수 있어요.";

const SCOPE_OPTIONS = [
  { value: "mine", label: DEV_LIST_SCOPE_LABELS.mine },
  { value: "all", label: DEV_LIST_SCOPE_LABELS.all },
] as const satisfies readonly { value: DevListScope; label: string }[];

function revokeTriggerSelector(id: string): string {
  return `[data-testid="dev-credential-row-${id}"] [data-testid="dev-credential-revoke"]`;
}

export function DevAccessList({
  workspaceId,
  memberId,
  offline,
  canManageAll,
  onStartCreate,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
  /** 서버가 말한 사실(`GET …/dev-access`). 거짓이면 「전체」 보기는 서지 않는다. */
  canManageAll: boolean;
  /** 만들기 폼이 서 있을 때만 있다. 빈 목록의 단 하나의 행동. */
  onStartCreate?: () => void;
}) {
  const client = useQueryClient();
  const [view, setView] = useState<DevListScope>("mine");
  // 권한이 사라졌는데 전체 보기에 머무는 일은 없다.
  const scope: DevListScope = canManageAll ? view : "mine";
  const list = useQuery(devCredentialsQuery(workspaceId, scope));
  const roster = useDirectory(workspaceId);
  const offlineReasonId = useId();
  const [rowError, setRowError] = useState<string | null>(null);
  const [goneNotice, setGoneNotice] = useState<string | null>(null);
  const [removed, setRemoved] = useState("");
  const [removedNow, setRemovedNow] = useState<boolean | null>(null);
  const landing = useRef<string | null>(null);
  const revokingName = useRef("");
  const listRef = useRef<HTMLUListElement | null>(null);
  const emptyRef = useRef<HTMLParagraphElement | null>(null);

  const credentials: DevCredential[] = list.data ?? [];
  const now = Date.now();
  const rows = credentials.map((credential) => {
    const own = isOwnDevCredential(credential, memberId);
    return {
      own,
      row: devCredentialRow(credential, {
        now,
        ...(scope === "all"
          ? { memberName: own ? "나" : memberLabel(roster, credential.memberId) }
          : {}),
      }),
    };
  });

  useEffect(() => {
    const target = landing.current;
    if (target === null) return;
    landing.current = null;
    if (target === "") {
      const create = document.querySelector<HTMLElement>('[data-testid="dev-access-create"]');
      (create ?? emptyRef.current)?.focus({ preventScroll: true });
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>(revokeTriggerSelector(target))
      ?.focus({ preventScroll: true });
  }, [list.data]);

  const revoke = useMutation({
    mutationFn: (id: string) => revokeDevCredential(workspaceId, id),
    onSuccess: (result, id) => {
      client.setQueryData<DevCredential[]>(devCredentialsQueryKey(workspaceId, scope), (current) =>
        (current ?? []).filter((row) => row.id !== id)
      );
      const name = revokingName.current;
      setRemovedNow(result.revokedNow);
      setRemoved(
        result.revokedNow
          ? `${name} 연결을 지웠어요.`
          : `${name} 연결은 이미 끝나 있었어요.`
      );
    },
    onError: (error) => {
      landing.current = null;
      const failure = devAccessError(error);
      const text = devAccessErrorText(failure, "revoke");
      if (failure.kind === "not_found") setGoneNotice(text);
      else setRowError(text);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: devCredentialsQueryPrefix(workspaceId) });
    },
  });

  function startRevoke(id: string) {
    if (offline || revoke.isPending) return;
    setRowError(null);
    setGoneNotice(null);
    setRemoved("");
    setRemovedNow(null);
    // 지운 뒤 초점이 갈 곳: 지울 수 있는 줄(내 줄) 중 이웃, 없으면 빈 자리.
    const ownIds = rows.filter((entry) => entry.own).map((entry) => entry.row.id);
    const at = ownIds.indexOf(id);
    landing.current = ownIds[at + 1] ?? ownIds[at - 1] ?? "";
    revokingName.current = rows.find((entry) => entry.row.id === id)?.row.name ?? "";
    revoke.mutate(id);
  }

  const revokingId = revoke.isPending ? (revoke.variables ?? null) : null;
  const busy = revoke.isPending;
  const hasOwn = rows.some((entry) => entry.own);
  const hasNotes =
    (list.isSuccess && hasOwn && offline) || goneNotice !== null || rowError !== null;

  return (
    <>
      <SettingsSection
        title="연결 목록"
        description={
          scope === "all"
            ? "이 워크스페이스 사람들이 만든 연결이에요. 다른 사람의 연결은 볼 수만 있고, 지우는 일은 만든 사람이 해요."
            : "내 계정으로 들어올 수 있는 연결이에요. 쓰지 않는 연결은 지워 두세요."
        }
        action={
          canManageAll ? (
            <SegmentedControl
              legend="목록 범위"
              name="dev-credentials-scope"
              options={SCOPE_OPTIONS}
              value={scope}
              onValueChange={(next) => {
                setView(next);
                setRowError(null);
                setGoneNotice(null);
              }}
              testId="dev-credentials-scope"
            />
          ) : undefined
        }
        testId="dev-access-list-card"
      >
        {list.isPending && (
          <CardBody>
            <div role="status" data-testid="dev-credentials-loading">
              <span className="sr-only">연결 목록을 불러오고 있어요.</span>
              <Skeleton ready={false} rows={2} className="p-0" />
            </div>
          </CardBody>
        )}

        {list.isError && (
          <CardBody>
            <InlineBanner
              message={devAccessErrorText(devAccessError(list.error), "list")}
              actionLabel="다시 시도"
              onAction={() => void list.refetch()}
              className="px-0"
              separator={false}
              testId="dev-credentials-error"
            />
          </CardBody>
        )}

        {list.isSuccess && rows.length === 0 && (
          <CardBody>
            <p
              ref={emptyRef}
              tabIndex={-1}
              className="break-keep rounded-sm text-body text-ink-muted focus-visible:focus-ring"
              data-testid="dev-credentials-empty"
            >
              {scope === "all"
                ? "이 워크스페이스에는 아직 만든 연결이 없어요."
                : "아직 만든 연결이 없어요."}
            </p>
            {onStartCreate !== undefined && scope === "mine" && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onStartCreate}
                  data-testid="dev-credentials-start"
                >
                  새 연결 만들기
                </Button>
              </div>
            )}
          </CardBody>
        )}

        {/* 행이 카드 폭을 다 쓰고 행 사이만 선 하나다(카드 안에 상자를 한 겹 더 두르지 않는다). */}
        {list.isSuccess && rows.length > 0 && (
          <ul
            ref={listRef}
            className="flex flex-col divide-y divide-line"
            data-testid="dev-credentials-list"
            data-scope={scope}
          >
            {rows.map(({ own, row }) => (
              <CredentialRow
                key={row.id}
                row={row}
                own={own}
                offline={offline}
                busy={busy}
                revoking={revokingId === row.id}
                offlineReasonId={offlineReasonId}
                onRevoke={() => startRevoke(row.id)}
              />
            ))}
          </ul>
        )}

        {hasNotes && (
          <CardBody>
            {list.isSuccess && hasOwn && offline && (
              <p
                id={offlineReasonId}
                className="break-keep text-meta text-ink-muted"
                data-testid="dev-credentials-offline"
              >
                {OFFLINE_REVOKE_REASON}
              </p>
            )}
            {goneNotice !== null && (
              <p
                className="break-keep text-meta text-ink-muted"
                role="status"
                data-testid="dev-credentials-gone"
              >
                {goneNotice}
              </p>
            )}
            {rowError !== null && (
              <p
                className="break-keep text-meta text-danger"
                role="alert"
                data-testid="dev-credentials-revoke-error"
              >
                {rowError}
              </p>
            )}
          </CardBody>
        )}
      </SettingsSection>

      {/* 카드 밖에 둔다: 카드의 직접 자식마다 윗선이 그어진다(`settings-card`). */}
      <p
        className="sr-only"
        role="status"
        data-testid="dev-credentials-removed"
        data-revoked-now={removedNow === null ? undefined : String(removedNow)}
      >
        {removed}
      </p>
    </>
  );
}

/** 명부에서 이름을 찾는다. 명부를 받기 전에는 「나간 멤버」가 아니라 받는 중이라고 말한다. */
function memberLabel(roster: ReturnType<typeof useDirectory>, memberId: string): string {
  const fallback = roster.isPending ? ROSTER_LOADING_LABEL : GONE_MEMBER_LABEL;
  const parts = memberNameParts(roster.directory, memberId, fallback);
  return parts.handle ? `${parts.name} ${parts.handle}` : parts.name;
}

function CredentialRow({
  row,
  own,
  offline,
  busy,
  revoking,
  offlineReasonId,
  onRevoke,
}: {
  row: DevCredentialRow;
  own: boolean;
  offline: boolean;
  busy: boolean;
  revoking: boolean;
  offlineReasonId: string;
  onRevoke: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const Icon = row.kind === "session" ? MonitorSmartphone : Terminal;
  const locked = offline || (busy && !revoking);

  return (
    <li
      className={cn(
        "flex min-w-0 gap-3 px-4 py-3",
        asking ? "flex-col items-stretch" : "items-start justify-between"
      )}
      data-testid={`dev-credential-row-${row.id}`}
      data-kind={row.kind}
      data-own={own ? "true" : undefined}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Icon className="mt-px size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="min-w-0 break-keep text-body text-ink">
            <span className="break-words" data-testid="dev-credential-name">
              {row.name}
            </span>
          </p>
          <dl className="flex min-w-0 flex-wrap gap-x-3 gap-y-px text-meta">
            {/* 카드 토큰이 보통이라 줄마다 「카드 토큰」을 되풀이하지 않는다. 다른 종류(로그인 세션)만 말한다. */}
            {row.kind !== "card" && (
              <Fact label="종류" value={row.kindLabel} testId="dev-credential-kind" />
            )}
            {row.toolLabel !== undefined && (
              <Fact label="도구" value={row.toolLabel} testId="dev-credential-tool" />
            )}
            <Fact label="범위" value={row.scopeLabel} testId="dev-credential-scope" />
            {row.memberName !== undefined && (
              <Fact label="만든 사람" value={row.memberName} testId="dev-credential-member" />
            )}
            {row.deviceName !== undefined && (
              <Fact label="기기" value={row.deviceName} testId="dev-credential-device" />
            )}
            <Fact
              label="마지막 사용"
              value={row.lastUsedLabel}
              testId="dev-credential-last-used"
            />
            <Fact
              label="만료"
              value={row.expiryLabel}
              testId="dev-credential-expiry"
              warn={row.expired}
            />
          </dl>
          {row.scopeDetail !== undefined && (
            <p className="break-keep text-meta text-ink-muted" data-testid="dev-credential-scope-detail">
              {row.scopeDetail}
            </p>
          )}
        </div>
      </div>
      {own && (
        <div className={asking ? "min-w-0" : "shrink-0"}>
          <ConfirmButton
            label="지우기"
            subject={row.name}
            question={DEV_NOTICES.revokeWarning}
            confirmLabel="지우기"
            busy={revoking}
            busyLabel="지우는 중"
            disabled={locked}
            describedBy={offline ? offlineReasonId : undefined}
            onAskingChange={setAsking}
            onConfirm={onRevoke}
            testId="dev-credential-revoke"
          />
        </div>
      )}
    </li>
  );
}

/** 이름표와 값 한 쌍. 값이 없는 칸은 부르는 쪽이 아예 그리지 않는다(지어낸 값으로 채우지 않는다). */
function Fact({
  label,
  value,
  testId,
  warn = false,
}: {
  label: string;
  value: string;
  testId: string;
  warn?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-1">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className={cn("min-w-0 break-keep", warn ? "text-warn" : "text-ink")} data-testid={testId}>
        <span className="break-words">{value}</span>
      </dd>
    </div>
  );
}
