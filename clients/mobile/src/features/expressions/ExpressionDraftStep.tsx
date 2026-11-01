import {
  expressionChoice,
  expressionDraftCard,
} from '@momo/core/features/expressions/cards';
import type {
  ExpressionChoice,
  ExpressionDraft,
} from '@momo/core/features/expressions/types';
import React, {useEffect, useRef, useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {OutlineButton, PrimaryButton, Sentence} from '../../design/atoms';
import {GroupCard, ListRow} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  space,
  type Palette,
} from '../../design/tokens';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {LiveLine} from './ExpressionChapter';
import {useExpressions} from './ExpressionProvider';
import {pickAlbumPhoto, photoIssueOf} from './photoPicker';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 가져오기의 둘째 걸음: 받아 온 그림(초안)을 보고 팀 보관함에 등록한다 (#4891).
// 웹 `ExpressionDraftCard` 와 같은 약속이다:
//   · 등록 단추는 **지금 보이는 미리보기**(초안 개정·`large` 해시)를 본 뒤에만 켜진다 — 바뀐 그림을 못 보고 승인하지 않는다.
//   · 「권한이 있어요」 확인이 서야 한다. 사람 얼굴은 지정된 당사자만 승인한다는 말은 그 문장 안에 있다.
//   · 받지 못한 그림(`manual_upload_required`)의 사유 문장은 코어(`expressionDraftCard().line`)가 말한 그대로다.
//     폰이 사유를 다시 지어 말하지 않는다.
//   · 받지 못했으면 같은 초안에 직접 올릴 수 있다(`PUT …/expression-drafts/{id}/file`).
// =============================================================================

const PREVIEW_POINTS = 160;

export function ExpressionDraftStep({
  draft,
  onReplace,
  onApprove,
  onAnother,
  promptLabel,
  anotherLabel,
}: {
  draft: ExpressionDraft;
  onReplace: (draft: ExpressionDraft) => void;
  onApprove: (choice: ExpressionChoice) => Promise<void>;
  onAnother: () => void;
  /**
   * 사진으로 만든 그림(#4984)만 준다: 서버가 이 그림에 쓴 고정 문장 앞에 붙는 이름(「만든 방법:」). 주지 않으면 그 문장을
   * 보이지 않는다 — 가져온 그림에는 문장이 없고, 에이전트가 쓴 문장은 이 단계에서 보이지 않는다.
   */
  promptLabel?: string;
  /** 「다른 …」 단추의 낱말. 주지 않으면 가져오기 쪽 낱말이다. */
  anotherLabel?: string;
}): React.JSX.Element {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const {store, state} = useExpressions();
  const offline = state === 'offline';
  const reduceMotion = useReduceMotion();
  const [now, setNow] = useState(Date.now());
  const [viewed, setViewed] = useState<string | null>(null);
  const [rights, setRights] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{uri: string; pin: string} | null>(
    null,
  );
  const lock = useRef(false);
  const card = expressionDraftCard(draft, now);
  const choice = expressionChoice(draft, now);
  const pin = choice ? `${choice.draftId}:${choice.revision}:${choice.sha256}` : null;
  const blocked = working || offline;

  useEffect(() => {
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(2147483647, draft.expiresAtMs - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [draft.expiresAtMs]);

  // 미리보기는 임시 파일이다 — 초안이 바뀌거나 이 걸음이 끝나면 지운다.
  const shown = card.preview;
  useEffect(() => {
    setPreview(null);
    if (!store || !shown) return;
    let alive = true;
    let loaded: string | null = null;
    // 움직이는 그림은 동작 줄이기에서 정지 그림(썸네일)으로 본다.
    const variant =
      reduceMotion && shown.large.mime === 'image/gif' ? 'thumb' : 'large';
    void store.draftImage(draft, variant).then(uri => {
      if (!uri) return;
      if (!alive) {
        store.discardDraftImage(uri);
        return;
      }
      loaded = uri;
      if (pin) setPreview({uri, pin});
    });
    return () => {
      alive = false;
      if (loaded) store.discardDraftImage(loaded);
    };
  }, [store, draft, shown, pin, reduceMotion]);

  async function approve() {
    if (!choice || !pin || viewed !== pin || !rights || blocked || lock.current) {
      return;
    }
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      await onApprove(choice);
    } catch {
      setError(formatMessage('expressions.draft.approveFailed'));
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }

  async function replace() {
    if (!store || blocked || lock.current) return;
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      const outcome = await pickAlbumPhoto();
      if (outcome.kind === 'cancelled') return;
      if (outcome.kind === 'denied') {
        setError(formatMessage('expressions.import.photoDenied'));
        return;
      }
      if (outcome.kind === 'unavailable') {
        setError(formatMessage('expressions.import.photoUnavailable'));
        return;
      }
      const {photo} = outcome;
      if (photoIssueOf(photo) !== null) {
        setError(formatMessage('expressions.import.fileIssue'));
        return;
      }
      const next = await store.draft({
        method: 'PUT',
        path: `${store.root}/expression-drafts/${draft.draftId}/file`,
        file: {uri: photo.uri, name: photo.name, mime: photo.mime},
      });
      setViewed(null);
      setRights(false);
      onReplace(next);
    } catch {
      setError(formatMessage('expressions.draft.replaceFailed'));
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }

  const large = draft.media?.large;
  const ratio = large ? large.width / large.height : 1;
  const sourceHost = card.sourceLink ? hostOf(card.sourceLink) : null;
  return (
    <View style={styles.root} testID="expression-draft" accessibilityLabel={draft.displayName}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{draft.displayName}</Text>
        <Text style={styles.code}>{`:${draft.name}:`}</Text>
      </View>
      {draft.tags.length > 0 ? (
        <Text style={styles.meta}>{draft.tags.join(' · ')}</Text>
      ) : null}
      <LiveLine text={card.line} testID="expression-draft-line" />
      {sourceHost ? (
        <Text style={styles.meta} testID="expression-draft-source">
          {formatMessage('expressions.draft.source', {host: sourceHost})}
        </Text>
      ) : null}
      {promptLabel && draft.origin.prompt ? (
        <Sentence style={styles.meta} testID="expression-draft-prompt">
          {`${promptLabel} ${draft.origin.prompt}`}
        </Sentence>
      ) : null}
      {preview ? (
        <Image
          source={{uri: preview.uri}}
          resizeMode="contain"
          accessibilityLabel={formatMessage('expressions.draft.previewLabel', {
            name: draft.displayName,
          })}
          onLoad={() => setViewed(preview.pin)}
          style={[
            styles.preview,
            {
              width: PREVIEW_POINTS * Math.min(1, ratio),
              height: PREVIEW_POINTS / Math.max(1, ratio),
            },
          ]}
          testID="expression-draft-preview"
        />
      ) : null}
      {card.canApprove ? (
        <>
          <GroupCard>
            <ListRow
              title={formatMessage('expressions.draft.rights')}
              accessory="toggle"
              toggle={{value: rights, onValueChange: setRights}}
              disabled={blocked}
              testID="expression-draft-rights"
            />
          </GroupCard>
          <PrimaryButton
            label={formatMessage('expressions.draft.approve')}
            busyLabel={formatMessage('expressions.draft.approving')}
            busy={working}
            disabled={blocked || !rights || !pin || viewed !== pin}
            onPress={() => void approve()}
            testID="expression-draft-approve"
          />
          {viewed !== pin ? (
            <Sentence style={styles.meta}>
              {formatMessage('expressions.draft.waiting')}
            </Sentence>
          ) : null}
        </>
      ) : null}
      {card.canUpload ? (
        <PrimaryButton
          label={card.uploadLabel}
          busyLabel={formatMessage('expressions.draft.replacing')}
          busy={working}
          disabled={blocked}
          onPress={() => void replace()}
          testID="expression-draft-upload"
        />
      ) : null}
      {offline ? (
        <LiveLine text={formatMessage('expressions.import.offline')} />
      ) : null}
      <LiveLine text={error} tone="danger" testID="expression-draft-error" />
      <OutlineButton
        label={anotherLabel ?? formatMessage('expressions.draft.another')}
        onPress={onAnother}
        testID="expression-draft-another"
      />
    </View>
  );
}

function hostOf(link: string): string | null {
  try {
    return new URL(link).hostname;
  } catch {
    return null;
  }
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {gap: space.md},
    titleRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      flexWrap: 'wrap',
      gap: space.sm,
    },
    title: {
      fontSize: font.heading,
      lineHeight: line.heading,
      fontWeight: '600',
      color: color.text,
    },
    code: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    meta: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    preview: {
      alignSelf: 'center',
      borderRadius: ds2Radius.row,
      backgroundColor: color.surfaceMuted,
    },
  });
