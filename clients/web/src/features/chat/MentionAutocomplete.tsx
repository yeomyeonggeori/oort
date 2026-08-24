/* eslint-disable react-refresh/only-export-components -- 이 파일은 컴포넌트와 그 컴포넌트만 쓰는 공용 훅·순수 멘션 모델을 한 경계로 내보낸다. */
import { useCallback, useMemo, useState, type RefObject } from "react";
import type { RosterMember } from "@momo/core/lib/api";
import type { ComposerKeyIntent } from "@momo/core/features/chat/composerKeys";
import { cn } from "@/design/lib/cn";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { insertMentionTriggerAtComposerSelection } from "./composerInsertion";

const MENTION_LIMIT = 6;

export interface MentionQuery {
  /** Index of the '@' that opened the query. */
  start: number;
  text: string;
}

/** The active @mention token at the caret, or null when there is none. */
export function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const text = upto.slice(at + 1);
  if (/\s/.test(text)) return null;
  return { start: at, text };
}

export function matchMembers(
  members: RosterMember[],
  query: string,
  limit = MENTION_LIMIT
): RosterMember[] {
  const needle = query.trim().toLowerCase();
  const active = members.filter((member) => member.status === "active");
  const matched = needle
    ? active.filter(
        (member) =>
          member.handle.toLowerCase().includes(needle) ||
          member.displayName.toLowerCase().includes(needle)
      )
    : active;
  return matched.slice(0, limit);
}

export function insertMention(
  value: string,
  caret: number,
  query: MentionQuery,
  handle: string
): { value: string; caret: number } {
  const next = `${value.slice(0, query.start)}@${handle} ${value.slice(caret)}`;
  return { value: next, caret: query.start + handle.length + 2 };
}

export function useMentionAutocomplete({
  value,
  members,
  inputRef,
  onValueChange,
}: {
  value: string;
  members: RosterMember[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onValueChange: (value: string) => void;
}) {
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const query = open ? mentionQueryAt(value, caret) : null;
  const queryText = query?.text ?? null;
  const candidates = useMemo(
    () => (queryText === null ? [] : matchMembers(members, queryText)),
    [members, queryText]
  );
  const visible = candidates.length > 0;

  const close = useCallback(() => setOpen(false), []);
  // textarea의 keydown보다 먼저 받는 공용 층이다. 스레드 패널의 Esc까지 함께
  // 닫히지 않게 이 목록 하나만 물러나고 전파를 끊는다.
  useEscapeLayer(visible, close);

  const replaceValue = (next: string, nextCaret: number) => {
    onValueChange(next);
    setCaret(nextCaret);
    setHighlight(0);
    setOpen(false);
  };

  const choose = (member: RosterMember) => {
    if (!query) return;
    const inserted = insertMention(value, caret, query, member.handle);
    replaceValue(inserted.value, inserted.caret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const onTextChange = (next: string, nextCaret: number) => {
    onValueChange(next);
    setCaret(nextCaret);
    setOpen(true);
    setHighlight(0);
  };

  const insertTrigger = () => {
    const input = inputRef.current;
    const fallback = value.length;
    const inserted = insertMentionTriggerAtComposerSelection(value, {
      start: input?.selectionStart ?? fallback,
      end: input?.selectionEnd ?? fallback,
    });
    // 평범하게 @를 타이핑한 경로와 같은 상태 전이를 쓴다. 별도 popover 상태나
    // 후보 store를 만들면 키보드 입력과 버튼 입력이 서로 다른 목록이 된다.
    onTextChange(inserted.value, inserted.caret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const handleIntent = (intent: ComposerKeyIntent): boolean => {
    switch (intent) {
      case "mention-accept": {
        const selected = candidates[Math.min(highlight, candidates.length - 1)];
        if (!selected) return false;
        choose(selected);
        return true;
      }
      case "mention-next":
        if (candidates.length === 0) return false;
        setHighlight((current) => (current + 1) % candidates.length);
        return true;
      case "mention-prev":
        if (candidates.length === 0) return false;
        setHighlight(
          (current) => (current - 1 + candidates.length) % candidates.length
        );
        return true;
      case "mention-close":
        close();
        return true;
      default:
        return false;
    }
  };

  return {
    candidates,
    visible,
    highlight,
    setCaret,
    close,
    replaceValue,
    insertTrigger,
    choose,
    onTextChange,
    handleIntent,
  };
}

export function MentionAutocompleteList({
  id,
  candidates,
  highlight,
  onChoose,
  testId,
  optionTestId,
  className,
}: {
  id: string;
  candidates: RosterMember[];
  highlight: number;
  onChoose: (member: RosterMember) => void;
  testId: string;
  optionTestId: string;
  className?: string;
}) {
  if (candidates.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="멤버 언급"
      data-testid={testId}
      className={cn(
        "absolute bottom-full left-3 mb-2 w-pane-sm overflow-hidden rounded-md border border-line bg-surface-raised p-1 shadow-lg",
        className
      )}
    >
      {candidates.map((member, index) => (
        <li key={member.id}>
          <button
            id={`${id}-option-${index}`}
            type="button"
            role="option"
            aria-selected={index === highlight}
            data-testid={optionTestId}
            onMouseDown={(event) => {
              event.preventDefault();
              onChoose(member);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body",
              index === highlight ? "bg-accent-soft text-ink" : "text-ink"
            )}
          >
            <span className="truncate">@{member.handle}</span>
            <span className="min-w-0 flex-1 truncate text-meta text-ink-muted">
              {member.displayName}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
