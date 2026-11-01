import {
  PHOTO_BRANCHES,
  PHOTO_PROVIDERS,
  buildPhotoMetadata,
  expressionActivateRequest,
  isPhotoMetadata,
  photoDraftRequest,
  photoFailureOf,
  type PhotoBranch,
  type PhotoDraftResult,
  type PhotoFailure,
  type PhotoModel,
} from '@momo/core/features/expressions/photo';
import type {ExpressionMetadata} from '@momo/core/features/expressions/types';
import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';
import {
  LoadingState,
  OutlineButton,
  PrimaryButton,
  Sentence,
} from '../../design/atoms';
import {ChoiceRow, GroupCard, GroupLabel, ListRow} from '../../design/sheetParts';
import {usePalette, useStyles} from '../../design/theme';
import {font, line, space, type Palette} from '../../design/tokens';
import {withBackgroundTask} from '../../lib/backgroundTask';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {Field, FieldLabel, SheetNotice} from '../../shell/sheetForm';
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
  type PhotoPickOutcome,
  type PickedPhoto,
} from './photoPicker';
import {ExpressionHttpError} from './store';
import {
  useExpressionMessages,
  type PlainMessageKey,
} from './useExpressionMessages';

// =============================================================================
// 사진으로 만들기 (ADR-0218 §8 H9, #4941 · 폰 #4984) — 사진 한 장을 서버가 팀에 연결된 이미지 모델(OpenAI·Gemini)에
// 보내 「배경 지우기」나 「캐리커처」 그림을 받아 오고, 그 그림이 가져오기와 같은 초안 카드로 돌아온다. 웹
// `ExpressionPhotoForm` 과 같은 다섯 가지 약속이다:
//   1. 모델이 있는지 먼저 묻고, 없으면 만들지 않고 연결을 안내한다(등록은 가져오기로 늘 된다).
//   2. 사진이 어느 회사로 가는지 말하고 동의를 받는다 — 동의한 회사가 요청에 실린다.
//   3. 갈래(배경 지우기·캐리커처)와 이름·얼굴 선언을 받는다.
//   4. 한 번 보내고(최대 2분), 실패는 닫힌 코드에 맞는 한 줄로 말한다.
//   5. 서버가 만든 그림을 그대로 보여 주고 승인을 받는다.
//
// **폰이 새로 정하는 규칙이 없다.** 요청 본문·요청 시간(`PHOTO_REQUEST_TIMEOUT_MS`)·응답 검사·실패 코드 → 상황은 코어
// `photo.ts` 가, 문장은 사전(`expressions.photo.*`)이 말한 그대로다. 이 파일은 상황 → 사전 키 표만 가진다(웹 폼의 표와
// 같은 열세 줄 — 타입이 빠진 줄을 막는다). 문구와 상태 이름은 글자로 두지 않는다(직접 문구 장부): 사전 키와 숫자 상태를 쓴다.
//
// ## 폰이 정하는 것은 둘뿐이고 둘 다 「기다리기」에 대한 것이다
//   · **취소**: 기다리기만 그만둔다(요청을 멈추고 양식으로 돌아와 입력은 그대로). 서버는 이미 시작한 일을 끝까지 하고
//     끝난 그림을 초안으로 보관한다(ADR-0218 §8 H11) — 그래서 「멈췄다」고 말하지 않고 사전 문장이 그 사실을 말한다.
//     화면을 닫아도 같다(요청은 멈춘다).
//   · **앱을 나갈 때**: 요청이 도는 동안 iOS 의 추가 시간(`withBackgroundTask`)을 청해 두지만 모델이 쓰는 시간(최대 2분)을
//     덮지는 못한다. 시간이 끝나 연결이 끊긴 채 돌아오면 「연결이 끊겼어요」와 다시 만들기가 나온다. **자동으로 다시
//     보내지 않는다** — 모델 호출은 돈이라 같은 사진이 두 번 나가면 안 된다.
// =============================================================================

/** 양식이 있는 자리. 이름은 속성 이름이라 문구로 세지지 않는다(웹 폼과 같다). */
const Step = {idle: 0, busy: 1, failed: 2, made: 3} as const;
const Check = {loading: 0, error: 1, ready: 2} as const;
const Face = {none: 0, self: 1, other: 2} as const;

type ModelCheck =
  | {kind: typeof Check.loading}
  | {kind: typeof Check.error; failure: PhotoFailure}
  | {kind: typeof Check.ready; model: PhotoModel};
type Phase =
  | {kind: typeof Step.idle}
  | {kind: typeof Step.busy}
  | {kind: typeof Step.failed; failure: PhotoFailure}
  | {kind: typeof Step.made; result: PhotoDraftResult};
interface Invalid {
  photo?: string;
  consent?: string;
  fields?: string;
  face?: string;
}

/** 상황 → 사전 키. 상황이 늘면 이 표가 컴파일에서 막힌다. */
export const PHOTO_FAILURE_KEY = {
  unavailable: 'expressions.photo.errorUnavailable',
  changed: 'expressions.photo.errorChanged',
  refused: 'expressions.photo.errorRefused',
  failed: 'expressions.photo.errorFailed',
  timeout: 'expressions.photo.errorTimeout',
  busy: 'expressions.photo.errorBusy',
  quota: 'expressions.photo.errorQuota',
  role: 'expressions.photo.errorRole',
  name: 'expressions.photo.errorName',
  media: 'expressions.photo.errorMedia',
  too_large: 'expressions.photo.photoSize',
  offline: 'expressions.photo.errorOffline',
  generic: 'expressions.photo.errorGeneric',
} as const satisfies Record<PhotoFailure, PlainMessageKey>;

/** 서버가 배경에 한 일 → 한 줄. `null`(캐리커처)은 줄이 없다. */
export const PHOTO_CUTOUT_KEY = {
  model: 'expressions.photo.cutoutModel',
  erased: 'expressions.photo.cutoutErased',
  unchanged: 'expressions.photo.cutoutUnchanged',
} as const satisfies Record<string, PlainMessageKey>;

const BRANCH_COPY = {
  cutout: {
    label: 'expressions.photo.cutoutLabel',
    hint: 'expressions.photo.cutoutHint',
  },
  caricature: {
    label: 'expressions.photo.caricatureLabel',
    hint: 'expressions.photo.caricatureHint',
  },
} as const satisfies Record<
  PhotoBranch,
  {label: PlainMessageKey; hint: PlainMessageKey}
>;

const FACE_ROWS = [
  [Face.none, 'expressions.photo.faceNone'],
  [Face.self, 'expressions.photo.faceSelf'],
  [Face.other, 'expressions.photo.faceOther'],
] as const satisfies readonly (readonly [number, PlainMessageKey])[];

/** 서버가 내는 갈래만 고를 수 있다: 고른 갈래가 거기 없으면(모델이 바뀐 때) 첫 갈래가 고른 것이다. */
function offeredBranches(model: PhotoModel): PhotoBranch[] {
  return PHOTO_BRANCHES.filter(item => model.branches.includes(item));
}
function activeBranch(model: PhotoModel, chosen: PhotoBranch): PhotoBranch {
  const offered = offeredBranches(model);
  return offered.includes(chosen) ? chosen : offered[0];
}

/** 서버가 답한 상태·코드가 있으면 코어 판정으로, 없으면(시간 초과·연결 실패) 오프라인으로 말한다. */
function failureOf(error: unknown): PhotoFailure {
  if (error instanceof ExpressionHttpError) {
    return photoFailureOf(error.status, error.code);
  }
  return photoFailureOf(undefined, undefined);
}

/** 개발·캡처용 자리: 시스템 사진 창은 캡처 흐름이 고를 수 없으니 고르개를 바꿔 끼우고, 값을 미리 채운다. */
export interface PhotoFormDev {
  pick?: () => Promise<PhotoPickOutcome>;
  initial?: {
    photo?: PickedPhoto;
    branch?: PhotoBranch;
    name?: string;
    displayName?: string;
    tags?: string;
    consent?: boolean;
    /** 모델 확인이 끝나면 한 번 보낸다(만드는 중·실패·결과 장면을 서게 한다). */
    submit?: boolean;
  };
}

export function ExpressionPhotoForm({
  onBack,
  onImport,
  onAgent,
  onDone,
  dev,
}: {
  onBack: () => void;
  /** 「가져오기로 등록하기」 — 모델이 없어도 등록은 늘 된다. */
  onImport: () => void;
  /** 「에이전트에게 부탁하기」 — 대화로 요청을 보내는 길(#4820 B). */
  onAgent: () => void;
  /** 등록을 마친 뒤 목록으로 돌아간다. */
  onDone: () => void;
  dev?: PhotoFormDev;
}): React.JSX.Element {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const {store, state} = useExpressions();
  const offline = state === 'offline';
  const reduceMotion = useReduceMotion();
  const scroll = useSectionScroll();
  const initial = dev?.initial;
  const [check, setCheck] = useState<ModelCheck>({kind: Check.loading});
  const [tries, setTries] = useState(0);
  const [photo, setPhoto] = useState<PickedPhoto | null>(
    initial?.photo ?? null,
  );
  const [branch, setBranch] = useState<PhotoBranch>(
    initial?.branch ?? PHOTO_BRANCHES[0],
  );
  const [name, setName] = useState(initial?.name ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [tags, setTags] = useState(initial?.tags ?? '');
  const [face, setFace] = useState<number>(Face.none);
  const [consent, setConsent] = useState(initial?.consent ?? false);
  const [invalid, setInvalid] = useState<Invalid>({});
  const [phase, setPhase] = useState<Phase>({kind: Step.idle});
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const autoSubmitted = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // 화면이 닫히면 기다리기를 그만둔다. 서버는 이미 시작한 일을 끝까지 한다.
      abort.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!store) return;
    let live = true;
    setCheck({kind: Check.loading});
    store.photoModel().then(
      model => {
        if (live) setCheck({kind: Check.ready, model});
      },
      (error: unknown) => {
        if (live) setCheck({kind: Check.error, failure: failureOf(error)});
      },
    );
    return () => {
      live = false;
    };
  }, [store, tries]);

  const busy = phase.kind === Step.busy;

  async function pick() {
    if (busy || lock.current) return;
    lock.current = true;
    try {
      const outcome = await (dev?.pick ?? pickAlbumPhoto)();
      if (!alive.current) return;
      if (outcome.kind === 'picked') {
        setPhoto(outcome.photo);
        setInvalid(current => ({...current, photo: undefined}));
      } else if (outcome.kind === 'denied') {
        setInvalid(current => ({
          ...current,
          photo: formatMessage('expressions.make.photoDenied'),
        }));
      } else if (outcome.kind === 'unavailable') {
        setInvalid(current => ({
          ...current,
          photo: formatMessage('expressions.make.photoUnavailable'),
        }));
      }
    } finally {
      lock.current = false;
    }
  }

  async function submit() {
    if (
      !store ||
      lock.current ||
      busy ||
      offline ||
      check.kind !== Check.ready ||
      !check.model.available ||
      check.model.provider === null
    ) {
      return;
    }
    const provider = check.model.provider;
    const chosenBranch = activeBranch(check.model, branch);
    // 닫는 것은 맨 처음이다: 이름 검사가 기다리는 사이에 다시 눌러도 요청은 한 번이다(모델 호출은 돈이다).
    lock.current = true;
    try {
      const problems: Invalid = {};
      const metadata: ExpressionMetadata = {
        name,
        displayName,
        tags: tags
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean),
        subjectMemberId: face === Face.self ? store.memberId : null,
      };
      const issue = photo === null ? null : photoIssueOf(photo);
      if (photo === null) {
        problems.photo = formatMessage('expressions.photo.photoMissing');
      } else if (issue !== null) {
        problems.photo = formatMessage(
          issue === 'type'
            ? 'expressions.photo.photoType'
            : issue === 'empty'
            ? 'expressions.make.photoEmpty'
            : 'expressions.photo.photoSize',
        );
      }
      if (face === Face.other) {
        problems.face = formatMessage('expressions.photo.faceOtherBlocked');
      }
      if (!isPhotoMetadata(metadata)) {
        problems.fields = formatMessage('expressions.photo.fieldsInvalid');
      }
      if (!consent) {
        problems.consent = formatMessage('expressions.photo.consentMissing');
      }
      if (Object.keys(problems).length === 0) {
        // 표준 이모지 이름과 겹치면 서버가 거절하니, 모델을 부르기 전에 먼저 알려 준다.
        const standard = await loadPhoneEmojiCatalog();
        if (standard.some(entry => entry.shortcodes.includes(name))) {
          problems.fields = formatMessage('expressions.photo.errorName');
        }
      }
      if (!alive.current) return;
      setInvalid(problems);
      setNotice(null);
      const first = (['photo', 'fields', 'face', 'consent'] as const).find(
        key => problems[key],
      );
      if (first) scroll.reveal(first);
      if (first || photo === null) return;
      const controller = new AbortController();
      abort.current = controller;
      setPhase({kind: Step.busy});
      try {
        const result = await withBackgroundTask('expression-photo', () =>
          store.photoDraft({
            ...photoDraftRequest(
              store.root,
              buildPhotoMetadata({branch: chosenBranch, provider, metadata}),
              {uri: photo.uri, name: photo.name, mime: photo.mime},
            ),
            signal: controller.signal,
          }),
        );
        // 취소했거나 화면이 닫혔으면 이 답은 아무도 기다리지 않는다.
        if (!alive.current || controller.signal.aborted) return;
        setPhase({kind: Step.made, result});
      } catch (error) {
        if (!alive.current || controller.signal.aborted) return;
        setPhase({kind: Step.failed, failure: failureOf(error)});
      } finally {
        if (abort.current === controller) abort.current = null;
      }
    } finally {
      lock.current = false;
    }
  }

  function cancel() {
    if (!abort.current) return;
    abort.current.abort();
    abort.current = null;
    setPhase({kind: Step.idle});
    setNotice(formatMessage('expressions.photo.cancelled'));
  }

  // 캡처 장면: 값이 미리 채워졌으면 모델 확인이 끝난 뒤 한 번 보낸다.
  const latestSubmit = useRef(submit);
  latestSubmit.current = submit;
  useEffect(() => {
    if (
      !initial?.submit ||
      autoSubmitted.current ||
      check.kind !== Check.ready
    ) {
      return;
    }
    autoSubmitted.current = true;
    void latestSubmit.current();
  }, [initial?.submit, check.kind]);

  const title = formatMessage('expressions.add.make');
  const chapter = (children: React.ReactNode) => (
    <ExpressionChapter
      title={title}
      onBack={onBack}
      scrollRef={scroll.ref}
      testID="expression-photo">
      {children}
    </ExpressionChapter>
  );
  if (!store) return chapter(null);

  if (phase.kind === Step.made) {
    const {draft, cutout: done} = phase.result;
    return chapter(
      <View style={styles.section} testID="expression-photo-made">
        <ExpressionDraftStep
          draft={draft}
          // 배경에 한 일은 그림 바로 위의 한 줄이다. 서버의 고정 문장(「만든 방법」)은 이 줄이 있으면 서지 않는다 — 같은 사실을 두
          // 번 말하고, 배경을 지우지 못한 때는 그 문장이 거꾸로 말한다. 캐리커처는 배경 줄이 없어서 고정 문장이 그 자리의 한 줄이다.
          pictureNote={
            done !== null ? (
              <LiveLine
                text={formatMessage(PHOTO_CUTOUT_KEY[done])}
                testID="expression-photo-cutout"
              />
            ) : undefined
          }
          promptLabel={formatMessage('expressions.photo.originLabel')}
          anotherLabel={formatMessage('expressions.photo.anotherPhoto')}
          onReplace={next =>
            setPhase({kind: Step.made, result: {draft: next, cutout: done}})
          }
          onApprove={async choice => {
            await store.mutate(expressionActivateRequest(store.root, choice));
            onDone();
          }}
          onAnother={() => {
            setPhase({kind: Step.idle});
            setConsent(false);
          }}
        />
      </View>,
    );
  }

  if (check.kind === Check.loading) {
    return chapter(
      <LoadingState
        label={formatMessage('expressions.photo.checking')}
        testID="expression-photo-checking"
      />,
    );
  }

  if (check.kind === Check.error) {
    // 확인이 안 될 때도 에이전트에게 부탁하는 길은 막지 않는다: 그 길은 이 확인과 상관없다. 서버가 이 사람에게는 사진으로
    // 만들 권한이 없다고 답한 경우(게스트·관리자만 추가하는 팀)는 다시 해도 같다: 못 한다고 말하고 다시 시도는 두지 않는다.
    const refused =
      PHOTO_FAILURE_KEY[check.failure] === PHOTO_FAILURE_KEY.role;
    return chapter(
      <View style={styles.section}>
        {refused ? (
          <LiveLine
            text={formatMessage(PHOTO_FAILURE_KEY.role)}
            tone="danger"
            testID="expression-photo-check-refused"
          />
        ) : (
          <>
            <LiveLine
              text={formatMessage('expressions.photo.checkFailed')}
              tone="danger"
              testID="expression-photo-check-error"
            />
            <OutlineButton
              label={formatMessage('expressions.photo.retry')}
              onPress={() => setTries(value => value + 1)}
              testID="expression-photo-retry"
            />
          </>
        )}
        <OutlineButton
          label={formatMessage('expressions.photo.agentInstead')}
          onPress={onAgent}
          testID="expression-photo-agent"
        />
      </View>,
    );
  }

  const {model} = check;
  if (!model.available || model.provider === null) {
    return chapter(
      <View style={styles.section} testID="expression-photo-no-model">
        <SheetNotice
          headline={formatMessage('expressions.photo.noModelHeadline')}
          detail={formatMessage('expressions.photo.noModelDetail')}
        />
        {/* 연결은 운영자만 한다. 폰에는 그 설정 화면이 없어서(`SettingsOpenSuggestion` 과 같다) 운영자에게도 갈 곳이 아니라
            어디서 하는지를 말한다. */}
        <Sentence
          style={styles.note}
          testID={
            model.canManage ? 'expression-photo-manage' : 'expression-photo-ask'
          }>
          {formatMessage(
            model.canManage
              ? 'expressions.photo.noModelManagePhone'
              : 'expressions.photo.noModelAsk',
          )}
        </Sentence>
        <OutlineButton
          label={formatMessage('expressions.photo.noModelImport')}
          onPress={onImport}
          testID="expression-photo-import"
        />
      </View>,
    );
  }

  const provider = model.provider;
  const providerName = formatMessage(
    provider === PHOTO_PROVIDERS[0]
      ? 'expressions.photo.providerOpenai'
      : 'expressions.photo.providerGemini',
  );
  const offered = offeredBranches(model);
  const active = activeBranch(model, branch);
  const failure = phase.kind === Step.failed ? phase.failure : null;
  return chapter(
    <>
      <Sentence style={styles.note}>
        {formatMessage('expressions.photo.introText')}
      </Sentence>
      <View
        style={styles.section}
        onLayout={scroll.track('photo')}
        testID="expression-photo-form">
        <FieldLabel label={formatMessage('expressions.photo.photoLabel')} />
        <PhotoPickRow
          photo={photo}
          disabled={busy}
          pickLabel={formatMessage('expressions.make.photoPick')}
          changeLabel={formatMessage('expressions.make.photoChange')}
          previewLabel={formatMessage('expressions.photo.photoPreviewAlt')}
          onPick={() => void pick()}
          testID="expression-photo-file"
        />
        <Sentence style={styles.note}>
          {formatMessage('expressions.photo.photoHint')}
        </Sentence>
        <LiveLine
          text={invalid.photo}
          tone="danger"
          testID="expression-photo-error-photo"
        />
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={formatMessage('expressions.photo.branchLabel')}
        style={styles.section}>
        <GroupLabel>{formatMessage('expressions.photo.branchLabel')}</GroupLabel>
        <GroupCard>
          {offered.map(item => (
            <ChoiceRow
              key={item}
              title={formatMessage(BRANCH_COPY[item].label)}
              detail={formatMessage(BRANCH_COPY[item].hint)}
              accessibilityHint={formatMessage(BRANCH_COPY[item].hint)}
              selected={active === item}
              disabled={busy}
              onPress={() => setBranch(item)}
              testID={`expression-photo-branch-${item}`}
            />
          ))}
        </GroupCard>
      </View>
      <View style={styles.section} onLayout={scroll.track('fields')}>
        <FieldLabel label={formatMessage('expressions.photo.nameLabel')} />
        <Field
          accessibilityLabel={formatMessage('expressions.photo.nameLabel')}
          value={name}
          onChangeText={setName}
          onFocus={() => scroll.reveal('fields')}
          placeholder={formatMessage('expressions.photo.namePlaceholder')}
          maxLength={30}
          editable={!busy}
          invalid={Boolean(invalid.fields)}
          autoCapitalize="none"
          autoCorrect={false}
          testID="expression-photo-name"
        />
        <FieldLabel label={formatMessage('expressions.photo.displayNameLabel')} />
        <Field
          accessibilityLabel={formatMessage('expressions.photo.displayNameLabel')}
          value={displayName}
          onChangeText={setDisplayName}
          onFocus={() => scroll.reveal('fields')}
          placeholder={formatMessage('expressions.photo.displayNamePlaceholder')}
          maxLength={40}
          editable={!busy}
          invalid={Boolean(invalid.fields)}
          testID="expression-photo-display-name"
        />
        <FieldLabel label={formatMessage('expressions.photo.tagsLabel')} />
        <Field
          accessibilityLabel={formatMessage('expressions.photo.tagsLabel')}
          value={tags}
          onChangeText={setTags}
          onFocus={() => scroll.reveal('fields')}
          placeholder={formatMessage('expressions.photo.tagsPlaceholder')}
          editable={!busy}
          invalid={Boolean(invalid.fields)}
          testID="expression-photo-tags"
        />
        <LiveLine
          text={invalid.fields}
          tone="danger"
          testID="expression-photo-error-fields"
        />
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={formatMessage('expressions.photo.faceLabel')}
        style={styles.section}
        onLayout={scroll.track('face')}>
        <GroupLabel>{formatMessage('expressions.photo.faceLabel')}</GroupLabel>
        <GroupCard>
          {FACE_ROWS.map(([value, key]) => (
            <ChoiceRow
              key={value}
              title={formatMessage(key)}
              selected={face === value}
              disabled={busy}
              onPress={() => setFace(value)}
              testID={`expression-photo-face-${Object.keys(Face)[value]}`}
            />
          ))}
        </GroupCard>
        <LiveLine
          text={invalid.face}
          tone="danger"
          testID="expression-photo-error-face"
        />
      </View>
      <Sentence style={styles.note}>
        {formatMessage('expressions.photo.fixedNote')}
      </Sentence>
      <View style={styles.section} onLayout={scroll.track('consent')}>
        <GroupCard>
          <ListRow
            title={formatMessage('expressions.photo.consent', {
              provider: providerName,
            })}
            accessory="toggle"
            toggle={{
              value: consent,
              onValueChange: next => {
                setConsent(next);
                setInvalid(current => ({...current, consent: undefined}));
              },
            }}
            disabled={busy}
            testID="expression-photo-consent"
          />
        </GroupCard>
        <LiveLine
          text={invalid.consent}
          tone="danger"
          testID="expression-photo-error-consent"
        />
      </View>
      {offline ? (
        <LiveLine text={formatMessage('expressions.photo.errorOffline')} />
      ) : null}
      {busy ? (
        <View style={styles.busyRow}>
          {reduceMotion ? null : (
            // 장식이다: 한 줄(`expression-photo-busy`)이 같은 일을 말하고 낭독한다.
            <ActivityIndicator
              accessibilityElementsHidden
              color={palette.textMuted}
              testID="expression-photo-spinner"
            />
          )}
          <View style={styles.busyText}>
            <LiveLine
              text={formatMessage('expressions.photo.busy')}
              testID="expression-photo-busy"
            />
          </View>
        </View>
      ) : null}
      <LiveLine
        text={notice}
        testID="expression-photo-cancelled"
      />
      {failure !== null ? (
        <LiveLine
          text={formatMessage(PHOTO_FAILURE_KEY[failure])}
          tone="danger"
          testID="expression-photo-failure"
        />
      ) : null}
      <PrimaryButton
        label={formatMessage('expressions.photo.submit')}
        disabled={offline || busy}
        onPress={() => void submit()}
        testID="expression-photo-submit"
      />
      {busy ? (
        <OutlineButton
          label={formatMessage('expressions.photo.cancel')}
          // 이 단추는 기다리기만 그만둔다. 낭독이 누르기 전에 그 사실을 말한다(`OutlineButton` 에는 힌트 자리가 없다).
          accessibilityLabel={[
            formatMessage('expressions.photo.cancel'),
            formatMessage('expressions.photo.cancelHint'),
          ].join(' ')}
          onPress={cancel}
          testID="expression-photo-cancel"
        />
      ) : (
        <OutlineButton
          label={formatMessage('expressions.photo.agentInstead')}
          onPress={onAgent}
          testID="expression-photo-agent"
        />
      )}
    </>,
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    section: {gap: space.xs},
    note: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    busyRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    busyText: {flex: 1},
  });
