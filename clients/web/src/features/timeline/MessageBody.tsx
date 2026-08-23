import { Fragment, useMemo, useState } from "react";
import { cn } from "@/design/lib/cn";
import { isDesktop, openExternalUrl } from "@/lib/tauri";
import {
  isPlainText,
  parseMarkdown,
  type Block,
  type Inline,
} from "@momo/core/features/timeline/markdown";
import {
  memberFor,
  type Directory,
} from "@momo/core/features/workspace/directory";
import { foldBlocks, foldText, foldWasOpened, rememberFoldOpen } from "./fold";
import { FoldToggle } from "./FoldToggle";

// =============================================================================
// The body of one message (goal B8 H6).
//
// Agents answer in markdown whether or not anyone asked them to, so before this
// the timeline printed "**결론**: 실패" with the asterisks in it, and a fenced
// code block arrived as backticks and un-indented text. That is not a styling
// gap, it is the reader having to parse markup by eye inside a work channel.
//
// SAFETY. Nothing here builds HTML. Every leaf below is a React text node,
// which React escapes, so a body containing `<img onerror=...>` renders those
// characters and nothing else; there is no `dangerouslySetInnerHTML` in this
// client and this file does not add one. The only attacker-controlled value
// that reaches an ATTRIBUTE is a link target, and that value comes from
// `safeHref`, a scheme allowlist (http/https/mailto) over URL's own parse. See
// markdown.ts for why the parser is here instead of a dependency.
//
// The plain path is byte-identical to what shipped before: a message with no
// markup renders the same single `whitespace-pre-wrap` paragraph, so the dense
// timeline does not change shape for the messages that are most of it.
// =============================================================================

const BODY_CLASS = "break-words text-body leading-relaxed";

/**
 * Inline code and code blocks share one look: quoted text, not a card.
 *
 * No color token of its own, deliberately: it INHERITS, so the pending echo's
 * `text-ink-muted` reaches the code in it too. Pinning `text-ink` here made a
 * sending row's prose muted and its code not, which is a row that says two
 * different things about its own state.
 */
const CODE_CLASS = "rounded-sm bg-surface-hover font-mono text-meta";

/**
 * Could this block overflow the narrowest pane a message renders in?
 *
 * The floor, not a measurement: the thread panel at 390px leaves roughly 300px
 * of content, and the 12px mono face runs about 7.2px per column, so ~41
 * columns fit. Twenty-four is comfortably under that, so anything this returns
 * false for cannot scroll anywhere, and everything ambiguous keeps its keyboard
 * path.
 */
function canScroll(text: string): boolean {
  return text.split("\n").some((line) => line.length > 24);
}

interface MentionRendering {
  activeHandles: ReadonlySet<string>;
  selfHandle: string | null;
}

const NO_MENTIONS: MentionRendering = {
  activeHandles: new Set<string>(),
  selfHandle: null,
};

function InlineNodes({
  nodes,
  mentions,
}: {
  nodes: Inline[];
  mentions: MentionRendering;
}) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNode key={index} node={node} mentions={mentions} />
      ))}
    </>
  );
}

function InlineNode({
  node,
  mentions,
}: {
  node: Inline;
  mentions: MentionRendering;
}) {
  if (node.kind === "text") return <>{node.text}</>;
  if (node.kind === "strong") {
    return (
      <strong className="font-semibold">
        <InlineNodes nodes={node.children} mentions={mentions} />
      </strong>
    );
  }
  if (node.kind === "em") {
    // `em-latin-only`, not `italic`: see tokens.css. A synthesized oblique on
    // Korean draws a stroke the author never typed.
    return (
      <em className="em-latin-only">
        <InlineNodes nodes={node.children} mentions={mentions} />
      </em>
    );
  }
  if (node.kind === "code") {
    return <code className={cn(CODE_CLASS, "px-1")}>{node.text}</code>;
  }
  if (node.kind === "mention") {
    if (!mentions.activeHandles.has(node.handle)) return <>{node.raw}</>;
    const self = mentions.selfHandle === node.handle;
    return (
      <span
        className={cn(
          "text-accent",
          self && "bg-accent-soft font-semibold"
        )}
        data-mention-handle={node.handle}
        data-testid={self ? "message-self-mention" : "message-mention"}
      >
        {node.raw}
      </span>
    );
  }
  return (
    <a
      href={node.href}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="message-link"
      onClick={(event) => {
        // wry leaves WKWebView's new-window request unimplemented, so in the
        // desktop shell `target="_blank"` is a dead control. Same handoff the
        // artifact card makes (ArtifactCard.OpenLinkRow): the OS opens OS
        // things. In a browser tab this branch never runs.
        if (!isDesktop()) return;
        event.preventDefault();
        void openExternalUrl(node.href);
      }}
      className="text-accent underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring"
    >
      <InlineNodes nodes={node.children} mentions={mentions} />
    </a>
  );
}

function BlockNode({
  block,
  mentions,
}: {
  block: Block;
  mentions: MentionRendering;
}) {
  if (block.kind === "code") {
    const scrollable = canScroll(block.text);
    return (
      // A code block scrolls itself rather than widening the timeline: a 200
      // column log line must not push the channel into a horizontal scroll.
      <pre
        // Focusable ONLY when it can actually scroll. An `overflow-x-auto`
        // element outside the tab order cannot be scrolled by keyboard at all,
        // so everything past its width is unreachable without a mouse (WCAG
        // 2.1.1) — but a two word ```sh``` block scrolls nothing, and a tab stop
        // per code block in a dense agent channel is a real cost. `canScroll` is
        // a floor, not a measurement, so it errs toward giving the stop.
        //
        // A focusable region also has to say what it is, or the reader lands on
        // a stop that announces nothing. `group` rather than `region`, because
        // twenty landmarks in one channel is its own kind of noise.
        {...(scrollable
          ? {
              tabIndex: 0,
              role: "group",
              "aria-label": block.lang ? `${block.lang} 코드` : "코드",
            }
          : {})}
        className={cn(
          CODE_CLASS,
          "overflow-x-auto border border-line p-3",
          "focus-visible:focus-ring"
        )}
        data-testid="message-code-block"
        // 가로로 끌리는 것이 이 상자의 일이다 (goal B11). 폰 캡처의 가로 오버플로
        // 단언은 "세로로만 스크롤할 표면"을 재는데, 코드 블록은 그 부류가 아니다 —
        // 넓은 코드는 자기 상자 안에서 스크롤해야 하고, 접으면 정렬이 깨진다.
        // 면제를 게이트가 아니라 여기서 선언하는 이유는 그래야 리뷰에서 보이기
        // 때문이다(capture-screens.mjs `assertNoHorizontalOverflow` 주석).
        data-scroll-x="code"
        {...(block.lang ? { "data-lang": block.lang } : {})}
      >
        <code>{block.text}</code>
      </pre>
    );
  }

  if (block.kind === "list") {
    const items = block.items.map((item, index) => (
      <li key={index} className="break-words">
        <InlineNodes nodes={item} mentions={mentions} />
      </li>
    ));
    // `list-outside` so a wrapped Korean line continues under its own text
    // rather than under the marker, and a real ul/ol because a typed bullet is
    // not a list to anything reading the tree (design-taste-web §6).
    return block.ordered ? (
      // `start` is the author's own number. Without it an agent quoting steps 3
      // and 4 of a runbook rendered as steps 1 and 2, which is the timeline
      // saying something nobody wrote.
      <ol
        start={block.start}
        className={cn(BODY_CLASS, "list-outside list-decimal ps-4")}
        data-testid="message-list"
      >
        {items}
      </ol>
    ) : (
      <ul
        className={cn(BODY_CLASS, "list-outside list-disc ps-4")}
        data-testid="message-list"
      >
        {items}
      </ul>
    );
  }

  return (
    // `whitespace-pre-wrap` and a real newline rather than `<br/>`: the plain
    // path preserves runs of spaces (an aligned list typed by hand, an indented
    // second line) and this one collapsed them, so the same body rendered two
    // ways depending on whether it happened to contain a markdown character.
    <p className={cn("whitespace-pre-wrap", BODY_CLASS)}>
      {block.lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 && "\n"}
          <InlineNodes nodes={line} mentions={mentions} />
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Render a message body, with markdown when it carries any.
 *
 * `muted` is the pending echo's one difference: the same anatomy in
 * `text-ink-muted`, so a row does not change shape when the server echo
 * replaces it (PendingRow's whole reason for borrowing this grid).
 *
 * 긴 답변은 접힌 채로 온다 (U4-e · 진단 H-8). 예산과 그 숫자의 근거는 `fold.ts`에
 * 있고, 여기서 하는 일은 그 판정을 그리는 것뿐이다. **예산에 걸리지 않는 본문은
 * 이 파일이 원래 그리던 것과 정확히 같은 마크업으로 나간다** — 채널의 대부분인
 * 짧은 메시지는 이 goal 이후에도 한 픽셀도 달라지지 않아야 한다.
 */
export function MessageBody({
  body,
  muted = false,
  foldKey,
  directory,
  selfMemberId,
}: {
  body: string;
  muted?: boolean;
  /** Active roster members are the authority for whether a token is a mention. */
  directory?: Directory;
  /** Current member, used only for the stronger self-mention treatment. */
  selfMemberId?: string;
  /**
   * 펼쳐 둔 상태를 기억하는 키(메시지 id). 없으면 이 본문은 언제나 접힌 채로
   * 시작한다 — 낙관적 에코처럼 곧 다른 행으로 교체될 행이 그렇다.
   */
  foldKey?: string;
}) {
  const blocks = useMemo(
    () => (isPlainText(body) ? null : parseMarkdown(body)),
    [body]
  );
  const mentions = useMemo<MentionRendering>(() => {
    // Keep the pre-markdown path cheap: ordinary prose neither walks the
    // directory nor changes its rendered shape just because this prop exists.
    if (blocks === null || directory === undefined) return NO_MENTIONS;
    const activeHandles = new Set(
      directory.members
        .filter((member) => member.status === "active")
        .map((member) => member.handle.toLowerCase())
    );
    const self = memberFor(directory, selfMemberId);
    return {
      activeHandles,
      selfHandle: self?.handle.toLowerCase() ?? null,
    };
  }, [blocks, directory, selfMemberId]);
  const [expanded, setExpanded] = useState(() => foldWasOpened(foldKey));
  const toggle = () =>
    setExpanded((open) => {
      rememberFoldOpen(foldKey, !open);
      return !open;
    });
  // 파싱과 같은 이유로 메모한다: 가상 리스트는 스크롤마다 이 행을 다시 그리고,
  // 500줄 펜스를 줄 단위로 세는 일을 그때마다 되풀이할 이유가 없다.
  const fold = useMemo(() => {
    if (blocks === null || blocks.length === 0) {
      return { kind: "plain" as const, ...foldText(body) };
    }
    return { kind: "blocks" as const, ...foldBlocks(blocks) };
  }, [blocks, body]);

  if (fold.kind === "plain") {
    const paragraph = (
      <p
        className={cn(
          "whitespace-pre-wrap",
          BODY_CLASS,
          muted && "text-ink-muted"
        )}
      >
        {expanded ? body : fold.text}
      </p>
    );
    if (fold.hiddenLines === 0) return paragraph;
    return (
      <div className={cn("flex flex-col gap-1", muted && "text-ink-muted")}>
        {paragraph}
        <FoldToggle
          hiddenLines={fold.hiddenLines}
          expanded={expanded}
          onToggle={toggle}
        />
      </div>
    );
  }

  const shown = expanded && blocks !== null ? blocks : fold.blocks;
  return (
    <div
      className={cn("flex flex-col gap-2", muted && "text-ink-muted")}
      data-testid="message-markdown"
    >
      {shown.map((block, index) => (
        <BlockNode key={index} block={block} mentions={mentions} />
      ))}
      {fold.hiddenLines > 0 && (
        <FoldToggle
          hiddenLines={fold.hiddenLines}
          expanded={expanded}
          onToggle={toggle}
        />
      )}
    </div>
  );
}
