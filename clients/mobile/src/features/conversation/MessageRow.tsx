import {threadRollup, type Message} from '@momo/core/lib/api';
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
import type {PendingMessage} from '@momo/core/features/timeline/model';
import type {ReactionChip} from '@momo/core/features/timeline/reactions';
import React, {useMemo} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from '../../design/tokens';

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

function Chips({chips}: {chips: ReactionChip[]}): React.JSX.Element | null {
  if (chips.length === 0) return null;
  return (
    <View style={styles.chipRow} testID="reaction-chips">
      {chips.map(chip => (
        <View
          key={chip.emoji}
          style={[styles.chip, chip.mine && styles.chipMine]}
          accessibilityLabel={`${chip.emoji} ${chip.count}개${chip.mine ? ', 내가 남김' : ''}`}>
          <Text style={styles.chipEmoji}>{chip.emoji}</Text>
          <Text style={[styles.chipCount, chip.mine && styles.chipCountMine]}>
            {chip.count}
          </Text>
        </View>
      ))}
    </View>
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

export function MessageRow({
  message,
  startsGroup,
  directory,
  chips,
  pausedRepeat,
  nowMs,
  onResend,
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
}): React.JSX.Element {
  const presentation = useMemo(() => rowPresentation(message), [message]);
  const deleted = message.state === 'deleted';
  const rollup = threadRollup(message);
  const body = message.body ?? '';

  return (
    <View
      style={[styles.row, startsGroup && styles.rowStartsGroup]}
      testID="message-row">
      {startsGroup ? (
        <Author
          directory={directory}
          memberId={message.authorMemberId}
          atMs={message.createdAtMs}
        />
      ) : null}

      {deleted ? (
        // Meta size, not body size, and never through a body renderer: a
        // tombstone is a statement ABOUT a message, not a message.
        <Text style={styles.tombstone} testID="tombstone">
          삭제된 메시지
        </Text>
      ) : (
        <>
          {presentation.keepsBody && body !== '' ? (
            body.includes('```') ? (
              <CodeBlock text={body} />
            ) : (
              <Text style={styles.body} selectable>
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

          {presentation.keepsBody && body === '' && !presentation.card && !presentation.artifact ? (
            <Text style={styles.tombstone}>내용 없는 메시지</Text>
          ) : null}
        </>
      )}

      {pausedRepeat !== undefined && pausedRepeat > 1 ? (
        <Text style={styles.cardMeta}>
          {`응답하지 못한 메시지 ${pausedRepeat}개`}
        </Text>
      ) : null}

      {rollup ? (
        // A label, not a button: the thread panel is the next batch, and a row
        // that offers a door to a room that does not exist is worse than one
        // that states the room is there.
        <Text style={styles.rollup} testID="thread-rollup">
          {`답글 ${rollup.replyCount}개 · 마지막 ${relativeLabel(
            rollup.lastReplyAtMs,
            nowMs,
          )}`}
        </Text>
      ) : null}

      {!deleted && message.state === 'edited' ? (
        <Text style={styles.edited} testID="edited-mark">
          수정됨
        </Text>
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

      <Chips chips={chips} />
    </View>
  );
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
  row: {paddingHorizontal: SAFE_GUTTER, paddingVertical: 3, gap: 2},
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
  rollup: {fontSize: font.meta, color: color.accentText, paddingTop: 2},
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
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  chipMine: {borderColor: color.accent, backgroundColor: '#1a2740'},
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
