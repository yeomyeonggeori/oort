import type {MessageAttachment} from '@momo/core/lib/api';
import React, {useMemo} from 'react';
import {Image, Pressable, StyleSheet, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {CONV_ICONS, CONV_ICON_SIZE} from '../../design/icons';
import {useStyles, usePalette} from '../../design/theme';
import {
  ds2Radius,
  font,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useAttachmentPreview} from '../attachments/content';
import {SET_ID, SET_WORD} from './setWords';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 참조 그림의 썸네일 (ADR-0218 §12 G1·L18, #5463 폰). 웹 `ExpressionSetReferences` 의 폰 짝이다.
//
// 카드가 가진 것은 **포인터**(첨부 id)이지 열쇠가 아니다: 그림은 대화가 쓰는 같은 인가 길(`useAttachmentPreview` →
// `…/channels/{c}/attachments/{id}/content`)로만 열린다. 열 수 없는 그림(지워졌거나 이 사람이 못 여는 것)과 연결이 끊겨 못 받는 그림은
// 다른 자리다: 오프라인에서는 요청 자체를 하지 않고 같은 크기의 자리만 둔다. 채널을 모르는 카드는 열 길이 없어 자리만 둔다.
// 「빼기」(장면 고치기)는 **빼기만** 된다: 더하는 길은 이 파일에 없다(L2.5).
// =============================================================================

/** 썸네일 한 장의 한 변(pt). */
export const REFERENCE_THUMB = 48;
/** 빼기 단추의 상자: 줄 높이가 `TOUCH_TARGET` 이라 슬롭 없이 44 를 채운다. */
const REMOVE_BOX = TOUCH_TARGET;

export interface ReferencePointer {
  attachmentId: string;
}

function ReferenceThumb({
  workspaceId,
  channelId,
  attachmentId,
  position,
  offline,
}: {
  workspaceId: string;
  channelId: string | undefined;
  attachmentId: string;
  position: number;
  offline: boolean;
}): React.JSX.Element {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  // 내려받는 길은 첨부의 `id` 와 캐시 파일 이름만 읽는다. 열쇠가 아닌 포인터에서 그 둘을 만든다.
  const attachment = useMemo(
    () => ({id: attachmentId, name: attachmentId}) as MessageAttachment,
    [attachmentId],
  );
  const reachable = channelId !== undefined && !offline;
  const preview = useAttachmentPreview(
    workspaceId,
    channelId ?? '',
    attachment,
    reachable,
  );
  const alt = formatMessage('expressions.plan.referenceAlt', {position});
  const uri =
    reachable && preview.status === SET_WORD.ready ? preview.uri : null;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={alt}
      style={styles.thumb}
      testID={SET_ID.reference(position)}>
      {uri !== null ? (
        <Image
          accessible={false}
          resizeMode="cover"
          source={{uri}}
          style={styles.thumbImage}
        />
      ) : null}
    </View>
  );
}

/** 참조 그림의 줄: 썸네일 0~4장. 장수가 0 이면 그리지 않는다. */
export function ExpressionSetReferences({
  references,
  workspaceId,
  channelId,
  offline,
}: {
  references: readonly ReferencePointer[];
  workspaceId: string;
  channelId: string | undefined;
  offline: boolean;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  if (references.length === 0) return null;
  return (
    <View style={styles.row} testID="expression-set-references">
      {references.map((reference, index) => (
        <ReferenceThumb
          key={reference.attachmentId}
          workspaceId={workspaceId}
          channelId={channelId}
          attachmentId={reference.attachmentId}
          position={index + 1}
          offline={offline}
        />
      ))}
    </View>
  );
}

/**
 * 계획 고치기의 참조 줄: 장마다 한 행(썸네일 · 이름 · 빼기). 누름 면은 행 높이(`TOUCH_TARGET`)를 채운다. **빼기만** 있고 더하는 단추는 없다.
 */
export function ExpressionSetReferenceRows({
  references,
  workspaceId,
  channelId,
  offline,
  disabled,
  onRemove,
}: {
  references: readonly ReferencePointer[];
  workspaceId: string;
  channelId: string | undefined;
  offline: boolean;
  disabled: boolean;
  onRemove: (attachmentId: string) => void;
}): React.JSX.Element | null {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  if (references.length === 0) return null;
  return (
    <View style={styles.rows} testID="expression-set-references">
      {references.map((reference, index) => {
        const position = index + 1;
        return (
          <View
            key={reference.attachmentId}
            style={styles.removeRow}
            testID={SET_ID.referenceRow(position)}>
            <ReferenceThumb
              workspaceId={workspaceId}
              channelId={channelId}
              attachmentId={reference.attachmentId}
              position={position}
              offline={offline}
            />
            <Sentence style={styles.removeName} numberOfLines={2}>
              {formatMessage('expressions.plan.referenceAlt', {position})}
            </Sentence>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={formatMessage(
                'expressions.plan.editRemoveReference',
                {position},
              )}
              accessibilityState={{disabled}}
              disabled={disabled}
              onPress={() => onRemove(reference.attachmentId)}
              style={({pressed}) => [
                styles.removeButton,
                pressed && !disabled && styles.removePressed,
              ]}
              testID={SET_ID.referenceRemove(position)}>
              <Image
                accessible={false}
                source={CONV_ICONS.cross}
                style={{
                  width: CONV_ICON_SIZE.cross,
                  height: CONV_ICON_SIZE.cross,
                  tintColor: palette.text,
                }}
              />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: SET_WORD.row,
      flexWrap: SET_WORD.wrap,
      alignItems: SET_WORD.center,
      gap: space.sm,
    },
    rows: {gap: space.xs},
    thumb: {
      width: REFERENCE_THUMB,
      height: REFERENCE_THUMB,
      borderRadius: ds2Radius.badge,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surfaceMuted,
      overflow: SET_WORD.hidden,
    },
    thumbImage: {width: REFERENCE_THUMB, height: REFERENCE_THUMB},
    removeRow: {
      flexDirection: SET_WORD.row,
      alignItems: SET_WORD.center,
      gap: space.md,
      minHeight: TOUCH_TARGET,
    },
    removeName: {flex: 1, fontSize: font.label, color: color.text},
    removeButton: {
      width: REMOVE_BOX,
      height: REMOVE_BOX,
      alignItems: SET_WORD.center,
      justifyContent: SET_WORD.center,
      borderRadius: ds2Radius.pill,
    },
    removePressed: {backgroundColor: color.surfacePressed},
  });
