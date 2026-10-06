import {NON_SECRET_KEYS, nonSecretStore} from '../../../storage/kv';

// =============================================================================
// 「작업 맡기기」 시트가 닫혔다 다시 열릴 때 무엇이 남는가 (#3588, owner 결정).
//
// - **제목·설명·저장소·브랜치는 이 앱 실행 안의 메모리에만 남는다.** 디스크에 쓰지 않는다:
//   작업 설명은 사람이 쓴 본문이고(저장소 이름·고객 사정이 들어갈 수 있다), 보내기 전에는
//   서버도 본 적이 없다. 앱이 죽으면 사라지는 것이 약속이다. 보내면 지운다.
// - 마지막에 쓴 에이전트·채널은 **id 둘만** MMKV에 둔다(키 `delegateLastTarget`). 글이
//   아니라 선택이고, 잃어도 처음처럼 아무것도 미리 고르지 않을 뿐이다.
// =============================================================================

export interface DelegateDraft {
  title: string;
  brief: string;
  repo: string;
  branch: string;
}

export const EMPTY_DRAFT: DelegateDraft = {title: '', brief: '', repo: '', branch: ''};

const drafts = new Map<string, DelegateDraft>();

export function readDraft(workspaceId: string): DelegateDraft {
  return drafts.get(workspaceId) ?? EMPTY_DRAFT;
}

export function writeDraft(workspaceId: string, draft: DelegateDraft): void {
  const empty =
    draft.title === '' && draft.brief === '' && draft.repo === '' && draft.branch === '';
  if (empty) drafts.delete(workspaceId);
  else drafts.set(workspaceId, draft);
}

export function clearDraft(workspaceId: string): void {
  drafts.delete(workspaceId);
}

/** Test seam. */
export function __resetDelegateDrafts(): void {
  drafts.clear();
}

export interface LastTarget {
  agentMemberId: string;
  channelId: string;
}

export function readLastTarget(workspaceId: string): LastTarget | null {
  try {
    const raw = nonSecretStore().getString(NON_SECRET_KEYS.delegateLastTarget);
    if (raw === undefined) return null;
    const all = JSON.parse(raw) as Record<string, unknown>;
    const mine = all[workspaceId];
    if (typeof mine !== 'object' || mine === null) return null;
    const {agentMemberId, channelId} = mine as Record<string, unknown>;
    return typeof agentMemberId === 'string' && typeof channelId === 'string'
      ? {agentMemberId, channelId}
      : null;
  } catch {
    return null;
  }
}

export function writeLastTarget(workspaceId: string, target: LastTarget): void {
  try {
    const store = nonSecretStore();
    const raw = store.getString(NON_SECRET_KEYS.delegateLastTarget);
    const all = raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
    store.set(
      NON_SECRET_KEYS.delegateLastTarget,
      JSON.stringify({...all, [workspaceId]: target}),
    );
  } catch {
    /* 편의일 뿐이다 — 못 쓰면 다음에 다시 고른다 */
  }
}
