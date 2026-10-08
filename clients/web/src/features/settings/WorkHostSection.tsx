import { useState } from "react";
import { type UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import type { WorkHost } from "@momo/core/features/settings/api";
import {
  isOperatorDenied,
  relativeSince,
  sortWorkHosts,
  workHostCounts,
  workHostIdTail,
  workHostRegistryMessage,
  workHostScopeLabel,
  workHostStatus,
  workHostTypeLabel,
} from "@momo/core/features/settings/model";
import { CopyButton, OperatorNotice, StatusChip } from "./SettingsFields";
import { SettingsRow } from "./shell/SettingsRow";
import { SettingsSection } from "./shell/SettingsSection";
import { useWorkHosts } from "./workHostsQuery";
import { CardBody, WorkspaceTierPolicySection } from "./workTierPolicy";

// =============================================================================
// 설정 > 실행 호스트 (#3578 S4; R-1 §5 + AX-6a / MOMO-617). 워크스페이스에 등록된
// 호스트의 목록과, 호스트를 잃었을 때의 **워크스페이스 기본** 정책이다.
//
//   등록된 호스트              the ADR-0125 registry: name, kind, liveness, host id
//   워크스페이스 기본 재개 정책  the D11 default every member falls back to (operators)
//
// 이 맥을 등록하는 자리와 내 재개 정책은 **개인**이라 설정 > 기기에 있다
// (ThisMacHostBlock, MyTierPolicySection). 「실행 엔진」은 워크스페이스에 하나라는 모델이
// 「하네스는 사람마다」(ADR-0198 D4)와 맞지 않아 이 화면에서 걷었다.
//
// 카드마다 자기 질의를 들어서, 운영자 전용 403이 다른 카드를 비우지 않는다.
// =============================================================================

/** Shared by every state of 등록된 호스트 so the verb never changes on the reader. */
const REGISTRY_REFRESH_LABEL = "등록 목록 다시 불러오기";

const REGISTRY_TITLE = "등록된 호스트";
const REGISTRY_DESCRIPTION =
  "에이전트가 실제로 명령을 돌리는 자리예요. 데스크톱 앱은 설정의 「기기」에서 이 맥을 등록하고, 리눅스 서버의 workd 데몬은 스스로 등록해요. 온라인 여부는 서버가 정하고 30초마다 다시 읽어요. 호스트 키는 그 호스트를 떠나지 않아요.";

export function WorkHostSection({
  workspaceId,
  memberId,
  offline,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
}) {
  // One read of the registry serves both the list and the auto-target choices.
  const hosts = useWorkHosts(workspaceId);

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="work-host-page">
      <RegistryBlock hosts={hosts} memberId={memberId} offline={offline} />
      {/* The QUERY goes down, not `hosts.data ?? []`: an empty array cannot say
          whether the registry is empty, still loading, or refused, and the
          policy card has to tell those apart before it claims a host is not
          registered. */}
      <WorkspaceTierPolicySection
        workspaceId={workspaceId}
        memberId={memberId}
        hosts={hosts}
        offline={offline}
      />
    </div>
  );
}

// --- 등록된 호스트 -----------------------------------------------------------

/**
 * The one control the 409 copy tells people to use.
 *
 * The registry poll keeps the list honest on its own, but "등록된 호스트를 다시
 * 불러온 뒤 고르세요" has to be an action someone can take at the moment they
 * read it, not a wait. Present in every state of the block including success and
 * empty: before MOMO-617 R2 only the error state had it, so a person who had
 * just registered a host had no way to go looking for it.
 */
function RegistryRefreshButton({
  hosts,
  offline,
}: {
  hosts: UseQueryResult<WorkHost[], unknown>;
  offline: boolean;
}) {
  // Busy for a reload THIS BUTTON started, not for `hosts.isFetching`: the poll
  // above refetches every 30 seconds, and a control whose name changes twice a
  // minute on its own is a moving target in the tab order and a flicker nobody
  // asked for. The label is the accessible name, so it moves only when the
  // person moved it.
  const [reloading, setReloading] = useState(false);

  async function reload() {
    if (reloading) return;
    setReloading(true);
    try {
      await hosts.refetch();
    } finally {
      setReloading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={offline}
      aria-busy={reloading || undefined}
      onClick={() => void reload()}
      data-testid="work-hosts-refresh"
    >
      {reloading ? "다시 불러오는 중" : REGISTRY_REFRESH_LABEL}
    </Button>
  );
}

/**
 * The registry as a list you can read, not a key dump: name, kind, liveness and
 * the host id an operator pastes into `MOMO_WORK_HOST_ID`. The signing public
 * key is in the payload and stays out of the row on purpose.
 *
 * Revoked rows are kept because the server keeps them: a host revoked yesterday
 * is the answer to "왜 안 붙지", and dropping it would make this list disagree
 * with the ledger the policy validates its target against.
 */
function RegistryBlock({
  hosts,
  memberId,
  offline,
}: {
  hosts: UseQueryResult<WorkHost[], unknown>;
  memberId: string;
  offline: boolean;
}) {
  const frame = { title: REGISTRY_TITLE, description: REGISTRY_DESCRIPTION, testId: "work-hosts-card" };

  if (hosts.isPending) {
    return (
      <SettingsSection {...frame}>
        <CardBody>
          <Skeleton ready={false} rows={2} />
        </CardBody>
      </SettingsSection>
    );
  }

  if (hosts.isError) {
    return (
      <SettingsSection {...frame}>
        <CardBody>
          {/* A 403 here means the reader is not a member of this workspace, which
              is an answer and not a failure, so it does not get a retry button
              that is guaranteed to fail. The other statuses get Korean copy
              instead of the wire message ("not a workspace member") the route logs. */}
          {isOperatorDenied(hosts.error) ? (
            <OperatorNotice
              bare
              who="등록된 호스트 목록은 이 워크스페이스의 멤버만 볼 수 있어요."
              contact="초대가 아직 처리되지 않았는지 워크스페이스 관리자에게 확인하세요."
            />
          ) : offline ? (
            /* Offline is the fourth state here too. A retry button while the
               socket is down is a button that cannot succeed, which is the same
               defect as an operator form whose save always 403s. */
            <InlineBanner
              message="연결이 끊겨 등록된 호스트 목록을 불러올 수 없어요. 다시 연결되면 목록을 불러와요."
              separator={false}
              className="px-0"
              testId="work-hosts-error"
            />
          ) : (
            <InlineBanner
              message={workHostRegistryMessage()}
              actionLabel={REGISTRY_REFRESH_LABEL}
              onAction={() => void hosts.refetch()}
              separator={false}
              className="px-0"
              testId="work-hosts-error"
            />
          )}
        </CardBody>
      </SettingsSection>
    );
  }

  if (hosts.data.length === 0) {
    return (
      <SettingsSection {...frame}>
        {/* One line of copy AND one action (SKILL §5). The action cannot be
            "등록하기" because nothing on this page registers a host, so it is the
            one thing a person who just started a host actually wants: look
            again. The copy names the app and the moment that creates the row. */}
        <EmptyInvite
          headline="등록된 호스트가 아직 없어요."
          detail="oort 데스크톱 앱의 설정 「기기」에서 이 맥을 등록하면 여기에 나타나고, 리눅스 서버는 workd 데몬이 켜질 때 스스로 등록해요."
          actions={<RegistryRefreshButton hosts={hosts} offline={offline} />}
          testId="work-hosts-empty"
        />
      </SettingsSection>
    );
  }

  // 남의 개인 맥은 이름만 보인다 (#3578 R6): 서버 목록은 워크스페이스 읽기라서 다른
  // 멤버의 `scope=member` 호스트도 내려오지만, 그 사람의 맥 상태·ID·마지막 연결은 나의
  // 일이 아니다. 서버가 거르기 전까지 화면이 먼저 줄인다. 내 일감 대상이 될 수 없는
  // 호스트이므로 「사용 가능」 수에도 넣지 않는다.
  const mine = (host: WorkHost) => !(host.scope === "member" && host.ownerMemberId !== memberId);
  const visible = hosts.data.filter(mine);
  // 사용 가능 / 해지 split: the live workspace holds 6 rows of which 4 are
  // revoked, and "등록 6대" reads as six hosts you can send work to.
  const counts = workHostCounts(visible);
  const ordered = [...sortWorkHosts(visible), ...hosts.data.filter((host) => !mine(host))];

  return (
    <SettingsSection {...frame}>
      {/* 다시 불러오기는 카드 안 머리 줄에 둔다: 제목 줄 오른쪽에 두면 폰 폭에서 설명 문장이
          좁은 열로 눌린다. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-3">
        <p className="text-meta text-ink-muted" data-testid="work-host-count">
          사용 가능{" "}
          <span className="font-mono text-ink" data-numeric>
            {counts.usable}
          </span>
          {counts.revoked > 0 && (
            <>
              , 해지{" "}
              <span className="font-mono text-ink" data-numeric>
                {counts.revoked}
              </span>
            </>
          )}
        </p>
        <RegistryRefreshButton hosts={hosts} offline={offline} />
      </div>
      <ul className="flex flex-col divide-y divide-line" data-testid="work-host-list">
        {ordered.map((host) =>
          mine(host) ? (
            <HostRow key={host.id} host={host} />
          ) : (
            <OtherPersonalHostRow key={host.id} host={host} />
          )
        )}
      </ul>
    </SettingsSection>
  );
}

function HostRow({ host }: { host: WorkHost }) {
  const status = workHostStatus(host);
  const revoked = Boolean(host.revokedAtMs);
  const facts = [workHostTypeLabel(host.type), workHostScopeLabel(host.scope)];
  if (host.revokedAtMs) {
    facts.push(`해지 ${relativeSince(host.revokedAtMs)}`);
  } else if (host.lastSeenAtMs) {
    facts.push(`마지막 연결 ${relativeSince(host.lastSeenAtMs)}`);
  }
  const tail = workHostIdTail(host.id);

  return (
    <li data-testid="work-host-row" data-host-status={status.label}>
      <SettingsRow
        keep
        label={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {/* A revoked row is history, not a choice. It keeps its full contrast
                chip and its facts, and gives up the ink weight of a name you can
                still send work to. */}
            <span className={cn("min-w-0 break-words", revoked && "text-ink-muted")}>
              {host.displayName}
            </span>
            <StatusChip tone={status.tone}>{status.label}</StatusChip>
          </span>
        }
        description={
          /* The id tail rides the facts line instead of owning a third line: a
             36 character UUID per row made the six-row list 486px tall. The tail
             is what distinguishes rows (UUIDv7 shares its prefix); the full id is
             what the copy button puts on the clipboard. */
          <span className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span className="min-w-0 break-words">{facts.join(", ")}</span>
            <span className="font-mono" data-numeric>
              ID {tail}
            </span>
          </span>
        }
      >
        <CopyButton
          value={host.id}
          label="호스트 ID 복사"
          subject={`${host.displayName} 끝자리 ${tail}`}
          testId="work-host-copy-id"
        />
      </SettingsRow>
    </li>
  );
}

/** 다른 멤버의 개인 맥: 이름과 「개인」만. 상태·ID·복사는 그 사람의 것이다. */
function OtherPersonalHostRow({ host }: { host: WorkHost }) {
  return (
    <li data-testid="work-host-row" data-host-status="other-personal">
      <SettingsRow
        label={<span className="min-w-0 break-words text-ink-muted">{host.displayName}</span>}
        description="다른 멤버의 개인 호스트예요."
      />
    </li>
  );
}
