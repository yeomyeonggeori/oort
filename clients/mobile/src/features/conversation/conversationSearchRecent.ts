import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';
import {
  foldRecent,
  RECENT_CONVERSATION_LIMIT,
  RECENT_LIMIT,
} from './conversationSearchModel';

// =============================================================================
// 대화 안 검색의 「최근 검색」 — 이 폰에만 있는 기억 (#5364).
//
// 열쇠는 `워크스페이스:채널`(소문자)이고 값은 말 목록(최근이 앞)이다. 한 덩이의 JSON 지도로 비밀 아닌 저장소(MMKV)에 적는다 — 초안
// (`drafts.ts`)과 같은 모양·같은 규율이다:
//
//   - **깨진 값은 빈 지도로 읽는다.** 검색어 하나 때문에 앱이 죽는 것은 검색어를 잃는 것보다 나쁘다. 모양이 틀린 항목만 건너뛴다.
//   - **비었으면 키 자체를 지운다.** 「비었으면 키가 없다」가 이 저장소의 계약이다.
//   - **정원이 둘이다.** 한 대화에 `RECENT_LIMIT`(6)개, 대화는 `RECENT_CONVERSATION_LIMIT`(40)곳 — 지도는 쓸 때마다 이 대화를 맨 뒤(가장 최근)로
//     옮기므로 넘치면 가장 오래 안 쓴 대화가 먼저 떨어진다(JS 객체의 열쇠 순서가 곧 최근 순서다).
//   - **로그아웃이 전부 지운다**(`clearAllConversationSearchRecent`). 무엇을 찾았는지는 다음 사람에게 보일 일이 아니다.
//
// 읽기·쓰기가 저장소 오류로 던져도 검색은 멈추지 않는다 — 최근 검색은 편의이고, 없으면 처음처럼 비어 있을 뿐이다.
// =============================================================================

type RecentMap = Record<string, string[]>;

/** 지도의 열쇠. 워크스페이스·채널 id 는 대소문자가 섞여 오므로 눕혀서 같은 대화가 둘로 갈라지지 않게 한다. */
export function recentKey(workspaceId: string, channelId: string): string {
  return `${workspaceId.toLowerCase()}:${channelId.toLowerCase()}`;
}

function readMap(): RecentMap {
  try {
    const raw = nonSecretStore().getString(NON_SECRET_KEYS.conversationSearchRecent);
    if (raw === undefined) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: RecentMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const terms = value.filter((term): term is string => typeof term === 'string' && term !== '');
      if (terms.length > 0) out[key] = terms.slice(0, RECENT_LIMIT);
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: RecentMap): void {
  try {
    const store = nonSecretStore();
    if (Object.keys(map).length === 0) {
      store.remove(NON_SECRET_KEYS.conversationSearchRecent);
      return;
    }
    store.set(NON_SECRET_KEYS.conversationSearchRecent, JSON.stringify(map));
  } catch {
    // 저장이 안 돼도 방금 친 검색은 이미 화면에 있다. 못 남기면 다음에 비어 있을 뿐이다.
  }
}

/** 이 대화의 최근 검색(최근이 앞). 없으면 빈 목록. */
export function readRecent(workspaceId: string, channelId: string): string[] {
  return readMap()[recentKey(workspaceId, channelId)] ?? [];
}

/** 한 말을 이 대화의 최근 검색에 더하고 새 목록을 돌려준다. 서버가 안 받아 줄 말(2자 미만)이면 아무것도 바꾸지 않는다. */
export function rememberRecent(workspaceId: string, channelId: string, raw: string): string[] {
  const map = readMap();
  const key = recentKey(workspaceId, channelId);
  const current = map[key] ?? [];
  const next = foldRecent(current, raw);
  if (next.length === current.length && next.every((term, index) => term === current[index])) return current;
  // 열쇠를 지우고 다시 넣어 맨 뒤(가장 최근)로 옮긴다.
  delete map[key];
  map[key] = next;
  const keys = Object.keys(map);
  for (const stale of keys.slice(0, Math.max(0, keys.length - RECENT_CONVERSATION_LIMIT))) delete map[stale];
  writeMap(map);
  return next;
}

/** 이 대화의 최근 검색을 모두 지운다(「지우기」). */
export function forgetRecent(workspaceId: string, channelId: string): void {
  const map = readMap();
  delete map[recentKey(workspaceId, channelId)];
  writeMap(map);
}

/** 로그아웃 — 이 기기에 남은 모든 대화의 최근 검색을 지운다. */
export function clearAllConversationSearchRecent(): void {
  try {
    nonSecretStore().remove(NON_SECRET_KEYS.conversationSearchRecent);
  } catch {
    // 로그아웃 자체는 이미 진행됐다. 저장소가 답하지 않으면 더 할 수 있는 일이 없다.
  }
}
