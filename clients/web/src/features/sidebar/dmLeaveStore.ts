import { useSyncExternalStore } from "react";

// =============================================================================
// 1:1 「대화 나가기」의 요청·영수증 한 곳 (ADR-0177 증보 2026-11-14 D21, #5825).
//
// 메뉴는 둘이다 - 사이드바 줄 메뉴와 대화 머리 ⋮. 둘 다 **확인 창을 직접 들지 않고 여기에 요청만 적는다.** 확인 창·왕복·끝난 뒤의 이동과
// 영수증은 사이드바의 `DmLeaveHost` 하나가 진다. 까닭: 나가기가 성공하면(또는 그 사이 30초 투영 폴링이 하한을 실어 오면) 그 대화의 줄이
// 보임 판정 3a 로 내려가고, 줄 안에 산 확인 창은 줄과 함께 사라진다(채널 나가기의 design-review #1937 H-1 과 같은 구멍). 머리 ⋮ 도 이동과
// 함께 내려간다. 그래서 둘보다 오래 사는 자리에 둔다.
// =============================================================================

export interface DmLeaveRequest {
  workspaceId: string;
  channelId: string;
  /** 확인 창 문장의 상대 이름(표시 이름). */
  name: string;
  /** 어느 메뉴에서 왔는가. 끝난 뒤의 착지가 다르다(머리 ⋮ 는 그 대화를 보고 있었다). */
  via: "row" | "header";
  /** 취소했을 때 캐럿을 돌려줄 자리(그 줄의 링크 · 머리 ⋮). */
  opener: HTMLElement | null;
  /** 이 기기가 실시간으로 받은 그 대화의 가장 큰 seq(열려 있었으면). 투영의 `latestSeq` 와 큰 쪽이 `seenSeq` 다(D16). */
  observedSeq: number | null;
  /** 열려 있던 이력에서 본 그 대화의 글 id - 답글 초안을 찾는 뿌리 후보(#5824 검수 r1 M4). */
  rootIds: readonly string[];
}

/** 끝난 뒤 그 대화의 줄 자리에 서는 한 줄 영수증(「대화에서 나갔어요.」). */
export interface DmLeaveReceipt {
  workspaceId: string;
  /** 소문자. */
  channelId: string;
  /** 같은 대화를 두 번 나가도(되살아난 뒤) 영수증마다 다른 값. */
  id: number;
}

interface Snapshot {
  request: DmLeaveRequest | null;
  /**
   * 서 있는 영수증들. 하나만 들면 첫 영수증이 붙들린 동안(포인터가 목록 위) 두 번째로 나갈 때 첫 자리가 빠져 아래 줄이 포인터 밑에서
   * 움직인다 - 그래서 영수증마다 제 시계로 걷힌다.
   */
  receipts: readonly DmLeaveReceipt[];
  /** 바뀔 때마다 오른다. 나가기 경로가 접힌 뒤(`settleDmLeaveFailure` 의 `absent`) 메뉴를 다시 그리게 하는 데도 쓴다. */
  version: number;
}

let snapshot: Snapshot = { request: null, receipts: [], version: 0 };
const listeners = new Set<() => void>();

function publish(patch: Partial<Omit<Snapshot, "version">>): void {
  snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 };
  for (const listener of listeners) listener();
}

export function requestDmLeave(request: DmLeaveRequest): void {
  publish({ request });
}

export function endDmLeaveRequest(): void {
  if (snapshot.request !== null) publish({ request: null });
}

export function showDmLeaveReceipt(workspaceId: string, channelId: string): void {
  const channel = channelId.toLowerCase();
  const next = { workspaceId, channelId: channel, id: snapshot.version + 1 };
  // 같은 대화의 앞 영수증은 새 것이 대신한다(자리는 하나다).
  publish({ receipts: [...snapshot.receipts.filter((receipt) => receipt.channelId !== channel), next] });
}

export function clearDmLeaveReceipt(id: number): void {
  if (snapshot.receipts.some((receipt) => receipt.id === id)) {
    publish({ receipts: snapshot.receipts.filter((receipt) => receipt.id !== id) });
  }
}

/** 나가기 경로가 이 워크스페이스에서 접혔다: 메뉴를 그리는 쪽이 판별(`dmLeaveMode`)을 다시 읽게 한다. */
export function noteDmLeaveFolded(): void {
  publish({});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDmLeaveStore(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/**
 * 지금 열려 있는 대화의 이력이 아는 것(가장 큰 seq · 글 id). 대화 화면이 바뀔 때마다 적고, 나가기가 연 순간·확정한 순간에 읽는다 - 줄 메뉴로
 * 나가도 그 대화가 열려 있으면 머리 ⋮ 와 같은 `seenSeq`·뿌리 후보를 쓴다. 구독 알림을 내지 않는다(글이 올 때마다 사이드바를 다시 그리지 않게).
 */
interface OpenTimeline {
  workspaceId: string;
  channelId: string;
  newestSeq: number | null;
  messageIds: readonly string[];
}

let openTimeline: OpenTimeline | null = null;

export function setOpenTimeline(next: OpenTimeline | null): void {
  openTimeline = next;
}

export function openTimelineFor(workspaceId: string, channelId: string): OpenTimeline | null {
  const current = openTimeline;
  if (current === null) return null;
  return current.workspaceId.toLowerCase() === workspaceId.toLowerCase() &&
    current.channelId.toLowerCase() === channelId.toLowerCase()
    ? current
    : null;
}

/** 시험 전용. */
export function resetDmLeaveStoreForTest(): void {
  openTimeline = null;
  snapshot = { request: null, receipts: [], version: 0 };
  for (const listener of listeners) listener();
}
