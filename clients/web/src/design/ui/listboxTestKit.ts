import { act } from "react";

// 앱이 그린 선택 칸(`ListboxSelect`)을 시험에서 조작하는 짝. 네이티브 `<select>` 의
// `selectOption`/`change` 를 대신한다. Radix 팝오버는 단추 click 으로 열리고, 항목은
// click 으로 고른다(실제 사용자와 같은 길).

const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');

export function listboxOptions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

export function openListbox(trigger: HTMLElement | null): void {
  if (!trigger) throw new Error("listbox trigger is missing");
  if (listbox()) return;
  act(() => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** 칸을 열고 `value` 항목을 고른다. 항목이 없으면 던진다(조용한 통과 금지). */
export function chooseListbox(trigger: HTMLElement | null, value: string): void {
  openListbox(trigger);
  const option = listboxOptions().find((o) => o.dataset.value === value);
  if (!option) throw new Error(`listbox option "${value}" is missing; have ${JSON.stringify(listboxOptions().map((o) => o.dataset.value))}; open=${trigger?.getAttribute("aria-expanded")} disabled=${trigger?.hasAttribute("disabled")}`);
  act(() => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export type ListboxChoice = { value: string; label: string; disabled: boolean };

/** 칸을 열어 항목을 읽고 닫는다(Esc). 네이티브 `select.options` 읽기의 짝. */
export function listboxChoices(trigger: HTMLElement | null): ListboxChoice[] {
  openListbox(trigger);
  const choices = listboxOptions().map((o) => ({
    value: o.dataset.value ?? "",
    label: o.textContent ?? "",
    disabled: o.getAttribute("aria-disabled") === "true",
  }));
  act(() => {
    listbox()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  return choices;
}

/** 지금 고른 값(`select.value` 의 짝). */
export function listboxValue(trigger: HTMLElement | null): string {
  return trigger?.dataset.value ?? "";
}

/** 단추에 보이는 글(`select.selectedOptions[0].textContent` 의 짝). */
export function listboxShown(trigger: HTMLElement | null): string {
  return trigger?.textContent ?? "";
}
