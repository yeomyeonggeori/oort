import {
  PHONE_APPS_COPY as COPY,
  phoneAppRows,
  type PhoneAppRow,
} from '@momo/core/features/plugins/phoneApps';
import {
  isSurfaceProvided,
  serverSaysAbsent,
  serverSurface,
} from '@momo/core/features/capabilities/serverSurfaces';
import React, {useCallback, useMemo} from 'react';
import {FlatList, StyleSheet, Text, View} from 'react-native';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoticeBlock,
  Screen,
  ScreenHeader,
  Sentence,
  TapRow,
} from '../design/atoms';
import {PULL_FILL, usePullRefresh, type PullScrollProps} from '../design/refresh';
import {useStyles} from '../design/theme';
import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../design/tokens';
import {StatusChip} from '../features/hostedAgents/StatusChip';
import {useOnline} from '../features/inbox/useOnline';
import {usePluginCatalog} from '../features/plugins/queries';
import {explicitTimeLabel} from '../features/work/model';
import {useSession} from '../session/useSession';

// =============================================================================
// 「앱」 목록 — 폰이 공식 앱을 읽는 자리 (U-4 #3951, ADR-0113 증보 2 E4).
//
// 관전·읽기 표면이다. 설치도 허용도 회수도 여기엔 없다: 폰에는 동의 창이 없고(plans 2.6) 그
// 일은 데스크탑이나 웹에서 한다. 이 화면은 그 말을 목록 위에 한 번 한다(`COPY.readonlyNote`).
// 줄의 칩은 웹 목록과 같은 읽기다(`pluginConnectionLabel`): 설치됐나와 허용했나를 화면이
// 따로 계산하지 않는다.
//
// ## 네 상태 + 서버 미제공 + 오프라인
//
// 로딩·오류·빈 목록·데이터가 다른 화면과 같은 어휘로 갈리고, 둘이 더 있다:
//   * 서버 미제공 — 404·405·501 은 장애가 아니라 「이 서버에는 없다」는 답이라 붉은 오류가 아니라
//     `NoticeBlock` 으로 선다(`serverSaysAbsent`). 문장은 판정표(`plugins`)가 갖고 있다.
//   * 오프라인 — 캐시된 목록을 그릴 때 캐시임을 말하고, 마지막으로 읽은 시각을 붙인다.
// =============================================================================

export default function AppsScreen({
  onBack,
  onOpenApp,
  active = true,
}: {
  onBack: () => void;
  onOpenApp: (pluginId: string, name: string) => void;
  /** 지금 이 목록이 맨 위에 보이는가. 상세가 열려 있는 동안에는 새로고침 실패 안내를 거둔다(#3992). */
  active?: boolean;
}): React.JSX.Element {
  const {workspaceId} = useSession();
  const provided = isSurfaceProvided('plugins');
  const query = usePluginCatalog(workspaceId, provided);
  const online = useOnline();

  const rows = useMemo(
    () =>
      query.data === undefined
        ? []
        : phoneAppRows(query.data.plugins, query.data.toolsByPlugin),
    [query.data],
  );

  const refetch = query.refetch;
  const {refreshControl, scrollProps, notice} = usePullRefresh(
    useCallback(() => refetch(), [refetch]),
    'apps-refresh',
    {active},
  );

  const state: AppsViewState = !provided || serverSaysAbsent(query.error)
    ? 'absent'
    : query.isPending
      ? 'loading'
      : query.isError
        ? 'error'
        : 'ready';

  return (
    <AppsView
      state={state}
      rows={rows}
      offline={!online}
      staleAtMs={query.dataUpdatedAt}
      onBack={onBack}
      onRetry={() => {
        void query.refetch();
      }}
      onOpenApp={onOpenApp}
      refreshControl={refreshControl}
      scrollProps={scrollProps}
      notice={notice}
    />
  );
}

export type AppsViewState = 'loading' | 'absent' | 'error' | 'ready';

/** 순수 표현부. 훅 없이 props 로만 그린다 — 캡처와 시험이 프로바이더 없이 직접 세운다. */
export function AppsView({
  state,
  rows,
  offline,
  staleAtMs,
  onBack,
  onRetry,
  onOpenApp,
  refreshControl,
  scrollProps,
  notice,
}: {
  state: AppsViewState;
  rows: PhoneAppRow[];
  offline: boolean;
  staleAtMs?: number;
  onBack: () => void;
  onRetry: () => void;
  onOpenApp: (pluginId: string, name: string) => void;
  refreshControl?: React.ComponentProps<typeof EmptyState>['refreshControl'];
  scrollProps?: PullScrollProps;
  notice?: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const absent = serverSurface('plugins');
  return (
    <Screen>
      <ScreenHeader
        title={COPY.title}
        subtitle={COPY.subtitle}
        onBack={onBack}
        backLabel="앱 닫기"
        titleTestID="apps-title"
      />
      {offline && (state === 'ready' || state === 'error') ? (
        <NoticeBlock
          headline={COPY.offline}
          detail={
            staleAtMs && staleAtMs > 0
              ? `마지막으로 읽은 때: ${explicitTimeLabel(staleAtMs)}`
              : undefined
          }
          testID="apps-offline"
        />
      ) : null}

      {notice}

      {state === 'loading' ? (
        <LoadingState label={COPY.loading} testID="apps-loading" />
      ) : state === 'absent' ? (
        <NoticeBlock
          headline={absent.absentReason}
          detail={absent.fallback}
          testID="apps-absent"
        />
      ) : state === 'error' ? (
        <ErrorState
          headline={COPY.errorHeadline}
          detail={COPY.errorDetail}
          onRetry={onRetry}
          testID="apps-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          headline={COPY.emptyHeadline}
          detail={COPY.emptyDetail}
          refreshControl={refreshControl}
          scrollProps={scrollProps}
          testID="apps-empty"
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={item => item.pluginId}
          ListHeaderComponent={
            <View style={styles.lead}>
              <Sentence style={styles.leadText}>{COPY.lead}</Sentence>
              <Sentence style={styles.readonlyText} testID="apps-readonly-note">
                {COPY.readonlyNote}
              </Sentence>
            </View>
          }
          renderItem={({item}) => (
            <Row item={item} onPress={() => onOpenApp(item.pluginId, item.name)} />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          {...scrollProps}
          testID="apps-list"
        />
      )}
    </Screen>
  );
}

/** 앱 타일 — 서버가 준 글자나 이름의 머리글자. 브랜드 이미지를 쓰지 않는다. */
export function AppTile({text}: {text: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.tile} importantForAccessibility="no-hide-descendants">
      <Text style={styles.tileText} numberOfLines={1} allowFontScaling={false}>
        {text}
      </Text>
    </View>
  );
}

function Row({
  item,
  onPress,
}: {
  item: PhoneAppRow;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <TapRow
      accessibilityLabel={item.spoken}
      onPress={onPress}
      testID={`apps-row-${item.pluginId}`}>
      <AppTile text={item.iconText} />
      <View style={styles.rowText}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
            {item.name}
          </Text>
          {item.official ? (
            <Text style={styles.rowOfficial}>{COPY.official}</Text>
          ) : null}
        </View>
        <Sentence style={styles.rowDetail} numberOfLines={2}>
          {item.subtitle}
        </Sentence>
        <View style={styles.chipLine}>
          <StatusChip
            tone={item.tone}
            label={item.chipLabel}
            testID={`apps-row-chip-${item.pluginId}`}
          />
        </View>
      </View>
    </TapRow>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    listContent: {paddingBottom: space.lg, ...PULL_FILL},
    lead: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.md,
      paddingBottom: space.sm,
      gap: space.xs,
    },
    leadText: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    readonlyText: {fontSize: font.meta, color: color.textFaint, lineHeight: line.meta},
    tile: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surfaceMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tileText: {fontSize: font.body, fontWeight: '600', color: color.text},
    rowText: {flex: 1, gap: space.xs},
    rowTitleLine: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
    rowTitle: {fontSize: font.body, color: color.text, fontWeight: '600', flexShrink: 1},
    rowOfficial: {fontSize: font.meta, color: color.textFaint},
    rowDetail: {fontSize: font.meta, color: color.textMuted, lineHeight: line.meta},
    chipLine: {flexDirection: 'row', flexWrap: 'wrap'},
  });
