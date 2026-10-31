import {
  itemsForSurface,
  noteForPhoneBuild,
  PHONE_SURFACE,
  shouldAnnounceNote,
  type ReleaseNote,
} from '@momo/core/features/releaseNotes/model';
import {RELEASE_NOTES} from '@momo/core/features/releaseNotes/notes';
import {nativeBuildVersion} from 'expo-application';
import React, {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {Sentence} from '../../design/atoms';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {GroupCard, ListRow, SheetScroll} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, SHEET, space, type Palette} from '../../design/tokens';
import {usePushPrompt} from '../../push/PushProvider';
import {
  isNotifyPrimerHeld,
  qrKeyEnrollmentArmed,
  subscribeNotifyPrimerHeld,
} from '../onboarding/phoneFlow';
import {markReleaseNoteSeen, useLastSeenReleaseNote} from './seenStore';
import {useReleaseNotesMessages} from './useReleaseNotesMessages';

// =============================================================================
// 업데이트 뒤 처음 열 때 한 번 올라오는 작은 「업데이트 소식」 시트 (#4937, owner 10-31).
//
// 시트다(`docs/design-system/phone-sheets.md` §1): 지금 화면을 두고 하는 짧은 일, 행동 하나. 작게 둔다: 제목, 버전과
// 공개일, 한 문장 요약, **이 화면(폰)에서 보이는** 변화의 제목 몇 줄, 그리고 「자세히 보기」 한 줄. 항목의 바뀐 점·써
// 보는 방법은 설정의 버전별 내용에 있다. 닫는 길은 공용 시트의 것 그대로다(오른쪽 위 원형 X · 스크림 · 끌어내리기 ·
// VoiceOver escape).
//
// 「자세히 보기」는 **시트를 먼저 내리고** 설정 페이지를 연다(`closesSheet`, §1 규칙 2: Modal 위에 화면을 쌓지 않는다).
// 닫는 길이 하나(`onClose`)라서 「봤다」 기록은 거기서만 한다: X 로 닫든 「자세히 보기」로 닫든 같은 소식은 다시 안 뜬다.
// =============================================================================

/** 작은 시트에 제목을 몇 줄까지 보일까. 나머지는 「그 밖에 N가지」로 접는다. */
const SHOWN_TITLES = 4;

const SHEET_TEST_ID = 'release-notes-sheet';

/**
 * 알림 미리 안내(M3)가 서 있거나 권한을 읽는 중인 게이트 이름. 이름을 키로 둔 표인 것은 직접 문구 장부가 낱말 하나짜리
 * 문자열을 문구로 세기 때문이다(키 자리의 이름은 세지 않는다). `DeviceKeyLinkGate` 가 같은 두 이름을 기다린다.
 */
const PRIMER_GATES: Readonly<Record<string, true>> = {ask: true, checking: true};

export function ReleaseNotesSheet({
  note,
  onClose,
  onOpenDetails,
}: {
  note: ReleaseNote;
  onClose: () => void;
  onOpenDetails: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {messages, noteLocale} = useReleaseNotesMessages();
  const items = itemsForSurface(note, PHONE_SURFACE);
  const shown = items.slice(0, SHOWN_TITLES);
  const hidden = items.length - shown.length;
  const title = messages.formatMessage('releaseNotes.popup.title');
  const closeLabel = messages.formatMessage('releaseNotes.popup.close');
  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel={title}
      scrimLabel={closeLabel}
      scrimTestID="release-notes-sheet-backdrop"
      testID={SHEET_TEST_ID}>
      <SheetHeader
        title={title}
        closeLabel={closeLabel}
        closeTestID="release-notes-close"
      />
      <SheetScroll>
        <GroupCard>
          <View style={styles.note}>
            <Text style={styles.meta} testID="release-notes-sheet-version">
              {messages.formatMessage('releaseNotes.version.label', {
                version: note.version,
              })}
              {' · '}
              {note.releasedOn}
            </Text>
            <Sentence style={styles.summary}>{note.summary[noteLocale]}</Sentence>
            {shown.length > 0 ? (
              <View style={styles.titles} testID="release-notes-sheet-titles">
                {shown.map(item => (
                  <Sentence key={item.id} style={styles.itemTitle}>
                    {item.copy[noteLocale].title}
                  </Sentence>
                ))}
                {hidden > 0 ? (
                  <Sentence style={styles.more}>
                    {messages.formatMessage('releaseNotes.popup.more', {
                      count: hidden,
                    })}
                  </Sentence>
                ) : null}
              </View>
            ) : null}
          </View>
        </GroupCard>
        <GroupCard>
          <ListRow
            title={messages.formatMessage('releaseNotes.action.details')}
            accessory="chevron"
            closesSheet
            onPress={onOpenDetails}
            testID="release-notes-details"
          />
        </GroupCard>
      </SheetScroll>
    </PageSheet>
  );
}

/**
 * 업데이트 뒤 처음 열 때 소식 시트를 한 번 올린다. 셸이 **한가할 때**(홈 탭이고 다른 층·시트가 없을 때)만 올리고, 한가하지
 * 않은 동안은 기다린다: 알림을 눌러 대화로 바로 들어온 사람의 화면을 가로채지 않고, 다른 Modal 과 겹치지 않는다. 한 번
 * 올린 뒤에는 이 마운트 안에서 다시 판정하지 않는다. 브라우저 같은 「앱 버전 없음」은 없다: 빌드 번호를 못 읽으면(개발
 * 빌드) 어느 소식도 붙지 않아 아무것도 하지 않는다.
 */
export function ReleaseNotesLaunchHost({
  idle,
  onOpenDetails,
  notes = RELEASE_NOTES,
  build = nativeBuildVersion,
}: {
  idle: boolean;
  onOpenDetails: () => void;
  notes?: readonly ReleaseNote[];
  build?: string | null;
}): React.JSX.Element | null {
  const lastSeen = useLastSeenReleaseNote();
  const note = useMemo(() => noteForPhoneBuild(notes, build), [notes, build]);
  const [shown, setShown] = useState<ReleaseNote | null>(null);
  const decided = useRef(false);
  // 첫 연결 흐름(M3 알림 미리 안내, QR 직후 기기 키 시트)은 Modal 이라 이 시트와 겹치면 한쪽이 서지 못한다. 그 흐름 중이면
  // 기다리고, QR 직후 기기 키 시트가 걸려 있던 실행(`qrKeyEnrollmentArmed`)에서는 이번 실행에 올리지 않는다: 새로 연결한
  // 폰은 업데이트가 아니라 처음이고, 같은 소식을 다음 실행에 한 번 본다(`DeviceKeyLinkGate` 와 같은 읽기).
  const {gate} = usePushPrompt();
  const primerHeld = useSyncExternalStore(
    subscribeNotifyPrimerHeld,
    isNotifyPrimerHeld,
    isNotifyPrimerHeld,
  );
  const [linkedJustNow] = useState(qrKeyEnrollmentArmed);
  const quiet = idle && !linkedJustNow && !primerHeld && PRIMER_GATES[gate] !== true;
  useEffect(() => {
    if (decided.current || !quiet || note === null || !shouldAnnounceNote(note, lastSeen)) return;
    decided.current = true;
    setShown(note);
  }, [quiet, note, lastSeen]);
  if (shown === null) return null;
  return (
    <ReleaseNotesSheet
      note={shown}
      onClose={() => {
        markReleaseNoteSeen(shown.version);
        setShown(null);
      }}
      onOpenDetails={onOpenDetails}
    />
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    note: {
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    meta: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    summary: {fontSize: font.body, lineHeight: line.body, color: color.text},
    titles: {gap: space.xs, paddingTop: space.xs},
    itemTitle: {fontSize: font.body, lineHeight: line.body, color: color.text},
    more: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
  });
