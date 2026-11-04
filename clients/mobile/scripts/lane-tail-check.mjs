#!/usr/bin/env node
// =============================================================================
// clients/mobile/scripts/lane-tail-check.mjs — 「마지막 행이 목록 창 아래 끝에서 잘렸는가」를 숫자로 잰다 (#5310)
//
// Maestro 의 `assertVisible` 은 잘린 행도 「보인다」고 센다(경계가 화면에 걸치면 된다) — 그래서 흐름만으로는 이 결함(검증 5a·5b: 자동 재전송된 마지막 행이 입력창 위 목록 끝에서 17~20pt
// 잘린 채 서 있다)이 붉어지지 않는다. `maestro hierarchy` 가 주는 경계(iOS 는 pt)는 **자르지 않은** 프레임이라, 마지막 `message-row` 의 아래 끝이 `timeline-list` 의 아래 끝을 넘은
// 만큼이 곧 잘린 양이다.
//
//   maestro --udid <UDID> hierarchy > hier.json
//   node scripts/lane-tail-check.mjs hier.json          # 또는 표준입력
//
// 출력: {"cutPt": <잘린 양>, "listBottom": …, "lastRowBottom": …, "lastRow": "<행 이름>"}. 잘린 양이 `--max`(기본 0.5pt)를 넘으면 종료 코드 1, 목록이나 행을 못 찾으면 2.
// 한계: 행의 **프레임**이 그린 모양보다 작은(콘텐츠 크기가 모자란) 결함은 못 본다 — 그 경우는 사진으로 본다.
// =============================================================================
import {readFileSync} from 'node:fs';

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

function argOf(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const file = process.argv.slice(2).find(arg => !arg.startsWith('--') && arg !== argOf('max'));
const raw = readFileSync(file ?? 0, 'utf8');
const tree = JSON.parse(raw.slice(raw.indexOf('{')));
const maxCut = Number(argOf('max') ?? 0.5);

/** 노드의 경계(없으면 null). */
function boundsOf(node) {
  const match = BOUNDS.exec(node.attributes?.bounds ?? '');
  return match === null ? null : {top: Number(match[2]), bottom: Number(match[4])};
}

const lists = [];
const rows = [];
(function walk(node) {
  const id = node.attributes?.['resource-id'];
  const bounds = boundsOf(node);
  if (bounds !== null && id === 'timeline-list') lists.push(bounds);
  if (bounds !== null && id === 'message-row') rows.push({bounds, name: node.attributes?.accessibilityText || node.attributes?.text || ''});
  for (const child of node.children ?? []) walk(child);
})(tree);

if (lists.length === 0 || rows.length === 0) {
  console.error('lane-tail-check: timeline-list 또는 message-row 를 계층에서 못 찾았다');
  process.exit(2);
}

// 마지막 행 = 위 끝이 가장 아래인 행. 창 아래 끝은 목록 프레임의 아래 끝이다.
const last = rows.reduce((best, row) => (row.bounds.top > best.bounds.top ? row : best));
const listBottom = lists[0].bottom;
const cutPt = Math.max(0, last.bounds.bottom - listBottom);
console.log(
  JSON.stringify({cutPt, listBottom, lastRowBottom: last.bounds.bottom, lastRow: last.name.slice(0, 60)}),
);
process.exit(cutPt > maxCut ? 1 : 0);
