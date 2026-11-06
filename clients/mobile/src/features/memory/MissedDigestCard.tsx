import type {
  MemoryDigest,
  MemoryEvidenceLink,
} from '@momo/core/features/memory/model';
import React, {useMemo, useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {SHEET_ICON_SIZE, SHEET_ICONS} from '../../design/icons';
import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {conversationFloor} from '../conversation/bubble';
import {
  MISSED_DISMISS_A11Y,
  MISSED_EMPTY,
  MISSED_ERROR,
  MISSED_LOADING,
  MISSED_MORE,
  MISSED_NOT_SUMMARIZED,
  MISSED_OFF,
  MISSED_PARTIAL,
  MISSED_RETRY,
  MISSED_TITLE,
} from './copy';
import {EvidencePills, PILL_HEIGHT} from './EvidencePills';
import {MemoryDigestSheet} from './MemoryDigestSheet';
import {
  evidenceOf,
  MISSED_MAX_EVIDENCE,
  MISSED_MIN_UNREAD,
  missedCardState,
  summaryLines,
  type MissedCardInput,
  type MissedCardState,
} from './model';
import {phaseOf, useMemorySettings, useMissedDigests} from './queries';

// =============================================================================
// 놓친 대화 요약 카드 (plan.md §5 V1 / ADR-0196 D12) — 채널·스레드 위, 목록 밖.
//
// 안 읽은 대화로 돌아왔을 때만 서고(`MISSED_MIN_UNREAD`), 닫을 수 있다. 상태는
// 판정(`missedCardState`)이 정하고 이 파일은 그린다. 다섯 상태는 서로 다른 문장을 든다.
//   로딩 · 오류(다시 시도) · 꺼짐/일시정지(이유) · 아직 요약 전 · 요약할 게 없음
// 근거를 누르면 부른 쪽이 그 메시지로 데려가고(채널의 점프 기계), 여기서는 길을 만들지
// 않는다.
// =============================================================================

const NO_DIGESTS: readonly MemoryDigest[] = [];

/** 한 줄 띠의 문장 칸 testID — 상태마다 옛 카드와 같은 id 를 쓴다(시험·흐름이 상태를 id 로 읽는다). */
const COMPACT_SENTENCE_ID = {
  loading: 'missed-digest-loading',
  error: 'missed-digest-error',
  off: 'missed-digest-off',
  notSummarized: 'missed-digest-pending',
  empty: 'missed-digest-empty',
  ready: 'missed-digest-ready',
} as const;

/** 요약이 없는 상태의 한 문장 — 옛 카드가 본문에 쓰던 그 문장이다. */
function compactSentence(
  state: Exclude<MissedCardState, {kind: 'hidden'} | {kind: 'ready'}>,
): string {
  switch (state.kind) {
    case 'loading':
      return MISSED_LOADING;
    case 'error':
      return MISSED_ERROR;
    case 'off':
      return MISSED_OFF[state.cause];
    case 'notSummarized':
      return MISSED_NOT_SUMMARIZED;
    case 'empty':
      return MISSED_EMPTY;
  }
}

export function MissedDigestCardView({
  state,
  onDismiss,
  onRetry,
  onMore,
  onOpenEvidence,
  compact = false,
}: {
  state: MissedCardState;
  onDismiss: () => void;
  onRetry?: () => void;
  onMore?: () => void;
  onOpenEvidence?: (link: MemoryEvidenceLink) => void;
  /** 한 줄 띠(#5436): 머리 밑에 붙는 자리용. 전문·근거는 「더 보기」 시트가 든다. 스레드 패널의 목록 머리 카드는 그대로(`false`). */
  compact?: boolean;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const readyDigests = state.kind === 'ready' ? state.digests : null;
  const lines = useMemo(
    () => summaryLines(readyDigests ?? NO_DIGESTS),
    [readyDigests],
  );
  const evidence = useMemo(
    () => evidenceOf(readyDigests ?? NO_DIGESTS),
    [readyDigests],
  );
  if (state.kind === 'hidden') return null;
  if (compact) {
    // 한 줄 띠 (#5436): 「안 읽은 동안」 · 요약 한 줄(말줄임) · [더 보기|다시 시도] · ✕. 높이는 상태와 상관없이 한 줄(`TOUCH_TARGET`)이라 머리 높이가 흔들리지 않고(진입 뒤
    // 목록 여백이 움직이지 않는다), 목록 첫 줄을 가리는 양이 가장 작다. 요약 전문·근거 알약은 이미 있는 「더 보기」 시트(`MemoryDigestSheet`)로 간다.
    const summary = state.kind === 'ready' ? (lines.shown[0] ?? MISSED_EMPTY) : compactSentence(state);
    const action =
      state.kind === 'ready' && onMore
        ? {label: MISSED_MORE, onPress: onMore, testID: 'missed-digest-more'}
        : state.kind === 'error' && onRetry
          ? {label: MISSED_RETRY, onPress: onRetry, testID: 'missed-digest-retry'}
          : null;
    return (
      <View style={styles.band} testID="missed-digest-band">
        {/* 뒷면의 아래끝을 알리는 1pt 이음매 - 화면이 읽는 높이가 아니라 **흐름이 재는 자리**다. Maestro 의 `below` 는 「위끝이 더 아래」를 비교해서 띠 뒤에 가린 요소도 통과시키므로
            (실측: 뒷면 안 날짜 칩이 `below: missed-digest-band` 를 통과했다), 「목록 첫 내용이 띠 밑에서 시작한다」는 이 이음매 `below` 로 잰다(`5436-unread-card-clear`). */}
        <View collapsable={false} pointerEvents="none" style={styles.bandEdge} testID="missed-digest-band-end" />
        <View style={[styles.card, styles.cardCompact]} testID="missed-digest-card">
          <Text accessibilityRole="header" style={styles.title}>
            {MISSED_TITLE}
          </Text>
          <Sentence
            ellipsizeMode="tail"
            numberOfLines={1}
            style={[styles.muted, styles.compactText]}
            testID={COMPACT_SENTENCE_ID[state.kind]}>
            {summary}
          </Sentence>
          {action ? (
            <Pressable
              accessibilityRole="button"
              onPress={action.onPress}
              style={({pressed}) => [styles.compactAction, pressed && styles.pressed]}
              testID={action.testID}>
              <Text style={styles.action}>{action.label}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={MISSED_DISMISS_A11Y}
            onPress={onDismiss}
            style={({pressed}) => [styles.dismiss, pressed && styles.pressed]}
            testID="missed-digest-dismiss">
            <Image source={SHEET_ICONS.close} style={styles.dismissGlyph} />
          </Pressable>
        </View>
      </View>
    );
  }
  const more =
    state.kind === 'ready' &&
    (lines.hidden > 0 || state.digests.length > 1 || evidence.length > MISSED_MAX_EVIDENCE);
  return (
    <View style={styles.card} testID="missed-digest-card">
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.title}>
          {MISSED_TITLE}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={MISSED_DISMISS_A11Y}
          onPress={onDismiss}
          style={({pressed}) => [styles.dismiss, pressed && styles.pressed]}
          testID="missed-digest-dismiss">
          {/* 글자 「닫기」가 아니라 시트·페이지와 같은 X 글리프다(#4458). 카드이므로 원은 없다. */}
          <Image source={SHEET_ICONS.close} style={styles.dismissGlyph} />
        </Pressable>
      </View>
      {state.kind === 'loading' ? (
        <Sentence style={styles.muted} testID="missed-digest-loading">
          {MISSED_LOADING}
        </Sentence>
      ) : null}
      {state.kind === 'error' ? (
        <View style={styles.stack} testID="missed-digest-error">
          <Sentence style={styles.body}>{MISSED_ERROR}</Sentence>
          {onRetry ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={{top: slopTo(PILL_HEIGHT), bottom: slopTo(PILL_HEIGHT)}}
              onPress={onRetry}
              style={({pressed}) => [styles.retry, pressed && styles.pressed]}
              testID="missed-digest-retry">
              <Text style={styles.action}>{MISSED_RETRY}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {state.kind === 'off' ? (
        <Sentence style={styles.muted} testID="missed-digest-off">
          {MISSED_OFF[state.cause]}
        </Sentence>
      ) : null}
      {state.kind === 'notSummarized' ? (
        <Sentence style={styles.muted} testID="missed-digest-pending">
          {MISSED_NOT_SUMMARIZED}
        </Sentence>
      ) : null}
      {state.kind === 'empty' ? (
        <Sentence style={styles.muted} testID="missed-digest-empty">
          {MISSED_EMPTY}
        </Sentence>
      ) : null}
      {state.kind === 'ready' ? (
        <View style={styles.stack} testID="missed-digest-ready">
          {lines.shown.map((row, index) => (
            <Sentence key={index} style={styles.body}>
              {row}
            </Sentence>
          ))}
          {state.partial ? (
            <Sentence style={styles.muted} testID="missed-digest-partial">
              {MISSED_PARTIAL}
            </Sentence>
          ) : null}
          <View style={styles.foot}>
            <View style={styles.footPills}>
              <EvidencePills
                links={evidence}
                max={MISSED_MAX_EVIDENCE}
                onOpen={onOpenEvidence}
                testID="missed-digest-evidence"
              />
            </View>
            {more && onMore ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={{top: slopTo(PILL_HEIGHT), bottom: slopTo(PILL_HEIGHT)}}
                onPress={onMore}
                style={({pressed}) => [styles.more, pressed && styles.pressed]}
                testID="missed-digest-more">
                <Text style={styles.action}>{MISSED_MORE}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * 화면이 붙이는 카드. 방문이 얼린 경계(`sinceSeq`)를 받아 요약과 설정을 읽는다.
 *
 * 닫기는 「이 방문·이 경계」에 걸린다: 같은 방을 다시 열어 경계가 움직이면 새 카드다.
 */
export function MissedDigestCard({
  workspaceId,
  channelId,
  threadRootId = null,
  sinceSeq,
  unreadCount,
  headSeq,
  eligible = true,
  onOpenEvidence,
  compact = false,
}: {
  workspaceId: string;
  channelId: string;
  threadRootId?: string | null;
  sinceSeq: number;
  unreadCount: number;
  headSeq: number;
  eligible?: boolean;
  onOpenEvidence?: (link: MemoryEvidenceLink) => void;
  /** 한 줄 띠로 그린다(#5436) — 대화 화면의 머리 밑 띠. */
  compact?: boolean;
}): React.JSX.Element | null {
  const visitId = `${channelId}:${threadRootId ?? '-'}:${sinceSeq}`;
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // 문턱 밑에서는 요청도 보내지 않는다(카드가 없으니 답을 쓸 곳이 없다).
  const wanted =
    eligible && unreadCount >= MISSED_MIN_UNREAD && dismissedId !== visitId;
  const settings = useMemorySettings(workspaceId, wanted);
  const digests = useMissedDigests({
    workspaceId,
    channelId,
    threadRootId,
    sinceSeq,
    headSeq,
    // 설정이 답한 뒤에 묻는다: 꺼진 방에는 요청을 보내지 않는다(요약을 내주지 않는
    // 방에 물어 놓고 「오류」를 그릴 이유가 없다). 설정을 못 읽었으면 그대로 묻는다.
    enabled:
      wanted &&
      !settings.isPending &&
      !isKnownOff(settings.data, channelId),
  });
  const input: MissedCardInput = {
    channelId,
    unreadCount,
    eligible,
    headSeq,
    settingsPhase: phaseOf(settings),
    settings: settings.data,
    digestsPhase: phaseOf(digests),
    page: digests.data,
  };
  const state = wanted ? missedCardState(input) : ({kind: 'hidden'} as const);
  if (state.kind === 'hidden') return null;
  return (
    <>
      <MissedDigestCardView
        state={state}
        onDismiss={() => setDismissedId(visitId)}
        onRetry={() => void digests.refetch()}
        onMore={() => setSheetOpen(true)}
        onOpenEvidence={onOpenEvidence}
        compact={compact}
      />
      {sheetOpen && state.kind === 'ready' ? (
        <MemoryDigestSheet
          title={MISSED_TITLE}
          digests={state.digests}
          withheld={null}
          listShorter={false}
          onClose={() => setSheetOpen(false)}
          onOpenEvidence={link => {
            setSheetOpen(false);
            onOpenEvidence?.(link);
          }}
          testID="missed-digest-sheet"
        />
      ) : null}
    </>
  );
}

function isKnownOff(
  settings: Parameters<typeof missedCardState>[0]['settings'],
  channelId: string,
): boolean {
  if (settings === undefined) return false;
  return (
    missedCardState({
      channelId,
      unreadCount: Number.MAX_SAFE_INTEGER,
      eligible: true,
      headSeq: 0,
      settingsPhase: 'ready',
      settings,
      digestsPhase: 'loading',
    }).kind === 'off'
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    card: {
      marginHorizontal: SAFE_GUTTER,
      marginVertical: space.sm,
      paddingHorizontal: space.md,
      paddingBottom: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    // 한 줄 띠(#5436). 뒷면(`band`)은 대화 바닥 색 한 장 — 카드 둘레 틈·둥근 모서리로 밑을 지나는 목록 글자가 비치지 않게 한다.
    band: {backgroundColor: conversationFloor(color)},
    bandEdge: {position: 'absolute', left: 0, right: 0, bottom: 0, height: 1},
    cardCompact: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: TOUCH_TARGET,
      paddingBottom: 0,
      gap: space.sm,
    },
    compactText: {flex: 1, flexShrink: 1},
    compactAction: {minHeight: TOUCH_TARGET, justifyContent: 'center'},
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: TOUCH_TARGET,
    },
    title: {fontSize: font.label, color: color.text, fontWeight: '700'},
    dismiss: {
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    pressed: {opacity: 0.6},
    dismissGlyph: {
      width: SHEET_ICON_SIZE.close,
      height: SHEET_ICON_SIZE.close,
      tintColor: color.icon,
    },
    action: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
    stack: {gap: space.xs},
    body: {fontSize: font.label, lineHeight: line.label, color: color.text},
    muted: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    retry: {alignSelf: 'flex-start', minHeight: PILL_HEIGHT, justifyContent: 'center'},
    more: {minHeight: PILL_HEIGHT, justifyContent: 'center'},
    foot: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space.sm,
      paddingTop: space.sm,
    },
    footPills: {flex: 1},
  });
