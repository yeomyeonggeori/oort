/**
 * 포커스 모달리티 스탬프 (#1866).
 *
 * 텍스트 입력은 클릭에도 `:focus-visible` 이 매치된다(키보드 입력 요소 특례).
 * 컴포저 그릇이 그 셀렉터만 보면 마우스 포커스에서 인셋 accent 링이 보더를 덮는다.
 * 캐럿을 옮기는 키(Tab 등, 아래)에서 `keyboard`, 포인터에서 `pointer` 를 루트에 찍어
 * 그릇 링을 가른다.
 *
 * #2938 ②: 컨트롤의 링도 이 스탬프를 읽는다(tokens.css 「포인터 모달리티」). 두
 * 엔진(Chromium·WebKit)은 포커스가 있는 채로 **아무 키**나 눌리면 그 요소를
 * `:focus-visible` 로 친다 — 마우스로 쓰던 사람이 Esc 로 설정을 닫거나 ⌘ 를 눌러도
 * 링이 섰다(제품 빌드 실측). 그래서 keyboard 로 올리는 키는 **캐럿을 옮기는 키**뿐이다:
 * Tab, 그리고 글 입력 칸 밖의 화살표·Home·End·PageUp·PageDown. 수정 키와 함께 누른
 * 단축키, Esc·Enter·Space, 글자는 올리지 않는다.
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

/** 글 입력 칸 밖에서 캐럿을 옮기는 키. 글 입력 칸 안에서는 글자 사이를 옮긴다. */
const NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageDown",
  "PageUp",
]);

/** 누르면 포커스가 아니라 글 사이 캐럿이 움직이는 input 종류가 아닌 것. */
const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image",
]);

function isTextEntry(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !NON_TEXT_INPUT_TYPES.has(typeof el.type === "string" ? el.type : "text");
}

/** 이 키 누름이 키보드 탐색인가(#2938 ②). */
export function isKeyboardNavigation(event: KeyboardEvent): boolean {
  if (event.key === "Tab") return true;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (!NAVIGATION_KEYS.has(event.key)) return false;
  return !isTextEntry(event.target);
}

export function initFocusModality(doc: ModalityDocument): () => void {
  applyFocusModality(doc, "pointer");
  const onKeyDown = (event: Event) => {
    if (!("key" in event)) return;
    if (!isKeyboardNavigation(event as KeyboardEvent)) return;
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
