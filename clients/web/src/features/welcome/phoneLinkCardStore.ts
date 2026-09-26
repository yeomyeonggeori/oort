// =============================================================================
// 첫 대화 채널의 「폰에서도」 카드 상태 (#2818, ADR-0193 D7).
//
// 예전에는 로그인 뒤 전체 화면 단계(`PhoneLinkFirstRun`)였고, 그 표시는 이번 탭
// sessionStorage에만 살았다. 이제는 채널 안 지속 카드(ADR-0182 ③)라 사용자가
// 치울 때까지 남는다. 그래서 localStorage에 워크스페이스 키로 둔다.
//
//   pending    카드가 선다(코메토 대기 + [QR 만들기] + [나중에]).
//   collapsed  [나중에]를 눌렀다. 「설정 › 기기」 재진입 한 줄만 남는다.
//   dismissed  한 줄까지 닫았다. 다시 서지 않는다.
//
// 접힘·닫힘은 이 기기에만 저장된다(이슈 Acceptance). 서버에 쓰지 않는다.
// =============================================================================

export const PHONE_LINK_CARD_PREFIX = "oort.phoneLinkCard.v1:";

export type PhoneLinkCardState = "pending" | "collapsed" | "dismissed";

const STATES: readonly PhoneLinkCardState[] = ["pending", "collapsed", "dismissed"];

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function phoneLinkCardKey(workspaceId: string): string {
  return `${PHONE_LINK_CARD_PREFIX}${workspaceId.toLowerCase()}`;
}

export function readPhoneLinkCard(workspaceId: string): PhoneLinkCardState | null {
  try {
    const raw = store()?.getItem(phoneLinkCardKey(workspaceId)) ?? null;
    return STATES.includes(raw as PhoneLinkCardState)
      ? (raw as PhoneLinkCardState)
      : null;
  } catch {
    return null;
  }
}

function write(workspaceId: string, state: PhoneLinkCardState): void {
  try {
    store()?.setItem(phoneLinkCardKey(workspaceId), state);
  } catch {
    // 저장소를 거절하는 창(비공개 모드)에서는 카드가 이번 렌더에만 산다.
  }
  emit();
}

/**
 * 가입·재가입이 찍는다. 이미 접었거나 닫은 기기에서는 되살리지 않는다:
 * 「접힘은 이 기기에 저장된다」가 다시 로그인했다고 풀리면 안 된다.
 */
export function markPhoneLinkCardPending(workspaceId: string): void {
  if (readPhoneLinkCard(workspaceId) !== null) return;
  write(workspaceId, "pending");
}

export function collapsePhoneLinkCard(workspaceId: string): void {
  write(workspaceId, "collapsed");
}

export function dismissPhoneLinkCard(workspaceId: string): void {
  write(workspaceId, "dismissed");
}

export function subscribePhoneLinkCard(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function clearPhoneLinkCardForTests(workspaceId: string): void {
  try {
    store()?.removeItem(phoneLinkCardKey(workspaceId));
  } catch {
    // 시험 전용
  }
  emit();
}
