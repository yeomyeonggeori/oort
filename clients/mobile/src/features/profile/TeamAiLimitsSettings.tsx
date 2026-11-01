import {isOperatorDenied} from '@momo/core/features/settings/model';
import {
  fetchTeamAiLimitsBag,
  readTeamAiLimitsStatus,
  saveTeamAiLimits,
  type TeamAiLimitField,
} from '@momo/core/features/settings/teamAiLimits';
import {
  limitChange,
  limitInputErrorCopy,
  limitInputText,
  limitRowCopy,
  limitRows,
  limitSaveFailure,
  limitSaveFailureCopy,
  limitSwitchDisabled,
  limitsHeaderNote,
  parseLimitInput,
  teamAiLimitsQueryKey,
  type LimitRow,
  type LimitRowCopy,
  type LimitsLocale,
} from '@momo/core/features/settings/teamAiLimitsView';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import React, {useEffect, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {OutlineButton, Screen, Sentence} from '../../design/atoms';
import {PageHeader} from '../../design/SheetChrome';
import {GroupCard, InputPill, ListRow} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, SAFE_GUTTER, SHEET, space, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useLocaleService} from '../../i18n/useLocaleService';
import {useLayerClose} from '../../nav/EdgeSwipeBack';
import {ActionRow, SettingsNote, SettingsSection} from './settingsRows';

// =============================================================================
// 설정 › 관리자 설정 › 사용 한도 (#5026, #4944의 화면 몫, ADR-0201 증보 v3 B9).
//
// 웹 설정 › AI › 팀 AI 키의 「사용 한도」와 **같은 판단·같은 문장**이다: 판정(켤 수 있는가·입력 상한·0 거절·
// 사용 %·초기화 시각)과 문구는 전부 코어 `teamAiLimitsView.ts` 와 사전(`settings.aiLimits.*`)이 하고, 이 파일은
// 폰 설정 화면의 문법(`SwitchRow`·`GroupCard`·`SettingsNote`)으로 그리고 부르기만 한다.
//
// 기본은 제한 없음이다. 소유자·관리자만 보고(`SettingsPage` 의 「관리자 설정」 카드가 그 사람에게만 이 행을 세우고, 장을
// 열어도 서버가 403 이면 그렇다고 말한다), 켜기는 값을 적고 「저장」을 눌러야 서버에 간다. 끄기는 그 한도의 `null`
// 하나이고 **`0` 은 어디서도 보내지 않는다**. 운영자 천장은 입력 상한이고, 운영자가 팀 AI를 멈췄으면 모두 잠긴다.
//
// 모양은 `LinkPreviewSettings` 와 같다: 설정 페이지 위에 한 겹 더 쌓이는 장이고, 머리의 ‹ 와 왼쪽 가장자리 밀기와
// VoiceOver escape 가 한 겹만 벗긴다.
// =============================================================================

/**
 * 설정 페이지가 이 장을 가리키는 이름. 하이픈 낱말로 짓고 JSX 밖에서 선언한다: 직접 문구 장부는 영어 낱말 하나짜리
 * 리터럴과 JSX 식 안의 문자열을 문구로 센다(`SettingsPage` 의 다른 장 이름은 그렇게 세어진 옛 몫이다).
 */
export const AI_LIMITS_PAGE = 'ai-limits';

/** 시험 이름표도 JSX 밖에서 짓는다. */
const BACK_TEST_ID = 'settings-back';

function limitTestIds(base: string) {
  return {
    card: `${base}-card`,
    toggle: `${base}-toggle`,
    input: `${base}-input`,
    save: `${base}-save`,
    error: `${base}-error`,
    status: `${base}-status`,
    headline: `${base}-headline`,
    detail: `${base}-detail`,
    resets: `${base}-resets`,
  };
}

/** 「관리자 설정」 카드의 한 행. 이 행이 서는 조건은 호출자가 가린다(소유자·관리자만). */
export function TeamAiLimitsSettingRow({onPress}: {onPress: () => void}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  return (
    <ListRow
      title={formatMessage('settings.aiLimits.title')}
      accessory="chevron"
      onPress={onPress}
      accessibilityHint={formatMessage('settings.aiLimits.rowHint')}
      testID="settings-team-ai-limits"
    />
  );
}

function LimitCard({
  row,
  copy,
  locale,
  offline,
  pendingHere,
  pendingValue,
  saving,
  failure,
  succeeded,
  onSave,
}: {
  row: LimitRow;
  copy: LimitRowCopy;
  locale: LimitsLocale;
  offline: boolean;
  /** 이 행의 저장이 가는 중. */
  pendingHere: boolean;
  /** 가는 중인 저장의 값(`null` = 끄는 중). 이 행의 저장이 아니면 `undefined`. */
  pendingValue: number | null | undefined;
  /** 어느 행이든 저장이 가는 중(동시에 둘을 보내지 않는다). */
  saving: boolean;
  /** 이 행의 마지막 저장 실패 문장. */
  failure: string | null;
  /** 이 행의 마지막 저장이 성공했고 그 값(`null` = 껐다). `undefined` = 성공한 적 없음. */
  succeeded: number | null | undefined;
  onSave: (field: TeamAiLimitField, value: number | null) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const ids = limitTestIds(`team-ai-limit-${row.field}`);
  const [draft, setDraft] = useState(false);
  const [text, setText] = useState(limitInputText(row.saved));
  const [invalid, setInvalid] = useState<string | null>(null);

  // 서버의 값이 바뀌면(저장 성공·다른 곳에서 바꿈) 입력칸을 그 값으로 맞추고 초안을 접는다.
  useEffect(() => {
    setText(limitInputText(row.saved));
    setInvalid(null);
    setDraft(false);
  }, [row.saved]);
  // 쓰던 초안은 이 행이 더는 쓸 수 없게 되면(운영자가 멈춤, 금액 한도 불가로 바뀜) 접는다.
  useEffect(() => {
    if (!row.editable) setDraft(false);
  }, [row.editable]);

  // 끄는 중에는 누른 값(꺼짐)을 보여 준다: 응답을 기다리는 동안 되돌아 튀는 스위치는 고장 난 것처럼 보인다.
  // 실패하면 저장된 값이 그대로라 켜진 채로 돌아오고 실패 문장이 선다.
  const turningOff = pendingHere && pendingValue === null;
  const shownOn = !turningOff && (row.saved !== null || draft);
  const switchDisabled = offline || saving || limitSwitchDisabled(row, shownOn, draft);
  const typed = text.trim();
  const canSave =
    row.editable && !offline && !saving && typed !== '' && typed !== limitInputText(row.saved);
  const problem = invalid ?? failure;

  function toggle(next: boolean) {
    if (switchDisabled) {
      return;
    }
    setInvalid(null);
    if (next) {
      // 켜기는 값을 적어 저장해야 서버에 간다.
      setDraft(true);
      return;
    }
    if (row.saved === null) {
      setDraft(false);
      setText('');
      return;
    }
    // 끄기는 그 한도의 null 하나다. 0이 아니다.
    onSave(row.field, null);
  }

  function submit() {
    if (!canSave) {
      return;
    }
    const parsed = parseLimitInput(row.field, text, row.ceiling);
    if (!parsed.ok) {
      setInvalid(limitInputErrorCopy(row.field, parsed, locale));
      return;
    }
    setInvalid(null);
    onSave(row.field, parsed.value);
  }

  const saveLabel = formatMessage(pendingHere ? 'settings.aiLimits.saving' : 'settings.aiLimits.save');

  return (
    <SettingsSection testID={ids.card}>
      <GroupCard>
        <ListRow
          title={copy.label}
          detail={copy.hint}
          accessory="toggle"
          toggle={{value: shownOn, onValueChange: toggle}}
          disabled={switchDisabled}
          testID={ids.toggle}
        />
        {shownOn ? (
          <View style={styles.editor}>
            {/* 눈에 보이는 이름표다. 입력 칸이 같은 이름을 접근성 이름으로 이미 들고 있어서 보조기술에는 숨긴다(두 번 읽히지 않게). */}
            <Sentence
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={styles.caption}>
              {copy.valueLabel}
            </Sentence>
            <InputPill
              accessibilityLabel={copy.valueLabel}
              value={text}
              onChangeText={next => {
                setText(next);
                setInvalid(null);
              }}
              inputMode={row.inputMode}
              autoCorrect={false}
              editable={row.editable && !offline}
              onSubmitEditing={submit}
              testID={ids.input}
            />
          </View>
        ) : null}
        {shownOn ? (
          <ActionRow
            title={saveLabel}
            tone="accent"
            disabled={!canSave}
            pending={pendingHere}
            onPress={submit}
            testID={ids.save}
          />
        ) : null}
      </GroupCard>
      {problem !== null ? (
        <SettingsNote tone="danger" testID={ids.error}>
          {problem}
        </SettingsNote>
      ) : null}
      {copy.headline !== null ? <SettingsNote testID={ids.headline}>{copy.headline}</SettingsNote> : null}
      {copy.detail !== null ? <SettingsNote testID={ids.detail}>{copy.detail}</SettingsNote> : null}
      {copy.resets !== null ? <SettingsNote testID={ids.resets}>{copy.resets}</SettingsNote> : null}
      {copy.notes.map(note => (
        <SettingsNote key={note}>{note}</SettingsNote>
      ))}
      {copy.pricingNote !== null ? <SettingsNote>{copy.pricingNote}</SettingsNote> : null}
      {succeeded !== undefined && problem === null ? (
        <SettingsNote testID={ids.status}>
          {formatMessage(succeeded === null ? 'settings.aiLimits.cleared' : 'settings.aiLimits.saved')}
        </SettingsNote>
      ) : null}
    </SettingsSection>
  );
}

export function TeamAiLimitsSettingsPage({
  workspaceId,
  onBack,
}: {
  workspaceId: string;
  onBack: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const closeLayer = useLayerClose();
  const formatMessage = useFormatMessage();
  const locale = useLocaleService();
  const client = useQueryClient();
  const goBack = closeLayer ?? onBack;
  const key = teamAiLimitsQueryKey(workspaceId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchTeamAiLimitsBag(workspaceId),
    retry: false,
    staleTime: 30_000,
  });
  const save = useMutation({
    mutationFn: ({field, value}: {field: TeamAiLimitField; value: number | null}) =>
      saveTeamAiLimits(workspaceId, limitChange(field, value)),
    // 응답은 저장된 가방 + 계산된 읽기다: 그대로 캐시에 두면 값·사용량·불가 사유가 한 번에 맞는다.
    onSuccess: saved => client.setQueryData(key, saved),
    onError: error => {
      // 금액 한도를 켤 수 없다는 답은 까닭이 응답에 없다. 다시 읽어 행의 안내가 까닭을 말하게 한다.
      if (limitSaveFailure(error) === 'usd_unavailable') {
        void client.invalidateQueries({queryKey: key});
      }
    },
  });
  // 읽기가 멈췄거나(오프라인) 쓰기가 멈췄으면 지금은 바꿀 수 없다.
  const offline = query.isPaused || save.isPaused;
  const status = query.data === undefined ? null : readTeamAiLimitsStatus(query.data);
  const denied = query.isError && isOperatorDenied(query.error);
  const now = Date.now();
  const failureOf = (field: TeamAiLimitField): string | null =>
    save.isError && save.variables?.field === field
      ? limitSaveFailureCopy(limitSaveFailure(save.error), locale)
      : null;

  let body: React.JSX.Element;
  if (denied) {
    body = <SettingsNote testID="team-ai-limits-denied">{formatMessage('settings.aiLimits.notAdmin')}</SettingsNote>;
  } else if (query.isError) {
    body = (
      <View style={styles.state} testID="team-ai-limits-load-error">
        <SettingsNote tone="danger">{formatMessage('settings.aiLimits.loadFailed')}</SettingsNote>
        <OutlineButton
          label={formatMessage('settings.aiLimits.retry')}
          onPress={() => {
            void query.refetch();
          }}
        />
      </View>
    );
  } else if (query.isPending) {
    body = (
      <SettingsNote testID="team-ai-limits-loading">
        {formatMessage(offline ? 'settings.aiLimits.offline' : 'settings.aiLimits.loading')}
      </SettingsNote>
    );
  } else if (status === null) {
    // 한도 읽기를 모르는 서버(#4944 이전)는 계산된 읽기를 싣지 않는다. 일부만 믿고 그리지 않는다.
    body = <SettingsNote testID="team-ai-limits-unsupported">{formatMessage('settings.aiLimits.unsupported')}</SettingsNote>;
  } else {
    const headerNote = limitsHeaderNote(status, locale);
    body = (
      <>
        <SettingsNote>{formatMessage('settings.aiLimits.description')}</SettingsNote>
        {headerNote !== null ? <SettingsNote testID="team-ai-limits-operator-off">{headerNote}</SettingsNote> : null}
        {offline ? <SettingsNote testID="team-ai-limits-offline">{formatMessage('settings.aiLimits.offline')}</SettingsNote> : null}
        {limitRows(status).map(row => (
          <LimitCard
            key={row.field}
            row={row}
            copy={limitRowCopy(row, status, locale, now)}
            locale={locale}
            offline={offline}
            pendingHere={save.isPending && save.variables?.field === row.field}
            pendingValue={save.isPending && save.variables?.field === row.field ? save.variables.value : undefined}
            saving={save.isPending}
            failure={failureOf(row.field)}
            succeeded={save.isSuccess && save.variables?.field === row.field ? save.variables.value : undefined}
            onSave={(field, value) => save.mutate({field, value})}
          />
        ))}
      </>
    );
  }

  return (
    <View onAccessibilityEscape={goBack} style={styles.root} testID="settings-team-ai-limits-page">
      <Screen>
        <PageHeader
          back={{
            label: formatMessage('mobile.locale.backToSettings'),
            onPress: goBack,
            testID: BACK_TEST_ID,
          }}
          testID="settings-sub-header"
          title={formatMessage('settings.aiLimits.title')}
          titleTestID="settings-sub-title"
        />
        <ScrollView
          contentContainerStyle={[styles.content, {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg}]}
          keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>
      </Screen>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    content: {paddingTop: space.md, paddingHorizontal: SAFE_GUTTER, gap: space.lg},
    state: {gap: space.sm},
    // 카드 안의 입력 칸: 위 이름(`valueLabel`)과 알약. 카드의 가로 여백(`SHEET.cardInset`)은 다른 행과 같다.
    editor: {
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.sm,
      gap: space.xs,
    },
    caption: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
  });
