import React, {useState} from 'react';
import {Linking, Pressable, StyleSheet, Text, View} from 'react-native';

import {BAR_CONTROL_MAX_SCALE, Sentence} from '../../design/atoms';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {GroupCard, ListRow, SheetScroll} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  radius,
  SAFE_GUTTER,
  SHEET,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {APP_STORE_URL, TESTFLIGHT_URL, type AppUpdateOffer} from './feed';

// =============================================================================
// 새 버전 배너 + 업데이트 시트 (#3905, 성재 결재 2026-10-16).
//
// 「홈 배너 활용은 좋은 거 같아. 그리고 프로필을 누르면 내 프로필 내 상태 위쪽에
// 업데이트 관련한 배너가 상시 노출(업데이트가 있을 때)하는 형태가 괜찮을 거 같아.」
//
// 같은 배너가 두 자리에 선다(홈 목록 맨 위, 프로필 시트의 「내 상태」 위). 닫기·나중에는
// 없다: 새 판이 있는 동안은 서 있고, 최신이 되면 피드가 더 새 판을 말하지 않아 저절로
// 사라진다. 누르면 시트가 어디로 가야 하는지 말한다. 이 앱은 스스로 설치할 수 없다
// (TestFlight·App Store가 설치한다).
// =============================================================================

export const APP_UPDATE_ACTION = '업데이트';

/** 시트가 가리키는 이동처. TestFlight 판이면 TestFlight 앱, 아니면 스토어. */
export function updateDestination(offer: AppUpdateOffer): {
  url: string;
  actionLabel: string;
  body: string;
  failure: string;
} {
  return offer.testflight
    ? {
        url: TESTFLIGHT_URL,
        actionLabel: 'TestFlight 열기',
        body: 'TestFlight 앱에서 업데이트를 눌러 주세요. 받은 뒤 oort를 다시 열면 새 버전이에요.',
        failure: 'TestFlight를 열지 못했어요. 홈 화면에서 TestFlight 앱을 직접 열어 주세요.',
      }
    : {
        url: APP_STORE_URL,
        actionLabel: 'App Store 열기',
        body: 'App Store에서 oort를 업데이트해 주세요. 받은 뒤 oort를 다시 열면 새 버전이에요.',
        failure: 'App Store를 열지 못했어요. 홈 화면에서 App Store 앱을 직접 열어 주세요.',
      };
}

export function AppUpdateBanner({
  offer,
  onPress,
  testID,
  flush = false,
}: {
  offer: AppUpdateOffer;
  onPress: () => void;
  testID: string;
  /** 호스트(홈 목록)가 이미 가로 여백을 줄 때: 배너가 한 번 더 들이지 않는다. */
  flush?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessible={false}
      style={[styles.banner, flush && styles.bannerFlush]}
      testID={testID}>
      <View style={styles.text}>
        <Text
          style={styles.title}
          numberOfLines={2}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
          {`새 버전 ${offer.version}`}
        </Text>
        <Sentence
          style={styles.meta}
          numberOfLines={2}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
          {`지금 쓰는 빌드는 ${offer.currentBuild}이에요`}
        </Sentence>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${APP_UPDATE_ACTION}, 새 버전 ${offer.version}`}
        onPress={onPress}
        style={({pressed}) => [styles.action, pressed && styles.pressed]}
        testID={`${testID}-action`}>
        <Text
          style={styles.actionLabel}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
          {APP_UPDATE_ACTION}
        </Text>
      </Pressable>
    </View>
  );
}

export function AppUpdateSheet({
  offer,
  onClose,
}: {
  offer: AppUpdateOffer;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [failed, setFailed] = useState(false);
  const destination = updateDestination(offer);
  const open = () => {
    setFailed(false);
    Linking.openURL(destination.url).catch(() => setFailed(true));
  };
  // 공용 시트(#4458): 머리의 오른쪽 원형 X · 스크림 · 끌어내리기 · VoiceOver escape 가 모두 같은 슬라이드를 지난다.
  // 옛 글자 「닫기」 단추는 없다 — 이름은 그대로 「업데이트 안내 닫기」다. 행동 한 줄(스토어로 가기)은 시트를 닫지 않는다:
  // 다른 앱으로 넘어갔다 돌아오면 안내가 그대로 남아 있어야 하고, 열지 못하면 이유가 이 시트 안에서 말해진다.
  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel="업데이트 안내"
      scrimLabel="업데이트 안내 닫기"
      scrimTestID="app-update-sheet-backdrop"
      testID="app-update-sheet">
      <SheetHeader
        title={`새 버전 ${offer.version} (${offer.latestBuild})`}
        closeLabel="업데이트 안내 닫기"
        closeTestID="app-update-close"
      />
      <SheetScroll>
        <GroupCard>
          <View style={styles.note}>
            <Sentence style={styles.noteBody}>{destination.body}</Sentence>
            {failed ? (
              <Sentence
                accessibilityLiveRegion="polite"
                style={styles.failure}
                testID="app-update-sheet-failure">
                {destination.failure}
              </Sentence>
            ) : null}
          </View>
        </GroupCard>
        <GroupCard>
          <ListRow
            title={destination.actionLabel}
            accessory="chevron"
            onPress={open}
            testID="app-update-open"
          />
        </GroupCard>
      </SheetScroll>
    </PageSheet>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      columnGap: space.md,
      marginHorizontal: SAFE_GUTTER,
      marginBottom: space.md,
      paddingVertical: space.md,
      paddingLeft: SAFE_GUTTER,
      paddingRight: space.md,
      borderRadius: ds2Radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    bannerFlush: {marginHorizontal: 0},
    text: {flex: 1, gap: space.xs},
    title: {fontSize: font.heading, fontWeight: '600', color: color.text},
    meta: {fontSize: font.meta, color: color.textMuted},
    action: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: SAFE_GUTTER,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.accentText,
    },
    actionLabel: {fontSize: font.label, fontWeight: '700', color: color.accentText},
    pressed: {opacity: 0.85},
    // 안내 문장 카드 — `ConfirmStep` 의 본문과 같은 안쪽 여백(카드 안 글자 열이 행과 맞는다).
    note: {
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    noteBody: {fontSize: font.body, lineHeight: line.body, color: color.text},
    failure: {fontSize: font.label, lineHeight: line.label, color: color.danger},
  });
