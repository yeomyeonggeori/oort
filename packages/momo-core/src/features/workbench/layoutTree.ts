// =============================================================================
// 작업 공간 격자의 분할 트리 (#2773, ADR-0190 D5·D7, 제안서 §3.3 (3)·§3.4).
//
// 격자는 가로·세로 분할의 중첩 트리다. 잎은 칸(pane), 속 마디는 두 자식을 한
// 축으로 나누는 분할(split)이다. 이진 트리로 둔 것은 경계 하나가 정확히 한
// 비율을 움직이게 하기 위해서다. 같은 축으로 세 칸을 두면 분할이 두 번 겹친다.
//
// 이 파일은 순수 함수만 둔다. 화면 크기를 재는 일(ResizeObserver)과 저장은
// 호스트가 한다. 크기가 필요한 연산(분할 거부, 경계 끌기, 방향 이동)은 호스트가
// 잰 격자 크기를 인자로 받는다.
//
// 연산은 던지지 않는다. 거부는 `{ ok: false, reason }`으로 돌려주고, 호스트가
// 그 이유를 화면 문구로 옮긴다(토스트 금지, ADR-0182).
// =============================================================================

export type PaneId = string;

/**
 * `row`는 자식을 왼쪽에서 오른쪽으로 놓는다(경계가 세로선, 「오른쪽으로 분할」).
 * `column`은 위에서 아래로 놓는다(경계가 가로선, 「아래로 분할」).
 */
export type SplitAxis = "row" | "column";

export interface PaneNode {
  kind: "pane";
  id: PaneId;
}

export interface SplitNode {
  kind: "split";
  id: string;
  axis: SplitAxis;
  /** `first`가 차지하는 몫. 경계 두께를 뺀 길이에 곱한다. (0, 1) 사이. */
  ratio: number;
  /**
   * 더블클릭 두 단계 토글이 돌아갈 비율. 균등(½)이 아닌 비율에서 더블클릭하면
   * 그 비율을 여기 적고 ½로 간다. ½에서 더블클릭하면 여기 적힌 비율로 돌아간다.
   */
  restoreRatio?: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export interface WorkbenchLayout {
  v: 1;
  root: LayoutNode;
  focused: PaneId;
  /** 최대화된 칸. 최대화 중에도 다른 칸은 트리에 남는다(터미널을 끊지 않는다). */
  maximized: PaneId | null;
  /** 다음에 만들 칸·분할 번호. id를 결정적으로 만들어 시험과 저장이 안정된다. */
  seq: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Direction = "left" | "right" | "up" | "down";

/** 칸 사이 경계의 두께(px). 끌기 손잡이의 판정 폭이기도 하다. */
export const WORKBENCH_GUTTER = 8;

/**
 * 칸 최소 크기(px). 터미널 한 칸이 명령 한 줄과 프롬프트를 담을 수 있는 선이다.
 * 이보다 작아지는 분할은 거부하고, 경계 끌기는 여기서 멈춘다.
 */
export const WORKBENCH_MIN_PANE: Size = { width: 240, height: 120 };

/** 칸 수 상한. ⌃1..9 번호 이동과 저장 크기를 함께 묶는다. */
export const WORKBENCH_MAX_PANES = 16;

/** ½에서 더블클릭했는데 돌아갈 비율이 없을 때 가는 비율. 앞 칸을 크게 둔다. */
export const WORKBENCH_TOGGLE_FALLBACK_RATIO = 2 / 3;

/** 경계에 키보드 화살표 한 번이 움직이는 몫. */
export const WORKBENCH_NUDGE_STEP = 0.05;

const EQUAL_EPSILON = 0.005;

export interface LayoutMetrics {
  gutter: number;
  min: Size;
}

export const DEFAULT_METRICS: LayoutMetrics = {
  gutter: WORKBENCH_GUTTER,
  min: WORKBENCH_MIN_PANE,
};

export type LayoutRefusal =
  | "not-found"
  | "too-small"
  | "limit"
  | "last-pane"
  | "single-pane"
  | "edge";

export type LayoutResult =
  | { ok: true; layout: WorkbenchLayout }
  | { ok: false; reason: LayoutRefusal; layout: WorkbenchLayout };

function ok(layout: WorkbenchLayout): LayoutResult {
  return { ok: true, layout };
}

function refuse(layout: WorkbenchLayout, reason: LayoutRefusal): LayoutResult {
  return { ok: false, reason, layout };
}

// ---- 기본 배치와 탐색 --------------------------------------------------------

export function paneIdFor(n: number): PaneId {
  return `p${n}`;
}

export function splitIdFor(n: number): string {
  return `s${n}`;
}

/** 칸 하나짜리 배치. 저장이 없거나 읽지 못하면 이것으로 그린다. */
export function defaultWorkbenchLayout(): WorkbenchLayout {
  return { v: 1, root: { kind: "pane", id: paneIdFor(1) }, focused: paneIdFor(1), maximized: null, seq: 2 };
}

/** 칸 id를 트리 순서(왼쪽·위 먼저)로. 순환 이동과 ⌃1..9 번호의 순서다. */
export function paneIds(root: LayoutNode): PaneId[] {
  if (root.kind === "pane") return [root.id];
  return [...paneIds(root.first), ...paneIds(root.second)];
}

export function paneCount(root: LayoutNode): number {
  return root.kind === "pane" ? 1 : paneCount(root.first) + paneCount(root.second);
}

export function findSplit(root: LayoutNode, splitId: string): SplitNode | null {
  if (root.kind === "pane") return null;
  if (root.id === splitId) return root;
  return findSplit(root.first, splitId) ?? findSplit(root.second, splitId);
}

function hasPane(root: LayoutNode, id: PaneId): boolean {
  if (root.kind === "pane") return root.id === id;
  return hasPane(root.first, id) || hasPane(root.second, id);
}

/** `mapNode`는 바뀐 가지만 새로 만들고 나머지는 참조를 그대로 둔다. */
function mapNode(
  node: LayoutNode,
  visit: (node: LayoutNode) => LayoutNode | undefined
): LayoutNode {
  const replaced = visit(node);
  if (replaced !== undefined) return replaced;
  if (node.kind === "pane") return node;
  const first = mapNode(node.first, visit);
  const second = mapNode(node.second, visit);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

// ---- 기하 --------------------------------------------------------------------

function axisLength(size: Size, axis: SplitAxis): number {
  return axis === "row" ? size.width : size.height;
}

/** 부분 트리가 받아들일 수 있는 가장 작은 상자. 경계 끌기의 한계다. */
export function minimumSize(node: LayoutNode, metrics: LayoutMetrics = DEFAULT_METRICS): Size {
  if (node.kind === "pane") return { ...metrics.min };
  const a = minimumSize(node.first, metrics);
  const b = minimumSize(node.second, metrics);
  if (node.axis === "row") {
    return { width: a.width + metrics.gutter + b.width, height: Math.max(a.height, b.height) };
  }
  return { width: Math.max(a.width, b.width), height: a.height + metrics.gutter + b.height };
}

export interface LayoutGeometry {
  panes: Map<PaneId, Rect>;
  /** 분할 마디의 상자(경계를 포함한 두 자식 전체). */
  splits: Map<string, Rect>;
}

/** 격자 크기를 받아 칸과 분할의 상자를 계산한다. 최대화는 무시한다. */
export function computeGeometry(
  root: LayoutNode,
  size: Size,
  metrics: LayoutMetrics = DEFAULT_METRICS
): LayoutGeometry {
  const panes = new Map<PaneId, Rect>();
  const splits = new Map<string, Rect>();
  const walk = (node: LayoutNode, rect: Rect) => {
    if (node.kind === "pane") {
      panes.set(node.id, rect);
      return;
    }
    splits.set(node.id, rect);
    const total = axisLength(rect, node.axis);
    const available = Math.max(0, total - metrics.gutter);
    const firstLength = available * node.ratio;
    const secondLength = available - firstLength;
    if (node.axis === "row") {
      walk(node.first, { x: rect.x, y: rect.y, width: firstLength, height: rect.height });
      walk(node.second, {
        x: rect.x + firstLength + metrics.gutter,
        y: rect.y,
        width: secondLength,
        height: rect.height,
      });
    } else {
      walk(node.first, { x: rect.x, y: rect.y, width: rect.width, height: firstLength });
      walk(node.second, {
        x: rect.x,
        y: rect.y + firstLength + metrics.gutter,
        width: rect.width,
        height: secondLength,
      });
    }
  };
  walk(root, { x: 0, y: 0, width: size.width, height: size.height });
  return { panes, splits };
}

// ---- 분할 --------------------------------------------------------------------

/** 이 칸을 이 축으로 나눌 수 있는가. 두 칸 모두 최소 크기 이상이어야 한다. */
export function canSplitPane(
  layout: WorkbenchLayout,
  paneId: PaneId,
  axis: SplitAxis,
  size: Size,
  metrics: LayoutMetrics = DEFAULT_METRICS
): LayoutResult {
  const rect = computeGeometry(layout.root, size, metrics).panes.get(paneId);
  if (rect === undefined) return refuse(layout, "not-found");
  if (paneCount(layout.root) >= WORKBENCH_MAX_PANES) return refuse(layout, "limit");
  const half = (axisLength(rect, axis) - metrics.gutter) / 2;
  const minimum = axisLength(metrics.min, axis);
  if (half < minimum) return refuse(layout, "too-small");
  return ok(layout);
}

/**
 * 칸을 둘로 나눈다. 원래 칸이 앞(왼쪽·위)에 남고 새 칸이 뒤에 생기며, 포커스는
 * 새 칸으로 간다. 최대화 중이면 최대화를 풀고 나눈다(새 칸이 보여야 한다).
 */
export function splitPane(
  layout: WorkbenchLayout,
  paneId: PaneId,
  axis: SplitAxis,
  size: Size,
  metrics: LayoutMetrics = DEFAULT_METRICS
): LayoutResult {
  const check = canSplitPane(layout, paneId, axis, size, metrics);
  if (!check.ok) return check;
  const newPane: PaneNode = { kind: "pane", id: paneIdFor(layout.seq) };
  const split: SplitNode = {
    kind: "split",
    id: splitIdFor(layout.seq),
    axis,
    ratio: 0.5,
    first: { kind: "pane", id: paneId },
    second: newPane,
  };
  const root = mapNode(layout.root, (node) =>
    node.kind === "pane" && node.id === paneId ? split : undefined
  );
  return ok({ ...layout, root, focused: newPane.id, maximized: null, seq: layout.seq + 1 });
}

// ---- 닫기 --------------------------------------------------------------------

function firstLeaf(node: LayoutNode): PaneId {
  return node.kind === "pane" ? node.id : firstLeaf(node.first);
}

function lastLeaf(node: LayoutNode): PaneId {
  return node.kind === "pane" ? node.id : lastLeaf(node.second);
}

/**
 * 칸을 닫는다. 형제 가지가 부모 분할의 자리를 이어받는다. 닫힌 칸에 포커스가
 * 있었으면 형제 가지에서 닫힌 칸과 맞닿아 있던 칸으로 간다. 마지막 칸은 닫지
 * 않는다(`last-pane`). 그때 무엇을 할지(세션 닫기 등)는 호스트가 정한다.
 */
export function closePane(layout: WorkbenchLayout, paneId: PaneId): LayoutResult {
  if (!hasPane(layout.root, paneId)) return refuse(layout, "not-found");
  if (layout.root.kind === "pane") return refuse(layout, "last-pane");
  let heir: PaneId | null = null;
  const root = mapNode(layout.root, (node) => {
    if (node.kind !== "split") return undefined;
    if (node.first.kind === "pane" && node.first.id === paneId) {
      heir = firstLeaf(node.second);
      return node.second;
    }
    if (node.second.kind === "pane" && node.second.id === paneId) {
      heir = lastLeaf(node.first);
      return node.first;
    }
    return undefined;
  });
  const focused = layout.focused === paneId ? (heir ?? firstLeaf(root)) : layout.focused;
  const maximized = layout.maximized === paneId ? null : layout.maximized;
  return ok({ ...layout, root, focused, maximized });
}

// ---- 경계 크기 ----------------------------------------------------------------

/**
 * 분할 비율이 가질 수 있는 범위. 양쪽 부분 트리가 최소 크기 아래로 내려가지
 * 않는 구간이다. 격자가 이미 너무 작아 구간이 비면 `null`.
 */
export function ratioBounds(
  layout: WorkbenchLayout,
  splitId: string,
  size: Size,
  metrics: LayoutMetrics = DEFAULT_METRICS
): { min: number; max: number } | null {
  const split = findSplit(layout.root, splitId);
  const rect = computeGeometry(layout.root, size, metrics).splits.get(splitId);
  if (split === null || rect === undefined) return null;
  const available = axisLength(rect, split.axis) - metrics.gutter;
  if (available <= 0) return null;
  const min = axisLength(minimumSize(split.first, metrics), split.axis) / available;
  const max = 1 - axisLength(minimumSize(split.second, metrics), split.axis) / available;
  if (min > max) return null;
  return { min, max };
}

function setSplit(
  layout: WorkbenchLayout,
  splitId: string,
  patch: (split: SplitNode) => SplitNode
): WorkbenchLayout {
  const root = mapNode(layout.root, (node) =>
    node.kind === "split" && node.id === splitId ? patch(node) : undefined
  );
  return root === layout.root ? layout : { ...layout, root };
}

/**
 * 경계를 끌어 비율을 바꾼다. 요청한 비율은 양쪽 최소 크기 안으로 잘린다.
 * 격자가 이미 최소보다 작으면(창을 줄인 경우) 비율을 바꾸지 않고 `too-small`.
 */
export function resizeSplit(
  layout: WorkbenchLayout,
  splitId: string,
  ratio: number,
  size: Size,
  metrics: LayoutMetrics = DEFAULT_METRICS
): LayoutResult {
  if (findSplit(layout.root, splitId) === null) return refuse(layout, "not-found");
  const bounds = ratioBounds(layout, splitId, size, metrics);
  if (bounds === null) return refuse(layout, "too-small");
  if (!Number.isFinite(ratio)) return refuse(layout, "not-found");
  const clamped = Math.min(bounds.max, Math.max(bounds.min, ratio));
  return ok(setSplit(layout, splitId, (split) => ({ ...split, ratio: clamped })));
}

/** 키보드로 경계를 한 걸음 옮긴다(분리자 역할의 화살표 키). */
export function nudgeSplit(
  layout: WorkbenchLayout,
  splitId: string,
  delta: number,
  size: Size,
  metrics: LayoutMetrics = DEFAULT_METRICS
): LayoutResult {
  const split = findSplit(layout.root, splitId);
  if (split === null) return refuse(layout, "not-found");
  return resizeSplit(layout, splitId, split.ratio + delta, size, metrics);
}

export function isEqualRatio(ratio: number): boolean {
  return Math.abs(ratio - 0.5) <= EQUAL_EPSILON;
}

/**
 * 경계 더블클릭, 두 단계 토글.
 * - 균등이 아니면: 지금 비율을 `restoreRatio`에 적고 균등(½)으로 간다.
 * - 균등이면: `restoreRatio`로 돌아간다. 없으면 앞 칸을 ⅔로 키운다.
 * 어느 쪽이든 양쪽 최소 크기 안으로 잘린다. 계속 누르면 두 상태를 오간다.
 */
export function toggleSplitRatio(
  layout: WorkbenchLayout,
  splitId: string,
  size: Size,
  metrics: LayoutMetrics = DEFAULT_METRICS
): LayoutResult {
  const split = findSplit(layout.root, splitId);
  if (split === null) return refuse(layout, "not-found");
  if (!isEqualRatio(split.ratio)) {
    const remembered = setSplit(layout, splitId, (node) => ({ ...node, restoreRatio: node.ratio }));
    return resizeSplit(remembered, splitId, 0.5, size, metrics);
  }
  const target = split.restoreRatio ?? WORKBENCH_TOGGLE_FALLBACK_RATIO;
  return resizeSplit(layout, splitId, target, size, metrics);
}

// ---- 최대화 ------------------------------------------------------------------

/**
 * 칸 최대화 토글(⌘⇧↵). 다른 칸은 트리에 그대로 남는다. 칸이 하나면 할 일이
 * 없으므로 `single-pane`.
 */
export function toggleMaximize(layout: WorkbenchLayout, paneId: PaneId = layout.focused): LayoutResult {
  if (!hasPane(layout.root, paneId)) return refuse(layout, "not-found");
  if (layout.maximized === paneId) return ok({ ...layout, maximized: null });
  if (layout.root.kind === "pane") return refuse(layout, "single-pane");
  return ok({ ...layout, maximized: paneId, focused: paneId });
}

// ---- 포커스 ------------------------------------------------------------------
//
// 최대화 중에 포커스가 다른 칸으로 가면 최대화를 푼다. 가려진 칸에 포커스를
// 두면 사람이 입력할 곳을 볼 수 없다(iTerm2와 같은 선택).

function withFocus(layout: WorkbenchLayout, paneId: PaneId): WorkbenchLayout {
  if (layout.focused === paneId && (layout.maximized === null || layout.maximized === paneId)) {
    return layout;
  }
  const maximized = layout.maximized === paneId ? layout.maximized : null;
  return { ...layout, focused: paneId, maximized };
}

export function focusPane(layout: WorkbenchLayout, paneId: PaneId): LayoutResult {
  if (!hasPane(layout.root, paneId)) return refuse(layout, "not-found");
  return ok(withFocus(layout, paneId));
}

/** ⌘] / ⌘[ 순환. 트리 순서로 돌고 끝에서 처음으로 감긴다. */
export function focusCycle(layout: WorkbenchLayout, delta: 1 | -1): LayoutResult {
  const ids = paneIds(layout.root);
  if (ids.length < 2) return refuse(layout, "single-pane");
  const at = Math.max(0, ids.indexOf(layout.focused));
  const next = ids[(at + delta + ids.length) % ids.length]!;
  return ok(withFocus(layout, next));
}

/** ⌃1..9. `index`는 1부터 센다. 없는 번호는 `not-found`. */
export function focusIndex(layout: WorkbenchLayout, index: number): LayoutResult {
  const id = paneIds(layout.root)[index - 1];
  if (id === undefined) return refuse(layout, "not-found");
  return ok(withFocus(layout, id));
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

/**
 * ⌘⌥화살표 방향 이동. 최대화를 무시한 실제 배치에서 고른다.
 * 1. 그 방향에 있고(현재 칸의 해당 변을 넘지 않음) 수직축으로 겹치는 칸만 후보.
 * 2. 가장 가까운 칸(변 사이 거리).
 * 3. 같으면 현재 칸과 수직축으로 가장 많이 겹치는 칸.
 * 4. 그래도 같으면 트리 순서가 앞선 칸.
 * 가장자리에서는 감기지 않는다(`edge`). 감기는 이동은 순환 키가 맡는다.
 */
export function focusDirection(
  layout: WorkbenchLayout,
  direction: Direction,
  size: Size,
  metrics: LayoutMetrics = DEFAULT_METRICS
): LayoutResult {
  const { panes } = computeGeometry(layout.root, size, metrics);
  const from = panes.get(layout.focused);
  if (from === undefined) return refuse(layout, "not-found");
  const slack = 0.5;
  let best: { id: PaneId; distance: number; shared: number } | null = null;
  for (const id of paneIds(layout.root)) {
    if (id === layout.focused) continue;
    const to = panes.get(id)!;
    let distance: number;
    let shared: number;
    switch (direction) {
      case "right":
        distance = to.x - (from.x + from.width);
        shared = overlap(from.y, from.y + from.height, to.y, to.y + to.height);
        break;
      case "left":
        distance = from.x - (to.x + to.width);
        shared = overlap(from.y, from.y + from.height, to.y, to.y + to.height);
        break;
      case "down":
        distance = to.y - (from.y + from.height);
        shared = overlap(from.x, from.x + from.width, to.x, to.x + to.width);
        break;
      case "up":
        distance = from.y - (to.y + to.height);
        shared = overlap(from.x, from.x + from.width, to.x, to.x + to.width);
        break;
    }
    if (distance < -slack || shared <= slack) continue;
    if (
      best === null ||
      distance < best.distance - slack ||
      (Math.abs(distance - best.distance) <= slack && shared > best.shared + slack)
    ) {
      best = { id, distance, shared };
    }
  }
  if (best === null) return refuse(layout, "edge");
  return ok(withFocus(layout, best.id));
}

// ---- 보이는 크기에 맞추기 (#2774) ------------------------------------------------

/**
 * 격자를 그릴 때 쓰는 배치. 저장된 배치를 바꾸지 않고, 지금 크기에서 칸이 최소
 * 크기 아래로 내려가지 않게 한다.
 *
 * - 분할마다 위에서부터 비율을 양쪽 최소 크기 안으로 자른다. 도크나 창이 줄어도
 *   중첩 분할(½·¼·¼)의 작은 칸이 먼저 짜부라지지 않는다. 크기가 다시 커지면
 *   저장된 비율로 돌아간다.
 * - 격자 전체가 배치의 최소 크기보다 작으면(`cramped`) 비율로는 풀 수 없다.
 *   그때는 포커스 칸만 보이게 최대화한 것처럼 그린다. 칸이 잘려 머리나 상태
 *   줄이 가려지는 대신, 한 칸이 온전히 보이고 나머지는 DOM에 남는다.
 * - 크기를 모르면(0) 그대로 둔다.
 */
export function fitLayoutToSize(
  layout: WorkbenchLayout,
  size: Size,
  metrics: LayoutMetrics = DEFAULT_METRICS
): { layout: WorkbenchLayout; cramped: boolean } {
  if (!(size.width > 0 && size.height > 0) || layout.root.kind === "pane") {
    return { layout, cramped: false };
  }
  const need = minimumSize(layout.root, metrics);
  if (size.width < need.width || size.height < need.height) {
    if (layout.maximized !== null) return { layout, cramped: true };
    return { layout: { ...layout, maximized: layout.focused }, cramped: true };
  }
  let changed = false;
  const fit = (node: LayoutNode, box: Size): LayoutNode => {
    if (node.kind === "pane") return node;
    const available = axisLength(box, node.axis) - metrics.gutter;
    let ratio = node.ratio;
    if (available > 0) {
      const lo = axisLength(minimumSize(node.first, metrics), node.axis) / available;
      const hi = 1 - axisLength(minimumSize(node.second, metrics), node.axis) / available;
      if (lo <= hi) ratio = Math.min(hi, Math.max(lo, ratio));
    }
    const firstLen = Math.max(0, available) * ratio;
    const secondLen = Math.max(0, available) - firstLen;
    const firstBox = node.axis === "row" ? { width: firstLen, height: box.height } : { width: box.width, height: firstLen };
    const secondBox = node.axis === "row" ? { width: secondLen, height: box.height } : { width: box.width, height: secondLen };
    const first = fit(node.first, firstBox);
    const second = fit(node.second, secondBox);
    if (ratio === node.ratio && first === node.first && second === node.second) return node;
    changed = true;
    return { ...node, ratio, first, second };
  };
  const root = fit(layout.root, size);
  return { layout: changed ? { ...layout, root } : layout, cramped: false };
}
