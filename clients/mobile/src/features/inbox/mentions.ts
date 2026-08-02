import {fetchMessages, type Message} from '@momo/core/lib/api';
import {mentionsMember} from '@momo/core/features/inbox/model';

// =============================================================================
// Reading the mentions behind a count the server already gave us.
//
// ## Where this comes from, and why it is not imported
//
// This is `fetchMentionsAfter` from `clients/web/src/features/inbox/useInbox.ts`
// (lines 188–216), re-implemented rather than shared. It is **not** in
// `@momo/core` today, and that looks like an oversight rather than a decision:
// the function is pure async over two core calls, touches no DOM, and both
// clients need exactly it. It is flagged in the PR as an extraction candidate —
// the reason it was not extracted *in* this batch is that
// `packages/momo-core` is frozen here (the purity gate and the web client's
// regression numbers are the evidence this batch owes), and moving a function
// between packages is a change with two consumers to re-verify.
//
// The loop and its four exit conditions are reproduced deliberately, in order:
// a divergence between the two clients here would show up as a phone that finds
// a different set of mentions than the desktop for the same account, which is
// the kind of disagreement nobody debugs because nobody believes it.
//
// ## The rule the loop encodes (P7 / ADR-0109)
//
// The SERVER decides which channels hold unread mentions and how many
// (`read_state.mention_count`), and it decided WHO was mentioned at insert time
// (`mention_member_ids` on the message). This client never scans a body for an
// @handle: handles and display names change, the recorded decision does not.
// All this does is fetch the rows behind a number it was handed.
// =============================================================================

/** Ascending page size. The server's own page cap for `?after=`. */
export const MENTION_PAGE_LIMIT = 50;
/** At most this many pages per channel, so one busy channel cannot run forever. */
export const MENTION_MAX_PAGES = 4;

export async function fetchMentionsAfter(
  workspaceId: string,
  channelId: string,
  afterSeq: number,
  selfMemberId: string,
  expected: number,
): Promise<Message[]> {
  const found: Message[] = [];
  let cursor = afterSeq;
  for (let page = 0; page < MENTION_MAX_PAGES; page += 1) {
    const result = await fetchMessages(workspaceId, channelId, {
      after: cursor,
      limit: MENTION_PAGE_LIMIT,
    });
    // Nothing above the cursor: the projection and the log agree, we are done.
    if (result.messages.length === 0) break;
    for (const message of result.messages) {
      if (mentionsMember(message, selfMemberId)) found.push(message);
    }
    const maxSeq = result.messages.reduce(
      (max, message) => Math.max(max, message.seq),
      cursor,
    );
    // A page that did not advance the cursor would make the next request
    // identical to this one. Breaking is what keeps this bounded even if the
    // server ever answers with rows at or below `after`.
    if (maxSeq <= cursor) break;
    cursor = maxSeq;
    // The server said there were `expected` of them; once they are all in hand
    // there is nothing left to look for.
    if (found.length >= expected) break;
    // A short page is the end of the channel.
    if (result.messages.length < MENTION_PAGE_LIMIT) break;
  }
  return found;
}
