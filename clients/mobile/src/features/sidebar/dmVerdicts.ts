import type {Channel, ReadState} from '@momo/core/lib/api';
import {
  dmClosedListReason,
  dmReadFacts,
  dmVisibility,
  type DmCounterpart,
  type DmVisibilityRule,
} from '@momo/core/features/sidebar/dmVisibility';
import {
  rosterIsComplete,
  type GoneUnreadVerdict,
  type ReadProjectionPhase,
} from '@momo/core/features/sidebar/goneDm';
import {
  channelLabelParts,
  idKey,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {uuidEq} from '@momo/core/lib/api';

// =============================================================================
// 폰 사이드바의 DM 보임 (ADR-0177 증보 D8, #4367). 웹 `dmClosureModel.ts` 의 폰판이고, 판정은 같은 코어 함수 하나(`dmVisibility`)다.
//
// 이 파일은 **입력을 모으는 일**만 한다. 웹과 다른 점이 폰이 가진 것의 차이다:
//
//   * 기기 로컬 닫기 원장이 없다. 만들지 않는다: 기기마다 어긋나던 문제를 되풀이한다(`channelRowActions.ts` 머리말). 그래서 서버가
//     닫기를 싣지 않는 서버(`legacy`)에서는 닫기를 내밀지 않고, 닫힘 없이 나간 상대 접기(6번)만 이 판정으로 돈다.
//   * 첫 페인트 캐시는 **닫힘 id 목록 하나**다(`dmClosedCache.ts`, 원장 아님). 투영이 오는 중에는 나간 상대의 DM 과 마지막 투영에서
//     닫혀 있던 DM 만 접힌 채로 둔다: 콜드스타트 첫 프레임에 닫은 DM 이 잠깐 보였다 사라지지 않게(웹 D8 캐시와 같은 원칙).
//
// ## 두 갈래, 한 판정
//
//   server  행이 `latestReadableSeq`·`closedAtSeq` 를 싣는다(새 서버는 모든 행에). 행 그대로 코어에 넣는다.
//   legacy  행이 그 둘을 안 싣는다(옛 서버). `closedAtSeq` 는 없음(`null`), 「읽을 seq」는 전체 seq 다. 나간 상대 DM 의 안 읽음이
//           기계 메시지뿐이면(`useGoneUnreadVerdicts` 가 읽어 가른다) 읽은 자리가 곧 읽을 자리다.
//
// `hold`(코어 3번): 투영이 오는 중이면 나간 상대만 숨고 나머지는 보인다. 이 행이 닫힘을 말하지 않았으면(`closedAtSeq` 가
// `undefined`) 보인다 - 모를 때 숨기는 쪽이 최악이다.
// =============================================================================

export type DmClosureMode = 'server' | 'legacy' | 'unknown';

/**
 * 읽음 투영 행들로 서버가 닫기를 싣는지 가른다(웹 `dmClosureMode` 와 같은 규칙).
 * 행이 없으면(투영이 없거나 DM 이 하나도 없다) 증거가 없다: `unknown`.
 */
export function dmClosureMode(rows: readonly ReadState[] | undefined): DmClosureMode {
  if (rows === undefined || rows.length === 0) return 'unknown';
  return rows.some(row => row.latestReadableSeq !== undefined || row.closedAtSeq !== undefined)
    ? 'server'
    : 'legacy';
}

export interface DmVerdict {
  shown: boolean;
  rule: DmVisibilityRule;
}

export interface DmVerdictsInput {
  dms: readonly Channel[];
  directory: Directory;
  selfMemberId: string;
  byChannel: ReadonlyMap<string, ReadState>;
  /** 지금 보고 있는 DM. 열린 DM 은 언제나 보인다(D8-1). */
  openChannelId: string | null;
  phase: ReadProjectionPhase;
  /** 명부를 받았나(코어 `rosterLoaded`). */
  rosterReady?: boolean;
  mode: DmClosureMode;
  /** legacy 에서 나간 상대 DM 의 안 읽음 판정(`useGoneUnreadVerdicts`). */
  goneVerdicts?: ReadonlyMap<string, GoneUnreadVerdict>;
  /** 마지막 투영에서 닫혀 있던 DM id(소문자 키). 투영이 오기 전 첫 페인트에서만 읽는다. */
  cachedClosed?: ReadonlySet<string>;
}

/** DM 마다의 판정(소문자 id 키). */
export function dmVerdicts(input: DmVerdictsInput): Map<string, DmVerdict> {
  const rosterComplete = rosterIsComplete(input.directory.members.length);
  const out = new Map<string, DmVerdict>();
  for (const dm of input.dms) {
    const id = idKey(dm.id);
    const label = channelLabelParts(
      dm,
      input.directory,
      input.selfMemberId,
      input.rosterReady === undefined ? {} : {rosterReady: input.rosterReady},
    );
    // 명부를 믿을 수 있을 때만 「나간 멤버」다(D8 `unknown`): 못 받았거나 한도에서 잘렸으면 6번을 건너뛴다.
    const counterpart: DmCounterpart =
      label.kind === 'gone'
        ? rosterComplete
          ? 'gone'
          : 'unknown'
        : label.kind === 'pending'
          ? 'unknown'
          : 'present';
    const read = input.byChannel.get(id);
    const isOpen = input.openChannelId !== null && uuidEq(dm.id, input.openChannelId);
    // 행을 통째로 코어에 넘긴다(폰은 마크 필드를 이름으로 부르지 않는다, D3). 옛 서버는 닫힘 없이 전체 seq 로 읽는다.
    const facts = dmReadFacts(read, input.mode === 'server');
    let latestReadableSeq = facts.latestReadableSeq;
    if (read !== undefined && input.mode !== 'server') {
      // 나간 상대 DM 의 안 읽음이 기계 메시지뿐이면(`useGoneUnreadVerdicts` 가 읽어 가른다, 읽는 중이어도) 읽은 자리가 곧 읽을 자리다.
      const gone = input.goneVerdicts?.get(id);
      if (gone === 'ambient' || gone === 'pending') {
        latestReadableSeq = Math.min(latestReadableSeq, facts.lastReadSeq);
      }
    }
    const verdict = dmVisibility({
      ...facts,
      latestReadableSeq,
      isOpen,
      // 폰에는 DM 별표·섹션이 없다. 웹도 DM 에 별표 문을 열지 않으므로 다른 클라이언트가 적은 배치에서만 참인데, 폰은 그 배치를
      // 읽지 않는다(이슈 Out of scope) - 별표한 DM 을 닫으면 웹에서 별표를 빼기 전까지 안 보일 수 있다. 미결.
      starredOrSectioned: false,
      counterpart,
      phase: input.phase,
    });
    if (verdict.visibility === 'hold') {
      // 오는 중이면 나간 상대와 마지막 투영에서 닫혀 있던 DM 만 접힌 채(깜빡이며 나타났다 사라지지 않게), 그 밖에는 보인다.
      // 열린 DM 은 코어 1번이 먼저 보임으로 가르므로 이 갈래(hold)에 오지 않는다 - 캐시가 열린 DM 을 숨기지 못한다.
      const cachedClosed = input.cachedClosed?.has(id) === true;
      out.set(id, {
        shown: !(input.phase === 'loading' && (counterpart === 'gone' || cachedClosed)),
        rule: verdict.rule,
      });
    } else {
      out.set(id, {shown: verdict.visibility === 'shown', rule: verdict.rule});
    }
  }
  return out;
}

export interface DmClosedEntry {
  channel: Channel;
  /** closed: 내가 닫았다(7번) · gone: 상대가 나갔다(6번). */
  reason: 'closed' | 'gone';
}

/** 「⋯ › 닫은 대화」 목록(D11): 숨겨진 DM 중 명시적 닫기(7)와 나간 상대(6)만. 열린 DM 은 verdict 가 이미 보임이다. */
export function dmClosedEntries(
  dms: readonly Channel[],
  verdicts: ReadonlyMap<string, DmVerdict>,
): DmClosedEntry[] {
  const out: DmClosedEntry[] = [];
  for (const channel of dms) {
    const verdict = verdicts.get(idKey(channel.id));
    if (verdict === undefined) continue;
    // 숨은 DM 만 6·7번에 닿는다: 목록에 드는 줄은 코어 `dmClosedListReason` 한 곳이 정한다.
    const reason = dmClosedListReason(verdict.rule);
    if (reason !== null) out.push({channel, reason});
  }
  return out;
}
