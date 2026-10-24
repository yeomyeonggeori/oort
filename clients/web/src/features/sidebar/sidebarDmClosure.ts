import { useSyncExternalStore } from "react";
import {
  readProjectionPhase,
  type ReadProjectionPhase,
} from "@momo/core/features/sidebar/goneDm";

// =============================================================================
// **레거시 갈래 (ADR-0177 증보 D12, #4228).** 서버가 DM 닫기를 기억하면(읽음 투영이 `latestReadableSeq`·`closedAtSeq` 를 싣는다)
// 이 원장은 **읽지 않는다**: 한 번 서버로 옮기고 비운다(`dmClosureModel.ts` `migrateDmLedger`). 서버가 아직 안 싣는 옛 서버에서만
// 이 원장이 닫기의 정본이고, 아래 머리말은 그 갈래의 규칙이다. 보임 판정은 어느 갈래든 코어 `dmVisibility` 한 함수다.
//
// DM 을 이 기기의 사이드바에서 닫는다 (#3963, 성재 2026-10-16: 「DM은 호버하면 X 표시가 떠서
// 삭제할 수 있어야 해」).
//
// ## 무엇이 아닌가
//
// 대화 삭제가 아니다. 상대 쪽 멤버십도 서버도 건드리지 않는다. **이 기기의 사이드바에서
// 숨길 뿐**이고, 닫은 뒤에 새 메시지가 오면 다시 나타난다. 그래서 확인 단계가 없다(되돌릴
// 것이 없다) - 파괴적 액션은 확인을 요구한다는 규칙(SKILL §6)의 대상이 아니다.
//
// ## 왜 기기 로컬인가 (planner 결정 2026-10-17)
//
// 서버의 사이드바 선호 payload v1 은 `deny_unknown_fields` 라 칸을 하나 늘리는 것이 곧 서버
// 계약 변경이다(`momo-messaging/src/sidebar_prefs.rs`, `sidebarSections.ts` 의 `section_sort`
// 문단). 그것은 엔진 트랙의 일이고 ADR 이 필요하다. 접힘이 이미 같은 갈래로 기기 성향이다
// (ADR-0177 D4, `sidebarSectionPreference.ts`): 27인치에서 닫아 둔 대화를 폰에서도 닫아 둘
// 이유가 없다. **기기 사이 동기화는 서버 계약이 필요한 일이라 이 모듈의 범위 밖이다.**
//
// ## 원장의 모양
//
//   { [workspaceId]: { [channelId 소문자]: 닫을 때의 latestSeq } }
//
// 「새 메시지가 오면 다시 나타남」을 시계가 아니라 **seq 비교**로 한다: 닫을 때 서버
// read-state 투영의 `latestSeq` 를 적어 두고, 지금 투영의 `latestSeq` 가 그보다 크면
// (= 그 뒤에 메시지가 하나라도 쌓였으면) 보인다. 시각을 쓰면 기기 시계가 틀린 날 닫은 대화가
// 영원히 숨거나 즉시 돌아온다.
//
// ## 숨김 판정의 세 갈래 (`dmHiddenByClosure`)
//
//   * 지금 **열려 있는** DM 은 닫은 것이 아니다. 보고 있는 대화가 사이드바에서 사라지면
//     자기가 어디에 있는지 모른다. 열린 DM 을 X 로 닫으면 사이드바가 `/` 로 착지시킨다
//     (채널 나가기와 같은 착지)
//   * 투영이 아직 **오는 중**이면 숨김을 유지한다. 도착하기 전에 보이면 닫은 대화가 한 프레임
//     깜빡이며 나타났다 사라진다.
//   * 투영을 **못 읽었으면** 보인다. 새 메시지가 왔는지 알 수 없을 때 숨기는 쪽이 최악이다
//     (대화를 잃는다). 닫은 대화가 잠시 더 보이는 것은 되돌릴 수 있다.
//
// 열린 DM 이 「닫은 DM」으로 바뀌는 순간(주소·⌘K·새 DM 으로 다시 열었을 때) 원장에서 지운다
// (`reopenDmOnDevice`, 호출은 사이드바). 그렇지 않으면 사람이 일부러 다시 연 대화가 다음에
// 다른 곳으로 이동하는 순간 도로 사라진다.
//
// 항목은 워크스페이스마다 200 개까지다(`CLOSED_DMS_PER_WORKSPACE_MAX`). 넘으면 **가장 먼저
// 닫은 것**부터 잊는다. 잊힌 DM 은 사이드바에 다시 나타날 뿐이다.
//
// ## 안 읽음이 있는 DM 은 닫기를 내밀지 않는다 (소유자 결정 2026-10-17)
//
// 성재(AskUserQuestion): 「안 읽음 있으면 X 숨김 (Recommended)」. 안 읽은 메시지(**멘션 포함**)가 있는 DM 행에는
// 호버 X 도 우클릭 메뉴의 「대화 닫기」도 없고(둘이 **같은 한 함수**, `dmCloseOffered`, 를 읽는다), 읽고 나면
// 다시 보인다. 닫기는 읽음 커서를 건드리지 않는다(서버 쓰기 0건) - 읽지 않은 것을 가리지 않으므로 「행은 없는데 숫자만
// 사이드바 밖 집계(독 배지·탭 제목·인박스·레일의 멘션 합)에 남는」 모양이 생길 길이 거의 없다(design-review R2 M1 이 짚은 것을
// 길 (c)로 닫았다). 열려 있는 DM 은 읽고 있는 것이라 안 읽음이 0 으로 접혀 있고(`sidebarUnreadCounts`) 닫을 수 있다 - 이것이
// 유일한 예외다: DM 을 연 `explicit_open` 읽음 쓰기가 서버에 닿기 전의 한 왕복 동안에는 서버의 안 읽음이 남아 있을 수 있다
// (design-review R4 가 짚은 것).
//
// 닫은 뒤에 새 메시지가 오면 DM 이 다시 나타나고(위 seq 비교) 그때는 안 읽음이 있으므로 X 가 없다 - 읽어야 다시 닫을 수 있다.
//
// ## 읽음 투영이 없을 때 닫기가 보이지 않는 이유 (design-review R2 M2 - 수용)
//
// 투영이 오는 중이거나 못 읽은 동안은 닫기(호버 X·메뉴 항목)를 내밀지 않는다: 기준 seq 를 모르는 채 0 을 적으면
// 새 메시지가 와도 되살아나지 않는다(R1 M1). 이 구간에는 안 읽음 알약도 같은 이유로 없어서 사이드바 전체가
// 「읽음 상태를 모르는」 모양이고, 닫기만 따로 이유를 말하지 않는다. 오류가 새로고침 전까지 이어지는 것은 투영
// 읽기의 재시도·오류 표시의 몫이다. 이유 문구를 얹는 일은 후속으로 둔다.
// =============================================================================

export const SIDEBAR_CLOSED_DMS_STORAGE_KEY = "momo.web.sidebar-closed-dms.v1";

/** 워크스페이스마다 적어 두는 최대 수. 쓰레기가 영원히 자라지 않게 한다. */
export const CLOSED_DMS_PER_WORKSPACE_MAX = 200;

/** channelId(소문자) → 닫을 때의 latestSeq. */
export type ClosedDms = Readonly<Record<string, number>>;
/** workspaceId(소문자) → ClosedDms. */
export type ClosedDmLedger = Readonly<Record<string, ClosedDms>>;

const EMPTY_DMS: ClosedDms = Object.freeze({});
const EMPTY_LEDGER: ClosedDmLedger = Object.freeze({});

/** 원장은 남의 문자열을 열쇠로 쓴다. 프로토타입의 이름(`constructor` 등)이 항목으로 읽히지 않게 한다. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

interface LedgerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): LedgerStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 저장된 문자열 → 원장. **던지지 않는다**: 못 읽은 것은 닫은 DM 이 없는 것과 같다(= 모든 DM 이
 * 보인다). 남의 값(음수·소수·문자열)은 항목째 버린다 - `Number.isSafeInteger` 만 통과한다.
 */
export function parseClosedDmLedger(raw: string | null): ClosedDmLedger {
  if (raw === null) return EMPTY_LEDGER;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return EMPTY_LEDGER;
    }
    const ledger: Record<string, ClosedDms> = {};
    for (const [workspace, entries] of Object.entries(parsed)) {
      if (workspace === "__proto__") continue;
      if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
        continue;
      }
      const kept: Record<string, number> = {};
      for (const [channel, seq] of Object.entries(entries)) {
        if (channel === "__proto__") continue;
        if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
          kept[channel.toLowerCase()] = seq;
        }
      }
      if (Object.keys(kept).length > 0) ledger[workspace.toLowerCase()] = kept;
    }
    return ledger;
  } catch {
    return EMPTY_LEDGER;
  }
}

/**
 * 한 DM 을 닫은 원장. 이미 있으면 seq 를 갈아 끼우고 **가장 최근에 닫은 쪽**으로 옮긴다
 * (다시 나타났다가 또 닫은 대화가 먼저 잊히면 안 된다). 상한을 넘으면 가장 오래된 것부터 버린다.
 */
export function withClosedDm(
  ledger: ClosedDmLedger,
  workspaceId: string,
  channelId: string,
  latestSeq: number
): ClosedDmLedger {
  const workspace = workspaceId.toLowerCase();
  const channel = channelId.toLowerCase();
  const seq = Number.isSafeInteger(latestSeq) && latestSeq > 0 ? latestSeq : 0;
  const entries: Record<string, number> = {};
  for (const [key, value] of Object.entries(own(ledger, workspace) ?? EMPTY_DMS)) {
    if (key !== channel) entries[key] = value;
  }
  entries[channel] = seq;
  const keys = Object.keys(entries);
  for (const stale of keys.slice(0, Math.max(0, keys.length - CLOSED_DMS_PER_WORKSPACE_MAX))) {
    delete entries[stale];
  }
  return { ...ledger, [workspace]: entries };
}

/** 한 DM 을 원장에서 지운 원장. 없으면 **같은 참조**를 돌려준다(구독자를 깨우지 않는다). */
export function withoutClosedDm(
  ledger: ClosedDmLedger,
  workspaceId: string,
  channelId: string
): ClosedDmLedger {
  const workspace = workspaceId.toLowerCase();
  const channel = channelId.toLowerCase();
  const current = own(ledger, workspace);
  if (current === undefined || own(current, channel) === undefined) return ledger;
  const entries: Record<string, number> = {};
  for (const [key, value] of Object.entries(current)) {
    if (key !== channel) entries[key] = value;
  }
  const next: Record<string, ClosedDms> = { ...ledger };
  if (Object.keys(entries).length === 0) delete next[workspace];
  else next[workspace] = entries;
  return next;
}

/** 이 DM 을 닫을 때 적어 둔 seq. 닫은 적 없으면 `undefined`. */
export function closedAtSeqOf(closed: ClosedDms, channelId: string): number | undefined {
  return own(closed, channelId.toLowerCase());
}

// 읽음 투영의 국면 판정은 코어로 옮겼다(#4252): 폰의 「나간 멤버와의 대화」 규칙도 같은 세 갈래를 읽는다.
// 이 파일을 import 하던 자리는 그대로 동작하도록 이름을 다시 내보낸다.
export { readProjectionPhase, type ReadProjectionPhase };

/**
 * 이 DM 을 사이드바에서 숨기는가. 규칙과 근거는 머리말에 있다.
 *
 * `latestSeq` 가 `undefined` 인 것은 투영이 이 DM 의 항목을 주지 않았다는 뜻이다(메시지가 한 번도
 * 없는 DM). 그때는 0 으로 본다: 닫을 때도 0 으로 적었으므로 첫 메시지가 오는 순간 1 > 0 이 된다.
 */
export function dmHiddenByClosure(input: {
  /** 원장의 닫을 때 seq. 닫은 적 없으면 `undefined`. */
  closedAtSeq: number | undefined;
  latestSeq: number | undefined;
  /** 지금 보고 있는 DM 인가. */
  isOpen: boolean;
  phase: ReadProjectionPhase;
}): boolean {
  if (input.closedAtSeq === undefined) return false;
  if (input.isOpen) return false;
  if (input.phase === "loading") return true;
  if (input.phase === "error") return false;
  return (input.latestSeq ?? 0) <= input.closedAtSeq;
}

/**
 * 인덱스 라우트(`/`)가 열어 주는 대화: 첫 채널, 채널이 없으면 **보이는** 첫 DM, 그것도 없으면 `null`(빈 상태).
 *
 * 사이드바(`openId`)와 `ChatShell`(본문)이 **같은 함수**를 읽는다. 둘이 따로 `dms[0]` 을 고르면 채널이 없는 멤버가 첫 DM 을
 * X 로 닫아도 `/` 가 그 DM 을 도로 열어 「열려 있음」으로 되살아났다(design-review R1 H1: 보이는 컨트롤이 무반응). 닫은 DM·
 * 나간 상대의 DM·판정이 미뤄진 DM 은 후보에서 빠지므로 본문은 다음 DM 을 열거나, 남은 것이 없으면 빈 상태를 그린다.
 *
 * `shown` 은 코어 `dmVisibility` 의 결과(열림을 뺀 판정)다. 후보를 고르는 중에는 열려 있다는 사실이 이 판정의 입력이 아니라
 * 결과라서 열림은 넣지 않는다.
 */
export function indexFallbackChannelId(input: {
  channels: readonly { id: string }[];
  dms: readonly { id: string }[];
  /** 이 DM 이 목록에 서는가(`useDmVisibility().verdictOf(id).state === "shown"`). */
  shown: (channelId: string) => boolean;
}): string | null {
  const channel = input.channels[0];
  if (channel !== undefined) return channel.id;
  for (const dm of input.dms) {
    if (input.shown(dm.id)) return dm.id;
  }
  return null;
}

// ---- 외부 저장소 (useSyncExternalStore) ------------------------------------------

function readLedger(storage: LedgerStorage | null = browserStorage()): ClosedDmLedger {
  try {
    return parseClosedDmLedger(storage?.getItem(SIDEBAR_CLOSED_DMS_STORAGE_KEY) ?? null);
  } catch {
    return EMPTY_LEDGER;
  }
}

let ledger: ClosedDmLedger = readLedger();
const listeners = new Set<() => void>();

function commit(next: ClosedDmLedger, storage: LedgerStorage | null): void {
  if (next === ledger) return;
  ledger = next;
  try {
    storage?.setItem(SIDEBAR_CLOSED_DMS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 저장소 거부는 이 탭에서만 유지된다는 뜻이다. 닫기는 이 탭에서 여전히 동작한다.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 지금 이 워크스페이스에서 닫은 DM 들(훅 밖에서 읽는 같은 값). 바뀌기 전까지 같은 참조다. */
export function closedDmsFor(workspaceId: string): ClosedDms {
  return own(ledger, workspaceId.toLowerCase()) ?? EMPTY_DMS;
}

/** 이 워크스페이스에서 닫은 DM 들. 바뀌기 전까지 같은 참조다. */
export function useClosedDms(workspaceId: string): ClosedDms {
  return useSyncExternalStore(
    subscribe,
    () => closedDmsFor(workspaceId),
    () => EMPTY_DMS
  );
}

/** 이 DM 을 닫는다. `latestSeq` 는 지금 서버 투영의 값(없으면 0). */
export function closeDmOnDevice(
  workspaceId: string,
  channelId: string,
  latestSeq: number,
  storage: LedgerStorage | null = browserStorage()
): void {
  commit(withClosedDm(ledger, workspaceId, channelId, latestSeq), storage);
}

/** 닫아 둔 DM 을 다시 연다. 닫은 적 없으면 아무 일도 없다. */
export function reopenDmOnDevice(
  workspaceId: string,
  channelId: string,
  storage: LedgerStorage | null = browserStorage()
): void {
  commit(withoutClosedDm(ledger, workspaceId, channelId), storage);
}

/** 시험 전용: 영속 저장소에서 다시 읽는 것을 모사한다(새로고침). */
export function reloadClosedDmsForTest(storage: LedgerStorage | null): void {
  ledger = readLedger(storage);
  for (const listener of listeners) listener();
}
