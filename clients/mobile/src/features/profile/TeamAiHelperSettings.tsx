import {renameAgent} from '@momo/core/lib/api';
import {
  TEAM_AI_NAME_STATUS_COPY,
  TEAM_AI_RENAME_ERROR_COPY,
  TEAM_AI_ROLE_COPY,
  TEAM_AI_ROLES_ERROR_COPY,
  teamAiRoleNoticeKey,
} from '@momo/core/features/settings/teamAiCopyKeys';
import {
  handleHolderName,
  readTeamAiAliasStatus,
  readTeamAiNameStatus,
  teamAiAliasNotices,
  teamAiCallableNames,
} from '@momo/core/features/settings/teamAiNextStep';
import {
  patchTeamAiRoles,
  readTeamAiRoles,
  TEAM_AI_ALWAYS_ON_BUNDLE,
  TEAM_AI_BUNDLES,
  teamAiRolesErrorKind,
  teamAiSettingsToggleNotice,
  type TeamAiBundle,
  type TeamAiSwitchableBundle,
} from '@momo/core/features/settings/teamAiRoles';
import {
  teamAiNameDraft,
  teamAiRenameErrorKind,
  TEAM_AI_NAME_MAX_LENGTH,
} from '@momo/core/features/settings/teamAiSetup';
import {
  fetchWorkspaceSettingsBag,
  readTeamAiSwitch,
  teamAiHelperName,
} from '@momo/core/features/settings/teamAiSwitch';
import {TEAM_AI_QUERY_KEYS} from '@momo/core/features/settings/teamAiStageModel';
import {memberFor, type Directory} from '@momo/core/features/workspace/directory';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import React, {useEffect, useRef, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Screen} from '../../design/atoms';
import {PageHeader} from '../../design/SheetChrome';
import {GroupCard, InputPill, ListRow} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {SAFE_GUTTER, space} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useOnline} from '../inbox/useOnline';
import {useLayerClose} from '../../nav/EdgeSwipeBack';
import {workspaceKeys} from '../workspace/queries';
import {ActionRow, SettingsNote, SettingsSection} from './settingsRows';

// =============================================================================
// 설정 › 도우미: 이름과 할 수 있는 일 (ADR-0201 증보 v3 B3·B10, #4945). 관리자만.
//
// 웹 설정 › AI의 「도우미」 카드(`TeamAiHelperCard`)와 **같은 서버 길·같은 코어 판정·같은 사전**이다:
//  - 이름: 사람용 `PATCH …/agents/{agent}`. 새 이름이 부르는 이름(별칭)에 더해지는 것은 서버가 같은
//    트랜잭션에서 하고, 화면은 결과(부르는 이름 줄)를 보인다.
//  - 역할: `PATCH …/settings {team_ai_roles: {묶음: 불리언}}`. 누르는 즉시 그 묶음 하나만 저장한다.
//    파일·기억은 켜면 내용이 공급자로 가므로 그 행 아래에 고지를 늘 보인다. 그 둘을 **켤 때** 같은
//    본문에 고지 기록(`team_ai_roles_notice`)을 실어 서버가 스위치와 한 트랜잭션에 남긴다(#5040).
//
// 폰에는 온보딩 단계가 없다(ADR-0185 증보 §6 「폰은 새 단계를 만들지 않는다」): 키를 넣고 도우미를 켜는
// 일은 데스크탑·웹 온보딩과 설정이 맡고, 폰은 **이미 켜진** 도우미를 관리한다. 설정 가방을 읽지 못하면
// (관리자가 아님, 옛 서버) 행이 서지 않고, 도우미가 꺼져 있어도 서지 않는다.
//
// 모양은 `LinkPreviewSettings` 와 같다: 설정 페이지 위에 한 겹 더 쌓이는 장이고, 머리의 ‹ 와 왼쪽
// 가장자리 밀기와 VoiceOver escape 가 한 겹만 벗긴다. 문구는 전부 사전이다(`teamAi.*`).
// =============================================================================

// 시험 이름은 JSX 밖에서 짓는다 — 직접 문구 장부는 JSX 식 안의 문자열을 문구로 세므로 이름표가 장부를 올리지 않게 한다.
const BACK_TEST_ID = 'settings-back';

/** 웹과 같은 키(코어 `TEAM_AI_QUERY_KEYS.settingsBag`): 한 곳에서 바꾸면 같은 가방을 읽는 곳이 함께 따라간다. */
export const teamAiHelperBagKey = TEAM_AI_QUERY_KEYS.settingsBag;

/**
 * 행이 설지. 설정 가방을 읽었고(= 관리자) 도우미가 켜져 있고 멤버가 있을 때만이다. 읽는 중·못 읽음은 서지 않는다
 * (없을 수도 있는 행의 자리를 잡아 두지 않는다).
 */
export function useTeamAiHelperEntry(
  workspaceId: string,
  directory: Directory,
  enabled = true,
): {visible: boolean; helperName: string} {
  const bag = useQuery({
    queryKey: teamAiHelperBagKey(workspaceId),
    queryFn: () => fetchWorkspaceSettingsBag(workspaceId),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  const state = bag.data === undefined ? null : readTeamAiSwitch(bag.data);
  const helperName = teamAiHelperName(memberFor(directory, state?.memberId ?? undefined));
  return {
    visible: state !== null && state.enabled && state.memberId !== null,
    helperName,
  };
}

/** 「관리자 설정」 카드의 한 행 — 도우미의 지금 이름이 오른쪽 값이다. */
export function TeamAiHelperSettingRow({
  helperName,
  onPress,
}: {
  helperName: string;
  onPress: () => void;
}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  const title = formatMessage('teamAi.phone.rowTitle');
  return (
    <ListRow
      accessibilityLabel={`${title}, ${helperName}`}
      accessory="chevron"
      onPress={onPress}
      testID="settings-team-ai-helper-row"
      title={title}
      value={helperName}
    />
  );
}

export function TeamAiHelperSettingsPage({
  workspaceId,
  directory,
  onBack,
}: {
  workspaceId: string;
  directory: Directory;
  onBack: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const closeLayer = useLayerClose();
  const formatMessage = useFormatMessage();
  const online = useOnline();
  const client = useQueryClient();
  const goBack = closeLayer ?? onBack;
  const bagKey = teamAiHelperBagKey(workspaceId);

  const bag = useQuery({
    queryKey: bagKey,
    queryFn: () => fetchWorkspaceSettingsBag(workspaceId),
    retry: false,
    staleTime: 30_000,
  });
  const state = bag.data === undefined ? null : readTeamAiSwitch(bag.data);
  const memberId = state?.memberId ?? null;
  const helperName = teamAiHelperName(memberFor(directory, memberId ?? undefined));

  // ---- 이름 ---------------------------------------------------------------------
  const [draft, setDraft] = useState(helperName);
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setDraft(helperName);
  }, [helperName]);
  const [saved, setSaved] = useState(false);
  const rename = useMutation({
    mutationFn: (name: string) => renameAgent(workspaceId, memberId as string, name),
    onSuccess: () => {
      edited.current = false;
      setSaved(true);
      // 별칭 결과는 서버가 가방에 적는다. 새 이름은 명부에서 다시 읽는다.
      void client.invalidateQueries({queryKey: bagKey});
      void client.invalidateQueries({queryKey: workspaceKeys.roster(workspaceId)});
    },
  });
  const nameState = teamAiNameDraft(draft);
  const nameSavable = memberId !== null && nameState.valid && nameState.name !== helperName.trim();
  const nameLocked = !online || rename.isPending || !nameSavable;

  // ---- 역할 ---------------------------------------------------------------------
  const stored = readTeamAiRoles(bag.data);
  const [pending, setPending] = useState<{bundle: TeamAiSwitchableBundle; next: boolean} | null>(
    null,
  );
  const toggle = useMutation({
    mutationFn: (change: {bundle: TeamAiSwitchableBundle; next: boolean}) =>
      patchTeamAiRoles(
        workspaceId,
        {[change.bundle]: change.next},
        teamAiSettingsToggleNotice(change.bundle, change.next),
      ),
    onMutate: change => setPending(change),
    onSuccess: next => client.setQueryData(bagKey, next),
    onSettled: () => setPending(null),
  });
  const roles = pending === null ? stored : {...stored, [pending.bundle]: pending.next};
  const rolesLocked = !online || toggle.isPending;

  const aliasStatus = readTeamAiAliasStatus(bag.data);
  const aliasNames = teamAiCallableNames(aliasStatus);
  const nameStatus = readTeamAiNameStatus(bag.data);
  const aliasNotices = teamAiAliasNotices(
    aliasStatus,
    alias => handleHolderName(directory.members, alias),
    helperName,
  );
  const renameKind = rename.isError ? teamAiRenameErrorKind(rename.error) : null;

  const title = formatMessage('teamAi.phone.rowTitle');
  const nameLabel = formatMessage('teamAi.helper.nameLabel');
  const rowOf = (id: TeamAiBundle) => {
    const copy = TEAM_AI_ROLE_COPY[id];
    const locked = id === TEAM_AI_ALWAYS_ON_BUNDLE;
    const noticeKey = teamAiRoleNoticeKey(id);
    const hint = formatMessage(copy.hint);
    const parts = [hint];
    if (locked) parts.push(formatMessage('teamAi.roles.alwaysOn'));
    if (noticeKey !== null) parts.push(formatMessage(noticeKey));
    const detail = parts.join(' ');
    const rowTestId = `team-ai-helper-role-${id}`;
    const change = (next: boolean) => {
      if (locked || rolesLocked) return;
      toggle.mutate({bundle: id as TeamAiSwitchableBundle, next});
    };
    return (
      <ListRow
        accessory="toggle"
        busy={pending?.bundle === id}
        detail={detail}
        disabled={locked || rolesLocked}
        key={id}
        testID={rowTestId}
        title={formatMessage(copy.name)}
        toggle={{value: roles[id], onValueChange: change}}
      />
    );
  };

  return (
    <View onAccessibilityEscape={goBack} style={styles.root} testID="settings-team-ai-helper-page">
      <Screen>
        <PageHeader
          back={{
            label: formatMessage('mobile.locale.backToSettings'),
            onPress: goBack,
            testID: BACK_TEST_ID,
          }}
          testID="settings-sub-header"
          title={title}
          titleTestID="settings-sub-title"
        />
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
          ]}
          keyboardShouldPersistTaps="handled">
          {bag.isPending ? (
            <SettingsNote testID="team-ai-helper-loading">
              {formatMessage('teamAi.phone.loading')}
            </SettingsNote>
          ) : state === null || !state.enabled || memberId === null ? (
            <SettingsNote tone="danger" testID="team-ai-helper-unavailable">
              {formatMessage('teamAi.phone.loadFailed')}
            </SettingsNote>
          ) : (
            <>
              <SettingsSection>
                <GroupCard label={nameLabel} testID="team-ai-helper-name-card">
                  <View style={styles.inputBox}>
                    <InputPill
                      accessibilityLabel={nameLabel}
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!rename.isPending}
                      maxLength={TEAM_AI_NAME_MAX_LENGTH}
                      onChangeText={text => {
                        edited.current = true;
                        setSaved(false);
                        setDraft(text);
                      }}
                      returnKeyType="done"
                      testID="team-ai-helper-name"
                      value={draft}
                    />
                  </View>
                  <ActionRow
                    disabled={nameLocked}
                    onPress={() => {
                      if (nameLocked) return;
                      setSaved(false);
                      rename.mutate(nameState.name);
                    }}
                    pending={rename.isPending}
                    testID="team-ai-helper-name-save"
                    title={formatMessage(
                      rename.isPending ? 'teamAi.helper.nameSaving' : 'teamAi.helper.nameSave',
                    )}
                    tone="accent"
                  />
                </GroupCard>
                <SettingsNote>{formatMessage('teamAi.helper.nameHint')}</SettingsNote>
                {renameKind !== null ? (
                  <SettingsNote tone="danger" testID="team-ai-helper-name-error">
                    {formatMessage(TEAM_AI_RENAME_ERROR_COPY[renameKind])}
                  </SettingsNote>
                ) : null}
                {saved && !rename.isError ? (
                  <SettingsNote testID="team-ai-helper-name-saved">
                    {formatMessage('teamAi.helper.nameSaved')}
                  </SettingsNote>
                ) : null}
                {aliasNames !== null ? (
                  <SettingsNote testID="team-ai-helper-aliases">
                    {formatMessage('teamAi.helper.aliasesLine', {names: aliasNames})}
                  </SettingsNote>
                ) : null}
                {nameStatus !== null ? (
                  <SettingsNote testID="team-ai-helper-name-status">
                    {formatMessage(TEAM_AI_NAME_STATUS_COPY[nameStatus])}
                  </SettingsNote>
                ) : null}
                {aliasNotices.map(notice => (
                  <SettingsNote key={notice}>{notice}</SettingsNote>
                ))}
                {!online ? (
                  <SettingsNote testID="team-ai-helper-offline">
                    {formatMessage('teamAi.helper.rolesOffline')}
                  </SettingsNote>
                ) : null}
              </SettingsSection>

              <SettingsSection>
                <GroupCard
                  label={formatMessage('teamAi.helper.rolesHeading')}
                  testID="team-ai-helper-roles-card">
                  {TEAM_AI_BUNDLES.map(rowOf)}
                </GroupCard>
                <SettingsNote>{formatMessage('teamAi.helper.rolesHint')}</SettingsNote>
                {toggle.isError ? (
                  <SettingsNote tone="danger" testID="team-ai-helper-roles-error">
                    {formatMessage(TEAM_AI_ROLES_ERROR_COPY[teamAiRolesErrorKind(toggle.error)])}
                  </SettingsNote>
                ) : null}
              </SettingsSection>
            </>
          )}
        </ScrollView>
      </Screen>
    </View>
  );
}

const buildStyles = () =>
  StyleSheet.create({
    root: {flex: 1},
    content: {paddingTop: space.md, paddingHorizontal: SAFE_GUTTER, gap: space.lg},
    inputBox: {paddingHorizontal: space.md, paddingVertical: space.sm},
  });
