#!/usr/bin/env node
// GATE: 채팅 pin v0 (이슈 #1112).
//
// 이 게이트가 지키는 것은 고정이 그려지는지가 아니라 **고정 목록이 하는 말이
// 참인가**다.
//
//   1. 재조회 금지     헤더 목록은 채널당 한 번 읽고, 그 뒤로는 프레임만으로 산다.
//                      `message.pinned`가 도착해 목록이 늘어나도 `/pins` 요청은
//                      **한 건도 더 나가지 않는다**. 이것이 서버가 프레임에 목록
//                      항목 전체를 싣는 이유이고, 그 페이로드를 id로 줄이면 여기서
//                      깨진다.
//   2. 두 방향 대칭    `message.unpinned`는 항목을 지운다. 지워진 메시지는
//                      `message.deleted` **하나로** 목록에서 빠진다 — 서버가 pin
//                      행을 함께 쓸어내고 두 번째 프레임을 쏘지 않기 때문이다.
//   3. 낱말은 상태다   행 메뉴의 항목은 고정 여부에 따라 뒤집힌다(고정하기 ↔ 고정
//                      해제하기). 낱말은 코어 소스에서 읽는다 — 게이트가 문자열을
//                      다시 적으면 정본이 바뀌었을 때 게이트만 혼자 초록으로 남는다.
//   4. 클릭 = 점프     목록 항목을 누르면 **기존 앵커 기계**가 원본을 물들인다.
//                      고정 목록은 자기만의 항법을 만들지 않는다.
//   5. 거절은 그 자리   상한 초과(409)는 그 행 안의 문장이다. 토스트가 아니고,
//                      서버의 영어 문장도 아니며, 숫자와 다음 행동을 말한다.
//
// 후속 #1146 이 더한 봉인 셋:
//
//   6. 목록은 거짓말하지  `/pins` 가 실패하면 「없습니다」가 아니라 「불러오지
//      않는다             못했습니다」다. 그리고 「다시 시도」는 **목록만** 다시
//                        읽는다(채널 전체를 재구축하지 않는다).
//   7. 도장 = 정렬 근거   목록의 시각은 **고정된 때**이지 쓰인 때가 아니다.
//                        해가 다르면 연도가 붙는다.
//   8. 행에 흔적이 남는다 고정된 메시지의 꼬리에 「고정됨」이 서고, 고정되지 않은
//                        행에는 서지 않는다.
//
// 잔여 #1149 가 더한 봉인 셋:
//
//   9. 가진 것은 재시도    「다시 시도」는 상태를 `loading` 으로 되돌린다. 그 순간
//      중에도 남는다      이미 가진 항목이 스켈레톤 뒤로 숨으면 안 된다 — 스켈레톤은
//                        **보여줄 것이 없을 때만** 서는 말이다(폰은 처음부터 그랬다).
//  10. 실패와 항목은       못 불러온 목록에 프레임으로 들어온 항목이 있으면 둘 다
//      **함께** 선다      그린다. 그리고 칸막이는 문장과 자기 버튼 사이가 아니라
//                        실패 블록과 목록 사이에 한 번 선다.
//  11. 빈 본문은 앱의 말   본문 없는 메시지의 발췌는 저자의 말이 아니라 앱의 서술이고,
//                        그래서 주(註) 기호를 달고 흐린 글자로 선다(폰과 같은 표시).
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   PIN_GATE_PROVE_RED_REFETCH=1 npm run gate:pin
//     expected failure: "the header list reached the network again"
//   PIN_GATE_PROVE_RED_LIVE=1 npm run gate:pin
//     expected failure: "a live pin never reached the header list"
//   PIN_GATE_PROVE_RED_LABEL=1 npm run gate:pin
//     expected failure: "the pin action did not flip with the state"
//   PIN_GATE_PROVE_RED_CAP=1 npm run gate:pin
//     expected failure: "the channel cap refusal was never stated in the row"
//   PIN_GATE_PROVE_RED_HONEST=1 npm run gate:pin
//     expected failure: "a failed read must not be reported as an empty channel"
//   PIN_GATE_PROVE_RED_STAMP=1 npm run gate:pin
//     expected failure: "the list stamp is not the value the list sorts on"
//   PIN_GATE_PROVE_RED_MARK=1 npm run gate:pin
//     expected failure: "a pinned row carries no mark"
//   PIN_GATE_PROVE_RED_TAIL=1 npm run gate:pin
//     expected failure: "the pinned mark jumped ahead of 「수정됨」"
//   PIN_GATE_PROVE_RED_KEEP=1 npm run gate:pin
//     expected failure: "the retry hid what the list already had"
//   PIN_GATE_PROVE_RED_VOICE=1 npm run gate:pin
//     expected failure: "an empty body is drawn as if the author wrote it"
//
// HONEST는 실패해야 할 `/pins` 를 성공시키고(그러면 화면이 「없습니다」로 돌아가
// 단언이 깨진다), STAMP·MARK 는 DOM 에서 글자와 원소를 걷어낸다.
//
// red seam은 **목/드라이버의 행동만** 바꾼다. REFETCH는 페이지에서 `/pins`를 직접
// 한 번 더 부르고(카운터 단언이 네트워크를 실제로 보고 있음을 증명), LIVE는
// 프레임에서 `pinned_at_ms`를 빼고(목록이 프레임에서 산다는 것을 증명), LABEL은
// DOM에서 항목의 글자를 갈아치우고, CAP은 목이 409 대신 200을 돌려준다. 제품 소스
// 줄을 지우거나 단언을 빼라고 요구하지 않으므로 증명은 반복 가능하다.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 고정 액션의 두 낱말. 코어 소스에서 읽는다 (gate-quote가 `QUOTE_ACTION_LABEL`에
 * 대해 하는 것과 같은 규율이고 같은 이유다). `import`가 아니라 정규식인 이유도
 * 같다: 이 게이트는 node가 직접 도는 `.mjs`이고, 코어의 `.ts` 한 줄을 읽자고 TS
 * 로더를 끌어오는 것은 값에 비해 비싸다.
 */
function canonicalPinCopy(root) {
  const pins = readFileSync(
    resolve(root, "../../packages/momo-core/src/features/timeline/pins.ts"),
    "utf8"
  );
  const labels = /return pinned \? "([^"]+)" : "([^"]+)";/.exec(pins);
  if (!labels) {
    throw new Error(
      "pinActionLabel의 낱말을 코어에서 찾지 못했다: 게이트가 검사할 문자열의 정본이 사라졌다"
    );
  }
  const copy = readFileSync(
    resolve(root, "../../packages/momo-core/src/features/timeline/actionCopy.ts"),
    "utf8"
  );
  const conflict =
    /export function pinFailureMessage[\s\S]*?case 409:\s*\n\s*return "([^"]+)";/.exec(
      copy
    );
  if (!conflict) {
    throw new Error("pinFailureMessage의 409 문장을 코어에서 찾지 못했다");
  }
  // #1149 M2·M4 — 행의 표지, 빈 본문의 서술, 그리고 그 서술 앞에 서는 주(註)
  // 기호. 셋 다 코어에서 읽는 이유는 위와 같다: 게이트가 문자열을 다시 적으면
  // 정본이 바뀐 날 게이트만 혼자 초록으로 남는다.
  const rowMark = /export const PIN_ROW_MARK = "([^"]+)";/.exec(pins);
  const emptyBody = /export const PIN_EMPTY_BODY_TEXT = "([^"]+)";/.exec(pins);
  if (!rowMark || !emptyBody) {
    throw new Error("PIN_ROW_MARK / PIN_EMPTY_BODY_TEXT 를 코어에서 찾지 못했다");
  }
  const voice = readFileSync(
    resolve(root, "../../packages/momo-core/src/features/timeline/appVoice.ts"),
    "utf8"
  );
  const noteMark = /export const APP_NOTE_MARK = "([^"]+)";/.exec(voice);
  if (!noteMark) {
    throw new Error("APP_NOTE_MARK 를 코어에서 찾지 못했다");
  }
  return {
    unpin: labels[1],
    pin: labels[2],
    capSentence: conflict[1],
    rowMark: rowMark[1],
    emptyBody: emptyBody[1],
    noteMark: noteMark[1],
  };
}

const port = Number(process.env.PIN_GATE_PORT || 5197);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channelId = "00000000-0000-7000-8000-000000000201";

const {
  unpin: UNPIN_LABEL,
  pin: PIN_LABEL,
  capSentence: CAP_SENTENCE,
  rowMark: PIN_ROW_MARK_TEXT,
  emptyBody: EMPTY_BODY_TEXT,
  noteMark: APP_NOTE_MARK,
} = canonicalPinCopy(webRoot);

const proveRedRefetch = process.env.PIN_GATE_PROVE_RED_REFETCH === "1";
const proveRedLive = process.env.PIN_GATE_PROVE_RED_LIVE === "1";
const proveRedLabel = process.env.PIN_GATE_PROVE_RED_LABEL === "1";
const proveRedCap = process.env.PIN_GATE_PROVE_RED_CAP === "1";
const proveRedHonest = process.env.PIN_GATE_PROVE_RED_HONEST === "1";
const proveRedStamp = process.env.PIN_GATE_PROVE_RED_STAMP === "1";
const proveRedMark = process.env.PIN_GATE_PROVE_RED_MARK === "1";
const proveRedTail = process.env.PIN_GATE_PROVE_RED_TAIL === "1";
const proveRedKeep = process.env.PIN_GATE_PROVE_RED_KEEP === "1";
const proveRedVoice = process.env.PIN_GATE_PROVE_RED_VOICE === "1";

// 행 id는 소문자다 — 행이 `data-message-id`를 소문자로 내놓는다.
const COLD_PINNED_MSG = "0199bbbb-0000-7000-8000-0000000000c1";
const LIVE_PINNED_MSG = "0199bbbb-0000-7000-8000-0000000000c2";
const PLAIN_MSG = "0199bbbb-0000-7000-8000-0000000000c3";
const CAPPED_MSG = "0199bbbb-0000-7000-8000-0000000000c4";
/**
 * 본문이 없는 메시지 (#1149 M4). 고정 목록은 그 자리에 앱의 서술을 그리고, 그
 * 서술이 저자의 말과 같은 결로 서면 사람은 앱의 해명을 남의 말로 읽는다.
 */
const VOICELESS_MSG = "0199bbbb-0000-7000-8000-0000000000c5";
/**
 * ADR-0155 — 사람이 정지를 눌러 얼어붙은 답. 꼬리 낱말이 하나 더 생겼으므로,
 * 「한 줄에 안쪽부터」 계약을 재는 이 게이트가 그 낱말도 함께 잰다. 별도 게이트를
 * 세우지 않는 이유는 계약이 하나이기 때문이다 — 두 곳에서 재면 한 곳만 고쳐진다.
 *
 * **c5 가 아니라 c6 이다** (design-review H-1). 1차는 `VOICELESS_MSG` 와 같은
 * UUID·같은 seq 를 썼다. 두 페르소나가 정반대인데(하나는 본문이 **없는** 고정
 * 대상, 하나는 본문이 **얼어붙은** 타임라인 행) 한 id 를 나눠 가지면, 그 id 를
 * 고정하는 프레임이 어느 쪽을 고정하는지 픽스처가 스스로 대답하지 못한다. 두
 * 단언이 서로 다른 표면을 읽어 **우연히** 초록이었을 뿐이고, id 로 조회하는 다음
 * 단언부터는 무엇을 재는지 아무도 모른다. 같은 사고가 다시 오지 않도록 아래
 * `assertDistinctFixtureIds` 가 이 목록 전체를 기계적으로 잰다.
 */
const STOPPED_MSG = "0199bbbb-0000-7000-8000-0000000000c6";
/**
 * ADR-0155 — 프로바이더가 답 도중에 죽은 판. 「중단됨」과 **다른 낱말**을 그리므로
 * 픽스처도 다른 행이어야 한다: 한 행을 두 outcome 으로 돌려쓰면 두 낱말이 한
 * 장에 함께 선 사진이 영영 안 나오고, 그 비교가 이 배치의 논점이다.
 */
const FAILED_MSG = "0199bbbb-0000-7000-8000-0000000000c7";

const COLD_BODY = "배포 순서는 이 문서가 정본입니다. 롤백까지 여기 있습니다.";
const LIVE_BODY = "온콜 교대는 매주 화요일 10시입니다.";
const PLAIN_BODY = "확인했습니다.";
const STOPPED_BODY = "배포 로그를 보면 첫 번째 원인은";
const FAILED_BODY = "그 다음 단계는 릴레이를 재시작하고";
const CAPPED_BODY = "이 채널은 고정이 꽉 찼습니다.";

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://pin-gate.invalid/connection/websocket",
};

function member(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const roster = [
  member({
    id: memberId,
    kind: "human",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
  }),
  member({ id: peerId, kind: "human", displayName: "이도현", handle: "dohyun" }),
];

const channels = [
  {
    id: channelId,
    workspaceId,
    kind: "public",
    name: "release-2026-08",
    muted: false,
  },
];

const AT = 1_785_238_400_000;

function row(over) {
  return {
    channelId,
    hlcCount: 0,
    type: "text",
    state: "sent",
    ...over,
    hlcTs: over.hlcTs ?? AT + over.seq * 1_000,
    createdAtMs: over.createdAtMs ?? AT + over.seq * 1_000,
  };
}

/**
 * 콜드 고정 대상은 **닷새 전에 쓰였다** (#1146 N1). 쓰인 때와 고정된 때가 같은
 * 날이면 도장이 어느 쪽을 그리는지 아무 단언도 구별하지 못한다 — 그리고 오래된
 * 글을 지금 고정하는 것이 고정의 전형적인 쓰임이다.
 */
const COLD_CREATED_MS = AT - 5 * 86_400_000;

/**
 * 픽스처의 id·seq 가 서로 다른가 (design-review H-1 의 재발 방지).
 *
 * H-1 은 상수 **두 줄이 같은 문자열**이었던 사고다. 사람은 그것을 못 본다 — 한
 * 줄은 c5 를 선언하고 다른 줄은 스무 줄 아래에서 c5 를 선언하며, 둘 다 자기
 * 페르소나를 길게 변호하는 독스트링을 달고 있다. 그리고 게이트는 **초록으로
 * 남았다**: 두 단언이 서로 다른 표면(고정 목록 vs 타임라인)을 읽었기 때문이다.
 * 즉 이 종류의 오염은 실패로 나타나지 않고 「무엇을 재는지 아무도 모르는 상태」로
 * 나타난다.
 *
 * 그래서 픽스처를 사람이 아니라 기계가 읽는다. 이 함수는 어떤 단언보다 **먼저**
 * 돌고, 다음번 상수 하나가 남의 id 를 빌리는 순간 게이트가 그 자리에서 멈춘다.
 */
function assertDistinctFixtureIds() {
  const rows = historyPage();
  const byId = new Map();
  const bySeq = new Map();
  for (const entry of rows) {
    if (byId.has(entry.id)) {
      throw new Error(
        `fixture id collision: "${entry.id}" is both ${byId.get(entry.id)} and ${entry.body} — ` +
          "two personas on one id means no assertion knows which one it read"
      );
    }
    if (bySeq.has(entry.seq)) {
      throw new Error(
        `fixture seq collision at ${entry.seq}: ${bySeq.get(entry.seq)} and ${entry.body}`
      );
    }
    byId.set(entry.id, entry.body ?? "(voiceless)");
    bySeq.set(entry.seq, entry.body ?? "(voiceless)");
  }
  // 고정 목록 쪽 페르소나는 히스토리에 없는 id 를 쓸 수도 있으므로 따로 잰다.
  // H-1 이 정확히 이 교차점에서 일어났다: 타임라인 상수가 고정 목록 상수의 id 를
  // 빌렸다.
  if (byId.has(VOICELESS_MSG)) {
    throw new Error(
      `VOICELESS_MSG ("${VOICELESS_MSG}") leaked into the timeline fixture — ` +
        "the pin-list persona is defined by having NO body, and a history row gives it one"
    );
  }
  console.log(
    `[fixture] ${byId.size} timeline rows, ${byId.size} distinct ids / ${bySeq.size} distinct seqs · ` +
      `VOICELESS(${VOICELESS_MSG.slice(-2)}) ∦ STOPPED(${STOPPED_MSG.slice(-2)}) ∦ FAILED(${FAILED_MSG.slice(-2)})`
  );
}

function historyPage() {
  return [
    row({
      id: COLD_PINNED_MSG,
      seq: 41,
      authorMemberId: memberId,
      body: COLD_BODY,
      createdAtMs: COLD_CREATED_MS,
    }),
    row({ id: LIVE_PINNED_MSG, seq: 42, authorMemberId: peerId, body: LIVE_BODY }),
    // **수정된 행이다** (#1149 M2). 이 행이 5단계에서 고정되므로, 6b 는 「수정됨」과
    // 「고정됨」이 한 꼬리에 그 순서로 함께 선 것을 한 번에 잰다. 1차 픽스처는
    // 전부 `sent` 라 그 공존이 코드에도 사진에도 없었다 — 주장만 있고 증거가 0.
    row({
      id: PLAIN_MSG,
      seq: 43,
      authorMemberId: memberId,
      body: PLAIN_BODY,
      state: "edited",
    }),
    row({ id: CAPPED_MSG, seq: 44, authorMemberId: memberId, body: CAPPED_BODY }),
    // ADR-0155 — 에이전트가 쓰다 만 답. `outcome` 은 서버가 닫는 PATCH 로 찍은
    // 도장이고, 본문은 사람이 정지를 누르던 순간 읽고 있던 그 글자 그대로다.
    //
    // seq 는 46 이다 — 45 는 `VOICELESS_MSG` 의 것이고, 그 겹침이 H-1 이었다.
    row({
      id: STOPPED_MSG,
      seq: 46,
      authorMemberId: peerId,
      body: STOPPED_BODY,
      props: {
        // 16진뿐이다 (design-review N-2). 1차의 `…r1` 은 UUID 를 주장하면서
        // UUID 가 아니었다 — 클라는 문자열로만 읽어 무해했지만, 모양을 주장하는
        // 픽스처는 그 모양을 지켜야 다음 사람이 값을 믿는다.
        run_id: "0199bbbb-0000-7000-8000-0000000000f1",
        "momo.stream": { rev: 6, streaming: false, outcome: "cancelled" },
      },
    }),
    // ADR-0155 — 프로바이더 사망. 같은 꼬리 자리, **다른 낱말**.
    row({
      id: FAILED_MSG,
      seq: 47,
      authorMemberId: peerId,
      body: FAILED_BODY,
      props: {
        run_id: "0199bbbb-0000-7000-8000-0000000000f2",
        "momo.stream": { rev: 4, streaming: false, outcome: "failed" },
      },
    }),
  ];
}

/**
 * 서버 `PinnedMessageDto` 그대로 (camelCase, 소문자 id).
 *
 * `createdAtMs` 를 따로 받을 수 있는 것은 #1146 N1 때문이다: **쓰인 때와 고정된
 * 때가 같은 날이면 도장이 어느 쪽을 그리는지 사진으로도 코드로도 구별되지 않는다.**
 */
function pinEntry(messageId, seq, authorMemberId, body, pinnedAtMs, createdAtMs) {
  return {
    messageId,
    channelId,
    seq,
    authorMemberId,
    type: "text",
    state: "sent",
    body,
    createdAtMs: createdAtMs ?? AT + seq * 1_000,
    pinnedBy: memberId,
    pinnedAtMs,
  };
}

/** 브로드캐스트 페이로드 (snake_case, 소문자 id) — `momo.message.pinned`. */
function pinnedFrame(entry) {
  const payload = {
    message_id: entry.messageId,
    channel_id: entry.channelId,
    seq: entry.seq,
    author_member_id: entry.authorMemberId,
    type: entry.type,
    state: entry.state,
    body: entry.body,
    created_at_ms: entry.createdAtMs,
    pinned_by: entry.pinnedBy,
    pinned_at_ms: entry.pinnedAtMs,
  };
  // red seam: 목록이 프레임에서 산다는 것을 증명한다. 서버는 이 키를 빼지 않고,
  // 코어의 `asPinFrame`은 빠진 프레임을 통째로 버린다 — 반쯤 그린 행은 다음 콜드
  // 로드까지 아무도 고치지 못하기 때문이다.
  if (proveRedLive) delete payload.pinned_at_ms;
  return {
    type: "message.pinned",
    v: 1,
    ts: entry.pinnedAtMs,
    seq: entry.seq,
    payload,
  };
}

function unpinnedFrame(messageId, seq) {
  return {
    type: "message.unpinned",
    v: 1,
    ts: AT + 900_000,
    seq,
    payload: { message_id: messageId, channel_id: channelId },
  };
}

function deletedFrame(messageId, seq) {
  return {
    type: "message.deleted",
    v: 1,
    ts: AT + 950_000,
    seq,
    payload: { message_id: messageId },
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    const sockets = new Set();
    let offset = 0;
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        this.url = url;
        this.readyState = GateWebSocket.CONNECTING;
        this.subscriptions = new Set();
        sockets.add(this);
        queueMicrotask(() => {
          this.readyState = GateWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send(data) {
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) {
            replies.push({
              id: command.id,
              connect: { client: "pin-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                // `recovered: true`. false면 useTimeline이 `?after=` 백필을 돌고,
                // 「요청이 더 나가지 않는다」를 재는 창을 그 루프가 흔든다.
                recovered: true,
                epoch: "pin-gate",
                offset,
              },
            });
          } else if (command.unsubscribe) {
            this.subscriptions.delete(command.unsubscribe.channel);
            replies.push({ id: command.id, unsubscribe: {} });
          } else {
            replies.push({ id: command.id });
          }
        }
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: replies.map((reply) => JSON.stringify(reply)).join("\n"),
            })
          );
        });
      }

      close() {
        this.readyState = GateWebSocket.CLOSED;
        sockets.delete(this);
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;

    window.__pinGateChannelSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("ch:")) return true;
        }
      }
      return false;
    };
    // 고정 프레임은 메시지 레일을 그대로 탄다 — 자기 채널을 만들지 않는다.
    window.__pinGatePublish = (frame) => {
      offset += 1;
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (!name.startsWith("ch:")) continue;
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: { channel: name, pub: { data: frame, offset } },
              }),
            })
          );
        }
      }
    };
  });
}

/**
 * 관측한 네트워크. 「목록을 다시 읽지 않는다」는 이 카운터로만 증명할 수 있다 —
 * 코드를 읽어서 하는 약속은 다음 리팩터에서 사라진다.
 */
function makeTraffic() {
  return { pinReads: [], pinWrites: [], allUrls: [] };
}

async function installRoutes(context, traffic, options = {}) {
  // #1146 M2 — 첫 목록 읽기를 한 번 떨어뜨린다. 재시도가 두 번째 읽기를 내는지,
  // 그리고 그 사이에 화면이 무슨 말을 하는지가 아래 `exerciseHonesty` 의 전부다.
  let pinReadsToDegrade = options.failFirstPinRead ? 1 : 0;
  // #1149 M1 — 재시도가 도는 **동안**의 화면을 재려면 그 창이 존재해야 한다.
  // 즉답하는 목은 `loading` 을 한 프레임도 남기지 않으므로, 늦게 답하는 목만이
  // 「스켈레톤이 가진 것을 덮었는가」를 물을 수 있다.
  const laterReadDelayMs = options.laterPinReadDelayMs ?? 0;
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    traffic.allUrls.push(`${method} ${path}${url.search}`);

    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    }

    // pin 쓰기. 상한이 찬 메시지만 409로 거절한다 — 서버의 영어 문장 그대로,
    // 그것이 화면에 닿지 않는다는 것이 단언 5의 절반이다.
    if (path.endsWith("/pin")) {
      traffic.pinWrites.push(`${method} ${path}`);
      const target = path.split("/").at(-2) ?? "";
      if (method === "PUT" && target === CAPPED_MSG && !proveRedCap) {
        return json(
          route,
          { error: { code: "conflict", message: "channel pin limit reached" } },
          409
        );
      }
      if (method === "PUT") {
        return json(route, {
          action: "pinned",
          messageId: target,
          channelId,
          changed: true,
          pinned: pinEntry(
            target,
            44,
            memberId,
            CAPPED_BODY,
            AT + 800_000
          ),
        });
      }
      return json(route, {
        action: "unpinned",
        messageId: target,
        channelId,
        changed: true,
      });
    }

    if (path.endsWith("/pins")) {
      traffic.pinReads.push(`${method} ${path}`);
      if (pinReadsToDegrade > 0) {
        pinReadsToDegrade -= 1;
        // red seam: **1차의 행동 그대로** — 실패를 조용한 빈 목록으로 바꾼다.
        // 그러면 화면은 「고정한 메시지가 없습니다」로 돌아가고, 그것을 잡는
        // 단언이 실제로 화면을 읽고 있다면 반드시 깨진다.
        if (proveRedHonest) return json(route, { pins: [] });
        return json(
          route,
          { error: { code: "unavailable", message: "pins are away" } },
          503
        );
      }
      if (laterReadDelayMs > 0) await wait(laterReadDelayMs);
      return json(route, { pins: options.pins ?? [
        pinEntry(
          COLD_PINNED_MSG,
          41,
          memberId,
          COLD_BODY,
          AT + 700_000,
          COLD_CREATED_MS
        ),
      ] });
    }

    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });

    if (path.endsWith("/messages")) {
      if (url.searchParams.has("after")) return json(route, { messages: [] });
      return json(route, { messages: historyPage() });
    }

    return json(route, {});
  });
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("pin@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  await page.getByTestId("channel-item").first().click();
  await page.waitForFunction(() => window.__pinGateChannelSubscribed(), undefined, {
    timeout: 15_000,
  });
  await page
    .locator(`[data-testid="timeline-message"][data-message-id="${COLD_PINNED_MSG}"]`)
    .waitFor();
}

/** 「8월 5일」. 오늘·어제가 아닌 날에 대해서만 정확하고, 아래는 그런 날만 쓴다. */
function plainDay(atMs) {
  const at = new Date(atMs);
  return `${at.getMonth() + 1}월 ${at.getDate()}일`;
}

function rowLocator(page, messageId) {
  return page.locator(
    `[data-testid="timeline-message"][data-message-id="${messageId}"]`
  );
}

async function openRowMenu(page, messageId) {
  const target = rowLocator(page, messageId);
  await target.hover();
  await target.getByTestId("message-actions-trigger").click();
  await page.getByTestId("message-action-menu").waitFor();
}

async function closeAnyMenu(page) {
  await page.keyboard.press("Escape");
  await page.getByTestId("message-action-menu").waitFor({ state: "detached" });
}

async function openPinList(page) {
  await page.getByTestId("open-pin-list").click();
  await page.getByTestId("pin-list").waitFor();
}

async function closePinList(page) {
  await page.keyboard.press("Escape");
  await page.getByTestId("pin-list").waitFor({ state: "detached" });
}

async function listedIds(page) {
  return page.getByTestId("pin-list-item").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-message-id"))
  );
}

async function exercise(browser) {
  const traffic = makeTraffic();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, traffic);
  await login(page);

  // ---- 1. 콜드 로드: 채널당 한 번 --------------------------------------------
  await page.getByTestId("open-pin-list").waitFor();
  if (traffic.pinReads.length !== 1) {
    throw new Error(
      `the header list must be read exactly once per channel, saw ${traffic.pinReads.length}: ${traffic.pinReads.join(", ")}`
    );
  }
  await openPinList(page);
  if ((await listedIds(page)).join() !== COLD_PINNED_MSG) {
    throw new Error(
      `the cold list did not carry the server's entry, read ${(await listedIds(page)).join(", ")}`
    );
  }
  const coldText = (await page.getByTestId("pin-list").textContent()) ?? "";
  if (!coldText.includes("배포 순서는")) {
    throw new Error(
      `the list entry must carry the message the server projected, read "${coldText}"`
    );
  }
  if (!coldText.includes("곽성재")) {
    throw new Error(`the list entry must name its author, read "${coldText}"`);
  }

  // ---- 1b. 도장은 정렬 근거다 (#1146 N1) --------------------------------------
  // 1차는 **쓰인 때**를 그리면서 **고정된 때**로 줄을 세웠다. 그 둘이 다른 날에
  // 떨어지는 픽스처에서만 이 단언이 의미를 갖는다.
  const pinnedDay = plainDay(AT + 700_000);
  const writtenDay = plainDay(COLD_CREATED_MS);
  if (pinnedDay === writtenDay) {
    throw new Error(
      "fixture is vacuous: the pinned day and the written day must differ"
    );
  }
  if (proveRedStamp) {
    // red seam: DOM에서 도장의 글자를 쓰인 때로 갈아치운다. 아래 단언이 DOM을
    // 읽고 있다면 반드시 깨진다. 제품 소스는 그대로다.
    await page.evaluate((text) => {
      const node = document.querySelector('[data-testid="pin-list-stamp"]');
      if (node) node.textContent = text;
    }, writtenDay);
  }
  const stamp =
    (await page.getByTestId("pin-list-stamp").textContent())?.trim() ?? "";
  if (stamp !== pinnedDay) {
    throw new Error(
      `the list stamp is not the value the list sorts on: expected the pinned day "${pinnedDay}", read "${stamp}"`
    );
  }
  if (stamp === writtenDay) {
    throw new Error(
      "the stamp drew the message's own time — the list would look unsorted"
    );
  }
  await closePinList(page);

  // ---- 2. 재조회 금지: 프레임만으로 자란다 ------------------------------------
  if (proveRedRefetch) {
    // red seam: 페이지에서 목록을 한 번 더 부른다. 아래 카운터가 네트워크를 실제로
    // 보고 있다면 반드시 깨진다. 제품 소스는 그대로다.
    await page.evaluate(
      ({ ws, ch }) =>
        fetch(`/v1/workspaces/${ws}/channels/${ch}/pins`).catch(() => {}),
      { ws: workspaceId, ch: channelId }
    );
    await wait(300);
  }
  await page.evaluate(
    (frame) => window.__pinGatePublish(frame),
    pinnedFrame(
      pinEntry(LIVE_PINNED_MSG, 42, peerId, LIVE_BODY, AT + 750_000)
    )
  );
  await wait(300);
  await openPinList(page);
  const afterLive = await listedIds(page);
  if (!afterLive.includes(LIVE_PINNED_MSG)) {
    throw new Error(
      `a live pin never reached the header list, read ${afterLive.join(", ")}`
    );
  }
  if (traffic.pinReads.length !== 1) {
    throw new Error(
      `the header list reached the network again — the frame must carry the whole entry (${traffic.pinReads.length} reads: ${traffic.pinReads.join(", ")})`
    );
  }
  // 최근 고정이 위다. 도착 순서가 아니라 `pinnedAtMs`가 줄을 세운다.
  if (afterLive[0] !== LIVE_PINNED_MSG) {
    throw new Error(
      `the list must lead with the newest pin, read ${afterLive.join(", ")}`
    );
  }
  await closePinList(page);

  // ---- 3. 낱말은 상태다 -------------------------------------------------------
  await openRowMenu(page, PLAIN_MSG);
  const plainLabel =
    (await page.getByTestId("menu-pin").textContent())?.trim() ?? "";
  if (plainLabel !== PIN_LABEL) {
    throw new Error(
      `an unpinned row must offer "${PIN_LABEL}", read "${plainLabel}"`
    );
  }
  await closeAnyMenu(page);

  await openRowMenu(page, COLD_PINNED_MSG);
  if (proveRedLabel) {
    // red seam: DOM에서 글자를 갈아치운다. 아래 단언이 DOM을 읽고 있다면 깨진다.
    await page.evaluate((text) => {
      const node = document.querySelector('[data-testid="menu-pin"]');
      if (node) node.textContent = text;
    }, PIN_LABEL);
  }
  const pinnedLabel =
    (await page.getByTestId("menu-pin").textContent())?.trim() ?? "";
  if (pinnedLabel !== UNPIN_LABEL) {
    throw new Error(
      `the pin action did not flip with the state: a pinned row must offer "${UNPIN_LABEL}", read "${pinnedLabel}"`
    );
  }
  await closeAnyMenu(page);

  // ---- 4. 두 방향 대칭: unpin 프레임과 tombstone -------------------------------
  await page.evaluate(
    (frame) => window.__pinGatePublish(frame),
    unpinnedFrame(LIVE_PINNED_MSG, 42)
  );
  await wait(200);
  await openPinList(page);
  if ((await listedIds(page)).includes(LIVE_PINNED_MSG)) {
    throw new Error("message.unpinned did not take the entry off the list");
  }
  await closePinList(page);

  // 지워진 메시지는 프레임 **하나로** 목록에서 빠진다: 서버는 pin 행을 함께
  // 쓸어내고 두 번째 프레임을 쏘지 않는다.
  await page.evaluate(
    (frame) => window.__pinGatePublish(frame),
    deletedFrame(COLD_PINNED_MSG, 41)
  );
  await wait(200);
  await openPinList(page);
  if ((await listedIds(page)).length !== 0) {
    throw new Error(
      "a deleted message must leave the pin list on message.deleted alone — the server publishes no second frame for it"
    );
  }
  await page.getByTestId("pin-list-empty").waitFor();
  if (traffic.pinReads.length !== 1) {
    throw new Error(
      `nothing above may re-read the list (${traffic.pinReads.length} reads)`
    );
  }
  await closePinList(page);

  // ---- 5. 클릭 = 원본 점프 ----------------------------------------------------
  // 목록을 다시 채우고, 항목을 눌러 기존 앵커 기계가 원본을 물들이는지 본다.
  await page.evaluate(
    (frame) => window.__pinGatePublish(frame),
    pinnedFrame(pinEntry(PLAIN_MSG, 43, memberId, PLAIN_BODY, AT + 760_000))
  );
  await wait(200);
  await openPinList(page);
  await page
    .locator(`[data-testid="pin-list-item"][data-message-id="${PLAIN_MSG}"]`)
    .click();
  await page.waitForFunction(
    (id) => {
      const article = document.querySelector(
        `[data-testid="timeline-message"][data-message-id="${id}"]`
      );
      return article?.classList.contains("bg-accent-soft") === true;
    },
    PLAIN_MSG,
    { timeout: 5_000 }
  );
  if (await page.getByTestId("chat-anchor-missed").isVisible()) {
    throw new Error(
      "the jump landed but the shell still said it had not — the pin list must reuse the anchor machinery, not a second one"
    );
  }

  // ---- 6. 상한 거절은 그 행 안의 문장 -----------------------------------------
  await openRowMenu(page, CAPPED_MSG);
  await page.getByTestId("menu-pin").click();
  const capped = rowLocator(page, CAPPED_MSG);
  const banner = capped.getByTestId("message-action-error");
  try {
    await banner.waitFor({ timeout: 5_000 });
  } catch {
    throw new Error(
      "the channel cap refusal was never stated in the row (a 409 must land where the click was, not in a toast)"
    );
  }
  const bannerText = (await banner.textContent()) ?? "";
  if (!bannerText.includes(CAP_SENTENCE)) {
    throw new Error(
      `the row must say the core's sentence, read "${bannerText}"`
    );
  }
  if (bannerText.includes("channel pin limit reached")) {
    throw new Error("the server's wire sentence reached the screen");
  }
  if (!bannerText.includes("100")) {
    throw new Error(
      `the refusal must name the number or it reads as a bug, read "${bannerText}"`
    );
  }

  // ---- 6b. 행에 흔적이 남는다 (#1146 M3) --------------------------------------
  //
  // 고정 목록에서 원본으로 점프한 뒤 착지 틴트가 가시면, 방금 고른 그 줄은 옆줄과
  // 완전히 같아진다. 흔적이 없으면 「이것이 그 고정된 메시지인가」에 답하는 것이
  // 사람의 기억뿐이다. 액션 메뉴를 열어 낱말을 확인하는 것은 답이 아니다.
  await closeAnyMenu(page);
  if (proveRedMark) {
    // red seam: DOM에서 표지를 걷어낸다. 단언이 화면을 보고 있다면 깨진다.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('[data-testid="pin-mark"]')) {
        node.remove();
      }
    });
  }
  const pinnedRowMark = rowLocator(page, PLAIN_MSG).getByTestId("pin-mark");
  try {
    await pinnedRowMark.waitFor({ timeout: 5_000 });
  } catch {
    throw new Error(
      "a pinned row carries no mark — the only way to learn a message is pinned would be to open its menu"
    );
  }
  // 그리고 고정되지 않은 행에는 서지 않는다. 모든 행에 서는 표지는 표지가 아니다.
  if (await rowLocator(page, CAPPED_MSG).getByTestId("pin-mark").isVisible()) {
    throw new Error("an unpinned row wears the pinned mark");
  }

  // ---- 6c. 두 표지는 **한 줄에 그 순서로** 선다 (#1149 M2) --------------------
  //
  // #1146 은 「기존 위계를 침범하지 않는다」를 이렇게 변호했다: 「고정됨」은
  // 「수정됨」이 앉아 있는 그 꼬리 한 줄에 같은 격으로 앉고, 순서는 「수정됨」
  // (본문에 대한 서술) 다음이다. 그런데 픽스처의 행이 전부 `sent` 라 **그 둘이
  // 함께 선 판이 한 번도 없었다** — 변호만 있고 증거가 0건이면, 다음 배치가 새 띠
  // 하나로 조용히 뒤집어도 게이트는 초록으로 남는다.
  const pinnedRow = rowLocator(page, PLAIN_MSG);
  const tails = pinnedRow.getByTestId("message-meta");
  if ((await tails.count()) !== 1) {
    throw new Error(
      `the row's read-only marks must share ONE tail line, found ${await tails.count()}`
    );
  }
  if (proveRedTail) {
    // red seam: DOM 에서 두 표지의 순서를 뒤집는다. 아래 단언이 순서를 실제로
    // 보고 있다면 반드시 깨진다. 제품 소스는 그대로다.
    await page.evaluate((id) => {
      const row = document.querySelector(
        `[data-testid="timeline-message"][data-message-id="${id}"]`
      );
      const meta = row?.querySelector('[data-testid="message-meta"]');
      const mark = meta?.querySelector('[data-testid="pin-mark"]');
      if (meta && mark) meta.insertBefore(mark, meta.firstChild);
    }, PLAIN_MSG);
  }
  const tailText = (await tails.textContent()) ?? "";
  if (!tailText.includes("수정됨")) {
    throw new Error(
      `fixture is vacuous: the pinned row must also be an edited row, read "${tailText}"`
    );
  }
  if (tailText.indexOf("수정됨") > tailText.indexOf(PIN_ROW_MARK_TEXT)) {
    throw new Error(
      `the pinned mark jumped ahead of 「수정됨」 — the tail reads inside-out, "${tailText}"`
    );
  }

  // ---- 6d. 멈춘 답은 같은 꼬리에, 같은 격으로 (ADR-0155) ---------------------
  //
  // 이 게이트가 이미 「꼬리 한 줄·안쪽부터」를 재고 있으므로 새 낱말도 여기서
  // 잰다. 색을 **계산된 값으로** 읽는 것이 요점이다: ADR-0155 는 이것이 상태이지
  // 강조가 아니라고 정했고, accent 나 danger 로 바뀌는 순간 그 결정이 뒤집힌다 —
  // 그런데 클래스 이름만 보는 단언은 팔레트가 바뀌어도 초록으로 남는다.
  const stoppedRow = rowLocator(page, STOPPED_MSG);
  const stopMark = stoppedRow.getByTestId("stream-stop-mark");
  const stopText = (await stopMark.textContent()) ?? "";
  if (stopText.trim() !== "중단됨") {
    throw new Error(
      `a cancelled stream must name itself in the app's own word, read "${stopText}"`
    );
  }
  // 얼린다 = 지우지 않는다. 사람이 읽고서 누른 그 반쪽이 그대로 있어야 한다.
  if (!((await stoppedRow.textContent()) ?? "").includes(STOPPED_BODY)) {
    throw new Error(
      "the frozen half-answer vanished — freezing, not tombstoning, is the whole decision"
    );
  }
  const stopTails = stoppedRow.getByTestId("message-meta");
  if ((await stopTails.count()) !== 1) {
    throw new Error(
      `the stop mark must join the ONE tail line, found ${await stopTails.count()}`
    );
  }
  const tones = await page.evaluate(
    ([stoppedId, editedId]) => {
      const pick = (id, testId) => {
        const row = document.querySelector(
          `[data-testid="timeline-message"][data-message-id="${id}"]`
        );
        const node = row?.querySelector(`[data-testid="${testId}"]`);
        return node ? getComputedStyle(node).color : null;
      };
      const probe = document.createElement("span");
      document.body.appendChild(probe);
      const swatch = (token) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const out = {
        stop: pick(stoppedId, "stream-stop-mark"),
        edited: pick(editedId, "message-meta"),
        accent: swatch("--accent"),
        danger: swatch("--danger"),
        muted: swatch("--ink-muted"),
      };
      probe.remove();
      return out;
    },
    [STOPPED_MSG, PLAIN_MSG]
  );
  if (tones.stop !== tones.muted) {
    throw new Error(
      `the stop mark must be the tail's muted ink, read ${tones.stop} against ${tones.muted}`
    );
  }
  if (tones.stop === tones.accent || tones.stop === tones.danger) {
    throw new Error(
      `a stopped answer is a STATE, not an alarm: ${tones.stop} is accent/danger`
    );
  }
  if (tones.stop !== tones.edited) {
    throw new Error(
      `the stop mark diverged from 「수정됨」's ink (${tones.stop} vs ${tones.edited}) — one tail, one weight`
    );
  }
  // 사망 판은 **다른 낱말**을 쓴다. 한 행을 두 outcome 으로 돌려쓰지 않는 이유가
  // 이것이다 — 두 낱말이 갈리는지는 둘이 함께 서 있을 때만 재진다.
  const failedRow = rowLocator(page, FAILED_MSG);
  const failedText = (await failedRow.getByTestId("stream-stop-mark").textContent()) ?? "";
  if (failedText.trim() !== "응답이 끊김") {
    throw new Error(
      `a dead provider is not a human pressing stop: read "${failedText}"`
    );
  }
  if (failedText.trim() === stopText.trim()) {
    throw new Error(
      "cancelled and failed collapsed into one word — the two endings stopped being distinguishable"
    );
  }
  // 그리고 얼어붙은 두 본문이 **둘 다** 살아 있다.
  if (!((await failedRow.textContent()) ?? "").includes(FAILED_BODY)) {
    throw new Error("the dead provider's half-answer vanished");
  }
  console.log(
    `[stop] "${stopText.trim()}" · "${failedText.trim()}" · ${tones.stop} (=수정됨)`
  );

  // ---- 7. 헤더 버튼은 하나의 이름을 갖는다 ------------------------------------
  const trigger = page.getByTestId("open-pin-list");
  const [ariaLabel, title] = await Promise.all([
    trigger.getAttribute("aria-label"),
    trigger.getAttribute("title"),
  ]);
  if (!ariaLabel || ariaLabel !== title) {
    throw new Error(
      `two names for one control is two controls to a reader: aria-label "${ariaLabel}" vs title "${title}"`
    );
  }

  await context.close();
}

/**
 * 목록이 **모르는 것을 아는 척하지 않는가** (#1146 M2·N1 연도).
 *
 * 1차의 결함은 조용했다: `/pins` 가 실패해도 지도는 비어 있었고, 화면은
 * 「고정한 메시지가 없습니다」를 인쇄했다 — 채널에 고정이 열 개 있어도. 오프라인에서
 * 그것을 읽은 사람은 고정이 지워졌다고 결론 내린다. 채널을 못 쓰게 만들자는 것이
 * 아니라(그 판정은 그대로다), 없다고 **말하지 말자**는 것이다.
 *
 * 별도의 컨텍스트에서 도는 이유는 위의 `exercise` 가 「채널당 정확히 한 번 읽는다」를
 * 재고 있기 때문이다. 실패와 재시도를 그 안에 끼우면 그 카운터가 흔들린다.
 */
async function exerciseHonesty(browser) {
  const traffic = makeTraffic();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  // 재시도가 돌려줄 목록. 둘째 항목은 **해를 넘겨** 고정된 것이다 — 연도가 붙는지는
  // 붙지 않는 줄 옆에서만 확인된다.
  const lastYear = new Date(AT);
  lastYear.setFullYear(lastYear.getFullYear() - 1);
  const olderPinMs = lastYear.getTime();
  await installRoutes(context, traffic, {
    failFirstPinRead: true,
    pins: [
      pinEntry(
        COLD_PINNED_MSG,
        41,
        memberId,
        COLD_BODY,
        AT + 700_000,
        COLD_CREATED_MS
      ),
      pinEntry(LIVE_PINNED_MSG, 42, peerId, LIVE_BODY, olderPinMs, olderPinMs),
    ],
  });
  await login(page);

  await openPinList(page);
  const failedText =
    (await page.getByTestId("pin-list").textContent()) ?? "";
  if (failedText.includes("고정한 메시지가 없습니다")) {
    throw new Error(
      "a failed read must not be reported as an empty channel — that sentence tells someone offline their pins are gone"
    );
  }
  if (!failedText.includes("불러오지 못했습니다")) {
    throw new Error(`a failed read must say so, read "${failedText}"`);
  }
  if ((await listedIds(page)).length !== 0) {
    throw new Error("the failed read produced entries out of nowhere");
  }
  // 그리고 버튼도 수를 말하지 않는다. 목록 안에서 고친 거짓말이 헤더로 옮겨 가면
  // 고쳐진 것이 아니다.
  const failedTrigger =
    (await page.getByTestId("open-pin-list").getAttribute("aria-label")) ?? "";
  if (/\d/.test(failedTrigger)) {
    throw new Error(
      `the header must not count what it could not read, read "${failedTrigger}"`
    );
  }

  // 「다시 시도」는 **목록만** 다시 읽는다. 채널 전체를 재구축하면 읽던 자리를
  // 잃는데, 사람이 답하고 있는 것은 부속물 하나에 대한 문장 하나다.
  const readsBefore = traffic.pinReads.length;
  const historyBefore = traffic.allUrls.filter((url) =>
    url.includes("/messages")
  ).length;
  await page.getByTestId("pin-list-retry").click();
  await page.getByTestId("pin-list-item").first().waitFor({ timeout: 5_000 });
  if (traffic.pinReads.length !== readsBefore + 1) {
    throw new Error(
      `the retry must read the list exactly once more (${readsBefore} -> ${traffic.pinReads.length})`
    );
  }
  const historyAfter = traffic.allUrls.filter((url) =>
    url.includes("/messages")
  ).length;
  if (historyAfter !== historyBefore) {
    throw new Error(
      "the retry rebuilt the channel — it must re-read the list alone, or the reader loses their place"
    );
  }
  const healedText = (await page.getByTestId("pin-list").textContent()) ?? "";
  if (healedText.includes("불러오지 못했습니다")) {
    throw new Error("the failure sentence outlived the failure");
  }

  // 해가 다르면 연도가 붙는다 (#1146 N1의 나머지 절반). 채널의 고정은 해를 넘겨
  // 남고, 「12월 31일」은 그것이 작년인지 말하지 않는다.
  const stamps = await page
    .getByTestId("pin-list-stamp")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
  if (stamps.length !== 2) {
    throw new Error(`expected two entries, read ${stamps.join(" | ")}`);
  }
  if (stamps[0].includes("년")) {
    throw new Error(
      `a pin from this year must not wear a year, read "${stamps[0]}"`
    );
  }
  if (!stamps[1].startsWith(`${lastYear.getFullYear()}년`)) {
    throw new Error(
      `a pin from another year must name it, read "${stamps[1]}"`
    );
  }

  await context.close();
}

/**
 * 못 불러온 목록도 **가진 것은 지키고**, 그 항목이 앱의 말이면 앱의 말로 선다
 * (#1149 M1·M3·M4).
 *
 * 세 항목이 한 화면에서 만나는 것은 우연이 아니다. `/pins` 가 실패한 채로 프레임이
 * 하나 도착한 순간이 그 셋의 유일한 공통 무대다:
 *
 *   M3  실패 문장과 그 항목이 **함께** 서는가. #1146 이 그렇게 하겠다고 적었지만
 *       (「가진 것을 숨기지 않는다」) 게이트도 캡처도 항목이 0인 판만 봤다.
 *   M1  그 상태에서 「다시 시도」를 누르면 상태가 `loading` 으로 되돌아간다. 1차의
 *       웹은 그 순간 스켈레톤을 세워 **가진 항목을 덮었다** — 폰은 덮지 않는다.
 *   M4  그 항목의 본문이 비어 있으면 발췌 자리에 서는 것은 앱의 서술이다. 저자의
 *       말과 같은 결로 서면 사람은 앱의 해명을 남의 말로 읽는다.
 *
 * 별도 컨텍스트인 이유는 `exercise` 와 같다: 저기는 「채널당 정확히 한 번 읽는다」를
 * 세고 있고, 실패·재시도를 끼우면 그 카운터가 흔들린다.
 */
async function exerciseKeepsWhatItHas(browser) {
  const traffic = makeTraffic();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, traffic, {
    failFirstPinRead: true,
    // 재시도가 도는 창을 사람이 볼 수 있을 만큼 벌린다. 즉답하는 목은 `loading` 을
    // 한 프레임도 남기지 않아 M1 을 물을 수 없다.
    laterPinReadDelayMs: 1_500,
    pins: [
      pinEntry(COLD_PINNED_MSG, 41, memberId, COLD_BODY, AT + 700_000, COLD_CREATED_MS),
      pinEntry(VOICELESS_MSG, 45, peerId, null, AT + 770_000),
    ],
  });
  await login(page);

  // 실패한 읽기 **위로** 프레임이 하나 도착한다. 서버가 목록을 못 준 것과 이
  // 메시지가 고정된 것은 둘 다 참이다.
  await page.evaluate(
    (frame) => window.__pinGatePublish(frame),
    pinnedFrame(pinEntry(VOICELESS_MSG, 45, peerId, null, AT + 770_000))
  );
  await wait(300);
  await openPinList(page);

  // ---- M3. 실패 문장과 항목이 함께 선다 --------------------------------------
  await page.getByTestId("pin-list-failed").waitFor({ timeout: 5_000 });
  const kept = await listedIds(page);
  if (!kept.includes(VOICELESS_MSG)) {
    throw new Error(
      `a failed read must not swallow the frames that did arrive, read ${kept.join(", ")}`
    );
  }

  // 그리고 칸막이는 **실패 블록과 목록 사이**에 선다 (#1149 M3 판단). 배너가
  // 자기 아래 테두리를 그리면 그 줄은 문장과 **자기 버튼** 사이에 떨어지는데,
  // 「다시 시도」는 아래 내용이 아니라 이 배너의 행동이다(키보드 때문에 상자
  // 밖으로 나갔을 뿐이다).
  const bannerBorder = await page
    .getByTestId("pin-list-failed")
    .evaluate((node) => getComputedStyle(node).borderBottomWidth);
  if (bannerBorder !== "0px") {
    throw new Error(
      `the separator fell between the sentence and its own button (banner border-bottom ${bannerBorder})`
    );
  }
  if ((await page.getByTestId("pin-list-divider").count()) !== 1) {
    throw new Error(
      "the failure block and the list it sits on must be divided exactly once"
    );
  }

  // ---- M4. 빈 본문은 앱의 말로 선다 ------------------------------------------
  const voiceRow = page.locator(
    `[data-testid="pin-list-item"][data-message-id="${VOICELESS_MSG}"] [data-testid="pin-list-excerpt"]`
  );
  if (proveRedVoice) {
    // red seam: DOM 에서 주(註) 기호를 걷어낸다. 단언이 화면을 보고 있다면 깨진다.
    await page.evaluate((id) => {
      const node = document.querySelector(
        `[data-testid="pin-list-item"][data-message-id="${id}"] [data-testid="pin-list-excerpt"]`
      );
      if (node) node.textContent = node.textContent?.replace(/^\S+\s*/, "") ?? "";
    }, VOICELESS_MSG);
  }
  const voiceText = (await voiceRow.textContent())?.trim() ?? "";
  if (!voiceText.includes(EMPTY_BODY_TEXT)) {
    throw new Error(
      `an empty body must say what it is, read "${voiceText}"`
    );
  }
  if (!voiceText.startsWith(APP_NOTE_MARK)) {
    throw new Error(
      `an empty body is drawn as if the author wrote it — the app's own sentence must wear "${APP_NOTE_MARK}", read "${voiceText}"`
    );
  }
  // 그리고 저자가 실제로 쓴 줄에는 그 표시가 없다. 모든 줄에 서는 표시는 표시가
  // 아니다. (이 판에서 저자의 줄은 재시도 뒤에 온다 — 아래에서 함께 잰다.)

  // ---- M1. 재시도 중에도 가진 것은 남는다 -------------------------------------
  const readsBefore = traffic.pinReads.length;
  await page.getByTestId("pin-list-retry").click();
  if (proveRedKeep) {
    // red seam: 재시도가 도는 동안 DOM 에서 항목을 걷어낸다. 아래 단언이 화면을
    // 보고 있다면 반드시 깨진다. 제품 소스는 그대로다.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('[data-testid="pin-list-item"]')) {
        node.remove();
      }
    });
  }
  // 창 안에서 잰다: 읽기가 아직 안 돌아왔고(카운터가 늘었지만 목록은 그대로),
  // 화면은 `loading` 이다.
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="pin-list"]')?.getAttribute(
        "data-pin-status"
      ) === "loading",
    undefined,
    { timeout: 5_000 }
  );
  const duringRetry = await listedIds(page);
  if (!duringRetry.includes(VOICELESS_MSG)) {
    throw new Error(
      `the retry hid what the list already had — a skeleton stands only when there is nothing to show (read ${duringRetry.join(", ")})`
    );
  }
  if ((await page.getByTestId("pin-list").getByTestId("skeleton-row").count()) !== 0) {
    throw new Error(
      "a skeleton was drawn over a list that already had rows: it predicts a place that is not empty"
    );
  }

  // 그리고 읽기가 돌아오면 실패 문장은 사라지고 두 항목이 함께 선다.
  await page.getByTestId("pin-list-item").nth(1).waitFor({ timeout: 10_000 });
  if (traffic.pinReads.length !== readsBefore + 1) {
    throw new Error(
      `the retry must read the list exactly once more (${readsBefore} -> ${traffic.pinReads.length})`
    );
  }
  const healed = await listedIds(page);
  if (!healed.includes(COLD_PINNED_MSG) || !healed.includes(VOICELESS_MSG)) {
    throw new Error(`the healed list lost an entry, read ${healed.join(", ")}`);
  }
  const authored = page.locator(
    `[data-testid="pin-list-item"][data-message-id="${COLD_PINNED_MSG}"] [data-testid="pin-list-excerpt"]`
  );
  if (((await authored.textContent()) ?? "").startsWith(APP_NOTE_MARK)) {
    throw new Error(
      "a line the author actually wrote wears the app's own mark — then the mark says nothing"
    );
  }
  if ((await page.getByTestId("pin-list-divider").count()) !== 0) {
    throw new Error("the divider outlived the failure it was dividing");
  }

  await context.close();
}

/** 리뷰용 스크린샷. 판정하지 않는다 — 사람이 보는 자리다. */
async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/pin");
  mkdirSync(outDir, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    const traffic = makeTraffic();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context, traffic);
    await login(page);
    await page.evaluate(
      (frame) => window.__pinGatePublish(frame),
      pinnedFrame(
        pinEntry(LIVE_PINNED_MSG, 42, peerId, LIVE_BODY, AT + 750_000)
      )
    );
    await wait(300);
    await openPinList(page);
    await page.screenshot({ path: resolve(outDir, `pin-list-${scheme}.png`) });
    await page
      .getByTestId("pin-list")
      .screenshot({ path: resolve(outDir, `pin-list-detail-${scheme}.png`) });
    await closePinList(page);
    // ADR-0155 — 멈춘 답의 꼬리. 행 하나만 찍는다: 리뷰가 봐야 하는 것은 「반쪽
    // 본문이 남아 있고, 그 아래 한 낱말이 흐리게 서 있다」이고, 화면 전체 사진은
    // 그 두 사실을 옆 줄들 사이에 묻는다. 두 배색으로 찍는 이유는 「흐린 잉크」가
    // 배색마다 다른 값이기 때문이다 — 한 장으로는 그 값이 지켜졌는지 못 본다.
    await rowLocator(page, STOPPED_MSG).screenshot({
      path: resolve(outDir, `stream-stop-row-${scheme}.png`),
    });
    // 방어 낱말의 웹 판 (design-review M-3). 폰은 세 판이 한 장에 서지만 웹은
    // 「중단됨」 한 장뿐이었다 — 두 낱말이 실제로 다른 글자인지는 웹 사진에서
    // 확인할 수 없었다.
    await rowLocator(page, FAILED_MSG).screenshot({
      path: resolve(outDir, `stream-stop-failed-row-${scheme}.png`),
    });
    await openRowMenu(page, COLD_PINNED_MSG);
    await page.screenshot({ path: resolve(outDir, `pin-menu-${scheme}.png`) });
    await context.close();

    // #1146 M2 — 「없다」와 「모른다」는 **나란히 놓아야** 갈린다. 그래서 못 불러온
    // 목록도 같은 두 배색으로 찍는다: 리뷰가 두 장을 함께 보지 않으면 1차의
    // 거짓말이 고쳐졌는지 사진으로 확인할 길이 없다.
    //
    // **그리고 항목과 함께 찍는다** (#1149 M3). 1차의 이 판은 항목이 0인 실패였고,
    // 그래서 #1146 이 길게 변호한 「가진 것을 숨기지 않는다」는 사진에 한 번도 서지
    // 않았다 — 실제로 갈리는 판은 실패 문장과 항목이 **함께** 선 그림이다. 프레임으로
    // 들어오는 그 항목은 **본문이 없는 메시지**로 고른다: 같은 한 장이 앱의 서술이
    // 저자의 말과 다른 결로 서는지(#1149 M4)와 칸막이가 어디 떨어지는지(#1149 M3)를
    // 함께 보여 준다.
    const failedTraffic = makeTraffic();
    const failedContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const failedPage = await failedContext.newPage();
    await installRealtimeSocket(failedPage);
    await installRoutes(failedContext, failedTraffic, {
      failFirstPinRead: true,
    });
    await login(failedPage);
    await openPinList(failedPage);
    await failedPage
      .getByTestId("pin-list")
      .screenshot({ path: resolve(outDir, `pin-list-failed-${scheme}.png`) });
    await closePinList(failedPage);
    await failedPage.evaluate(
      (frame) => window.__pinGatePublish(frame),
      pinnedFrame(pinEntry(VOICELESS_MSG, 45, peerId, null, AT + 770_000))
    );
    await wait(300);
    await openPinList(failedPage);
    await failedPage.getByTestId("pin-list-item").first().waitFor();
    await failedPage
      .getByTestId("pin-list")
      .screenshot({
        path: resolve(outDir, `pin-list-failed-kept-${scheme}.png`),
      });
    await failedContext.close();
  }
  console.log(
    "[shots] artifacts/pin/pin-{list,list-detail,list-failed,list-failed-kept,menu}-{light,dark}.png"
  );
  console.log(
    "[shots] artifacts/pin/stream-stop-{row,failed-row}-{light,dark}.png"
  );
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  // 브라우저를 띄우기 전에. 픽스처가 자기모순이면 그 뒤의 초록은 무의미하다.
  assertDistinctFixtureIds();
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "PIN_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      await exercise(browser);
      await exerciseHonesty(browser);
      await exerciseKeepsWhatItHas(browser);
      if (process.env.PIN_GATE_SHOTS === "1") await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: 고정 목록은 채널당 한 번 읽고 프레임만으로 살았고,");
  console.log("           unpin·tombstone 양쪽에서 빠졌고, 행 메뉴의 낱말은");
  console.log("           상태를 따라 뒤집혔고, 클릭은 기존 앵커로 원본에");
  console.log("           착지했고, 상한 거절은 그 행 안의 우리 문장이었다.");
  console.log("           #1146: 도장은 정렬 근거(고정된 때·연도)를 그렸고,");
  console.log("           고정된 행에만 흔적이 섰고, 못 불러온 목록은 「없다」고");
  console.log("           말하지 않았으며 재시도는 목록만 다시 읽었다.");
  console.log("           #1149: 「수정됨」과 「고정됨」이 한 꼬리에 그 순서로 섰고,");
  console.log("           실패 문장은 가진 항목과 함께 섰고(칸막이는 그 둘 사이가");
  console.log("           아니라 목록 앞에), 재시도가 도는 동안에도 가진 것은");
  console.log("           남았으며, 빈 본문은 앱의 말로 섰다.");
  console.log("           ADR-0155: 멈춘 답은 같은 꼬리 한 줄에 「중단됨」으로 섰고,");
  console.log("           그 글자는 「수정됨」과 **같은 흐린 잉크**였으며(accent 도");
  console.log("           danger 도 아니고), 얼어붙은 반쪽 본문은 그대로 남았다.");
}

await main();
