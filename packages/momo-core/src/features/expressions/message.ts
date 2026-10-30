import type { Expression, ExpressionMessageInput, ExpressionResult } from "./types";

export const EXPRESSION_NAME_PATTERN = /^[a-z0-9_-]{2,30}$/;
export function isExpressionName(name: string): boolean {
  return EXPRESSION_NAME_PATTERN.test(name);
}

export function expressionToken(name: string): string {
  if (!isExpressionName(name)) throw new Error("Invalid expression name");
  return `:${name}:`;
}

export type ExpressionToken =
  | { type: "text"; text: string }
  | { type: "expression"; text: string; expression: Expression };

/**
 * Lightweight scanning before a host's Markdown renderer. Code, escapes, URLs,
 * autolinks, and link destinations remain literal. Unknown/deleted names do too.
 * Offsets/whitespace are preserved; this never rewrites the persisted body.
 */
export function tokenizeExpressions(body: string, expressions: readonly Expression[]): ExpressionToken[] {
  const byName = new Map(expressions.filter((item) => item.status === "active").map((item) => [item.name, item]));
  const result: ExpressionToken[] = [];
  let textStart = 0;
  let cursor = 0;
  let lineStart = 0;
  let fence: { char: string; length: number } | null = null;
  const flush = (end: number) => {
    if (end > textStart) result.push({ type: "text", text: body.slice(textStart, end) });
  };
  while (cursor < body.length) {
    if (cursor === lineStart) {
      const lineEnd = body.indexOf("\n", cursor);
      const end = lineEnd < 0 ? body.length : lineEnd + 1;
      const line = body.slice(cursor, end);
      // Fences can be nested in Markdown quote/list containers. Their markers
      // are syntax, rather than text to render or part of a fence delimiter.
      let content = line;
      let container: RegExpExecArray | null;
      while ((container = /^ {0,3}(?:>[ \t]?|(?:[-+*]|[0-9]{1,9}[.)])[ \t]+)/.exec(content))) {
        content = content.slice(container[0].length);
      }
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(content);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(content.slice(marker[0].length))) fence = null;
        cursor = end; lineStart = end; continue;
      }
      if (marker) {
        fence = { char: marker[1][0], length: marker[1].length };
        cursor = end; lineStart = end; continue;
      }
      // Markdown indented code.
      if (/^( {4}|\t)/.test(content)) { cursor = end; lineStart = end; continue; }
    }
    const char = body[cursor];
    if (char === "\n") { cursor += 1; lineStart = cursor; continue; }
    if (char === "\\") { cursor += Math.min(2, body.length - cursor); continue; }
    if (char === "`") {
      const run = /^`+/.exec(body.slice(cursor))![0];
      let close = body.indexOf(run, cursor + run.length);
      while (close >= 0 && (body[close - 1] === "`" || body[close + run.length] === "`")) close = body.indexOf(run, close + run.length);
      if (close >= 0) {
        const end = close + run.length;
        const lastNewline = body.lastIndexOf("\n", end - 1);
        if (lastNewline >= cursor) lineStart = lastNewline + 1;
        cursor = end; continue;
      }
      cursor += run.length; continue;
    }
    if (body.startsWith("http://", cursor) || body.startsWith("https://", cursor) || char === "<") {
      const opaque = char === "<" ? /^<[^>\n]*>/.exec(body.slice(cursor)) : /^https?:\/\/[^\s<>]+/.exec(body.slice(cursor));
      if (opaque) { cursor += opaque[0].length; continue; }
    }
    if (body.startsWith("](", cursor)) {
      let end = cursor + 2;
      let depth = 1;
      while (end < body.length && depth > 0) {
        if (body[end] === "\\") { end += 2; continue; }
        if (body[end] === "(") depth += 1;
        if (body[end] === ")") depth -= 1;
        end += 1;
      }
      if (depth === 0) { cursor = end; continue; }
    }
    if (char === ":") {
      const match = /^:([a-z0-9_-]{2,30}):/.exec(body.slice(cursor));
      const item = match && byName.get(match[1]);
      if (match && item) {
        flush(cursor);
        result.push({ type: "expression", text: match[0], expression: item });
        cursor += match[0].length;
        textStart = cursor;
        continue;
      }
    }
    cursor += 1;
  }
  flush(body.length);
  return result;
}

export type ExpressionSize = "large" | "medium" | "inline";
export function expressionMessageSize(tokens: readonly ExpressionToken[]): ExpressionSize {
  if (tokens.some((token) => token.type === "text" && token.text.trim() !== "")) return "inline";
  const count = tokens.filter((token) => token.type === "expression").length;
  return count === 1 ? "large" : count >= 2 && count <= 6 ? "medium" : "inline";
}

export function buildExpressionMessage(expression: Expression): ExpressionMessageInput {
  if (expression.status !== "active") throw new Error("Expression is unavailable");
  return { body: expressionToken(expression.name) };
}

/** Persistent body, notification, search, quote, and old-client fallback agree. */
export function expressionFallbackBody(body: string): string {
  return body;
}

export function expressionMessageModel(body: string, expressions: readonly Expression[]) {
  const tokens = tokenizeExpressions(body, expressions);
  return { body, fallbackBody: expressionFallbackBody(body), tokens, size: expressionMessageSize(tokens) };
}

export function tokenizeExpressionReaction(value: string, expressions: readonly Expression[]): ExpressionToken {
  const match = /^:([a-z0-9_-]{2,30}):$/.exec(value);
  const item = match && expressions.find((expression) => expression.name === match[1] && expression.status === "active");
  return item ? { type: "expression", text: value, expression: item } : { type: "text", text: value };
}

export function expressionAltText(expression: Expression): string {
  return expression.tags[0] ? `${expression.displayName} · ${expression.tags[0]}` : expression.displayName;
}

/** Result-card send controls re-resolve against the live catalogue. */
export function expressionResultMessage(result: ExpressionResult, expressions: readonly Expression[]): ExpressionMessageInput | null {
  const item = expressions.find((entry) => entry.id === result.id && entry.name === result.name && entry.status === "active");
  if (!item || result.token !== expressionToken(item.name)) return null;
  return buildExpressionMessage(item);
}
