import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/design/ui/popover";

// Reading this as: a closed single-choice field whose list is drawn by the app, opened from a
// dialog on web + the Tauri shell, density 7/10, motion 2/10.

// =============================================================================
// 앱이 그리는 선택 칸 (#4106). `Select`(네이티브 `<select>`)의 짝이다.
//
// ## 왜 `Select` 를 두고 이것을 새로 만드나
//
// `select.tsx` 머리말이 적어 둔 대로 네이티브 팝업은 OS가 그린다 — 클래스를 받지
// 않는다. macOS 에서는 회색 반투명 메뉴가 뜨는데, 이 앱의 메뉴·팝오버(`--surface-raised`,
// `--line`, `shadow-lg`, `POPOVER_MOTION`)와 한 제품으로 읽히지 않는다. 방해 금지·알림
// 일시 중지의 「기한」은 사람이 하루에도 몇 번 여는 자리라 그 어긋남이 눈에 띈다
// (성재 0.1.32 실기, 2026-10-20).
//
// 그렇다고 `Select` 를 없애지 않는다: 모델·노력 수준처럼 항목이 많고 타이프어헤드가
// 중요한 칸은 OS 팝업이 여전히 낫다. 이 칸은 **항목이 열 개 안쪽인 짧은 목록**용이다.
//
// ## 계약
//
// - 단추가 `role="combobox"`(`aria-haspopup="listbox"`)이고 목록이 `role="listbox"`,
//   항목이 `role="option"` + `aria-selected` 다. 포커스는 목록이 열리면 목록으로 가고,
//   활성 항목은 `aria-activedescendant` 로 말한다(항목이 탭 정지점이 되지 않는다).
// - 키보드: 단추에서 ↓·↑·Enter·Space 가 연다. 목록에서 ↑↓ 이동(끝에서 멈춤), Home·End,
//   Enter·Space 선택, Esc 닫기(Radix 가 가장 위 층만 닫는다), Tab 은 닫고 흐름을 잇는다.
//   닫히면 포커스는 단추로 돌아온다.
// - 비활성 항목은 숨기지 않고 흐리게 보이며 고를 수 없다(「불가능한 선택지는 이유와 함께
//   보인다」 규칙). 자리표시자는 항목이 아니라 단추의 글이다.
// - 폭은 단추를 따른다(`--radix-popover-trigger-width`). 항목의 보조 글(`hint`)은 제 줄을
//   가져 잘리지 않는다.
// =============================================================================

export type ListboxOption<V extends string = string> = {
  value: V;
  label: string;
  /** 라벨 아래 흐린 한 줄(끝 시각·날짜). 단추에는 「라벨 · 보조」 로 합쳐 읽힌다. */
  hint?: string;
  disabled?: boolean;
};

export function optionDisplay(option: ListboxOption): string {
  return option.hint ? `${option.label} · ${option.hint}` : option.label;
}

export function ListboxSelect<V extends string = string>({
  id,
  value,
  options,
  onValueChange,
  placeholder,
  disabled = false,
  className,
  "data-testid": testId,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  side = "bottom",
  ...rest
}: Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "onChange" | "children" | "role" | "type"
> & {
  id?: string;
  /** 고른 값. 목록에 없는 값(빈 문자열 포함)이면 자리표시자가 보인다. */
  value: V | "";
  options: ListboxOption<V>[];
  onValueChange: (value: V) => void;
  placeholder: string;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
  "aria-label"?: string;
  /** 칸의 이름이 되는 글의 id(`<label>`). 목록(listbox)도 같은 이름을 갖는다. */
  "aria-labelledby"?: string;
  /** 목록이 칸의 어느 쪽에 뜨는지. 칸 아래에 눌러야 할 단추가 있는 폼은 위로 둔다. 자리가 모자라면 Radix 가 뒤집는다. */
  side?: "top" | "bottom";
}) {
  const reactId = React.useId();
  const listId = `${reactId}-list`;
  const optionId = (index: number) => `${reactId}-opt-${index}`;
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const listRef = React.useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const enabled = (index: number) => !!options[index] && !options[index].disabled;

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) {
      if (enabled(i)) return i;
    }
    return from;
  };
  const edge = (dir: 1 | -1) => step(dir === 1 ? -1 : options.length, dir);

  const choose = (index: number) => {
    if (!enabled(index)) return;
    onValueChange(options[index].value);
    setOpen(false);
  };

  // 열릴 때 활성 항목: 고른 항목, 없으면 첫 활성 항목.
  const openList = () => {
    if (disabled) return;
    setActive(selectedIndex >= 0 && enabled(selectedIndex) ? selectedIndex : edge(1));
    setOpen(true);
  };

  // 열린 채 잠기면(저장 중·오프라인) 목록도 접는다. 잠긴 칸의 목록이 계속 눌리면 안 된다.
  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  React.useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((a) => step(a, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((a) => step(a, -1));
        break;
      case "Home":
        event.preventDefault();
        setActive(edge(1));
        break;
      case "End":
        event.preventDefault();
        setActive(edge(-1));
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(active);
        break;
      case "Tab":
        // 목록은 탭 순서 밖이다. 닫고 포커스가 단추로 돌아온 뒤 흐름이 이어진다.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) openList();
        else setOpen(false);
      }}
    >
      <PopoverTrigger asChild>
        <button
          {...rest}
          type="button"
          id={id}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          disabled={disabled}
          data-testid={testId}
          data-value={value}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              openList();
            }
          }}
          className={cn(
            "tap-target flex h-field w-full min-w-0 items-center gap-2 rounded-lg border border-line-strong bg-transparent pl-3 pr-2.5 text-left text-label press-instant-fill active:bg-surface-pressed focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate", selected ? "text-ink" : "text-ink-muted")}>
            {selected ? optionDisplay(selected) : placeholder}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-ink-muted transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        sideOffset={4}
        className="max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-lg p-1"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          listRef.current?.focus();
        }}
      >
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          onKeyDown={onListKeyDown}
          className="flex flex-col gap-px rounded-md outline-none focus-visible:focus-ring"
        >
          {options.map((option, index) => {
            const isSelected = index === selectedIndex;
            return (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                data-value={option.value}
                data-active={index === active ? "" : undefined}
                onPointerMove={() => {
                  if (enabled(index) && active !== index) setActive(index);
                }}
                onClick={() => choose(index)}
                className={cn(
                  "tap-target flex min-h-control cursor-default select-none items-center gap-2 rounded-md px-2 py-1 text-label text-ink press-instant-fill active:bg-surface-pressed",
                  index === active && "bg-surface-hover",
                  option.disabled && "pointer-events-none opacity-50"
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="break-keep">{option.label}</span>
                  {option.hint ? (
                    <span className="text-meta text-ink-muted">{option.hint}</span>
                  ) : null}
                </span>
                {isSelected ? (
                  <Check aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                ) : null}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
