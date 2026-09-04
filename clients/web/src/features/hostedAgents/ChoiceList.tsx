import { cn } from "@/design/lib/cn";

// =============================================================================
// 결과 문장을 상시 노출하는 선택 목록 — 라디오와 체크박스 한 벌.
//
// 형태는 `features/settings/SettingsFields.tsx` 의 `ChoiceRadios` 관용구 그대로다
// (테두리 하나 + 헤어라인 행, 줄마다 label + detail, fieldset/legend). 그것을
// import 하지 않고 여기 한 벌 두는 이유는 하나뿐이다: 이 표면이 필요로 하는 두
// 가지를 그 컴포넌트가 갖고 있지 않다.
//
//   1. **줄 단위 잠금과 사유.** `ChoiceRadios` 의 `disabled` 는 fieldset 통째이고
//      사유 채널은 그룹 `hint` 하나뿐이다. 이 화면은 "1:1 대화는 승인 대상이
//      아닙니다" 를 그 줄 옆에 적어야 한다(ADR-0162 승인은 사람의 결정이고,
//      고를 수 없는 이유가 다른 줄에 있으면 그것은 답이 아니다). 같은 요구를
//      `SelectField` 의 `SelectChoice.disabled` 와 `RoutingFields` 의
//      `*DisabledReason` 이 이미 각자 풀고 있고, 이것은 그 둘을 목록 형태로
//      합친 것이다.
//   2. **다중 선택.** 채널과 권한은 여러 개를 고르는 결정이라 라디오가 아니다.
//
// 두 형태를 한 컴포넌트에 둔 이유: 이 화면에 라디오 목록(인증 방식)과 체크박스
// 목록(채널·권한)이 함께 서고, 둘의 유일한 차이가 `type` 과 "몇 개를 들 수
// 있는가"이다. 형태가 갈리면 같은 화면의 두 목록이 서로 다른 여백과 서로 다른
// 잠금 표시를 갖게 된다.
//
// 잠긴 줄을 흐리게 만들지 않는 이유는 이 레포가 이미 정한 것이다(에이전트 허브의
// 오프라인 지시문 상자, design-review 2R High): 못 고르는 표시는 바탕이 지고,
// 글자는 읽을 수 있어야 한다. 사유가 안 읽히면 사유가 아니다.
// =============================================================================

export interface ChoiceListItem {
  id: string;
  label: string;
  /** 이 줄을 고르면 무슨 일이 생기는가, 또는 왜 고를 수 없는가. 상시 노출된다. */
  detail: string;
  /** 고를 수 없다. 숨기지 않고 세운다. */
  disabled?: boolean;
  /**
   * 켜져 있고 끌 수 없다. 잠긴 채로 체크된 줄이며, `detail` 이 왜인지 말한다.
   * 서버가 반드시 요구하는 권한이 이 자리다.
   */
  locked?: boolean;
}

export function ChoiceList({
  name,
  legend,
  hint,
  multiple,
  items,
  selected,
  onChange,
  disabled,
  testId,
}: {
  name: string;
  /** 그룹의 이름. 스크린리더가 두 목록을 두 그룹으로 읽게 한다. */
  legend: string;
  /** 그룹 전체에 걸리는 한 문장. 저장 상태나 잠금 사유. */
  hint?: string;
  multiple: boolean;
  items: readonly ChoiceListItem[];
  selected: readonly string[];
  /** 다음 선택 전체. 컴포넌트가 토글 규칙을 들고 호출부는 결과만 받는다. */
  onChange: (next: string[]) => void;
  /** 그룹 전체가 지금 조작 대상이 아니다(오프라인 등). */
  disabled?: boolean;
  testId?: string;
}) {
  const hintId = hint ? `${name}-hint` : undefined;

  function toggle(item: ChoiceListItem) {
    if (item.disabled || item.locked) return;
    if (!multiple) {
      onChange([item.id]);
      return;
    }
    const has = selected.includes(item.id);
    onChange(
      has ? selected.filter((id) => id !== item.id) : [...selected, item.id]
    );
  }

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-1"
      disabled={disabled}
      aria-describedby={hintId}
      data-testid={testId}
    >
      <legend className="pb-1 text-meta text-ink-muted">{legend}</legend>
      <div className="flex flex-col overflow-hidden rounded-md border border-line">
        {items.map((item) => {
          const checked = item.locked || selected.includes(item.id);
          const inert = Boolean(item.disabled) || Boolean(item.locked);
          const detailId = `${name}-${item.id}-detail`;
          return (
            <label
              key={item.id}
              htmlFor={`${name}-${item.id}`}
              className={cn(
                "flex min-w-0 items-start gap-2 border-b border-line p-2 last:border-b-0",
                item.disabled
                  ? "cursor-not-allowed bg-surface-hover"
                  : "cursor-pointer",
                !item.disabled && checked && "bg-accent-soft",
                !item.disabled && !checked && "press hover:bg-surface-hover"
              )}
              data-testid={`${name}-row`}
              data-choice-id={item.id}
              data-choice-disabled={item.disabled ? "" : undefined}
              data-choice-locked={item.locked ? "" : undefined}
            >
              <input
                type={multiple ? "checkbox" : "radio"}
                id={`${name}-${item.id}`}
                name={name}
                value={item.id}
                checked={checked}
                disabled={inert}
                aria-describedby={detailId}
                onChange={() => toggle(item)}
                className="mt-1 accent-accent focus-visible:focus-ring"
              />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="break-keep text-body text-ink">{item.label}</span>
                {/* 결과 문장은 hover 뒤가 아니라 언제나 여기 있다. */}
                <span id={detailId} className="break-keep text-meta text-ink-muted">
                  {item.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {/* live region 이 아니다. 이 문장은 그룹을 설명하며 처음부터 거기 있고 바뀌지
          않으므로, `role="status"` 는 알릴 것이 없는 자리에 폴라이트 announce 를
          하나 더 만들 뿐이다. 읽히는 길은 이미 `aria-describedby` 다. */}
      {hint && (
        <p id={hintId} className="break-keep text-meta text-ink-muted">
          {hint}
        </p>
      )}
    </fieldset>
  );
}
