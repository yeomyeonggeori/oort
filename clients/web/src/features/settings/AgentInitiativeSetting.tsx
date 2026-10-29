import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_INITIATIVE_SECTION_DESCRIPTION,
  AGENT_INITIATIVE_SECTION_TITLE,
  AGENT_INITIATIVE_SWITCH_DESCRIPTION,
  AGENT_INITIATIVE_SWITCH_LABEL,
  agentInitiativeBusyLabel,
  agentInitiativeSaveErrorCopy,
  probeAgentInitiativeSwitch,
  readAgentInitiative,
  setAgentInitiativeSwitch,
} from "@momo/core/features/settings/agentInitiativeSwitch";
import { fetchWorkspaceSettingsBag } from "@momo/core/features/settings/teamAiSwitch";
import { Switch } from "@/design/ui/switch";
import { SettingsRow } from "./shell/SettingsRow";
import { SettingsSection } from "./shell/SettingsSection";
import { CardBody } from "./workTierPolicy";

// =============================================================================
// 설정 › 워크스페이스 › 「에이전트의 먼저 제안」 (ADR-0186 증보 v5 U-b-3 K1, #4705).
//
// 관리자 전용 설정 가방의 불리언 키 `agent_initiative` 한 줄이다. **키가 없으면 켜짐**이라
// (「oort 도우미」 스위치와 반대) 처음 보는 관리자는 켜진 스위치를 본다.
//
// **이 카드는 확인된 뒤에만 선다.** 가방을 읽지 못하면(구성원 403) 아무것도 그리지 않고, 서버가
// 키를 아는지 확인하지 못해도 그리지 않는다(판정은 코어 `agentInitiativeSwitch.ts`). 그래서
// 키를 모르는 서버와 구성원 화면에는 카드가 없다. 로딩 뼈대도 세우지 않는다: 없을 수도 있는 카드의
// 자리를 잡아 두면 그 자리가 거짓말이 된다. 폰에는 워크스페이스 설정 화면이 없어 이 카드도 없다.
// =============================================================================

function agentInitiativeSettingKey(workspaceId: string) {
  return ["settings", "agent-initiative", workspaceId.toLowerCase()] as const;
}

export function AgentInitiativeSetting({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const client = useQueryClient();
  const bagKey = agentInitiativeSettingKey(workspaceId);
  const bag = useQuery({
    queryKey: bagKey,
    queryFn: () => fetchWorkspaceSettingsBag(workspaceId),
    retry: false,
    staleTime: 30_000,
  });
  const state = bag.data === undefined ? null : readAgentInitiative(bag.data);
  // 가방에 키가 있으면 묻지 않는다. 없을 때만 부작용 없는 물음을 한 번 던진다.
  const probe = useQuery({
    queryKey: [...bagKey, "probe"],
    queryFn: () => probeAgentInitiativeSwitch(workspaceId),
    enabled: state !== null && !state.known,
    retry: false,
    staleTime: Infinity,
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) => setAgentInitiativeSwitch(workspaceId, enabled),
    onSuccess: (saved) => client.setQueryData(bagKey, saved),
  });

  const supported = state !== null && (state.known || probe.data === "ready");
  if (!supported) return null;

  const nameId = "workspace-agent-initiative-name";
  const descId = "workspace-agent-initiative-desc";
  const offlineId = "workspace-agent-initiative-offline";
  // 저장 중에는 누른 값을 보여 준다(되돌아 튀는 토글은 고장 난 것처럼 보인다).
  const shownEnabled =
    save.isPending && typeof save.variables === "boolean"
      ? save.variables
      : state.enabled;

  return (
    <SettingsSection
      title={AGENT_INITIATIVE_SECTION_TITLE}
      description={AGENT_INITIATIVE_SECTION_DESCRIPTION}
      testId="workspace-agent-initiative-card"
    >
      <SettingsRow
        label={
          <span aria-live="polite">
            {save.isPending
              ? agentInitiativeBusyLabel(shownEnabled)
              : AGENT_INITIATIVE_SWITCH_LABEL}
          </span>
        }
        description={AGENT_INITIATIVE_SWITCH_DESCRIPTION}
        labelId={nameId}
        descriptionId={descId}
        keep
      >
        <Switch
          id="workspace-agent-initiative"
          testId="workspace-agent-initiative"
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
            data-testid="workspace-agent-initiative-save-error"
          >
            {agentInitiativeSaveErrorCopy(save.error)}
          </p>
        </CardBody>
      )}
    </SettingsSection>
  );
}
