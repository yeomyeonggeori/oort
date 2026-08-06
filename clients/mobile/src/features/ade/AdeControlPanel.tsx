import {uuidEq} from '@momo/core/lib/api';
import {
  ADE_DRAWER_EMPTY_DETAIL,
  ADE_DRAWER_EMPTY_HEADLINE,
  ADE_STATE_LABEL,
  adeDiffLabel,
  durabilityTone,
  itemDurabilityBadge,
  type AdeItem,
  type AdeState,
} from '@momo/core/features/work/adeControl';
import {elapsedLabel} from '@momo/core/features/agents/workingSignal';
import {channelLabel} from '@momo/core/features/workspace/directory';
import React, {useCallback, useMemo} from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {
  EmptyState,
  FailureBanner,
  Screen,
  ScreenHeader,
} from '../../design/atoms';
import {
  color,
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
} from '../../design/tokens';
import {EdgeSwipeBack} from '../../nav/EdgeSwipeBack';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useSession} from '../../session/useSession';
import {AgentTurnStaleNotice} from '../agents/turnSurfaces';
import {useTickingNow} from '../agents/workingSignal';
import {useChannels, useDirectory} from '../workspace/queries';
import {useAdeControl} from './useAdeControl';

// =============================================================================
// 관제 = 목록 (ADR-0154 D2 의 2층, "웹 우선, **폰은 목록형**").
//
//   대화 화면   요약 한 줄     무엇이 몇 개
//   **이 화면** 세션 카드 목록  무엇이, 어디서, 얼마나, 살아남는지  <- 여기
//   데스크톱    터미널          실제로 무엇을 했는지
//
// ## 왜 바텀 시트가 아니라 **덮는 화면**인가 (이 앱의 관례 실측)
//
// 폰에는 이미 두 가지 관례가 있고, 둘은 서로 다른 것을 위해 있다.
//
//   `Modal transparent` + 바텀 시트   화면에 이미 있는 **한 대상**에 대한
//     (`MessageActionSheet`,          **행동의 묶음**. 길이가 고정이고, 닫으면
//      `MessageEditorSheet`)          있던 자리로 되돌아온다.
//   `EdgeSwipeBack` + `Screen`        **가는 곳**. 훑어보는 목록이고, 거기서
//     (`ThreadPanel`·`SearchScreen`   **다른 데로 떠날 수 있다**. 자기 헤더와
//      ·`AgentDetailScreen`)          자기 뒤로가기를 갖는다.
//
// 이 표면은 두 번째다. 길이가 워크스페이스의 작업 수만큼 변하고(서버는 원장을 200
// 행에서 자른다), 카드마다 하는 일이 **여기서 나가는 것**이다. 바텀 시트로 만들면
// 85% 높이 안에 스크롤을 하나 더 접어 넣게 되는데, 그 아래에는 이미 스크롤하는
// 타임라인이 있다 — 한 화면에 스크롤 세 겹은 어느 것이 손가락을 받을지 사람이
// 알 수 없다는 뜻이다.
//
// 그래서 요약 줄의 오른쪽 표지도 꺾쇠(›)다: 접히는 서랍이 아니라 밀려 들어오는
// 화면이라는 것을 누르기 전에 말한다.
//
// ## 카드는 「확대」된다 — 그리고 폰에서 그 도착지는 **채널**이다
//
// 웹은 두 갈래로 확대한다: 턴은 작업 패널(`AgentWorkPanel`)로, ACP 세션은 작업 세션
// 패널(`?work=`)로. **폰에는 그 둘이 없다.** 없는 것이 누락이 아니라 결정이라는
// 근거가 남아 있다 — ADR-0137 D5 가 폰에서 raw PTY 를 내렸고(390pt 화면에서 80칸을
// 읽는 것이 문제라고 적었다), `AgentDetailScreen` 이 그것을 "터미널은 여기서 열지
// 않는다" 로 이행했다.
//
// 그러므로 이 화면은 세 번째 상세를 만들지 않는다. 확대의 도착지는 **그 카드의
// 채널** 하나이고, 그 규칙은 두 종류에 똑같이 적용된다:
//
//   턴    채널의 컴포저 위에 `AgentActivityBar` 가 그 턴을 이름·경과·「중단」과 함께
//         이미 그리고 있다. 폰에서 턴에 대해 할 수 있는 모든 일이 거기 있다.
//   세션  ADR-0154 D2 가 "채널이 세션의 홈" 이라고 적었고, 원장도 그렇게 생겼다
//         (`WorkSession.rootMessageId` 가 그 채널의 카드다). 그 카드가 있는 방까지가
//         폰이 정직하게 데려다줄 수 있는 곳이다.
//
// 그 방의 **어느 줄**인지까지 데려가지 못하는 것은 남는 구멍이고, 이 배치가 메우지
// 않은 이유는 재료가 없어서다: 대화 화면의 앵커는 `{messageId, seq}` 쌍을 요구하는데
// (없는 줄을 「더 위에 있다」고 말할 수 있어야 해서) 코어의 `AdeItem` 은 둘 중
// 어느 것도 나르지 않는다. 없는 seq 를 지어내는 대신 방까지 데려다주고 멈춘다.
// =============================================================================

/**
 * 3분류 -> 칩의 색.
 *
 * 웹의 클래스를 옮겨 적지 않는다. 두 앱의 팔레트가 같은 낱말에 다른 뜻을 걸어
 * 두었기 때문이고, 옮겨 적으면 폰에서 틀린다:
 *
 *   `blocked`  앰버. 폰의 앰버는 「사람이 필요하다」이고(`tokens.ts`), 그것이 D1 이
 *              이 상태에 준 뜻이다. `AgentTurnBadge` 가 승인 대기에 이미 쓴다.
 *   `working`  초록. `AgentDetailScreen` 의 작업 세션 행이 `running` 에 쓰는 그
 *              색이고, 이 목록이 집계하는 것이 바로 그 행들이다.
 *   `idle`     무채색. 「끝났고 호스트가 터미널을 열어 두고 있다」는 구경이지
 *              행동이 아니다.
 */
const STATE_CHIP: Readonly<
  Record<AdeState, {backgroundColor: string; borderColor: string}>
> = {
  working: {backgroundColor: color.okSurface, borderColor: color.okBorder},
  blocked: {backgroundColor: color.warnSurface, borderColor: color.warnBorder},
  idle: {backgroundColor: color.surfacePressed, borderColor: color.border},
};

const STATE_CHIP_TEXT: Readonly<Record<AdeState, {color: string}>> = {
  working: {color: color.ok},
  blocked: {color: color.warn},
  idle: {color: color.textMuted},
};

const DURABILITY_TEXT = {
  ok: {color: color.ok},
  muted: {color: color.textMuted},
  warn: {color: color.warn},
} as const;

/** 명부가 아직이거나 내가 못 보는 방. 방 이름을 지어내지 않는다(웹과 같은 낱말). */
const UNRESOLVED_CHANNEL = '다른 채널';

function AdeCard({
  item,
  channelName,
  nowMs,
  hostsPending,
  onPress,
}: {
  item: AdeItem;
  channelName: string;
  nowMs: number;
  hostsPending: boolean;
  onPress: () => void;
}): React.JSX.Element {
  // 생존성은 **등록기가 답한 뒤에만** 말한다. 「모른다」와 「아직 안 물어봤다」는
  // 다른 사실이고, 뒤의 것을 「실행 위치 확인 필요」로 그리면 이 화면은 열릴 때마다
  // 모든 카드에 경고를 하나씩 달고 뜬 다음 조용히 지운다 — 그렇게 되는 순간 그것은
  // 경고가 아니다(코어 `itemDurabilityBadge` 가 턴 카드에 대해 하는 그 말이다).
  const durability = hostsPending ? null : itemDurabilityBadge(item);
  const elapsed =
    item.startedAtMs === undefined
      ? null
      : elapsedLabel(item.startedAtMs, item.endedAtMs ?? nowMs);
  // 리뷰 병목 방어의 첫 칸(D2). 오늘은 어느 빌더도 채우지 않으므로 언제나 `null`
  // 이고, 그때 이 줄은 **서지 않는다**. 웹은 자리를 예약하지만(격자에서 카드 높이가
  // 나중에 바뀌지 않게), 폰의 세로 목록에서는 카드가 한 줄 자라도 위에서 읽던 줄이
  // 움직이지 않는다 — 그 대신 지불하게 되는 것은 390pt 화면에서 카드마다 영구히
  // 비어 있는 한 줄이고, 그것은 이 층이 요약 줄에 대해 이미 거절한 거래다.
  const diff = adeDiffLabel(item.diff);

  return (
    <Pressable
      accessibilityRole="button"
      // 한 문장으로 합친다. `Pressable` 은 기본이 `accessible` 이라 안쪽 조각들은
      // 이 라벨로 병합되고, 순서는 화면과 같다: 무엇이 · 어떤 상태로 · 어디서 ·
      // 얼마나 · 살아남는지.
      accessibilityLabel={[
        `${item.title}, ${ADE_STATE_LABEL[item.state]}`,
        channelName,
        item.detail,
        elapsed === null ? null : `${elapsed} 경과`,
        durability,
      ]
        .filter(part => part !== null)
        .join(', ')}
      onPress={onPress}
      style={({pressed}) => [styles.card, pressed && styles.pressed]}
      testID={`ade-card-${item.key}`}>
      <View style={styles.cardHead}>
        <Text
          style={styles.cardTitle}
          numberOfLines={1}
          ellipsizeMode="tail"
          testID={`ade-card-title-${item.key}`}>
          {item.title}
        </Text>
        <View style={[styles.chip, STATE_CHIP[item.state]]}>
          <Text
            style={[styles.chipText, STATE_CHIP_TEXT[item.state]]}
            testID={`ade-card-state-${item.key}`}>
            {ADE_STATE_LABEL[item.state]}
          </Text>
        </View>
        {/* 경과. 끝난 세션은 자기 종료 시각에서 멈춘다. 시작을 못 본 턴은 숫자를
            지어내지 않고 칸을 비운다 — 같은 규칙을 `AgentActivityBar` 가 이미
            쓴다(`startedAtMs` 는 없으면 없는 것이지 0 이 아니다). */}
        {elapsed === null ? null : (
          <Text style={styles.cardElapsed} testID={`ade-card-elapsed-${item.key}`}>
            {elapsed}
          </Text>
        )}
      </View>
      {/* 방과, 3분류보다 정밀한 원래 사실. 칩은 요약 줄이 센 것과 같은 어휘여야
          하고(그래야 "대기 1" 과 카드가 같은 말을 한다), 원장이 아는 더 정확한 말은
          그 대가로 사라지면 안 된다. */}
      <Text
        style={styles.cardMeta}
        numberOfLines={1}
        ellipsizeMode="tail"
        testID={`ade-card-meta-${item.key}`}>
        {`${channelName} · ${item.detail}`}
      </Text>
      {/* 생존성은 **자기 줄**을 갖는다. 웹은 메타 줄의 첫 조각으로 두지만, 358pt
          안에서 세 조각이 한 줄에 서면 잘리는 것은 꼬리이고 — 이 문장이 잘리면
          사람이 랩탑을 덮을지 정하는 근거가 사라진다. */}
      {durability === null ? null : (
        <Text
          style={[styles.cardMeta, DURABILITY_TEXT[durabilityTone(item.durability)]]}
          testID={`ade-card-durability-${item.key}`}>
          {durability}
        </Text>
      )}
      {diff === null ? null : (
        <Text style={styles.cardMeta} testID={`ade-card-diff-${item.key}`}>
          {diff}
        </Text>
      )}
    </Pressable>
  );
}

export function AdeControlPanel({
  onClose,
  onOpenChannel,
}: {
  onClose: () => void;
  /** 카드가 확대되는 곳. 이 화면은 물러나고 그 방이 열린다. */
  onOpenChannel: (channelId: string, title: string) => void;
}): React.JSX.Element {
  const {workspaceId, member} = useSession();
  const {status: railStatus} = useRealtime();
  // 여기서는 경과를 인쇄하므로 1Hz 가 실제로 무언가를 잰다. 요약 줄이 그것을
  // 마운트하지 않는 이유와 정확히 대칭이다.
  const nowMs = useTickingNow(true);
  const {items, sessionsFailed, hostsPending, retrySessions} = useAdeControl(
    nowMs,
    true,
  );
  const {groups} = useChannels(workspaceId);
  const {directory} = useDirectory(workspaceId);

  const nameOfChannel = useMemo(() => {
    const all = [...groups.channels, ...groups.dms];
    return (channelId: string): string => {
      const channel = all.find(candidate => uuidEq(candidate.id, channelId));
      return channel === undefined
        ? UNRESOLVED_CHANNEL
        : channelLabel(channel, directory, member.id);
    };
  }, [groups, directory, member.id]);

  const openItem = useCallback(
    (item: AdeItem) => {
      // 카드가 확대되면 이 화면은 물러난다. 둘이 겹쳐 서면 위에 있는 쪽이 아래를
      // 가린 채로 남고, 사람은 방금 누른 카드가 어디 갔는지 모른다.
      onClose();
      onOpenChannel(item.channelId, nameOfChannel(item.channelId));
    },
    [onClose, onOpenChannel, nameOfChannel],
  );

  return (
    // 스레드 패널과 같은 층·같은 제스처다. 대화의 엣지 스와이프 래퍼와 부모-자식
    // 으로 겹치고, 안쪽이 이긴다는 판정은 `EdgeSwipeBack` 이 컨텍스트로 스스로
    // 한다 — 이 화면을 열어 둔 채 엣지를 밀면 닫히는 것은 이 화면 하나다.
    <EdgeSwipeBack
      style={styles.overlay}
      onBack={onClose}
      // 이 판 자체를 이름으로 집을 수 있어야 한다: 「덮을 뿐 밀지 않는다」는 이
      // 뷰의 기하에 대한 주장이고, 조상을 훑어 찾는 단정은 대화 자신의 오버레이를
      // 집어 통과해 버린다(실측 — 그 상태로는 이 판을 흐름에 세워도 초록이었다).
      testID="ade-panel-pane">

      <Screen>
        <ScreenHeader
          title="작업 목록"
          onBack={onClose}
          // 「뒤로」가 아니다. 덮고 있는 표면은 자기가 무엇을 닫는지 말한다
          // (`ScreenHeader.backLabel` 독스트링).
          backLabel="작업 목록 닫기"
          titleTestID="ade-panel-title"
        />
        <FlatList
          data={items}
          keyExtractor={item => item.key}
          testID="ade-card-list"
          contentContainerStyle={styles.listBody}
          ListHeaderComponent={
            <>
              {/* 끊긴 것을 화면에서 말한다 (2R H2). 이 목록의 절반은 레일이 증명한
                  턴이고, 레일이 없는 동안 그것은 **기억**이다. 배지가 무채색으로
                  내려앉는 것만으로는 「조용한 워크스페이스」와 구별되지 않는다. */}
              {railStatus === 'connected' ? null : (
                <AgentTurnStaleNotice testID="ade-panel-stale" />
              )}
              {sessionsFailed ? (
                <View style={styles.bannerWrap}>
                  <FailureBanner
                    message="작업 세션 목록을 불러오지 못했습니다. 아래에는 에이전트 턴만 있습니다."
                    onRetry={retrySessions}
                    testID="ade-sessions-error"
                  />
                </View>
              ) : null}
            </>
          }
          ListEmptyComponent={
            // 요약 줄이 있어야 이 화면이 열리므로, 열려 있는 동안 이 문장을 볼 수
            // 있는 경로는 하나다: 열어 둔 채로 마지막 작업이 끝나는 것. 그때 화면을
            // 닫아 버리면 사람이 보던 것이 손 밑에서 사라지므로, 화면은 남고 이
            // 문장이 선다(코어가 그 자리를 위해 문장을 들고 있다).
            <EmptyState
              headline={ADE_DRAWER_EMPTY_HEADLINE}
              detail={ADE_DRAWER_EMPTY_DETAIL}
              testID="ade-panel-empty"
            />
          }
          renderItem={({item}) => (
            <AdeCard
              item={item}
              channelName={nameOfChannel(item.channelId)}
              nowMs={nowMs}
              hostsPending={hostsPending}
              onPress={() => openItem(item)}
            />
          )}
        />
      </Screen>
    </EdgeSwipeBack>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.bg,
  },
  listBody: {paddingVertical: space.sm},
  bannerWrap: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.sm},
  card: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    marginHorizontal: SAFE_GUTTER,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    gap: space.xs,
  },
  pressed: {backgroundColor: color.surfacePressed},
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  cardTitle: {
    flex: 1,
    fontSize: font.label,
    lineHeight: line.label,
    color: color.text,
    fontWeight: '600',
  },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '600'},
  cardElapsed: {
    fontSize: font.meta,
    lineHeight: line.meta,
    color: color.textFaint,
  },
  cardMeta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
});
