import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { renameAgent, uuidEq, type RosterMember } from "@momo/core/lib/api";
import { memberFor } from "@momo/core/features/workspace/directory";
import {
  TEAM_AI_NAME_STATUS_COPY,
  TEAM_AI_RENAME_ERROR_COPY,
  TEAM_AI_ROLES_ERROR_COPY,
} from "@momo/core/features/settings/teamAiCopyKeys";
import {
  handleHolderName,
  readTeamAiAliasStatus,
  readTeamAiNameStatus,
  teamAiAliasNotices,
  teamAiCallableNames,
} from "@momo/core/features/settings/teamAiNextStep";
import {
  patchTeamAiRoles,
  readTeamAiRoles,
  teamAiRolesErrorKind,
  teamAiSettingsToggleNotice,
  type TeamAiBundle,
  type TeamAiRoles,
  type TeamAiSwitchableBundle,
} from "@momo/core/features/settings/teamAiRoles";
import {
  teamAiNameDraft,
  teamAiRenameErrorKind,
  TEAM_AI_NAME_MAX_LENGTH,
} from "@momo/core/features/settings/teamAiSetup";
import {
  fetchWorkspaceSettingsBag,
  readTeamAiSwitch,
  teamAiHelperName,
} from "@momo/core/features/settings/teamAiSwitch";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { useBrowserOffline } from "@/features/common/useOffline";
import { teamAiSettingKey } from "@/features/settings/TeamAiSetting";
import { TeamAiRolesList } from "@/features/settings/TeamAiRolesList";
import { rosterQueryKey, useDirectory } from "@/features/workspace/useWorkspace";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// 설정 › AI › 팀 AI 키 화면의 「도우미」 카드 (ADR-0201 증보 v3 B3·B10, #4945).
//
// 관리자가 켠 도우미의 **이름**과 **할 수 있는 일**(역할 일곱 묶음)을 바꾼다.
//
//  - 이름: 사람용 `PATCH …/agents/{agent}`(`renameAgent`). 새 이름이 부르는 이름(별칭)에
//    더해지고 예전 이름은 남는 것은 **서버가 같은 트랜잭션에서** 한다. 화면은 결과를 보인다:
//    저장 뒤 설정 가방을 다시 읽어 부르는 이름 줄을 새로 그린다.
//  - 역할: `PATCH …/settings {team_ai_roles: {묶음: 불리언}}`. 누르는 즉시 그 묶음 하나만 저장한다
//    (서버가 한 단계 아래로 병합하므로 다른 묶음은 움직이지 않는다). 파일·기억은 켜면 내용이
//    공급자로 가므로 그 행 아래에 고지를 늘 보인다. 그 둘을 **켤 때** 같은 본문에 고지 기록
//    (`team_ai_roles_notice`)을 실어 서버가 스위치와 한 트랜잭션에 남긴다(#5040) — 끄거나 고지 없는
//    묶음이면 싣지 않는다.
//
// **확인된 뒤에만 선다**(`TeamAiSetting`·`TeamAiNextStepCard`와 같은 규율): 설정 가방을 읽지 못하면
// (관리자가 아님, 옛 서버) 아무것도 그리지 않고, 도우미가 꺼져 있으면 서지 않는다(켜는 길은 다음 단계
// 카드와 온보딩). 로딩 뼈대도 세우지 않는다: 없을 수도 있는 카드의 자리는 거짓말이 된다.
//
// 쿼리 키는 이웃과 같다: 설정 가방은 도우미 스위치·다음 단계 카드와(`teamAiSettingKey`), 명부는 에이전트
// 카드와(`rosterQueryKey`). 한 곳에서 바꾸면 다른 곳도 같은 값을 본다.
// =============================================================================

export function TeamAiHelperCard({ workspaceId }: { workspaceId: string }) {
  const formatMessage = useFormatMessage();
  const offline = useBrowserOffline();
  const client = useQueryClient();
  const titleId = useId();
  const nameInputId = useId();
  const nameHintId = useId();
  const nameErrorId = useId();
  const rolesTitleId = useId();

  const bagKey = teamAiSettingKey(workspaceId);
  const bag = useQuery({
    queryKey: bagKey,
    queryFn: () => fetchWorkspaceSettingsBag(workspaceId),
    retry: false,
    staleTime: 30_000,
  });
  const state = bag.data === undefined ? null : readTeamAiSwitch(bag.data);
  const memberId = state?.memberId ?? null;
  const directory = useDirectory(workspaceId);
  const member = memberFor(directory.directory, memberId ?? undefined);
  const helperName = teamAiHelperName(member);

  // ---- 이름 -----------------------------------------------------------------------
  const [draft, setDraft] = useState(helperName);
  const edited = useRef(false);
  useEffect(() => {
    // 서버의 이름이 바뀌면(저장 뒤·다른 기기) 손대지 않은 칸은 따라간다.
    if (!edited.current) setDraft(helperName);
  }, [helperName]);
  const [saved, setSaved] = useState(false);
  const rename = useMutation({
    mutationFn: (name: string) => renameAgent(workspaceId, memberId as string, name),
    onSuccess: (renamed) => {
      edited.current = false;
      setSaved(true);
      client.setQueryData<RosterMember[]>(rosterQueryKey(workspaceId), (rows) =>
        rows?.map((row) =>
          memberId !== null && uuidEq(row.id, memberId)
            ? { ...row, displayName: renamed.displayName }
            : row
        )
      );
      // 별칭 결과(새 이름이 더해졌는지·못 만든 까닭)는 서버가 가방에 적는다: 다시 읽어 보인다.
      void client.invalidateQueries({ queryKey: bagKey });
      void client.invalidateQueries({ queryKey: rosterQueryKey(workspaceId) });
    },
  });
  const nameState = teamAiNameDraft(draft);
  const nameSavable = memberId !== null && nameState.valid && nameState.name !== helperName.trim();
  const nameLocked = offline || rename.isPending || !nameSavable;

  function submitName(event: FormEvent) {
    event.preventDefault();
    if (nameLocked) return;
    setSaved(false);
    rename.mutate(nameState.name);
  }

  // ---- 역할 -----------------------------------------------------------------------
  const stored = readTeamAiRoles(bag.data);
  const [pending, setPending] = useState<{ bundle: TeamAiSwitchableBundle; next: boolean } | null>(null);
  const toggle = useMutation({
    mutationFn: (change: { bundle: TeamAiSwitchableBundle; next: boolean }) =>
      patchTeamAiRoles(
        workspaceId,
        { [change.bundle]: change.next },
        teamAiSettingsToggleNotice(change.bundle, change.next)
      ),
    onMutate: (change) => setPending(change),
    onSuccess: (next) => client.setQueryData(bagKey, next),
    onSettled: () => setPending(null),
  });
  // 저장 중에는 누른 값을 보인다(되돌아 튀는 스위치는 고장 난 것처럼 보인다).
  const roles: TeamAiRoles = pending === null ? stored : { ...stored, [pending.bundle]: pending.next };
  const busyBundle: TeamAiBundle | null = pending === null ? null : pending.bundle;

  // 확인된 뒤에만 선다.
  if (state === null || !state.enabled || memberId === null) return null;

  const aliasStatus = readTeamAiAliasStatus(bag.data);
  const aliasNames = teamAiCallableNames(aliasStatus);
  const nameStatus = readTeamAiNameStatus(bag.data);
  const aliasNotices = teamAiAliasNotices(
    aliasStatus,
    (alias) => handleHolderName(directory.data, alias),
    helperName
  );
  const renameKind = rename.isError ? teamAiRenameErrorKind(rename.error) : null;
  const nameDescribedBy = renameKind === null ? nameHintId : `${nameHintId} ${nameErrorId}`;

  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-4"
      data-testid="team-ai-helper"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-3 border-b border-line pb-2">
        <h3 id={titleId} className="text-body font-bold text-ink" data-testid="team-ai-helper-title">
          {helperName}
        </h3>
        <span className="text-meta text-ink-muted">{formatMessage("teamAi.helper.description")}</span>
      </div>

      <form className="flex min-w-0 flex-col gap-2" onSubmit={submitName} noValidate>
        <label htmlFor={nameInputId} className="text-meta font-semibold text-ink">
          {formatMessage("teamAi.helper.nameLabel")}
        </label>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id={nameInputId}
            name="helperName"
            className="sm:max-w-xs"
            value={draft}
            maxLength={TEAM_AI_NAME_MAX_LENGTH}
            autoComplete="off"
            disabled={rename.isPending}
            aria-invalid={renameKind === null ? undefined : true}
            aria-describedby={nameDescribedBy}
            data-testid="team-ai-helper-name"
            onChange={(event) => {
              edited.current = true;
              setSaved(false);
              setDraft(event.currentTarget.value);
            }}
          />
          <Button
            type="submit"
            size="sm"
            className="tap-target self-start aria-disabled:opacity-50"
            aria-disabled={nameLocked || undefined}
            aria-busy={rename.isPending || undefined}
            data-testid="team-ai-helper-name-save"
          >
            {rename.isPending ? formatMessage("teamAi.helper.nameSaving") : formatMessage("teamAi.helper.nameSave")}
          </Button>
        </div>
        <p id={nameHintId} className="break-keep text-meta text-ink-muted">
          {formatMessage("teamAi.helper.nameHint")}
        </p>
        {renameKind !== null && (
          <p
            id={nameErrorId}
            role="alert"
            className="break-keep text-meta text-danger"
            data-testid="team-ai-helper-name-error"
          >
            {formatMessage(TEAM_AI_RENAME_ERROR_COPY[renameKind])}
          </p>
        )}
        {saved && !rename.isError && (
          <p role="status" className="break-keep text-meta text-ok" data-testid="team-ai-helper-name-saved">
            {formatMessage("teamAi.helper.nameSaved")}
          </p>
        )}
        {aliasNames !== null && (
          <p className="break-keep text-meta text-ink" data-testid="team-ai-helper-aliases">
            {formatMessage("teamAi.helper.aliasesLine", { names: aliasNames })}
          </p>
        )}
        {nameStatus !== null && (
          <p className="break-keep text-meta text-ink-muted" data-testid="team-ai-helper-name-status">
            {formatMessage(TEAM_AI_NAME_STATUS_COPY[nameStatus])}
          </p>
        )}
        {aliasNotices.map((notice) => (
          <p key={notice} className="break-keep text-meta text-ink-muted" data-testid="team-ai-helper-alias-notice">
            {notice}
          </p>
        ))}
      </form>

      <section aria-labelledby={rolesTitleId} className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h4 id={rolesTitleId} className="text-body font-semibold text-ink">
            {formatMessage("teamAi.helper.rolesHeading")}
          </h4>
          <p className="break-keep text-meta text-ink-muted">{formatMessage("teamAi.helper.rolesHint")}</p>
        </div>
        <TeamAiRolesList
          roles={roles}
          disabled={offline || toggle.isPending}
          busyBundle={busyBundle}
          rowNotices
          testIdPrefix="team-ai-helper"
          labelledBy={rolesTitleId}
          onToggle={(bundle, next) => {
            if (offline || toggle.isPending) return;
            toggle.mutate({ bundle, next });
          }}
        />
        {offline && (
          <p className="break-keep text-meta text-ink-muted" data-testid="team-ai-helper-offline">
            {formatMessage("teamAi.helper.rolesOffline")}
          </p>
        )}
        {toggle.isError && (
          <p role="alert" className="break-keep text-meta text-danger" data-testid="team-ai-helper-roles-error">
            {formatMessage(TEAM_AI_ROLES_ERROR_COPY[teamAiRolesErrorKind(toggle.error)])}
          </p>
        )}
      </section>
    </section>
  );
}
