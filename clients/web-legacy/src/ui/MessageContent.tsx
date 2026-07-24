import { Fragment } from "react";

const CODE_FENCE = /```(?:[^\n]*)\n?([\s\S]*?)```/g;
const WEB_URL = /https?:\/\/[^\s<]+/g;

function textWithLinks(text: string) {
  const parts: Array<{ kind: "text" | "link"; value: string }> = [];
  let cursor = 0;
  for (const match of text.matchAll(WEB_URL)) {
    const index = match.index;
    const value = match[0];
    if (index > cursor) parts.push({ kind: "text", value: text.slice(cursor, index) });
    parts.push({ kind: "link", value });
    cursor = index + value.length;
  }
  if (cursor < text.length) parts.push({ kind: "text", value: text.slice(cursor) });
  return parts.map((part, index) =>
    part.kind === "link" ? (
      <a key={`${index}-${part.value}`} href={part.value} target="_blank" rel="noreferrer">
        {part.value}
      </a>
    ) : (
      <Fragment key={`${index}-${part.value}`}>{part.value}</Fragment>
    )
  );
}

export default function MessageContent({ body }: { body: string }) {
  const blocks: Array<{ kind: "text" | "code"; value: string }> = [];
  let cursor = 0;
  for (const match of body.matchAll(CODE_FENCE)) {
    const index = match.index;
    if (index > cursor) blocks.push({ kind: "text", value: body.slice(cursor, index) });
    blocks.push({ kind: "code", value: match[1] ?? "" });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) blocks.push({ kind: "text", value: body.slice(cursor) });
  return (
    <div className="message-body">
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <pre key={`${index}-${block.value}`}><code>{block.value}</code></pre>
        ) : (
          <span key={`${index}-${block.value}`} className="message-text">{textWithLinks(block.value)}</span>
        )
      )}
    </div>
  );
}
