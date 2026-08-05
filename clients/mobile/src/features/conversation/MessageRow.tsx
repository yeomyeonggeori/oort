import {threadRollup, type Message, type ThreadRollup} from '@momo/core/lib/api';
import {
  dayDividerLabel,
  dayDividerSegments,
  recoveryDividerSegments,
  unreadDividerSegments,
  DIVIDER_SPACE,
  ROW_SPACE,
  type DividerSegment,
  type RecoverySource,
} from '@momo/core/features/timeline/divider';
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
import {canQuoteMessage} from '@momo/core/features/timeline/quote';
import type {QuoteBlock as QuoteBlockModel} from '@momo/core/features/timeline/quote';
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
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Keyboard, Pressable, StyleSheet, Text, View} from 'react-native';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from '../../design/tokens';
import {COPY_RECEIPT_MS, copyText} from './copy';
import {MessageBody, bodyAffordances, openLink} from './MessageBody';
import {MessageActionSheet} from './MessageActionSheet';
import {MessageEditorSheet} from './MessageEditorSheet';
import {appNote} from './appVoice';
import {
  deadlinePassed,
  gateFor,
  type ApprovalGate,
  type ApprovalReceipt,
} from './approvalGate';

/** 표가 없는 표면(측정 하네스·검색 미리보기)에서 매번 새 Map 을 짓지 않으려고. */
const EMPTY_GATES: ReadonlyMap<string, ApprovalGate> = new Map();
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import {ApprovalDecision} from '../inbox/ApprovalDecision';
import {APPROVAL_OFFLINE_COPY} from '../inbox/useOnline';
import {QuoteBlock, quoteAccessibilityPhrase} from './Quote';
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
// ## 본문은 이 파일의 것이 아니다 (goal U4-a / #1048)
//
// 본문 렌더는 `MessageBody.tsx` 로 나갔다. 그 전까지 이 자리에는 이런 분기가
// 있었다:
//
//   body.includes('```') ? <CodeBlock text={body} /> : <Text>{body}</Text>
//
// 그리고 이 머리말에는 그것을 정당화하는 문단이 있었다 — *"전체 트리를 RN 에서
// 걷는 것은 이 배치가 함께 측정할 수 없고, 반쯤 걷다 모르는 부분을 버리는 트리는
// 메시지 내용을 조용히 지운다. 완전한 텍스트가 부분적인 마크업을 이긴다."*
//
// **그 판단이 실측으로 틀렸다.** U1 감사가 실기기에서 찍은 것(`md-01`)은
// 「마크업이 좀 덜 예쁘다」가 아니었다: 기술 답변에는 코드 펜스가 거의 항상 있고
// 분기 조건이 `includes('```')` 였으므로, **에이전트의 답 전체가 하나의 모노스페이스
// 상자**로 들어갔다 — 한국어 산문이 12px Menlo 로 조판되고, 셸 명령은 가로로
// 잘리고, `#` 와 별표와 펜스 마커가 글자로 남았다. 즉 옛 분기가 지키려던 바로 그
// 것(내용을 잃지 않는 것)을 옛 분기가 깨고 있었다.
//
// 부분적으로 걷는다는 걱정도 근거가 없었다: 코어 파서의 `Block`·`Inline` 은 닫힌
// 합집합이라 렌더러가 **모든** 갈래를 다루는지 컴파일러가 센다.
//
// ## Reactions are shown, not offered
//
// The chips render counts and whether I am in them, and they are NOT pressable
// in this batch: 메시지 액션 is the next one. A chip that looks like a button
// and does nothing is worse than a chip that looks like a label, so they are
// drawn as labels — no press feedback, no button role, nothing for a thumb to
// aim at and be refused by.
// =============================================================================

const UNKNOWN_MEMBER = '알 수 없는 멤버';

/**
 * 연속 행 오른쪽 시각 칸 (감사 H-3).
 *
 * `09:01` 다섯 글자가 `font.meta` 로 들어가는 폭. 고정 폭에 오른쪽 정렬이라
 * 시각들이 한 줄에 서고, 그래서 눈이 그 칸을 **읽지 않기로** 정할 수 있다 —
 * 매 줄 다른 자리에 있으면 매번 다시 봐야 한다.
 */
const TIME_COLUMN = 34;

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

/**
 * 라벨 조각을 그린다. `figure` 만 자릿폭을 고정한다 (코어의 `DividerSegment`).
 *
 * 「3개」의 `3` 은 figure 이고 `개` 는 prose 다 — 조사와 단위는 한글이라, 같은
 * 표지를 함께 받으면 음절 사이가 벌어진다. 판정은 코어가 하고 여기서는 칠한다.
 */
function DividerLabel({
  segments,
  tone,
}: {
  segments: readonly DividerSegment[];
  tone?: 'warn';
}): React.JSX.Element {
  return (
    <Text style={[styles.dividerLabel, tone === 'warn' && styles.dividerLabelWarn]}>
      {segments.map((segment, index) =>
        segment.kind === 'figure' ? (
          <Text key={index} style={styles.dividerFigure}>
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}

/**
 * 하루가 바뀌는 자리.
 *
 * ## 문구도 배치도 코어가 정한다 (감사 H-4·M-2)
 *
 * 첫 판은 `${y}년 ${m}월 ${d}일` 절대 표기 **고정**이었다. 오늘 대화를 보면서
 * 「2026년 8월 5일」을 읽고 그게 오늘인지 계산해야 했고, 아픈 것은 상대 표기
 * 함수가 **같은 파일에 이미 있었다**는 점이다(`relativeLabel` — 스레드 롤업만
 * 그걸 썼다).
 *
 * 그리고 배치가 웹과 달랐다(폰=가운데 라벨+양쪽 rule, 웹=좌측 라벨+우측 rule).
 * 통일값은 **`leading`** 이고 그 판정은 `divider.ts` 가 든다 — 가운데 라벨은
 * 글자 수(「오늘」 두 글자 ↔ 「2025년 12월 31일」 열두 글자)에 따라 좌우로
 * 움직여서, 같은 자리에 반복해 나타나야 할 표지가 매번 다른 x 에 선다.
 *
 * 보이는 글자와 **읽히는 글자가 다르다**: 라벨은 언제나 절대 날짜를 함께 말한다
 * (`dayDividerLabel`). 「오늘」은 눈에는 가장 값싼 낱말이지만 귀에는 어느 날인지
 * 알려주지 않는다.
 */
export function DayDivider({
  atMs,
  nowMs,
}: {
  atMs: number;
  nowMs: number;
}): React.JSX.Element {
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={dayDividerLabel(atMs, nowMs)}
      style={[styles.divider, styles.dividerDay]}
      testID="day-divider">
      <DividerLabel segments={dayDividerSegments(atMs, nowMs)} />
      <View style={styles.dividerLine} />
    </View>
  );
}

export function UnreadDivider({count}: {count: number}): React.JSX.Element {
  return (
    <View style={styles.divider} testID="unread-divider">
      <DividerLabel segments={unreadDividerSegments(count)} tone="warn" />
      <View style={[styles.dividerLine, styles.dividerLineWarn]} />
    </View>
  );
}

/**
 * 재연결 표지.
 *
 * ## 「(다시 읽음)」이 여기서 사라진 이유 (design-review D-1)
 *
 * 이 낱말은 **이 파일 안에서** 이어 붙던 것이었다. 그동안 웹은 같은 사실을
 * `data-source` 속성으로만 내보내 화면에는 한 글자도 없었고, 그래서 두 클라가
 * 복구 구분선에서 다른 문장을 말했다 — `divider.ts` 가 생긴 그 커밋이 어휘 판정
 * 하나를 로컬에 남긴 것이다.
 *
 * 이제 `source` 는 코어 `recoveryDividerSegments` 의 **필수 인자**다. 이 함수는
 * 조각 배열을 받아 칠하기만 하고, 붙일지 말지는 판정하지 않는다.
 */
export function RecoveryDivider({
  seq,
  source,
}: {
  seq: number;
  /** Which rail healed the gap. Stated, because they are not equally strong. */
  source: RecoverySource;
}): React.JSX.Element {
  return (
    <View style={styles.divider} testID="recovery-divider">
      <DividerLabel segments={recoveryDividerSegments(seq, source)} />
      <View style={styles.dividerLine} />
    </View>
  );
}

// ---- shared bits ------------------------------------------------------------

/**
 * 작성자 줄. **시각은 여기 없다** — 행이 오른쪽 한 칸으로 가져갔다(감사 H-3).
 *
 * 연속 행에 시각을 세우고 나니 같은 정보가 두 자리에 있었고, 그러면 눈이 매 줄
 * 어느 쪽을 볼지 다시 정해야 한다. 한 칸에 모으면 그 칸을 **안 보기로** 정할 수
 * 있다 — 그것이 이 배치가 산 것이다.
 */
function Author({
  directory,
  memberId,
}: {
  directory: Directory;
  memberId: string;
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
      {/* 시각은 여기 있었다. 행이 **오른쪽 한 칸**으로 가져갔다 (감사 H-3):
          연속 행에 시각을 세우고 나니 같은 정보가 두 자리에 있었고(머리 행은
          이름 옆, 연속 행은 오른쪽 끝), 그러면 눈이 매 줄 어느 쪽을 볼지 다시
          정해야 한다. 한 칸에 모으면 그 칸을 **안 보기로** 정할 수 있다. */}
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
 * The quote is the tempting version and it is wrong FOR THIS DEVICE: a thread
 * reply is about BELONGING (`root_id`), and belonging is answered by naming the
 * room and opening it. Drawing the parent's text here would double the height of
 * every reply and re-render text the reader can already scroll to. One
 * meta-sized line names the destination and opens it, which is the whole job —
 * and it keeps the density this product has.
 *
 * **This is not the argument against quoting** (ADR-0148 settled that: 인용 is a
 * different device and DOES draw the original). `reply_to_id` is AIM rather than
 * belonging, it stays in the main channel, and it exists precisely for the case
 * where the context has to come along. That block is `Quote.tsx`, it sits right
 * below this line, and the two are deliberately built to look nothing alike —
 * a line vs a block, an arrow vs a rule, 답글 vs 인용, another screen vs this one.
 * A row can carry both at once (ADR-0148 규칙 1: quoting one reply inside the
 * thread it belongs to), which is why they had to be told apart at a glance.
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

function AgentCard({
  card,
  approvalGates,
  approvalReceipts,
  approvalOffline,
  nowMs,
  onApprovalSettled,
}: {
  card: AgentCardModel;
  approvalGates?: ReadonlyMap<string, ApprovalGate>;
  approvalReceipts?: ReadonlyMap<string, ApprovalReceipt>;
  approvalOffline?: boolean;
  nowMs: number;
  onApprovalSettled?: (approvalId: string, outcome: DecisionOutcome) => void;
}): React.JSX.Element {
  if (card.kind === 'approval') {
    // 카드가 이미 파싱돼 있으므로 여기서 맞춰 본다 — 목록 쪽에서 하려면 이
    // 파싱을 한 번 더 해야 하고, 그것은 코어 규칙의 두 번째 구현이 된다.
    const approval = gateFor(card, approvalGates ?? EMPTY_GATES);
    const receipt =
      card.approvalId === null
        ? undefined
        : approvalReceipts?.get(card.approvalId);
    const settledStatus = receipt?.status ?? card.status;
    return (
      <View style={styles.card} testID="agent-card">
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {card.title}
          </Text>
          {/* 원장이 방금 답해 준 상태가 있으면 그것이 이긴다. 없으면 스냅샷.
              둘을 섞지 않는 이유는 사진이 잡아냈다 — 영수증이 「승인을
              기록했습니다」인데 칩이 「승인 대기」였다. */}
          <StatusChip
            label={APPROVAL_STATUS_LABEL[settledStatus]}
            tone={
              settledStatus === 'pending'
                ? 'warn'
                : settledStatus === 'approved'
                  ? 'ok'
                  : 'muted'
            }
          />
        </View>
        {card.summary ? <Text style={styles.cardBody}>{card.summary}</Text> : null}
        {/* =====================================================================
            여기 있던 문장은 이랬다 (감사 H-1):

              // 승인/거부 버튼은 이 배치가 아니다 — 결정은 데스크톱이나 인박스에서.
              <Text>이 결정은 인박스나 데스크톱 앱에서 처리할 수 있습니다.</Text>

            승인을 기다리는 에이전트가 **지금 이 화면에 있는데** 폰은 다른 앱으로
            가라고만 했다. 감사 캡처(`m-07`)에는 같은 카드 셋이 연달아 그 한 문장만
            반복한다.

            컨트롤은 새로 만들지 않는다 — 잠금화면 알림과 인박스가 이미 쓰는 것을
            그대로 부른다(세 번째 호출자). 결정 가능 여부는 `approval` 이 들고,
            그것을 누가 어떻게 판정하는지는 `approvalGate.ts` 머리말에 있다.

            영수증이 컨트롤보다 **먼저** 온다: 결정한 순간 그 승인은 대기 목록에서
            빠져 `approval` 이 `null` 이 되므로, 순서를 반대로 두면 방금 누른 사람이
            영수증 대신 예전 안내 문장을 보게 된다.
            ===================================================================== */}
        {receipt !== undefined ? (
          <Text style={styles.cardNote} testID="card-approval-receipt">
            {receipt.note}
          </Text>
        ) : approval && approvalOffline ? (
          // 결정할 수 있는 건인데 지금은 못 보낸다. 「다른 데서 하세요」와 다른
          // 문장이어야 한다 — 이건 자리의 문제가 아니라 **때**의 문제다.
          <Text style={styles.cardNote} testID="card-approval-offline">
            {APPROVAL_OFFLINE_COPY}
          </Text>
        ) : approval ? (
          <ApprovalDecision
            approvalId={approval.approvalId}
            reversible={approval.reversible}
            deadlinePassed={deadlinePassed(approval, nowMs)}
            onSettled={outcome =>
              onApprovalSettled?.(approval.approvalId, outcome)
            }
            testIDPrefix={`card-approval-${approval.approvalId}`}
          />
        ) : (
          <Text style={styles.cardNote}>
            이 결정은 인박스나 데스크톱 앱에서 처리할 수 있습니다.
          </Text>
        )}
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
            // BL-3 의 나머지 절반. 이 줄은 강조색만 링크이고 **동작이 없었다** —
            // 링크처럼 생긴 것이 링크가 아닌 것은 아무것도 없는 것보다 나쁘다.
            // 본문 링크와 같은 문을 쓴다(`openLink` — 코어 `safeHref` 재확인).
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`${artifact.url} 열기`}
              hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}
              onPress={() => openLink(artifact.url as string)}
              testID="artifact-link">
              <Text style={styles.cardLink} numberOfLines={1}>
                {artifact.url}
              </Text>
            </Pressable>
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

// =============================================================================
// 리렌더 계측 seam (goal RN-P2a / #997)
//
// 성능 주장은 **셀 수 있어야** 주장이다. 이 배치가 고치는 결함은 "화면이 다시
// 그려질 때마다 붙어 있는 모든 메시지 행이 통째로 다시 그려진다"이고, 그 수리를
// 잠그는 단정은 「신호가 한 번 갱신되면 메시지 행 리렌더 0회」다. 그 0을 밖에서
// 셀 방법은 없다 — `React.memo` 의 bail-out 은 정의상 부모에게 보이지 않고,
// 컴포넌트를 감싸서 세면 감싼 자리가 memo 바깥이라 언제나 호출된다.
//
// 그래서 계측은 안에 있다. 정수 하나 증가이므로 릴리스에서 잰 값은 0에 가깝고,
// 이 파일이 이미 들고 있는 다른 seam들(`anchorRef`·`metricsRef`·
// `agentWorkingSnapshot`)과 같은 종류의 것이다: 앱이 실제로 그리는 그 나무를
// 재는 자리.
// =============================================================================

let rowRenders = 0;

/** 이 프로세스가 시작된 뒤 그려진 `MessageRow` 본문의 수. */
export function messageRowRenderCount(): number {
  return rowRenders;
}

/** 계측 구간의 시작점. 테스트가 델타를 재기 위해 부른다. */
export function resetMessageRowRenderCount(): void {
  rowRenders = 0;
}

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
  /**
   * Quote this message: bind it to the composer as 인용, in the MAIN channel.
   *
   * Deliberately NOT `onOpenThread` with a flag. The two are different devices
   * (ADR-0148) and they go to different places — a thread is another screen, a
   * quote stays here — so folding them into one handler would be the first step
   * toward the surface treating them as one thing.
   */
  onQuote?: (message: Message) => void;
  /**
   * Scroll to the message this row quotes. ONE identity for the whole list (see
   * `quoteReachable`); the row hands back its own message and the surface reads
   * the target off it, because the row does not know what the page holds.
   */
  onJumpToQuoted?: (message: Message) => void;
  /** The gesture was used at least once, so the hint can retire itself. */
  onLongPressUsed?: () => void;
}

export interface MessageRowProps {
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
  /**
   * The message this one QUOTES (ADR-0148 `reply_to_id`), already resolved.
   *
   * A different device from `replyParent` and never a substitute for it — see
   * `ReplyMarker`'s header. `null`/`undefined` means this row quotes nothing.
   *
   * **The value rides the page.** The server LEFT JOINs the quoted row onto
   * every history page (`momo-messaging/src/message.rs:1062`), so the caller
   * unpacks what it already holds and this row never asks for anything. A row
   * that fetched its own quote would turn one scroll into a request storm,
   * hardest exactly when the conversation is busy.
   */
  quote?: QuoteBlockModel | null;
  /**
   * 이 행의 승인 카드를 **지금 결정할 수 있는가** (감사 H-1 / goal U4-g).
   *
   * `null`/`undefined` 면 컨트롤을 안 세운다. 왜 그 넷인지는 `approvalGate.ts`
   * 머리말이 든다 — 요약하면 카드는 메시지의 스냅샷이고 「지금 무엇이 참인가」는
   * 승인 원장만 안다.
   *
   * **값이 페이지를 타지 않는다.** 인용(`quote`)과 다른 점이 여기다: 인용은 서버가
   * 히스토리 페이지에 LEFT JOIN 해 주지만 승인의 기한·가역성은 그 페이지에 없다.
   * 그래서 화면이 대기 목록을 **한 번** 구독하고 행마다 나눠 준다 — 행이 스스로
   * 물으면 스크롤 한 번이 요청 폭풍이 된다.
   */
  approvalGates?: ReadonlyMap<string, ApprovalGate>;
  /**
   * 결정이 끝난 뒤 이 행이 말할 영수증. 화면이 든다.
   *
   * 행이 들 수 없는 이유: 결정하면 그 승인은 대기 목록에서 빠지고 `approval` 이
   * `null` 이 된다 — 즉 **컨트롤과 영수증은 같은 순간에 서로 반대로 움직인다**.
   * 영수증을 행의 상태로 두면 그 행이 목록에서 사라질 때 영수증도 함께 사라져,
   * 사람은 자기가 무엇을 했는지 못 본 채 카드가 조용히 바뀐 것만 본다.
   * (인박스가 이미 같은 이유로 화면에 둔다.)
   */
  approvalReceipts?: ReadonlyMap<string, ApprovalReceipt>;
  /**
   * 연결이 끊겼는가. 끊겼으면 컨트롤 대신 **인박스와 같은 문장**이 선다.
   *
   * 같은 결정 컨트롤이 화면마다 다른 오프라인 결을 가지면 어휘 분열이다. 판정은
   * 화면이 하고(`useOnline`), 문장은 두 화면이 같은 상수를 든다.
   */
  approvalOffline?: boolean;
  /** 결정을 원장에 보낸 뒤. 화면이 영수증을 만들고 목록을 무효화한다. */
  onApprovalSettled?: (approvalId: string, outcome: DecisionOutcome) => void;
}

/**
 * 로터가 읽을 링크 라벨.
 *
 * 여럿이면 **첫 개만** 올린다 — 스무 개짜리 답에 액션 스무 개를 얹으면 로터가
 * 그 자체로 못 쓸 물건이 되고, 그것은 「하나의 원소」 규칙을 다른 방식으로
 * 깨는 것이다. 대신 라벨이 **총 개수와 목적지**를 말한다: 첫 개만 준다는 사실도,
 * 어디로 가는지도 숨기지 않는다.
 *
 * 둘째 링크부터는 지금 닿을 길이 없다 — 알려진 한계이고 #1071 에 적었다.
 * (시트에 링크 절을 만드는 것이 후속 후보이지만 이 배치의 범위가 아니다.)
 */
function linkActionLabel(href: string, count: number): string {
  let host = '';
  try {
    host = new URL(href).host;
  } catch {
    host = '';
  }
  const where = host === '' ? '링크 열기' : `링크 열기: ${host}`;
  return count > 1 ? `첫 ${where} (총 ${count}개)` : where;
}

function MessageRowInner({
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
  quote,
  approvalGates,
  approvalReceipts,
  approvalOffline,
  onApprovalSettled,
}: MessageRowProps): React.JSX.Element {
  rowRenders += 1;
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
  // 「복사됨」 영수증 (design-review M-3). 실패 슬롯(`rowError`)과 나누는 이유는
  // 색과 뜻이 다르기 때문이다 — 이건 성공이고, 빨간 상자를 쓰면 안 된다.
  const [rowReceipt, setRowReceipt] = useState<string | null>(null);
  const receiptRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (receiptRef.current !== null) clearTimeout(receiptRef.current);
    },
    [],
  );
  const showReceipt = useCallback((text: string) => {
    setRowReceipt(text);
    if (receiptRef.current !== null) clearTimeout(receiptRef.current);
    receiptRef.current = setTimeout(() => setRowReceipt(null), COPY_RECEIPT_MS);
  }, []);

  // The five answers come from the core, which is also where the server's rules
  // are mirrored: only the author may edit or delete, nobody acts on a tombstone,
  // and a reply is never offered a reply of its own (momo threads are one level).
  const available = useMemo<MessageActionAvailability>(
    () => ({
      reply:
        actions?.onOpenThread !== undefined && canReplyToMessage(message),
      // 인용은 답글과 **다른 축**이다(core `model.ts`): 이미 답글인 행은 답글을
      // 더 달 수 없지만 인용은 할 수 있다. 두 답을 하나로 접으면 ADR-0148 이
      // 나눈 두 장치가 UI 에서 다시 합쳐진다.
      quote: actions?.onQuote !== undefined && canQuoteMessage(message),
      react: actions !== undefined && canReactToMessage(message),
      edit: actions !== undefined && canEditMessage(message, actions.myMemberId),
      delete:
        actions !== undefined && canDeleteMessage(message, actions.myMemberId),
    }),
    [actions, message],
  );
  const actionable = actions !== undefined && hasAnyAction(available);

  // ===========================================================================
  // 행 안의 컨트롤을 로터에 올린다 (design-review H-1)
  //
  // 이 행은 접근성 원소 **하나**다 — 웹에서 6→1 로 줄인 그 규칙이고, 그것을
  // 되돌리지 않는다. 그런데 이번 배치가 행 안에 누를 것을 넷 더 넣었고
  // (인용 점프·코드 복사·본문 링크·아티팩트 주소) 그중 셋은 **본문 안**에 있다.
  // 손가락은 닿는데 VoiceOver 는 못 닿았다.
  //
  // 답은 원소를 늘리는 것이 아니라 **행동을 등재**하는 것이다: 원소는 하나로
  // 두고 로터가 그 넷을 부른다.
  //
  // 파싱은 `bodyAffordances` 가 한 번 더 돈다. 그 비용이 감당되는 이유는 이 행이
  // `React.memo` 아래 있고 `body` 가 안 바뀌면 이 `useMemo` 도 안 돌기 때문이다 —
  // **프레임당이 아니라 메시지당 한 번**이다.
  // ===========================================================================
  const affordances = useMemo(() => bodyAffordances(body), [body]);

  const openSheet = useCallback(() => {
    setRowError(null);
    setSheetOpen(true);
    actions?.onLongPressUsed?.();
  }, [actions]);

  const longPress = useLongPress({enabled: actionable, onFire: openSheet});

  // ===========================================================================
  // 탭 = 이 행이 이미 열어 주는 문 (goal RN-U1 결함 2)
  //
  // 성재: "채팅을 일단 클릭하면 스레드처럼 거기서 바로 답글을 달 수 있게 해주고."
  //
  // 스레드로 가는 길은 롤업 버튼 하나뿐이었고, **답글이 없는 메시지에는 그 버튼이
  // 없다** — 즉 새 스레드를 시작하는 길이 길게 누르기 하나뿐이었다. 그것은 눈에
  // 보이지 않는 제스처이므로, 실제로는 길이 없었던 것에 가깝다.
  //
  // 목적지는 새로 만들지 않는다. 이 행이 **이미 그리고 있는 문**과 같은 곳으로
  // 간다: 루트는 자기 스레드로, 답글은 자기가 달린 스레드로(↳ 표식이 가는 곳과
  // 같다). 그래서 한 단계 규칙은 그대로다 — 답글을 탭해도 답글의 스레드가 생기지
  // 않고, 코어의 `canReplyToMessage` 가 거절하는 것을 화면이 제안하는 일도 없다.
  // 문이 없는 행(묘비, 루트를 못 불러온 답글)은 탭해도 아무 데도 가지 않는다.
  // ===========================================================================
  const threadTarget = useMemo<Message | null>(() => {
    if (!actions?.onOpenThread) return null;
    if (isMarkedReply) return deleted ? null : replyParent ?? null;
    // 롤업만 있고 답글을 새로 달 수 없는 루트(묘비)도 문은 문이다 — 그 행은
    // 「답글 N개」를 이미 눌리는 것으로 그리고 있다.
    return available.reply || rollup !== null ? message : null;
  }, [actions, isMarkedReply, deleted, replyParent, available.reply, rollup, message]);

  // ===========================================================================
  // 그리고 그 탭은 키보드와 다툰다 (결함 1 × 결함 2)
  //
  // 결함 1은 "메시지 영역을 탭하면 키보드가 내려가야 한다"고 하고, 결함 2는 같은
  // 탭에 스레드를 준다. 애매하게 두면 둘 다 안 된다: 닫으려고 누른 탭이 화면을
  // 하나 열어 버리면, 그것은 어포던스가 없는 것보다 나쁘다 — 실수의 대가가
  // 「아무 일도 안 일어남」에서 「길을 잃음」으로 커진다.
  //
  // **규칙: 키보드가 올라와 있으면 첫 탭은 닫기이고, 그 이상 아무것도 아니다.**
  // 내려가 있으면 탭은 스레드를 연다. 모드를 고르는 것은 숨은 상태가 아니라 화면의
  // 절반을 차지하고 있는 키보드 자체이므로, 사람은 자기가 어느 규칙 안에 있는지
  // 보면서 누른다. iOS 전체가 쓰는 관습이기도 하다.
  //
  // 시트의 「답글 달기」에는 이 판정이 없다. 메뉴에서 고른 것은 탭이 아니라 선택이고,
  // 고른 것을 "키보드를 닫으라는 뜻이었겠지"로 다시 해석하는 화면은 거짓말을 한다.
  //
  // `Keyboard.isVisible()` 은 `keyboardDidShow`/`DidHide` 로 유지되는 값이라
  // (RN `Keyboard.js`: `!!this._currentlyShowing`), 올라오는 250ms 동안에는 아직
  // false 다. 그 창에 들어온 탭은 스레드를 연다. 그것을 좁히려면 `willShow` 를
  // 따로 듣고 상태를 하나 더 들고 있어야 하는데, 그 상태는 모든 행이 지게 된다 —
  // 컴포저를 누른 손가락이 250ms 안에 메시지로 옮겨 가는 경우를 위해 타임라인
  // 전체의 렌더 비용을 올리는 것은 잘못된 거래다. 재현되면 그때 값을 치른다.
  // ===========================================================================
  const onRowPress = useCallback(() => {
    // 길게 눌러 시트를 연 손가락을 떼면 따라 울리는 탭. 그것은 이 제스처의 것이다.
    if (longPress.consumeTap()) return;
    if (Keyboard.isVisible()) {
      Keyboard.dismiss();
      return;
    }
    if (threadTarget) actions?.onOpenThread?.(threadTarget);
  }, [longPress, threadTarget, actions]);

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
          // VoiceOver 의 두 번 탭은 손가락의 탭과 같은 뜻이어야 한다. 문이 있으면
          // 그리로 가고, 없으면 예전처럼 시트를 연다.
          if (threadTarget) actions?.onOpenThread?.(threadTarget);
          else if (actionable) openSheet();
          return;
        case 'momoActions':
          if (actionable) openSheet();
          return;
        case 'momoThread':
          if (threadTarget) actions?.onOpenThread?.(threadTarget);
          return;
        case 'momoQuoteJump':
          actions?.onJumpToQuoted?.(message);
          return;
        case 'momoLink':
          if (affordances.firstLink) openLink(affordances.firstLink);
          return;
        case 'momoCopyCode':
          if (affordances.firstCode) void copyText(affordances.firstCode);
          return;
        case 'momoArtifactLink':
          if (presentation.artifact && 'url' in presentation.artifact) {
            const url = presentation.artifact.url;
            if (url) openLink(url);
          }
          return;
        default:
      }
    },
    [
      actionable,
      openSheet,
      threadTarget,
      actions,
      message,
      affordances,
      presentation.artifact,
    ],
  );

  // VoiceOver reaches the actions through the rotor rather than through a row
  // full of buttons — the iOS answer to "one tab stop per row" (web R2 H1).
  const accessibilityActions = useMemo(() => {
    const list: {name: string; label: string}[] = [];
    if (actionable) list.push({name: 'momoActions', label: '메시지 액션'});
    if (threadTarget) list.push({name: 'momoThread', label: '스레드 열기'});
    // 아래 넷이 H-1 이 더한 것이다. 묘비에는 하나도 붙지 않는다 — 지워진
    // 메시지에는 열 링크도 복사할 코드도 없다.
    if (!deleted) {
      if (quote && quote.kind !== 'unresolved' && actions?.onJumpToQuoted) {
        list.push({name: 'momoQuoteJump', label: '인용한 원본으로 이동'});
      }
      if (affordances.firstLink) {
        list.push({
          name: 'momoLink',
          label: linkActionLabel(affordances.firstLink, affordances.linkCount),
        });
      }
      if (affordances.firstCode) {
        list.push({
          name: 'momoCopyCode',
          label:
            affordances.codeCount > 1
              ? `첫 코드 복사 (총 ${affordances.codeCount}개)`
              : '코드 복사하기',
        });
      }
      if (presentation.artifact && 'url' in presentation.artifact
          && presentation.artifact.url) {
        list.push({name: 'momoArtifactLink', label: '아티팩트 주소 열기'});
      }
    }
    return list.length > 0 ? list : undefined;
  }, [
    actionable,
    threadTarget,
    deleted,
    quote,
    actions,
    affordances,
    presentation.artifact,
  ]);

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
        quoted:
          quote && !deleted
            ? quoteAccessibilityPhrase(quote, directory)
            : null,
      })}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={[styles.row, startsGroup && styles.rowStartsGroup]}
      testID="message-row"
      {...longPress.handlers}>
      <Pressable
        // The tap rule is above. The row stays pressable even when it has no
        // door and no actions (a tombstone), because with the keyboard up every
        // tap on the conversation means the same thing — put it away — and a row
        // that opted out of that would be a dead patch in the middle of it.
        onPress={actions ? onRowPress : undefined}
        onLongPress={longPress.onLongPress}
        delayLongPress={longPress.delayLongPress}
        disabled={actions === undefined}
        style={({pressed}) => [
          styles.rowInner,
          // 시각 칸의 예약은 **여기 한 곳**이다 (design-review M-1) — 아래
          // `rowTimeReserve` 주석이 왜 자식이 아니라 그릇인지 든다.
          styles.rowTimeReserve,
          pressed && actions !== undefined && styles.rowPressed,
        ]}
        testID="message-press">
        {startsGroup ? (
          <Author directory={directory} memberId={message.authorMemberId} />
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

        {/* 인용 블록 (ADR-0148). 표식 **아래**, 본문 **위** — 한 행이 둘 다 가질
            수 있고(규칙 1), 그때 읽히는 순서는 「어느 대화에 속하는가」 →
            「무엇을 가리키는가」 → 「무슨 말인가」다. 묘비에는 붙이지 않는다:
            지워진 메시지가 무엇을 인용했었는지는 그 메시지에 대한 사실이지
            묘비에 대한 사실이 아니다. */}
        {quote && !deleted ? (
          <QuoteBlock
            block={quote}
            directory={directory}
            // 목적지를 **아는** 인용에는 언제나 문을 준다 — 그 행이 지금 로드된
            // 범위 안에 있든 없든.
            //
            // 처음 판은 로드된 것만 눌리게 했고, 그것이 이 레포의 「없는 방으로
            // 가는 문은 짓지 않는다」를 잘못 적용한 것이었다. 여기서 **방은
            // 있다.** 아직 거기까지 안 걸어갔을 뿐이다. 그 경우에 아무 반응도 안
            // 주면 사람은 이유를 모른 채 막히고, 목록은 「더 위쪽에 있어 아직
            // 불러오지 않았습니다. 위로 올려 이어서 불러오세요」라고 말할 수
            // 있었는데 말하지 못한다 — 검색 앵커가 이미 같은 말을 하는 자리다.
            //
            // 정말로 목적지를 모르는 경우(`unresolved`)에만 문이 없고, 그 판정은
            // `QuoteBlock` 이 자기 갈래로 직접 한다.
            onJump={
              actions?.onJumpToQuoted
                ? () => {
                    if (longPress.consumeTap()) return;
                    actions.onJumpToQuoted?.(message);
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
            {appNote('삭제된 메시지')}
          </Text>
        ) : (
          <>
            {presentation.keepsBody && body !== '' ? (
              // 시각 칸의 여백은 여기 없다. 그릇(`rowTimeReserve`)이 진다 —
              // 본문에 걸어 두었더니 본문이 첫 자식이 아닌 행마다 구멍이었다
              // (design-review M-1).
              <MessageBody
                body={body}
                // ===================================================
                // 규칙: **모든 행에 텍스트를 꺼내는 길이 정확히 하나** (goal U4-b)
                //
                // iOS 의 텍스트 선택은 그 자체가 길게 누르기라, 시트가 있는 행에서
                // 둘은 같은 제스처를 다툰다 — 이기는 쪽을 OS 가 정하고, 지면 시트
                // 위로 돋보기가 올라온다. 그래서 예전 판은 시트가 있는 행의 선택을
                // 껐고, 시트에 복사도 없었으므로 **꺼낼 길이 0이 됐다**(BL-2).
                //
                // 이제 시트에 「메시지 복사」가 있다. 그러므로 이 행의 답은
                // 「선택을 켜서 둘이 다투게 한다」가 아니라 **「길이 시트에 있으므로
                // 선택은 끈다」** 이다. 시트가 없는 행(낙관적 메아리)만 선택을 갖고,
                // 그것은 비일관이 아니라 같은 규칙의 다른 답이다 — 감사가 지적한
                // 「보내는 중엔 선택되고 확인되면 꺼진다」가 이제 뜻을 갖는다.
                // ===================================================
                selectable={!actionable}
              />
            ) : null}

            {presentation.artifact ? (
              <ArtifactCard
                artifact={presentation.artifact}
                state={presentation.artifactState}
              />
            ) : presentation.card ? (
              <AgentCard
                card={presentation.card}
                approvalGates={approvalGates}
                approvalReceipts={approvalReceipts}
                approvalOffline={approvalOffline}
                nowMs={nowMs}
                onApprovalSettled={onApprovalSettled}
              />
            ) : null}

            {presentation.keepsBody &&
            body === '' &&
            !presentation.card &&
            !presentation.artifact ? (
              <Text style={styles.tombstone}>{appNote('내용 없는 메시지')}</Text>
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

        {rowReceipt ? (
          // 성공의 자리. 실패와 같은 상자를 쓰지 않는다 — 테두리도 danger 색도
          // 없고, 스스로 물러난다.
          <Text style={styles.rowReceipt} testID="message-copy-receipt">
            {rowReceipt}
          </Text>
        ) : null}

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

        {
          // ===================================================================
          // 행의 시각 (감사 H-3)
          //
          // 그룹 창은 **5분**이다(`AUTHOR_GROUP_WINDOW_MS`). 즉 한 그룹이 최대
          // 5분을 덮는데 그 안 개별 발화의 시각이 화면 어디에도 없었다 —
          // 「이 말 언제 한 거지?」에 답이 없다.
          //
          // 그런데 **접근성 라벨에는 모든 행의 시각이 들어 있다**
          // (`rowAccessibilityLabel`). 로터는 아는 것을 눈은 몰랐다. 즉 이
          // 정보가 값어치 있다는 판단은 이미 내려져 있었고, 빠진 것은 눈으로
          // 가는 길뿐이었다.
          //
          // 웹은 hover 로 준다. **폰에는 hover 가 없다** — 그래서 이 화면의
          // 선택지는 「항상」 아니면 「전혀」 둘뿐이고, 「전혀」가 지금 고장난
          // 쪽이다.
          //
          // ## 세로를 한 픽셀도 안 쓴다
          //
          // 줄을 하나 더 세우면 5연발에 80pt 가 사라진다. 대신 행의 첫 줄
          // 오른쪽 끝에 절대 위치로 앉히고, 그릇이 그만큼 오른쪽을 비워 둔다
          // (`rowTimeReserve`). 겹치지 않으면서 세로 비용이 0 이다.
          //
          // ## 흐름 자식 **뒤**에 그린다 (design-review M-1)
          //
          // RN 에는 z-index 기본값이 없다 — 형제는 **쓰인 순서대로** 칠해진다.
          // 이 `Text` 가 카드보다 앞에 있었을 때, 불투명한 `styles.card` 배경이
          // 그 위에 칠해져 시각이 조용히 사라질 수 있었다. 자리는 이제 여백이
          // 지키고 순서는 칠을 지킨다 — 둘 중 하나가 깨져도 나머지가 남는다.
          //
          // ## 보조기술에는 안 보인다
          //
          // 행 라벨이 이미 이 시각을 말한다. 여기서 또 하나의 원소를 세우면
          // 로터가 같은 사실을 두 번 읽는다 — 「행 하나 = 원소 하나」를 다른
          // 방식으로 깨는 것이다.
          // ===================================================================
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.rowTime}
            testID="row-time">
            {timeLabel(message.createdAtMs)}
          </Text>
        }
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
          onCopy={
            // 묘비에는 꺼낼 내용이 없다. `body` 가 비었을 때도 마찬가지 —
            // 빈 문자열을 클립보드에 넣는 것은 「복사했다」는 거짓말이다.
            !deleted && body !== ''
              ? () => {
                  setSheetOpen(false);
                  setRowError(null);
                  void copyText(body).then(ok => {
                    if (ok) showReceipt('복사됨');
                    else setRowError('복사하지 못했습니다.');
                  });
                }
              : undefined
          }
          onQuote={
            available.quote
              ? () => {
                  setSheetOpen(false);
                  actions.onQuote?.(message);
                }
              : undefined
          }
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

// =============================================================================
// 왜 이 행은 memo 되어야 하는가 (goal RN-P2a / #997, 측정으로 좁힌 결함)
//
// `FlatList` 은 이미 셀 단위로 bail-out 을 한다 — `CellRenderer` 는
// `React.PureComponent` 다(`@react-native/virtualized-lists/Lists/
// VirtualizedListCellRenderer.js:63`). 그런데 그 bail-out 은 `renderItem` 의
// **동일성**에 걸려 있고, 이 앱에서 그것이 매 렌더 바뀌고 있었다. 그래서 화면이
// 어떤 이유로든 다시 그려지면 붙어 있는 모든 셀이 `renderItem` 을 다시 부르고,
// memo 가 없는 이 함수는 본문 전체를 다시 실행했다. 턴이 열려 있는 동안에는 그
// 일이 **초당 한 번** 일어났다.
//
// `Timeline`/`ConversationScreen` 쪽에서 `renderItem` 동일성을 되찾는 것이 첫
// 수리이고, 이 memo 는 두 번째다. 둘 다 필요한 이유는 데이터가 진짜로 바뀔 때
// 갈리기 때문이다: 메시지가 하나 도착하면 `buildTimelineItems` 가 **모든** 항목
// 객체를 새로 만들므로 셀은 전부 다시 그려진다. 그때 실제로 달라진 행은 하나뿐인데,
// 이 비교가 없으면 화면에 있는 행 전부가 자기 하위 트리를 다시 조정한다.
//
// ## 비교가 얕지 않은 두 자리
//
// `chips` 와 `rollup` 은 렌더할 때마다 **새로 만들어지는** 값이다
// (`chipsFor` 는 새 배열을, `rollupFor` 는 새 객체를 돌려준다). 얕은 비교는 그
// 둘에서 언제나 실패하므로 `React.memo` 를 그냥 씌우면 아무것도 막지 못한다.
// 그래서 그 둘만 값으로 본다 — 필드 수가 고정이고(3개·3개) 개수가 한 자리라서,
// 이 비교는 행 하나를 다시 그리는 것보다 압도적으로 싸다.
//
// 나머지는 전부 동일성 비교다. 그것이 성립하려면 호출자가 핸들러를 안정적으로
// 넘겨야 하고(`actions`·`onResend`), 그것이 첫 수리의 내용이다.
// =============================================================================

function sameChips(a: ReactionChip[], b: ReactionChip[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].emoji !== b[i].emoji ||
      a[i].count !== b[i].count ||
      a[i].mine !== b[i].mine
    ) {
      return false;
    }
  }
  return true;
}

function sameRollup(
  a: ThreadRollup | null | undefined,
  b: ThreadRollup | null | undefined,
): boolean {
  if (a === b) return true;
  // `null`(이 표면에는 롤업이 없다)과 `undefined`(서버의 것을 쓰라)는 다른 뜻이다.
  if (a == null || b == null) return a === b;
  return (
    a.replyCount === b.replyCount &&
    a.lastReplySeq === b.lastReplySeq &&
    a.lastReplyAtMs === b.lastReplyAtMs
  );
}

/**
 * 비교자가 **본** prop 의 전수 목록 — 컴파일 타임 망라성 가드 (1R M2).
 *
 * 아래 비교자는 필드를 손으로 열거한다. 빠르고 읽히지만, 그 형태에는 조용한
 * 결함이 하나 붙어 있다: `MessageRowProps` 에 열한 번째 prop 이 생겨도 비교자는
 * **컴파일된다.** 그리고 그 순간 이 행은 그 prop 이 바뀌어도 다시 그려지지 않는
 * 행이 된다 — 성능 결함이 아니라 **정확성 결함**이고, 화면에는 옛 값이 남는다.
 * memo 의 무서운 점이 그것이다. 틀려도 조용하다.
 *
 * 그래서 목록을 따로 적는다. `Record<keyof MessageRowProps, true>` 는 prop 이
 * 하나 늘면 "속성이 없습니다"로 **빌드를 멈춘다.** 그때 이 파일을 열게 되고,
 * 이 주석이 다음 질문을 준다: 그 prop 은 동일성으로 충분한가, 아니면 `chips`·
 * `rollup` 처럼 값으로 봐야 하는가.
 *
 * 그리고 목록만으로는 "인지했다"까지밖에 못 잠근다. 비교자가 실제로 그 prop 을
 * **보는지**는 `__tests__/messageRowMemo.test.tsx` 가 이 목록을 순회하며 묻는다.
 */
export const MESSAGE_ROW_COMPARED_PROPS: Record<keyof MessageRowProps, true> = {
  message: true,
  startsGroup: true,
  directory: true,
  chips: true,
  pausedRepeat: true,
  nowMs: true,
  onResend: true,
  actions: true,
  rollup: true,
  replyParent: true,
  quote: true,
  approvalGates: true,
  approvalReceipts: true,
  approvalOffline: true,
  onApprovalSettled: true,
};

/**
 * `chips`·`rollup` 과 같은 이유로 **값**으로 본다.
 *
 * 인용 미리보기는 호출부가 페이지의 `replyTo` 를 풀어 만드는 객체이므로 렌더마다
 * 새 동일성을 얻는다. 동일성으로 비교하면 이 행은 화면에 붙어 있는 동안 memo 가
 * 절대 적중하지 못하고, 그것은 goal RN-P2a 가 산 것을 조용히 되돌리는 일이다.
 * 필드는 네 개이고 전부 스칼라라, 이 비교는 행 하나를 다시 그리는 것보다
 * 압도적으로 싸다.
 */
function sameQuote(
  a: QuoteBlockModel | null | undefined,
  b: QuoteBlockModel | null | undefined,
): boolean {
  if (a === b) return true;
  // `sameRollup` 과 달리 `null` 과 `undefined` 는 여기서 같은 뜻이다 — 둘 다
  // 「이 행은 아무것도 인용하지 않는다」이고, 구별할 세 번째 상태가 없다.
  if (a == null || b == null) return a == null && b == null;
  // 갈래가 바뀐 것은 언제나 보여야 하는 변화다: 못 푼 인용이 풀리는 것도,
  // 원본이 지워지는 것도 여기로 온다.
  if (a.kind !== b.kind) return false;
  if (a.targetId !== b.targetId) return false;
  if (a.kind === 'unresolved' || b.kind === 'unresolved') return true;
  if (a.authorMemberId !== b.authorMemberId) return false;
  if (a.kind !== 'ready' || b.kind !== 'ready') return true;
  return (
    a.truncated === b.truncated &&
    a.quotesAnother === b.quotesAnother &&
    a.edited === b.edited &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, index) => line === b.lines[index])
  );
}

export function sameMessageRowProps(
  a: MessageRowProps,
  b: MessageRowProps,
): boolean {
  return (
    a.message === b.message &&
    a.startsGroup === b.startsGroup &&
    a.directory === b.directory &&
    a.pausedRepeat === b.pausedRepeat &&
    a.nowMs === b.nowMs &&
    a.onResend === b.onResend &&
    a.actions === b.actions &&
    a.replyParent === b.replyParent &&
    sameChips(a.chips, b.chips) &&
    sameRollup(a.rollup, b.rollup) &&
    sameQuote(a.quote, b.quote) &&
    // 두 표는 **동일성**으로 본다(`directory` 와 같은 취급). 화면이 `useMemo`
    // 로 붙잡고 있으므로 승인이 실제로 바뀔 때만 새 표가 되고, 그때는 붙어 있는
    // 행이 전부 다시 그려진다 — 승인은 드물어 감당할 수 있는 값이고, 대안은
    // 행마다 카드를 다시 파싱하는 것(코어 규칙의 두 번째 구현)이다.
    a.approvalGates === b.approvalGates &&
    a.approvalReceipts === b.approvalReceipts &&
    a.approvalOffline === b.approvalOffline &&
    a.onApprovalSettled === b.onApprovalSettled
  );
}

export const MessageRow = React.memo(MessageRowInner, sameMessageRowProps);
// `React.memo` 는 이름을 지우므로 다시 붙인다 — 리액트 개발자 도구와 테스트
// 실패 메시지가 「Memo」 대신 이 이름을 말하게 하려고.
MessageRow.displayName = 'MessageRow';

/**
 * The whole row as one sentence, because the row is one accessibility element.
 *
 * Exported for the test that counts what VoiceOver would say — a label assembled
 * inline is a label nobody checks.
 */
/**
 * 행이 눌려 있는 동안의 채움.
 *
 * 이름을 붙여 내보내는 이유는 **측정 하네스가 이 값을 읽어 눌린 행을 세우기
 * 때문**이다(design-review M-2 는 「도출 — 눌린 상태 캡처 없음」으로 남았다).
 * 시뮬레이터는 손가락을 대고 있을 수 없으므로 그 상태는 찍히지 않는데, 하네스가
 * 색을 **베껴 적으면** 그 사진은 증거가 아니게 된다. 같은 심볼을 들면 이 값이
 * 바뀌는 순간 사진도 함께 틀린 것이 된다.
 *
 * 그리고 이것이 M-2 의 실체다: 이 값은 코드 상자의 채움과 **같은 `color.surface`**
 * 라서, 행을 누르는 동안 상자의 고도가 사라진다(1.000:1). 값 공간을 가르는 것은
 * 토큰 체계 결정이라 U2 소관이고, 여기서는 그 사실을 **사진과 단정으로 붙잡아
 * 둔다**.
 */
export const ROW_PRESSED_BACKGROUND = color.surface;

export function rowAccessibilityLabel({
  message,
  authorLabel,
  chips,
  tail,
  deleted,
  replyTo,
  quoted,
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
  /**
   * What the 인용 block says, when the row is drawing one. Between the 답글
   * marker and the body, in the same order the eye reads them — and the block
   * does NOT get its own accessibility element, because the row is one element
   * (the count this client cut from 6 to 1 on the web side).
   */
  quoted?: string | null;
}): string {
  const parts = [
    authorLabel,
    timeLabel(message.createdAtMs),
    replyTo ?? '',
    quoted ?? '',
    deleted ? '삭제된 메시지' : (message.body ?? '').trim(),
    ...tail,
    ...chips.map(
      chip => `${chip.emoji} 반응 ${chip.count}개${chip.mine ? ', 내 반응' : ''}`,
    ),
  ];
  return parts.filter(part => part !== '').join(', ');
}

// =============================================================================
// 답이 나타날 자리 (#999)
//
// 성재, 1차 검수: *"에이전트가 일하고 있는 상태인지도 잘 파악이 안 돼."*
//
// 배선은 #994 에 이미 있었다. 없던 것은 인지다 — 짧은 턴은 수 초 만에 끝나고,
// 활동 줄도 배지도 시선 밖이다. 멘션을 막 친 사람의 눈이 가 있는 곳은 대화의
// 맨 아래, 자기가 쓴 줄 다음 칸이다. 그래서 「작업 중」을 거기서 말한다.
//
// ## 메시지처럼 생겼지만 메시지가 아니다
//
// 이름줄은 진짜 행과 같은 모양이다(에이전트 색, 에이전트 태그, 책임자) — 그것이
// 이 칸이 **누구의 답을 기다리는 자리**인지 말하는 방법이기 때문이다. 대신 본문
// 자리는 비어 있고, 그 비어 있음을 한 낱말로 적는다. 시각도, 반응도, 길게 누르기도
// 없다: 아직 아무것도 일어나지 않았으므로 할 수 있는 일도 없다.
//
// ## 시계도 헤드라인도 없다 — 그리고 그것은 절약이 아니라 계약이다
//
// 둘 다 초 단위로 바뀐다. 이 행에 실으면 그 박자로 `items` 가 새로 만들어지고
// 목록 전체가 다시 그려진다 — goal RN-P2a(#997)가 방금 산 것이 정확히 그것이다.
// 둘은 컴포저 바로 위 활동 줄에 이미 있고, 거기가 그 둘이 있어야 할 자리다.
// `__tests__/conversationRenders.test.tsx` 가 이 계약을 숫자로 지킨다.
// =============================================================================

export function WorkingRow({
  memberId,
  directory,
}: {
  memberId: string;
  directory: Directory;
}): React.JSX.Element {
  const parts = memberNameParts(directory, memberId, UNKNOWN_MEMBER);
  const member = memberFor(directory, memberId);
  const owner = member?.ownerHumanId
    ? memberFor(directory, member.ownerHumanId)
    : null;
  return (
    <View
      // 한 행 = 한 접근성 원소, 메시지 행과 같은 규칙. 문장 하나로 읽힌다.
      accessible
      accessibilityLabel={`${parts.name} 작업 중, 답을 기다리는 중입니다`}
      style={[styles.row, styles.rowStartsGroup]}
      testID={`working-row-${memberId}`}>
      <View style={styles.rowInner}>
        <View style={styles.authorRow}>
          <Text
            style={[styles.authorName, styles.authorNameAgent]}
            numberOfLines={1}>
            {parts.name}
          </Text>
          {parts.handle ? (
            <Text style={styles.authorHandle} numberOfLines={1}>
              {parts.handle}
            </Text>
          ) : null}
          <View style={styles.agentTag}>
            <Text style={styles.agentTagText}>에이전트</Text>
          </View>
          {owner ? (
            <Text style={styles.authorMeta} numberOfLines={1}>
              {`${owner.displayName}님이 관리`}
            </Text>
          ) : null}
        </View>
        {/* 코어의 낱말 그대로다. 「작업 중」은 열린 턴 하나를 뜻하고, 승인 대기는
            애초에 이 행을 얻지 못한다(`turnPlaceholderKey`). */}
        <Text style={styles.workingBody}>작업 중…</Text>
      </View>
    </View>
  );
}

/** A local echo: on screen the instant it is sent, with no seq and no clock. */
export function PendingRow({
  pending,
  startsGroup,
  directory,
  quote,
  onResend,
}: {
  pending: PendingMessage;
  startsGroup: boolean;
  directory: Directory;
  /**
   * 이 전송이 인용을 걸고 나갔다면 그 블록 (ADR-0148).
   *
   * 메아리가 자기 인용을 **먼저** 그려야 한다. 없으면 낙관적 행에는 인용이 없다가
   * seq 가 도착하는 순간 블록이 자라나고, 읽던 사람 눈 밑에서 본문이 밀린다 —
   * 이 파일이 `bodyPending` 에서 이미 한 번 고른 규율이다(서버 사본이 이 행을
   * 대체할 때 글이 다시 흐르면 안 된다).
   */
  quote?: QuoteBlockModel | null;
  onResend?: (clientMsgId: string) => void;
}): React.JSX.Element {
  const failed = pending.status === 'failed';
  return (
    <View
      style={[styles.row, startsGroup && styles.rowStartsGroup]}
      testID="pending-row">
      {startsGroup ? (
        <Author directory={directory} memberId={pending.authorMemberId} />
      ) : null}
      {quote ? <QuoteBlock block={quote} directory={directory} /> : null}
      {/* Same anatomy as a confirmed row, dimmed: the text must not re-flow when
          the server's copy replaces this one — which is exactly why the echo
          goes through the SAME renderer. Before this, a pending row printed
          markdown raw and then rearranged itself the instant its seq landed. */}
      <MessageBody body={pending.body} muted selectable />
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
  rowInner: {
    paddingHorizontal: SAFE_GUTTER,
    // 3pt 였다 — 한 사람이 연달아 쓴 다섯 줄이 한 덩이 문단으로 읽혔다(감사
    // H-7). 값은 **코어가 정한다**: 두 행 사이에 실제로 남는 거리가
    // `ROW_SPACE.withinGroup` 이 되도록 절반씩 나눠 문다. 웹은 같은 값을
    // 위아래 패딩의 합으로 만든다.
    //
    // 첫 판은 `space.xs`(4 → 사이 8pt)로 잡았는데 코어 랜딩이 그것을 12 로
    // 정정했다. 「둘의 비를 지키면서 안쪽을 넓힌다」가 그 판정이다.
    paddingVertical: ROW_SPACE.withinGroup / 2,
    gap: 2,
  },
  /**
   * 시각 칸의 예약. **그릇이 진다** (design-review M-1).
   *
   * ## 자식에게 걸었던 것이 왜 구멍이었나
   *
   * 시각은 모든 행에 절대 위치로 앉는데, 오른쪽을 비워 두는 자리는 둘뿐이었다:
   * 작성자 줄과 — 연속 행일 때만 — 본문. 그래서 행의 **첫 흐름 자식**이 답글
   * 표식·인용·묘비·아티팩트 카드·승인 카드일 때는 예약이 없었고, 리뷰가 그
   * 겹침을 저장소의 캡처에서 읽어 냈다(`...문서에⁷젝³`).
   *
   * 그 구멍은 오타가 아니라 **자리의 문제**였다: 예약을 자식에 걸면 자식 종류가
   * 늘 때마다 같은 구멍이 다시 생기고, 그때마다 아무도 알아채지 못한다. 그래서
   * 예약을 그릇으로 올린다 — 이 그릇에 무엇이 들어오든, 앞으로 무엇이 더
   * 들어오든, 오른쪽 34pt 는 시각의 것이다.
   *
   * ## 값
   *
   * `SAFE_GUTTER`(그릇 자신의 좌우 여백) + `TIME_COLUMN` + `space.sm`. 시각은
   * 화면 오른쪽에서 `SAFE_GUTTER` 만큼 떨어져 서므로(`rowTime.right`), 내용의
   * 오른쪽 끝과 시각의 왼쪽 끝 사이에 정확히 `space.sm` 이 남는다.
   *
   * ## 값이 사는 비용
   *
   * 그룹 **머리** 행의 본문도 이제 42pt 좁아진다 — 전에는 작성자 줄만 비켜 주고
   * 본문은 끝까지 갔다. 그 대신 한 묶음 안 모든 행의 본문 오른쪽 끝이 같은 x 에
   * 서고, 시각이 그제야 **칸**이 된다. 「눈이 그 칸을 안 읽기로 정할 수 있다」는
   * 이 배치의 주장은 다른 것이 그 칸에 들어오지 않을 때만 참이다.
   *
   * `WorkingRow` 는 이 스타일을 안 쓴다 — 그 행에는 시각이 없고, 없는 것을 위해
   * 자리를 비우면 그것은 예약이 아니라 그냥 여백이다.
   */
  rowTimeReserve: {paddingRight: SAFE_GUTTER + TIME_COLUMN + space.sm},
  /**
   * 행의 시각 (H-3). 행의 첫 줄 오른쪽 끝.
   *
   * `position: 'absolute'` 인 이유는 세로 비용을 0 으로 두기 위해서다 — 흐름에
   * 넣으면 줄이 하나 늘고, 5연발에서 그것은 80pt 다. 겹침을 막는 것은
   * `rowTimeReserve` 이고, 가림을 막는 것은 렌더 순서다(위 JSX 주석).
   */
  rowTime: {
    position: 'absolute',
    right: SAFE_GUTTER,
    // 규칙 하나: **이 메시지의 맨 위 오른쪽**. 그룹 머리면 그 줄이 작성자
    // 줄이고 연속 행이면 본문 첫 줄이다 — 자리를 따로 계산하지 않는다.
    // (`rowStartsGroup` 의 여백은 바깥 `row` 에 있으므로 여기 안 들어온다.)
    top: space.xs,
    width: TIME_COLUMN,
    textAlign: 'right',
    fontSize: font.meta,
    // 시각은 뜻을 나르는 글자다 — `textFaint` 는 배경 대비 3.909:1 로 본문
    // AA(4.5)를 못 지난다(U4-2 M-6 실측). 그룹 머리의 시각도 같은 이유로
    // 함께 옮겼다: 한 화면에서 같은 종류의 글자가 두 밝기면, 덜 중요한 쪽이
    // 더 밝아지는 일이 생긴다.
    color: color.textMuted,
    lineHeight: 22,
  },
  // Feedback that the row is interactive at all. On a phone this is one of the
  // few honest signals that a gesture exists, and it costs no vertical space.
  rowPressed: {backgroundColor: ROW_PRESSED_BACKGROUND},
  // 그룹 사이는 `ROW_SPACE.betweenGroups`. 안쪽이 이미 절반씩 물고 있으므로
  // 차이만 더한다 — 6+6=12(안), 6+6+6=18(사이).
  rowStartsGroup: {marginTop: ROW_SPACE.betweenGroups - ROW_SPACE.withinGroup},
  // 시각 칸의 여백은 여기 없다 — 그릇(`rowTimeReserve`)이 진다. 이 줄에만
  // 걸어 두었던 것이 M-1 이 말한 구멍의 절반이었다: 예약이 자식에 붙어 있으면
  // **그 자식이 없는 행**은 예약도 없다.
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
  // 그룹 머리의 시각. 연속 행의 것과 **같은 밝기**여야 한다 — 위 주석 참조.
  time: {fontSize: font.meta, color: color.textMuted},
  // 앱이 말하는 문장이다 — 구분축은 `appVoice.ts` 의 `※` 가 든다. 인용 안의
  // 묘비와 **같은 낱말이므로 같은 모양이어야 한다**: 한 화면에 두 모양으로 나오면
  // 사람은 둘이 다른 것을 뜻한다고 읽는다.
  tombstone: {fontSize: font.label, color: color.textMuted, lineHeight: 18},
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
  rowReceipt: {fontSize: font.meta, color: color.textMuted, paddingTop: space.xs},
  rowFailureDismiss: {fontSize: font.meta, color: color.textMuted, fontWeight: '600'},
  sending: {fontSize: font.meta, color: color.textFaint},
  // 본문 크기의 자리를 차지하되 본문의 무게는 갖지 않는다 — 이것은 메시지에
  // **대한** 서술이지 메시지가 아니다(묘비와 같은 규칙).
  //
  // 다만 `※` 는 **안 붙인다**. 이 줄은 *부재* 서술이 아니라 *진행* 서술이고
  // (「작업 중」은 지금 일어나는 일이다), 이미 말줄임표라는 자기 표시를 달고
  // 있다. 죽은 `fontStyle:'italic'` 만 걷어내고 AA 로 올렸다 — 무동작인 채로
  // 남겨 두면 다음 사람이 그 축이 서 있다고 믿는다.
  workingBody: {
    fontSize: font.body,
    lineHeight: 22,
    color: color.textMuted,
  },
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

  // 라벨이 **앞**에 선다(`DIVIDER_LABEL_SIDE`). 여백·두께도 코어 값이다.
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DIVIDER_SPACE.labelGap,
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: DIVIDER_SPACE.marker.blockStart,
    paddingBottom: DIVIDER_SPACE.marker.blockEnd,
  },
  // 날짜는 **가장 큰 경계**라 더 연다. 셋이 같은 여백이면 위계가 사라진다.
  dividerDay: {
    paddingTop: DIVIDER_SPACE.day.blockStart,
    paddingBottom: DIVIDER_SPACE.day.blockEnd,
  },
  dividerLine: {
    flex: 1,
    height: DIVIDER_SPACE.ruleThickness,
    backgroundColor: color.border,
  },
  dividerLineWarn: {backgroundColor: color.warn},
  // `textFaint` 는 배경 대비 3.909:1 로 본문 AA 미달이다(U4-2 M-6 실측).
  dividerLabel: {fontSize: font.meta, color: color.textMuted},
  /** 숫자만 자릿폭 고정 — 조사·단위가 함께 받으면 음절 사이가 벌어진다. */
  dividerFigure: {fontVariant: ['tabular-nums']},
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

});
