import {threadRollup, type Message, type ThreadRollup} from '@momo/core/lib/api';

// =============================================================================
// 답글을 답글로 보이게 하는 데 필요한 두 가지 사실 — 둘 다 이미 손에 있는
// 메시지 배열에서 나온다.
//
// 성재, iPhone 17: "답글쪽은 아직 뭔가 부족한 거 같아. 답글을 달았는데, 답글
// 모양 아이콘과 함께 별도로 안 보이는 거 같아."
//
// ## 답글을 달면 정확히 무슨 일이 일어나는가 (고치기 전)
//
// 답글은 `rootId` 가 붙은 **이 채널의 메시지**다. 서버의 채널 히스토리 질의가
// 답글을 걸러내지 않으므로(`list_channel_page` 에 `root_id IS NULL` 술어가
// 없다) 답글은 채널 타임라인에 **평범한 행으로 그대로 나타난다** — 답글이라는
// 표시 없이. 그리고 루트 밑의 「답글 N개」는 서버가 페이지에 실어 준
// `message.thread` 에서만 온다. 그 값은 내가 답글을 달아도 **변하지 않는다**:
// 로컬 상태에 들어 있는 루트 메시지는 답글이 달리기 전에 받은 그 객체다.
//
// 그래서 답글이 없던 메시지에 첫 답글을 달고 스레드를 닫으면 화면은 이렇게 된다:
// 루트는 아무 변화가 없고, 채널 맨 아래에 방금 쓴 글이 **보통 메시지처럼** 하나
// 늘어 있다. 어디에도 「답글」이라고 적혀 있지 않다. 성재가 본 것이 이것이다.
//
// ## 왜 웹을 그대로 베끼지 않는가
//
// 베낄 규약이 없기 때문이다. 웹의 `MessageRow` 는 `rootId` 를 아예 읽지 않는다 —
// 부모 인용도, 아이콘도, 들여쓰기도 없다. 롤업 한 줄이 전부다. 반대로 macOS 는
// 답글을 목록에서 **빼 버린다**(`MessageListView.swift`: `filter { $0.rootId ==
// nil }`), 그게 P12 「채널 밖 답글」의 문자 그대로의 이행이다. 셋이 서로 다르다.
//
// 이 배치는 결함 수정이므로 **데이터 모델을 웹과 같이 두고**(답글은 채널에 남는다)
// 빠져 있던 표식만 채운다. 답글을 목록에서 빼는 것은 P12 를 향한 진짜 결정이고,
// ADR 없이 드라이브바이로 할 일이 아니다 — 읽던 사람의 눈앞에서 행이 사라지는
// 변화다.
//
// ## 두 사실 모두 배열에서 파생한다 — 새 요청이 없다
//
// 스레드를 열면 `loadReplies` 가 그 루트의 답글을 **전부** 같은 seq 상태로
// 병합한다. 그러니 답글을 단 직후 이 클라이언트는 이미 자기가 쓴 답글을 들고
// 있다. 서버의 롤업이 오래된 것이지, 이쪽이 모르는 것이 아니다.
// =============================================================================

/** Case-insensitive, matching `uuidEq` — the ids come from two wires. */
function key(id: string): string {
  return id.toLowerCase();
}

export interface ThreadContext {
  /** Every message by id, so a reply can name the message it answers. */
  byId: Map<string, Message>;
  /** What THIS client can see under each root. Never the whole truth. */
  localRollup: Map<string, ThreadRollup>;
}

/**
 * Index one channel's messages for the two questions a row asks.
 *
 * O(n) over the array the list is already rendering, memoised by the caller on
 * the same identity the list uses — so this costs one pass per merge, not one
 * per row.
 */
export function buildThreadContext(messages: Message[]): ThreadContext {
  const byId = new Map<string, Message>();
  const localRollup = new Map<string, ThreadRollup>();
  for (const message of messages) {
    byId.set(key(message.id), message);
  }
  for (const message of messages) {
    if (message.rootId === undefined) continue;
    // A tombstone is not a reply any more. Counting it would leave 「답글 1개」
    // under a root whose only reply says 삭제된 메시지, which is a count of
    // nothing.
    if (message.state === 'deleted') continue;
    const root = key(message.rootId);
    const seen = localRollup.get(root);
    localRollup.set(root, {
      replyCount: (seen?.replyCount ?? 0) + 1,
      lastReplySeq: Math.max(seen?.lastReplySeq ?? 0, message.seq),
      lastReplyAtMs: Math.max(seen?.lastReplyAtMs ?? 0, message.createdAtMs),
    });
  }
  return {byId, localRollup};
}

/**
 * The message this one answers, or null when it is not a reply — or when the
 * root is not loaded.
 *
 * The two nulls are told apart by the caller through `message.rootId`, and the
 * second one is real: a reply can arrive on the rail while its root sits above
 * the oldest page this client has fetched. **모르면 모른다고 말한다** — the row
 * still says 답글, it just cannot say to whom.
 */
export function parentOf(
  message: Message,
  context: ThreadContext,
): Message | null {
  if (message.rootId === undefined) return null;
  return context.byId.get(key(message.rootId)) ?? null;
}

/**
 * What to draw under a root: the server's rollup and this client's own view of
 * the same thread, folded so that neither can hide the other.
 *
 * **Why not just the server's.** Because the server's rides the page that
 * delivered the root, and nothing re-delivers a root when a reply lands under
 * it. Reply to a message with no replies and the server's rollup stays null for
 * as long as that page is on screen — so the one visible consequence of the
 * thing you just did is nothing at all. That is the defect.
 *
 * **Why not just the local one.** Because it only counts replies this client
 * has fetched, which is none until the thread is opened. A root with 5 replies
 * would announce 0.
 *
 * So: the larger of the two, field by field. The server wins while it is ahead
 * (history nobody opened), the local count wins the moment it goes past it (a
 * reply I just wrote), and neither ever pulls the number DOWN — a count that
 * drops as pages load would read as replies disappearing.
 */
export function rollupFor(
  message: Message,
  context: ThreadContext,
): ThreadRollup | null {
  // A reply can never carry a rollup: the server's projection joins the thread
  // table only `AND m.root_id IS NULL`, which is what keeps momo threads one
  // level deep in the read path as well as the write path.
  if (message.rootId !== undefined) return null;
  const server = threadRollup(message);
  const local = context.localRollup.get(key(message.id));
  if (!server && !local) return null;
  return {
    replyCount: Math.max(server?.replyCount ?? 0, local?.replyCount ?? 0),
    lastReplySeq: Math.max(server?.lastReplySeq ?? 0, local?.lastReplySeq ?? 0),
    lastReplyAtMs: Math.max(
      server?.lastReplyAtMs ?? 0,
      local?.lastReplyAtMs ?? 0,
    ),
  };
}
