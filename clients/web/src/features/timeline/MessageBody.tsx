import { Fragment, useMemo } from "react";
import { cn } from "@/design/lib/cn";
import { isDesktop, openExternalUrl } from "@/lib/tauri";
import {
  isPlainText,
  parseMarkdown,
  type Block,
  type Inline,
} from "./markdown";

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

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNode key={index} node={node} />
      ))}
    </>
  );
}

function InlineNode({ node }: { node: Inline }) {
  if (node.kind === "text") return <>{node.text}</>;
  if (node.kind === "strong") {
    return (
      <strong className="font-semibold">
        <InlineNodes nodes={node.children} />
      </strong>
    );
  }
  if (node.kind === "em") {
    return (
      <em className="italic">
        <InlineNodes nodes={node.children} />
      </em>
    );
  }
  if (node.kind === "code") {
    return <code className={cn(CODE_CLASS, "px-1")}>{node.text}</code>;
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
      className="text-accent underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <InlineNodes nodes={node.children} />
    </a>
  );
}

function BlockNode({ block }: { block: Block }) {
  if (block.kind === "code") {
    return (
      // A code block scrolls itself rather than widening the timeline: a 200
      // column log line must not push the channel into a horizontal scroll.
      <pre
        className={cn(CODE_CLASS, "mt-1 overflow-x-auto border border-line p-3")}
        data-testid="message-code-block"
        {...(block.lang ? { "data-lang": block.lang } : {})}
      >
        <code>{block.text}</code>
      </pre>
    );
  }

  if (block.kind === "list") {
    const items = block.items.map((item, index) => (
      <li key={index} className="break-words">
        <InlineNodes nodes={item} />
      </li>
    ));
    // `list-outside` so a wrapped Korean line continues under its own text
    // rather than under the marker, and a real ul/ol because a typed bullet is
    // not a list to anything reading the tree (design-taste-web §6).
    return block.ordered ? (
      <ol
        className={cn(BODY_CLASS, "mt-1 list-outside list-decimal ps-4")}
        data-testid="message-list"
      >
        {items}
      </ol>
    ) : (
      <ul
        className={cn(BODY_CLASS, "mt-1 list-outside list-disc ps-4")}
        data-testid="message-list"
      >
        {items}
      </ul>
    );
  }

  return (
    <p className={BODY_CLASS}>
      {block.lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 && <br />}
          <InlineNodes nodes={line} />
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
 */
export function MessageBody({
  body,
  muted = false,
}: {
  body: string;
  muted?: boolean;
}) {
  const blocks = useMemo(
    () => (isPlainText(body) ? null : parseMarkdown(body)),
    [body]
  );

  if (blocks === null || blocks.length === 0) {
    return (
      <p
        className={cn(
          "whitespace-pre-wrap",
          BODY_CLASS,
          muted && "text-ink-muted"
        )}
      >
        {body}
      </p>
    );
  }

  return (
    <div
      className={cn("flex flex-col gap-2", muted && "text-ink-muted")}
      data-testid="message-markdown"
    >
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} />
      ))}
    </div>
  );
}
