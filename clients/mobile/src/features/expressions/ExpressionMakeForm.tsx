import {rosterPaused} from '@momo/core/features/agents/agentOps';
import {
  MAKE_DEFAULT_SIZE,
  MAKE_NOTE_MAX,
  MAKE_PRESET_MAX,
  MOTION_PRESETS,
  STILL_MOTION,
  buildMakeRequest,
  checkMakeSelection,
  fitsStillInput,
  makeNoteLength,
  toggleMotionChoice,
  type MakeIssue,
  type MotionChoice,
  type MotionPick,
} from '@momo/core/features/expressions/make';
import {fetchRoster, type Channel, type RosterMember} from '@momo/core/lib/api';
import React, {useEffect, useRef, useState} from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  OutlineButton,
  PrimaryButton,
  STACK_PILL_SCALE,
  Sentence,
} from '../../design/atoms';
import {usePageSheetAction} from '../../design/PageSheet';
import {SHEET_ICON_SIZE, SHEET_ICONS} from '../../design/icons';
import {ChoiceRow, GroupCard, GroupLabel} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  space,
  type Palette,
} from '../../design/tokens';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {SheetNotice, TextArea} from '../../shell/sheetForm';
import type {UploadHandle} from '../attachments/uploadTransport';
import {
  ExpressionChapter,
  LiveLine,
  PhotoPickRow,
  useSectionScroll,
} from './ExpressionChapter';
import {ExpressionMakePreview} from './ExpressionMakePreview';
import {useExpressions} from './ExpressionProvider';
import {
  MakeStepError,
  makeFailureKey,
  resumeAttempt,
  runMakeAttempt,
  type MakeAttempt,
  type MakeStep,
} from './makeFlow';
import {
  pickAlbumPhoto,
  photoIssueOf,
  type PickedPhoto,
} from './photoPicker';
import {
  useExpressionMessages,
  type PlainMessageKey,
} from './useExpressionMessages';

// =============================================================================
// AI와 만들기 (#4891) — 웹 `ExpressionMakeForm` 과 같은 약속이다.
//
// 사람이 원본 사진·움직임·만들 에이전트·메모를 고르면, 그 에이전트와의 DM 에 사진을 첨부한 요청 한 통이 나간다. 만드는 일은
// 에이전트가, 움직임을 입히는 일은 서버 조립이 하고 결과는 그 DM 에 승인 카드로 온다(카드 화면은 이 양식 밖이다).
//
// **폰이 새로 정하는 규칙이 없다.** 움직임 칩(이름·설명·고르기 규칙)·요청 본문·원본 사진 한도는 코어 `make.ts` 가
// 말한 그대로고, 보내는 순서와 이어 가기 표는 웹과 같은 `makeFlow.ts` 다. 사진으로 만드는 새 길(원본 사진 → 이모티콘)은
// #4931 몫이라 여기서 열지 않는다 — 웹 「AI와 만들기」가 지금 하는 것까지만 폰에 맞췄다.
// =============================================================================

type PhotoProblem = 'empty' | 'type' | 'size' | 'dimensions';

const PHOTO_KEYS: Record<PhotoProblem | 'missing', PlainMessageKey> = {
  missing: 'expressions.make.photoMissing',
  empty: 'expressions.make.photoEmpty',
  type: 'expressions.make.photoType',
  size: 'expressions.make.photoSize',
  dimensions: 'expressions.make.photoDimensions',
};

const STEP_KEYS: Record<MakeStep, PlainMessageKey> = {
  dm: 'expressions.make.stepDm',
  upload: 'expressions.make.stepUpload',
  send: 'expressions.make.stepSend',
};

type RosterState =
  | {kind: 'loading'}
  | {kind: 'error'}
  | {kind: 'ready'; agents: RosterMember[]};
type Phase =
  | {kind: 'idle'}
  | {kind: 'busy'; step: MakeStep}
  | {kind: 'failed'; key: PlainMessageKey}
  | {kind: 'sent'; channel: Channel};
interface Invalid {
  photo?: PlainMessageKey;
  motion?: MakeIssue;
  agent?: PlainMessageKey;
  note?: MakeIssue;
}

export function ExpressionMakeForm({
  onBack,
  onDone,
  onImport,
  onOpenConversation,
}: {
  onBack: () => void;
  /** 요청을 보낸 뒤 목록으로 돌아간다(대화로 갈 길이 없을 때). */
  onDone: () => void;
  /** 에이전트가 없을 때의 다른 길 — 가져오기. */
  onImport: () => void;
  /** 요청을 보낸 뒤 그 DM 으로 간다. 호스트가 줄 때만 서고, 시트를 먼저 내린 뒤 부른다. */
  onOpenConversation?: (channel: Channel) => void;
}): React.JSX.Element {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const {store, state} = useExpressions();
  const offline = state === 'offline';
  const reduceMotion = useReduceMotion();
  const {fontScale} = useWindowDimensions();
  const afterClose = usePageSheetAction();
  const scroll = useSectionScroll();
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [photoProblem, setPhotoProblem] = useState<PhotoProblem | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [replays, setReplays] = useState<Record<string, number>>({});
  const [pick, setPick] = useState<MotionPick>({presets: [], still: false});
  const [motionIssue, setMotionIssue] = useState<MakeIssue | null>(null);
  const [agentId, setAgentId] = useState('');
  const [note, setNote] = useState('');
  const [roster, setRoster] = useState<RosterState>({kind: 'loading'});
  const [rosterTry, setRosterTry] = useState(0);
  const [invalid, setInvalid] = useState<Invalid>({});
  const [phase, setPhase] = useState<Phase>({kind: 'idle'});
  const lock = useRef(false);
  const alive = useRef(true);
  const attempt = useRef<MakeAttempt | null>(null);
  const upload = useRef<UploadHandle | null>(null);
  const landed = useRef(false);
  const busy = phase.kind === 'busy';
  const sent = phase.kind === 'sent';
  const locked = busy || sent;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      upload.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!store) return;
    let live = true;
    setRoster({kind: 'loading'});
    void fetchRoster(store.workspaceId).then(
      members => {
        if (!live) return;
        const agents = members.filter(
          member => member.kind === 'agent' && member.status === 'active',
        );
        setRoster({kind: 'ready', agents});
        // 하나뿐이면 미리 골라 둔다. 여럿이면 사람이 고른다.
        setAgentId(current =>
          agents.some(agent => agent.id === current)
            ? current
            : agents.length === 1
            ? agents[0].id
            : '',
        );
      },
      () => {
        if (live) setRoster({kind: 'error'});
      },
    );
    return () => {
      live = false;
    };
  }, [store, rosterTry]);

  // 보낸 뒤: 호스트가 대화로 갈 길을 주면 시트를 내리고 그 DM 으로 간다(웹은 고르개를 닫고 이동한다).
  useEffect(() => {
    if (phase.kind !== 'sent' || !onOpenConversation || landed.current) return;
    landed.current = true;
    const {channel} = phase;
    afterClose(() => onOpenConversation(channel));
  }, [phase, onOpenConversation, afterClose]);

  if (!store) return <View />;
  const agents = roster.kind === 'ready' ? roster.agents : [];
  // 불러오는 중이거나 불러오지 못했거나 비어 있으면 고를 에이전트가 없다. 보내기는 그 셋 모두에서 잠긴다.
  const noAgents = agents.length === 0;
  const gated = roster.kind === 'error' || (roster.kind === 'ready' && noAgents);
  const noteCount = makeNoteLength(note);
  const clear = (key: keyof Invalid) =>
    setInvalid(current =>
      current[key] === undefined ? current : {...current, [key]: undefined},
    );

  function issueLine(issue: MakeIssue): string {
    switch (issue) {
      case 'motion_missing':
        return formatMessage('expressions.make.motionMissing');
      case 'presets_unknown':
        return formatMessage('expressions.make.motionUnknown');
      case 'presets_duplicate':
        return formatMessage('expressions.make.motionDuplicate');
      case 'presets_too_many':
        return formatMessage('expressions.make.motionTooMany', {
          max: MAKE_PRESET_MAX,
        });
      case 'still_mixed':
        return formatMessage('expressions.make.motionStillMixed');
      case 'note_too_long':
        return formatMessage('expressions.make.noteTooLong', {
          max: MAKE_NOTE_MAX,
        });
      case 'size_invalid':
        return formatMessage('expressions.make.sizeInvalid');
    }
  }

  async function choosePhoto() {
    if (locked || lock.current) return;
    lock.current = true;
    try {
      const outcome = await pickAlbumPhoto();
      if (outcome.kind === 'cancelled') return;
      setPhotoProblem(null);
      clear('photo');
      if (outcome.kind === 'denied') {
        setInvalid(current => ({
          ...current,
          photo: 'expressions.make.photoDenied',
        }));
        return;
      }
      if (outcome.kind === 'unavailable') {
        setInvalid(current => ({
          ...current,
          photo: 'expressions.make.photoUnavailable',
        }));
        return;
      }
      const {photo: picked} = outcome;
      const problem: PhotoProblem | null =
        photoIssueOf(picked) ??
        (picked.width > 0 &&
        picked.height > 0 &&
        !fitsStillInput(picked.width, picked.height)
          ? 'dimensions'
          : null);
      if (problem !== null) {
        setPhoto(null);
        setPhotoProblem(problem);
        return;
      }
      setPhoto(picked);
      setPhotoVersion(value => value + 1);
    } finally {
      lock.current = false;
    }
  }

  function press(choice: MotionChoice) {
    // 누르면 그 칸의 미리보기가 다시 재생된다(고르든 막히든).
    setReplays(current => ({...current, [choice]: (current[choice] ?? 0) + 1}));
    const result = toggleMotionChoice(pick, choice);
    if (!result.ok) {
      setMotionIssue(result.issue);
      return;
    }
    setPick(result.pick);
    setMotionIssue(null);
    clear('motion');
  }

  /** 막힌 곳이 있으면 줄을 띄우고 첫 칸이 보이게 스크롤한다. */
  function validate(): boolean {
    const problems: Invalid = {};
    if (photo === null) {
      problems.photo = PHOTO_KEYS[photoProblem ?? 'missing'];
    }
    const check = checkMakeSelection({
      presets: pick.presets,
      still: pick.still,
      note,
      size: MAKE_DEFAULT_SIZE,
    });
    if (!check.ok) {
      const issues = check.issues.filter(issue => issue !== 'note_too_long');
      if (issues.length > 0) problems.motion = issues[0];
      if (check.issues.includes('note_too_long')) {
        problems.note = 'note_too_long';
      }
    }
    if (!agents.some(agent => agent.id === agentId)) {
      problems.agent = 'expressions.make.agentMissing';
    }
    setInvalid(problems);
    const first = (['photo', 'motion', 'agent', 'note'] as const).find(
      key => problems[key] !== undefined,
    );
    if (first) scroll.reveal(first);
    return first === undefined;
  }

  async function submit() {
    if (!store || lock.current || locked || offline) return;
    if (!validate() || photo === null) return;
    lock.current = true;
    const body = buildMakeRequest({
      presets: pick.presets,
      still: pick.still,
      note,
      size: MAKE_DEFAULT_SIZE,
    });
    const current = resumeAttempt(attempt.current, {agentId, photo, body});
    attempt.current = current;
    setPhase({
      kind: 'busy',
      step:
        current.channel === undefined
          ? 'dm'
          : current.attachmentId === undefined
          ? 'upload'
          : 'send',
    });
    try {
      const outcome = await runMakeAttempt(store.workspaceId, current, {
        step: step => {
          if (alive.current) setPhase({kind: 'busy', step});
        },
        uploading: handle => {
          upload.current = handle;
        },
        cancelled: () => !alive.current,
      });
      if (outcome === 'cancelled' || !alive.current) return;
      setPhase({kind: 'sent', channel: outcome.channel});
    } catch (error) {
      if (!alive.current) return;
      const step = error instanceof MakeStepError ? error.step : 'send';
      setPhase({
        kind: 'failed',
        key: makeFailureKey(
          step,
          error instanceof MakeStepError ? error.cause : error,
        ),
      });
    } finally {
      lock.current = false;
    }
  }

  const chips: {id: MotionChoice; label: string; description: string}[] = [
    ...MOTION_PRESETS.map(entry => ({
      id: entry.id as MotionChoice,
      label: entry.label,
      description: entry.description,
    })),
    {
      id: STILL_MOTION.id,
      label: STILL_MOTION.label,
      description: STILL_MOTION.description,
    },
  ];
  const stacked = fontScale >= STACK_PILL_SCALE;
  const photoKey =
    invalid.photo ?? (photoProblem !== null ? PHOTO_KEYS[photoProblem] : null);
  return (
    <ExpressionChapter
      title={formatMessage('expressions.add.make')}
      onBack={onBack}
      scrollRef={scroll.ref}
      testID="expression-make">
      <Sentence style={styles.hint}>
        {formatMessage('expressions.make.intro')}
      </Sentence>
      {roster.kind === 'error' ? (
        <View style={styles.block} testID="expression-make-roster-error">
          <LiveLine
            text={formatMessage('expressions.make.rosterFailed')}
            tone="danger"
          />
          <OutlineButton
            label={formatMessage('expressions.make.retry')}
            onPress={() => setRosterTry(value => value + 1)}
            testID="expression-make-roster-retry"
          />
        </View>
      ) : null}
      {roster.kind === 'ready' && noAgents ? (
        <View style={styles.block} testID="expression-make-empty">
          <SheetNotice
            headline={formatMessage('expressions.make.noAgents')}
            detail={formatMessage('expressions.make.noAgentsDetail')}
          />
          <OutlineButton
            label={formatMessage('expressions.add.import')}
            onPress={onImport}
            testID="expression-make-empty-import"
          />
        </View>
      ) : null}
      {/* 막혀 있을 때는 지우지 않고 가린다: 고른 사진이 칸 안의 상태로 남아 다시 시도 뒤에도 어긋나지 않는다. */}
      <View
        style={[styles.body, gated && styles.hidden]}
        pointerEvents={gated ? 'none' : 'auto'}
        accessibilityElementsHidden={gated}
        importantForAccessibility={gated ? 'no-hide-descendants' : 'auto'}
        testID="expression-make-body">
        <View style={styles.block} onLayout={scroll.track('photo')}>
          <GroupLabel>{formatMessage('expressions.make.photo')}</GroupLabel>
          <PhotoPickRow
            photo={photo}
            disabled={locked}
            pickLabel={formatMessage('expressions.make.photoPick')}
            changeLabel={formatMessage('expressions.make.photoChange')}
            previewLabel={formatMessage('expressions.make.photoPreview')}
            onPick={() => void choosePhoto()}
            testID="expression-make-photo"
          />
          <LiveLine
            text={photoKey ? formatMessage(photoKey) : null}
            tone="danger"
            testID="expression-make-photo-error"
          />
          <Sentence style={styles.hint}>
            {formatMessage('expressions.make.photoRule')}
          </Sentence>
        </View>

        <View
          style={styles.block}
          accessibilityRole="none"
          onLayout={scroll.track('motion')}>
          <GroupLabel>{formatMessage('expressions.make.motion')}</GroupLabel>
          <View style={styles.chips}>
            {chips.map(chip => {
              const selected =
                chip.id === STILL_MOTION.id
                  ? pick.still
                  : pick.presets.includes(chip.id as never);
              const wide = stacked || chip.id === STILL_MOTION.id;
              return (
                <Pressable
                  key={chip.id}
                  accessibilityRole="checkbox"
                  accessibilityLabel={formatMessage('expressions.make.chipLabel', {
                    label: chip.label,
                    description: chip.description,
                  })}
                  accessibilityState={{checked: selected, disabled: locked}}
                  disabled={locked}
                  onPress={() => press(chip.id)}
                  style={({pressed}) => [
                    styles.chip,
                    wide ? styles.chipWide : styles.chipHalf,
                    selected && styles.chipSelected,
                    pressed && !locked && styles.chipPressed,
                    locked && styles.chipOff,
                  ]}
                  testID={`expression-make-chip-${chip.id}`}>
                  <ExpressionMakePreview
                    motion={chip.id}
                    uri={photo?.uri ?? null}
                    playKey={`${photoVersion}:${replays[chip.id] ?? 0}`}
                    reduce={reduceMotion}
                    testID={`expression-make-preview-${chip.id}`}
                  />
                  <View style={styles.chipText}>
                    <Text style={styles.chipLabel}>{chip.label}</Text>
                    {/* 설명은 문장이다 — 어절 단위로 줄바꿈한다(맨 `Text` 는 「흔들려 / 요」·「두근 / 거려요」로 끊었다, #5065 M1). 같은 파일의 안내 줄은 이미 `Sentence` 다. */}
                    <Sentence style={styles.chipDescription}>
                      {chip.description}
                    </Sentence>
                  </View>
                  {selected ? (
                    <Image
                      source={SHEET_ICONS.check}
                      style={styles.chipCheck}
                      importantForAccessibility="no"
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          <Sentence style={styles.hint}>
            {formatMessage('expressions.make.motionHint', {max: MAKE_PRESET_MAX})}
          </Sentence>
          <LiveLine
            text={
              motionIssue ?? invalid.motion
                ? issueLine((motionIssue ?? invalid.motion) as MakeIssue)
                : null
            }
            tone="danger"
            testID="expression-make-motion-status"
          />
        </View>

        <View style={styles.block} onLayout={scroll.track('agent')}>
          <GroupLabel>{formatMessage('expressions.make.agent')}</GroupLabel>
          {roster.kind === 'loading' ? (
            <Sentence style={styles.hint}>
              {formatMessage('expressions.make.agentLoading')}
            </Sentence>
          ) : null}
          {roster.kind === 'ready' && !noAgents ? (
            <>
              <View accessibilityRole="radiogroup">
                <GroupCard>
                  {agents.map(agent => (
                    <ChoiceRow
                      key={agent.id}
                      title={
                        rosterPaused(agent) === true
                          ? formatMessage('expressions.make.agentPaused', {
                              name: agent.displayName,
                            })
                          : agent.displayName
                      }
                      selected={agentId === agent.id}
                      disabled={locked}
                      onPress={() => {
                        setAgentId(agent.id);
                        clear('agent');
                      }}
                      testID={`expression-make-agent-${agent.id}`}
                    />
                  ))}
                </GroupCard>
              </View>
              <Sentence style={styles.hint}>
                {formatMessage('expressions.make.agentHint')}
              </Sentence>
            </>
          ) : null}
          <LiveLine
            text={invalid.agent ? formatMessage(invalid.agent) : null}
            tone="danger"
            testID="expression-make-agent-error"
          />
        </View>

        <View style={styles.block} onLayout={scroll.track('note')}>
          <GroupLabel>{formatMessage('expressions.make.note')}</GroupLabel>
          <TextArea
            accessibilityLabel={formatMessage('expressions.make.note')}
            value={note}
            editable={!locked}
            placeholder={formatMessage('expressions.make.notePlaceholder')}
            onChangeText={value => {
              setNote(value);
              clear('note');
            }}
            onFocus={() => scroll.reveal('note')}
            invalid={invalid.note !== undefined || noteCount > MAKE_NOTE_MAX}
            testID="expression-make-note"
          />
          <Text
            style={[styles.count, noteCount > MAKE_NOTE_MAX && styles.countOver]}
            testID="expression-make-note-count">
            {formatMessage('expressions.make.noteCount', {
              count: noteCount,
              max: MAKE_NOTE_MAX,
            })}
          </Text>
          <LiveLine
            text={invalid.note ? issueLine(invalid.note) : null}
            tone="danger"
          />
        </View>
      </View>

      {!gated ? (
        <View style={styles.footer} testID="expression-make-footer">
          {offline ? (
            <LiveLine text={formatMessage('expressions.make.offline')} />
          ) : null}
          {phase.kind === 'busy' ? (
            <LiveLine
              text={formatMessage(STEP_KEYS[phase.step])}
              testID="expression-make-status"
            />
          ) : null}
          {phase.kind === 'failed' ? (
            <LiveLine
              text={formatMessage(phase.key)}
              tone="danger"
              testID="expression-make-error"
            />
          ) : null}
          {sent ? (
            <LiveLine
              text={formatMessage('expressions.make.sent')}
              testID="expression-make-sent"
            />
          ) : null}
          {sent ? (
            onOpenConversation ? null : (
              <PrimaryButton
                label={formatMessage('expressions.make.done')}
                onPress={onDone}
                testID="expression-make-done"
              />
            )
          ) : (
            <PrimaryButton
              label={
                phase.kind === 'failed'
                  ? formatMessage('expressions.make.retry')
                  : formatMessage('expressions.make.submit')
              }
              busyLabel={formatMessage('expressions.make.sending')}
              busy={busy}
              disabled={offline || noAgents}
              onPress={() => void submit()}
              testID="expression-make-submit"
            />
          )}
        </View>
      ) : null}
    </ExpressionChapter>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    body: {gap: space.lg},
    hidden: {display: 'none'},
    block: {gap: space.sm},
    hint: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    chips: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      padding: space.sm,
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.textFaint,
    },
    chipHalf: {width: '48%'},
    chipWide: {width: '100%'},
    chipSelected: {backgroundColor: color.accentSurface, borderColor: color.accent},
    chipPressed: {backgroundColor: color.surfacePressed},
    chipOff: {opacity: 0.5},
    chipText: {flex: 1, gap: space.xs},
    chipLabel: {
      fontSize: font.body,
      lineHeight: line.body,
      fontWeight: '600',
      color: color.text,
    },
    chipDescription: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    chipCheck: {
      width: SHEET_ICON_SIZE.check,
      height: SHEET_ICON_SIZE.check,
      tintColor: color.accent,
    },
    count: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    countOver: {color: color.dangerText},
    footer: {gap: space.sm},
  });
