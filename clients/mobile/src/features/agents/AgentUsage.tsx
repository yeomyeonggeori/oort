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
import {font, line, space, type Palette} from '../../design/tokens';
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
  return label ? <View style={styles.group}>
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
    return <View style={styles.group}>
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
  report: {gap: space.md},
  group: {gap: space.sm},
  row: {gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.border},
  name: {fontSize: font.body, lineHeight: line.body, color: color.text, fontWeight: '600'},
  detail: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted, flexShrink: 1},
  number: {fontSize: font.meta, lineHeight: line.meta, color: color.text, fontVariant: ['tabular-nums']},
  error: {fontSize: font.meta, lineHeight: line.meta, color: color.danger},
});
