import {
  PRESENCE_WRITE_FAILED,
} from '@momo/core/features/presence/model';
import {
  pauseUntilAtMs,
  pauseUntilDescription,
  pauseUntilHint,
  pauseUntilLabel,
  pauseUntilOptions,
  pauseUntilPresetHint,
  pauseUntilTitle,
  type PauseUntilKind,
  type PauseUntilPreset,
} from '@momo/core/features/presence/pauseUntil';
import {NOTIFICATION_PAUSE_SAVE_FAILED} from '@momo/core/features/settings/notificationRules';
import type {RosterMember} from '@momo/core/lib/api';
import React, {useRef, useState} from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';

import {GroupRow, GroupSection, Sentence} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';
import {font, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {useNow} from '../../lib/useNow';
import {PauseUntilCustom} from './PauseUntilCustom';
import {usePauseNotifications, useSetPresence} from './selfStatus';

// =============================================================================
// 기한 고르기 — 알림 일시 중지·방해 금지가 켜지는 유일한 길 (ADR-0204 D2, #2899).
//
// 프로필 시트 **안의 한 장**이다(테마·상태 글과 같은 문법 — 시트 위에 시트를 겹치지 않는다).
// 두 스위치가 이 장을 같이 쓴다:
//
//   * `kind="pause"` — `PATCH /notification-rules {dnd:true, dndUntilMs}`. 이 쓰기는 방해
//     금지와의 묶음을 끊는다(ADR-0124 증보 3).
//   * `kind="dnd"`   — `PUT /presence {status:'dnd', dndUntilMs}`. 서버가 같은 트랜잭션에서
//     알림 일시 중지도 같은 기한으로 켠다. **notification-rules 를 따로 쓰지 않는다.**
//
// ## 고르면 곧 켜진다
//
// 짧은 선택(30분·1시간·2시간·내일·다음 주 월요일)은 누르는 즉시 쓰고 프로필로 돌아간다.
// 시각을 직접 정하는 길만 한 번 더 확인한다(`PauseUntilCustom`). 켜기 전에 기한을 고르게
// 하는 것이 이 장의 존재 이유라서 「일단 켜고 나중에 기한」 길은 없다. 되돌리는 길은 프로필의
// 스위치이고 한 번이다.
//
// ## 「직접 끌 때까지」는 없다
//
// 목록은 코어(`PAUSE_UNTIL_OPTIONS`)가 정한다. 이 장이 목록을 따로 들지 않는 것이 그
// 약속을 지킨다. 이미 있는 기한 없는 행은 이 장의 머리에서 「지금은 기한이 없어요」로 말한다.
//
// 만료는 서버가 판정한다 — 이 장은 타이머로 풀지 않는다.
// =============================================================================

export function PauseUntilPage({
  kind,
  workspaceId,
  selfId,
  self,
  onDone,
  onReveal,
}: {
  kind: PauseUntilKind;
  workspaceId: string;
  selfId: string;
  self: RosterMember | undefined;
  /** 쓰기가 성공하면 부른다 — 시트가 프로필로 돌아간다. */
  onDone: () => void;
  /**
   * 「직접 고르기」가 열리면 그 블록의 윗변이 보이게 시트를 내린다. `y` 는 이 장의 윗변에서
   * 잰 값이다(시트의 위쪽 여백은 시트가 더한다). 끝까지 내리면 달력을 지나쳐 확인 단추만 남는다.
   */
  onReveal: (y: number) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const nowMs = useNow();
  const pause = usePauseNotifications(workspaceId);
  const setPresence = useSetPresence(workspaceId, selfId);
  const [customOpen, setCustomOpen] = useState(false);
  const [pendingId, setPendingId] = useState<PauseUntilPreset | 'custom' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // 「직접 고르기」 블록이 **열릴 때 한 번만** 시트를 내린다. `onLayout` 은 블록의 높이가 바뀔
  // 때마다(지난 시각 오류문이 뜨거나 달이 넘어갈 때) 다시 오는데, 그때마다 내리면 고르던 자리에서
  // 시트가 튄다. 열고 닫을 때마다 깃발을 내려 다음에 열 때 다시 한 번 내린다.
  const revealedRef = useRef(false);
  const toggleCustom = () => {
    revealedRef.current = false;
    setCustomOpen(open => !open);
  };

  const busy = kind === 'pause' ? pause.pending : setPresence.isPending;
  // 규칙을 한 번도 못 읽은 채로는 일시 중지 쓰기를 세우지 않는다(`usePauseNotifications`).
  const locked = busy || (kind === 'pause' && !pause.ready);

  // 지금 걸려 있는 것 — 머리에서 한 줄로 말한다.
  const active = kind === 'pause' ? pause.paused : self?.presenceStatus === 'dnd';
  const currentUntilMs = kind === 'pause' ? pause.untilMs : self?.dndUntilMs;

  const commit = async (atMs: number, id: PauseUntilPreset | 'custom') => {
    if (locked) return;
    setFailure(null);
    setPendingId(id);
    try {
      if (kind === 'pause') {
        if (!(await pause.pauseUntil(atMs))) return;
      } else {
        await setPresence.mutateAsync({status: 'dnd', dndUntilMs: atMs});
      }
      onDone();
    } catch {
      setFailure(kind === 'pause' ? NOTIFICATION_PAUSE_SAVE_FAILED : PRESENCE_WRITE_FAILED);
    } finally {
      setPendingId(null);
    }
  };

  const options = pauseUntilOptions(nowMs);

  return (
    <View style={styles.page} testID="pause-until-page">
      <View style={styles.intro}>
        {/* 완성된 한국어 문장이라 `Sentence` 다 — 큰 글씨에서 「언제까/지」처럼 어절 한가운데서 끊기지
            않게 한다(`lineBreakStrategyIOS="hangul-word"`, 같은 규칙이 한 자리에 있다). */}
        <Sentence accessibilityRole="header" style={styles.heading} testID="pause-until-title">
          {pauseUntilTitle(kind)}
        </Sentence>
        <Sentence style={styles.caption} testID="pause-until-description">
          {pauseUntilDescription(kind)}
        </Sentence>
        {active ? (
          <Sentence style={styles.caption} testID="pause-until-current">
            {currentUntilMs === undefined
              ? '지금은 기한이 없어요.'
              : `지금은 ${pauseUntilLabel(currentUntilMs, nowMs)}예요.`}
          </Sentence>
        ) : null}
      </View>

      <GroupSection label="기한">
        {options.map((option, index) => {
          const custom = option.id === 'custom';
          const hint =
            option.id === 'custom' ? undefined : pauseUntilHint(option.id, nowMs);
          return (
            <GroupRow
              key={option.id}
              title={option.label}
              detail={hint}
              chevron={custom && pendingId !== 'custom'}
              tone={custom && customOpen ? 'accent' : 'default'}
              separated={index > 0}
              disabled={locked}
              onPress={() => {
                if (option.id === 'custom') toggleCustom();
                // 줄에 적힌 끝 시각(`hint`)과 저장되는 시각이 같도록 같은 시계로 센다.
                else void commit(pauseUntilAtMs(option.id, nowMs), option.id);
              }}
              accessibilityLabel={hint ? `${option.label}, ${hint}` : option.label}
              // 짧은 선택은 누르면 곧바로 켜진다 — 확인 단계가 없다는 것을 읽어 준다.
              accessibilityHint={custom ? undefined : pauseUntilPresetHint(kind)}
              accessibilityState={custom ? {expanded: customOpen} : undefined}
              trailing={
                pendingId === option.id ? (
                  <ActivityIndicator
                    color={palette.textMuted}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                  />
                ) : undefined
              }
              testID={`pause-until-option-${option.id}`}
            />
          );
        })}
      </GroupSection>

      {customOpen ? (
        <View
          testID="pause-until-custom-block"
          onLayout={event => {
            if (revealedRef.current) return;
            revealedRef.current = true;
            onReveal(event.nativeEvent.layout.y);
          }}>
          <PauseUntilCustom
            kind={kind}
            nowMs={nowMs}
            busy={busy && pendingId === 'custom'}
            onConfirm={atMs => void commit(atMs, 'custom')}
          />
        </View>
      ) : null}

      {failure ? (
        <Sentence
          accessibilityLiveRegion="polite"
          style={styles.failure}
          testID="pause-until-failure">
          {failure}
        </Sentence>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    page: {gap: space.xl},
    intro: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    heading: {fontSize: font.heading, fontWeight: '600', color: color.text},
    caption: {fontSize: font.label, color: color.textMuted, lineHeight: 18},
    failure: {
      fontSize: font.label,
      color: color.dangerText,
      lineHeight: 18,
      paddingHorizontal: SAFE_GUTTER,
    },
  });
