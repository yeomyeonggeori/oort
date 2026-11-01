import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchWorkspaceSettingsBag,
  probeTeamAiSwitch,
  readTeamAiSwitch,
  setTeamAiSwitch,
  TEAM_AI_SECTION_DESCRIPTION,
  TEAM_AI_SWITCH_LABEL,
  teamAiHelperName,
  teamAiSaveErrorCopy,
  teamAiSectionTitle,
  teamAiSwitchBusyLabel,
  teamAiSwitchDescription,
} from "@momo/core/features/settings/teamAiSwitch";
import { memberFor } from "@momo/core/features/workspace/directory";
import { Switch } from "@/design/ui/switch";
import { useDirectory } from "@/features/workspace/useWorkspace";
import { SettingsRow } from "./shell/SettingsRow";
import { SettingsSection } from "./shell/SettingsSection";
import { CardBody } from "./workTierPolicy";

// =============================================================================
// 설정 › 워크스페이스 › 「oort 도우미」 (ADR-0201 D8, #3836).
//
// **이 카드는 확인된 뒤에만 선다.** 운영자 전용 가방을 읽지 못하면(구성원 403) 아무 것도
// 그리지 않고, 서버가 스위치를 아는지 확인하지 못해도 그리지 않는다(판정은 코어
// `teamAiSwitch.ts`). 그래서 #3837 이전 서버와 구성원 화면에는 카드가 없다. 로딩 뼈대도
// 세우지 않는다: 없을 수도 있는 카드의 자리를 잡아 두면 그 자리가 거짓말이 된다.
// =============================================================================

export function teamAiSettingKey(workspaceId: string) {
  return ["settings", "team-ai", workspaceId.toLowerCase()] as const;
}

export function TeamAiSetting({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const client = useQueryClient();
  const bagKey = teamAiSettingKey(workspaceId);
  const bag = useQuery({
    queryKey: bagKey,
    queryFn: () => fetchWorkspaceSettingsBag(workspaceId),
    retry: false,
    staleTime: 30_000,
  });
  const state = bag.data === undefined ? null : readTeamAiSwitch(bag.data);
  // 제목과 설명이 부르는 이름은 도우미 멤버의 표시 이름이다(ADR-0201 증보 v3 B10-7).
  const directory = useDirectory(workspaceId);
  const helperName = teamAiHelperName(
    memberFor(directory.directory, state?.memberId ?? undefined)
  );
  // 가방에 키가 있으면 묻지 않는다. 없을 때만 부작용 없는 물음을 한 번 던진다.
  const probe = useQuery({
    queryKey: [...bagKey, "probe"],
    queryFn: () => probeTeamAiSwitch(workspaceId),
    enabled: state !== null && !state.known,
    retry: false,
    staleTime: Infinity,
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) => setTeamAiSwitch(workspaceId, enabled),
    onSuccess: (saved) => client.setQueryData(bagKey, saved),
  });

  const supported =
    state !== null && (state.known || probe.data === "ready");
  if (!supported) return null;

  const nameId = "workspace-team-ai-name";
  const descId = "workspace-team-ai-desc";
  const offlineId = "workspace-team-ai-offline";
  // 저장 중에는 누른 값을 보여 준다(링크 확인 스위치와 같은 이유: 되돌아 튀는 토글은
  // 고장 난 것처럼 보인다).
  const shownEnabled =
    save.isPending && typeof save.variables === "boolean"
      ? save.variables
      : state.enabled;

  return (
    <SettingsSection
      title={teamAiSectionTitle(helperName)}
      description={TEAM_AI_SECTION_DESCRIPTION}
      testId="workspace-team-ai-card"
    >
      <SettingsRow
        label={
          <span aria-live="polite">
            {save.isPending
              ? teamAiSwitchBusyLabel(shownEnabled)
              : TEAM_AI_SWITCH_LABEL}
          </span>
        }
        description={teamAiSwitchDescription(helperName)}
        labelId={nameId}
        descriptionId={descId}
        keep
      >
        <Switch
          id="workspace-team-ai"
          testId="workspace-team-ai"
          checked={shownEnabled}
          disabled={offline}
          labelledBy={nameId}
          describedBy={offline ? `${descId} ${offlineId}` : descId}
          onCheckedChange={(next) => {
            if (offline || save.isPending) return;
            save.mutate(next);
          }}
        />
      </SettingsRow>
      {offline && (
        <CardBody>
          <p id={offlineId} className="text-meta text-ink-muted">
            연결이 끊겨 지금은 이 설정을 바꿀 수 없어요.
          </p>
        </CardBody>
      )}
      {save.isError && (
        <CardBody>
          <p
            className="text-meta text-danger"
            role="alert"
            data-testid="workspace-team-ai-save-error"
          >
            {teamAiSaveErrorCopy(save.error)}
          </p>
        </CardBody>
      )}
    </SettingsSection>
  );
}
