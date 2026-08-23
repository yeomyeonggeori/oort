/** A selected message belongs to the browser's native context menu. */
export function selectionIsWithinRow(
  root: Pick<HTMLElement, "contains"> | null,
  selection: Pick<Selection, "isCollapsed" | "anchorNode" | "focusNode"> | null
): boolean {
  if (root === null || selection === null || selection.isCollapsed) return false;
  return (
    (selection.anchorNode !== null && root.contains(selection.anchorNode)) ||
    (selection.focusNode !== null && root.contains(selection.focusNode))
  );
}
