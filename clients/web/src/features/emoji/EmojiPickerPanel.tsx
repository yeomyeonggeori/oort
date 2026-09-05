import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useBrowserOffline } from "@/features/common/useOffline";
import {
  displayGlyph,
  EMOJI_CATEGORY_TABS,
  resolveCatalogEmoji,
  type CatalogEmoji,
  type EmojiCategoryId,
  type SkinTone,
} from "./catalog";
import { useFrequentEmojis } from "./frequencyStore";
import {
  EMOJI_GRID_COLS,
  EMOJI_GRID_RENDER_LIMIT,
  emojiGridPadRows,
  emojiGridWindow,
} from "./gridWindow";
import { EMOJI_CATALOG_COPY } from "./copy";
import { filterEmojis, isEmojiSearchQuery } from "./search";
import { useEmojiSkinTone } from "./skinToneStore";

const SKIN_OPTIONS: ReadonlyArray<{ tone: SkinTone; glyph: string; label: string }> = [
  { tone: 0, glyph: "\u270B", label: "기본 피부" },
  { tone: 1, glyph: "\u270B\u{1F3FB}", label: "밝은 피부" },
  { tone: 2, glyph: "\u270B\u{1F3FC}", label: "중간 밝은 피부" },
  { tone: 3, glyph: "\u270B\u{1F3FD}", label: "중간 피부" },
  { tone: 4, glyph: "\u270B\u{1F3FE}", label: "중간 어두운 피부" },
  { tone: 5, glyph: "\u270B\u{1F3FF}", label: "어두운 피부" },
];

function moveGridIndex(
  index: number,
  key: string,
  count: number
): number {
  if (count === 0) return 0;
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key === "ArrowRight") return Math.min(last, index + 1);
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowDown") return Math.min(last, index + EMOJI_GRID_COLS);
  if (key === "ArrowUp") return Math.max(0, index - EMOJI_GRID_COLS);
  return index;
}

function glyphsToEntries(
  glyphs: readonly string[],
  catalog: readonly CatalogEmoji[]
): CatalogEmoji[] {
  const out: CatalogEmoji[] = [];
  const seen = new Set<string>();
  for (const glyph of glyphs) {
    const entry = resolveCatalogEmoji(catalog, glyph);
    if (!entry || seen.has(entry.glyph)) continue;
    seen.add(entry.glyph);
    out.push(entry);
  }
  return out;
}

function EmojiGridPad({ rows }: { rows: number }) {
  if (rows <= 0) return null;
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="emoji-grid-row-pad" aria-hidden="true" />
      ))}
    </>
  );
}

export function EmojiPickerPanel({
  itemPrefix,
  entries,
  loading,
  error,
  onRetry,
  onPick,
  seed,
  searchRef,
  skinOpen,
  onSkinOpenChange,
  autoFocusSearch = true,
}: {
  itemPrefix: string;
  entries: CatalogEmoji[] | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onPick: (emoji: string, base: string) => void;
  seed: readonly string[];
  searchRef: MutableRefObject<HTMLInputElement | null>;
  skinOpen: boolean;
  onSkinOpenChange: (open: boolean) => void;
  autoFocusSearch?: boolean;
}) {
  const id = useId();
  const tablistId = `${id}-tabs`;
  const listId = `${id}-list`;
  const skinListId = `${id}-skin`;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"frequent" | EmojiCategoryId>("frequent");
  const [tabFocus, setTabFocus] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollAnchor, setScrollAnchor] = useState(0);
  const [preview, setPreview] = useState<CatalogEmoji | null>(null);
  const [tone, setTone] = useEmojiSkinTone();
  const frequentGlyphs = useFrequentEmojis(seed);
  const browserOffline = useBrowserOffline();
  const searching = isEmojiSearchQuery(query);
  const pointerPosRef = useRef<{ x: number; y: number } | null>(null);
  const focusGridRef = useRef(false);
  const skinRootRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => {
    const catalog = entries ?? [];
    if (searching) return filterEmojis(catalog, query);
    if (category === "frequent") return glyphsToEntries(frequentGlyphs, catalog);
    return catalog.filter((entry) => entry.category === category);
  }, [category, entries, frequentGlyphs, query, searching]);

  const { start, end } = emojiGridWindow(
    visible.length,
    scrollAnchor,
    EMOJI_GRID_RENDER_LIMIT
  );
  const rendered = visible.slice(start, end);

  useEffect(() => {
    setActiveIndex(0);
    setScrollAnchor(0);
    setPreview(visible[0] ?? null);
  }, [visible]);

  useEffect(() => {
    if (!autoFocusSearch) return;
    searchRef.current?.focus();
  }, [searchRef, autoFocusSearch]);

  useEffect(() => {
    if (!skinOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (skinRootRef.current?.contains(target)) return;
      onSkinOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [skinOpen, onSkinOpenChange]);

  useEffect(() => {
    const node = document.getElementById(`${listId}-${activeIndex}`);
    if (!node) return;
    if (focusGridRef.current) {
      focusGridRef.current = false;
      if (!searching) node.focus();
    }
    node.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId, start, end, searching]);

  const pick = (entry: CatalogEmoji) => {
    onPick(displayGlyph(entry, tone), entry.glyph);
  };

  const moveCursor = (index: number, via: "keyboard" | "pointer") => {
    const entry = visible[index];
    if (!entry) return;
    if (via === "keyboard") focusGridRef.current = true;
    setActiveIndex(index);
    setScrollAnchor(index);
    setPreview(entry);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!searching) {
      if (event.key === "ArrowDown" && visible[0]) {
        event.preventDefault();
        moveCursor(0, "keyboard");
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        event.key === "ArrowDown"
          ? Math.min(visible.length - 1, activeIndex + 1)
          : Math.max(0, activeIndex - 1);
      moveCursor(next, "keyboard");
      return;
    }
    if (event.key === "Enter" && visible[activeIndex]) {
      event.preventDefault();
      pick(visible[activeIndex]);
    }
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next =
      (tabFocus + delta + EMOJI_CATEGORY_TABS.length) % EMOJI_CATEGORY_TABS.length;
    setTabFocus(next);
    const tab = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[
      next
    ];
    tab?.focus();
  };

  const onGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (searching) return;
    const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
    if (keys.includes(event.key)) {
      event.preventDefault();
      moveCursor(moveGridIndex(activeIndex, event.key, visible.length), "keyboard");
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && visible[activeIndex]) {
      event.preventDefault();
      pick(visible[activeIndex]);
    }
  };

  const onCellPointerMove = (
    event: React.PointerEvent<HTMLButtonElement>,
    index: number
  ) => {
    const prev = pointerPosRef.current;
    if (prev && prev.x === event.clientX && prev.y === event.clientY) return;
    pointerPosRef.current = { x: event.clientX, y: event.clientY };
    if (index !== activeIndex) moveCursor(index, "pointer");
  };

  const onGridScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const cell = scroller.querySelector("[data-emoji-cell]");
    if (!(cell instanceof HTMLElement) || cell.offsetHeight <= 0) return;
    const rowHeight = cell.offsetHeight + 4;
    const row = Math.round(scroller.scrollTop / rowHeight);
    setScrollAnchor(row * EMOJI_GRID_COLS);
  };

  const shortcode = preview?.shortcodes[0]
    ? `:${preview.shortcodes[0]}:`
    : "";

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          ref={(node) => {
            searchRef.current = node;
          }}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="영문 이름, :code:로 검색"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={false}
          aria-label="이모지 검색"
          data-testid="emoji-search"
          className="min-w-0 flex-1"
          {...(searching
            ? {
                role: "combobox" as const,
                "aria-expanded": true,
                "aria-autocomplete": "list" as const,
                "aria-controls": listId,
                "aria-activedescendant":
                  visible[activeIndex] != null ? `${listId}-${activeIndex}` : undefined,
              }
            : {})}
        />
        <div className="relative shrink-0" ref={skinRootRef}>
          {/* Nested DropdownMenu inside a modal Popover fights the focus
              scope. A local listbox stays in this panel. Esc is not handled
              here: React stopPropagation does not reach Radix DismissableLayer
              (document listener). The shell Popover/Dialog onEscapeKeyDown
              closes only this list when it is open. */}
          <button
            type="button"
            aria-label="피부색"
            aria-expanded={skinOpen}
            aria-haspopup="listbox"
            aria-controls={skinOpen ? skinListId : undefined}
            data-testid="emoji-skin-toggle"
            onClick={() => onSkinOpenChange(!skinOpen)}
            onKeyDown={(event) => {
              if (!skinOpen) return;
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 1 : -1;
              const next = ((((tone + delta) % 6) + 6) % 6) as SkinTone;
              setTone(next);
            }}
            className="tap-target flex size-control items-center justify-center rounded-sm border border-line-strong text-title press hover:bg-surface-hover focus-visible:focus-ring"
          >
            <span aria-hidden="true">
              {SKIN_OPTIONS[tone]?.glyph ?? "✋"}
            </span>
          </button>
          {skinOpen && (
            <ul
              id={skinListId}
              role="listbox"
              aria-label="피부색"
              className="absolute right-0 z-50 mt-1 flex gap-1 rounded-md border border-line bg-surface-raised p-1 shadow-lg"
            >
              {SKIN_OPTIONS.map((option) => (
                <li key={option.tone} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={tone === option.tone}
                    aria-label={option.label}
                    data-testid={`emoji-skin-${option.tone}`}
                    onClick={() => {
                      setTone(option.tone);
                      onSkinOpenChange(false);
                    }}
                    className={cn(
                      "tap-target flex size-control items-center justify-center rounded-sm text-title press focus-visible:focus-ring",
                      tone === option.tone
                        ? "bg-accent-soft active:bg-surface-pressed"
                        : "hover:bg-surface-hover"
                    )}
                  >
                    <span aria-hidden="true">{option.glyph}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {!searching && (
        // 390에서 9탭이 7+2로 접힌다. nowrap+overflow-x는 무선언 가로 스크롤이라
        // capture:design 하네스가 차단하고(iOS엔 스크롤 어포던스도 없다),
        // 끌리는 상자로 바꾸려면 컴포넌트가 data-scroll-x를 선언해야 한다.
        <div
          role="tablist"
          aria-label="이모지 분류"
          id={tablistId}
          onKeyDown={onTabKeyDown}
          className="flex flex-wrap gap-1"
        >
          {EMOJI_CATEGORY_TABS.map((tab, index) => {
            const selected = category === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`${tablistId}-${tab.id}`}
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                tabIndex={tabFocus === index ? 0 : -1}
                title={tab.label}
                aria-label={tab.label}
                data-testid={`emoji-cat-${tab.id}`}
                onClick={() => {
                  onSkinOpenChange(false);
                  setCategory(tab.id);
                  setTabFocus(index);
                }}
                className={cn(
                  "tap-target flex size-control shrink-0 items-center justify-center rounded-sm press focus-visible:focus-ring",
                  selected
                    ? "bg-accent-soft text-ink active:bg-surface-pressed"
                    : "text-ink-muted hover:bg-surface-hover hover:text-ink"
                )}
              >
                <tab.Icon className="size-4" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}

      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={
          searching ? undefined : `${tablistId}-${category}`
        }
        onScroll={onGridScroll}
        className="min-h-0 max-h-pane overflow-y-auto"
      >
        {loading ? (
          <Skeleton ready={false} rows={6} className="p-0" />
        ) : error ? (
          <InlineBanner
            message={
              browserOffline
                ? EMOJI_CATALOG_COPY.offline
                : EMOJI_CATALOG_COPY.error
            }
            actionLabel={EMOJI_CATALOG_COPY.retry}
            onAction={onRetry}
            separator={false}
            testId="emoji-catalog-error"
          />
        ) : visible.length === 0 && searching ? (
          <EmptyInvite
            headline={EMOJI_CATALOG_COPY.emptyHeadline}
            detail={EMOJI_CATALOG_COPY.emptyDetail}
            className="px-0 py-4"
            testId="emoji-search-empty"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setQuery("")}
              >
                검색 지우기
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          // 오늘은 도달 불가(빈도 탭은 32종 시드로 폴백)지만, 빈 목록이 문장
          // 없는 상자로 출하되지 않게 자리를 지킨다.
          <EmptyInvite
            headline="표시할 이모지가 없습니다"
            className="px-0 py-4"
            testId="emoji-grid-empty"
          />
        ) : (
          <div
            id={listId}
            role={searching ? "listbox" : "menu"}
            aria-label={searching ? "검색 결과" : "이모지"}
            onKeyDown={onGridKeyDown}
            className="emoji-grid"
          >
            <EmojiGridPad rows={emojiGridPadRows(start)} />
            {rendered.map((entry, offset) => {
              const index = start + offset;
              const shown = displayGlyph(entry, tone);
              const active = index === activeIndex;
              return (
                <button
                  key={entry.glyph}
                  type="button"
                  id={`${listId}-${index}`}
                  role={searching ? "option" : "menuitem"}
                  aria-selected={searching ? active : undefined}
                  tabIndex={searching ? -1 : active ? 0 : -1}
                  data-testid={`${itemPrefix}-${entry.glyph}`}
                  data-emoji-cell=""
                  aria-label={entry.name}
                  onPointerMove={(event) => onCellPointerMove(event, index)}
                  onFocus={() => {
                    setPreview(entry);
                    setActiveIndex(index);
                  }}
                  onMouseDown={
                    searching
                      ? (event) => {
                          event.preventDefault();
                          pick(entry);
                        }
                      : undefined
                  }
                  onClick={searching ? undefined : () => pick(entry)}
                  className={cn(
                    // 8 equal columns share the pane. tap-target (44) × 8
                    // cannot fit a 390 sheet; the column is the hit box
                    // (~42px there). Finger floor is touch-target (24).
                    // MOBILE_TAP_TARGETS is an allowlist and does not see
                    // these cells (오르트 구름 §5.5②) — 42 < 44 is known.
                    "emoji-grid-slot touch-target flex aspect-square w-full items-center justify-center rounded-sm text-title press focus-visible:focus-ring",
                    active
                      ? "bg-accent-soft text-ink active:bg-surface-pressed"
                      : "hover:bg-surface-hover"
                  )}
                >
                  <span aria-hidden="true">{shown}</span>
                </button>
              );
            })}
            <EmojiGridPad rows={emojiGridPadRows(visible.length - end)} />
          </div>
        )}
      </div>

      <div
        className="flex min-h-control flex-wrap items-center gap-2 border-t border-line pt-2"
        data-testid="emoji-preview"
        aria-hidden="true"
      >
        {preview ? (
          <>
            <span className="text-title">{displayGlyph(preview, tone)}</span>
            <span className="text-body">{preview.name}</span>
            {shortcode ? (
              <span className="min-w-0 truncate font-mono text-meta text-ink-muted">
                {shortcode}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-meta text-ink-muted">이모지를 고르세요</span>
        )}
      </div>
    </div>
  );
}
