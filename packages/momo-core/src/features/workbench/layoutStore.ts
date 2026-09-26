// =============================================================================
// 격자 배치의 저장 형식 (#2773). 배치는 세션(worktree)마다 이 기기에 둔다
// (ADR-0174 「외양=이 기기」, ADR-0190 D5, 제안서 §2.2 Orca 「칸 배치는
// worktree마다 저장」).
//
// `appearance.ts`와 같은 모양이다. 이 파일은 저장소를 만지지 않는다. 호스트가
// 키로 읽은 원문을 넘기면 배치를 돌려주고, 쓸 문자열을 만들어 준다. 웹은
// `localStorage`가 그 원문을 들고 있다.
//
// 모르는 값, 깨진 값, 다른 버전이 쓴 값은 `null`로 읽는다. 호스트는 그때 기본
// 배치(칸 하나)를 그린다. 저장이 화면을 잠글 이유가 되지 않는다.
// =============================================================================

import {
  WORKBENCH_MAX_PANES,
  type LayoutNode,
  type PaneId,
  type WorkbenchLayout,
} from "./layoutTree";

/**
 * 저장소 항목 이름의 앞부분. 뒤에 세션 키(worktree 경로 등)가 붙는다.
 * 접미사가 `_KEY`가 아닌 것은 비밀 스캐너가 `…_KEY = "…"`를 자격증명으로 읽기
 * 때문이다(appearance.ts와 같은 이유).
 */
export const WORKBENCH_LAYOUT_ENTRY_PREFIX = "momo.web.workbench.layout.v1:";

/** 세션 키가 비어 있을 때 쓰는 이름. 세션 밖의 격자(하네스 등)가 여기 간다. */
export const WORKBENCH_DEFAULT_SESSION = "default";

export function workbenchLayoutEntry(sessionKey: string): string {
  const key = sessionKey.trim();
  return WORKBENCH_LAYOUT_ENTRY_PREFIX + (key === "" ? WORKBENCH_DEFAULT_SESSION : key);
}

export function serializeWorkbenchLayout(layout: WorkbenchLayout): string {
  return JSON.stringify(layout);
}

/** 트리 깊이 상한. 칸 16개는 균형이 가장 나빠도 깊이 15를 넘지 않는다. */
const MAX_DEPTH = WORKBENCH_MAX_PANES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function parseNode(
  value: unknown,
  depth: number,
  seen: Set<string>
): LayoutNode | null {
  if (!isRecord(value) || depth > MAX_DEPTH) return null;
  if (value.kind === "pane") {
    if (!isId(value.id) || seen.has(value.id)) return null;
    seen.add(value.id);
    return { kind: "pane", id: value.id };
  }
  if (value.kind !== "split") return null;
  if (!isId(value.id) || seen.has(value.id)) return null;
  if (value.axis !== "row" && value.axis !== "column") return null;
  if (!isRatio(value.ratio)) return null;
  if (value.restoreRatio !== undefined && !isRatio(value.restoreRatio)) return null;
  seen.add(value.id);
  const first = parseNode(value.first, depth + 1, seen);
  if (first === null) return null;
  const second = parseNode(value.second, depth + 1, seen);
  if (second === null) return null;
  return {
    kind: "split",
    id: value.id,
    axis: value.axis,
    ratio: value.ratio,
    ...(value.restoreRatio !== undefined ? { restoreRatio: value.restoreRatio } : {}),
    first,
    second,
  };
}

function highestSerial(node: LayoutNode): number {
  const own = /^[ps](\d{1,6})$/.exec(node.id);
  const mine = own === null ? 0 : Number(own[1]);
  if (node.kind === "pane") return mine;
  return Math.max(mine, highestSerial(node.first), highestSerial(node.second));
}

function collectPanes(node: LayoutNode, out: PaneId[] = []): PaneId[] {
  if (node.kind === "pane") out.push(node.id);
  else {
    collectPanes(node.first, out);
    collectPanes(node.second, out);
  }
  return out;
}

/**
 * 저장된 원문을 배치로 읽는다. 다음 중 하나라도 어긋나면 `null`이다.
 * - JSON이 아님, `v`가 1이 아님
 * - 마디 모양이 틀림, id가 겹침, 비율이 (0, 1) 밖, 깊이·칸 수 상한 초과
 * - 포커스 칸이 트리에 없음, 최대화 칸이 트리에 없음
 * - `seq`가 양의 정수가 아님
 */
export function parseWorkbenchLayout(raw: string | null | undefined): WorkbenchLayout | null {
  if (typeof raw !== "string" || raw === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1) return null;
  const root = parseNode(value.root, 0, new Set());
  if (root === null) return null;
  const panes = collectPanes(root);
  if (panes.length > WORKBENCH_MAX_PANES) return null;
  if (!isId(value.focused) || !panes.includes(value.focused)) return null;
  const maximized = value.maximized ?? null;
  if (maximized !== null && (!isId(maximized) || !panes.includes(maximized))) return null;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) return null;
  // 손으로 고친 값이나 옛 값이 `seq`를 뒤로 돌려 두었어도 새 id가 기존 id와
  // 겹치지 않게, 쓰인 번호보다 크게 올린다.
  const seq = Math.max(value.seq, highestSerial(root) + 1);
  // 칸이 하나뿐이면 최대화는 뜻이 없다. 풀어 둔다.
  return { v: 1, root, focused: value.focused, maximized: root.kind === "pane" ? null : maximized, seq };
}
