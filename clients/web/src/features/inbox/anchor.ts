// =============================================================================
// Jump from an inbox row to the message it is about (R-1 §2: "Enter 원본으로
// 점프").
//
// The destination row lives in the virtualised timeline, which mounts rows on
// demand, so the jump is two parts: the route carries the target seq in the URL
// (inspectable, and it survives a reload), and a short watcher scrolls the row
// into view once virtuoso has actually mounted it.
//
// The watcher reads the DOM rather than calling into the timeline because P1
// wave2 runs four surfaces in parallel and this ticket owns inbox/activity
// only; `data-seq` is already the timeline's published row identity (it is what
// the seq gate asserts against), so this leans on a contract that exists rather
// than reaching into another surface's state.
// =============================================================================

/** How long to keep looking for the row before giving up quietly. */
const WATCH_MS = 3_000;
const POLL_MS = 80;
/** How long the landed row stays tinted. Feedback, not decoration. */
const HIGHLIGHT_MS = 1_600;

// Written as a literal so the Tailwind scanner emits the class: it is applied
// imperatively below, not through JSX.
const HIGHLIGHT_CLASS = "bg-accent-soft";

/**
 * Route for a channel, optionally anchored at a message seq.
 * `seq` is omitted when the source projection does not carry one, and the link
 * then simply opens the channel instead of pretending to know the position.
 */
export function channelPath(channelId: string, seq?: number): string {
  const path = `/c/${encodeURIComponent(channelId)}`;
  return seq === undefined ? path : `${path}?seq=${seq}`;
}

/**
 * Route for a channel anchored at a message ID rather than a seq (MOMO-677).
 *
 * The goal layer knows its anchor thread by `rootMessageId` and never sees a
 * seq: the workstream projection carries no ordering number, and deriving one
 * would mean guessing. So the same jump gets a second key rather than a second
 * mechanism — one path helper, one watcher, two identities the timeline already
 * publishes on its rows.
 */
export function messageAnchorPath(channelId: string, messageId: string): string {
  return `/c/${encodeURIComponent(channelId)}?msg=${encodeURIComponent(
    messageId.toLowerCase()
  )}`;
}

export function messageSelector(seq: number): string {
  return `[data-testid="timeline-message"][data-seq="${seq}"]`;
}

/** UUIDs cross the wire mixed-case; the row publishes its id lower-cased. */
export function messageIdSelector(messageId: string): string {
  return `[data-testid="timeline-message"][data-message-id="${messageId.toLowerCase()}"]`;
}

export interface WatchOptions {
  doc?: Document;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
  watchMs?: number;
}

/**
 * Scroll the row matching this selector into view once it mounts. Returns a
 * cancel function. If the row never appears (it is older than the loaded head),
 * the watcher expires silently: the channel is open, which is the outcome that
 * matters, and a message that says "not found" would be worse than nothing.
 */
function watchForRow(selector: string, options: WatchOptions = {}): () => void {
  const doc = options.doc ?? document;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? window.setTimeout.bind(window);
  const cancel = options.cancel ?? window.clearTimeout.bind(window);
  const deadline = now() + (options.watchMs ?? WATCH_MS);

  let handle: number | null = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const row = doc.querySelector<HTMLElement>(selector);
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.classList.add(HIGHLIGHT_CLASS);
      schedule(() => row.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
      return;
    }
    if (now() >= deadline) return;
    handle = schedule(tick, POLL_MS);
  };

  tick();

  return () => {
    stopped = true;
    if (handle !== null) cancel(handle);
  };
}

/** Jump to a message by its channel-ordered seq (인박스 · 활동). */
export function watchForMessage(seq: number, options: WatchOptions = {}): () => void {
  return watchForRow(messageSelector(seq), options);
}

/** Jump to a message by its id (작업 흐름의 앵커 스레드). */
export function watchForMessageId(
  messageId: string,
  options: WatchOptions = {}
): () => void {
  return watchForRow(messageIdSelector(messageId), options);
}
