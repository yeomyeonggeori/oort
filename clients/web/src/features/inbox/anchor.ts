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
 * Route for a search hit (goal B12 H5).
 *
 * 두 열쇠를 **함께** 싣는다. `msg`는 정확한 신원이라 찾는 데 쓰이고, `seq`는
 * 채널의 순서값이라 **못 찾았을 때 이유를 말하는 데** 쓰인다: 목표 seq가 지금
 * 로드된 가장 오래된 seq보다 작으면 "더 위쪽에 있어 아직 불러오지 않았다"가
 * 추측이 아니라 사실이 된다. 검색 결과는 이미 둘 다 들고 있다
 * (`MessageSearchHit.messageId` / `.seq`).
 */
export function searchHitPath(
  channelId: string,
  messageId: string,
  seq: number
): string {
  return `${messageAnchorPath(channelId, messageId)}&seq=${seq}`;
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

/**
 * Route for a channel with the 작업 세션 패널 opened on one session (MOMO-679).
 *
 * A goal's run ledger lists work sessions, and those live in a PANE inside the
 * channel surface rather than on a route of their own, so a row that hands the
 * reader to one has to name both the channel and the session. It travels in the
 * URL rather than in component state because the two surfaces are different
 * routes: 작업 흐름 상세 unmounts on the way there, and a message passed through
 * state would have nowhere to live in between.
 */
export function workSessionPath(channelId: string, sessionId: string): string {
  return `/c/${encodeURIComponent(channelId)}?work=${encodeURIComponent(
    sessionId.toLowerCase()
  )}`;
}

export function messageSelector(seq: number): string {
  return `[data-testid="timeline-message"][data-seq="${seq}"]`;
}

/**
 * UUIDs cross the wire mixed-case; the row publishes its id lower-cased.
 *
 * The id is INTERPOLATED INTO A CSS SELECTOR, so it is escaped rather than
 * assumed to be a uuid. `querySelector` throws `SyntaxError` on a malformed
 * selector, and since ChatShell now reads this anchor out of `?msg=` the value
 * arrives from the address bar: one pasted link carrying a quote would take the
 * whole channel surface down instead of quietly failing to find a row.
 *
 * The value sits inside a QUOTED attribute value, and a CSS string can hold
 * anything except an unescaped `"`, an unescaped `\` and a raw newline. So those
 * three are exactly what this escapes, rather than reaching for `CSS.escape`:
 * that helper escapes for the IDENTIFIER grammar (it would also backslash every
 * `-` leading a digit and every space), it is a DOM global this module otherwise
 * does not need, and a conditional fallback would leave the branch these tests
 * run in different from the branch the product runs in.
 */
export function messageIdSelector(messageId: string): string {
  return `[data-testid="timeline-message"][data-message-id="${escapeAttr(
    messageId
  )}"]`;
}

function escapeAttr(messageId: string): string {
  return messageId
    .toLowerCase()
    .replace(/["\\]/g, "\\$&")
    .replace(/[\n\r\f]/g, " ");
}

/**
 * 이 메시지를 **대신해 서 있는** 행 (design-review U4-5 H-1 · 코어
 * `timeline/deletedFold.ts`).
 *
 * 연달아 지워진 묘비는 한 줄로 접히고, 접혀 들어간 행은 DOM에 없다. 그 상태에서
 * 삭제 원본을 가리킨 인용을 누르면 위 선택자가 빈손으로 돌아오고 화면은 「위로
 * 올려 이전 대화를 더 불러오세요」라고 말한다 — 원본은 **이미 로드돼 있고 접혀
 * 있을 뿐인데**. 폰이 그 거짓 지시를 먼저 만났고(이슈 1105), 접기가 코어로 올라오면서
 * 웹에도 같은 자리가 생겼으므로 착지도 같은 계약으로 온다.
 *
 * 「인용된 묘비는 접지 않는다」가 아니라 이쪽인 이유는 `deletedFold.ts` 머리말에
 * 있다. 요지: 접힌 머리 행은 **원본이 지금 화면에서 서 있는 자리 그 자체**이고,
 * 「삭제된 메시지 3개」는 원본을 포함해서 하는 말이다.
 *
 * `~=`는 공백으로 이은 목록에서 낱개를 고른다. 그래서 이 착지는 새 상태도 새
 * 기계도 만들지 않는다 — 행이 이미 내보내는 속성 하나를 읽는 두 번째 선택자다.
 */
export function foldedStandInSelector(messageId: string): string {
  return `[data-testid="timeline-message"][data-deleted-folded-ids~="${escapeAttr(
    messageId
  )}"]`;
}

export interface WatchOptions {
  doc?: Document;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
  watchMs?: number;
  /**
   * 행을 끝내 찾지 못하고 시한이 지났다. 호출자가 그 사실을 말할 수 있게 알린다
   * (goal B12 R1 High-3).
   *
   * 취소된 감시자는 부르지 않는다: 채널을 옮겨서 그만둔 것은 실패가 아니다.
   */
  onExpire?: () => void;
}

/**
 * Scroll the row matching this selector into view once it mounts. Returns a
 * cancel function.
 *
 * 행이 끝내 나타나지 않으면(로드된 머리보다 오래된 메시지) 감시자는 조용히
 * 만료된다. 원래 그 침묵은 인박스·활동을 위한 판단이었다. 그 표면들의 행은
 * 대개 최근이라 거의 언제나 찾아지고, 드물게 못 찾아도 "채널은 열렸다"가 쓸 만한
 * 결과이기 때문이다.
 *
 * **검색에서는 그 가정이 뒤집힌다**: 검색은 정의상 머리에 없는 것을 찾는
 * 표면이라 만료가 예외가 아니라 흔한 경로다. 사용자는 화면에서 읽은 그 문장을
 * 눌렀는데 전혀 다른 메시지가 있는 채널 바닥에 도착하고, 표식도 문장도 재시도도
 * 없다. 그래서 침묵은 **기본값으로 남기되** 만료를 알릴 통로를 연다. 무엇을 할지는
 * 표면이 정한다.
 */
function watchForRow(
  selectors: string | readonly string[],
  options: WatchOptions = {}
): () => void {
  const doc = options.doc ?? document;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? window.setTimeout.bind(window);
  const cancel = options.cancel ?? window.clearTimeout.bind(window);
  const deadline = now() + (options.watchMs ?? WATCH_MS);
  // 선택자가 여럿이면 **순서가 곧 우선순위**다: 자기 행이 있으면 거기 서고, 없을
  // 때만 대신 서 있는 행으로 간다. 한 선택자에 `,`로 합치지 않는 이유가 이것이다 —
  // CSS의 선택자 목록은 문서 순서로 첫 요소를 돌려줄 뿐 어느 갈래가 맞았는지
  // 모르고, 그러면 대리 착지가 직접 착지를 앞지르는 순간이 생긴다.
  const list = typeof selectors === "string" ? [selectors] : selectors;

  let handle: number | null = null;
  let stopped = false;

  const find = (): HTMLElement | null => {
    for (const selector of list) {
      const hit = doc.querySelector<HTMLElement>(selector);
      if (hit !== null) return hit;
    }
    return null;
  };

  const tick = () => {
    if (stopped) return;
    const row = find();
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.classList.add(HIGHLIGHT_CLASS);
      schedule(() => row.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
      return;
    }
    if (now() >= deadline) {
      options.onExpire?.();
      return;
    }
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

/**
 * Jump to a message by its id (작업 흐름의 앵커 스레드 · 인용 점프).
 *
 * 두 자리를 이 순서로 본다: **그 행 자체**, 그리고 없으면 **그것을 대신해 서 있는
 * 행**(연속 묘비 접기, U4-5 H-1). 셋째는 없다 — 로드되지 않은 메시지는 여전히
 * 없는 것이고, 그때 만료가 부르는 「더 위쪽에 있습니다」는 참인 말이다.
 */
export function watchForMessageId(
  messageId: string,
  options: WatchOptions = {}
): () => void {
  return watchForRow(
    [messageIdSelector(messageId), foldedStandInSelector(messageId)],
    options
  );
}
