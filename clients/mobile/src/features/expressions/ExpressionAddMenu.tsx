import {fetchRoster} from '@momo/core/lib/api';
import React, {useEffect, useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {circleLook} from '../../design/sheetModel';
import {GroupCard, ListRow} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useExpressions} from './ExpressionProvider';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 팀 이모지 고르개의 「＋」 (#4891) — 웹 패널의 「추가하기」 메뉴와 같은 두 갈래: 가져오기 · AI와 만들기.
//
// 누가 쓸 수 있는가도 웹과 같다(`TeamExpressionsPanel` 의 `canAdd`): 서버가 준 추가 정책이 `members` 이거나,
// 정책이 `admins` 인데 내가 관리자·소유자일 때. 정책이 `members` 인 흔한 경우에는 명단을 부르지 않는다.
// 제자리에 펼치는 메뉴다(폰의 「여기서 고른다」 문법 — `ListRow accessory="expand"` 와 같은 ⌄ 의 뜻). 두 행은 장으로
// 「더 들어가므로」 셰브론이다.
// =============================================================================

/** 이 사람이 새 그림을 올릴 수 있는가. 정책이 관리자 전용일 때만 명단에서 내 역할을 확인한다. */
export function useCanAddExpression(): boolean {
  const {store, addPolicy} = useExpressions();
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    setAdmin(false);
    if (!store || addPolicy !== 'admins') return;
    let live = true;
    void fetchRoster(store.workspaceId).then(
      members => {
        if (!live) return;
        setAdmin(
          members.some(
            member =>
              member.id === store.memberId &&
              (member.role === 'admin' || member.role === 'owner'),
          ),
        );
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [store, addPolicy]);
  return addPolicy === 'members' || admin;
}

export function ExpressionAddMenu({
  canAdd,
  offline,
  onImport,
  onMake,
}: {
  canAdd: boolean;
  offline: boolean;
  onImport: () => void;
  onMake: () => void;
}): React.JSX.Element {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const [open, setOpen] = useState(false);
  const disabled = !canAdd || offline;
  // 잠기면 열려 있던 메뉴도 접는다 — 눌러도 소용없는 행을 떠 있게 두지 않는다.
  const expanded = open && !disabled;
  return (
    <View style={styles.root} testID="expression-add">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={formatMessage('expressions.add.trigger')}
        accessibilityHint={
          offline
            ? formatMessage('expressions.add.offlineHint')
            : formatMessage('expressions.add.triggerHint')
        }
        accessibilityState={{disabled, expanded}}
        disabled={disabled}
        onPress={() => setOpen(value => !value)}
        style={({pressed}) => [
          styles.trigger,
          disabled && styles.triggerOff,
          pressed && styles.triggerPressed,
        ]}
        testID="expression-add-menu">
        <Image
          source={CONV_ICONS.plus}
          style={styles.plus}
          importantForAccessibility="no"
        />
        <Text style={styles.triggerLabel}>
          {formatMessage('expressions.add.trigger')}
        </Text>
      </Pressable>
      {!canAdd ? (
        <Sentence style={styles.note} testID="expression-add-admins-only">
          {formatMessage('expressions.add.adminsOnly')}
        </Sentence>
      ) : null}
      {expanded ? (
        <GroupCard testID="expression-add-doors">
          <ListRow
            title={formatMessage('expressions.add.import')}
            detail={formatMessage('expressions.add.importDetail')}
            accessory="chevron"
            onPress={() => {
              setOpen(false);
              onImport();
            }}
            testID="expression-add-import"
          />
          <ListRow
            title={formatMessage('expressions.add.make')}
            detail={formatMessage('expressions.add.makeDetail')}
            accessory="chevron"
            onPress={() => {
              setOpen(false);
              onMake();
            }}
            testID="expression-add-make"
          />
        </GroupCard>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    // 시트(`sheet`) 위에 서는 보조 알약은 시트 위 문법이다: `surface` 채움 + `elevationRest` 그림자(phone-sheets.md §4, README
    // §3.3). 옛 판은 `surfaceMuted` 였는데 라이트에서 그 값이 시트와 1.009 라 알약 안팎이 같은 색이었다 — 팀 이모지를 늘리는
    // 유일한 입구가 글리프와 글자로만 보였다(#5099, 검증 줄 2회차 화면 M4). 채움·가장자리는 시트 머리의 원과 같은 규칙
    // (`circleLook`)이고 장 안의 「앨범에서 고르기」 알약(`PhotoPickRow`, #5065)과 같은 모양이다 — 시험이 둘이 같음을 잰다.
    trigger: {
      minHeight: TOUCH_TARGET,
      alignSelf: 'flex-end',
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      paddingHorizontal: space.lg,
      borderRadius: ds2Radius.pill,
      backgroundColor: circleLook(color).fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: circleLook(color).ring,
      boxShadow: color.elevationRest,
    },
    triggerOff: {opacity: 0.5},
    triggerPressed: {backgroundColor: color.surfacePressed},
    plus: {
      width: CONV_ICON_SIZE.plus,
      height: CONV_ICON_SIZE.plus,
      tintColor: color.icon,
    },
    triggerLabel: {fontSize: font.body, lineHeight: line.body, color: color.text},
    note: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
  });
