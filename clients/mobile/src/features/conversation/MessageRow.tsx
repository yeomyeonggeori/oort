import {threadRollup, type Message, type ThreadRollup} from '@momo/core/lib/api';
import {
  memberFor,
  memberNameParts,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {
  formatCount,
  formatMicroUsd,
  frameSentence,
  TURN_STATUS_LABEL,
  APPROVAL_STATUS_LABEL,
  type AgentCardModel,
} from '@momo/core/features/timeline/agentCardModel';
import {
  artifactNote,
  isProvisional,
  rowPresentation,
  type ArtifactState,
} from '@momo/core/features/timeline/rowModel';
import {isTruncated, omittedFileCount} from '@momo/core/features/timeline/artifacts';
import type {ArtifactPresentation} from '@momo/core/features/timeline/artifacts';
import {
  canDeleteMessage,
  canEditMessage,
  canReactToMessage,
  canReplyToMessage,
  hasAnyAction,
  type MessageActionAvailability,
  type PendingMessage,
} from '@momo/core/features/timeline/model';
import {
  deleteFailureMessage,
  editFailureMessage,
  reactionFailureMessage,
} from '@momo/core/features/timeline/actionCopy';
import type {ReactionChip} from '@momo/core/features/timeline/reactions';
import React, {useCallback, useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from '../../design/tokens';
import {MessageActionSheet} from './MessageActionSheet';
import {MessageEditorSheet} from './MessageEditorSheet';
import {useLongPress} from './useLongPress';

// =============================================================================
// One row of the conversation.
//
// Everything this file decides about MEANING it asks the core for: which card a
// message renders (`rowPresentation` — the approval > artifact > card
// precedence chain, which used to live inline in the web row and got the most
// important case backwards), what a turn's status is called
// (`TURN_STATUS_LABEL`), whether an artifact's numbers are final
// (`isProvisional`), what to say about it (`artifactNote`), how to write a
// count or a cost (`formatCount` / `formatMicroUsd`), and whether there is a
// thread under it (`threadRollup`). This file decides only how those answers
// look on a phone.
//
// ## Reactions are shown, not offered
//
// The chips render counts and whether I am in them, and they are NOT pressable
// in this batch: 메시지 액션 is the next one. A chip that looks like a button
// and does nothing is worse than a chip that looks like a label, so they are
// drawn as labels — no press feedback, no button role, nothing for a thumb to
// aim at and be refused by.
//
// ## Why the body is not a markdown renderer yet
//
// `@momo/core/features/timeline/markdown` parses a body into blocks, and the
// web row walks that tree into elements. Here the body renders as text, with
// `isPlainText` deciding nothing more than whether a fenced block gets its own
// monospace box. Rendering the full tree (links, emphasis, nested lists) on RN
// means a `Text`-composition pass that this batch cannot also measure, and a
// half-walked tree that drops the parts it does not know how to draw would
// silently delete content from a message. Text that is complete beats markup
// that is partial. The parser is in the core and unchanged, so the batch that
// draws it starts from the same tree the web client already uses.
// =============================================================================

const UNKNOWN_MEMBER = '알 수 없는 멤버';

/** hh:mm, 24-hour, local. The row's own clock is never used for ordering. */
function timeLabel(atMs: number): string {
  const d = new Date(atMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function relativeLabel(atMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - atMs);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

// ---- dividers ---------------------------------------------------------------

export function DayDivider({atMs}: {atMs: number}): React.JSX.Element {
  const d = new Date(atMs);
  const label = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
  return (
    <View style={styles.divider} testID="day-divider">
      <View style={styles.dividerLine} />
      <Text style={styles.dividerLabel}>{label}</Text>
      <View style={styles.dividerLine} />
    </View>
  );
}

export function UnreadDivider({count}: {count: number}): React.JSX.Element {
  return (
    <View style={styles.divider} testID="unread-divider">
      <View style={[styles.dividerLine, styles.dividerLineWarn]} />
      <Text style={[styles.dividerLabel, styles.dividerLabelWarn]}>
        {`새 메시지 ${count}개, 여기까지 읽음`}
      </Text>
      <View style={[styles.dividerLine, styles.dividerLineWarn]} />
    </View>
  );
}

export function RecoveryDivider({
  seq,
  source,
}: {
  seq: number;
  /** Which rail healed the gap. Stated, because they are not equally strong. */
  source: 'replay' | 'backfill';
}): React.JSX.Element {
  return (
    <View style={styles.divider} testID="recovery-divider">
      <View style={styles.dividerLine} />
      <Text style={styles.dividerLabel}>
        {`재연결됨, seq ${seq}까지 복구${source === 'backfill' ? ' (다시 읽음)' : ''}`}
      </Text>
      <View style={styles.dividerLine} />
    </View>
  );
}

// ---- shared bits ------------------------------------------------------------

function Author({
  directory,
  memberId,
  atMs,
}: {
  directory: Directory;
  memberId: string;
  atMs: number;
}): React.JSX.Element {
  const member = memberFor(directory, memberId);
  const parts = memberNameParts(directory, memberId, UNKNOWN_MEMBER);
  const isAgent = member?.kind === 'agent';
  const owner =
    isAgent && member?.ownerHumanId
      ? memberFor(directory, member.ownerHumanId)
      : null;
  return (
    <View style={styles.authorRow}>
      <Text
        style={[styles.authorName, isAgent && styles.authorNameAgent]}
        numberOfLines={1}>
        {parts.name}
      </Text>
      {parts.handle ? (
        <Text style={styles.authorHandle} numberOfLines={1}>
          {parts.handle}
        </Text>
      ) : null}
      {isAgent ? (
        <View style={styles.agentTag}>
          <Text style={styles.agentTagText}>에이전트</Text>
        </View>
      ) : null}
      {owner ? (
        <Text style={styles.authorMeta} numberOfLines={1}>
          {`${owner.displayName}님이 관리`}
        </Text>
      ) : null}
      <Text style={styles.time}>{timeLabel(atMs)}</Text>
    </View>
  );
}

/**
 * The reaction chips.
 *
 * Pressable now (RN-C4 drew them as labels and said why: a chip that looks like
 * a button and does nothing is worse than one that looks like a label). They are
 * also the row's one ALWAYS-VISIBLE action affordance, which matters on a phone
 * where the other entry point is an invisible gesture.
 *
 * `hitSlop` rather than padding for the 44px target: a 44px-tall chip would push
 * the tail of every reacted message a line further down, and density is one of
 * the things this product has. The slop is 6 top and bottom over a 32px chip,
 * which is 44 to a thumb and 32 to the layout.
 */
function Chips({
  chips,
  onToggle,
}: {
  chips: ReactionChip[];
  onToggle?: (emoji: string) => void;
}): React.JSX.Element | null {
  if (chips.length === 0) return null;
  return (
    <View style={styles.chipRow} testID="reaction-chips">
      {chips.map(chip => (
        <Pressable
          key={chip.emoji}
          accessibilityRole="button"
          accessibilityState={{selected: chip.mine}}
          accessibilityLabel={`${chip.emoji} 반응 ${chip.count}개, ${
            chip.mine ? '내 반응 취소' : '나도 반응하기'
          }`}
          disabled={onToggle === undefined}
          hitSlop={{top: 6, bottom: 6, left: 2, right: 2}}
          onPress={() => onToggle?.(chip.emoji)}
          style={({pressed}) => [
            styles.chip,
            chip.mine && styles.chipMine,
            pressed && styles.chipPressed,
          ]}
          testID={`reaction-chip-${chip.emoji}`}>
          <Text style={styles.chipEmoji}>{chip.emoji}</Text>
          <Text style={[styles.chipCount, chip.mine && styles.chipCountMine]}>
            {chip.count}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * 「↳ ○○님에게 답글」 — the line that makes a reply readable as one.
 *
 * ## Why the row needs it at all
 *
 * A reply is a message in this channel with `rootId` set, and the server does
 * not filter replies out of channel history — so it lands in the timeline as an
 * ordinary row. Nothing about it said 답글, which is exactly the report: 답글을
 * 달았는데 답글 모양으로 별도로 보이지 않는다.
 *
 * ## Why it is a glyph and a name rather than a quoted parent
 *
 * The quote is the tempting version and it is wrong on a phone: it doubles the
 * height of every reply and re-renders text the reader can already scroll to.
 * One meta-sized line names the destination and opens it, which is the whole job
 * — and it keeps the density this product has.
 *
 * ## Pressable only when there is a room to enter
 *
 * The same rule the thread rollup already follows here: with the root loaded and
 * a thread surface to open, this is a button onto that thread; with the root
 * above the oldest page this client has fetched, it is a sentence. A door to a
 * room that does not exist is worse than a sentence saying the room is there.
 *
 * This is not 「답글 달기」 and does not weaken the one-level rule: replying to a
 * reply is still refused by `canReplyToMessage`, so the action sheet on this row
 * offers no 답글. Opening the thread it already belongs to is navigation.
 */
function ReplyMarker({
  parent,
  directory,
  onOpen,
}: {
  parent: Message | null;
  directory: Directory;
  onOpen?: () => void;
}): React.JSX.Element {
  const label =
    parent === null
      ? // 모르면 모른다고 말한다: the root is not loaded, so the row says that it
        // is a reply and stops short of naming a message it cannot see.
        '↳ 답글'
      : `↳ ${
          memberNameParts(directory, parent.authorMemberId, UNKNOWN_MEMBER).name
        }님에게 답글`;
  if (!onOpen) {
    return (
      <Text style={styles.replyMark} numberOfLines={1} testID="reply-marker">
        {label}
      </Text>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="이 답글이 달린 스레드 열기"
      hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}
      onPress={onOpen}
      style={({pressed}) => [pressed && styles.pressed]}
      testID="reply-marker">
      <Text style={styles.replyMarkLink} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A fenced code block, scrollable sideways INSIDE itself. */
function CodeBlock({text}: {text: string}): React.JSX.Element {
  return (
    // The horizontal scroll lives here rather than on the screen: a long patch
    // line must not be able to drag the whole conversation sideways.
    <ScrollView
      horizontal
      style={styles.codeScroll}
      contentContainerStyle={styles.codeContent}
      showsHorizontalScrollIndicator>
      <Text style={styles.code}>{text}</Text>
    </ScrollView>
  );
}

// ---- agent + artifact cards -------------------------------------------------

function StatusChip({label, tone}: {label: string; tone: 'ok' | 'warn' | 'danger' | 'muted'}) {
  return (
    <View style={[styles.statusChip, styles[`statusChip_${tone}`]]}>
      <Text style={[styles.statusChipText, styles[`statusChipText_${tone}`]]}>
        {label}
      </Text>
    </View>
  );
}

function toneForTurn(status: string): 'ok' | 'warn' | 'danger' | 'muted' {
  if (status === 'done') return 'ok';
  if (status === 'error') return 'danger';
  if (status === 'awaiting-approval' || status === 'stalled') return 'warn';
  return 'muted';
}

function AgentCard({card}: {card: AgentCardModel}): React.JSX.Element {
  if (card.kind === 'approval') {
    return (
      <View style={styles.card} testID="agent-card">
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {card.title}
          </Text>
          <StatusChip
            label={APPROVAL_STATUS_LABEL[card.status]}
            tone={card.status === 'pending' ? 'warn' : card.status === 'approved' ? 'ok' : 'muted'}
          />
        </View>
        {card.summary ? <Text style={styles.cardBody}>{card.summary}</Text> : null}
        {/* 승인/거부 버튼은 이 배치가 아니다 — 결정은 데스크톱이나 인박스에서. */}
        <Text style={styles.cardNote}>
          이 결정은 인박스나 데스크톱 앱에서 처리할 수 있습니다.
        </Text>
      </View>
    );
  }

  const cost = card.kind === 'turn' ? card.cost : null;
  return (
    <View style={styles.card} testID="agent-card">
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {card.kind === 'tool' ? frameSentence(card.frame) : card.title}
        </Text>
        <StatusChip label={TURN_STATUS_LABEL[card.status]} tone={toneForTurn(card.status)} />
      </View>
      {card.errorNote ? (
        <Text style={[styles.cardNote, styles.cardNoteDanger]}>{card.errorNote}</Text>
      ) : null}
      {card.kind === 'turn' && card.failure ? (
        <Text style={styles.cardNote}>
          {`${card.failure.label} — ${card.failure.detail}`}
        </Text>
      ) : null}
      {cost ? (
        <Text style={styles.cardMeta}>
          {[
            cost.model,
            cost.promptTokens !== undefined
              ? `입력 ${formatCount(cost.promptTokens)}`
              : null,
            cost.completionTokens !== undefined
              ? `출력 ${formatCount(cost.completionTokens)}`
              : null,
            cost.costMicroUsd !== undefined
              ? `${formatMicroUsd(cost.costMicroUsd)}${cost.estimated ? ' (추정)' : ''}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      ) : null}
      {card.detail.rows.length > 0 ? (
        <View style={styles.detailRows}>
          {card.detail.rows.map(row => (
            <View key={row.label} style={styles.detailRow}>
              <Text style={styles.detailLabel}>{row.label}</Text>
              <Text style={styles.detailValue} numberOfLines={3}>
                {row.value}
              </Text>
            </View>
          ))}
          {card.detail.withheld > 0 ? (
            <Text style={styles.cardMeta}>
              {`표시하지 않은 항목 ${card.detail.withheld}개`}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ArtifactCard({
  artifact,
  state,
}: {
  artifact: ArtifactPresentation;
  state: ArtifactState | null;
}): React.JSX.Element {
  const note = state ? artifactNote(state) : null;
  const provisional = isProvisional(state);
  return (
    <View style={styles.card} testID="artifact-card">
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {artifact.title}
        </Text>
        {state ? (
          <StatusChip label={TURN_STATUS_LABEL[state.status]} tone={toneForTurn(state.status)} />
        ) : null}
      </View>

      {note ? (
        <Text style={[styles.cardNote, note.tone === 'danger' && styles.cardNoteDanger]}>
          {note.live ? `${note.text} …` : note.text}
        </Text>
      ) : null}

      {artifact.kind === 'diff' ? (
        <>
          <Text style={styles.cardMeta}>
            {/* The counts are labelled as not-final whenever the turn that
                produced them had not finished — a bare `+12 −3` under a
                streaming turn is a confident number about an incomplete patch. */}
            {`파일 ${artifact.files.length}개 · +${formatCount(artifact.additions)} −${formatCount(
              artifact.deletions,
            )}${provisional ? ' (아직 확정 아님)' : ''}`}
          </Text>
          {artifact.files.slice(0, 6).map(file => (
            <View key={file.id} style={styles.fileRow}>
              <Text style={styles.filePath} numberOfLines={1} ellipsizeMode="head">
                {file.path}
              </Text>
              <Text style={styles.fileCounts}>
                {`+${file.additions} −${file.deletions}`}
              </Text>
            </View>
          ))}
          {omittedFileCount(artifact) > 0 ? (
            <Text style={styles.cardMeta}>
              {`그리고 파일 ${omittedFileCount(artifact)}개 더`}
            </Text>
          ) : null}
          {isTruncated(artifact) ? (
            <Text style={styles.cardMeta}>
              {`너무 길어 ${formatCount(artifact.displayedLineCount)}줄만 표시했습니다. 전체는 ${formatCount(
                artifact.totalLineCount,
              )}줄입니다.`}
            </Text>
          ) : null}
        </>
      ) : null}

      {artifact.kind === 'oversized' ? (
        <Text style={styles.cardMeta}>
          {`변경이 너무 큽니다 — ${formatCount(artifact.totalLineCount)}줄. 데스크톱 앱에서 열어 보세요.`}
        </Text>
      ) : null}

      {artifact.kind === 'commit' || artifact.kind === 'pr' ? (
        <View>
          {artifact.repository ? (
            <Text style={styles.cardMeta}>{artifact.repository}</Text>
          ) : null}
          {artifact.branch ? (
            <Text style={styles.cardMeta}>{artifact.branch}</Text>
          ) : null}
          {artifact.url ? (
            <Text style={styles.cardLink} numberOfLines={1}>
              {artifact.url}
            </Text>
          ) : null}
          {artifact.urlRejected ? (
            <Text style={[styles.cardNote, styles.cardNoteDanger]}>
              {`믿을 수 없는 주소라 링크를 열지 않습니다${
                artifact.rejectedHost ? ` (${artifact.rejectedHost})` : ''
              }.`}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ---- the message row --------------------------------------------------------

/** What a row can do, supplied by the surface that owns the state. */
export interface MessageRowActions {
  myMemberId: string;
  /** Optimistic in the hook; rejects with the error the row turns into a line. */
  onToggleReaction: (message: Message, emoji: string) => Promise<void>;
  onEdit: (message: Message, body: string) => Promise<void>;
  onDelete: (message: Message) => Promise<void>;
  /**
   * Open this message's thread. Absent when there is nowhere to open — inside a
   * thread already, or on a surface with no thread panel. A rollup with no
   * handler renders as a LABEL rather than a dead button (QA P3 1-1).
   */
  onOpenThread?: (message: Message) => void;
  /** The gesture was used at least once, so the hint can retire itself. */
  onLongPressUsed?: () => void;
}

export function MessageRow({
  message,
  startsGroup,
  directory,
  chips,
  pausedRepeat,
  nowMs,
  onResend,
  actions,
  rollup: rollupOverride,
  replyParent,
}: {
  message: Message;
  startsGroup: boolean;
  directory: Directory;
  chips: ReactionChip[];
  /** This paused-agent notice stands in for N of them (core folded the rest). */
  pausedRepeat?: number;
  nowMs: number;
  /** A server-stored `failed` row offers a fresh send, not a replay. */
  onResend?: (message: Message) => void;
  /** Absent on read-only surfaces (the measurement harness, search previews). */
  actions?: MessageRowActions;
  /**
   * The reply rollup to draw, folded from the server's and this client's own
   * (`threadContext.rollupFor`). Absent on a surface that has no list around it
   * — then the server's is all there is, which is what this row used to use
   * unconditionally and why replying looked like it did nothing.
   */
  rollup?: ThreadRollup | null;
  /**
   * The message this one answers. `undefined` on a surface that does not mark
   * replies (inside a thread every row is one, so saying so on each is noise);
   * `null` when this IS a reply whose root is not loaded — the row then says
   * 답글 without claiming to know to whom.
   */
  replyParent?: Message | null;
}): React.JSX.Element {
  const presentation = useMemo(() => rowPresentation(message), [message]);
  const deleted = message.state === 'deleted';
  const rollup =
    rollupOverride === undefined ? threadRollup(message) : rollupOverride;
  const body = message.body ?? '';
  // A reply, on a surface that marks them. The parent may still be unknown.
  const isMarkedReply =
    replyParent !== undefined && message.rootId !== undefined;

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  // One slot for the failures with nowhere else to sit (a reaction, a delete).
  // A Korean sentence, never the wire string, and never a toast — the reason
  // belongs beside the message it is about (B8 + B11).
  const [rowError, setRowError] = useState<string | null>(null);

  // The four answers come from the core, which is also where the server's rules
  // are mirrored: only the author may edit or delete, nobody acts on a tombstone,
  // and a reply is never offered a reply of its own (momo threads are one level).
  const available = useMemo<MessageActionAvailability>(
    () => ({
      reply:
        actions?.onOpenThread !== undefined && canReplyToMessage(message),
      react: actions !== undefined && canReactToMessage(message),
      edit: actions !== undefined && canEditMessage(message, actions.myMemberId),
      delete:
        actions !== undefined && canDeleteMessage(message, actions.myMemberId),
    }),
    [actions, message],
  );
  const actionable = actions !== undefined && hasAnyAction(available);

  const openSheet = useCallback(() => {
    setRowError(null);
    setSheetOpen(true);
    actions?.onLongPressUsed?.();
  }, [actions]);

  const longPress = useLongPress({enabled: actionable, onFire: openSheet});

  const toggleReaction = useCallback(
    (emoji: string) => {
      if (!actions) return;
      setRowError(null);
      void actions.onToggleReaction(message, emoji).catch((error: unknown) => {
        setRowError(reactionFailureMessage(error));
      });
    },
    [actions, message],
  );

  const onChipPress = useCallback(
    (emoji: string) => {
      // The tap that follows a long press belongs to the gesture that opened the
      // sheet, not to the chip underneath the finger.
      if (longPress.consumeTap()) return;
      toggleReaction(emoji);
    },
    [longPress, toggleReaction],
  );

  const onAccessibilityAction = useCallback(
    (event: {nativeEvent: {actionName: string}}) => {
      switch (event.nativeEvent.actionName) {
        case 'activate':
        case 'momoActions':
          if (actionable) openSheet();
          return;
        case 'momoThread':
          if (rollup && actions?.onOpenThread) actions.onOpenThread(message);
          return;
        default:
      }
    },
    [actionable, openSheet, rollup, actions, message],
  );

  // VoiceOver reaches the actions through the rotor rather than through a row
  // full of buttons — the iOS answer to "one tab stop per row" (web R2 H1).
  const accessibilityActions = useMemo(() => {
    const list: {name: string; label: string}[] = [];
    if (actionable) list.push({name: 'momoActions', label: '메시지 액션'});
    if (rollup && actions?.onOpenThread) {
      list.push({name: 'momoThread', label: '스레드 열기'});
    }
    return list.length > 0 ? list : undefined;
  }, [actionable, rollup, actions]);

  const authorLabel = memberNameParts(
    directory,
    message.authorMemberId,
    UNKNOWN_MEMBER,
  ).name;

  const tail = [
    !deleted && message.state === 'edited' ? '수정됨' : null,
    rollup
      ? `답글 ${rollup.replyCount}개 · 마지막 ${relativeLabel(
          rollup.lastReplyAtMs,
          nowMs,
        )}`
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <View
      // ONE accessibility element per row. Grouping is what keeps the chips, the
      // thread anchor and the resend button from each becoming their own stop —
      // the same count the web client cut from 6 to 1. Touch is unaffected:
      // grouping changes the accessibility tree, not the responder tree.
      accessible
      accessibilityLabel={rowAccessibilityLabel({
        message,
        authorLabel,
        chips,
        tail,
        deleted,
        replyTo:
          isMarkedReply && !deleted
            ? replyParent === null
              ? '답글'
              : `${
                  memberNameParts(
                    directory,
                    replyParent.authorMemberId,
                    UNKNOWN_MEMBER,
                  ).name
                }님에게 답글`
            : null,
      })}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={[styles.row, startsGroup && styles.rowStartsGroup]}
      testID="message-row"
      {...longPress.handlers}>
      <Pressable
        // No `onPress`: a tap on a message does nothing yet, and inventing a
        // destination for it would be a second gesture competing with this one.
        onLongPress={longPress.onLongPress}
        delayLongPress={longPress.delayLongPress}
        disabled={!actionable}
        style={({pressed}) => [styles.rowInner, pressed && actionable && styles.rowPressed]}
        testID="message-press">
        {startsGroup ? (
          <Author
            directory={directory}
            memberId={message.authorMemberId}
            atMs={message.createdAtMs}
          />
        ) : null}

        {/* 답글 표식 (성재: "답글 모양 아이콘과 함께 별도로 안 보이는 거 같아").
            본문 **위**에 온다 — 맥락은 내용보다 먼저 읽혀야 이 줄이 무엇에 대한
            답인지 알고 본문을 읽는다. 삭제된 행에는 붙이지 않는다: 묘비는
            메시지에 대한 서술이지 메시지가 아니다. */}
        {isMarkedReply && !deleted ? (
          <ReplyMarker
            parent={replyParent ?? null}
            directory={directory}
            onOpen={
              replyParent && actions?.onOpenThread
                ? () => {
                    if (longPress.consumeTap()) return;
                    actions.onOpenThread?.(replyParent);
                  }
                : undefined
            }
          />
        ) : null}

        {deleted ? (
          // Meta size, not body size, and never through a body renderer: a
          // tombstone is a statement ABOUT a message, not a message. Web R2 M5
          // set this in body size and leading, and at a glance it read as
          // content — it keeps its place and gives up its weight.
          <Text style={styles.tombstone} testID="tombstone">
            삭제된 메시지
          </Text>
        ) : (
          <>
            {presentation.keepsBody && body !== '' ? (
              body.includes('```') ? (
                <CodeBlock text={body} />
              ) : (
                <Text
                  style={styles.body}
                  // Selectable ONLY where no gesture wants the same press. iOS
                  // text selection is itself a long press, so on an actionable
                  // row the two fight and the loser is whichever the OS decides
                  // — a magnifier appearing over the action sheet. Where there
                  // is no sheet to open there is nothing to fight, so those rows
                  // keep their copy. (A 복사 action needs a clipboard native
                  // module; RN's own is deprecated and warns on every access.)
                  selectable={!actionable}>
                  {body}
                </Text>
              )
            ) : null}

            {presentation.artifact ? (
              <ArtifactCard
                artifact={presentation.artifact}
                state={presentation.artifactState}
              />
            ) : presentation.card ? (
              <AgentCard card={presentation.card} />
            ) : null}

            {presentation.keepsBody &&
            body === '' &&
            !presentation.card &&
            !presentation.artifact ? (
              <Text style={styles.tombstone}>내용 없는 메시지</Text>
            ) : null}
          </>
        )}

        {pausedRepeat !== undefined && pausedRepeat > 1 ? (
          <Text style={styles.cardMeta}>
            {`응답하지 못한 메시지 ${pausedRepeat}개`}
          </Text>
        ) : null}

        {/* The tail is ONE line (web R2 M6). R1 gave 「수정됨」 and 「답글 N개」 a
            band each, so a one-line message wore a taller tail than itself. The
            chips keep their own line because they are pressed; these two are
            read, so they sit together. */}
        {tail.length > 0 ? (
          <View style={styles.tailRow}>
            {!deleted && message.state === 'edited' ? (
              <Text style={styles.edited} testID="edited-mark">
                수정됨
              </Text>
            ) : null}
            {rollup ? (
              actions?.onOpenThread ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="스레드 열기"
                  hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}
                  onPress={() => {
                    if (longPress.consumeTap()) return;
                    actions.onOpenThread?.(message);
                  }}
                  style={({pressed}) => [pressed && styles.pressed]}
                  testID="thread-rollup">
                  <Text style={styles.rollupLink}>
                    {`답글 ${rollup.replyCount}개 · 마지막 ${relativeLabel(
                      rollup.lastReplyAtMs,
                      nowMs,
                    )}`}
                  </Text>
                </Pressable>
              ) : (
                // A label, not a button: a door to a room that does not exist is
                // worse than a sentence saying the room is there.
                <Text style={styles.rollup} testID="thread-rollup">
                  {`답글 ${rollup.replyCount}개 · 마지막 ${relativeLabel(
                    rollup.lastReplyAtMs,
                    nowMs,
                  )}`}
                </Text>
              )
            ) : null}
          </View>
        ) : null}

        {message.state === 'failed' ? (
          <View style={styles.failedRow}>
            <Text style={styles.failedText}>전송 실패</Text>
            {onResend ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="다시 보내기"
                onPress={() => onResend(message)}
                style={({pressed}) => [styles.resend, pressed && styles.pressed]}
                testID="message-resend">
                <Text style={styles.resendLabel}>다시 보내기</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <Chips chips={chips} onToggle={actions ? onChipPress : undefined} />

        {rowError ? (
          // The optimistic change has already gone back to where it was; this is
          // the reason, on the row it belongs to.
          <View style={styles.rowFailure} testID="message-action-error">
            <Text style={styles.rowFailureText}>{rowError}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="오류 닫기"
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
              onPress={() => setRowError(null)}
              testID="message-action-error-dismiss">
              <Text style={styles.rowFailureDismiss}>닫기</Text>
            </Pressable>
          </View>
        ) : null}
      </Pressable>

      {sheetOpen && actions ? (
        <MessageActionSheet
          message={message}
          chips={chips}
          availability={available}
          authorLabel={authorLabel}
          deletePending={deletePending}
          onClose={() => setSheetOpen(false)}
          onToggleReaction={emoji => {
            setSheetOpen(false);
            toggleReaction(emoji);
          }}
          onReply={() => {
            setSheetOpen(false);
            actions.onOpenThread?.(message);
          }}
          onEdit={() => {
            setSheetOpen(false);
            setEditError(null);
            setEditing(true);
          }}
          onDelete={() => {
            setDeletePending(true);
            setRowError(null);
            void actions
              .onDelete(message)
              .then(() => setSheetOpen(false))
              .catch((error: unknown) => {
                setRowError(deleteFailureMessage(error));
                setSheetOpen(false);
              })
              .finally(() => setDeletePending(false));
          }}
        />
      ) : null}

      {editing && actions ? (
        <MessageEditorSheet
          initialBody={body}
          pending={editPending}
          error={editError}
          onCancel={() => setEditing(false)}
          onSave={next => {
            setEditPending(true);
            setEditError(null);
            void actions
              .onEdit(message, next)
              .then(() => setEditing(false))
              .catch((error: unknown) => setEditError(editFailureMessage(error)))
              .finally(() => setEditPending(false));
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * The whole row as one sentence, because the row is one accessibility element.
 *
 * Exported for the test that counts what VoiceOver would say — a label assembled
 * inline is a label nobody checks.
 */
export function rowAccessibilityLabel({
  message,
  authorLabel,
  chips,
  tail,
  deleted,
  replyTo,
}: {
  message: Message;
  authorLabel: string;
  chips: ReactionChip[];
  tail: string[];
  deleted: boolean;
  /**
   * What the 답글 marker says, when the row is drawing one. It comes FIRST,
   * before the body, for the same reason it is drawn above the body: a reader
   * who hears the answer before the question has to go back for the context.
   */
  replyTo?: string | null;
}): string {
  const parts = [
    authorLabel,
    timeLabel(message.createdAtMs),
    replyTo ?? '',
    deleted ? '삭제된 메시지' : (message.body ?? '').trim(),
    ...tail,
    ...chips.map(
      chip => `${chip.emoji} 반응 ${chip.count}개${chip.mine ? ', 내 반응' : ''}`,
    ),
  ];
  return parts.filter(part => part !== '').join(', ');
}

/** A local echo: on screen the instant it is sent, with no seq and no clock. */
export function PendingRow({
  pending,
  startsGroup,
  directory,
  onResend,
}: {
  pending: PendingMessage;
  startsGroup: boolean;
  directory: Directory;
  onResend?: (clientMsgId: string) => void;
}): React.JSX.Element {
  const failed = pending.status === 'failed';
  return (
    <View
      style={[styles.row, startsGroup && styles.rowStartsGroup]}
      testID="pending-row">
      {startsGroup ? (
        <Author
          directory={directory}
          memberId={pending.authorMemberId}
          atMs={pending.createdAtMs}
        />
      ) : null}
      {/* Same body style as a confirmed row, dimmed: the text must not re-flow
          when the server's copy replaces this one. */}
      <Text style={[styles.body, styles.bodyPending]} selectable>
        {pending.body}
      </Text>
      {failed ? (
        <View style={styles.failedRow}>
          <Text style={styles.failedText}>전송 실패</Text>
          {onResend ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="다시 보내기"
              onPress={() => onResend(pending.clientMsgId)}
              style={({pressed}) => [styles.resend, pressed && styles.pressed]}
              testID="pending-resend">
              <Text style={styles.resendLabel}>다시 보내기</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <Text style={styles.sending} testID="pending-sending">
          전송 중
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // The padding lives on the inner pressable so the press highlight covers the
  // whole row rather than a box floating inside it.
  row: {},
  rowInner: {paddingHorizontal: SAFE_GUTTER, paddingVertical: 3, gap: 2},
  // Feedback that the row is interactive at all. On a phone this is one of the
  // few honest signals that a gesture exists, and it costs no vertical space.
  rowPressed: {backgroundColor: color.surface},
  rowStartsGroup: {paddingTop: space.md},
  authorRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.xs,
    flexWrap: 'wrap',
  },
  authorName: {fontSize: font.label, fontWeight: '700', color: color.text},
  authorNameAgent: {color: color.agent},
  authorHandle: {fontSize: font.meta, color: color.textFaint},
  authorMeta: {fontSize: font.meta, color: color.textFaint},
  agentTag: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.sm,
    backgroundColor: '#2a2136',
  },
  agentTagText: {fontSize: 10, color: color.agent, fontWeight: '600'},
  time: {fontSize: font.meta, color: color.textFaint},
  body: {fontSize: font.body, color: color.text, lineHeight: 22},
  bodyPending: {color: color.textMuted},
  tombstone: {fontSize: font.label, color: color.textFaint, fontStyle: 'italic'},
  edited: {fontSize: font.meta, color: color.textFaint},
  tailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
    paddingTop: 2,
  },
  rollup: {fontSize: font.meta, color: color.textFaint},
  rollupLink: {fontSize: font.meta, color: color.accentText, fontWeight: '600'},
  // Meta size, like the tail: this is a statement ABOUT the message, and it must
  // not compete with the message for the eye.
  replyMark: {fontSize: font.meta, color: color.textFaint},
  replyMarkLink: {fontSize: font.meta, color: color.textMuted},
  rowFailure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.dangerBorder,
    backgroundColor: color.dangerSurface,
  },
  rowFailureText: {flex: 1, fontSize: font.meta, color: '#f0b4b8', lineHeight: 17},
  rowFailureDismiss: {fontSize: font.meta, color: color.textMuted, fontWeight: '600'},
  sending: {fontSize: font.meta, color: color.textFaint},
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingTop: 2,
    flexWrap: 'wrap',
  },
  failedText: {fontSize: font.meta, color: color.danger},
  resend: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.dangerBorder,
  },
  resendLabel: {fontSize: font.label, color: color.danger, fontWeight: '600'},
  pressed: {opacity: 0.6},

  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.md,
  },
  dividerLine: {flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: color.border},
  dividerLineWarn: {backgroundColor: color.warn},
  dividerLabel: {fontSize: font.meta, color: color.textFaint},
  dividerLabelWarn: {color: color.warn, fontWeight: '600'},

  chipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, paddingTop: space.xs},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // 32 in layout, 44 to a thumb via `hitSlop`. See the note on `Chips`.
    minHeight: 32,
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  chipMine: {borderColor: color.accent, backgroundColor: '#1a2740'},
  chipPressed: {backgroundColor: color.surfacePressed},
  chipEmoji: {fontSize: font.label},
  chipCount: {fontSize: font.meta, color: color.textMuted, fontWeight: '600'},
  chipCountMine: {color: color.accentText},

  card: {
    marginTop: space.xs,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    gap: space.xs,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  cardTitle: {flex: 1, fontSize: font.label, fontWeight: '700', color: color.text},
  cardBody: {fontSize: font.label, color: color.text, lineHeight: 19},
  cardNote: {fontSize: font.meta, color: color.textMuted, lineHeight: 17},
  cardNoteDanger: {color: color.danger},
  cardMeta: {fontSize: font.meta, color: color.textFaint},
  cardLink: {fontSize: font.meta, color: color.accentText},
  detailRows: {gap: 2, paddingTop: space.xs},
  detailRow: {flexDirection: 'row', gap: space.sm},
  detailLabel: {fontSize: font.meta, color: color.textFaint, minWidth: 72},
  detailValue: {flex: 1, fontSize: font.meta, color: color.textMuted},
  fileRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  filePath: {flex: 1, fontSize: font.meta, color: color.textMuted},
  fileCounts: {fontSize: font.meta, color: color.textFaint},

  statusChip: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  statusChip_ok: {borderColor: color.okBorder, backgroundColor: color.okSurface},
  statusChip_warn: {borderColor: '#4a3a1c', backgroundColor: '#241d0f'},
  statusChip_danger: {borderColor: color.dangerBorder, backgroundColor: color.dangerSurface},
  statusChip_muted: {borderColor: color.border, backgroundColor: color.surfacePressed},
  statusChipText: {fontSize: 11, fontWeight: '600'},
  statusChipText_ok: {color: color.ok},
  statusChipText_warn: {color: color.warn},
  statusChipText_danger: {color: color.danger},
  statusChipText_muted: {color: color.textMuted},

  codeScroll: {
    marginTop: space.xs,
    borderRadius: radius.sm,
    backgroundColor: '#0b0d11',
    borderWidth: 1,
    borderColor: color.border,
  },
  codeContent: {padding: space.sm},
  code: {
    fontFamily: 'Menlo',
    fontSize: font.meta,
    color: color.textMuted,
    lineHeight: 17,
  },
});
