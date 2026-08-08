// =============================================================================
// Which channel is on screen right now (goal B8 H10).
//
// The sidebar needs this to answer one question: does the row the reader is
// currently looking at still get an unread badge? The server says yes for the
// length of a round trip, because the read cursor is advanced by a PUT that
// leaves after the message arrives (ChatShell). For that window, and for as
// long as the PUT is failing, the app shows a count for a channel whose
// messages are on the reader's screen. That is not a lag, it is a contradiction:
// "새 메시지 1" beside text that has already been read.
//
// So the rule the sidebar applies is the same one the read cursor is trying to
// express, applied without waiting for the wire: the channel you are reading is
// read. Nothing else is touched, and the server remains the only thing that
// counts (P7) for every row you are not looking at.
//
// Pure and tested because the path shapes are the part that rots: this client
// is a HashRouter, the index route renders a channel WITHOUT naming it in the
// address, and a channel id crosses the wire in mixed case.
// =============================================================================

/**
 * The channel the channel surface is showing, folded to lower case, or null on
 * a route that is not a channel at all.
 *
 * `indexFallbackId` is what the index route ("/") resolves to, which the caller
 * computes the same way ChatShell does (first channel, else first DM). Passing
 * it in rather than deriving it here keeps this function free of the workspace
 * query and makes the "/" case assertable.
 */
export function openChannelId(
  pathname: string,
  indexFallbackId: string | null
): string | null {
  const match = /^\/c\/([^/?#]+)/.exec(pathname);
  if (match) {
    try {
      return decodeURIComponent(match[1]).toLowerCase();
    } catch {
      return match[1].toLowerCase();
    }
  }
  if (pathname === "/" || pathname === "") {
    return indexFallbackId === null ? null : indexFallbackId.toLowerCase();
  }
  return null;
}
