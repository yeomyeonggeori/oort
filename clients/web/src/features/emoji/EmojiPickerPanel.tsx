import {
  useEffect,
  useId,
  useMemo,
  useState,
  type MutableRefObject,
} from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  displayGlyph,
  EMOJI_CATEGORY_TABS,
  resolveCatalogEmoji,
  type CatalogEmoji,
  type EmojiCategoryId,
  type SkinTone,
} from "./catalog";
import { useFrequentEmojis } from "./frequencyStore";
import { filterEmojis } from "./search";
import { useEmojiSkinTone } from "./skinToneStore";

const GRID_COLS = 8;
const SKIN_OPTIONS: ReadonlyArray<{ tone: SkinTone; glyph: string; label: string }> = [
  { tone: 0, glyph: "\u270B", label: "기본 피부색" },
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
  if (key === "ArrowDown") return Math.min(last, index + GRID_COLS);
  if (key === "ArrowUp") return Math.max(0, index - GRID_COLS);
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

export function EmojiPickerPanel({
  itemPrefix,
  entries,
  loading,
  error,
  onRetry,
  onPick,
  seed,
  searchRef,
}: {
  itemPrefix: string;
  entries: CatalogEmoji[] | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onPick: (emoji: string, base: string) => void;
  seed: readonly string[];
  searchRef: MutableRefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const tablistId = `${id}-tabs`;
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"frequent" | EmojiCategoryId>("frequent");
  const [tabFocus, setTabFocus] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [preview, setPreview] = useState<CatalogEmoji | null>(null);
  const [skinOpen, setSkinOpen] = useState(false);
  const [tone, setTone] = useEmojiSkinTone();
  const frequentGlyphs = useFrequentEmojis(seed);
  const searching = query.trim().length > 0;

  const visible = useMemo(() => {
    const catalog = entries ?? [];
    if (searching) return filterEmojis(catalog, query);
    if (category === "frequent") return glyphsToEntries(frequentGlyphs, catalog);
    return catalog.filter((entry) => entry.category === category);
  }, [category, entries, frequentGlyphs, query, searching]);

  useEffect(() => {
    setActiveIndex(0);
    setPreview(visible[0] ?? null);
  }, [visible]);

  useEffect(() => {
    searchRef.current?.focus();
  }, [searchRef]);

  const pick = (entry: CatalogEmoji) => {
    onPick(displayGlyph(entry, tone), entry.glyph);
  };

  const revealIndex = (index: number) => {
    document
      .getElementById(`${listId}-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!searching) {
      if (event.key === "ArrowDown" && visible[0]) {
        event.preventDefault();
        setActiveIndex(0);
        setPreview(visible[0]);
        document.getElementById(`${listId}-0`)?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        event.key === "ArrowDown"
          ? Math.min(visible.length - 1, activeIndex + 1)
          : Math.max(0, activeIndex - 1);
      setActiveIndex(next);
      setPreview(visible[next] ?? null);
      revealIndex(next);
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
      const next = moveGridIndex(activeIndex, event.key, visible.length);
      setActiveIndex(next);
      setPreview(visible[next] ?? null);
      const item = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[
        next
      ];
      item?.focus();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && visible[activeIndex]) {
      event.preventDefault();
      pick(visible[activeIndex]);
    }
  };

  const shortcode = preview?.shortcodes[0]
    ? `:${preview.shortcodes[0]}:`
    : "";

  return (
    <div
      className="flex min-h-0 flex-col gap-2"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !skinOpen) return;
        event.preventDefault();
        event.stopPropagation();
        setSkinOpen(false);
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          ref={(node) => {
            searchRef.current = node;
          }}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="이름, 단축 코드로 찾기"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
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
        <div className="relative shrink-0">
          {/* Nested DropdownMenu inside a modal Popover fights the focus
              scope and steals Esc. A local listbox stays in this panel. */}
          <button
            type="button"
            aria-label="피부색"
            aria-expanded={skinOpen}
            aria-haspopup="listbox"
            data-testid="emoji-skin-toggle"
            onClick={() => setSkinOpen((open) => !open)}
            onKeyDown={(event) => {
              if (!skinOpen) return;
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 1 : -1;
              const next = ((((tone + delta) % 6) + 6) % 6) as SkinTone;
              setTone(next);
            }}
            className="tap-target flex size-control items-center justify-center rounded-sm border border-line-strong text-title hover:bg-surface-hover focus-visible:focus-ring"
          >
            <span aria-hidden="true">
              {SKIN_OPTIONS[tone]?.glyph ?? "✋"}
            </span>
          </button>
          {skinOpen && (
            <ul
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
                      setSkinOpen(false);
                    }}
                    className={cn(
                      "tap-target flex size-control items-center justify-center rounded-sm text-title hover:bg-surface-hover focus-visible:focus-ring",
                      tone === option.tone && "bg-accent-soft"
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
                  setCategory(tab.id);
                  setTabFocus(index);
                }}
                className={cn(
                  "tap-target flex size-control items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:focus-ring",
                  selected && "bg-accent-soft text-ink"
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
        className="min-h-0 max-h-pane overflow-y-auto"
      >
        {loading ? (
          <SkeletonRows rows={6} className="p-0" />
        ) : error ? (
          <InlineBanner
            message="이모지 목록을 불러오지 못했습니다. 다시 시도하세요."
            actionLabel="다시 시도"
            onAction={onRetry}
            separator={false}
            testId="emoji-catalog-error"
          />
        ) : visible.length === 0 && searching ? (
          <EmptyInvite
            headline="찾는 이모지가 없습니다"
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
          <EmptyInvite
            headline="자주 쓰는 이모지가 여기 모입니다"
            className="px-0 py-4"
            testId="emoji-frequent-empty"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => searchRef.current?.focus()}
              >
                검색으로 찾기
              </Button>
            }
          />
        ) : (
          <div
            id={listId}
            role={searching ? "listbox" : "menu"}
            aria-label={searching ? "검색 결과" : "이모지"}
            onKeyDown={onGridKeyDown}
            className="grid grid-cols-8 gap-1"
          >
            {visible.map((entry, index) => {
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
                  aria-label={entry.name}
                  onMouseEnter={() => {
                    setPreview(entry);
                    setActiveIndex(index);
                  }}
                  onFocus={() => {
                    setPreview(entry);
                    setActiveIndex(index);
                  }}
                  onClick={() => pick(entry)}
                  className={cn(
                    // 8 equal columns share the pane. tap-target (44) × 8
                    // cannot fit a 390 sheet; the column is the hit box
                    // (~42px there). Finger floor is touch-target (24).
                    "touch-target flex aspect-square w-full items-center justify-center rounded-sm text-title hover:bg-surface-hover focus-visible:focus-ring",
                    active && "bg-surface-hover"
                  )}
                >
                  <span aria-hidden="true">{shown}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div
        className="flex min-h-control items-center gap-2 border-t border-line pt-2"
        data-testid="emoji-preview"
        aria-live="polite"
      >
        {preview ? (
          <>
            <span className="text-title" aria-hidden="true">
              {displayGlyph(preview, tone)}
            </span>
            <span className="min-w-0 truncate text-body">{preview.name}</span>
            {shortcode ? (
              <span className="shrink-0 font-mono text-meta text-ink-muted">
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
