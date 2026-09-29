import {memoryIsCaughtUp} from '@momo/core/features/memory/model';
import type {
  MemoryDigest,
  MemoryDigestLevel,
  MemoryDigestPage,
  MemoryEvidenceLink,
  MemoryReceipt,
  MemorySettings,
} from '@momo/core/features/memory/model';
import type {MissedOffCause} from './copy';

// =============================================================================
// 팀 기억 v2 폰 표면의 판정 — 순수 함수만 (ADR-0196 D7·D12 / #3166).
//
// 화면은 이 파일이 낸 갈래를 그릴 뿐 판정하지 않는다. 그래서 다섯 상태와 「개수만
// 보이는 보류」 규칙을 렌더 없이 시험할 수 있고, 사보타주도 이 파일 한 곳을 겨눈다.
// 가시성은 서버(RLS)가 정한다: 빈 목록은 「기억이 없다」의 증거가 아니다.
// =============================================================================

/**
 * 이만큼 안 읽은 대화가 쌓여야 카드를 세운다.
 *
 * 안 읽은 한두 줄에 요약 카드를 세우면 카드가 원문보다 길다. 이 값 밑에서는 카드가
 * 아예 없고(로딩도 그리지 않는다), 서버도 그만큼 모이기 전에는 요약을 만들지 않는다.
 */
export const MISSED_MIN_UNREAD = 5;

/** 접힌 카드가 보여 주는 요약 줄 수의 상한 (plan.md §5 V1 「3~5줄」). */
export const MISSED_MAX_LINES = 5;

/** 접힌 카드가 옆에 두는 근거 링크 수. 나머지는 「더 보기」 시트에 있다. */
export const MISSED_MAX_EVIDENCE = 3;

export type QueryPhase = 'loading' | 'error' | 'ready';

export type MissedCardState =
  | {kind: 'hidden'}
  | {kind: 'loading'}
  | {kind: 'error'}
  | {kind: 'off'; cause: MissedOffCause}
  | {kind: 'notSummarized'}
  | {kind: 'empty'}
  | {kind: 'ready'; digests: MemoryDigest[]; partial: boolean};

/** 설정에서 이 채널의 요약이 꺼진 이유. 꺼져 있지 않으면 `null`. */
export function memoryOffCause(
  settings: MemorySettings,
  channelId: string,
): MissedOffCause | null {
  if (!settings.workspace.enabled) return 'workspace';
  if (settings.workspace.paused) return 'workspacePaused';
  const channel = settings.channels.find(
    row => row.channelId.toLowerCase() === channelId.toLowerCase(),
  );
  if (channel?.excluded) return 'channel';
  if (channel?.paused) return 'channelPaused';
  if (settings.me.paused) return 'me';
  return null;
}

export interface MissedCardInput {
  channelId: string;
  /** 이 방문에서 안 읽은 수. 스레드에서는 경계 뒤에 온 답글 수. */
  unreadCount: number;
  /** 사람끼리의 DM처럼 서버가 기본으로 요약하지 않는 방. */
  eligible: boolean;
  /** 서버의 채널 머리 seq(읽기 상태의 `latestSeq`와 화면에 든 최대 seq 중 큰 것). */
  headSeq: number;
  settingsPhase: QueryPhase;
  settings?: MemorySettings;
  digestsPhase: QueryPhase;
  page?: MemoryDigestPage;
}

export function missedCardState(input: MissedCardInput): MissedCardState {
  if (!input.eligible || input.unreadCount < MISSED_MIN_UNREAD) {
    return {kind: 'hidden'};
  }
  // 설정을 읽지 못했다고 요약까지 가리지 않는다. 꺼짐을 단정할 근거가 없을 뿐이고,
  // 서버는 꺼진 방의 요약을 어차피 내주지 않는다.
  if (input.settingsPhase === 'ready' && input.settings !== undefined) {
    const cause = memoryOffCause(input.settings, input.channelId);
    if (cause !== null) return {kind: 'off', cause};
  }
  if (input.settingsPhase === 'loading' || input.digestsPhase === 'loading') {
    return {kind: 'loading'};
  }
  if (input.digestsPhase === 'error' || input.page === undefined) {
    return {kind: 'error'};
  }
  const caughtUp = memoryIsCaughtUp(input.page, input.headSeq);
  const digests = coverDigests(input.page.digests);
  if (digests.length > 0) {
    return {kind: 'ready', digests, partial: !caughtUp};
  }
  return caughtUp ? {kind: 'empty'} : {kind: 'notSummarized'};
}

const LEVEL_RANK: Record<MemoryDigestLevel, number> = {window: 0, day: 1, week: 2};

/**
 * 같은 구간을 두 번 말하지 않는다. 일간·주간 요약이 이미 덮은 창 요약은 뺀다.
 * 결과는 시간순(오래된 것 먼저)이다 — 「안 읽은 동안」은 읽는 순서로 적는다.
 */
export function coverDigests(digests: readonly MemoryDigest[]): MemoryDigest[] {
  const byCoarse = [...digests].sort(
    (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.toSeq - a.toSeq,
  );
  const picked: MemoryDigest[] = [];
  for (const digest of byCoarse) {
    const covered = picked.some(
      other =>
        other.channelId === digest.channelId &&
        other.fromSeq <= digest.fromSeq &&
        other.toSeq >= digest.toSeq,
    );
    if (!covered) picked.push(digest);
  }
  return picked.sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq);
}

const BULLET = /^\s*(?:[-*•]\s+|\d+[.)]\s+)/;

/** 요약 본문을 줄로. 불릿 기호는 걷는다. */
export function digestLines(digest: MemoryDigest): string[] {
  return digest.body
    .split(/\r?\n/)
    .map(row => row.replace(BULLET, '').trim())
    .filter(row => row !== '');
}

export function summaryLines(digests: readonly MemoryDigest[]): {
  shown: string[];
  hidden: number;
} {
  const all = digests.flatMap(digestLines);
  return {
    shown: all.slice(0, MISSED_MAX_LINES),
    hidden: Math.max(0, all.length - MISSED_MAX_LINES),
  };
}

/** 근거 링크를 메시지 기준으로 겹침 없이, seq 순으로. */
export function evidenceOf(
  digests: readonly MemoryDigest[],
): MemoryEvidenceLink[] {
  const seen = new Set<string>();
  const out: MemoryEvidenceLink[] = [];
  for (const digest of digests) {
    for (const link of digest.evidence) {
      const key = link.messageId.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(link);
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

// ---- 「기억 n개 참고」 칩 ------------------------------------------------------

export interface ReceiptChipModel {
  /** 칩의 n — 서버가 센 `servedCount` 그대로다. 볼 수 있는 목록 길이가 아니다. */
  count: number;
}

/** 참고한 기억이 없으면 칩도 없다. */
export function receiptChipModel(
  receipt: MemoryReceipt | null | undefined,
): ReceiptChipModel | null {
  if (!receipt || receipt.servedCount <= 0) return null;
  return {count: receipt.servedCount};
}

export interface ReceiptSheetModel {
  count: number;
  digests: MemoryDigest[];
  /** 서버가 준 보류 개수. 없거나 0이면 `null` — 줄을 세우지 않는다. */
  withheld: number | null;
  /** 실린 수보다 목록이 짧다: 내가 읽을 수 없는 기억이 섞여 있다(이유는 말하지 않는다). */
  listShorter: boolean;
}

export function receiptSheetModel(receipt: MemoryReceipt): ReceiptSheetModel {
  const withheld =
    receipt.withheldCount !== undefined && receipt.withheldCount > 0
      ? receipt.withheldCount
      : null;
  return {
    count: receipt.servedCount,
    // 실린 것을 그대로 센다. 겹침을 걷으면 칩의 n과 목록이 어긋난다.
    digests: [...receipt.digests].sort(
      (a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq,
    ),
    withheld,
    listShorter: receipt.digests.length < receipt.servedCount,
  };
}
