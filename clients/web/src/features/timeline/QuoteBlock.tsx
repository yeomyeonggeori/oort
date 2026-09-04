import { X } from "lucide-react";
import {
  QUOTE_CANCEL_LABEL,
  QUOTE_DELETED_TEXT,
  QUOTE_JUMP_HINT,
  QUOTE_NESTED_MARK,
  type QuoteBlock as QuoteBlockModel,
} from "@momo/core/features/timeline/quote";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 인용 블록 (ADR-0148 · goal B3 W1).
//
// **스레드와 눈으로 구분되어야 한다.** ADR-0148이 나눈 두 장치가 화면에서 같은
// 모양이면 결정은 코드에만 남고 사용자에게는 도착하지 않는다. 그래서 세 축을
// 전부 다르게 둔다:
//
//   | | 스레드(`root_id`) | 인용(`reply_to_id`) |
//   |---|---|---|
//   | 자리 | 본문 **아래** 꼬리 줄 | 본문 **위** |
//   | 모양 | 글/버튼 한 줄 「답글 N개」 | 왼쪽 세로 레일(blockquote) |
//   | 어휘 | 답글 | 인용 |
//
// 왼쪽 레일은 웹·메일·마크다운이 200년 넘게 인용에 써 온 그 모양이고
// (`blockquote`), 그래서 설명이 필요 없는 유일한 표시다. 배경 틴트를 쓰지 않는
// 이유는 §9다 — 행 배경 틴트는 이 제품에서 신원(에이전트)에 쓰지 않기로 한
// 장치이고, 인용에 쓰면 그 규칙이 흐려진다.
//
// 본문은 `MessageBody`(마크다운)를 타지 **않는다**. 인용은 원본의 한두 줄을
// 가리키는 표지판이고, 표지판 안에서 코드 블록과 리스트가 펼쳐지면 표지판이
// 본문보다 커진다. 게다가 잘린 마크다운은 문법이 깨진 마크다운이다.
//
// **글리프는 없다.** 1차에서 레일 옆에 lucide `Quote`를 12px로 두었는데, 그
// 크기에서 두 개의 인용 부호는 「99」로 읽혔다(라이트 캡처에서 확인). 레일만으로
// 이미 인용이고 - `blockquote`가 웹에서 그 뜻을 갖는 유일한 모양이며, 이 클라의
// 마크다운 렌더러는 왼쪽 레일을 쓰지 않으므로 겹칠 것도 없다 - 읽히지 않는 장식은
// §8이 금지한 그것이다.
// =============================================================================

/**
 * 인용 안의 본문.
 *
 * 줄들을 한 문단으로 이어 `line-clamp-2`로 잠근다. 코어가 이미 줄 수와 글자 수를
 * 잘라 두었지만 그것은 **문자 예산**이고, 좁은 폭에서 한 줄이 두 줄로 감기는 것은
 * 폭의 문제다. 두 예산을 둘 다 걸어야 390px에서도 블록이 본문보다 커지지 않는다.
 * 말줄임은 우리가 붙인다 — `line-clamp`의 말줄임은 실제로 넘칠 때만 나오고, 코어가
 * 자른 사실은 그것과 별개다.
 */
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

function QuoteAuthor({
  memberId,
  directory,
}: {
  memberId: string | null;
  directory: Directory;
}) {
  const member = memberId === null ? null : memberFor(directory, memberId);
  const name = member?.displayName ?? (memberId === null ? "" : memberId.slice(0, 8));
  if (name === "") return null;
  return (
    <span
      className={cn(
        "font-medium",
        member?.kind === "agent" ? "text-agent" : "text-ink"
      )}
    >
      {member?.kind === "agent" ? `@${member.handle}` : name}
    </span>
  );
}

/** 블록의 내용. 행과 컴포저 칩이 같은 것을 그리도록 한 곳에서 나온다. */
function QuoteContent({
  block,
  directory,
}: {
  block: QuoteBlockModel;
  directory: Directory;
}) {
  return (
    <>
      <span
        className={cn(
          "min-w-0 flex-1",
          // 「무엇을 인용했는지 모른다」가 「안다」와 같은 무게로 그려지면 화면이
          // 고장 난 것으로 읽힌다 (design-review H-1 — 이쪽은 내 코드에서 실재했다:
          // 1차의 unresolved는 ready와 **글자 하나 다르지 않은** 스타일이었다).
          // 두 줄을 쓸 이유도 없으므로 한 줄로 잠그고 글자를 한 단 내린다. 이 팔레트에는
          // 잉크 3단이 없어서(`--ink`/`--ink-muted`가 전부) 위계는 **크기**로 낸다.
          block.kind === "unresolved"
            ? "truncate text-timestamp"
            : "line-clamp-2"
        )}
      >
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
          <>
            <QuoteAuthor
              memberId={block.authorMemberId}
              directory={directory}
            />{" "}
            <QuoteLines lines={block.lines} truncated={block.truncated} />
            {/* 규칙 4 — 두 번째 겹은 표시뿐이다. 펼치면 타임라인이 계단이 된다. */}
            {/* H-3 — 표시는 표시의 무게로. 본문과 같은 크기면 원본 내용의 일부로
                읽히고, 규칙 4가 「표시만」이라고 한 것이 화면에서 무의미해진다.
                중점으로 본문과 분리하고 11px로 한 단 내린다. */}
            {block.quotesAnother && (
              <span className="text-timestamp" data-testid="quote-nested">
                {" · "}
                {QUOTE_NESTED_MARK}
              </span>
            )}
          </>
        )}
      </span>
    </>
  );
}

/**
 * 인용의 모양. **accent가 여기 닿지 않는다** (design-review B-1).
 *
 * 이 화면에서 앰버(`--accent`)는 이미 세 뜻을 갖고 있다: **멘션**(`text-accent`,
 * 나를 불렀다) · **미읽 경계**(`bg-accent` 1px 규칙) · **앵커 착지**
 * (`bg-accent-soft`, 방금 여기로 왔다). 인용은 그 셋과 관계없는 「참조」이므로 같은
 * 색을 쓰면 「저 글을 가리킨다」가 「나를 불렀다」로 읽힌다.
 *
 * **실측(2026-08-05): 정지 상태는 처음부터 중성이었다.** `f9bc5ecd`의 레일은
 * `border-line-strong`(중성 회색)이고 앰버가 아니다 — 값은 `gate-quote`가 매 런마다
 * `[color]`로 찍는다(여기 적으면 팔레트 재조정에 낡는다). 위반은 **hover 하나**였다:
 * `hover:border-accent`가 마우스를 얹은 순간 인용을 멘션의 색으로 바꿨다.
 * 그래서 고친 것도 그 하나다: hover가 중성 위계 안에서만 움직인다
 * (레일 `--line-strong` → `--ink`, 배경은 하우스 hover 패턴 `--surface-hover`).
 *
 * **배경 한 단(`--surface-raised`)은 넣었다가 되돌렸다.** 그것은 「정지 레일이
 * 앰버다」라는 전제 위의 처방이었고 그 전제가 실측에서 거짓이었다. 게다가 이 파일이
 * 지키려는 것과 반대로 작동한다: 코어가 2줄로 자르는 이유가 「인용 블록이 자기를
 * 인용한 메시지보다 높으면 원본을 다시 올린 것으로 읽힌다」인데, 폭을 꽉 채운 고도
 * 있는 띠는 인용의 무게를 **올린다**. 실재하지 않은 결함을 고치는 것도 오염이다.
 *
 * `focus-visible`의 accent 링은 **남는다.** 그것은 색으로 뜻을 말하는 것이 아니라
 * 「포커스가 여기 있다」를 말하는 하우스 패턴이고(SKILL §6), 이 앱의 모든 컨트롤이
 * 같은 링을 쓴다 — 인용만 다른 링을 쓰면 그게 새로운 오독이다.
 */
const RAIL =
  "flex gap-1 border-l-2 border-line-strong pl-2 text-left text-meta text-ink-muted";

/**
 * 본류의 인용 블록. 누르면 원본으로 점프한다.
 *
 * 점프는 **기존 앵커 기계 그대로**다(`features/inbox/anchor.ts`
 * `watchForMessageId`): 가상 목록에서 행을 기다렸다가 가운데로 스크롤하고 잠깐
 * 틴트를 남기는 그 동작이고, 못 찾으면 채널 표면이 이미 가진 그 문장이 이유를
 * 말한다. 인용 대상은 같은 채널 안에 있어야 하므로(규칙 2) 라우트 이동은 없다.
 */
export function QuoteBlock({
  block,
  directory,
  onJump,
}: {
  block: QuoteBlockModel;
  directory: Directory;
  /** 없으면 읽는 글이 된다 (읽기 전용 마운트: 갈 곳 없는 버튼을 만들지 않는다). */
  onJump?: (targetId: string, targetSeq: number | null) => void;
}) {
  const shared = {
    "data-testid": "quote-block",
    "data-kind": block.kind,
    "data-target-id": block.targetId.toLowerCase(),
  };
  if (!onJump) {
    return (
      <div {...shared} className={cn(RAIL, "mb-1")}>
        <QuoteContent block={block} directory={directory} />
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
        RAIL,
        // hover도 중성이다 (B-1). `hover:bg-surface-hover`는 이 앱의 하우스 hover
        // 패턴이고, 레일은 앰버로 가는 대신 잉크 쪽으로 한 단 올라간다.
        "mb-1 w-full rounded-sm press hover:border-ink hover:text-ink focus-visible:focus-ring"
      )}
    >
      <QuoteContent block={block} directory={directory} />
      <span className="sr-only">{QUOTE_JUMP_HINT}</span>
    </button>
  );
}

/**
 * 컴포저 위에 걸린 인용 (ADR-0148 미결 3).
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
}: {
  block: QuoteBlockModel;
  directory: Directory;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex items-start gap-2 border-t border-line px-4 py-2"
      data-testid="composer-quote"
      data-target-id={block.targetId.toLowerCase()}
    >
      <div className={cn(RAIL, "min-w-0 flex-1")}>
        <QuoteContent block={block} directory={directory} />
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
