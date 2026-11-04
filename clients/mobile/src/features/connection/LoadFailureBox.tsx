import {CONNECTION_KEYS, type ConnectionPlainKey} from '@momo/core/features/connection/copyKeys';
import {copyForCause} from '@momo/core/features/connection/model';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {ErrorState, FailureBanner} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {SAFE_GUTTER, space} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import type {ReadFailure} from './readFailure';

// =============================================================================
// 읽기가 실패한 곳의 두 모양 (#5285, #5201 S-C 의 폰판: 웹 `LoadFailureBox`·`LoadFailureLine`).
//
// 받아 둔 것이 **없으면** 제목 + (이유 한 줄) + 「다시 시도」 상자(`LoadFailureBox`), **있으면** 상자로 덮지 않고 목록 위 한 줄만(`LoadFailureLine`). 읽을 것이 있는데
// 화면을 비우면 정보를 버리는 일이다. 이 부품은 어느 쪽을 그릴지 정하지 않는다 - 화면이 `data` 의 유무로 정한다(react-query 는 다시 읽기가 실패해도 `data` 를 남긴다).
//
// 문장은 모두 사전에서 온다: 제목(표면별 키) + 이유(코어 `copyForCause(원인).loadReason` - 오프라인 / 서버에 닿지 못함 / 그 밖). 상태 코드·서버 원문은 어디에도 없다.
// **이유는 띠가 같은 원인을 말하지 않을 때만** 붙는다(`failure.spoken`, `readFailure.ts`): 띠가 「서버에 닿지 못했어요」를 말하는데 상자도 같은 문장을 말하면 같은 원인이
// 두 줄이다(검증 5a: 에이전트 화면의 세 겹). 상자의 모양은 이 앱의 오류 상태(`ErrorState`)이고, 한 줄은 지속 실패 배너(`FailureBanner`, 팀 보드의 「새로 불러오지 못했어요」)다.
// =============================================================================

export function LoadFailureBox({
  titleKey,
  failure,
  onRetry,
  testID,
}: {
  /** 표면별 제목의 사전 키(`CONNECTION_KEYS.loadChannelListTitle` 등). */
  titleKey: ConnectionPlainKey;
  failure: ReadFailure;
  onRetry: () => void;
  testID: string;
}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  return (
    <ErrorState
      headline={formatMessage(titleKey)}
      detail={
        failure.spoken
          ? undefined
          : formatMessage(copyForCause(failure.cause).loadReason)
      }
      onRetry={onRetry}
      testID={testID}
    />
  );
}

/** 받아 둔 목록이 있을 때 그 위에 서는 한 줄: 내용은 그대로 두고 위에서만 말한다(제목 + 다시 시도). */
export function LoadFailureLine({
  titleKey,
  onRetry,
  testID,
}: {
  titleKey: ConnectionPlainKey;
  onRetry: () => void;
  testID: string;
}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.wrap}>
      <FailureBanner
        message={formatMessage(titleKey)}
        onRetry={onRetry}
        retryLabel={formatMessage(CONNECTION_KEYS.retry)}
        testID={testID}
      />
    </View>
  );
}

const buildStyles = () =>
  StyleSheet.create({
    // 팀 보드의 지속 실패 배너 자리(`TeamBoardScreen.bannerWrap`)와 같은 여백.
    wrap: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.sm},
  });
