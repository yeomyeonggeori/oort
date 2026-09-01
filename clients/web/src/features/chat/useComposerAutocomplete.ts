import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import type { ComposerKeyIntent } from "@momo/core/features/chat/composerKeys";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import type { CatalogEmoji } from "@/features/emoji/catalog";
import { loadCatalog } from "@/features/emoji/catalog";
import { recordEmojiUse } from "@/features/emoji/frequencyStore";
import { useEmojiSkinTone } from "@/features/emoji/skinToneStore";
import {
  channelCandidates,
  composerTriggerQueryAt,
  composerTriggerSpec,
  emojiCandidates,
  insertComposerCandidate,
  memberCandidates,
  type ComposerCandidate,
  type ComposerTriggerKind,
} from "./composerAutocomplete";
import { insertMentionTriggerAtComposerSelection } from "./composerInsertion";

// =============================================================================
// 자동완성 목록의 상태 기계 (#1930). 채널 컴포저와 스레드 컴포저가 이 하나를 쓴다.
//
// 트리거가 셋이어도 상태는 한 벌이다: 캐럿 하나, 강조 하나, 열림 하나. 어느
// 트리거가 열렸는지는 파서가 **본문에서** 읽어 내는 것이지 이 훅이 따로
// 기억하는 사실이 아니다 — 기억하기 시작하면 사람이 `@her` 를 지우고 `#gen` 을
// 칠 때 두 사실이 갈라지고, 그 사이에 목록은 옛 트리거의 후보를 그린다.
//
// 키 처리도 한 벌이다. 코어의 `ComposerKeyIntent` 는 `mention-*` 이라는 이름을
// 그대로 둔다: 그 열거는 폰까지 함께 출하되는 정본이고, 뜻은 이미 「자동완성
// 목록이 열려 있을 때의 ↑↓·↵·Tab·Esc」다. 이름 하나를 바꾸자고 코어 계약을
// 흔드는 것은 이 티켓의 값이 아니다.
// =============================================================================

const NO_CANDIDATES: ComposerCandidate[] = [];
const NO_CATALOG: readonly CatalogEmoji[] = [];

/**
 * 이모지 질의가 실제로 열렸을 때만 카탈로그를 싣는다.
 *
 * 정적 import 를 쓰지 않는 이유는 피커와 같다: 카탈로그는 부팅 예산이 감당할
 * 크기가 아니고(`loadCatalog` 는 그래서 dynamic import 다), `:` 를 한 번도 치지
 * 않는 사람은 이 파일을 내려받을 이유가 없다.
 */
function useEmojiCatalog(active: boolean): readonly CatalogEmoji[] {
  const [entries, setEntries] = useState<readonly CatalogEmoji[]>(NO_CATALOG);
  useEffect(() => {
    if (!active || entries.length > 0) return;
    let live = true;
    void loadCatalog().then(
      (catalog) => {
        if (live) setEntries(catalog);
      },
      () => {
        // 못 실으면 이모지 후보만 없다. `@`·`#` 은 카탈로그와 무관하므로
        // 여기서 목록 기계 전체를 세우지 않는다.
      }
    );
    return () => {
      live = false;
    };
  }, [active, entries.length]);
  return entries;
}

export function useComposerAutocomplete({
  value,
  members,
  channels,
  inputRef,
  onValueChange,
}: {
  value: string;
  members: RosterMember[];
  /** 이 워크스페이스의 채널 스토어. `#` 후보는 여기서만 온다. */
  channels: Channel[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onValueChange: (value: string) => void;
}) {
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const [tone] = useEmojiSkinTone();
  const query = open ? composerTriggerQueryAt(value, caret) : null;
  const kind: ComposerTriggerKind | null = query?.kind ?? null;
  const queryText = query?.text ?? null;
  const catalog = useEmojiCatalog(kind === "emoji");
  const candidates = useMemo(() => {
    if (kind === null || queryText === null) return NO_CANDIDATES;
    if (kind === "mention") return memberCandidates(members, queryText);
    if (kind === "channel") return channelCandidates(channels, queryText);
    return emojiCandidates(catalog, queryText, tone);
  }, [kind, queryText, members, channels, catalog, tone]);
  const visible = candidates.length > 0;
  const slug = composerTriggerSpec(kind ?? "mention").slug;

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

  const choose = (candidate: ComposerCandidate) => {
    if (!query) return;
    const inserted = insertComposerCandidate(
      value,
      caret,
      query.start,
      candidate.insert
    );
    // 이모지는 고른 순간 「자주 씀」에 센다. 피커에서 고른 것과 컴포저에서
    // 완성한 것이 같은 한 벌로 쌓여야 다음에 뜨는 슬롯이 사람의 습관이 된다.
    if (candidate.base !== undefined) recordEmojiUse(candidate.base);
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
    /** 지금 열린 트리거, 없으면 null. 목록의 접근 이름·id 가 여기서 갈린다. */
    kind,
    /** DOM id·testid 의 조각(`mention`·`channel`·`emoji`). */
    slug,
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
