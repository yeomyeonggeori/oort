import type {Member, Message, PluginCatalog, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import React, {useMemo} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {ChannelAudienceContext} from '../src/features/conversation/appsTail';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 「쓴 앱」 꼬리·막힘 문장 캡처 표면 (#3950). 실제 `MessageRow` 를 세운다. 서버가 없으므로 앱 목록과
// run 보고는 질의 캐시에 미리 넣는다(훅의 키·모양은 `appsTail.ts` 와 같다).
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure APPS-TAIL-<tail|dm|notices-a|notices-b|notices-c>
//   (라이트: LIGHT-APPS-TAIL-…)
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000e0';
const SELF = '00000000-0000-7000-8000-0000000000e1';
const HERMES = '00000000-0000-7000-8000-0000000000e2';
const RUN_A = '00000000-0000-7000-8000-0000000039a1';
const RUN_B = '00000000-0000-7000-8000-0000000039a2';
const NOW = Date.now();

function roster(id: string, kind: 'human' | 'agent', name: string): RosterMember {
  return {
    id, workspaceId: WS, kind, status: 'active', displayName: name, handle: name.toLowerCase(),
    channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([roster(SELF, 'human', '이도현'), roster(HERMES, 'agent', 'Hermes')]);
const ME: Member = {id: SELF, workspaceId: WS, kind: 'human', displayName: '이도현', handle: 'dohyun'};

const CATALOG = {
  plugins: [
    {pluginId: 'gmail', name: 'Gmail', version: '1', description: '', official: true, recommended: true,
      egressDomains: ['gmailmcp.googleapis.com'], recommendedFor: [], installed: true, enabled: true},
    {pluginId: 'github', name: 'GitHub', version: '1', description: '', official: true, recommended: true,
      egressDomains: ['api.githubcopilot.com'], recommendedFor: [], installed: true, enabled: true},
  ],
  toolsByPlugin: new Map(),
} as unknown as PluginCatalog;

function reply(id: string, seq: number, body: string, props: Record<string, unknown>): Message {
  return {
    id, channelId: 'ch', seq, hlcTs: seq, hlcCount: 0, authorMemberId: HERMES, type: 'text', body,
    state: 'sent', createdAtMs: NOW - (10 - seq) * 60_000, replyToId: 'q',
    replyTo: {id: 'q', seq: 1, authorMemberId: SELF, type: 'text', state: 'sent', body: '메일 찾아줘'},
    props,
  } as unknown as Message;
}
const ok = (run: string) => ({source: 'hermes_gateway', status: 'succeeded', run_id: run});
const bad = (note: Record<string, unknown>) => ({
  source: 'hermes_gateway', status: 'failed', run_id: RUN_A, app_notice: note,
});

const NOTICES_A = [
  {kind: 'site_off', site: 'mac'},
  {kind: 'site_silent', site: 'hermes'},
  {kind: 'login_lost', plugin_id: 'gmail', site: 'mac'},
  {kind: 'login_lost', plugin_id: 'gmail', site: 'hermes'},
  {kind: 'grant_revoked'},
];
const NOTICES_B = [
  {kind: 'rate_limited', plugin_id: 'github'},
  {kind: 'egress_blocked', plugin_id: 'gmail', host: 'gmailmcp.googleapis.com'},
  {kind: 'not_allowed', plugin_id: 'gmail'},
  {kind: 'working', site: 'hermes', since_ms: NOW - 3 * 60_000},
];

export function AppsTailSurface({which}: {which: string}): React.JSX.Element {
  const client = useMemo(() => {
    const c = new QueryClient({defaultOptions: {queries: {retry: false}}});
    c.setQueryData(['plugins', WS], CATALOG);
    c.setQueryData(['agent-run-apps-used', WS, RUN_A], [{pluginId: 'gmail', tool: 'search_threads', calls: 2}]);
    c.setQueryData(['agent-run-apps-used', WS, RUN_B], [
      {pluginId: 'github', tool: 'get_issue', calls: 1},
      {pluginId: 'github', tool: 'list_issues', calls: 3},
    ]);
    return c;
  }, []);
  let rows: Message[];
  let audience: number | null = 5;
  if (which === 'notices-a') {
    rows = NOTICES_A.map((n, i) => reply(`n${i}`, i + 2, '답을 만들지 못했어요.', bad(n)));
  } else if (which === 'notices-c') {
    // #4058: 실행 장소가 없는 문(Agent Port) — 문장만, 행동 없음.
    rows = [reply('p', 2, '답을 만들지 못했어요.', bad({kind: 'login_lost', plugin_id: 'gmail'}))];
    // #4058: system 행(정지·건너뜀 줄)은 본문이 이미 그 문장이다: 앱 문장을 또 붙이지 않는다.
    rows.push({
      ...reply('sys', 20, 'Hermes가 꺼져 있어서 못 했어요.', bad({kind: 'site_off', site: 'hermes'})),
      type: 'system',
    } as Message);
  } else if (which === 'notices-b') {
    rows = NOTICES_B.map((n, i) => reply(`n${i}`, i + 2, '답을 만들지 못했어요.', bad(n)));
  } else {
    if (which === 'dm') audience = null;
    rows = [
      reply('a', 2, '받은편지함에서 견적 관련 메일 두 건을 찾았어요. 본문은 옮기지 않고 요약만 적었어요.', ok(RUN_A)),
      reply('b', 3, '열린 이슈 4건 중 로그인 오류는 #812 하나예요.', ok(RUN_B)),
    ];
  }
  return (
    <Screen>
      <QueryClientProvider client={client}>
        <SessionProvider member={ME}>
          <ChannelAudienceContext.Provider value={audience}>
            <ScrollView contentContainerStyle={styles.pad}>
              {rows.map(row => (
                <View key={row.id}>
                  <MessageRow
                    message={row}
                    startsGroup
                    directory={DIRECTORY}
                    chips={[]}
                    nowMs={NOW}
                    approvalsProvided
                    actions={{
                      myMemberId: SELF, workspaceId: WS,
                      onToggleReaction: async () => {}, onEdit: async () => {}, onDelete: async () => {},
                    }}
                  />
                </View>
              ))}
            </ScrollView>
          </ChannelAudienceContext.Provider>
        </SessionProvider>
      </QueryClientProvider>
    </Screen>
  );
}

const styles = StyleSheet.create({pad: {paddingTop: 80, paddingBottom: 40}});
