import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";

// =============================================================================
// The four mandatory surface states (design-taste-web §5), one implementation
// so the sidebar, timeline, inbox and settings all read identically:
//   empty   = one line of copy + one action (an invitation, not a poster)
//   loading = height-preserving neutral bars, never a shimmer
//   error   = what happened + what to do next, inline, never a toast
//   offline = one inline banner, cached content keeps rendering (P15)
// =============================================================================

/** Height-preserving neutral bars. No shimmer: loading is not a light show. */
export function SkeletonRows({
  rows = 4,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 p-2", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-6 rounded-sm bg-surface-hover"
          data-testid="skeleton-row"
        />
      ))}
    </div>
  );
}

/**
 * Inline banner used for both error and offline. Toast stacks are banned; the
 * message lives where the problem is.
 *
 * The bottom border is a SEPARATOR, not a frame: it exists to divide the banner
 * from the content it sits on top of. `separator={false}` is for the one shape
 * where there is nothing to divide from, a banner that is the only child of a
 * box that already draws its own boundary. Drawing it there produced two
 * parallel horizontal rules 16px apart in 설정 > 사용량, the louder of the two
 * landing where no frame boundary is (MOMO-628 R1 M2). Default stays true, so
 * every existing caller renders exactly as before.
 *
 * `items` is the same shape of opt-in, for STRUCTURE. Exactly one caller (the
 * app consent dialog's per-cause failure) ever has more than one thing to say,
 * and that caller alone used to teach this shared banner a text FORMATTING
 * behaviour: `whitespace-pre-line`, so it could join `"• " + sentence` with
 * `\n` (MOMO-642 4, then MOMO-676 M-4). A typed bullet is not a list. It had no
 * `ul`/`li` semantics, `role="alert"` announced the whole join as one sentence,
 * and a soft-wrapped continuation started under the dot instead of under the
 * text it continued. The opt-in is now the list itself: the caller hands over
 * its items and the banner renders real list markup, with the hanging indent
 * that `list-outside` gives for free. `\n` is not a formatting language.
 *
 * `list-disc` rather than a typed bullet also keeps the semantics in Safari,
 * which drops list roles from a `list-style: none` list, and the desktop shell
 * is WKWebView.
 */
export function InlineBanner({
  tone = "error",
  message,
  messageId,
  items,
  icon,
  actionLabel,
  onAction,
  actionBusy = false,
  separator = true,
  heading = false,
  className,
  testId,
}: {
  tone?: "error" | "neutral";
  message: string;
  /**
   * id on the SENTENCE, so a control this banner explains can point at it with
   * `aria-describedby` (#1559: 잠긴 컨트롤은 사유를 든다).
   *
   * On the sentence and not on the box, because a describedby aimed at the
   * wrapper drags the action button's label in with it: a reader asking a greyed
   * control why it is grey would hear the reason and then "다시 시도" as though
   * that were part of the same sentence.
   */
  messageId?: string;
  /** Rendered as a real list under `message`. Omit for a one-sentence banner. */
  items?: readonly string[];
  /**
   * Leading indicator, for a banner that has to be FINDABLE rather than merely
   * present. The neutral tone deliberately looks like chrome, which is right
   * for a banner the reader arrived at and wrong for one that appears while
   * they are looking elsewhere (the shell's connection line, goal B8 B2). Pass
   * a lucide icon carrying a status token; leave it out and nothing changes.
   */
  icon?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  /**
   * The action is running. `aria-busy` and a changed label, never `disabled`
   * and never dimmed: a control that goes grey mid-action reads as "you may not
   * do this" rather than "this is happening" (gate-shell-layout asserts exactly
   * that shape for the consent dialog's confirm).
   */
  actionBusy?: boolean;
  separator?: boolean;
  /**
   * This banner REPLACED the page, so its sentence is the page's heading.
   *
   * Default false, and it has to stay that way: nearly every caller sits under
   * a heading that is still on screen (the route header, the goal a detail page
   * is about), and a second `h1` there would be two documents in one pane. The
   * opt-in is for the branch where the content is gone and the banner is all
   * that is left, which otherwise renders a route with no heading at all
   * (PR 918 R1 Low).
   */
  heading?: boolean;
  /**
   * 이 배너가 **남의 패딩 축 위에** 설 때 그 자를 맞추는 자리. 유일한 현재
   * 소비자는 메뉴 안의 배너다: 메뉴 행은 `px-2` 인데 이 상자의 기본은 `px-4`
   * 라, 배너 첫 글자가 항목 첫 글자보다 8px 오른쪽에 섰다(design-review
   * #1937 N-3 실측 21px 대 13px). 색·역할·기하는 여기 것이고, 바깥 표면이
   * 정하는 것은 그 표면의 자뿐이다.
   */
  className?: string;
  testId?: string;
}) {
  const Message = heading ? "h1" : "span";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={cn(
        // 한국어 산문 표면이므로 음절이 아니라 어절에서 끊는다(MOMO-676 M-5).
        // `break-words`와 **같은 엘리먼트에 둘 수 없다**: tailwind-merge는 둘을
        // 한 `break` 그룹으로 묶어 마지막 하나만 남기므로, 끊기지 않는 긴 토큰을
        // 받아내는 overflow-wrap이 조용히 사라진다. word-break는 상속되니 부모가
        // keep-all을, 자식이 break-words를 갖는다.
        "flex items-start justify-between gap-3 break-keep px-4 py-2 text-body",
        separator && "border-b",
        tone === "error"
          ? "border-danger text-danger"
          : "border-line bg-surface-hover text-ink",
        className
      )}
    >
      {icon && (
        <span aria-hidden="true" className="mt-px shrink-0">
          {icon}
        </span>
      )}
      {/* Wraps, never truncates: this banner also runs in the sidebar column,
          and half an error message is worse than none. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Message id={messageId} className="break-words">
          {message}
        </Message>
        {items && items.length > 0 && (
          <ul className="flex list-outside list-disc flex-col gap-1 ps-4">
            {items.map((item) => (
              <li key={item} className="break-words">{item}</li>
            ))}
          </ul>
        )}
      </div>
      {actionLabel && onAction && (
        // `type="button"` 은 장식이 아니다 (design-review #1930 B-1).
        //
        // 이 배너는 폼 **안**에도 산다(컴포저의 자동완성 사유 상자가 그 자리다).
        // `design/ui/button.tsx` 는 shadcn 원본 그대로 `type` 을 정하지 않으므로
        // DOM 기본값 `submit` 이 되고, 그러면 「다시 시도」 한 번이 그 폼을
        // 제출한다 — 실측에서 사람이 쓰던 초안이 채널로 나가고 입력창이 비워졌다.
        //
        // 프리미티브의 기본값을 바꾸지 않는 이유: 이 레포의 `<Button>` 호출부는
        // 206 곳이고 폼은 스무 남짓인데 그중 몇은 제출 격을 명시하지 않은 채
        // Enter 제출에 기대고 있어, 기본값 전환은 그 전부를 실사해야 하는 별개
        // 작업이다. 반면 **이 자리의 격은 여기서 이미 안다**: 인라인 배너의
        // 액션은 「다시 불러오기」·「닫기」 류이고(레포 전수 확인: 전부 refetch
        // 또는 dismiss) 어떤 폼의 제출도 아니다.
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-busy={actionBusy || undefined}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * Empty state: one line of copy plus at most two actions. Left-aligned and
 * quiet, never a centered illustration poster.
 *
 * 둘일 때 그 둘은 **동급이 아니다** (#1536). 이 상자는 위계를 강제하지 않고
 * (`actions`가 노드를 그대로 받는다) 호출자가 디자인 시스템 §3 채움 순서로 그것을
 * 말한다 — 빈 채널이 `첫 메시지 쓰기`(채움)와 `멤버 추가하기`(윤곽)를 그 순서로
 * 넘긴다. 같은 자리에 같은 옷 두 벌을 세우면 그 화면은 「둘 중 아무거나」라고 말하게
 * 되고, 그것은 첫 행동을 묻는 사람에게 답이 아니다.
 *
 * Same `break-keep` as the banner above, for the same reason and by the same
 * rule: these two are the file's Korean prose surfaces, so the rule applies to
 * both branches of it rather than only to the one a review happened to measure.
 */
export function EmptyInvite({
  headline,
  detail,
  actions,
  heading = false,
  className,
  testId,
  dataAttrs,
}: {
  headline: string;
  detail?: string;
  actions?: React.ReactNode;
  /**
   * 자리 조정용. 이 상자는 기본으로 자기 여백(px-4)을 갖는데, 이미 여백을 가진
   * 상자 안에 들어가면 그만큼 안으로 더 들어가 앉는다. `cn()`이 tailwind-merge를
   * 거치므로 `px-0` 한 마디로 기본값을 덮을 수 있다.
   */
  className?: string;
  /**
   * This state REPLACED the page, so its headline is the page's heading. Same
   * opt-in and same reason as `InlineBanner.heading`: an empty list inside a
   * route that still shows its own `h1` must not add a second one, and a 404
   * that replaced the whole route must not leave the document with none.
   */
  heading?: boolean;
  testId?: string;
  /** Extra data-* hooks, e.g. which variant of an empty state this is. */
  dataAttrs?: Record<string, string>;
}) {
  const Headline = heading ? "h1" : "p";
  return (
    <div
      className={cn(
        "flex break-keep flex-col items-start gap-3 px-4 py-6",
        className
      )}
      data-testid={testId}
      {...dataAttrs}
    >
      <Headline className="text-body font-medium text-ink">
        {headline}
      </Headline>
      {detail && (
        <p className="text-body text-ink-muted">{detail}</p>
      )}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
