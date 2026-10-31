import React, {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {
  AGENT_USAGE_COPY as COPY, agentUsageKey, agentUsageLine, fetchAgentUsage,
  hiddenUsageLabel, saveSubscriptionFee, subscriptionAmount, usageForAgent, usageLine,
  type AgentUsage,
} from '@momo/core/features/settings/agentUsage';
import {memberFor} from '@momo/core/features/workspace/directory';
import {OutlineButton, Sentence} from '../../design/atoms';
import {InputPill} from '../../design/sheetParts';
import {font, line, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {useSession} from '../../session/useSession';
import {useDirectory} from '../workspace/queries';

export function useAgentUsage(workspaceId: string) {
  return useQuery({queryKey: agentUsageKey(workspaceId), queryFn: () => fetchAgentUsage(workspaceId), staleTime: 30_000, retry: false});
}

export function AgentUsageStatus({agentId}: {agentId?: string}) {
  const {workspaceId} = useSession();
  const query = useAgentUsage(workspaceId);
  const styles = useStyles(buildStyles);
  const {directory} = useDirectory(workspaceId);
  const row = query.data && agentId ? usageForAgent(query.data, agentId) : undefined;
  const failed = query.isError || query.fetchStatus === 'paused';
  const label = query.fetchStatus === 'paused' ? COPY.offline : query.isError ? COPY.error : query.isPending ? COPY.loading : agentId ? `${COPY.title}: ${row ? agentUsageLine(row, memberFor(directory, agentId)?.brain) : COPY.unavailable}` : query.data && hiddenUsageLabel(query.data.hiddenPersonalAgents);
  return label ? <View style={styles.status}>
    <Sentence style={styles.detail} testID="agent-usage-status">{label}</Sentence>
    {failed && <OutlineButton label="다시 불러오기" onPress={() => {void query.refetch();}} />}
  </View> : null;
}

function SubscriptionEditor({workspaceId, row}: {workspaceId: string; row: AgentUsage}) {
  const styles = useStyles(buildStyles);
  const client = useQueryClient();
  const [value, setValue] = useState(row.subscriptionFee ? String(row.subscriptionFee.monthlyMicroUsd / 1_000_000) : '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const save = async () => {
    if (saving) {return;}
    let amount: number | null;
    setMessage(''); setFailed(false);
    try {amount = subscriptionAmount(value);}
    catch (error) {setFailed(true); setMessage((error as Error).message); return;}
    setSaving(true);
    try {
      await saveSubscriptionFee(workspaceId, row.agentMemberId, amount);
      setMessage(COPY.saved);
      await client.invalidateQueries({queryKey: agentUsageKey(workspaceId)});
    } catch {setFailed(true); setMessage(COPY.saveError);}
    finally {setSaving(false);}
  };
  return <View style={styles.group}>
    <Text style={styles.detail}>{COPY.subscription}</Text>
    <InputPill accessibilityLabel={COPY.subscription} value={value} onChangeText={setValue} keyboardType="decimal-pad" editable={!saving} testID={`subscription-${row.agentMemberId}`} />
    <OutlineButton label={saving ? '저장하고 있어요' : '저장'} onPress={() => {void save();}} accessibilityLabel="구독 정액 저장" />
    <Sentence style={styles.detail}>비워서 저장하면 정액을 지워요.</Sentence>
    <Sentence accessibilityLiveRegion="polite" accessibilityRole={failed ? 'alert' : undefined} style={failed ? styles.error : styles.detail}>{message}</Sentence>
  </View>;
}

export function AgentMonthlyReport({workspaceId}: {workspaceId: string}) {
  const styles = useStyles(buildStyles);
  const query = useAgentUsage(workspaceId);
  const {directory} = useDirectory(workspaceId);
  const data = query.data;
  if (query.isPending || query.isError || query.fetchStatus === 'paused') {
    return <View style={styles.state} testID="agent-monthly-report-state">
      <Sentence style={styles.detail} accessibilityLiveRegion="polite">{query.fetchStatus === 'paused' ? COPY.offline : query.isError ? COPY.error : COPY.loading}</Sentence>
      {query.isError && <OutlineButton label="다시 불러오기" onPress={() => {void query.refetch();}} />}
    </View>;
  }
  if (!data) {return null;}
  return <View style={styles.report} testID="agent-monthly-report">
    <Sentence style={styles.detail}>{COPY.note}</Sentence>
    <Text style={styles.detail}>{data.range.from.slice(0, 10)} ~ {data.range.to.slice(0, 10)} (UTC)</Text>
    <OutlineButton label="다시 불러오기" onPress={() => {void query.refetch();}} />
    {data.totals.workspace ? <Sentence style={styles.number}>워크스페이스 전체 · {usageLine(data.totals.workspace)}</Sentence> : <>
      <Sentence style={styles.number}>내 에이전트 · {usageLine(data.totals.mine)}</Sentence>
      <Sentence style={styles.number}>공유 에이전트 · {usageLine(data.totals.shared)}</Sentence>
    </>}
    {data.agents.length === 0 && <Sentence style={styles.detail}>{COPY.empty}</Sentence>}
    {data.agents.map(row => {
      const member = memberFor(directory, row.agentMemberId);
      return <View key={row.agentMemberId} style={styles.row}>
        <Text style={styles.name}>{member?.displayName ?? '에이전트'}{member?.handle ? ` (@${member.handle})` : ''}</Text>
        <Sentence style={styles.number}>{agentUsageLine(row, member?.brain)}</Sentence>
        {data.totals.workspace && member?.callableBy === 'everyone' && <SubscriptionEditor workspaceId={workspaceId} row={row} />}
      </View>;
    })}
    {hiddenUsageLabel(data.hiddenPersonalAgents) && <Sentence style={styles.detail}>{hiddenUsageLabel(data.hiddenPersonalAgents)}</Sentence>}
  </View>;
}

const buildStyles = (color: Palette) => StyleSheet.create({
  // 가터는 이 부품들이 스스로 진다. 부품이 서는 자리 어디에도 가로 여백을 주는 그릇이 없기 때문이다.
  //  - 설정 안쪽 장의 스크롤은 가로 여백을 주지 않는다(`SettingsPage` 의 `subContent`): 장마다 제 가터를 진다
  //    (`themePage`). 월 보고 장은 이 둘이 진다 - 다 불러온 보고서(`report`)와 불러오는 중·오류·오프라인 줄(`state`).
  //  - 에이전트 목록·상세도 같다(#4912 2차, 디자인 검수 H2). `Screen` 은 가로 여백이 없고 상세의 스크롤 `body` 는
  //    아래 여백뿐이라, `AgentUsageStatus` 가 가터 없이 서면 줄이 화면 가장자리에 붙는다. 이 화면들의 다른 줄
  //    (`SectionLabel`·`stateBlock`·`notice`)이 제 가터를 지는 것과 같은 문법으로 `status` 가 진다.
  // `group` 에는 얹지 않는다: `SubscriptionEditor` 가 `report` 안에 들어 있어서, 얹으면 이중 인셋이 된다.
  report: {gap: space.md, paddingHorizontal: SAFE_GUTTER},
  state: {gap: space.sm, paddingHorizontal: SAFE_GUTTER},
  status: {gap: space.sm, paddingHorizontal: SAFE_GUTTER},
  group: {gap: space.sm},
  row: {gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.border},
  name: {fontSize: font.body, lineHeight: line.body, color: color.text, fontWeight: '600'},
  detail: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted, flexShrink: 1},
  number: {fontSize: font.meta, lineHeight: line.meta, color: color.text, fontVariant: ['tabular-nums']},
  error: {fontSize: font.meta, lineHeight: line.meta, color: color.danger},
});
