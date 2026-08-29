/**
 * 포커스 모달리티 스탬프 (#1866).
 *
 * 텍스트 입력은 클릭에도 `:focus-visible` 이 매치된다(키보드 입력 요소 특례).
 * 컴포저 그릇이 그 셀렉터만 보면 마우스 포커스에서 인셋 accent 링이 보더를 덮는다.
 * Tab 키에서만 `keyboard`, 포인터에서 `pointer` 를 루트에 찍어 그릇 링을 가른다.
 * 컨트롤 프리미티브의 `focus-visible:focus-ring` 은 이 스탬프를 읽지 않는다.
 *
 * vitest 는 node 환경이라 `Document` 를 통째로 요구하지 않는다 — `theme.ts` 와
 * 같은 구조적 타입이면 가짜 문서로 스탬프 규칙을 잴 수 있다.
 */

export const FOCUS_MODALITY_ATTRIBUTE = "data-focus-modality";

export type FocusModality = "keyboard" | "pointer";

interface ModalityRoot {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

interface ModalityDocument {
  documentElement: ModalityRoot;
  addEventListener(
    type: string,
    listener: EventListener,
    options?: boolean
  ): void;
  removeEventListener(
    type: string,
    listener: EventListener,
    options?: boolean
  ): void;
}

export function applyFocusModality(
  doc: ModalityDocument,
  modality: FocusModality
): void {
  doc.documentElement.setAttribute(FOCUS_MODALITY_ATTRIBUTE, modality);
}

export function initFocusModality(doc: ModalityDocument): () => void {
  applyFocusModality(doc, "pointer");
  const onKeyDown = (event: Event) => {
    if (!("key" in event) || (event as KeyboardEvent).key !== "Tab") return;
    applyFocusModality(doc, "keyboard");
  };
  const onPointerDown = () => applyFocusModality(doc, "pointer");
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("pointerdown", onPointerDown, true);
  };
}
