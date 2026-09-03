/** Imperative focus. Isolated so tests spy on the call, not Fabric `autoFocus`. */
export function focusTextInput(
  field: {focus: () => void} | null | undefined,
): void {
  field?.focus();
}
