import { useEffect, useMemo, useRef, useState } from "react";
import type { DialogFocusTarget } from "@/design/ui/dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/design/ui/popover";
import type { CatalogEmoji } from "./catalog";
import { loadCatalog } from "./catalog";
import { EmojiPickerPanel } from "./EmojiPickerPanel";
import { recordEmojiUse } from "./frequencyStore";
import { useHoverNone } from "./useHoverNone";

// =============================================================================
// 컴포저와 메시지 반응이 함께 쓰는 이모지 표면 (#1742, supersede #1688).
//
// 피커 라이브러리를 쓰지 않는 결정은 유지한다. 라이브러리는 폰트나 스프라이트를
// 싣기 쉽고, 이 앱은 외부 호스트가 막힌 CSP와 오프라인 Tauri 셸을 함께 낸다.
// 데이터는 emojibase compact(en)+iamcal shortcode를 빌드타임에 추출한
// same-origin 번들이다.
//
// 32종 고정 어휘와 중앙 Dialog는 2026-08-24 성재 지시로 supersede됐다.
// PICKER_EMOJI는 빈 Frequently used의 큐레이션 시드(그리고 UX-HT 슬롯 시드)로
// 남는다. 포인터는 트리거 기준 anchored popover, 터치(`hover: none`)는 바텀시트.
//
// DialogTrigger/PopoverTrigger는 두지 않는다. 두 소비자는 열기 전에 각각
// 메시지 행 또는 textarea의 선택 범위를 기록해야 하므로, 실제 button onClick이
// open을 올리고 그 button을 `anchor`, 포커스 복귀 대상을 `opener`로 넘기는
// 정본 프로그래매틱 패턴을 쓴다.
// =============================================================================

// eslint-disable-next-line react-refresh/only-export-components -- 테스트와 빈도 시드가 닫힌 32종을 직접 센다.
export const PICKER_EMOJI = [
  "👍", "👎", "✅", "❌", "🙏", "🎉", "👀", "😄",
  "😂", "😅", "🤔", "😮", "😭", "🔥", "💯", "✨",
  "🚀", "🐛", "🛠️", "📌", "📝", "🔍", "⏳", "⚠️",
  "❤️", "💡", "🙌", "👏", "☕", "🍀", "🥲", "🫡",
] as const;

const COPY = {
  reaction: {
    title: "반응 고르기",
    description: "이 메시지에 남길 이모지를 고르세요.",
    itemPrefix: "picker-react",
  },
  insert: {
    title: "이모지 넣기",
    description: "메시지에 넣을 이모지를 고르세요.",
    itemPrefix: "picker-insert",
  },
} as const;

export function EmojiPickerDialog({
  open,
  onOpenChange,
  onPick,
  opener,
  anchor,
  purpose,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
  opener: DialogFocusTarget | null;
  /** Popover 위치의 기준. 생략하면 opener가 HTMLElement일 때 그것을 쓴다. */
  anchor?: HTMLElement | null;
  purpose: keyof typeof COPY;
  testId: string;
}) {
  const copy = COPY[purpose];
  const isTouch = useHoverNone();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [entries, setEntries] = useState<CatalogEmoji[] | null>(null);
  const [error, setError] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [skinOpen, setSkinOpen] = useState(false);
  const positionRef = useMemo(
    () => ({
      current: (anchor ?? (opener instanceof HTMLElement ? opener : null)) ?? null,
    }),
    [anchor, opener]
  );

  useEffect(() => {
    if (!open) setSkinOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(false);
    loadCatalog().then(
      (catalog) => {
        if (live) setEntries(catalog);
      },
      () => {
        if (live) {
          setEntries(null);
          setError(true);
        }
      }
    );
    return () => {
      live = false;
    };
  }, [open, loadNonce]);

  const handlePick = (emoji: string, base: string) => {
    recordEmojiUse(base);
    onPick(emoji);
    onOpenChange(false);
  };

  const retry = () => {
    setError(false);
    setEntries(null);
    setLoadNonce((n) => n + 1);
  };

  const onEscapeKeyDown = (event: KeyboardEvent) => {
    if (!skinOpen) return;
    event.preventDefault();
    setSkinOpen(false);
  };

  const panel = (
    <EmojiPickerPanel
      itemPrefix={copy.itemPrefix}
      entries={entries}
      loading={open && !error && entries === null}
      error={error}
      onRetry={retry}
      onPick={handlePick}
      seed={PICKER_EMOJI}
      searchRef={searchRef}
      skinOpen={skinOpen}
      onSkinOpenChange={setSkinOpen}
      autoFocusSearch={!isTouch}
    />
  );

  if (isTouch) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          ref={sheetRef}
          tabIndex={-1}
          opener={opener}
          data-testid={testId}
          className="safe-area-bottom bottom-0 left-0 top-auto max-h-pane-lg max-w-none translate-x-0 gap-2 rounded-lg p-3"
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={(event) => {
            // 검색창을 포커스하면 소프트 키보드가 fixed 시트를 덮는다. 그렇다고
            // 포커스를 트리거(시트 뒤, aria-hidden 서브트리)에 남기면 Tab이 눈에
            // 안 보이는 컨트롤에 닿는다(ADR-0112 D6). 시트 자신에게 옮긴다.
            event.preventDefault();
            sheetRef.current?.focus();
          }}
        >
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="sr-only">
            {copy.description}
          </DialogDescription>
          {panel}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal>
      <PopoverAnchor virtualRef={positionRef} />
      <PopoverContent
        opener={opener}
        data-testid={testId}
        side="top"
        align="start"
        aria-label={copy.title}
        onEscapeKeyDown={onEscapeKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        className="flex max-h-pane-md flex-col"
      >
        <p className="sr-only">{copy.description}</p>
        {panel}
      </PopoverContent>
    </Popover>
  );
}
