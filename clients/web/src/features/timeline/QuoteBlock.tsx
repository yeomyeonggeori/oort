import { missingMemberLabel } from "@momo/core/features/workspace/directory";
import { CornerUpLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  QUOTE_CANCEL_LABEL,
  QUOTE_DELETED_TEXT,
  QUOTE_JUMP_HINT,
  QUOTE_NESTED_MARK,
  quoteHeadAuthorId,
  type QuoteBlock as QuoteBlockModel,
} from "@momo/core/features/timeline/quote";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 인용 = 답장 카드의 **윗칸 머리** (ADR-0148 · goal B3 W1 → #5381 Q4, owner 2026-11-05).
//
// 답장 메시지는 한 덩어리 카드다. 윗칸이 머리이고, 가는 구분선 아래가 답 본문이다:
//
//   ┌──────────────────────────────────────────┐
//   │ ↩ 하늘에게 답장                           │  머리: 아이콘 + 이름 문장
//   │ 배포 되돌리기 절차 정리해 줄래요? 릴리스…  │        원문 **1줄**(말줄임)
//   ├──────────────────────────────────────────┤  가는 구분선
//   │ 세 단계예요. 릴리스 태그를 확인하고…        │  본문 (`MessageBody`)
//   └──────────────────────────────────────────┘
//
// **스레드와 눈으로 구분되어야 한다.** ADR-0148이 나눈 두 장치가 화면에서 같은
// 모양이면 결정은 코드에만 남고 사용자에게는 도착하지 않는다. 세 축을 다르게 둔다:
//
//   | | 스레드(`root_id`) | 인용(`reply_to_id`) |
//   |---|---|---|
//   | 자리 | 본문 **아래** 꼬리 줄 | 본문을 **싸는 카드의 윗칸** |
//   | 모양 | 글/버튼 한 줄 「답글 N개」 | 답장 아이콘 + 「○○에게 답장」 머리 |
//   | 어휘 | 답글 | 답장(인용) |
//
// **세로선·막대는 어디에도 없다** (owner 의견: 왼쪽 둥근 세로 테두리는 흔한 AI 모양으로
// 읽힌다). 1차(ADR-0148)가 쓰던 왼쪽 레일(`blockquote`)과 그 레일 색을 지키던 모든
// 단정은 이 결정으로 사라졌다. 머리가 맡는 일은 그 레일이 맡던 「저 글을 가리킨다」인데,
// 이제는 아이콘과 「에게 답장」 문장이 낱말로 말한다 — 색이나 선에 기대지 않는다.
//
// 본문은 `MessageBody`(마크다운)를 타지 **않는다** (머리 안의 원문). 인용은 원본의 한 줄을
// 가리키는 표지판이고, 표지판 안에서 코드 블록과 리스트가 펼쳐지면 표지판이 본문보다
// 커진다. 게다가 잘린 마크다운은 문법이 깨진 마크다운이다.
//
// **아이콘은 lucide `CornerUpLeft`다.** 1차에서 레일 옆에 `Quote`(인용 부호)를 12px로 두었는데,
// 그 크기에서 두 개의 인용 부호는 「99」로 읽혔다(라이트 캡처에서 확인). 이번 아이콘은 부호가
// 아니라 **되돌아가는 화살표**라서 그 오독이 없고, 스레드 행 도구 막대의 「답글」(`MessageSquareReply`,
// 말풍선)과도 다른 도형이다.
// =============================================================================

/** 머리 안의 원문 한 줄 (코어가 이미 한 줄·글자 수로 잘라 준다). */
function QuoteLines({
  lines,
  truncated,
}: {
  lines: string[];
  truncated: boolean;
}) {
  if (lines.length === 0) {
    // 본문이 공백뿐인 메시지도 인용될 수 있다. 빈 자리를 남기는 대신 무엇을
    // 가리키는지 말한다.
    return <span>내용 없는 메시지</span>;
  }
  return (
    <span>
      {lines.join(" ")}
      {truncated ? "…" : ""}
    </span>
  );
}

/**
 * 머리 첫 줄의 문장 「{이름}에게 답장」 (사전 `timeline.quote.head`).
 *
 * 이름이 없으면(못 푼 인용·저자를 잃은 지워진 원본) 이름을 지어내지 않고 이름 없는 문장으로
 * 말한다. 이름을 부를지는 코어가 정한다(`quoteHeadAuthorId` — 폰과 같은 판정). 에이전트의 이름은
 * 행 머리줄과 같이 `@핸들`이다. 색은 따로 주지 않는다: 에이전트 신원 색은 아바타·행 이름에만
 * 쓴다(SKILL §9) — 머리는 「누구에게」가 아니라 「이 말에 답한다」를 말하는 자리다.
 */
function useQuoteHeadLabel(
  block: QuoteBlockModel,
  directory: Directory
): string {
  const formatMessage = useFormatMessage();
  const authorId = quoteHeadAuthorId(block);
  if (authorId === null) return formatMessage("timeline.quote.headUnnamed");
  const member = memberFor(directory, authorId);
  const name =
    member === null
      ? missingMemberLabel(directory)
      : member.kind === "agent"
        ? `@${member.handle}`
        : member.displayName.trim() === ""
          ? missingMemberLabel(directory)
          : member.displayName;
  return formatMessage("timeline.quote.head", { name });
}

/** 머리의 내용. 행의 머리와 컴포저 칩이 같은 문법을 그리도록 한 곳에서 나온다. */
function QuoteHeadContent({
  block,
  directory,
}: {
  block: QuoteBlockModel;
  directory: Directory;
}) {
  const label = useQuoteHeadLabel(block, directory);
  return (
    <>
      <span className="flex min-w-0 items-center gap-1 font-semibold">
        <CornerUpLeft className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate" data-testid="quote-head-label">
          {label}
        </span>
      </span>
      {/* 원문 줄. 한 줄로 잠근다 — 코어가 줄 수와 글자 수를 잘라 두었지만 그것은 **문자 예산**이고,
          좁은 폭에서 한 줄이 두 줄로 감기는 것은 폭의 문제라서 말줄임은 화면(`truncate`)이 맡는다.
          「무엇을 인용했는지 모른다」가 「안다」와 같은 무게로 그려지면 화면이 고장 난 것으로
          읽힌다(design-review H-1) — 이 팔레트에는 잉크 3단이 없어서(`--ink`/`--ink-muted`가
          전부) 위계는 **크기**로 낸다: 못 푼 인용의 문장만 한 단 작다. */}
      <span
        className={cn(
          "flex min-w-0 items-baseline gap-1",
          block.kind === "unresolved" && "text-timestamp"
        )}
      >
        <span className="min-w-0 truncate">
          {block.kind === "deleted" ? (
            // 삭제된 원본을 정직하게 말한다 (규칙 3). 사본을 남기지 않는 것이
            // 삭제의 뜻이므로, 여기에 있던 글자는 여기에 없다.
            <span data-testid="quote-deleted">{QUOTE_DELETED_TEXT}</span>
          ) : block.kind === "unresolved" ? (
            // 「인용했다」는 참이고 「무엇을」은 모른다. 실시간 프레임에는 원문이
            // 실리지 않고(ADR-0148 규칙 3), 원본이 아직 안 불러온 위쪽에 있는 경우다.
            <span data-testid="quote-unresolved">
              인용한 메시지가 이 화면에 없습니다
            </span>
          ) : (
            <QuoteLines lines={block.lines} truncated={block.truncated} />
          )}
        </span>
        {/* 규칙 4 — 두 번째 겹은 표시뿐이다. 펼치면 타임라인이 계단이 된다.
            H-3 — 표시는 표시의 무게로: 본문과 같은 크기면 원본 내용의 일부로 읽히고, 규칙 4가
            「표시만」이라고 한 것이 화면에서 무의미해진다. 11px로 한 단 내리고, 말줄임이 이
            표시를 먹지 않게 `shrink-0`으로 원문 줄 오른쪽에 따로 둔다. */}
        {block.kind === "ready" && block.quotesAnother && (
          <span className="shrink-0 text-timestamp" data-testid="quote-nested">
            {"· "}
            {QUOTE_NESTED_MARK}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * 머리의 모양. **accent가 여기 닿지 않는다** (design-review B-1).
 *
 * 이 화면에서 앰버(`--accent`)는 이미 세 뜻을 갖고 있다: **멘션**(`text-signal-text`,
 * 나를 불렀다) · **미읽 경계**(`bg-accent` 1px 규칙) · **앵커 착지**
 * (`bg-accent-soft`, 방금 여기로 왔다). 인용은 그 셋과 관계없는 「참조」이므로 같은
 * 색을 쓰면 「저 글을 가리킨다」가 「나를 불렀다」로 읽힌다. 그래서 머리는 중성 잉크
 * (`--ink-muted`)이고 hover가 중성 위계 안에서만 움직인다(글자 `--ink-muted` → `--ink`,
 * 배경은 하우스 hover 패턴 `--surface-hover`).
 *
 * **B-1이 바뀌었다 — 채움을 쓴다** (owner 2026-11-05, #5381 Q4). 1차는 「인용에 배경 한
 * 단(`--surface-raised`)을 넣었다가 되돌렸다」: 그 처방은 「정지 레일이 앰버다」라는 전제
 * 위에 있었는데 실측에서 그 전제가 거짓이었고, 폭을 꽉 채운 고도 있는 띠는 인용의 무게를
 * **올린다**고 적었다. 이번 결정이 그 되돌림을 다시 열었고 두 점이 다르다:
 *
 *   1. 채움은 **인용 띠가 아니라 답장 한 덩어리**(머리 + 본문)를 싼다. 머리만 도드라지지
 *      않으므로 인용의 무게가 본문 위로 올라가지 않는다 — 카드 전체가 한 무게다.
 *   2. 채움은 보조 채움 토큰(`--surface-muted`)이고 **고도가 없다**(그림자·테두리 없음).
 *      머리와 본문의 경계는 가는 구분선(`--line`) 하나다.
 *
 * 머리 자체에는 별도 채움을 주지 않는다: `--surface-hover`/`--surface-pressed`는 눌림·hover
 * 상태 토큰이라 가만히 선 면에 빌려 쓰지 않는다(tokens.md 「상태 토큰을 그릇으로 빌려 쓰지
 * 않는다」, #1515).
 *
 * `focus-visible`의 accent 링은 **남는다.** 그것은 색으로 뜻을 말하는 것이 아니라
 * 「포커스가 여기 있다」를 말하는 하우스 패턴이고(SKILL §6), 이 앱의 모든 컨트롤이
 * 같은 링을 쓴다 — 인용만 다른 링을 쓰면 그게 새로운 오독이다.
 */
const HEAD =
  "flex w-full min-w-0 flex-col px-3 py-2 text-left text-meta text-ink-muted";

/**
 * 답장 카드의 머리. 누르면 원본으로 점프한다.
 *
 * 점프는 **기존 앵커 기계 그대로**다(`features/inbox/anchor.ts`
 * `watchForMessageId`): 가상 목록에서 행을 기다렸다가 가운데로 스크롤하고 잠깐
 * 틴트를 남기는 그 동작이고, 못 찾으면 채널 표면이 이미 가진 그 문장이 이유를
 * 말한다. 인용 대상은 같은 채널 안에 있어야 하므로(규칙 2) 라우트 이동은 없다.
 *
 * `divider`는 이 머리 **아래에 본문이 선다**는 뜻이다: 그때만 가는 구분선을 긋는다(본문 없는
 * 카드 — 첨부만 보낸 답장 — 는 머리가 카드 전부라 선이 갈 곳이 없다).
 */
export function QuoteBlock({
  block,
  directory,
  onJump,
  divider = false,
}: {
  block: QuoteBlockModel;
  directory: Directory;
  /** 없으면 읽는 글이 된다 (읽기 전용 마운트: 갈 곳 없는 버튼을 만들지 않는다). */
  onJump?: (targetId: string, targetSeq: number | null) => void;
  divider?: boolean;
}) {
  const shared = {
    "data-testid": "quote-block",
    "data-kind": block.kind,
    "data-target-id": block.targetId.toLowerCase(),
  };
  const lineClass = divider ? "border-b border-line" : undefined;
  if (!onJump) {
    return (
      <div {...shared} className={cn(HEAD, lineClass)}>
        <QuoteHeadContent block={block} directory={directory} />
      </div>
    );
  }
  return (
    <button
      type="button"
      {...shared}
      // 행의 로빙 포커스 그룹에 속한다 (rowFocus.ts): 인용 하나가 타임라인의
      // 탭 스톱을 하나 더 늘리면 컴포저까지 가는 키보드 경로가 메시지 수만큼
      // 길어진다.
      data-row-action=""
      title={QUOTE_JUMP_HINT}
      onClick={() => onJump(block.targetId, block.targetSeq)}
      className={cn(
        HEAD,
        lineClass,
        // hover도 중성이다 (B-1). `hover:bg-surface-hover`는 이 앱의 하우스 hover
        // 패턴이고, 글자는 잉크 쪽으로 한 단 올라간다.
        "hover:bg-surface-hover hover:text-ink active:bg-surface-pressed focus-visible:focus-ring"
      )}
    >
      <QuoteHeadContent block={block} directory={directory} />
      <span className="sr-only">{QUOTE_JUMP_HINT}</span>
    </button>
  );
}

/**
 * 답장 한 덩어리 카드: 머리(인용) + 가는 구분선 + 본문 (#5381, Q4).
 *
 * 웹·데스크탑에서는 **메시지 본문 자리가 카드**다. 채움은 보조 채움 토큰(`--surface-muted`)이고, 줄이 가리킴·키보드 초점으로 물드는 동안에는
 * 한 단 더 짙은 `--muted-soft`다(`quote-card` 유틸, #5421 — 줄 호버 면 위에서 카드 그릇이 녹지 않게),
 * 반경은 디자인 시스템 사다리의 `rounded-lg`(14)다 — 시안의 12px은 사다리 밖이라 가까운 단을 쓴다.
 * 카드의 폭은 내용 폭까지이고 `max-w-pane-lg`(640, 「카드는 배너가 아니다」 — 에이전트 카드와 같은
 * 자)를 넘지 않는다. 바깥 `flex`는 그 상한이 좁은 열(스레드 패널)에서 열 폭으로 줄어들게 하는
 * 자리다(`min-w-0` 자식은 flex 항목이라 줄어든다).
 *
 * `children`(본문)이 없으면 머리만 선 카드다(첨부만 보낸 답장·편집 중인 행의 머리). 있으면 머리
 * 아래 구분선과 본문 칸이 선다. 본문 칸의 안쪽 여백이 본문이 카드 가장자리에 붙지 않게 한다.
 */
export function QuoteCard({
  block,
  directory,
  onJump,
  children,
}: {
  block: QuoteBlockModel;
  directory: Directory;
  onJump?: (targetId: string, targetSeq: number | null) => void;
  children?: ReactNode;
}) {
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <div className="mt-1 flex" data-testid="quote-card" data-has-body={hasBody ? "true" : "false"}>
      <div className="min-w-0 max-w-pane-lg overflow-hidden rounded-lg quote-card">
        <QuoteBlock
          block={block}
          directory={directory}
          divider={hasBody}
          {...(onJump ? { onJump } : {})}
        />
        {hasBody && <div className="px-3 py-2">{children}</div>}
      </div>
    </div>
  );
}

/**
 * 본문을 카드가 **싸야 할 때만** 싼다. `quote`가 `null`이면 자식을 그대로 둔다 — 행의 본문 가지
 * (묘비·편집기·마크다운)를 복제하지 않고 한 자리에서 카드 안팎을 고르게 하는 얇은 자리다.
 */
export function QuoteCardAround({
  quote,
  directory,
  onJump,
  children,
}: {
  quote: QuoteBlockModel | null;
  directory: Directory;
  onJump?: (targetId: string, targetSeq: number | null) => void;
  children?: ReactNode;
}) {
  if (quote === null) return <>{children}</>;
  return (
    <QuoteCard
      block={quote}
      directory={directory}
      {...(onJump ? { onJump } : {})}
    >
      {children}
    </QuoteCard>
  );
}

/**
 * 컴포저 위에 걸린 인용 (ADR-0148 미결 3) — 행의 머리와 **같은 문법**이다 (#5381):
 * 아이콘 + 「{이름}에게 답장」 + 원문 1줄 + 닫기. 세로선은 없다.
 *
 * 취소가 **컨트롤로** 있어야 한다: 성재가 지적한 계열이 "들어가는 길만 있고
 * 나오는 길이 없는" 것이고, 인용은 실수로 걸기 쉬운 액션이다(행 메뉴 한 번).
 * Esc도 같은 일을 하지만 Esc는 키보드에만 있고, 이 자리에서 손가락에게도 같은
 * 길이 있어야 한다.
 */
export function QuoteChip({
  block,
  directory,
  onCancel,
  attached = false,
}: {
  block: QuoteBlockModel;
  directory: Directory;
  onCancel: () => void;
  /** 입력창 카드의 맥락 띠 안에 선다(#4317): 띠가 구분선을 지므로 자기 윗선은 없다. */
  attached?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 px-4 py-2",
        attached ? "items-center" : "items-start border-t border-line"
      )}
      data-testid="composer-quote"
      data-target-id={block.targetId.toLowerCase()}
    >
      <div className="flex min-w-0 flex-1 flex-col text-left text-meta text-ink-muted">
        <QuoteHeadContent block={block} directory={directory} />
      </div>
      <button
        type="button"
        onClick={onCancel}
        aria-label={QUOTE_CANCEL_LABEL}
        title={QUOTE_CANCEL_LABEL}
        data-testid="composer-quote-cancel"
        className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
