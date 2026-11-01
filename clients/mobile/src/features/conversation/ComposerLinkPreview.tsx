import {
  unfurlDrawsCards,
  type UnfurlPreviewCard,
} from '@momo/core/features/timeline/unfurl';
import React from 'react';
import {Image, Pressable, ScrollView, StyleSheet, View} from 'react-native';

import {useStyles} from '../../design/theme';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {
  ATTACHMENT_TRAY_MAX_HEIGHT,
  slopTo,
  space,
  type Palette,
} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {CONV} from './convDesign';
import {LINK_CARD} from './linkCardDesign';
import {useLinkPreviewPreference} from './linkPreviewPreference';
import {CardView} from './UnfurlCards';

// =============================================================================
// 입력칸 위의 링크 미리보기 — 폰 (#5016, 웹 `ComposerLinkPreview.tsx` #5005 의 짝).
//
// 카드 한 장은 타임라인 카드와 **같은 컴포넌트**(`UnfurlCards.tsx` 의 `CardView`)이고, 무엇을 보일지는 같은 코어
// 표시 모델이 정한다(작게·크게는 이 기기의 설정을 따른다 — 이 줄은 규칙을 다시 판단하지 않는다). 이 파일이 더하는
// 것은 줄의 자리와 「이번 메시지는 미리보기 없이 보내기」(✕) 하나다.
//
// 자리: 첨부 트레이(`AttachmentTray`)와 같은 줄 모양(도크 안쪽 8, 아래 머리카락 선)으로 그 바로 아래, 인용 줄·알약
// 위다. 알약 **밖**이라 ✕가 보내기를 일으키지 않고, 입력창을 눌러 키보드를 올리는 규칙에 카드가 섞이지 않는다.
// 카드는 늘 입력칸 위에서 자라므로, 줄 높이는 트레이와 같은 상한(`ATTACHMENT_TRAY_MAX_HEIGHT`, 웹 `max-h-tray-max`와
// 짝)으로 묶고 넘치면 줄 안에서 스크롤한다. 작은 카드 셋은 이 안에 다 든다(3 × 72 + 2 × 8 = 232). 큰 카드는 잘려
// 스크롤된다 — 화면 검수에서 받아들일 만한지 본다.
//
// ✕는 첫 카드에 한 개다. 끄는 범위는 카드 한 장이 아니라 **이번 메시지의 미리보기 전체**이기 때문이다. 카드 오른쪽
// 위에 얹고(웹과 같은 자리), 작은 카드의 글은 그 자리를 비워 두어(`endInset`) 긴 제목이 ✕ 밑으로 흐르지 않는다.
// 누르는 면은 보이는 28을 44까지 채운다(`slopTo`).
//
// 낭독: 카드는 타임라인과 같은 「링크 미리보기: 제목, 도메인」이고, ✕는 「이번 메시지는 미리보기 없이 보내기」다.
// 눌렀을 때의 안내(`previewDismissed`)는 호출한 쪽(`Composer`)이 `announceForAccessibility` 로 말한다 — 이 줄은
// 눌린 순간 사라지므로 늘 붙어 있는 안내 자리를 가질 수 없다(iOS 에는 live region 도 없다).
// =============================================================================

export function ComposerLinkPreview({
  cards,
  onDismiss,
}: {
  cards: readonly UnfurlPreviewCard[];
  /** ✕. 호출한 쪽이 상태를 바꾸고 결과를 소리로 알린다. */
  onDismiss: () => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const preference = useLinkPreviewPreference();
  if (!unfurlDrawsCards(preference) || cards.length === 0) return null;
  const dismissLabel = formatMessage('timeline.unfurl.previewDismiss');
  return (
    <View style={styles.root} testID="composer-link-preview">
      <ScrollView
        contentContainerStyle={styles.list}
        // 키보드가 올라와 있어도 ✕와 카드의 첫 누름이 키보드를 내리는 데 쓰이지 않는다.
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        style={styles.viewport}
        testID="composer-link-preview-list">
        {cards.map((card, index) => (
          <View key={card.id} style={styles.item}>
            <CardView
              eagerIcon
              endInset={index === 0 ? LINK_CARD.dismiss + space.xs : 0}
              preference={preference}
              rowKey="composer-link-preview"
              unfurl={card}
            />
            {index === 0 ? (
              // 카드 전체를 덮는 투명한 자리에 ✕를 오른쪽 위로 민다. 자리 자신은 눌림을 받지 않아(`box-none`) 카드의
              // 나머지는 그대로 눌린다.
              <View pointerEvents="box-none" style={styles.corner}>
                <Pressable
                  accessibilityLabel={dismissLabel}
                  accessibilityRole="button"
                  hitSlop={slopTo(LINK_CARD.dismiss)}
                  onPress={onDismiss}
                  style={({pressed}) => [styles.dismiss, pressed && styles.dismissPressed]}
                  testID="composer-link-preview-dismiss">
                  <Image
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                    source={CONV_ICONS.cross}
                    style={styles.dismissGlyph}
                  />
                </Pressable>
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 첨부 트레이(`AttachmentTray`)와 같은 줄: 도크 안쪽 가장자리, 위아래 8, 아래에 머리카락 선.
    root: {
      paddingHorizontal: CONV.composerDockInset,
      paddingVertical: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    viewport: {maxHeight: ATTACHMENT_TRAY_MAX_HEIGHT},
    list: {gap: space.sm},
    // 카드 폭은 타임라인과 같은 상한까지다(`LINK_CARD.maxWidth`). 좁은 화면에서는 줄 폭이 이긴다.
    item: {width: '100%', maxWidth: LINK_CARD.maxWidth},
    // 카드 위를 덮는 투명한 자리: ✕를 오른쪽 위 모서리로 민다(웹과 같은 자리, 안쪽 여백 4). 직접 문구 장부는 `'absolute'` 같은
    // 낱말 리터럴도 세므로 위치는 `absoluteFill` 로 얻고 정렬은 하이픈 낱말로 적는다.
    corner: {...StyleSheet.absoluteFill, alignItems: 'flex-end', padding: space.xs},
    // 카드 위에 얹는 ✕. 면은 `surface`, 경계는 3:1 컨트롤 경계(`textFaint` — 웹 `border-line-strong`과 같은 자리)다. 글리프는
    // 안쪽 여백으로 가운데에 놓는다(보이는 28 − 글리프 14 − 경계 양쪽의 반).
    dismiss: {
      width: LINK_CARD.dismiss,
      height: LINK_CARD.dismiss,
      borderRadius: LINK_CARD.dismiss / 2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
      padding: (LINK_CARD.dismiss - CONV_ICON_SIZE.cross) / 2 - StyleSheet.hairlineWidth,
    },
    dismissPressed: {backgroundColor: color.surfacePressed},
    dismissGlyph: {
      width: CONV_ICON_SIZE.cross,
      height: CONV_ICON_SIZE.cross,
      tintColor: color.textMuted,
    },
  });
