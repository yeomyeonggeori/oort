import {addChannelMember, type RosterMember} from '@momo/core/lib/api';
import {AVATAR_SIZE} from '@momo/core/features/workspace/avatar';
import type {Directory} from '@momo/core/features/workspace/directory';
import {
  addChannelMemberFailure,
  channelMemberCandidates,
  isChannelMember,
  withChannelMemberAdded,
} from '@momo/core/features/channels/memberAdd';
import {useQueryClient} from '@tanstack/react-query';
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {FlatList, StyleSheet, View} from 'react-native';

import {FailureBanner, Sentence} from '../design/atoms';
import {PageSheet, usePageSheetScrollProps} from '../design/PageSheet';
import {SheetHeader} from '../design/SheetChrome';
import {GroupCardItem, InputPill, ListRow} from '../design/sheetParts';
import {useStyles} from '../design/theme';
import {font, SAFE_GUTTER, SHEET, space, type Palette} from '../design/tokens';
import {SHELL_ICONS} from '../design/icons';
import {Avatar} from '../features/conversation/Avatar';
import {FaceWithStatusDot} from '../features/presence/FaceWithStatusDot';
import {useHumanStatusDot} from '../features/presence/useHumanStatusDot';
import {useDirectory, workspaceKeys} from '../features/workspace/queries';
import {useFormatMessage} from '../i18n/useFormatMessage';
import {useSession} from '../session/useSession';

// =============================================================================
// 채널에 멤버 추가 시트 — 채널을 만든 직후 이어서 뜬다(#5784, 공개·비공개 모두).
//
// 폰에는 채널에 사람을 넣는 화면이 없었다(홈 빈 상태가 「멤버 추가는 데스크탑에서」라고 말했다). 채널은 만든 사람 한 명으로
// 시작하고(공개도 지금은 앞으로 들어오는 사람만 자동이다) 다른 사람은 누군가 추가해야 들어오므로, 만든 그 자리에서 이 시트를 잇는다.
// X 가 건너뛰기다(시트의 닫는 길 셋 그대로). 새 채널 시트가 iOS 에서 다 내려간 뒤에 선다(`NewChannelSheet` 의 넘겨주기, #5417).
//
// 규칙은 모두 웹 「멤버 추가」 창과 같은 코어다:
//   누구를 보이나   `channelMemberCandidates` — 나를 뺀 명부, 이름·핸들 검색, 사람 다음 에이전트
//   이미 있나       `isChannelMember` — 명부의 `channelIds`. 이미 있는 사람도 목록에 남아 「멤버」로 선다(누른 줄이 사라지지 않음)
//   누르면          `withChannelMemberAdded` 로 명부에 먼저 넣고(낙관적) 서버(`POST …/channels/{ch}/members`)가 거절하면 되돌린다
//   거절 문장       `addChannelMemberFailure`
//
// 모양은 새 DM 시트와 같은 「사람 고르기」다: 큰 단 `PageSheet`, 목록 밖에 고정된 머리, 검색 알약, 묶음 카드의 사람 줄
// (`docs/design-system/phone-sheets.md` §1 규칙 4 — 고르는 시트는 목록이 길어도 시트). 다른 점은 고르면 닫히지 않고 그 줄이
// 「멤버」로 바뀐다는 것 — 여러 사람을 차례로 넣는다.
// =============================================================================

export interface ChannelMemberAddTarget {
  id: string;
  name: string;
  /** 방금 만든 채널의 공개 범위 — 안내 한 줄이 달라진다(공개: 앞으로 들어오는 사람은 자동, 비공개: 추가한 멤버에게만). */
  kind: 'public' | 'private';
}

export function ChannelMemberAddSheet({
  target,
  onClose,
}: {
  target: ChannelMemberAddTarget;
  onClose: () => void;
}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel={formatMessage('mobile.addMember.title')}
      scrimLabel={formatMessage('mobile.addMember.close')}
      testID="channel-member-add-sheet">
      <SheetBody target={target} />
    </PageSheet>
  );
}

/**
 * 추가는 명부 캐시에 먼저 쓰고 실패하면 되돌린다(웹 `useAddChannelMember` 와 같은 순서). 진행 중인 명부 읽기가 낙관적 값을 덮지
 * 않게 먼저 세우고, 서버가 받으면 다시 읽어 진짜 행으로 맞춘다.
 */
function useAddMember(workspaceId: string, channelId: string) {
  const client = useQueryClient();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<{memberId: string; message: string} | null>(null);
  const inFlight = useRef(new Set<string>());

  const add = useCallback(
    async (memberId: string) => {
      if (inFlight.current.has(memberId)) return;
      inFlight.current.add(memberId);
      setPendingIds(prev => new Set(prev).add(memberId));
      setFailure(null);
      const key = workspaceKeys.roster(workspaceId);
      await client.cancelQueries({queryKey: key});
      const previous = client.getQueryData<RosterMember[]>(key);
      client.setQueryData<RosterMember[]>(key, current =>
        current ? withChannelMemberAdded(current, channelId, memberId) : current,
      );
      try {
        await addChannelMember(workspaceId, channelId, memberId);
        void client.invalidateQueries({queryKey: key});
      } catch (error) {
        client.setQueryData<RosterMember[]>(key, previous);
        setFailure({memberId, message: addChannelMemberFailure(error)});
      } finally {
        inFlight.current.delete(memberId);
        setPendingIds(prev => {
          const next = new Set(prev);
          next.delete(memberId);
          return next;
        });
      }
    },
    [client, workspaceId, channelId],
  );

  return {pendingIds, failure, add};
}

function SheetBody({target}: {target: ChannelMemberAddTarget}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  // 목록은 날 `FlatList` 라 스스로 시트에 알려야 한다(#4612) — 새 DM 시트와 같다.
  const sheetScroll = usePageSheetScrollProps();
  const {member, workspaceId} = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const directory = directoryQuery.directory;
  const [query, setQuery] = useState('');
  const {pendingIds, failure, add} = useAddMember(workspaceId, target.id);

  const groups = useMemo(
    () => channelMemberCandidates(directory.members, member.id, query),
    [directory.members, member.id, query],
  );
  // 사람 다음 에이전트 — 한 카드에 이어 세우고 보조 줄이 종류를 말한다(새 DM 시트와 같은 문법).
  const rows = useMemo(() => [...groups.people, ...groups.agents], [groups]);

  const trimmed = query.trim();
  const emptyText = directoryQuery.isPending
    ? formatMessage('mobile.addMember.loading')
    : groups.total === 0
      ? formatMessage('mobile.addMember.emptyWorkspace')
      : formatMessage('mobile.addMember.noMatch', {query: trimmed});

  // 머리(원형 X·제목)는 목록 밖에 고정이다. 안내·검색·실패는 목록의 머리라 목록과 함께 스크롤한다.
  const listHeader = (
    <View style={styles.listHeader}>
      <Sentence style={styles.lead} testID="channel-member-add-lead">
        {formatMessage(
          target.kind === 'public'
            ? 'timeline.addMember.createdDescriptionPublic'
            : 'timeline.addMember.createdDescription',
          {name: target.name},
        )}
      </Sentence>
      <InputPill
        icon={SHELL_ICONS.search}
        value={query}
        onChangeText={setQuery}
        placeholder={formatMessage('mobile.addMember.searchPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        accessibilityLabel={formatMessage('mobile.addMember.searchLabel')}
        testID="channel-member-add-search"
      />
      {directoryQuery.error !== null && groups.total === 0 ? (
        <FailureBanner
          message={formatMessage('connection.load.membersTitle')}
          onRetry={() => void directoryQuery.refetch()}
          testID="channel-member-add-roster-error"
        />
      ) : null}
      {failure ? (
        <FailureBanner
          message={failure.message}
          onRetry={() => void add(failure.memberId)}
          testID="channel-member-add-error"
        />
      ) : null}
    </View>
  );

  return (
    <View style={styles.body}>
      <SheetHeader
        title={formatMessage('mobile.addMember.title')}
        closeLabel={formatMessage('mobile.addMember.close')}
        closeTestID="channel-member-add-close"
      />
      <FlatList
        {...sheetScroll}
        data={rows}
        keyExtractor={candidate => candidate.id}
        ListHeaderComponent={listHeader}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          directoryQuery.error !== null && groups.total === 0 ? null : (
            <Sentence style={styles.empty} testID="channel-member-add-empty">
              {emptyText}
            </Sentence>
          )
        }
        renderItem={({item, index}) => (
          <CandidateRow
            member={item}
            directory={directory}
            channelId={target.id}
            index={index}
            count={rows.length}
            pending={pendingIds.has(item.id)}
            onAdd={() => void add(item.id)}
          />
        )}
        testID="channel-member-add-list"
      />
    </View>
  );
}

/**
 * 고를 사람 한 줄. 이미 채널에 있으면 누를 수 없는 줄이 되고 오른쪽 값이 「멤버」다 — 흐리지 않는다(못 하는 것이 아니라 이미
 * 된 것이다). 누르는 동안은 값이 「추가하는 중」이고 다시 눌리지 않는다. 점과 이름은 새 DM 시트와 같은 판정을 읽는다.
 */
function CandidateRow({
  member,
  directory,
  channelId,
  index,
  count,
  pending,
  onAdd,
}: {
  member: RosterMember;
  directory: Directory;
  channelId: string;
  index: number;
  count: number;
  pending: boolean;
  onAdd: () => void;
}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  const dot = useHumanStatusDot(member);
  const kind = formatMessage(
    member.kind === 'agent' ? 'mobile.addMember.kindAgent' : 'mobile.addMember.kindHuman',
  );
  const present = isChannelMember(member, channelId);
  const value = present
    ? formatMessage('mobile.addMember.present')
    : pending
      ? formatMessage('mobile.addMember.adding')
      : undefined;
  const base = `${member.displayName}, @${member.handle}, ${kind}`;
  const spoken = [base, dot?.label, value].filter(Boolean).join(', ');
  return (
    <GroupCardItem index={index} count={count} inset={AVATAR_SIZE}>
      <ListRow
        leading={
          <FaceWithStatusDot
            size={AVATAR_SIZE}
            dot={dot}
            testID={`channel-member-add-status-dot-${member.handle}`}
            face={<Avatar directory={directory} memberId={member.id} ground="muted" />}
          />
        }
        leadingWidth={AVATAR_SIZE}
        title={member.displayName}
        detail={`@${member.handle} · ${kind}`}
        value={value}
        accessibilityLabel={spoken}
        accessibilityHint={present ? undefined : formatMessage('mobile.addMember.addHint')}
        busy={pending}
        disabled={pending}
        onPress={present ? undefined : onAdd}
        testID={`channel-member-add-person-${member.handle}`}
      />
    </GroupCardItem>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    body: {flex: 1},
    // 카드·입력은 가로 여백을 목록이 준다 — 시트 몸은 여백이 없다(`PageSheet`).
    list: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: SHEET.bodyTop,
      paddingBottom: space.xl * 2,
    },
    listHeader: {gap: space.sm, paddingBottom: space.lg},
    lead: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      color: color.textMuted,
    },
    empty: {
      paddingVertical: space.lg,
      fontSize: font.body,
      color: color.textMuted,
    },
  });
