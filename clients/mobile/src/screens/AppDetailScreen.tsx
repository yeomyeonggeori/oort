import {
  PHONE_APP_BLOCKED_SENTENCE,
  PHONE_APP_WEB_ACTION,
  PHONE_APPS_COPY as COPY,
  phoneAppDetail,
  type PhoneAppDetail,
  type PhoneAppToolRow,
} from '@momo/core/features/plugins/phoneApps';
import {serverSaysAbsent, serverSurface} from '@momo/core/features/capabilities/serverSurfaces';
import React, {useMemo} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {
  ErrorState,
  LoadingState,
  NoticeBlock,
  OutlineButton,
  Screen,
  ScreenHeader,
  SectionLabel,
  Sentence,
} from '../design/atoms';
import {useStyles} from '../design/theme';
import {font, line, radius, SAFE_GUTTER, space, type Palette} from '../design/tokens';
import {appsOnWebUrl} from '../features/conversation/appsTail';
import {openLink} from '../features/conversation/MessageBody';
import {StatusChip} from '../features/hostedAgents/StatusChip';
import {useOnline} from '../features/inbox/useOnline';
import {usePluginCatalog, usePluginDetail} from '../features/plugins/queries';
import {explicitTimeLabel} from '../features/work/model';
import {useSession} from '../session/useSession';
import {AppTile} from './AppsScreen';

// =============================================================================
// 한 앱 — 할 수 있는 일·연결하는 곳·내 권한을 읽기만 한다 (U-4 #3951).
//
// 버튼은 둘뿐이다: 뒤로가기, 그리고 막혔을 때의 「웹에서 열기」 하나. 설치·허용·회수는 폰에
// 없다(plans 2.6, 폰 동의 창은 v1.1 후보). 쓰기 도구는 승인 카드로 묻고 「항상 허용」은 v1에 없다
// (ADR-0188 D5) — 그 한 줄을 도구 목록 위에서 말한다. 승인 범위(이번 한 번 · 이 세션 동안)는 카드가
// 말하므로 여기서 하나만 있다고 단정하지 않는다.
//
// 「내 권한」은 목록 질의(`toolsByPlugin`, 호출한 사람의 실효 정책)에서 온다. 상세 질의에는 매니페스트만
// 있으므로 두 질의를 모두 읽는다. 목록이 아직 오지 않았으면 허용 여부를 말하지 않는다(짐작하지 않는다).
// =============================================================================

export default function AppDetailScreen({
  pluginId,
  name,
  onBack,
}: {
  pluginId: string;
  name: string;
  onBack: () => void;
}): React.JSX.Element {
  const {workspaceId} = useSession();
  const detailQuery = usePluginDetail(workspaceId, pluginId);
  const catalogQuery = usePluginCatalog(workspaceId, true);
  const online = useOnline();

  const policy = catalogQuery.data?.toolsByPlugin.get(pluginId);
  const view = useMemo(
    () =>
      detailQuery.data === undefined
        ? undefined
        : phoneAppDetail(detailQuery.data, policy),
    [detailQuery.data, policy],
  );
  // 허용 여부는 목록 질의가 와야 말할 수 있다. 오기 전에 「허용 없음」이라 하면 거짓이다.
  const policyKnown = catalogQuery.data !== undefined;

  const state: AppDetailState = serverSaysAbsent(detailQuery.error)
    ? 'absent'
    : detailQuery.isPending
      ? 'loading'
      : detailQuery.isError || view === undefined
        ? 'error'
        : 'ready';

  return (
    <AppDetailView
      title={name}
      state={state}
      view={view}
      policyKnown={policyKnown}
      policyFailed={catalogQuery.isError}
      offline={!online}
      staleAtMs={detailQuery.dataUpdatedAt}
      webUrl={appsOnWebUrl()}
      onBack={onBack}
      onRetry={() => {
        void detailQuery.refetch();
      }}
      onOpenWeb={openLink}
    />
  );
}

export type AppDetailState = 'loading' | 'absent' | 'error' | 'ready';

export function AppDetailView({
  title,
  state,
  view,
  policyKnown,
  policyFailed = false,
  offline,
  staleAtMs,
  webUrl,
  onBack,
  onRetry,
  onOpenWeb,
}: {
  title: string;
  state: AppDetailState;
  view?: PhoneAppDetail;
  policyKnown: boolean;
  /** 목록 질의가 실패해 내 권한을 모른다. 조용히 비우지 않고 한 줄로 말한다. */
  policyFailed?: boolean;
  offline: boolean;
  staleAtMs?: number;
  /** 「웹에서 열기」가 여는 주소. 서버 주소를 모르면 null — 열 수 없는 버튼을 세우지 않는다. */
  webUrl: string | null;
  onBack: () => void;
  onRetry: () => void;
  onOpenWeb: (url: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const absent = serverSurface('plugins');
  return (
    <Screen>
      <ScreenHeader
        title={title}
        subtitle={view === undefined ? COPY.title : `버전 ${view.version}`}
        onBack={onBack}
        backLabel="앱 목록으로"
        titleTestID="app-detail-title"
      />
      <ScrollView contentContainerStyle={styles.body} testID="app-detail-scroll">
        {offline && (state === 'ready' || state === 'error') ? (
          <NoticeBlock
            headline={COPY.offline}
            detail={
              staleAtMs && staleAtMs > 0
                ? `마지막으로 읽은 때: ${explicitTimeLabel(staleAtMs)}`
                : undefined
            }
            testID="app-detail-offline"
          />
        ) : null}

        {state === 'loading' ? (
          <LoadingState label={COPY.detailLoading} testID="app-detail-loading" />
        ) : state === 'absent' ? (
          <NoticeBlock
            headline={absent.absentReason}
            detail={absent.fallback}
            testID="app-detail-absent"
          />
        ) : state === 'error' || view === undefined ? (
          <ErrorState
            headline={COPY.detailErrorHeadline}
            detail={COPY.detailErrorDetail}
            onRetry={onRetry}
            testID="app-detail-error"
          />
        ) : (
          <Ready
            view={view}
            policyKnown={policyKnown}
            policyFailed={policyFailed}
            webUrl={webUrl}
            onOpenWeb={onOpenWeb}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

function Ready({
  view,
  policyKnown,
  policyFailed,
  webUrl,
  onOpenWeb,
}: {
  view: PhoneAppDetail;
  policyKnown: boolean;
  policyFailed: boolean;
  webUrl: string | null;
  onOpenWeb: (url: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {header} = view;
  // 막힘은 허용 여부를 아는 뒤에만 말한다.
  const blocked = policyKnown && view.blocked;
  return (
    <View>
      {/* ---- 머리: 타일 · 한 줄 소개 · 연결 칩 -------------------------------- */}
      <View style={styles.head}>
        <AppTile text={header.iconText} />
        <View style={styles.headText}>
          <Sentence style={styles.headSubtitle}>{header.subtitle}</Sentence>
          <View style={styles.chipLine}>
            {policyKnown ? (
              <StatusChip
                tone={header.tone}
                label={header.chipLabel}
                testID="app-detail-chip"
              />
            ) : null}
            {header.official ? (
              <StatusChip tone="muted" label={COPY.official} testID="app-detail-official" />
            ) : null}
          </View>
        </View>
      </View>

      {/* ---- 상태 ------------------------------------------------------------ */}
      <View style={styles.card} testID="app-detail-status">
        <Field label={COPY.statusWorkspace} value={view.statusWorkspace} testID="app-detail-status-workspace" />
        {policyKnown ? (
          <Field label={COPY.statusMine} value={view.statusMine} testID="app-detail-status-mine" />
        ) : null}
      </View>

      {policyFailed ? (
        <Sentence style={styles.plain} testID="app-detail-policy-unknown">
          {COPY.policyUnknown}
        </Sentence>
      ) : null}

      {/* ---- 폰 허용 경로: 문장 하나 + 행동 하나 ------------------------------- */}
      {blocked ? (
        <View style={styles.blocked} testID="app-detail-blocked">
          <Sentence style={styles.blockedText} testID="app-detail-blocked-sentence">
            {PHONE_APP_BLOCKED_SENTENCE}
          </Sentence>
          {webUrl !== null ? (
            <OutlineButton
              label={PHONE_APP_WEB_ACTION}
              onPress={() => onOpenWeb(webUrl)}
              testID="app-detail-open-web"
            />
          ) : null}
        </View>
      ) : null}

      {/* ---- 할 수 있는 일 ---------------------------------------------------- */}
      <SectionLabel label={COPY.toolsHeading} />
      {view.tools.length === 0 ? (
        <Sentence style={styles.plain}>{COPY.toolsNone}</Sentence>
      ) : (
        <View testID="app-detail-tools">
          {view.toolsSummary !== null ? (
            <Sentence style={styles.summary}>{view.toolsSummary}</Sentence>
          ) : null}
          {view.hasWriteTools ? (
            <Sentence style={styles.summary} testID="app-detail-write-note">
              {COPY.writeNote}
            </Sentence>
          ) : null}
          {view.tools.map(tool => (
            <ToolRow key={tool.name} tool={tool} policyKnown={policyKnown} />
          ))}
        </View>
      )}

      {/* ---- 연결하는 곳 ------------------------------------------------------ */}
      <SectionLabel label={COPY.egressHeading} />
      <View style={styles.block} testID="app-detail-egress">
        {view.egressDomains.length === 0 ? (
          <Sentence style={styles.plain}>{COPY.egressNone}</Sentence>
        ) : (
          <>
            <Sentence style={styles.plainNoGutter}>{COPY.egressLead}</Sentence>
            {view.egressDomains.map(domain => (
              <Text key={domain} style={styles.domain} selectable>
                {domain}
              </Text>
            ))}
          </>
        )}
      </View>

      {/* ---- 배포자 ----------------------------------------------------------- */}
      {view.publisher.length > 0 ? (
        <>
          <SectionLabel label={COPY.publisherHeading} />
          <View style={styles.card} testID="app-detail-publisher">
            {view.publisher.map(row => (
              <Field key={row.label} label={row.label} value={row.value} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

function ToolRow({
  tool,
  policyKnown,
}: {
  tool: PhoneAppToolRow;
  policyKnown: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const allowed = policyKnown && tool.allowed;
  const chips = tool.chips;
  // 행 하나가 한 번에 읽힌다: 제목, 범위, 칩의 글자.
  const label = [
    tool.title,
    tool.scopes,
    ...chips.map(chip => chip.label),
    ...(allowed ? [COPY.toolAllowed] : []),
  ]
    .filter(part => part !== '')
    .join('. ');
  return (
    <View
      style={styles.tool}
      accessible
      accessibilityLabel={label}
      testID={`app-detail-tool-${tool.name}`}>
      <Sentence style={styles.toolTitle}>{tool.title}</Sentence>
      <Text style={styles.toolMeta}>
        {tool.identifier !== null ? `${tool.identifier} · ` : ''}
        {tool.scopes}
      </Text>
      {chips.length > 0 || allowed ? (
        <View style={styles.chipLine}>
          {chips.map(chip => (
            <StatusChip
              key={chip.label}
              tone={chip.tone === 'danger' ? 'danger' : chip.tone === 'warn' ? 'warn' : 'muted'}
              label={chip.label}
            />
          ))}
          {allowed ? (
            <StatusChip
              tone="ok"
              label={COPY.toolAllowed}
              testID={`app-detail-tool-allowed-${tool.name}`}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Field({
  label,
  value,
  testID,
}: {
  label: string;
  value: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.field} testID={testID} accessible accessibilityLabel={`${label}. ${value}`}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Sentence style={styles.fieldValue}>{value}</Sentence>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    body: {paddingBottom: space.xl},
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.md,
    },
    headText: {flex: 1, gap: space.xs},
    headSubtitle: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    chipLine: {flexDirection: 'row', flexWrap: 'wrap', gap: space.xs},
    card: {
      marginHorizontal: SAFE_GUTTER,
      padding: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
      gap: space.sm,
    },
    field: {gap: space.xs},
    fieldLabel: {fontSize: font.meta, color: color.textFaint},
    fieldValue: {fontSize: font.label, color: color.text, lineHeight: line.label},
    blocked: {
      marginHorizontal: SAFE_GUTTER,
      marginTop: space.md,
      gap: space.sm,
      alignItems: 'flex-start',
    },
    blockedText: {fontSize: font.label, color: color.text, lineHeight: line.label},
    summary: {
      marginHorizontal: SAFE_GUTTER,
      marginBottom: space.xs,
      fontSize: font.meta,
      color: color.textMuted,
      lineHeight: line.meta,
    },
    plain: {
      marginHorizontal: SAFE_GUTTER,
      fontSize: font.label,
      color: color.textMuted,
      lineHeight: line.label,
    },
    plainNoGutter: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    block: {marginHorizontal: SAFE_GUTTER, gap: space.xs},
    domain: {fontSize: font.meta, color: color.text, fontFamily: 'Menlo'},
    tool: {
      marginHorizontal: SAFE_GUTTER,
      paddingVertical: space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
      gap: space.xs,
    },
    toolTitle: {fontSize: font.label, color: color.text, fontWeight: '600', lineHeight: line.label},
    toolMeta: {fontSize: font.meta, color: color.textMuted, lineHeight: line.meta},
  });
