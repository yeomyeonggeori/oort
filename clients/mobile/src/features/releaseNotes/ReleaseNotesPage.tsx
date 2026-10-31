import {
  findReleaseNote,
  listReleaseNotes,
  noteForPhoneBuild,
  type ReleaseNote,
  type ReleaseNoteSurface,
} from '@momo/core/features/releaseNotes/model';
import {RELEASE_NOTES} from '@momo/core/features/releaseNotes/notes';
import {nativeBuildVersion} from 'expo-application';
import React, {useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Screen, Sentence} from '../../design/atoms';
import {PageHeader} from '../../design/SheetChrome';
import {GroupCard, ListRow} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {
  font,
  line,
  SAFE_GUTTER,
  SHEET,
  space,
  type Palette,
} from '../../design/tokens';
import {EdgeSwipeBack, useLayerClose} from '../../nav/EdgeSwipeBack';
import {useReleaseNotesMessages} from './useReleaseNotesMessages';

// =============================================================================
// 설정 › 업데이트 소식 (#4937, owner 10-31): 버전 목록 → 버전별 내용.
//
// 설정 페이지 위에 한 겹 더 쌓이는 안쪽 장이다(`SettingsPage` 의 `releaseNotes` 장, 언어 장과 같은 문법). 목록에서
// 버전을 고르면 그 위에 한 겹이 더 밀려 들어오고(‹ 는 목록으로, 목록의 ‹ 는 설정으로), 두 겹 모두 가장자리 밀기와
// VoiceOver escape 가 한 겹씩만 벗긴다. 이 화면에는 자기 움직임이 없다: 겹의 들어옴·나감은 `EdgeSwipeBack` 이 지고 동작
// 줄이기면 즉시다.
//
// 목록은 새 소식이 맨 위이고, 이 빌드에 붙는 소식(`noteForPhoneBuild`)의 오른쪽 값이 「지금 쓰는 버전」이다(나머지는 공개일).
// 이 빌드의 자기 소식이 아직 없으면 그 앞의 가장 새 소식에 선다(그 소식이 이 앱에 적용되는 가장 새 것이다).
// 내용은 팀이 QA 와 써 보기에 쓴다: 항목마다 보이는 화면(폰·데스크탑) 표지, 「바뀐 점」, 「이렇게 써 보세요」.
// =============================================================================

const SURFACE_KEY = {
  phone: 'releaseNotes.surface.phone',
  desktop: 'releaseNotes.surface.desktop',
} as const satisfies Record<ReleaseNoteSurface, string>;

// testID 는 템플릿 문자열로 짓지 않는다: 직접 문구 장부(`direct-copy.mjs`)가 JSX 안의 템플릿 조각을 문구로 센다.
const rowTestId = (version: string) => 'release-notes-row-' + version;
const itemTestId = (id: string) => 'release-notes-item-' + id;
const surfacesTestId = (id: string) => itemTestId(id) + '-surfaces';
// JSX 식 안의 글자 있는 문자열은 직접 문구 장부가 문구로 센다 — 머리의 ‹ 단추 속성은 식 밖에서 만든다.
const LIST_BACK_TEST_ID = 'settings-back';
const DETAIL_BACK_TEST_ID = 'release-notes-back';

/** 설정 › 정보 카드의 한 줄. 오른쪽 값은 이 빌드에 붙는 소식의 버전이다(없으면 비운다). */
export function ReleaseNotesSettingRow({
  onPress,
  notes = RELEASE_NOTES,
  build = nativeBuildVersion,
}: {
  onPress: () => void;
  notes?: readonly ReleaseNote[];
  build?: string | null;
}): React.JSX.Element {
  const {messages} = useReleaseNotesMessages();
  const current = noteForPhoneBuild(notes, build);
  return (
    <ListRow
      title={messages.formatMessage('releaseNotes.page.title')}
      value={current?.version}
      accessory="chevron"
      accessibilityHint={messages.formatMessage('releaseNotes.page.openHint')}
      onPress={onPress}
      testID="settings-release-notes-row"
    />
  );
}

/** 목록 장. 버전을 고르면 그 위에 내용 장이 한 겹 더 선다. */
export function ReleaseNotesSettingsPage({
  onBack,
  notes: given = RELEASE_NOTES,
  build = nativeBuildVersion,
}: {
  onBack: () => void;
  notes?: readonly ReleaseNote[];
  build?: string | null;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const closeLayer = useLayerClose();
  const {messages, noteLocale} = useReleaseNotesMessages();
  const notes = useMemo(() => listReleaseNotes(given), [given]);
  const current = noteForPhoneBuild(notes, build);
  const [selected, setSelected] = useState<string | null>(null);
  const goBack = closeLayer ?? onBack;
  const back = {
    label: messages.formatMessage('releaseNotes.page.back'),
    onPress: goBack,
    testID: LIST_BACK_TEST_ID,
  };
  const opened = selected === null ? null : findReleaseNote(notes, selected);
  return (
    <View
      style={styles.root}
      onAccessibilityEscape={goBack}
      testID="settings-release-notes-page">
      <Screen>
        <PageHeader
          title={messages.formatMessage('releaseNotes.page.title')}
          back={back}
          titleTestID="settings-sub-title"
          testID="settings-sub-header"
        />
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
          ]}>
          <Sentence style={styles.intro}>
            {messages.formatMessage('releaseNotes.page.description')}
          </Sentence>
          {notes.length === 0 ? (
            <Sentence style={styles.intro} testID="release-notes-empty">
              {messages.formatMessage('releaseNotes.page.empty')}
            </Sentence>
          ) : (
            <GroupCard>
              {notes.map(note => (
                <ListRow
                  key={note.version}
                  title={messages.formatMessage('releaseNotes.version.label', {
                    version: note.version,
                  })}
                  detail={note.summary[noteLocale]}
                  value={
                    current !== null && current.version === note.version
                      ? messages.formatMessage('releaseNotes.version.current')
                      : note.releasedOn
                  }
                  accessory="chevron"
                  onPress={() => setSelected(note.version)}
                  testID={rowTestId(note.version)}
                />
              ))}
            </GroupCard>
          )}
        </ScrollView>
      </Screen>
      {opened !== null ? (
        <EdgeSwipeBack
          accessibilityViewIsModal
          style={styles.pane}
          onBack={() => setSelected(null)}
          enter="push"
          testID="release-notes-detail-pane">
          <ReleaseNoteDetailPage note={opened} onBack={() => setSelected(null)} />
        </EdgeSwipeBack>
      ) : null}
    </View>
  );
}

/** 내용 장: 공개일과 요약, 항목마다 보이는 화면·바뀐 점·이렇게 써 보세요. */
function ReleaseNoteDetailPage({
  note,
  onBack,
}: {
  note: ReleaseNote;
  onBack: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const closeLayer = useLayerClose();
  const {messages, noteLocale} = useReleaseNotesMessages();
  const goBack = closeLayer ?? onBack;
  const versionLabel = messages.formatMessage('releaseNotes.version.label', {
    version: note.version,
  });
  // 보이는 화면은 알약이 아니라 한 줄 글자다(폰 · 데스크탑): 누를 수 없는 표지에 컨트롤의 모양을 주지 않고 색에 기대지 않는다.
  const detailBack = {
    label: messages.formatMessage('releaseNotes.detail.back'),
    onPress: goBack,
    testID: DETAIL_BACK_TEST_ID,
  };
  const surfaceNames = (surfaces: readonly ReleaseNoteSurface[], separator = ', ') =>
    surfaces.map(surface => messages.formatMessage(SURFACE_KEY[surface])).join(separator);
  return (
    <View
      style={styles.root}
      onAccessibilityEscape={goBack}
      testID="release-notes-detail">
      <Screen>
        <PageHeader
          title={versionLabel}
          back={detailBack}
          titleTestID="release-notes-detail-title"
          testID="release-notes-detail-header"
        />
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
          ]}>
          <View style={styles.intro}>
            <Text style={styles.date}>
              {messages.formatMessage('releaseNotes.version.releasedOn', {
                date: note.releasedOn,
              })}
            </Text>
            <Sentence style={styles.summary}>{note.summary[noteLocale]}</Sentence>
          </View>
          {note.items.map(item => (
            <GroupCard
              key={item.id}
              label={item.copy[noteLocale].title}
              testID={itemTestId(item.id)}>
              <View style={styles.itemBody}>
                <Text
                  accessibilityLabel={[
                    messages.formatMessage('releaseNotes.surface.label'),
                    surfaceNames(item.surfaces),
                  ].join(': ')}
                  style={styles.surfaces}
                  testID={surfacesTestId(item.id)}>
                  {surfaceNames(item.surfaces, ' · ')}
                </Text>
                <View style={styles.block}>
                  <Text accessibilityRole="header" style={styles.blockLabel}>
                    {messages.formatMessage('releaseNotes.detail.changed')}
                  </Text>
                  <Sentence style={styles.blockText}>
                    {item.copy[noteLocale].changed}
                  </Sentence>
                </View>
                <View style={styles.block}>
                  <Text accessibilityRole="header" style={styles.blockLabel}>
                    {messages.formatMessage('releaseNotes.detail.tryIt')}
                  </Text>
                  <Sentence style={styles.blockText}>
                    {item.copy[noteLocale].tryIt}
                  </Sentence>
                </View>
              </View>
            </GroupCard>
          ))}
        </ScrollView>
      </Screen>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    // 안쪽 장은 설정 페이지의 안쪽 장(`subPane`)과 같이 부모를 덮는다.
    pane: {...StyleSheet.absoluteFill, backgroundColor: color.bg},
    content: {paddingTop: space.md, paddingHorizontal: SAFE_GUTTER, gap: space.lg},
    intro: {gap: space.xs, fontSize: font.body, lineHeight: line.body, color: color.textMuted},
    date: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    summary: {fontSize: font.body, lineHeight: line.body, color: color.text},
    itemBody: {
      gap: space.md,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    surfaces: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    block: {gap: space.xs},
    blockLabel: {fontSize: font.label, lineHeight: line.label, fontWeight: '600', color: color.textMuted},
    blockText: {fontSize: font.body, lineHeight: line.body, color: color.text},
  });
