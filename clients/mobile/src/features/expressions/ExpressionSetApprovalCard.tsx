import {
  isAnimatedExpression,
  LEGACY_EXPRESSION_KIND,
  recommendExpressionKind,
} from '@momo/core/features/expressions/kind';
import {
  expressionSetCard,
  expressionSetChoices,
  expressionSetSlotDraft,
  readySlots,
  type ExpressionSetApproval,
  type ExpressionSetGrayCode,
  type ExpressionSetResult,
  type ExpressionSetSlot,
} from '@momo/core/features/expressions/set';
import {
  expressionDecisionRequest,
  expressionSetResultFromReceipt,
} from '@momo/core/features/expressions/setWire';
import {
  EXPRESSION_KINDS,
  type ExpressionDraft,
  type ExpressionKind,
} from '@momo/core/features/expressions/types';
import type {
  AgentApprovalCard,
  ApprovalStatus,
} from '@momo/core/features/timeline/agentCardModel';
import type {ApprovalCardNote} from '@momo/core/features/timeline/approvalNote';
import {
  newDecisionId,
  type DecisionOutcome,
} from '@momo/core/features/timeline/approvalDecision';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {Sentence} from '../../design/atoms';
import {ATTACH_MENU_ICONS, CONV_ICONS, CONV_ICON_SIZE} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {ds2Radius, font, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {LiveLine} from './ExpressionChapter';
import {useExpressions} from './ExpressionProvider';
import {ExpressionSetReferences} from './ExpressionSetReferences';
import {Decided, sendSetDecision, Status} from './setDecision';
import {PillButton, PillRow} from './setCardParts';
import {SET_ID, SET_WORD} from './setWords';
import {useExpressionMessages, type PlainMessageKey} from './useExpressionMessages';

// =============================================================================
// 세트 카드 (ADR-0218 §12 L5~L7, #5463 폰): 팀 AI 가 올린 그림 세트를 사람이 **한 번** 승인하고, 서버는 고른 것만 등록한다.
// 웹 `ExpressionSetApprovalCard` 의 폰 짝이다. 대화에 서는 길은 기존 행동 승인 카드다(`MessageRow` 의 `AgentCard` 가 `expression.set.create`
// 를 여기로 보낸다). 새 경로·새 화면 자리는 없다.
//
// 규칙(코어 `expressionSetCard`·`expressionSetChoices` 가 판정하고 이 화면은 그린다):
//  - 기본은 준비된 칸 전부 선택이다. 칸별로 빼고 다시 넣을 수 있고, 선택이 0 이면 등록은 꺼진다. 한 세트에는 두 번째 승인이 없다.
//  - 회색 칸(L7)은 같은 크기의 자리를 차지하지만 선택·올리기·다시 시도가 없다. 눌러도 아무 일도 없고, 사유는 한 줄이며 재시도를 권하지 않는다.
//  - 종류(작은/큰 이모티콘)는 고른 칸 전체에 한 번 정한다. 고르지 않으면 칸마다 서버와 같은 추천(J4)을 보낸다.
//  - 결과 줄은 숫자만이다(L5.5). 이름이 겹치거나 정원이 차서 건너뛴 것은 서버가 건너뛰고 개수만 말한다.
//  - 이름 목록이 모두 보인다(L9): 한 번의 승인이 최대 40개 이름을 영구 예약하므로 줄이거나 접지 않는다.
//
// ## 폰 손맛
//  - **누름 면**: 칸 하나·단추 하나가 모두 `TOUCH_TARGET` 이상이다(`minHeight`). 칸은 글이 자라는 만큼 자란다.
//  - **큰 글씨**: 시스템 글자 배율이 `LARGE_TEXT_SCALE` 이상이면 격자는 두 칸씩(`GRID_COLUMNS.large`)으로 줄어 이름이 잘리지 않는다. 읽는 글자에는 상한을
//    붙이지 않는다(`atoms.tsx` 의 Dynamic Type 정책: 크롬만 상한을 갖고 본문·목록은 끝까지 자란다) — 칸은 글이 자라는 만큼 길어진다.
//  - **동작 줄이기**: 칸의 그림은 늘 정지 썸네일(`thumb`)이다 — 움직이는 그림(GIF)도 마찬가지다(열 장이 동시에 도는 것을 피한다). 보내는 중의
//    도는 표시기는 동작 줄이기가 꺼져 있을 때만 서고(`PillButton`), 켜져 있으면 낱말(「등록 중」)만 남는다.
//  - **VoiceOver**: 칸은 체크 상자(`checkbox`, 선택 상태)이고 이름은 「표시 이름, :이름:」 이다. 회색 칸은 「선택할 수 없는 칸, 사유. 표시 이름」으로 읽힌다.
//
// 이 파일에는 상태 이름 같은 글자 리터럴이 없다(직접 문구 장부: 새 파일은 0칸). 표의 키는 속성 이름이고, 갈래는 숫자, 글은 사전이다.
// =============================================================================

/** 시스템 글자 배율이 이 값 이상이면 「큰 글씨」다. */
export const LARGE_TEXT_SCALE = 1.3;
/** 격자 한 줄의 칸 수. 큰 글씨에서는 줄어서 이름이 잘리지 않는다. */
export const GRID_COLUMNS = {normal: 3, large: 2} as const;
/** 칸 그림의 한 변(pt). */
const PICTURE_EDGE = 64;
/** 선택 표지(체크 원)의 지름. */
const CHECK_EDGE = 20;
/** 회색 칸의 그림 글리프(굽는 크기 22pt). */
const ATTACH_ICON_EDGE = 22;

/** 이 글자 배율에서 한 줄에 몇 칸을 세우는가. */
export function gridColumnsFor(fontScale: number): number {
  return fontScale >= LARGE_TEXT_SCALE ? GRID_COLUMNS.large : GRID_COLUMNS.normal;
}

const GRAY_LINE = {
  refused: 'expressions.set.grayRefused',
  failed: 'expressions.set.grayFailed',
  not_made: 'expressions.set.grayNotMade',
  base_missing: 'expressions.set.grayBaseMissing',
} as const satisfies Record<ExpressionSetGrayCode, PlainMessageKey>;
/** 이 빌드가 모르는 사유는 「만들지 못했어요」다: 빈 줄이 아니다. */
const grayKey = (code: ExpressionSetGrayCode): PlainMessageKey =>
  GRAY_LINE[code] ?? GRAY_LINE.failed;

const KIND_LABEL = {
  emoji: 'expressions.kind.emoji',
  sticker: 'expressions.kind.sticker',
} as const satisfies Record<ExpressionKind, PlainMessageKey>;

/** 끝난 카드가 하는 말(결과를 읽을 수 없을 때). */
const SETTLED_LINE = {
  pending: 'expressions.set.settledExpired',
  approved: 'expressions.set.settledDone',
  rejected: 'expressions.set.settledDeclined',
  expired: 'expressions.set.settledExpired',
  cancelled: 'expressions.set.settledDone',
} as const satisfies Record<ApprovalStatus, PlainMessageKey>;

/** 종류 고르개에서 아무것도 고르지 않은 상태의 값: 고른 칸의 추천이 갈릴 때. 두 선택지 어느 것과도 같지 않다. */
const MIXED = null;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    rows.push(items.slice(at, at + size));
  }
  return rows;
}

export function ExpressionSetApprovalCard({
  card,
  set,
  result,
  settledStatus,
  note,
  nowMs,
  onSettled,
}: {
  card: AgentApprovalCard;
  set: ExpressionSetApproval | null;
  result: ExpressionSetResult | null;
  /** 이 카드가 지금 말하는 승인 상태: 이 화면이 방금 결정한 것(영수증 표)이 메시지 스냅샷보다 앞선다. */
  settledStatus: ApprovalStatus;
  /** 컨트롤 대신 서는 한 줄(오프라인·다른 자리). `null` 이면 컨트롤이 선다. */
  note: ApprovalCardNote | null;
  nowMs: number;
  /** 결정이 끝났다: 화면의 영수증 표(`onApprovalSettled`)가 이 카드가 끝났다는 사실을 한 곳에서 읽는다. */
  onSettled?: (approvalId: string, outcome: DecisionOutcome) => void;
}): React.JSX.Element {
  const {store} = useExpressions();
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const {fontScale} = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const [errorLine, setErrorLine] = useState<PlainMessageKey | null>(null);
  const [localResult, setLocalResult] = useState<ExpressionSetResult | null>(null);
  const [kindChoice, setKindChoice] = useState<ExpressionKind | null>(null);
  const lock = useRef(false);
  const keys = useRef(new Map<string, string>());

  // 다른 워크스페이스의 묶음은 그리지 않는다: 이 저장소의 그림 길로는 열 수 없고, 열 수 있는 척하면 안 된다.
  const usable =
    set !== null && store !== null && set.workspaceId === store.workspaceId
      ? set
      : null;
  const ready = useMemo(() => (usable ? readySlots(usable) : []), [usable]);
  const readyIndexes = useMemo(() => ready.map(slot => slot.index), [ready]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(
    () => new Set(readyIndexes),
  );
  // 다른 세트가 오면 기본(전부)으로 돌아간다. 같은 세트의 메시지 갱신은 고른 것을 지킨다.
  const setId = usable?.setId ?? null;
  useEffect(() => {
    setSelected(new Set(readyIndexes));
    setKindChoice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setId]);
  const drafts = useMemo(
    () =>
      new Map<number, ExpressionDraft>(
        usable
          ? ready.map(slot => [slot.index, expressionSetSlotDraft(usable, slot)])
          : [],
      ),
    [ready, usable],
  );
  const recommended = useMemo(
    () =>
      new Map(
        ready.map(slot => [slot.index, recommendExpressionKind(slot.media.large)]),
      ),
    [ready],
  );

  // 열려 있다 = 아직 결정되지 않았고 카드의 기한도 묶음의 기한도 지나지 않았다. 기한은 시계가 아니라 서버가 박은 값이다.
  const open =
    settledStatus === Status.pending &&
    (!card.expiresAtMs || nowMs < card.expiresAtMs) &&
    (usable === null || nowMs < usable.expiresAtMs);
  // 컨트롤은 카드가 열려 있고 할 말(오프라인·다른 자리)이 없을 때만 선다.
  const live = open && note === null;
  const view = usable ? expressionSetCard(usable, nowMs, open) : null;
  const slots = usable ? [...usable.slots].sort((a, b) => a.index - b.index) : [];
  const stranger =
    usable !== null &&
    usable.subjectMemberId !== null &&
    usable.subjectMemberId !== store?.memberId;
  // 종류: 사람이 고른 값이 있으면 고른 칸 전부에, 없으면 칸마다 추천(서버가 같은 규칙으로 정할 값)을 보낸다.
  const kinds = Object.fromEntries(
    [...selected].map(index => [
      index,
      kindChoice ?? recommended.get(index) ?? LEGACY_EXPRESSION_KIND,
    ]),
  ) as Record<number, ExpressionKind>;
  const choices =
    usable && open
      ? expressionSetChoices(usable, nowMs, {only: [...selected], kinds})
      : null;
  const picked = choices?.length ?? 0;
  const canRegister = live && picked > 0 && !busy && !stranger;
  const picks = new Set([...selected].map(index => recommended.get(index)));
  const shownKind: ExpressionKind | null =
    kindChoice ?? (picks.size === 1 ? ([...picks][0] ?? MIXED) : MIXED);
  const allSelected =
    readyIndexes.length > 0 && readyIndexes.every(index => selected.has(index));
  const editable = live && !busy;

  function toggle(index: number) {
    if (!editable) return;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function decide(approve: boolean) {
    if (!store || !card.approvalId || !live || lock.current) return;
    if (approve && (!choices || stranger)) return;
    lock.current = true;
    setBusy(true);
    setErrorLine(null);
    // 같은 결정을 다시 누르면 같은 키라 서버가 첫 영수증을 돌려준다. 고른 것이 바뀌면 다른 결정이라 새 키다.
    const pin = approve ? JSON.stringify(choices) : '';
    const key = keys.current.get(pin) ?? newDecisionId();
    keys.current.set(pin, key);
    try {
      const outcome = await sendSetDecision(
        expressionDecisionRequest(
          store.root,
          card.approvalId,
          key,
          approve ? {approve: true, expressionChoices: choices} : {approve: false},
        ),
        approve,
      );
      if (outcome.kind === Decided.failed) {
        if (outcome.freshKey) keys.current.delete(pin);
        setErrorLine(outcome.line);
        return;
      }
      if (outcome.kind === Decided.settled) {
        onSettled?.(card.approvalId, outcome.outcome);
        return;
      }
      if (approve) setLocalResult(expressionSetResultFromReceipt(outcome.receipt));
      onSettled?.(card.approvalId, outcome.outcome);
      await store.refresh();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const title = usable?.title ?? card.title;
  if (!store) {
    return (
      <Sentence style={styles.body} testID="expression-set-unreadable">
        {formatMessage('expressions.set.unreadable')}
      </Sentence>
    );
  }
  const shownResult = localResult ?? result;
  const settledLine = shownResult
    ? shownResult.skipped.length === 0
      ? formatMessage('expressions.set.resultSaved', {count: shownResult.registered.length})
      : formatMessage('expressions.set.resultSavedSkipped', {
          saved: shownResult.registered.length,
          skipped: shownResult.skipped.length,
        })
    : formatMessage(SETTLED_LINE[settledStatus]);
  const summary = view
    ? [
        formatMessage('expressions.set.summaryReady', {count: view.ready}),
        view.gray > 0
          ? formatMessage('expressions.set.summaryGray', {count: view.gray})
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  const columns = gridColumnsFor(fontScale);

  return (
    <View style={styles.root} testID="expression-set">
      <View style={styles.header}>
        <Sentence style={styles.title} accessibilityRole="header">
          {title}
        </Sentence>
        {summary !== null && open ? (
          <Sentence style={styles.meta} testID="expression-set-summary">
            {summary}
          </Sentence>
        ) : null}
      </View>
      {open && usable === null ? (
        <>
          <Sentence style={styles.body} testID="expression-set-unreadable">
            {formatMessage('expressions.set.unreadable')}
          </Sentence>
          <PillRow>
            <PillButton
              quiet
              label={formatMessage('expressions.set.decline')}
              disabled={!live || busy}
              onPress={() => void decide(false)}
              testID="expression-set-decline"
            />
          </PillRow>
        </>
      ) : null}
      {open && usable !== null ? (
        <>
          {usable.references.length > 0 ? (
            <View style={styles.source} testID="expression-set-source">
              <ExpressionSetReferences
                references={usable.references}
                workspaceId={store.workspaceId}
                channelId={card.channelId}
                offline={note?.kind === SET_WORD.offline}
              />
              <Sentence style={styles.meta}>
                {formatMessage('expressions.set.referenceCount', {
                  count: usable.references.length,
                })}
              </Sentence>
            </View>
          ) : null}
          <Sentence style={styles.meta} testID="expression-set-prompt">
            {formatMessage('expressions.set.agentText', {prompt: usable.prompt})}
          </Sentence>
          <View
            accessibilityRole="list"
            accessibilityLabel={formatMessage('expressions.set.gridLabel', {
              title: usable.title,
            })}
            style={styles.grid}
            testID="expression-set-grid">
            {chunk(slots, columns).map((row, rowAt) => (
              <View
                key={row[0]?.index ?? 0}
                style={styles.gridRow}
                testID={SET_ID.row(rowAt)}>
                {row.map(slot => (
                  <SetTile
                    key={slot.index}
                    slot={slot}
                    checked={selected.has(slot.index)}
                    editable={editable}
                    draft={drafts.get(slot.index) ?? null}
                    onToggle={() => toggle(slot.index)}
                  />
                ))}
                {Array.from({length: columns - row.length}, (_, filler) => (
                  <View key={filler} style={styles.tileFiller} />
                ))}
              </View>
            ))}
          </View>
          {readyIndexes.length > 0 ? (
            <View style={styles.controls}>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={formatMessage('expressions.kind.legend')}
                style={styles.kindRow}
                testID="expression-set-kind">
                {EXPRESSION_KINDS.map(value => (
                  <KindPill
                    key={value}
                    label={formatMessage(KIND_LABEL[value])}
                    checked={shownKind === value}
                    disabled={!editable || picked === 0}
                    onPress={() => setKindChoice(value)}
                    testID={SET_ID.kind(value)}
                  />
                ))}
              </View>
              {readyIndexes.length > 1 ? (
                <PillButton
                  quiet
                  label={formatMessage(
                    allSelected
                      ? 'expressions.set.selectNone'
                      : 'expressions.set.selectAll',
                  )}
                  disabled={!editable}
                  onPress={() =>
                    setSelected(allSelected ? new Set() : new Set(readyIndexes))
                  }
                  testID="expression-set-select-all"
                />
              ) : null}
            </View>
          ) : null}
          <Sentence style={styles.meta} testID="expression-set-rights">
            {formatMessage('expressions.set.rights')}
          </Sentence>
          {stranger ? (
            <Sentence style={styles.meta} testID="expression-set-face-only">
              {formatMessage('expressions.set.faceOnly')}
            </Sentence>
          ) : null}
          {note !== null ? (
            <Sentence style={styles.meta} testID="expression-set-note">
              {note.text}
            </Sentence>
          ) : null}
          <PillRow>
            <PillButton
              quiet
              label={formatMessage('expressions.set.decline')}
              disabled={!live || busy}
              onPress={() => void decide(false)}
              testID="expression-set-decline"
            />
            <PillButton
              label={formatMessage('expressions.set.register', {count: picked})}
              busy={busy}
              busyLabel={formatMessage('expressions.set.registering')}
              disabled={!canRegister}
              onPress={() => void decide(true)}
              testID="expression-set-register"
            />
          </PillRow>
        </>
      ) : null}
      {!open ? (
        <LiveLine text={settledLine} testID="expression-set-settled" />
      ) : null}
      <LiveLine
        text={errorLine === null ? null : formatMessage(errorLine)}
        tone="danger"
        testID="expression-set-error"
      />
    </View>
  );
}

/** 종류 고르개의 한 알약: 라디오다. 고른 쪽은 채움이 아니라 테두리+글 굵기로도 말한다(색에만 기대지 않는다). */
function KindPill({
  label,
  checked,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{checked, disabled}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.kindPill,
        checked && styles.kindPillOn,
        disabled && styles.inert,
        pressed && !disabled && styles.pressed,
      ]}
      testID={testID}>
      <Sentence style={[styles.kindLabel, checked && styles.kindLabelOn]}>
        {label}
      </Sentence>
    </Pressable>
  );
}

/** 칸의 그림: 등록 전 미리보기의 **작은 썸네일**을 임시 파일로 받는다(늘 정지 — 움직이는 그림도). 칸이 사라지면 파일을 지운다. */
function TilePicture({draft}: {draft: ExpressionDraft}): React.JSX.Element {
  const {store} = useExpressions();
  const styles = useStyles(buildStyles);
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    setUri(null);
    if (!store) return;
    let alive = true;
    let loaded: string | null = null;
    void store.draftImage(draft, SET_WORD.thumb).then(next => {
      if (!next) return;
      if (!alive) {
        store.discardDraftImage(next);
        return;
      }
      loaded = next;
      setUri(next);
    });
    return () => {
      alive = false;
      if (loaded) store.discardDraftImage(loaded);
    };
  }, [store, draft]);
  return (
    <View style={styles.picture}>
      {uri !== null ? (
        <Image
          accessible={false}
          resizeMode="contain"
          source={{uri}}
          style={styles.pictureImage}
          testID="expression-set-picture"
        />
      ) : null}
    </View>
  );
}

/**
 * 격자의 한 칸. 준비된 칸은 눌러서 고르고 빼는 체크 상자이고, 회색 칸은 같은 자리를 차지하되 누를 것이 없는 글 한 덩어리다: 눌러도 아무 일도 없고
 * 선택·올리기·다시 시도가 모두 없다. 구분은 색에만 기대지 않는다(점선·아이콘·글).
 */
function SetTile({
  slot,
  checked,
  editable,
  draft,
  onToggle,
}: {
  slot: ExpressionSetSlot;
  checked: boolean;
  editable: boolean;
  draft: ExpressionDraft | null;
  onToggle: () => void;
}): React.JSX.Element {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const tileId = SET_ID.tile(slot.index);
  const token = [':', slot.name, ':'].join('');
  if (slot.code !== null) {
    const reason = formatMessage(grayKey(slot.code));
    return (
      <View
        accessible
        accessibilityLabel={formatMessage('expressions.set.cellGray', {
          reason,
          displayName: slot.displayName,
        })}
        accessibilityState={{disabled: true}}
        style={[styles.tile, styles.tileGray]}
        testID={tileId}>
        <View style={styles.picture}>
          <Image
            accessible={false}
            source={ATTACH_MENU_ICONS.photo}
            style={{
              width: ATTACH_ICON_EDGE,
              height: ATTACH_ICON_EDGE,
              tintColor: palette.textFaint,
            }}
          />
        </View>
        <Sentence
          style={styles.tileName}>
          {slot.displayName}
        </Sentence>
        <Sentence
          style={styles.tileMeta}>
          {reason}
        </Sentence>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={formatMessage('expressions.set.cellReady', {
        displayName: slot.displayName,
        name: slot.name,
      })}
      accessibilityState={{checked, disabled: !editable}}
      disabled={!editable}
      onPress={onToggle}
      style={({pressed}) => [
        styles.tile,
        checked && styles.tileOn,
        pressed && editable && styles.pressed,
      ]}
      testID={tileId}>
      <View
        style={[styles.check, checked && styles.checkOn]}
        testID={SET_ID.check(slot.index)}>
        {checked ? (
          <Image
            accessible={false}
            source={CONV_ICONS.check}
            style={{
              width: CONV_ICON_SIZE.check,
              height: CONV_ICON_SIZE.check,
              tintColor: palette.onPrimary,
            }}
          />
        ) : null}
      </View>
      {draft !== null ? <TilePicture draft={draft} /> : <View style={styles.picture} />}
      <Sentence style={styles.tileName}>
        {slot.displayName}
      </Sentence>
      <Sentence style={styles.tileMeta}>
        {token}
      </Sentence>
      {draft !== null && isAnimatedExpression(draft) ? (
        <Text
          style={styles.badge}
          testID={SET_ID.gif(slot.index)}>
          {formatMessage('expressions.set.badgeGif')}
        </Text>
      ) : null}
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {gap: space.md},
    header: {gap: space.xs},
    title: {fontSize: font.heading, fontWeight: '600', color: color.text},
    body: {fontSize: font.body, color: color.text},
    meta: {fontSize: font.meta, color: color.textMuted},
    source: {gap: space.sm},
    grid: {gap: space.sm},
    gridRow: {flexDirection: SET_WORD.row, gap: space.sm},
    tile: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: SET_WORD.center,
      gap: space.xs,
      padding: space.sm,
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    // 고른 칸의 테두리는 컨트롤 테두리(3:1)다. 고름은 체크 원이 말하고, 테두리는 그 곁에서 한 번 더 말한다.
    tileOn: {borderColor: color.textFaint},
    tileGray: {
      borderStyle: SET_WORD.dashed,
      backgroundColor: color.surfaceMuted,
    },
    tileFiller: {flex: 1},
    picture: {
      width: PICTURE_EDGE,
      height: PICTURE_EDGE,
      alignItems: SET_WORD.center,
      justifyContent: SET_WORD.center,
    },
    pictureImage: {width: PICTURE_EDGE, height: PICTURE_EDGE},
    check: {
      position: SET_WORD.absolute,
      top: space.xs,
      left: space.xs,
      width: CHECK_EDGE,
      height: CHECK_EDGE,
      borderRadius: ds2Radius.pill,
      borderWidth: 1,
      borderColor: color.textFaint,
      alignItems: SET_WORD.center,
      justifyContent: SET_WORD.center,
      zIndex: 1,
    },
    checkOn: {backgroundColor: color.primary, borderColor: color.primary},
    tileName: {
      fontSize: font.label,
      fontWeight: '600',
      color: color.text,
      textAlign: SET_WORD.center,
    },
    tileMeta: {
      fontSize: font.meta,
      color: color.textMuted,
      textAlign: SET_WORD.center,
    },
    badge: {
      fontSize: font.caption,
      fontWeight: '600',
      color: color.textMuted,
      backgroundColor: color.surfaceMuted,
      paddingHorizontal: space.xs,
      borderRadius: ds2Radius.badge,
      overflow: SET_WORD.hidden,
    },
    controls: {gap: space.sm},
    kindRow: {flexDirection: SET_WORD.row, flexWrap: SET_WORD.wrap, gap: space.sm},
    kindPill: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: SET_WORD.center,
      justifyContent: SET_WORD.center,
      paddingHorizontal: space.md,
      borderRadius: ds2Radius.pill,
      borderWidth: 1,
      borderColor: color.border,
    },
    kindPillOn: {borderColor: color.textFaint, backgroundColor: color.surfaceMuted},
    kindLabel: {
      fontSize: font.label,
      color: color.textMuted,
      textAlign: SET_WORD.center,
    },
    kindLabelOn: {color: color.text, fontWeight: '600'},
    inert: {opacity: 0.6},
    pressed: {backgroundColor: color.surfacePressed},
  });
