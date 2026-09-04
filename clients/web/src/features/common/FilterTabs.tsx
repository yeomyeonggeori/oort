import { useCallback, useRef } from "react";
import { cn } from "@/design/lib/cn";
import type { FilterTabsSpec } from "@momo/core/features/common/filterTabs";

// =============================================================================
// N개의 값 중 하나를 고르는 세그먼트 컨트롤 (R-1 §2).
//
// Hand-built rather than a primitive: @radix-ui/react-tabs is not a dependency
// of this client and P1 wave2 adds no packages, so this implements the WAI-ARIA
// tabs pattern directly (roving tabindex, aria-selected, ←/→ traversal) and the
// route owns the panel it controls.
//
// 인박스의 세 필터를 위해 지어졌고, 작업 흐름의 다섯 필터가 두 번째 호출자다.
// 두 번째 표면이 이걸 쓰지 않고 role="group" + aria-pressed 버튼을 손으로 다시
// 만들었을 때 실제로 잃은 것: 탭 정거장이 1개가 아니라 5개가 되고, ←/→ 이동이
// 없어지고, 선택 알약이 그 표면의 상태칩과 같은 배지가 됐다(MOMO-677 1R H2).
// 그래서 값의 집합·이름·id 규칙만 호출자의 spec으로 빼고 키보드 계약과 기하는
// 이 파일 한 곳에 남긴다. 두 번째 구현이 아니라 두 번째 호출자여야 한다.
//
// 값을 열거하지 않고 제네릭으로 받는 이유: 필터 값은 서버의 어휘이고
// (`?filter=`, `?status=`), 그 어휘를 이 컴포넌트가 알면 표면이 하나 늘 때마다
// 여기를 고쳐야 한다. 그래서 inbox/ 가 아니라 common/ 에 산다.
// =============================================================================

export type { FilterTabsSpec } from "@momo/core/features/common/filterTabs";

const BASE =
  "inline-flex h-control-sm items-center gap-2 rounded-sm px-3 text-body press focus-visible:focus-ring";

export function FilterTabs<T extends string>({
  spec,
  value,
  onChange,
  counts,
}: {
  spec: FilterTabsSpec<T>;
  value: T;
  onChange: (value: T) => void;
  /** Rendered only where a server projection actually supplies a number. */
  counts?: Partial<Record<T, number>>;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const index = spec.values.indexOf(value);
      const next =
        spec.values[(index + step + spec.values.length) % spec.values.length];
      onChange(next);
      listRef.current
        ?.querySelector<HTMLElement>(`#${spec.tabId(next)}`)
        ?.focus();
    },
    [spec, value, onChange]
  );

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={spec.label}
      onKeyDown={onKeyDown}
      // flex-wrap은 다섯 값을 받으면서 붙었다: 세 개는 어느 판에서도 한 줄에
      // 들어가지만 다섯 개는 좁은 판에서 문서를 옆으로 밀 수 있고, 이 셸에서
      // 가로 스크롤을 만드는 표면은 없다(MOMO-610). 세 개짜리 호출자에서는
      // 렌더가 바뀌지 않는다.
      className="flex min-w-0 flex-wrap items-center gap-1"
    >
      {spec.values.map((filter) => {
        const selected = filter === value;
        const count = counts?.[filter] ?? 0;
        return (
          <button
            key={filter}
            type="button"
            role="tab"
            id={spec.tabId(filter)}
            // 선택된 탭만 자기 패널을 가리킨다. 이 위젯의 호출자는 활성 패널
            // 하나만 렌더하므로(인박스도 작업 흐름도 그렇다) 비활성 탭의
            // `aria-controls`는 문서에 없는 id를 가리키는 참조였다: 따라가면
            // 아무 데도 가지 않고, 검사 도구에는 깨진 참조로 잡힌다. 워크스트림만
            // 고치면 형제 표면과 갈라지므로, 두 호출자가 공유하는 이 컨트롤에서
            // 한 번 고친다(PR 918 R1 "함께 볼 것"). 관계를 아예 지우지 않고 선택된
            // 탭에만 두는 이유는 그 하나가 지금 실제로 화면에 있는 관계이기
            // 때문이고, 같은 형태를 이 레포가 이미 두 곳에서 쓴다
            // (WorkPanel의 peek, WorkSessionDetail의 발췌 폼).
            {...(selected ? { "aria-controls": spec.panelId(filter) } : {})}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-testid={spec.testId(filter)}
            onClick={() => onChange(filter)}
            className={cn(
              BASE,
              selected
                ? "bg-accent-soft font-medium text-ink active:bg-surface-pressed"
                : "text-ink-muted hover:bg-surface-hover"
            )}
          >
            {spec.labelFor(filter)}
            {count > 0 && (
              <span className="text-timestamp text-ink-muted" data-numeric>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
