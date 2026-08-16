import { uuidEq, type Message, type QuotedMessage } from "../../lib/api";

// =============================================================================
// 인용 답글 — 두 클라이언트가 공유하는 정본 (ADR-0148, goal B3 W1/M1).
//
// 이 파일이 있는 이유는 인용이 렌더 규칙 하나가 아니라 **여러 개의 작은 판단**의
// 묶음이기 때문이다: 어디까지 자르나, 삭제된 원본을 뭐라고 부르나, 에이전트의
// 긴 출력이 인용되면 무엇을 보여주나, 인용의 인용은 어디까지 그리나. 웹과 폰이
// 그 판단을 각자 내리면 같은 대화가 두 기기에서 다르게 읽힌다 — 인용은 정의상
// "저기서 저 말을 했다"를 주장하는 장치라서, 두 화면이 다르게 자르면 주장 자체가
// 흔들린다.
//
// **스냅샷이 아니라 참조다** (ADR-0148 규칙 3). 서버는 페이지를 읽을 때마다 원본
// 행에서 인용을 다시 만든다(`PagedMessage.reply_to`). 그래서 클라가 할 일은
// 「받은 것을 그린다」이고, 인용을 그리기 위해 **추가 요청을 하지 않는다**. 원본이
// 수정되면 다음 페이지에서 따라 바뀌고, 삭제되면 tombstone으로 온다.
//
// 그런데 실시간 프레임에는 `reply_to`가 없다(`reply_to_id`만 있다 —
// `momo-messaging::build_broadcast_payload`가 그렇게 쓴 이유는 outbox 행이 한 번
// 쓰이고 영원히 재생되므로 본문을 실으면 그게 곧 금지된 스냅샷이기 때문이다).
// 그래서 [`resolveQuote`]는 두 경로를 갖는다: 서버가 풀어 준 것이 있으면 그것을
// 쓰고, 없으면 **이미 화면에 들고 있는 같은 채널의 행**에서 푼다. 두 번째 경로도
// 재조회가 아니다 — 인용 대상은 같은 채널 안에 있어야 하므로(규칙 2) 대개 방금
// 읽던 그 행이다.
// =============================================================================

/** 인용 블록이 본문을 몇 줄까지 보여주나 (ADR-0148 미결 1). */
export const QUOTE_EXCERPT_MAX_LINES = 2;

/**
 * 한 줄이 몇 글자에서 잘리나.
 *
 * 두 값은 **웹과 폰이 같다**. ADR-0148이 "폰과 웹이 달라도 되는지"를 열어 두었고,
 * 답은 같아야 한다는 쪽이다: 인용 블록은 자기를 인용한 메시지 **위에** 앉으므로,
 * 원본이 답글보다 높으면 타임라인이 "원본을 다시 올렸다"로 읽힌다. 2줄은 블록이
 * 종속적으로 남는 상한이고, 그 판단은 화면 폭이 아니라 대화의 모양에서 나오므로
 * 기기별로 갈릴 이유가 없다.
 */
export const QUOTE_EXCERPT_MAX_CHARS = 140;

/** 삭제된 원본이 인용된 자리. 우리 문장이므로 마크다운을 타지 않는다. */
export const QUOTE_DELETED_TEXT = "삭제된 메시지";

/**
 * 규칙 4 — 인용의 인용은 원본만 그린다. 두 번째 겹은 이 표시뿐이고, 대상 id가
 * 애초에 와이어에 없으므로(`quotesAnother`는 boolean이다) 계단을 만들 재료 자체가
 * 없다.
 */
export const QUOTE_NESTED_MARK = "인용 포함";

/**
 * 컴포저 칩과 행 액션이 쓰는 어휘. 스레드의 「답글」과 절대 겹치지 않는다.
 *
 * **「인용하기」가 아니라 「인용해서 답하기」다** (2026-08-05 양 클라 정본). 이 낱말은
 * 메뉴에서 「답글 달기」 **바로 옆**에 서므로, 무엇을 하는지만 말하면 두 항목이 「답을
 * 단다」로 똑같이 읽힌다. 갈리는 지점은 *답이 어디로 가는가*다 — 답글은 대화를
 * 스레드로 치우고, 인용은 본류에 남기면서 맥락만 끌어온다(ADR-0148의 핵심 문장).
 * 「해서 답하기」가 그 「본류에 남는다」를 낱말 안에 넣는다.
 */
export const QUOTE_ACTION_LABEL = "인용해서 답하기";
export const QUOTE_CANCEL_LABEL = "인용 취소";
export const QUOTE_JUMP_HINT = "원본으로 이동";

/**
 * 본문이 내용이 아닌 메시지 종류의 이름 (ADR-0148 미결 2).
 *
 * 에이전트의 긴 출력이 인용되면 `body`를 자르는 것은 답이 아니다. 도구 실행이나
 * diff의 `body`는 사람이 읽을 문장이 아니고, 우리가 `detail.rows`를 전부 펼치는
 * 문제를 인용 블록 안으로 한 번 더 들여오는 일이다. 종류를 말하고 원본으로 보낸다.
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  tool_call: "도구 실행",
  tool_result: "도구 결과",
  diff: "코드 변경",
  artifact: "산출물",
  approval_request: "승인 요청",
  system: "시스템 알림",
};

/**
 * 인용 블록이 그리는 것. `kind`는 세 갈래뿐이고 그 셋이 서로 배타인 것이 요점이다
 * — 「삭제됐다」와 「아직 못 불러왔다」를 한 상태로 뭉치면 화면이 삭제되지 않은
 * 메시지를 삭제됐다고 말하게 된다.
 */
export type QuoteBlock =
  | {
      kind: "ready";
      /** 원본의 id. 점프의 목적지. */
      targetId: string;
      /** 원본의 seq. 못 찾았을 때 「더 위쪽이다」를 사실로 말할 수 있게 한다. */
      targetSeq: number | null;
      authorMemberId: string;
      /** 표시할 줄. 종류 라벨이면 한 줄이다. */
      lines: string[];
      /** 잘렸다. 「원본으로 이동」이 있다는 뜻이 아니라, 이게 전부가 아니라는 뜻. */
      truncated: boolean;
      /** 규칙 4 — 이 원본이 또 무언가를 인용했다. 표시만. */
      quotesAnother: boolean;
      /** 원본이 수정된 뒤의 상태. 인용은 참조이므로 따라 바뀐 것이 맞다. */
      edited: boolean;
    }
  | {
      /** 원본이 지워졌다. 사본을 남기지 않는 것이 삭제의 뜻이다. */
      kind: "deleted";
      targetId: string;
      targetSeq: number | null;
      authorMemberId: string | null;
    }
  | {
      /**
       * 이 메시지는 무언가를 가리키는데, 그 무언가가 지금 이 화면에 없다.
       *
       * 실시간으로 도착한 인용 답글이 여기 온다(프레임에 `reply_to`가 없고, 원본이
       * 로드된 창 위쪽에 있는 경우). 「인용했다」는 참이므로 지우지 않고, 「무엇을」은
       * 모르므로 말하지 않는다.
       */
      kind: "unresolved";
      targetId: string;
      targetSeq: null;
    };

function normalizeLines(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * 인용 블록에 들어갈 줄과, 그것이 잘렸는지.
 *
 * 빈 줄을 버리는 이유: 인용은 두 줄을 쓸 수 있고, 원본이 문단 사이를 빈 줄로
 * 띄웠다면 그 빈 줄이 인용의 예산 절반을 먹는다. 잘림 판정은 줄 수와 글자 수
 * **둘 다** 본다 — 한 줄에 500자를 쓴 메시지는 줄 수로는 안 잘리지만 화면에서는
 * 확실히 잘린다.
 */
export function quoteExcerpt(
  body: string,
  maxLines = QUOTE_EXCERPT_MAX_LINES,
  maxChars = QUOTE_EXCERPT_MAX_CHARS
): { lines: string[]; truncated: boolean } {
  const all = normalizeLines(body);
  if (all.length === 0) return { lines: [], truncated: false };
  const kept = all.slice(0, Math.max(1, maxLines));
  let truncated = kept.length < all.length;
  const lines: string[] = [];
  let budget = Math.max(1, maxChars);
  for (const line of kept) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    if (line.length > budget) {
      lines.push(line.slice(0, budget));
      truncated = true;
      budget = 0;
      continue;
    }
    lines.push(line);
    budget -= line.length;
  }
  return { lines, truncated };
}

/** 이 종류의 메시지가 인용됐을 때 본문 대신 말할 이름, 또는 null(본문을 쓴다). */
export function quotedKindLabel(type: string): string | null {
  return KIND_LABELS[type] ?? null;
}

/**
 * 이 인용이 실어 온 본문, **없으면 `undefined`** (이슈 #1498).
 *
 * 타입은 `body?: string`이라 말하지만 전선은 `"body": null`을 싣는다
 * (`momo_messaging::build_broadcast_payload`). 그리고 그 `null`이 여기 오는 길에
 * 정규화가 **한 줄도 없다**: `payloadToMessage`는 `p.body ?? undefined`로 접지만
 * 그것은 실시간 프레임 경로뿐이고, REST 페이지는 `isMessage`가 본문을 **보지 않은
 * 채** 통과시켜(`lib/api.ts`) 와이어 객체가 그대로 `Message`·`QuotedMessage`가 된다.
 * 선언 타입은 런타임 `null`을 막지 못한다 — `artifacts.ts`가 같은 사실로 타임라인을
 * 통째로 백지화했던 그 자리다(#1476).
 *
 * 이 파일에서 그 `null`은 던지지 않고 **조용히 틀렸다**. `=== undefined`로 묻던
 * 자리가 둘이었고 둘 다 샜다: 묘비 판정은 본문 없는 text를 못 알아봐 인용이 빈
 * 블록으로 서고, 로컬 행 → 인용 스냅샷은 `body: string | undefined`라고 선언된
 * 자리에 `null`을 실어 날랐다.
 *
 * **`null`까지만 부재로 접는다.** `''`와 공백뿐인 본문은 「본문이 없다」가 아니라
 * 「본문에 읽을 것이 없다」이고, 두 표면이 그 자리에 이미 다른 말을 세워 뒀다
 * (「내용 없는 메시지」 — 웹 `QuoteBlock.tsx`, 폰 `Quote.tsx`, 그리고 코어의
 * `PIN_EMPTY_BODY_TEXT`). 그 셋을 묘비로 접으면 화면이 **지워지지 않은 메시지를
 * 지워졌다고** 말한다 — ADR-0148이 가장 경계한 거짓말이고, 공백뿐인 본문의 인용은
 * 폰이 이미 「묘비가 아니므로 삭제라 말할 수 없다」로 못 박아 둔 경우다.
 * 그래서 `bodySlot.hasRenderableBody`는 묘비 판정이 아니라 **발췌가 비는 자리**에서
 * 지켜진다: `quoteExcerpt`의 `normalizeLines`가 줄마다 `trim`하고 빈 줄을 버리므로
 * 「줄이 하나도 없다」와 「읽을 글자가 없다」는 같은 답이고, `quote.test.ts`가 그
 * 일치를 못으로 박는다.
 */
function presentBody(body: string | null | undefined): string | undefined {
  return body ?? undefined;
}

/**
 * 이 인용이 묘비인가.
 *
 * `body`는 호출자가 [`presentBody`]로 이미 한 번 읽은 값이다 — 본문을 두 번 읽으면
 * 두 물음이 갈라지고, 갈라진 둘 중 하나만 고쳐지는 것이 이 파일이 겪은 결함이다.
 */
function isDeletedQuote(quoted: QuotedMessage, body: string | undefined): boolean {
  if (quoted.state === "deleted") return true;
  if (quoted.deletedAtMs !== undefined) return true;
  // 본문이 아예 없는 text는 tombstone이다 (서버가 `body`를 뺀다 — 키를 빼든 `null`을
  // 싣든 「본문이 없다」는 같은 사실이다). 종류 라벨이 있는 메시지는 본문이 없어도
  // 지워진 것이 아니다.
  return quoted.type === "text" && body === undefined;
}

/** 서버가 풀어 준 인용 하나를 블록으로. */
export function quoteBlockFrom(quoted: QuotedMessage): QuoteBlock {
  // 본문은 여기서 **한 번만** 읽는다: 묘비 판정과 발췌가 같은 값을 본다.
  const body = presentBody(quoted.body);
  if (isDeletedQuote(quoted, body)) {
    return {
      kind: "deleted",
      targetId: quoted.id,
      targetSeq: quoted.seq,
      authorMemberId: quoted.authorMemberId,
    };
  }
  const label = quotedKindLabel(quoted.type);
  const excerpt =
    label === null
      ? quoteExcerpt(body ?? "")
      : { lines: [label], truncated: false };
  return {
    kind: "ready",
    targetId: quoted.id,
    targetSeq: quoted.seq,
    authorMemberId: quoted.authorMemberId,
    lines: excerpt.lines,
    truncated: excerpt.truncated,
    quotesAnother: quoted.quotesAnother === true,
    edited: quoted.state === "edited" || quoted.editedAtMs !== undefined,
  };
}

/**
 * 화면에 이미 있는 행 하나를 인용 블록으로 (실시간 프레임 경로).
 *
 * 여기서 만드는 `QuotedMessage`는 **서버가 준 것과 같은 모양이어야 한다** — 이
 * 함수의 존재 이유가 「프레임에는 `reply_to`가 없다」이고, 두 경로가 다른 모양을
 * 만들면 같은 원본이 실시간에 도착했을 때와 새로고침한 뒤에 다르게 읽힌다.
 * 그래서 본문도 [`presentBody`]를 지나서만 실린다: 로컬 행의 런타임 `null`을 그대로
 * 옮기면 `body: string | undefined`라고 선언된 자리에 `null`이 앉고, 그 `null`은
 * 묘비 판정을 지나쳐 빈 인용 블록이 된다(#1498).
 */
function quoteBlockFromLocal(message: Message): QuoteBlock {
  const body = presentBody(message.body);
  return quoteBlockFrom({
    id: message.id,
    seq: message.seq,
    authorMemberId: message.authorMemberId,
    type: message.type,
    ...(body === undefined ? {} : { body }),
    state: message.state ?? "sent",
    ...(message.editedAtMs === undefined ? {} : { editedAtMs: message.editedAtMs }),
    ...(message.deletedAtMs === undefined
      ? {}
      : { deletedAtMs: message.deletedAtMs }),
    // 로컬 행이 또 무엇을 인용했는지는 그 행의 `replyToId`가 말해 준다. 대상의
    // 대상까지는 여전히 그리지 않는다 — 표시만이다(규칙 4).
    quotesAnother: message.replyToId !== undefined,
  });
}

/**
 * 이 메시지가 그려야 할 인용 블록, 또는 null.
 *
 * **여기서 네트워크 요청은 일어나지 않는다.** 두 재료만 쓴다: 서버가 페이지에
 * 동봉한 `replyTo`, 그리고 호출자가 이미 들고 있는 같은 채널의 행들. 인용을 풀기
 * 위해 fetch를 한 번이라도 하면 채널 하나 여는 데 N+1이 되고, 서버가 LEFT JOIN으로
 * 이미 갚아 둔 값을 두 번 사는 일이다.
 *
 * `loaded`는 「id로 행을 찾는다」 하나만 요구한다(배열 순회든 Map이든 호출자 사정).
 */
export function resolveQuote(
  message: Pick<Message, "replyToId" | "replyTo">,
  loaded?: (messageId: string) => Message | undefined
): QuoteBlock | null {
  const targetId = message.replyToId;
  if (targetId === undefined) return null;
  if (message.replyTo !== undefined) return quoteBlockFrom(message.replyTo);
  const local = loaded?.(targetId);
  if (local !== undefined) return quoteBlockFromLocal(local);
  return { kind: "unresolved", targetId, targetSeq: null };
}

/**
 * 인용을 걸어 둔 컴포저의 상태. `body`가 아니라 이미 만든 블록을 들고 다니는 이유:
 * 칩이 그리는 것과 본류의 인용 블록이 그리는 것이 같은 규칙에서 나와야, 보내기
 * 전에 본 것과 보낸 뒤에 보이는 것이 어긋나지 않는다.
 */
export interface QuoteDraft {
  targetId: string;
  targetSeq: number | null;
  authorMemberId: string;
  block: QuoteBlock;
}

/**
 * 이 메시지를 인용할 수 있나.
 *
 * 삭제된 메시지는 인용하지 않는다 — 서버는 tombstone을 대상으로 받아 주지만
 * (`validate_quote_target_in_tx`가 행의 존재만 본다), 그렇게 만든 인용은 태어날
 * 때부터 「삭제된 메시지」다. 실패하지 않는다고 해서 제안할 이유는 아니다.
 *
 * `rootId`는 보지 않는다. 규칙 1이 둘을 배타로 두지 않았고, 스레드 안에서 그
 * 스레드의 특정 답글을 인용하는 것이 ADR이 직접 든 예다.
 */
export function canQuoteMessage(message: Message): boolean {
  if (message.state === "deleted") return false;
  return true;
}

/** 행 하나를 컴포저에 걸 인용 초안으로. 걸 수 없으면 null. */
export function quoteDraftFor(message: Message): QuoteDraft | null {
  if (!canQuoteMessage(message)) return null;
  return {
    targetId: message.id,
    targetSeq: message.seq,
    authorMemberId: message.authorMemberId,
    block: quoteBlockFromLocal(message),
  };
}

/**
 * 인용을 건 채로 채널을 옮기거나 원본이 지워졌다. 초안을 버려야 하나.
 *
 * 컴포저는 채널 표면 안에 살지만 인용 대상은 **행**이라, 그 행이 사라지는 길이
 * 두 개 있다: 채널 이동(이 초안은 다른 방의 것이다)과 원본 삭제(규칙 2가 같은
 * 채널을 요구하므로 서버가 받아는 주지만, 보내면 태어날 때부터 tombstone이다).
 */
export function quoteDraftStillValid(
  draft: QuoteDraft,
  lookup: (messageId: string) => Message | undefined
): boolean {
  const current = lookup(draft.targetId);
  // 창 밖으로 스크롤돼 로드에서 빠진 것은 사라진 것이 아니다: 서버는 여전히 그
  // 행을 알고, 인용은 id로 걸린다. 「지워진 것을 봤다」만 무효로 만든다.
  if (current === undefined) return true;
  return canQuoteMessage(current);
}

/** 두 id가 같은 메시지를 가리키나 (와이어 대소문자 접기). */
export function isQuoteTarget(block: QuoteBlock, messageId: string): boolean {
  return uuidEq(block.targetId, messageId);
}
