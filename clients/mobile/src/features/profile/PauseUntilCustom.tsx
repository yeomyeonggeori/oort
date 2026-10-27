import {
  customPauseUntil,
  customPauseUntilMessage,
  pauseUntilConfirmLabel,
  pauseUntilLabel,
  type PauseUntilKind,
} from '@momo/core/features/presence/pauseUntil';
import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {BAR_CONTROL_MAX_SCALE, PrimaryButton, Sentence} from '../../design/atoms';
import {GroupCard} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {
  font,
  line,
  radius,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {
  addMonths,
  dayAccessibilityLabel,
  dayKey,
  HOURS12,
  isBeforeToday,
  isSameDay,
  MINUTES,
  monthTitle,
  monthWeeks,
  nextWholeHour,
  timeKey,
  todayPick,
  WEEKDAY_HEADS,
  type DayPick,
  type Meridiem,
  type MonthView,
  type TimePick,
} from './pauseCalendar';

// =============================================================================
// 「직접 고르기」 — 달력 한 달과 시각 칩 (ADR-0204 D2, #2899).
//
// 날짜·시각 입력 컨트롤이 폰에 없고 새 네이티브 의존을 들이지 않으므로(`pauseCalendar.ts`
// 머리) 이 판은 JS 만으로 선다. 날짜는 달력 한 달, 시각은 오전·오후 + 시 12칸 + 분 12칸
// (5분 단위)이다. 키보드가 필요 없으니 시트 아래가 가려지지 않고, 칸 하나가 한 번의 탭이다.
//
// ## 처음 값은 이미 미래다
//
// 열리면 **지금 다음의 정각**이 놓여 있어 확인이 곧바로 눌린다. 빈 칸에서 시작하면 「확인이
// 안 눌리는 이유」를 사람이 풀어야 한다. 사람이 오늘의 이른 시각을 고르면 그때 문장이 이유를
// 말하고 확인이 잠긴다(`customPauseUntil` 의 `past`). 오늘보다 앞 날짜는 칸 자체가 눌리지 않는다.
//
// 모든 칸은 44pt 이상이다(`TOUCH_TARGET`). 달력 칸은 한 주가 한 줄(`flex: 1` 일곱 칸)이라
// 폭이 몇이어도 일곱이 한 줄에 선다.
// =============================================================================

export function PauseUntilCustom({
  kind,
  nowMs,
  busy,
  offline,
  onConfirm,
}: {
  kind: PauseUntilKind;
  /** 분 단위로 틱하는 지금(`useNow`). 「오늘」·지난 날을 가르는 데 쓴다. */
  nowMs: number;
  busy: boolean;
  /** 연결이 끊겼다 — 확인이 잠긴다(끊긴 동안 쓰기는 대기열에 쌓여 지난 절대 시각으로 나간다). */
  offline: boolean;
  onConfirm: (atMs: number) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [seed] = useState(() => nextWholeHour(nowMs));
  const [view, setView] = useState<MonthView>({
    year: seed.day.year,
    monthIndex: seed.day.monthIndex,
  });
  const [day, setDay] = useState<DayPick>(seed.day);
  const [time, setTime] = useState<TimePick>(seed.time);

  const today = todayPick(nowMs);
  const currentMonth: MonthView = {
    year: today.year,
    monthIndex: today.monthIndex,
  };
  const atCurrentMonth =
    view.year === currentMonth.year && view.monthIndex === currentMonth.monthIndex;
  // 검증은 누르는 순간의 시계로도 한 번 더 한다(`confirm`). 여기 값은 그리기 위한 것이다.
  const result = customPauseUntil(dayKey(day), timeKey(time), Date.now());

  const confirm = () => {
    if (busy || offline) return;
    const fresh = customPauseUntil(dayKey(day), timeKey(time), Date.now());
    if (fresh.ok) onConfirm(fresh.atMs);
  };
  const setMeridiem = (meridiem: Meridiem) => setTime(prev => ({...prev, meridiem}));

  return (
    <View style={styles.root} testID="pause-until-custom">
      <GroupCard label="날짜" testID="pause-until-date-group">
        <View style={styles.card}>
          <View style={styles.monthBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="이전 달"
              accessibilityState={{disabled: atCurrentMonth}}
              disabled={atCurrentMonth}
              onPress={() => setView(prev => addMonths(prev, -1))}
              style={({pressed}) => [
                styles.monthButton,
                atCurrentMonth && styles.dimmed,
                pressed && styles.pressed,
              ]}
              testID="pause-until-prev-month">
              <Text
                style={styles.monthGlyph}
                importantForAccessibility="no"
                maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
                ‹
              </Text>
            </Pressable>
            <Text
              accessibilityRole="header"
              style={styles.monthTitle}
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              testID="pause-until-month-title">
              {monthTitle(view)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="다음 달"
              onPress={() => setView(prev => addMonths(prev, 1))}
              style={({pressed}) => [styles.monthButton, pressed && styles.pressed]}
              testID="pause-until-next-month">
              <Text
                style={styles.monthGlyph}
                importantForAccessibility="no"
                maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
                ›
              </Text>
            </Pressable>
          </View>
          <View style={styles.week} importantForAccessibility="no-hide-descendants">
            {WEEKDAY_HEADS.map(head => (
              <View key={head} style={styles.weekdayCell}>
                <Text
                  style={styles.weekday}
                  maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
                  {head}
                </Text>
              </View>
            ))}
          </View>
          {monthWeeks(view.year, view.monthIndex).map((week, weekIndex) => (
            <View key={weekIndex} style={styles.week}>
              {week.map((cell, cellIndex) => {
                if (cell === null) return <View key={cellIndex} style={styles.cell} />;
                const pick: DayPick = {
                  year: view.year,
                  monthIndex: view.monthIndex,
                  day: cell,
                };
                const past = isBeforeToday(pick, nowMs);
                const selected = isSameDay(pick, day);
                const isToday = isSameDay(pick, today);
                return (
                  <Pressable
                    key={cellIndex}
                    accessibilityRole="button"
                    accessibilityLabel={dayAccessibilityLabel(pick)}
                    accessibilityState={{selected, disabled: past}}
                    disabled={past}
                    onPress={() => setDay(pick)}
                    style={styles.cell}
                    testID={`pause-until-day-${dayKey(pick)}`}>
                    <View
                      style={[
                        styles.dayFace,
                        isToday && !selected && styles.dayFaceToday,
                        selected && styles.dayFaceSelected,
                      ]}>
                      <Text
                        style={[
                          styles.dayText,
                          past && styles.dayTextPast,
                          selected && styles.dayTextSelected,
                        ]}
                        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
                        {cell}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </GroupCard>

      <GroupCard label="시각" testID="pause-until-time-group">
        <View style={styles.card}>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="오전·오후"
            style={styles.chipRow}>
            {(
              [
                ['am', '오전'],
                ['pm', '오후'],
              ] as const
            ).map(([id, label]) => (
              <Chip
                key={id}
                label={label}
                selected={time.meridiem === id}
                onPress={() => setMeridiem(id)}
                testID={`pause-until-meridiem-${id}`}
              />
            ))}
          </View>
          <ChipGrid
            label="시"
            values={HOURS12}
            selected={time.hour12}
            format={value => String(value)}
            accessibilitySuffix="시"
            onPick={hour12 => setTime(prev => ({...prev, hour12}))}
            testIDPrefix="pause-until-hour"
          />
          <ChipGrid
            label="분"
            values={MINUTES}
            selected={time.minute}
            format={value => String(value).padStart(2, '0')}
            accessibilitySuffix="분"
            onPick={minute => setTime(prev => ({...prev, minute}))}
            testIDPrefix="pause-until-minute"
          />
        </View>
      </GroupCard>

      <View style={styles.actions} testID="pause-until-actions">
        {result.ok ? (
          <Text
            accessibilityLiveRegion="polite"
            style={styles.summary}
            testID="pause-until-summary">
            {pauseUntilLabel(result.atMs, nowMs)}
          </Text>
        ) : (
          <Sentence
            accessibilityLiveRegion="polite"
            style={styles.error}
            testID="pause-until-error">
            {customPauseUntilMessage(result.reason)}
          </Sentence>
        )}
        <PrimaryButton
          label={pauseUntilConfirmLabel(kind)}
          busyLabel="저장 중"
          busy={busy}
          disabled={!result.ok || offline}
          onPress={confirm}
          testID="pause-until-confirm"
        />
      </View>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{selected}}
      onPress={onPress}
      style={({pressed}) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && !selected && styles.pressed,
      ]}
      testID={testID}>
      <Text
        style={[styles.chipText, selected && styles.chipTextSelected]}
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
        {label}
      </Text>
    </Pressable>
  );
}

/** 여섯 칸씩 줄을 나눈 칩 묶음 — 시(12칸)와 분(12칸)이 각각 두 줄이다. */
function ChipGrid({
  label,
  values,
  selected,
  format,
  accessibilitySuffix,
  onPick,
  testIDPrefix,
}: {
  label: string;
  values: readonly number[];
  selected: number;
  format: (value: number) => string;
  accessibilitySuffix: string;
  onPick: (value: number) => void;
  testIDPrefix: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const rows: (readonly number[])[] = [];
  for (let at = 0; at < values.length; at += 6) rows.push(values.slice(at, at + 6));
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.grid}>
      <Text style={styles.gridLabel} importantForAccessibility="no">
        {label}
      </Text>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.chipRow}>
          {row.map(value => (
            <Chip
              key={value}
              label={format(value)}
              accessibilityLabel={`${value}${accessibilitySuffix}`}
              selected={value === selected}
              onPress={() => onPick(value)}
              testID={`${testIDPrefix}-${value}`}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 카드는 폭 전체로 서고 가로 여백은 호스트가 진다(`GroupCard`) — 이 블록의 호스트 `PauseUntilPage` 가 진다(그래서
    // `actions` 도 스스로 지지 않는다 — 지면 이중 여백이다). 카드 사이 16.
    root: {gap: space.lg},
    card: {padding: space.md, gap: space.md},
    dimmed: {opacity: 0.4},
    pressed: {backgroundColor: color.surfacePressed},
    monthBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    monthButton: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
    },
    monthGlyph: {fontSize: font.title, color: color.accentText},
    monthTitle: {fontSize: font.body, fontWeight: '600', color: color.text},
    week: {flexDirection: 'row'},
    cell: {flex: 1, minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center'},
    // 요일 머리는 누르는 칸이 아니라 44 를 채우지 않는다.
    weekdayCell: {flex: 1, alignItems: 'center', paddingVertical: space.xs},
    weekday: {fontSize: font.meta, color: color.textMuted},
    // 얼굴은 칸(44)보다 한 단 작다 — 이웃 날짜와 원이 맞닿지 않게.
    dayFace: {
      width: TOUCH_TARGET - space.sm,
      height: TOUCH_TARGET - space.sm,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // 오늘 — 채움 없이 가는 테두리. 채움은 고른 날의 몫이다.
    dayFaceToday: {borderWidth: 1, borderColor: color.textFaint},
    dayFaceSelected: {backgroundColor: color.accent},
    dayText: {fontSize: font.body, color: color.text},
    dayTextPast: {color: color.textFaint},
    dayTextSelected: {color: color.onAccent, fontWeight: '600'},
    grid: {gap: space.sm},
    gridLabel: {fontSize: font.label, color: color.textMuted, fontWeight: '600'},
    chipRow: {flexDirection: 'row', gap: space.sm},
    // 3:1 을 넘는 테두리(`textFaint`)가 「여기가 버튼이다」의 전부다 — 채움이 없는 칩이다.
    chip: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: color.textFaint,
    },
    chipSelected: {backgroundColor: color.accent, borderColor: color.accent},
    chipText: {fontSize: font.body, color: color.text},
    chipTextSelected: {color: color.onAccent, fontWeight: '600'},
    actions: {gap: space.sm},
    summary: {
      fontSize: font.heading,
      fontWeight: '600',
      color: color.text,
      textAlign: 'center',
    },
    error: {
      fontSize: font.label,
      color: color.dangerText,
      lineHeight: line.label,
      textAlign: 'center',
    },
  });
