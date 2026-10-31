import {matchesExpressionContract} from '@momo/core/features/expressions/contracts';
import type {
  ExpressionDraft,
  ExpressionMetadata,
} from '@momo/core/features/expressions/types';
import React, {useRef, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {PrimaryButton, Sentence} from '../../design/atoms';
import {ChoiceRow, GroupCard, GroupLabel} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, space, type Palette} from '../../design/tokens';
import {Field, FieldLabel} from '../../shell/sheetForm';
import {loadPhoneEmojiCatalog} from '../emoji/catalog';
import {
  ExpressionChapter,
  LiveLine,
  PhotoPickRow,
  useSectionScroll,
} from './ExpressionChapter';
import {ExpressionDraftStep} from './ExpressionDraftStep';
import {useExpressions} from './ExpressionProvider';
import {
  pickAlbumPhoto,
  photoIssueOf,
  type PickedPhoto,
} from './photoPicker';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 가져오기 (#4891) — 내 그림이나 링크를 팀 이모지로 올린다. 웹 `ExpressionUploadForm` 과 같은 약속이다:
//   · 한도·이름 규칙: 코어 계약(`Metadata`·`ImportRequest`)과 5 MiB·네 가지 형식(`photoIssueOf`), 표준 이모지와 겹치는
//     이름은 막는다.
//   · 서버 경로: 링크는 `POST …/expressions/import`, 앨범 그림은 `POST …/expressions/uploads`(multipart). 둘 다 미리보기
//     초안을 받고, 사람이 본 뒤에야 `POST …/expressions` 로 등록한다(`ExpressionDraftStep`).
//   · 링크를 적으면 앨범 고르기는 잠긴다(웹의 파일 칸 `disabled` 와 같다).
// =============================================================================

type Face = 'none' | 'self' | 'other';

export function ExpressionImportForm({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const {store, state} = useExpressions();
  const offline = state === 'offline';
  const scroll = useSectionScroll();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tags, setTags] = useState('');
  const [face, setFace] = useState<Face>('none');
  const [url, setUrl] = useState('');
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [draft, setDraft] = useState<ExpressionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  async function pick() {
    if (busy || lock.current) return;
    lock.current = true;
    try {
      const outcome = await pickAlbumPhoto();
      if (outcome.kind === 'picked') {
        setPhoto(outcome.photo);
        setError(null);
      } else if (outcome.kind === 'denied') {
        setError(formatMessage('expressions.import.photoDenied'));
      } else if (outcome.kind === 'unavailable') {
        setError(formatMessage('expressions.import.photoUnavailable'));
      }
    } finally {
      lock.current = false;
    }
  }

  async function prepare() {
    if (!store || busy || lock.current || offline) return;
    const metadata: ExpressionMetadata = {
      name,
      displayName,
      tags: tags
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean),
      subjectMemberId: face === 'self' ? store.memberId : null,
    };
    if (face === 'other') {
      setError(formatMessage('expressions.import.faceOtherIssue'));
      return;
    }
    if (!matchesExpressionContract('Metadata', metadata)) {
      setError(formatMessage('expressions.import.metadataIssue'));
      return;
    }
    if (!url && (!photo || photoIssueOf(photo) !== null)) {
      setError(formatMessage('expressions.import.fileIssue'));
      return;
    }
    if (url && !matchesExpressionContract('ImportRequest', {...metadata, url})) {
      setError(formatMessage('expressions.import.urlIssue'));
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const standard = await loadPhoneEmojiCatalog();
      if (standard.some(entry => entry.shortcodes.includes(name))) {
        setError(formatMessage('expressions.import.nameTaken'));
        return;
      }
      const request = url
        ? {
            method: 'POST' as const,
            path: `${store.root}/expressions/import`,
            body: {...metadata, url},
          }
        : {
            method: 'POST' as const,
            path: `${store.root}/expressions/uploads`,
            body: metadata,
            file: {uri: photo!.uri, name: photo!.name, mime: photo!.mime},
          };
      setDraft(await store.draft(request));
    } catch {
      setError(formatMessage('expressions.import.prepareFailed'));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const faces: {id: Face; label: string}[] = [
    {id: 'none', label: formatMessage('expressions.import.faceNone')},
    {id: 'self', label: formatMessage('expressions.import.faceSelf')},
    {id: 'other', label: formatMessage('expressions.import.faceOther')},
  ];
  const title = formatMessage('expressions.add.import');
  return (
    <ExpressionChapter
      title={title}
      onBack={onBack}
      scrollRef={scroll.ref}
      testID="expression-import">
      {draft && store ? (
        <ExpressionDraftStep
          draft={draft}
          onReplace={setDraft}
          onApprove={async choice => {
            await store.mutate({
              method: 'POST',
              path: `${store.root}/expressions`,
              body: choice,
            });
            onDone();
          }}
          onAnother={() => setDraft(null)}
        />
      ) : (
        <>
          <View style={styles.section} onLayout={scroll.track('name')}>
            <FieldLabel label={formatMessage('expressions.import.name')} />
            <Field
              accessibilityLabel={formatMessage('expressions.import.name')}
              value={name}
              onChangeText={setName}
              onFocus={() => scroll.reveal('name')}
              placeholder={formatMessage('expressions.import.namePlaceholder')}
              maxLength={30}
              autoCapitalize="none"
              autoCorrect={false}
              testID="expression-import-name"
            />
          </View>
          <View style={styles.section} onLayout={scroll.track('displayName')}>
            <FieldLabel label={formatMessage('expressions.import.displayName')} />
            <Field
              accessibilityLabel={formatMessage('expressions.import.displayName')}
              value={displayName}
              onChangeText={setDisplayName}
              onFocus={() => scroll.reveal('displayName')}
              placeholder={formatMessage(
                'expressions.import.displayNamePlaceholder',
              )}
              maxLength={40}
              testID="expression-import-display-name"
            />
          </View>
          <View style={styles.section} onLayout={scroll.track('tags')}>
            <FieldLabel label={formatMessage('expressions.import.tags')} />
            <Field
              accessibilityLabel={formatMessage('expressions.import.tags')}
              value={tags}
              onChangeText={setTags}
              onFocus={() => scroll.reveal('tags')}
              placeholder={formatMessage('expressions.import.tagsPlaceholder')}
              testID="expression-import-tags"
            />
          </View>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={formatMessage('expressions.import.face')}
            style={styles.section}>
            <GroupLabel>{formatMessage('expressions.import.face')}</GroupLabel>
            <GroupCard>
              {faces.map(item => (
                <ChoiceRow
                  key={item.id}
                  title={item.label}
                  selected={face === item.id}
                  onPress={() => setFace(item.id)}
                  testID={`expression-import-face-${item.id}`}
                />
              ))}
            </GroupCard>
          </View>
          <Sentence style={styles.note}>
            {formatMessage('expressions.import.fixedNote')}
          </Sentence>
          <View style={styles.section} onLayout={scroll.track('url')}>
            <FieldLabel label={formatMessage('expressions.import.url')} />
            <Field
              accessibilityLabel={formatMessage('expressions.import.url')}
              value={url}
              onChangeText={setUrl}
              onFocus={() => scroll.reveal('url')}
              placeholder={formatMessage('expressions.import.urlPlaceholder')}
              keyboardType="url"
              textContentType="URL"
              autoCapitalize="none"
              autoCorrect={false}
              testID="expression-import-url"
            />
          </View>
          <View style={styles.section}>
            <FieldLabel label={formatMessage('expressions.import.photo')} />
            <PhotoPickRow
              photo={photo}
              disabled={url !== '' || busy}
              pickLabel={formatMessage('expressions.import.photoPick')}
              changeLabel={formatMessage('expressions.import.photoChange')}
              previewLabel={
                photo
                  ? formatMessage('expressions.import.photoPicked', {
                      name: photo.name,
                    })
                  : ''
              }
              onPick={() => void pick()}
              testID="expression-import-photo"
            />
          </View>
          {offline ? (
            <LiveLine text={formatMessage('expressions.import.offline')} />
          ) : null}
          <LiveLine
            text={error}
            tone="danger"
            testID="expression-import-error"
          />
          <PrimaryButton
            label={formatMessage('expressions.import.prepare')}
            busyLabel={formatMessage('expressions.import.preparing')}
            busy={busy}
            disabled={offline}
            onPress={() => void prepare()}
            testID="expression-import-submit"
          />
        </>
      )}
    </ExpressionChapter>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    section: {gap: space.xs},
    note: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
  });
