#!/usr/bin/env node
// GATE: ADE 2단계 관제 표면 (정본 ADR-0154 D1+D2, 이슈 1135).
//
// 이 게이트가 지키는 것은 서랍이 열리는지가 아니라 **그 줄이 센 것이 참인가,
// 그리고 그것을 여느라 화면을 밀지 않았는가**다.
//
//   1. 집계 정확성   요약 줄의 숫자 = 서랍의 카드 수 = 원장이 실제로 낸 것.
//                    종료된 세션은 세지 않고, 유휴는 줄을 켜지 않는다.
//   2. 대기 강조     「대기」는 나머지 조각과 **다른 잉크**로 서고, 대기 카드가
//                    목록 맨 위에 온다. blocked 가 강조축이라는 D1 의 주장이
//                    문서가 아니라 마크업과 픽셀에 있다.
//   3. 서랍 불밀림   여는 전후로 라우트·컴포저·타임라인의 좌표가 **한 픽셀도**
//                    다르지 않다. 「작성 중」줄이 컴포저를 26px 밀었던 그 결함의
//                    더 큰 판이라, 같은 방식으로 잰다.
//   4. 생존성 정직   app 호스트 카드는 「기기를 꺼도 계속됩니다」라고 **말하지
//                    않는다**. 이 문장은 사람이 랩탑을 덮는 근거다.
//   5. 빈 상태       살아 있는 작업이 0이면 요약 줄이 DOM 에 없다. 빈 띠도 없다.
//   6. 카드 확대     카드를 누르면 서랍이 물러나고 기존 표면이 선다. 둘이 겹쳐
//                    있는 순간이 없다. **두 종류 다** 누른다 — 턴 카드는 작업
//                    패널로, 세션 카드는 `?work=` 로 작업 세션 패널로. 1차 게이트가
//                    턴 카드만 눌러서 세션 절반이 죽은 채 통과했다(리뷰 B1: 세션
//                    카드는 라우트 표에 없는 주소로 가서 `/` 로 튕겼다).
//   7. live 아님     이 줄은 `aria-live` 영역이 아니다. 잦은 갱신을 낭독으로
//                    끼어들게 하지 않는다(작업 패널 1Hz 시계와 같은 판정).
//   8. Esc 는 한 층  서랍과 작업 패널이 함께 서 있을 때 Esc 한 번은 **위 한 층**만
//                    닫는다(리뷰 H1 ①). 두 층이 같은 키에 같이 반응하면 사람이 한
//                    번 누른 것으로 아직 보고 있던 것까지 사라진다.
//   9. 덮인 형제     서랍에 덮인 작업 패널은 `inert` 다 — 라우트에만 걸려 있던
//                    규칙을 형제 표면도 받는다(리뷰 H1 ②).
//  10. 바깥 클릭     덮이지 않은 라우트 영역을 누르면 서랍이 닫힌다. 보이는데
//                    아무 반응도 없는 표면을 남기지 않는다(리뷰 H2).
//  11. 조각 띠 없음  899px 에서 서랍 오른쪽에 남는 라우트 띠는 0px 이고, 1200px
//                    위에서는 최소 한 칸(320px)이다. 반쯤 잘린 컨트롤이 걸리는
//                    폭이 없다(리뷰 M3).
//
// ADE 3단계 D3 (#1137) — 재개/인수 어휘 분리:
//  12. 동사 배정     카드가 세우는 동사가 **원장이 뜻하는 것**과 같다. 살아 있는
//                    세션은 재개, 죽은 세션은 인수, 붙을 것이 없으면 아무것도.
//                    한 카드에 두 동사가 함께 서지 않고, 턴 카드는 동사를 갖지
//                    않는다. `data-handoff` 뿐 아니라 **보이는 글자**도 잰다 —
//                    이 티켓이 고치는 것이 정확히 그 낱말이다.
//  13. 사전조건      자격 있는 대상이 0이면 인수 확정 버튼이 서지 않고, 그 자리에
//                    「무엇을 하면 되는지」가 온다(명령형으로 끝나는지까지 잰다).
//                    고를 수 없는 것을 고를 수 있게 그려 놓고 서버가 거절하는
//                    것은 「막았다」가 아니라 「거짓말한 뒤 막았다」이다.
//  14. 부분 복원     인수 고지가 **두 목록 다** 세우고, 잃는 쪽이 미커밋 변경을
//                    이름으로 말하며, 제목이 「일부」라고 말한다. 한쪽만 있는
//                    고지는 「전부 복원된다」로 읽힌다.
//
// #1193 — 발원 대화 앵커:
//  15. 착지 정확     세션 카드의 「대화로」가 **원장이 말한 그 줄**에 내려놓는다.
//                    주소가 그 방을 가리키는 것으로는 부족하다 — 채널 바닥에
//                    도착하는 것과 그 작업을 낳은 줄에 도착하는 것은 다른 일이라,
//                    이 검사는 도착한 행의 `data-seq` 를 원장 픽스처가 뜻하는
//                    seq 와 맞춘다. 그리고 앵커가 없는 카드(턴)에는 그 동사가
//                    **아예 서지 않는다** — 눌러도 아무 데도 안 가는 버튼을
//                    목록의 절반에 하나씩 세우지 않는다.
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   ADE_GATE_PROVE_RED_COUNT=1 npm run gate:ade
//     expected failure: "the summary count disagreed with the ledger"
//   ADE_GATE_PROVE_RED_BLOCKED=1 npm run gate:ade
//     expected failure: "대기 was not emphasised"
//   ADE_GATE_PROVE_RED_LAYOUT=1 npm run gate:ade
//     expected failure: "opening the drawer moved the route"
//   ADE_GATE_PROVE_RED_DURABILITY=1 npm run gate:ade
//     expected failure: "a device-bound session claimed it survives the lid"
//   ADE_GATE_PROVE_RED_SESSION=1 npm run gate:ade
//     expected failure: "the session card led nowhere"
//   ADE_GATE_PROVE_RED_ESC=1 npm run gate:ade
//     expected failure: "one Escape closed two layers"
//   ADE_GATE_PROVE_RED_OUTSIDE=1 npm run gate:ade
//     expected failure: "clicking the uncovered route did nothing"
//   ADE_GATE_PROVE_RED_VERB=1 npm run gate:ade
//     expected failure: "a verb was assigned to the wrong act"
//   ADE_GATE_PROVE_RED_PRECOND=1 npm run gate:ade
//     expected failure: "a takeover was offered without its preconditions"
//   ADE_GATE_PROVE_RED_RESTORE=1 npm run gate:ade
//     expected failure: "the partial restore hid what it loses"
//   ADE_GATE_PROVE_RED_ANCHOR=1 npm run gate:ade
//     expected failure: "the anchor landed on the wrong line"
//   ADE_GATE_PROVE_RED_ZIGZAG=1 npm run gate:ade
//     expected failure: "the list zigzagged: 상태·경과 열이 오른쪽 끝을 2 개 갖는다"
//   ADE_GATE_PROVE_RED_DEEP=1 npm run gate:ade
//     expected failure: "the anchor landed on the wrong line: … 표식이 선 줄은
//                        seq null 다 … 이 방은 80줄이고 앵커는 가상 창 밖이다"
//   ADE_GATE_PROVE_RED_ADDRESS=1 npm run gate:ade
//     expected failure: "the anchor landed on the wrong line: 첫 누름 뒤에도
//                        주소가 앵커를 들고 있다"
//
// red seam 은 **목/드라이버의 행동만** 바꾼다. COUNT 는 원장에 실행 중 세션을 한
// 줄 더 실어 화면과 기대표를 갈라놓고(단언이 DOM 의 숫자를 실제로 읽는지 증명),
// DURABILITY 는 지속 호스트의 `type` 을 `app` 으로 바꿔 배지가 호스트에서 파생되는지
// 증명하며, BLOCKED 와 LAYOUT 은 CSS 만 덮어쓴다(React 가 들고 있는 노드는 그대로).
// 제품 소스 줄을 지우거나 단언을 빼라고 요구하지 않으므로 증명은 반복 가능하다.
//
// 새 셋도 같은 규율이다. SESSION 은 `history.pushState` 를 감싸 작업 세션 주소의
// `#/c/` 를 `#/channels/` 로 되돌린다 — 리뷰가 잡은 그 죽은 주소 그대로이고, 라우트
// 표에 없으므로 와일드카드가 `/` 로 보낸다. ESC 는 **예전 판의 리스너를 하나 되살린다**:
// window 캡처 단계에 작업 패널을 닫는 리스너를 앱보다 먼저 등록하므로, 층 스택이
// 없던 시절처럼 두 층이 같은 Esc 에 각자 반응한다. OUTSIDE 는 스크림의
// `pointer-events` 만 끈다(노드는 그대로 서 있고 클릭만 통과한다).
//
// D3 의 셋(#1137)도 같은 두 가지 수법만 쓴다. VERB 와 PRECOND 는 **목을 바꾸고
// 기대표는 원본 픽스처에서 뽑는다** — COUNT 가 세운 그 형태다. VERB 는 고아
// 세션을 살아 있는 것처럼 실어 화면의 동사를 뒤집고, 기대표는 여전히 「이 줄은
// 인수」라고 말하므로 단언이 DOM 의 동사를 실제로 읽고 있다면 깨진다. PRECOND 는
// 클라우드 호스트를 온라인으로 실어 자격 대상을 하나 만들어 내고, 기대표는
// 원본 명부대로 「자격 대상 0 — 확정 버튼이 서면 안 된다」를 들고 있다.
// RESTORE 는 CSS 로 「새로 시작하는 것」 목록만 숨긴다(BLOCKED·LAYOUT 과 같은
// 수법 — React 가 들고 있는 노드는 그대로다).
//
// ANCHOR(#1193)도 목만 바꾼다: 원장이 `rootMessageId` 를 **빼고** 답한다. 서버가
// 그 사실을 안 준 판이 그대로 재현되고, 그러면 카드에는 「대화로」가 서지 않아
// 착지 단정이 도착할 곳을 잃는다. 제품 소스는 한 줄도 건드리지 않는다.
//
// 셋이 늦게 왔다 (#1199 N-d). #1195 리뷰 수리가 세운 새 단정 — 「칸이 안 붙어
// 목록이 지그재그다」와 「가상 창 밖의 줄에 두 번 내려앉는다」 — 에는 이름 붙은
// red proof 가 없었다. 그 판은 직전 빌드가 실제로 빨갰다는 **경험적** 근거로만
// 서 있었고, 그것은 다음 사람이 다시 돌릴 수 없는 증거다. 셋 다 위 두 수법
// 안에 있다:
//
//   ZIGZAG   CSS 로 유령 칸만 `display:none`. 노드도 React 상태도 그대로이고,
//            없어지는 것은 **자리**뿐이다 = 칸이 세션 카드에만 서던 1차 판.
//            그러면 턴 행의 내용 열이 넓어져 상태·경과의 오른쪽 끝이 둘이 된다.
//   DEEP     드라이버가 타임라인 스크롤러의 `scrollTo` 만 삼킨다(누르기 직전에
//            켜고, 그 스크롤러 밖에서는 아무것도 안 바꾼다). `bringIntoView` 가
//            없던 판이 그대로 재현된다 — 목록은 바닥에 머물고, 창 밖의 앵커 행은
//            영영 마운트되지 않으며, 워처는 오지 않는 행을 기다리다 만료한다.
//   ADDRESS  `history.replaceState` 에서 **주소가 앵커를 잃는 갱신만** 무시한다.
//            `?msg=` 가 착지 뒤에도 주소에 남던 판이고, 그 판에서 두 번째 누름은
//            글자 단위로 같은 주소라 아무 일도 일어나지 않았다.
//
// 스크린샷은 이 게이트가 만든다(게이트 재생성 규율): artifacts/ade/*.png,
// light/dark 두 벌. 판정하지 않는다 — design-review 는 별도 레인이다.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.ADE_GATE_PORT || 5191);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const hermesId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA614";
const generalId = "00000000-0000-7000-8000-000000000201";
const engineId = "00000000-0000-7000-8000-000000000202";
const runId = "9F1C8B2A-0000-7000-8000-00000000RUN1";

const APP_HOST = "0199C0DE-0000-7000-8000-0000000000H1";
const CLOUD_HOST = "0199C0DE-0000-7000-8000-0000000000H2";

const proveRedCount = process.env.ADE_GATE_PROVE_RED_COUNT === "1";
const proveRedBlocked = process.env.ADE_GATE_PROVE_RED_BLOCKED === "1";
const proveRedLayout = process.env.ADE_GATE_PROVE_RED_LAYOUT === "1";
const proveRedDurability = process.env.ADE_GATE_PROVE_RED_DURABILITY === "1";
const proveRedSession = process.env.ADE_GATE_PROVE_RED_SESSION === "1";
const proveRedEsc = process.env.ADE_GATE_PROVE_RED_ESC === "1";
const proveRedOutside = process.env.ADE_GATE_PROVE_RED_OUTSIDE === "1";
// ADE 3단계 D3 (#1137)
const proveRedVerb = process.env.ADE_GATE_PROVE_RED_VERB === "1";
const proveRedPrecond = process.env.ADE_GATE_PROVE_RED_PRECOND === "1";
const proveRedRestore = process.env.ADE_GATE_PROVE_RED_RESTORE === "1";
// #1193
const proveRedAnchor = process.env.ADE_GATE_PROVE_RED_ANCHOR === "1";
// #1193 리뷰 수리가 세운 단정들 (#1199 N-d)
const proveRedZigzag = process.env.ADE_GATE_PROVE_RED_ZIGZAG === "1";
const proveRedDeep = process.env.ADE_GATE_PROVE_RED_DEEP === "1";
const proveRedAddress = process.env.ADE_GATE_PROVE_RED_ADDRESS === "1";

const PERSISTENT_BADGE = "기기를 꺼도 계속됩니다";
const DEVICE_BADGE = "이 기기에서만";

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
  realtimeWebSocketUrl: "ws://ade-gate.invalid/connection/websocket",
};

const roster = [
  {
    id: memberId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 2,
    channelIds: [generalId, engineId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: agentId,
    workspaceId,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 2,
    channelIds: [generalId, engineId],
    capabilities: ["work.observe"],
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: hermesId,
    workspaceId,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "Hermes",
    handle: "hermes",
    channelCount: 1,
    channelIds: [engineId],
    capabilities: ["work.observe"],
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const channels = [
  { id: generalId, workspaceId, kind: "public", name: "release-2026-08", muted: false },
  { id: engineId, workspaceId, kind: "public", name: "엔진", muted: false },
];

const workHosts = [
  {
    id: APP_HOST,
    workspaceId,
    scope: "member",
    ownerMemberId: memberId,
    type: "app",
    displayName: "성재 맥북",
    capabilities: { "work.spawn": true },
    createdAtMs: 0,
    online: true,
  },
  {
    id: CLOUD_HOST,
    workspaceId,
    scope: "workspace",
    ownerMemberId: memberId,
    // red seam: 지속 호스트를 로컬로 바꾼다. 배지가 `work_host.type` 파생이라면
    // 카드는 「이 기기에서만」이 되고, 아래 단언이 그것을 잡는다.
    type: proveRedDurability ? "app" : "cloud",
    displayName: "momo Cloud (서울)",
    capabilities: { "work.spawn": true },
    createdAtMs: 0,
    online: false,
  },
];

/**
 * 원장 픽스처. 다섯 줄이고, 각 줄이 이 게이트의 한 규칙을 산다.
 *
 *   running  + cloud   실행 중 · 지속        "기기를 꺼도 계속됩니다"
 *   running  + app     실행 중 · 기기 종속   "이 기기에서만"
 *   orphaned + app     대기(멘션급)          목록 맨 위
 *   idle     + app     유휴                  줄을 켜지 않는다(카드는 있다)
 *   ended    + cloud   어디에도 없다
 */
const BASE_SESSIONS = [
  {
    id: "0199AAAA-0000-7000-8000-0000000015e5",
    workspaceId,
    channelId: generalId,
    memberId,
    hostId: CLOUD_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-000000001ada",
    tool: "codex",
    label: "릴리스 노트 초안",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: true,
    remoteDisplayAvailable: false,
    startedAtMs: Date.now() - 240_000,
  },
  {
    id: "0199AAAA-0000-7000-8000-0000000025e5",
    workspaceId,
    channelId: engineId,
    memberId,
    hostId: APP_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-000000002ada",
    tool: "codex",
    label: "마이그레이션 042 검토",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: Date.now() - 120_000,
  },
  {
    id: "0199AAAA-0000-7000-8000-0000000035e5",
    workspaceId,
    channelId: engineId,
    memberId,
    hostId: APP_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-000000003ada",
    tool: "codex",
    label: "관전 터미널 회귀",
    status: "orphaned",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: Date.now() - 600_000,
  },
  {
    id: "0199AAAA-0000-7000-8000-0000000045e5",
    workspaceId,
    channelId: generalId,
    memberId,
    hostId: APP_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-000000004ada",
    tool: "codex",
    label: "스크롤 프로파일",
    status: "idle",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: Date.now() - 900_000,
  },
  {
    id: "0199AAAA-0000-7000-8000-0000000055e5",
    workspaceId,
    channelId: generalId,
    memberId,
    hostId: CLOUD_HOST,
    rootMessageId: "0199AAAA-0000-7000-8000-000000005ada",
    tool: "codex",
    label: "지난 배포 되돌리기",
    status: "ended",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: Date.now() - 1_800_000,
    endedAtMs: Date.now() - 1_500_000,
    exitCode: 0,
  },
];

// red seam: 원장이 한 줄 더 낸다. 기대표는 픽스처(BASE_SESSIONS)에서 나오므로
// 화면과 갈라지고, 「숫자가 원장과 같은가」 단언이 DOM 을 실제로 읽고 있다면
// 반드시 깨진다.
const RED_EXTRA_SESSION = {
  ...BASE_SESSIONS[0],
  id: "0199AAAA-0000-7000-8000-0000000095e5",
  label: "빨간 증명용 여벌",
};

/**
 * `release-2026-08` 의 히스토리 (#1193).
 *
 * 이 게이트는 여태 빈 타임라인으로 돌았다 — 잴 것이 카드였기 때문이다. 「대화로」는
 * **도착한 줄**을 재야 하므로 여기서부터 방에 대화가 있어야 한다.
 *
 * ## 왜 80줄인가 (리뷰 M4 — 얕은 픽스처는 실패할 줄 모른다)
 *
 * 1차 픽스처는 다섯 줄이었고 그 다섯은 가상 창 안에 통째로 들어갔다. 그래서 이
 * 게이트는 초록인 채로 B1 을 통과시켰다: 리뷰가 잰 표에 따르면 창은 1280x900 에서
 * 36줄이고 45줄 방부터 앵커가 DOM 에서 사라진다. **제품이 실패하는 방식으로
 * 실패할 수 없는 게이트는 그 실패에 대해 아무 말도 하지 않는다.**
 *
 * 그래서 방은 80줄이고 앵커는 위에서 세 번째다 — 창 밖이고 바닥에서 멀다. 바닥에
 * 데려다 놓고 「도착했다」고 부르는 회귀와, 창 밖이라 못 찾고 「더 불러오세요」라고
 * 말하는 회귀를 **한 장의 픽스처가 동시에** 잡는다.
 *
 * id 는 진짜 16진수다 (리뷰 N3): 서버가 낼 수 없는 문자열로 증명한 착지는 증명이
 * 아니다.
 */
const ANCHOR_SEQ = 4_102;
const GENERAL_DEPTH = 80;
const CHATTER = [
  "릴리스 노트 초안 어디까지 됐어요?",
  "관전은 열어 뒀습니다.",
  "확인했습니다. 초안 나오면 여기 붙일게요.",
  "migration 042 는 스테이징에서 먼저 돌립니다.",
  "@kim-intern 8월 배포분 정리 부탁해요.",
];
const GENERAL_MESSAGES = Array.from({ length: GENERAL_DEPTH }, (_, index) => {
  const seq = 4_100 + index;
  const isAnchor = seq === ANCHOR_SEQ;
  return {
    // 앵커 줄만 원장이 말한 그 id 다. 나머지는 이 방의 평범한 대화이고, 그 대비가
    // 「어느 줄에 내려놓았나」를 잴 수 있게 한다.
    id: isAnchor
      ? BASE_SESSIONS[0].rootMessageId
      : `0199AAAA-0000-7000-8000-${(0xe00000000000 + index).toString(16)}`,
    channelId: generalId,
    seq,
    hlcTs: 1_760_000_000_000 + index,
    hlcCount: 0,
    authorMemberId: isAnchor ? agentId : memberId,
    type: "text",
    body: isAnchor
      ? "작업 세션을 시작했습니다: 릴리스 노트 초안"
      : `${CHATTER[index % CHATTER.length]} (${index + 1})`,
    createdAtMs: 1_760_000_000_000 + index * 1_000,
  };
});

function ledger(extra = false) {
  const base = proveRedAnchor
    ? // red seam(ANCHOR): 원장이 발원 메시지를 안 준다. 그러면 카드에 「대화로」가
      // 서지 않고, 착지 단정은 도착할 곳을 잃는다.
      BASE_SESSIONS.map((row) => {
        const stripped = { ...row };
        delete stripped.rootMessageId;
        return stripped;
      })
    : BASE_SESSIONS;
  const rows = extra ? [...base, RED_EXTRA_SESSION] : base;
  if (!proveRedVerb) return rows;
  // red seam(VERB): 고아 세션을 살아 있는 것으로 실어 화면의 동사를 재개로
  // 뒤집는다. 기대표는 BASE_SESSIONS 에서 나오므로 「이 줄은 인수」로 남는다.
  return rows.map((row) =>
    row.status === "orphaned"
      ? { ...row, status: "running", remoteAttachAvailable: true }
      : row
  );
}

/**
 * 명부. red seam(PRECOND) 은 클라우드 호스트를 온라인으로 만들어 **자격 대상을
 * 하나 만들어 낸다** — 기대표는 원본 `workHosts` 로 계산하므로 갈라진다.
 */
function hostRegistry() {
  if (!proveRedPrecond) return workHosts;
  return workHosts.map((host) =>
    host.id === CLOUD_HOST ? { ...host, online: true } : host
  );
}

/**
 * 픽스처가 뜻하는 이어하기 동사 (코어 `sessionVerdict` 의 서버 규칙 그대로,
 * 화면이 아니라 여기서 다시 센다).
 */
function expectedVerb(row, hosts) {
  if (row.status === "orphaned") return "takeover";
  if (row.status !== "running" && row.status !== "idle") return null;
  const host = hosts.find((candidate) => candidate.id === row.hostId);
  if (host === undefined) return null;
  return host.revokedAtMs === undefined && row.remoteAttachAvailable
    ? "resume"
    : null;
}

/** 자격 있는 인수 대상 (코어 `workSessionResumeTargets` 규칙). */
function eligibleTargets(row, hosts) {
  if (row.status !== "orphaned") return [];
  return hosts.filter(
    (host) =>
      host.revokedAtMs === undefined &&
      host.online &&
      host.id !== row.hostId &&
      (host.scope === "workspace" || host.ownerMemberId === memberId)
  );
}

/** 픽스처가 실제로 뜻하는 수. 화면이 아니라 여기서 센다. */
function expectedFromFixture(sessions, turnStates) {
  let working = 0;
  let blocked = 0;
  let idle = 0;
  for (const s of sessions) {
    if (s.status === "running") working += 1;
    else if (s.status === "orphaned") blocked += 1;
    else if (s.status === "idle") idle += 1;
  }
  for (const state of turnStates) {
    if (state === "awaiting_approval") blocked += 1;
    else working += 1;
  }
  return { working, blocked, idle };
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
              connect: { client: "ade-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                // `recovered: false` 가 load-bearing 이다: true 면 웹 레일의
                // replay gate 가 agent 네임스페이스 배치를 통째로 버린다.
                recovered: false,
                epoch: "ade-gate",
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
    window.__adeGateAgentSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("agent:")) return true;
        }
      }
      return false;
    };
    window.__adeGatePublish = (frame) => {
      offset += 1;
      const stamped = { ...frame, ts: frame.ts ?? Date.now() };
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (!name.startsWith("agent:")) continue;
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: { channel: name, pub: { data: stamped, offset } },
              }),
            })
          );
        }
      }
    };
  });
}

/**
 * red seam 넷 (드라이버 쪽에서만 산다, 앱 번들보다 **먼저** 돈다).
 *
 * SESSION: 1차 판이 지었던 죽은 주소를 되돌린다. 라우트 표에 있는 것은
 *   `c/:channelId` 뿐이라 `#/channels/...` 는 와일드카드가 받아 `/` 로 보내고,
 *   그 리다이렉트는 쿼리(`?work=`)까지 함께 버린다.
 *
 * ESC: 층 스택이 서기 전의 리스너를 하나 되살린다. window 캡처 단계이고 앱보다
 *   먼저 등록되므로 — 그것이 정확히 예전 `AgentWorkPanel` 의 자리였다 —
 *   `stopImmediatePropagation` 도 이것을 막지 못한다. 서랍이 자기 층을 닫는 사이
 *   이 리스너가 작업 패널을 닫아, 한 번의 Esc 가 두 층을 가져간다.
 *
 * ADDRESS (#1199 N-d): 주소가 **앵커를 잃는** 갱신만 삼킨다. 나머지 주소 변경은
 *   그대로 통과하므로 라우팅도 서랍도 평소대로 돈다 — 되살아나는 것은 「읽고도
 *   지우지 않던」 그 한 가지뿐이고, 그 판에서 두 번째 누름은 첫 번째와 글자 단위로
 *   같은 주소라 라우터가 아무것도 알리지 않았다.
 *
 * DEEP (#1199 N-d): 타임라인 스크롤러의 `scrollTo` 만 삼킨다. **누르기 직전에
 *   켜지므로**(`window.__adeBlockTimelineScroll`) 첫 페이지 착지와 따라가기는
 *   평소대로 일어나고, 사라지는 것은 `bringIntoView` 가 목록에 내리는 그 한 번의
 *   명령이다 = 리뷰 B1 이전의 판. 그 판에서 워처는 가상 창 밖의 행이 마운트되기를
 *   기다리다 만료하고, 화면은 이미 로드된 줄을 두고 「더 불러오세요」라고 말한다.
 */
async function installRedSeams(page) {
  if (proveRedAddress) {
    await page.addInitScript(() => {
      const replace = history.replaceState.bind(history);
      history.replaceState = (state, title, url) => {
        const dropsAnchor =
          typeof url === "string" &&
          !url.includes("msg=") &&
          location.hash.includes("msg=");
        if (dropsAnchor) return undefined;
        return replace(state, title, url);
      };
    });
  }
  if (proveRedDeep) {
    await page.addInitScript(() => {
      window.__adeBlockTimelineScroll = false;
      const nativeScrollTo = Element.prototype.scrollTo;
      Element.prototype.scrollTo = function (...args) {
        if (
          window.__adeBlockTimelineScroll === true &&
          typeof this.closest === "function" &&
          this.closest('[data-testid="timeline-virtuoso"]') !== null
        ) {
          return undefined;
        }
        return nativeScrollTo.apply(this, args);
      };
    });
  }
  if (proveRedSession) {
    await page.addInitScript(() => {
      const push = history.pushState.bind(history);
      history.pushState = (state, title, url) => {
        const dead =
          typeof url === "string" && url.includes("work=")
            ? url.replace("#/c/", "#/channels/")
            : url;
        return push(state, title, dead);
      };
    });
  }
  if (proveRedEsc) {
    await page.addInitScript(() => {
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Escape") return;
          const close = document.querySelector(
            '[data-testid="agent-work-panel-close"]'
          );
          if (close instanceof HTMLElement) close.click();
        },
        true
      );
    });
  }
}

async function installRoutes(context, options = {}) {
  const sessions = options.sessions ?? ledger(false);
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/work-hosts")) {
      return json(route, { workHosts: hostRegistry() });
    }
    if (path.endsWith("/work-sessions")) {
      return json(route, { workSessions: sessions });
    }
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes("/messages")) {
      // 히스토리는 **요청한 방에만** 있다 (#1193). 모든 방에 같은 줄을 실으면
      // 「그 방의 그 줄」이라는 주장이 「아무 방의 아무 줄」이 된다.
      const history =
        options.messages !== undefined && path.includes(generalId)
          ? options.messages
          : [];
      return json(route, { messages: history });
    }
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    return json(route, {});
  });
}

function statusFrame(agentMemberId, channelId, phase, runStatus) {
  return {
    type: "agent.status",
    v: 1,
    payload: {
      run_id: `${runId}-${agentMemberId.slice(-3)}`,
      agent_member_id: agentMemberId,
      channel_id: channelId,
      phase,
      run_status: runStatus,
    },
  };
}

async function publish(page, frame) {
  await page.evaluate((f) => window.__adeGatePublish(f), frame);
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("ade@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  await page.getByTestId("channel-item").first().click();
  await page.waitForFunction(() => window.__adeGateAgentSubscribed(), undefined, {
    timeout: 15_000,
  });
}

/** 요약 줄이 실제로 그린 숫자. 조각의 종류로 읽는다(문자열 파싱이 아니다). */
async function summaryNumbers(page) {
  return page.evaluate(() => {
    const line = document.querySelector('[data-testid="ade-summary"]');
    if (line === null) return null;
    const read = (kind) => {
      const node = line.querySelector(`[data-ade-segment="${kind}"]`);
      return node === null ? 0 : Number(node.textContent ?? "0");
    };
    return {
      working: read("count"),
      blocked: read("blockedCount"),
      text: line.querySelector('[data-testid="ade-summary-text"]')?.textContent ?? "",
      label: line.querySelector('[data-testid="ade-summary-label"]')?.textContent ?? "",
    };
  });
}

async function openDrawer(page) {
  await page.getByTestId("ade-summary").click();
  await page.getByTestId("ade-drawer").waitFor();
}

async function cardFacts(page) {
  return page.locator('[data-testid="ade-card"]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      kind: node.dataset.kind,
      state: node.dataset.state,
      durability: node.dataset.durability,
      title: node.querySelector('[data-testid="ade-card-title"]')?.textContent ?? "",
      badge:
        node.querySelector('[data-testid="ade-card-durability"]')?.textContent ?? "",
      chip: node.querySelector('[data-testid="ade-card-state"]')?.textContent ?? "",
      diffEmpty:
        node.querySelector('[data-testid="ade-card-diff"]')?.hasAttribute("data-empty") ??
        false,
      // ADE 3단계 D3: 이 카드가 세우는 이어하기 동사와 그 보이는 글자.
      handoff: node.dataset.handoff ?? null,
      handoffText:
        node.querySelector('[data-testid="ade-card-handoff"]')?.textContent ?? "",
    }))
  );
}

// ---- 1~4. 본 시나리오 --------------------------------------------------------

async function exerciseControl(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRedSeams(page);
  await installRoutes(context, { sessions: ledger(proveRedCount) });
  await login(page);

  // 열린 턴 둘: 하나는 작업 중, 하나는 승인 대기.
  await publish(page, statusFrame(agentId, generalId, "queued", "queued"));
  await publish(page, statusFrame(agentId, generalId, "streaming", "running"));
  await publish(page, statusFrame(hermesId, engineId, "queued", "queued"));
  await publish(
    page,
    statusFrame(hermesId, engineId, "awaiting_approval", "awaiting_approval")
  );

  const expected = expectedFromFixture(ledger(false), [
    "running",
    "awaiting_approval",
  ]);

  await page.getByTestId("ade-summary").waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    (want) => {
      const node = document.querySelector('[data-ade-segment="count"]');
      return node !== null && Number(node.textContent ?? "0") === want;
    },
    expected.working,
    { timeout: 10_000 }
  ).catch(() => {
    // 대기는 편의다. 판정은 아래 비교가 한다.
  });

  // ---- 3. 서랍 불밀림 (여는 **전** 좌표) -----------------------------------
  //
  // 「입력창이 그 자리에 있는가」는 의견이 아니라 좌표다. 「작성 중」 줄이 컴포저를
  // 26px 밀었던 결함을 게이트가 픽셀로 잡았고(리뷰 H-2), 이 서랍은 그것보다 훨씬
  // 큰 표면이라 같은 자를 댄다.
  if (proveRedLayout) {
    // red seam: 서랍을 흐름 안의 블록으로 되돌린다 = 절대 위치를 쓰지 않은 판.
    // CSS 규칙만 바꾸므로 React 가 들고 있는 노드는 그대로다.
    await page.addStyleTag({
      content:
        '[data-testid="ade-drawer"]{position:static!important;inset:auto!important;max-inline-size:none!important}',
    });
  }
  const geometry = async () => {
    return page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      };
      return {
        composer: box('[data-testid="composer-input"]'),
        header: box("main header"),
        summary: box('[data-testid="ade-summary"]'),
      };
    });
  };
  const before = await geometry();
  if (before.composer === null || before.header === null) {
    throw new Error("채널 표면을 측정할 수 없다 (컴포저/헤더가 없다)");
  }

  await openDrawer(page);

  const after = await geometry();
  console.log(
    `[layout] 컴포저 ${JSON.stringify(before.composer)} -> ${JSON.stringify(
      after.composer
    )} · 헤더 ${JSON.stringify(before.header)} -> ${JSON.stringify(after.header)}`
  );
  for (const [name, a, b] of [
    ["composer", before.composer, after.composer],
    ["header", before.header, after.header],
  ]) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(
        `opening the drawer moved the route: ${name} ${JSON.stringify(
          a
        )} -> ${JSON.stringify(b)} (tokens.css ade-drawer must cover, never push)`
      );
    }
  }

  // ---- 1. 집계 정확성 -------------------------------------------------------
  const numbers = await summaryNumbers(page);
  if (numbers === null) throw new Error("요약 줄이 없다 (작업이 있는데도)");
  const cards = await cardFacts(page);
  const drawn = {
    working: cards.filter((c) => c.state === "working").length,
    blocked: cards.filter((c) => c.state === "blocked").length,
    idle: cards.filter((c) => c.state === "idle").length,
  };
  console.log(
    `[count] 원장 기대 ${JSON.stringify(expected)} · 요약 ${numbers.working}/${
      numbers.blocked
    } · 카드 ${JSON.stringify(drawn)}`
  );
  if (
    numbers.working !== expected.working ||
    numbers.blocked !== expected.blocked
  ) {
    throw new Error(
      `the summary count disagreed with the ledger: 기대 ${expected.working}/${expected.blocked}, 화면 ${numbers.working}/${numbers.blocked} (${numbers.text})`
    );
  }
  if (
    drawn.working !== expected.working ||
    drawn.blocked !== expected.blocked ||
    drawn.idle !== expected.idle
  ) {
    throw new Error(
      `the summary count disagreed with the ledger: 서랍이 ${JSON.stringify(
        drawn
      )} 장을 그렸다 (기대 ${JSON.stringify(expected)})`
    );
  }
  // 종료된 세션은 어디에도 없다. 이름으로 찾는다 — 상태 칸이 아니라 존재 자체다.
  if (cards.some((c) => c.title.includes("지난 배포 되돌리기"))) {
    throw new Error(
      "the summary count disagreed with the ledger: 종료된 세션이 관제 목록에 남았다"
    );
  }
  // 유휴는 카드로는 서지만 줄을 켜지 않는다.
  if (numbers.text.includes("유휴")) {
    throw new Error(
      `the summary count disagreed with the ledger: 유휴가 요약 줄에 실렸다 (${numbers.text})`
    );
  }

  // ---- 2. 대기 강조 ---------------------------------------------------------
  if (proveRedBlocked) {
    // red seam: 강조 조각을 나머지와 같은 잉크로 칠한다 = 강조축이 없는 판.
    await page.addStyleTag({
      content:
        '[data-ade-segment="blocked"],[data-ade-segment="blockedCount"]{color:var(--ink-muted)!important}',
    });
  }
  const inks = await page.evaluate(() => {
    const line = document.querySelector('[data-testid="ade-summary"]');
    const read = (kind) => {
      const node = line?.querySelector(`[data-ade-segment="${kind}"]`);
      return node === null || node === undefined
        ? null
        : getComputedStyle(node).color;
    };
    return { plain: read("plain"), blocked: read("blocked") };
  });
  console.log(`[blocked] plain=${inks.plain} · blocked=${inks.blocked}`);
  if (inks.blocked === null || inks.plain === null) {
    throw new Error("대기 was not emphasised: 강조 조각이 아예 없다");
  }
  if (inks.blocked === inks.plain) {
    throw new Error(
      `대기 was not emphasised: 강조 조각이 나머지와 같은 잉크다 (${inks.blocked})`
    );
  }
  // 순서도 강조축이다: 대기가 맨 위.
  if (cards[0]?.state !== "blocked") {
    throw new Error(
      `대기 was not emphasised: 목록 맨 위가 ${cards[0]?.state} 다 (대기가 멘션급이라는 D1 이 순서에 없다)`
    );
  }

  // ---- 4. 생존성 정직 -------------------------------------------------------
  const deviceBound = cards.filter((c) => c.durability === "device_bound");
  const persistent = cards.filter((c) => c.durability === "persistent");
  console.log(
    `[durability] 기기 종속 ${deviceBound.length}장 · 지속 ${persistent.length}장`
  );
  for (const card of deviceBound) {
    if (card.badge.includes(PERSISTENT_BADGE)) {
      throw new Error(
        `a device-bound session claimed it survives the lid: "${card.title}" -> "${card.badge}"`
      );
    }
    if (!card.badge.includes(DEVICE_BADGE)) {
      throw new Error(
        `a device-bound session claimed it survives the lid: "${card.title}" 이 자기 등급을 말하지 않았다 ("${card.badge}")`
      );
    }
  }
  if (persistent.length === 0) {
    throw new Error(
      `a device-bound session claimed it survives the lid: 지속 등급 카드가 한 장도 없다 (호스트 파생이 끊겼다)`
    );
  }
  for (const card of persistent) {
    if (!card.badge.includes(PERSISTENT_BADGE)) {
      throw new Error(
        `a device-bound session claimed it survives the lid: 지속 세션이 "${card.badge}" 라고 말했다`
      );
    }
  }
  // 턴에는 호스트가 없다. 등급은 `unknown` 이고 배지는 **그리지 않는다** — 모든
  // 턴이 「실행 위치 확인 필요」를 하나씩 달고 서면 경고가 기본값이 된다.
  const runCards = cards.filter((c) => c.kind === "run");
  if (runCards.length === 0) throw new Error("턴 카드가 목록에 없다");
  for (const card of runCards) {
    if (card.durability !== "unknown") {
      throw new Error(
        `a device-bound session claimed it survives the lid: 턴 카드가 "${card.durability}" 를 주장했다 (턴에는 호스트가 없다)`
      );
    }
    if (card.badge !== "") {
      throw new Error(
        `a device-bound session claimed it survives the lid: 턴 카드가 생존성 배지를 세웠다 ("${card.badge}")`
      );
    }
  }

  // diff 는 아직 서버에 없다. 자리는 있고, 숫자는 없다.
  if (!cards.every((c) => c.diffEmpty)) {
    throw new Error("서버가 주지 않은 diff 를 카드가 그렸다");
  }

  // ---- 7. live 영역이 아니다 -------------------------------------------------
  const live = await page.evaluate(() => {
    const line = document.querySelector('[data-testid="ade-summary"]');
    return line === null ? null : line.closest("[aria-live]") !== null;
  });
  if (live !== false) {
    throw new Error(
      "the summary line sits inside a live region; a count that changes this often would be read aloud over the reader's work"
    );
  }

  // ---- 12. 동사 배정 (ADE 3단계 D3, #1137) ------------------------------------
  //
  // 재개와 인수는 **다른 act** 이므로 같은 카드에 둘 다 설 수 없고, 어느 쪽이
  // 서는지는 원장이 정한다. 기대표는 화면이 아니라 픽스처에서 뽑는다
  // (`expectedVerb` — 서버 `SessionReattachState::verdict` 규칙 그대로).
  //
  // 이 검사가 이 티켓의 첫 red proof 를 진다. 앞 판의 결함은 **낱말이 뒤섞인
  // 것**이었다: 죽은 세션의 인수 버튼이 「새 호스트에서 재개」였고, 살아 있는
  // 세션으로 돌아가는 길이 「이어서 보기」였으며, 형제 표면은 같은 act 를
  // 「이어받기」라고 불렀다. 한 act 에 두 이름, 두 act 에 한 종류의 이름.
  const verbExpectations = BASE_SESSIONS.map((row) => ({
    label: row.label,
    verb: expectedVerb(row, workHosts),
  }));
  for (const card of cards) {
    if (card.kind !== "session") {
      // 턴에는 호스트도 원장 행도 없다. 동사를 하나 달면 모든 턴이 달게 된다.
      if (card.handoff !== null) {
        throw new Error(
          `a verb was assigned to the wrong act: 턴 카드 "${card.title}" 가 이어하기 동사 "${card.handoff}" 를 세웠다 (턴은 재개할 히스토리도 인수할 원장 행도 없다)`
        );
      }
      continue;
    }
    const expected = verbExpectations.find((row) => row.label === card.title);
    if (expected === undefined) continue;
    if (card.handoff !== expected.verb) {
      throw new Error(
        `a verb was assigned to the wrong act: 원장이 "${card.title}" 에 대해 뜻하는 동사는 ${
          expected.verb ?? "없음"
        } 인데 카드는 ${card.handoff ?? "없음"} 를 세웠다`
      );
    }
    // 보이는 글자도 확인한다. `data-handoff` 만 맞고 라벨이 다른 판은 사람이
    // 읽는 쪽이 틀린 것이고, 이 티켓이 고치는 것은 정확히 그 낱말이다.
    const wanted =
      expected.verb === "takeover"
        ? "인수"
        : expected.verb === "resume"
          ? "이어서 보기"
          : "";
    if (card.handoffText.trim() !== wanted) {
      throw new Error(
        `a verb was assigned to the wrong act: "${card.title}" 의 동사는 ${
          expected.verb ?? "없음"
        } 인데 카드에 적힌 글자는 "${card.handoffText.trim()}" 다 (기대 "${wanted}")`
      );
    }
  }
  {
    const spread = cards
      .filter((c) => c.kind === "session")
      .map((c) => `${c.title}=${c.handoff ?? "없음"}`)
      .join(" · ");
    console.log(`[verb] ${spread}`);
  }
  // 한 카드가 두 동사를 함께 세우는 판은 없다 — 「다른 버튼」이 D3 의 요구다.
  const bothVerbs = await page.evaluate(
    () =>
      document
        .querySelectorAll('[data-testid="ade-card"]')
        .length > 0 &&
      [...document.querySelectorAll('[data-testid="ade-card"]')].some(
        (node) =>
          node.querySelectorAll('[data-testid="ade-card-handoff"]').length > 1
      )
  );
  if (bothVerbs) {
    throw new Error(
      "a verb was assigned to the wrong act: 한 카드가 이어하기 동사를 둘 세웠다 (재개와 인수는 함께 설 수 없다)"
    );
  }

  // ---- 6. 카드 확대: 서랍은 물러난다 ------------------------------------------
  //
  // **두 종류를 다 누른다.** 1차 게이트는 턴 카드만 눌렀고, 그 구멍으로 세션 카드가
  // 죽은 주소를 들고 통과했다(리뷰 B1). 카드가 두 종류라는 것은 이 표면의 설계이지
  // 구현 세부가 아니므로, 확대 검사도 두 종류다.
  const sessionCardIndex = cards.findIndex((c) => c.kind === "session");
  if (sessionCardIndex < 0) throw new Error("세션 카드가 목록에 없다");
  const sessionTitle = cards[sessionCardIndex].title;
  await page.locator('[data-testid="ade-card"]').nth(sessionCardIndex).click();
  await page.getByTestId("ade-drawer").waitFor({ state: "detached" });
  const landed = await page
    .getByTestId("work-panel")
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  const hash = await page.evaluate(() => location.hash);
  if (!landed || !hash.startsWith("#/c/")) {
    throw new Error(
      `the session card led nowhere: "${sessionTitle}" 를 눌렀는데 작업 세션 패널이 ${
        landed ? "섰지만" : "서지 않았고"
      } 주소는 ${hash} 다 (라우트 표에 있는 것은 c/:channelId 뿐이고, 와일드카드는 쿼리까지 버린 채 / 로 보낸다)`
    );
  }
  console.log(`[expand] 세션 카드 -> 작업 세션 패널 (${hash})`);

  // ---- 13·14. 인수 사전조건과 부분 복원 정직 (D3, #1137) -----------------------
  //
  // 방금 누른 것은 목록에서 맨 위, 즉 **대기(고아) 세션**이다(정렬 규칙 D1).
  // 그래서 여기 도착한 화면이 인수 동선의 출발점이고, 이 두 검사는 그 자리에서
  // 돈다 — 서랍의 「대기」 카드가 목적지에서 실제로 이어지는지까지 봐야 그
  // 카드가 동선이다.
  const takeoverToggle = page.getByTestId("work-detail-takeover-toggle");
  const hasToggle = await takeoverToggle
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasToggle) {
    throw new Error(
      "a takeover was offered without its preconditions: 고아 세션 상세에 인수 동선이 없다 (서랍의 대기 카드가 막다른 길로 끝난다)"
    );
  }
  if ((await takeoverToggle.textContent())?.trim() !== "인수") {
    throw new Error(
      `a verb was assigned to the wrong act: 고아 세션의 동선 버튼이 "${(
        await takeoverToggle.textContent()
      )?.trim()}" 다 (인수여야 한다)`
    );
  }
  await takeoverToggle.click();
  await page.getByTestId("work-detail-takeover").waitFor({ timeout: 5_000 });

  // 14. 부분 복원 정직 — 두 목록이 **다** 서고, 잃는 쪽이 미커밋 변경을 이름으로
  // 말한다. 「Git 계보만 이어집니다」한 줄이던 앞 판은 읽는 사람에게 자기
  // 작업이 어느 쪽인지 스스로 판정하게 시켰다.
  if (proveRedRestore) {
    await page.addStyleTag({
      content: '[data-testid="takeover-fresh"]{display:none!important}',
    });
  }
  const disclosure = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="work-detail-takeover-disclosure"]');
    if (box === null) return null;
    const visible = (node) =>
      node !== null && node.getClientRects().length > 0;
    const restored = box.querySelector('[data-testid="takeover-restored"]');
    const fresh = box.querySelector('[data-testid="takeover-fresh"]');
    return {
      headline: box.querySelector("p")?.textContent ?? "",
      restoredShown: visible(restored),
      freshShown: visible(fresh),
      freshText: fresh?.textContent ?? "",
      restoredText: restored?.textContent ?? "",
    };
  });
  if (disclosure === null) {
    throw new Error(
      "the partial restore hid what it loses: 인수 블록에 복원 고지가 아예 없다"
    );
  }
  if (!disclosure.restoredShown || !disclosure.freshShown) {
    throw new Error(
      `the partial restore hid what it loses: 고지의 두 목록 중 ${
        disclosure.freshShown ? "「그대로 이어지는 것」" : "「새로 시작하는 것」"
      } 이 화면에 없다 — 한쪽만 있는 고지는 「전부 복원된다」로 읽힌다`
    );
  }
  if (!disclosure.freshText.includes("커밋하지 않은 변경")) {
    throw new Error(
      `the partial restore hid what it loses: 잃는 목록이 미커밋 변경을 이름으로 말하지 않는다 ("${disclosure.freshText}")`
    );
  }
  if (!disclosure.headline.includes("일부")) {
    throw new Error(
      `the partial restore hid what it loses: 고지 제목이 「일부」라고 말하지 않는다 ("${disclosure.headline}")`
    );
  }
  console.log(
    `[restore] 고지 두 목록 · 제목 "${disclosure.headline.trim()}"`
  );

  // 13. 사전조건 — 자격 대상이 0이면 확정 버튼이 **서지 않고**, 그 자리에
  // 「무엇을 하면 되는지」가 온다. 기대는 원본 명부에서 계산한다.
  const orphan = BASE_SESSIONS.find((row) => row.status === "orphaned");
  const targets = eligibleTargets(orphan, workHosts);
  const picker = await page.evaluate(() => ({
    confirm:
      document.querySelector('[data-testid="work-session-resume-confirm"]') !== null,
    blocked:
      document.querySelector('[data-testid="work-detail-takeover-blocked"]')
        ?.textContent ?? null,
  }));
  if (targets.length === 0) {
    if (picker.confirm) {
      throw new Error(
        "a takeover was offered without its preconditions: 자격 있는 대상 호스트가 하나도 없는데 인수 확정 버튼이 섰다 (서버는 이 요청을 거절하고, 화면은 거짓말한 뒤 막은 것이 된다)"
      );
    }
    if (picker.blocked === null) {
      throw new Error(
        "a takeover was offered without its preconditions: 인수를 막았는데 이유가 없다"
      );
    }
    // 「무엇을 하면 되는지」의 기계적 형태: 명령형으로 끝난다.
    if (!/세요\.?\s*$/.test(picker.blocked.trim())) {
      throw new Error(
        `a takeover was offered without its preconditions: 차단 문장이 행동으로 끝나지 않는다 ("${picker.blocked.trim()}") — 상태만 말하는 문장은 사람을 세워 둔다`
      );
    }
    console.log(`[precond] 대상 0 · 차단 문장 "${picker.blocked.trim()}"`);
  } else if (!picker.confirm) {
    throw new Error(
      `a takeover was offered without its preconditions: 자격 대상이 ${targets.length}개인데 확정 버튼이 서지 않았다`
    );
  } else {
    console.log(`[precond] 대상 ${targets.length}개 · 확정 버튼 있음`);
  }

  await page.getByTestId("work-panel-close").click();

  await openDrawer(page);
  const reopened = await cardFacts(page);
  const runCardIndex = reopened.findIndex((c) => c.kind === "run");
  if (runCardIndex < 0) throw new Error("턴 카드가 목록에 없다");
  await page.locator('[data-testid="ade-card"]').nth(runCardIndex).click();
  await page.getByTestId("ade-drawer").waitFor({ state: "detached" });
  await page.getByTestId("agent-work-panel").waitFor({ timeout: 5_000 });
  if ((await page.getByTestId("ade-drawer").count()) !== 0) {
    throw new Error(
      "카드를 확대했는데 서랍이 그대로 남았다: 두 부차 표면이 같은 층에 겹친다"
    );
  }
  console.log("[expand] 턴 카드 -> 작업 패널, 서랍은 물러났다");

  // ---- 9·11. 덮인 형제와 남는 띠 ----------------------------------------------
  //
  // 여기부터는 **작업 패널이 열려 있는 채로** 서랍을 연다. 리뷰가 잡은 두 결함이
  // 정확히 이 상태에서만 보인다: 가려진 패널이 탭 순서에 남았고(H1 ②), 서랍
  // 오른쪽에 19px 짜리 라우트 조각이 걸렸다(M3, 899px 실측).
  const panelInert = async () =>
    page.evaluate(() => {
      const panel = document.querySelector('[data-testid="agent-work-panel"]');
      return panel === null ? null : panel.hasAttribute("inert");
    });
  const routeStrip = async () =>
    page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="ade-drawer"]');
      // 스크림이 곧 라우트 상자다(`inset: 0`). 상자를 따로 재지 않는 이유는 그
      // 둘이 같아야 한다는 것이 H2 수리의 계약이기 때문이다.
      const box = document.querySelector('[data-testid="ade-scrim"]');
      if (drawer === null || box === null) return null;
      const d = drawer.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return {
        strip: Math.round(b.right - d.right),
        box: Math.round(b.width),
        drawer: Math.round(d.width),
      };
    });

  await page.setViewportSize({ width: 899, height: 900 });
  await openDrawer(page);
  const narrow = await routeStrip();
  console.log(
    `[strip] 899px: 라우트 상자 ${narrow?.box}px · 서랍 ${narrow?.drawer}px · 남는 띠 ${narrow?.strip}px`
  );
  if (narrow === null || narrow.strip !== 0) {
    throw new Error(
      `the drawer left a sliver of route: 899px 에서 ${narrow?.strip}px 가 남았다 (반쯤 잘린 컨트롤이 걸리는 폭 — 전면 문턱은 1200px 이어야 한다)`
    );
  }
  if ((await panelInert()) !== true) {
    throw new Error(
      "a covered sibling stayed in the tab order: 서랍이 통째로 덮은 작업 패널에 inert 가 없다 (라우트에만 걸려 있다)"
    );
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  const wide = await routeStrip();
  console.log(
    `[strip] 1280px: 라우트 상자 ${wide?.box}px · 서랍 ${wide?.drawer}px · 남는 칸 ${wide?.strip}px`
  );
  if (wide === null || wide.strip < 320) {
    throw new Error(
      `the drawer left a sliver of route: 1280px 에서 ${wide?.strip}px 만 남았다 (남는 것은 띠가 아니라 최소 한 칸 320px 이어야 한다)`
    );
  }
  if ((await panelInert()) !== true) {
    throw new Error(
      "a covered sibling stayed in the tab order: 넓은 창에서도 서랍이 열린 동안 작업 패널은 받지 않는다"
    );
  }

  // ---- 10. 바깥 클릭 (리뷰 H2) -------------------------------------------------
  //
  // 덮이지 않은 라우트 영역은 `inert` 라 아무 버튼도 눌리지 않는다. 그 상태에서
  // 클릭까지 아무 일도 하지 않으면 그 절반은 「살아 보이는 시체」다. 사이드바
  // 서랍이 스크림을 버튼으로 세운 것과 같은 답을 이 서랍도 갖는다.
  if (proveRedOutside) {
    // red seam: 스크림은 그 자리에 그대로 서 있고 클릭만 통과시킨다 = 히트면이
    // 없던 판. 노드도 색도 그대로라 「보이니까 반응한다」만 사라진다.
    await page.addStyleTag({
      content: '[data-testid="ade-scrim"]{pointer-events:none!important}',
    });
  }
  await page.mouse.click(1000, 400);
  await page
    .getByTestId("ade-drawer")
    .waitFor({ state: "detached", timeout: 3_000 })
    .catch(() => {});
  if ((await page.getByTestId("ade-drawer").count()) !== 0) {
    throw new Error(
      "clicking the uncovered route did nothing: 서랍이 라우트를 못 쓰게 해 놓고 바깥 클릭도 받지 않았다"
    );
  }
  if ((await panelInert()) !== false) {
    throw new Error(
      "a covered sibling stayed in the tab order: 서랍이 닫혔는데 작업 패널의 inert 가 남았다"
    );
  }
  console.log("[outside] 덮이지 않은 라우트 클릭 -> 서랍이 닫혔다");

  // ---- 8. Esc 는 한 층만 (리뷰 H1 ①) ------------------------------------------
  await openDrawer(page);
  await page.keyboard.press("Escape");
  await page
    .getByTestId("ade-drawer")
    .waitFor({ state: "detached", timeout: 3_000 })
    .catch(() => {});
  if ((await page.getByTestId("ade-drawer").count()) !== 0) {
    throw new Error("Esc 를 눌렀는데 서랍이 닫히지 않았다 (가장 위 층이 이것이다)");
  }
  if ((await page.getByTestId("agent-work-panel").count()) !== 1) {
    throw new Error(
      "one Escape closed two layers: 서랍을 닫으려 누른 한 번이 그 아래 작업 패널까지 닫았다 (Esc 는 가장 위 층의 것이다)"
    );
  }
  // 그리고 그 다음 Esc 는 아래 층을 닫는다 — 스택이 층을 삼키지 않는다는 증명.
  await page.keyboard.press("Escape");
  await page.getByTestId("agent-work-panel").waitFor({ state: "detached" });
  console.log("[esc] 첫 Esc = 서랍만 · 둘째 Esc = 작업 패널");

  await context.close();
}

// ---- 5. 빈 상태 --------------------------------------------------------------

async function exerciseEmpty(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  // 종료된 세션만 있는 원장. 「없다」와 「모른다」를 가르려고 빈 배열이 아니라
  // 끝난 것들을 낸다 — 빈 배열이면 목이 아무 말도 안 한 것과 구별되지 않는다.
  await installRoutes(context, {
    sessions: BASE_SESSIONS.filter((s) => s.status === "ended"),
  });
  await login(page);
  await wait(1_500);

  if ((await page.getByTestId("ade-summary").count()) !== 0) {
    const text = await page.getByTestId("ade-summary").textContent();
    throw new Error(
      `살아 있는 작업이 0인데 요약 줄이 있다: "${text}" (빈 자리도 남기지 않는 것이 이 줄의 계약이다)`
    );
  }
  // 예약된 빈 띠도 없다: 라우트 맨 위는 채널 헤더가 받는다.
  const topOfRoute = await page.evaluate(() => {
    const header = document.querySelector("main header");
    const main = document.querySelector("main");
    if (header === null || main === null) return null;
    return Math.round(
      header.getBoundingClientRect().y - main.getBoundingClientRect().y
    );
  });
  console.log(`[empty] 요약 줄 없음 · 라우트 상단 여백 ${topOfRoute}px`);
  if (topOfRoute === null || topOfRoute > 4) {
    throw new Error(
      `작업이 0인데 라우트 위에 ${topOfRoute}px 가 예약돼 있다`
    );
  }
  await context.close();
}

// ---- 15. 발원 대화 앵커 (#1193) ----------------------------------------------

async function exerciseAnchor(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRedSeams(page);
  await installRoutes(context, { messages: GENERAL_MESSAGES });
  await login(page);

  // 턴 하나를 연다. 「앵커가 없는 카드에는 동사가 없다」는 주장은 그 카드가
  // 목록에 **있을 때만** 검사할 수 있다.
  await publish(page, statusFrame(agentId, generalId, "queued", "queued"));
  await publish(page, statusFrame(agentId, generalId, "streaming", "running"));
  await page.getByTestId("ade-summary").waitFor({ timeout: 15_000 });
  await openDrawer(page);

  if (proveRedZigzag) {
    // red seam: 유령 칸의 **자리만** 없앤다(노드도 React 상태도 그대로). 칸이
    // 세션 카드에만 서던 1차 판이 그대로 재현되고, 턴 행의 내용 열이 그만큼
    // 넓어져 상태·경과의 오른쪽 끝이 카드 종류에 따라 갈린다.
    await page.addStyleTag({
      content:
        '[data-testid="ade-card-anchor-ghost"]{display:none!important}',
    });
  }

  // ① 동사는 세션 카드에만 선다. 죽은 버튼 금지 — 턴에는 원장 행이 없고,
  //    따라서 발원 메시지도 없다.
  const verbs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="ade-card"]')].map((card) => ({
      kind: card.dataset.kind,
      title:
        card.querySelector('[data-testid="ade-card-title"]')?.textContent ?? "",
      // 형제로 서므로 카드가 아니라 **행**에 묻는다.
      hasVerb:
        card.parentElement?.querySelector('[data-testid="ade-card-anchor"]') !==
        null,
      // 동사가 없는 행은 **자리만** 갖는다 (리뷰 H1). 둘 다 없으면 그 행의
      // 내용 열이 다른 행보다 넓어지고, 목록의 오른쪽 끝이 갈린다.
      hasCell:
        card.parentElement?.querySelector(
          '[data-testid="ade-card-anchor"], [data-testid="ade-card-anchor-ghost"]'
        ) !== null,
    }))
  );
  for (const card of verbs) {
    const shouldHave = card.kind === "session";
    if (card.hasVerb !== shouldHave) {
      throw new Error(
        `the anchor landed on the wrong line: ${card.kind} 카드 "${card.title}" 에 「대화로」가 ${
          card.hasVerb ? "섰다" : "없다"
        } (세션 카드만 발원 메시지를 안다)`
      );
    }
    if (!card.hasCell) {
      throw new Error(
        `the list zigzagged: ${card.kind} 카드 "${card.title}" 에 액션 칸이 아예 없다 (동사가 없는 행도 자리는 지킨다)`
      );
    }
  }
  console.log(
    `[anchor] 동사 ${verbs.filter((c) => c.hasVerb).length}/${verbs.length} 장 (세션만), 칸은 ${verbs.length}장 전부`
  );

  // ② 정렬 (리뷰 H1). 상태 칩 + 경과 열은 **모든 행에서 같은 오른쪽 끝**을 갖는다.
  //    1차 판은 액션 칸이 세션 카드에서만 서서 그 모서리가 카드 종류에 따라
  //    번갈았고(실측 806 / 861), 목록에서 눈이 따라가는 것이 정확히 그 선이다.
  const edges = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="ade-card"]')].map((card) => ({
      kind: card.dataset.kind,
      title:
        card.querySelector('[data-testid="ade-card-title"]')?.textContent ?? "",
      right: Math.round(
        card
          .querySelector('[data-testid="ade-card-elapsed"]')
          ?.getBoundingClientRect().right ?? -1
      ),
    }))
  );
  const distinct = [...new Set(edges.map((row) => row.right))];
  if (distinct.length !== 1) {
    const spread = edges
      .map((row) => `${row.kind}:${row.title.trim()}=${row.right}`)
      .join(" · ");
    throw new Error(
      `the list zigzagged: 상태·경과 열이 오른쪽 끝을 ${distinct.length} 개 갖는다 (${spread}) — 액션 칸이 있는 행과 없는 행이 다른 폭을 쓰고 있다`
    );
  }
  console.log(
    `[anchor] 상태·경과 오른쪽 끝 ${distinct[0]}px, ${edges.length}행 공통`
  );

  // ③ 착지. 하이라이트가 붙은 **그 행**의 seq 를 잡아 둔다 — 표식은 1.6초 뒤
  //    스스로 걷히므로, 클릭 뒤에 물어보면 늦을 수 있다.
  const armLandingProbe = () =>
    page.evaluate(() => {
      window.__adeAnchorLandedSeq = null;
      if (window.__adeAnchorObserver !== undefined) return;
      const look = () => {
        if (window.__adeAnchorLandedSeq !== null) return;
        const hit = document.querySelector(
          '[data-testid="timeline-message"].bg-accent-soft'
        );
        if (hit !== null) {
          window.__adeAnchorLandedSeq = Number(hit.getAttribute("data-seq"));
        }
      };
      window.__adeAnchorObserver = new MutationObserver(look);
      window.__adeAnchorObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    });

  // 히스토리를 실은 방의 카드다. 목록 맨 위(대기 카드)는 다른 방의 것이고, 그
  // 방에는 이 게이트가 대화를 싣지 않았다 — 아무 카드나 누르면 이 검사는
  // 「착지가 틀렸다」와 「그 방에 히스토리가 없다」를 구별하지 못한다.
  const anchorButton = page.locator(
    `[data-testid="ade-card-anchor"][aria-label^="${BASE_SESSIONS[0].label}"]`
  );
  const target = await anchorButton.getAttribute("aria-label");

  /**
   * 한 번 누르고, 착지한 줄의 seq 와 그때의 주소를 본다.
   *
   * **두 번 부른다** (리뷰 B2). 착지한 뒤 아래로 읽어 내려가고 서랍을 다시 열어
   * 같은 카드를 누르는 것이 이 컨트롤의 자연스러운 왕복인데, 1차 판은 그 두
   * 번째에서 아무 일도 하지 않았다 — 주소가 첫 번째와 글자 단위로 같아 라우터가
   * 아무것도 알리지 않았기 때문이다. 서랍은 닫히므로 성공처럼 보인다.
   */
  const press = async (label) => {
    await armLandingProbe();
    if (proveRedDeep) {
      // red seam: 여기서부터만 목록의 스크롤 명령을 삼킨다 (#1199 N-d). 첫 페이지
      // 착지와 따라가기는 이미 끝났으므로 사라지는 것은 `bringIntoView` 한 번뿐이고,
      // 그것이 정확히 리뷰 B1 이전의 판이다.
      await page.evaluate(() => {
        window.__adeBlockTimelineScroll = true;
      });
    }
    await anchorButton.click();
    await page.getByTestId("ade-drawer").waitFor({ state: "detached" });
    const seq = await page
      .waitForFunction(() => window.__adeAnchorLandedSeq, undefined, {
        timeout: 10_000,
      })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    const hash = await page.evaluate(() => location.hash);
    if (seq !== ANCHOR_SEQ) {
      throw new Error(
        `the anchor landed on the wrong line: ${label}에 "${target}" 를 눌렀는데 표식이 선 줄은 seq ${seq} 다 (원장이 뜻한 줄은 ${ANCHOR_SEQ}, 주소는 ${hash}). 이 방은 ${GENERAL_DEPTH}줄이고 앵커는 가상 창 밖이다 — 로드된 줄을 못 찾는 착지는 착지가 아니다`
      );
    }
    // 읽고 나면 주소에서 지운다(`?work=` 와 같은 규율). 남으면 두 번째 누름이
    // 같은 주소가 되어 아무 일도 일어나지 않는다.
    if (hash.includes("msg=")) {
      throw new Error(
        `the anchor landed on the wrong line: ${label} 뒤에도 주소가 앵커를 들고 있다 (${hash}) — 다음 누름은 같은 주소라 아무 일도 일어나지 않는다`
      );
    }
    return { seq, hash };
  };

  // 창 밖의 줄에 처음 내려앉는다. 이 방은 80줄이라 앵커는 DOM 에 없다.
  const first = await press("첫 누름");
  if ((await page.getByTestId("chat-anchor-missed").count()) !== 0) {
    throw new Error(
      "the anchor landed on the wrong line: 착지했는데 「더 불러오세요」가 함께 서 있다 — 이미 로드된 줄에 대고 하는 거짓 지시다"
    );
  }
  console.log(`[anchor] 첫 누름: 착지 seq ${first.seq} · 주소 정리됨`);

  // 같은 카드를 한 번 더. 사람이 실제로 하는 왕복이고, 두 번째가 무동작이면
  // 서랍만 닫혀 성공처럼 보인다.
  await page.getByTestId("ade-summary").click();
  await page.getByTestId("ade-drawer").waitFor();
  const second = await press("두 번째 누름");
  console.log(`[anchor] 두 번째 누름: 착지 seq ${second.seq}`);

  await context.close();
}

// ---- 캡처 (판정하지 않는다, SKILL §11) ---------------------------------------

async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/ade");
  mkdirSync(outDir, { recursive: true });
  const shots = [];
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context, {});
    await login(page);
    await publish(page, statusFrame(agentId, generalId, "queued", "queued"));
    await publish(page, statusFrame(agentId, generalId, "streaming", "running"));
    await publish(page, statusFrame(hermesId, engineId, "queued", "queued"));
    await publish(
      page,
      statusFrame(hermesId, engineId, "awaiting_approval", "awaiting_approval")
    );
    await page.getByTestId("ade-summary").waitFor({ timeout: 15_000 });
    const closed = resolve(outDir, `ade-summary-${scheme}.png`);
    await page.screenshot({ path: closed });
    shots.push(closed);

    await openDrawer(page);
    const open = resolve(outDir, `ade-drawer-${scheme}.png`);
    await page.screenshot({ path: open });
    shots.push(open);

    // 좁은 폭: 서랍이 표면을 통째로 받는 판(tokens.css 600px 문턱).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("ade-drawer").waitFor();
    const narrow = resolve(outDir, `ade-drawer-narrow-${scheme}.png`);
    await page.screenshot({ path: narrow });
    shots.push(narrow);

    await context.close();
  }
  console.log(
    "[shots] artifacts/ade/ade-{summary,drawer,drawer-narrow}-{light,dark}.png"
  );
  return shots;
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "ADE_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      await exerciseControl(browser);
      await exerciseEmpty(browser);
      await exerciseAnchor(browser);
      await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: 집계가 원장과 일치하고(종료 제외·유휴는 줄을 켜지 않음),");
  console.log("           대기가 잉크와 순서 양쪽에서 강조되며, 서랍은 라우트를");
  console.log("           한 픽셀도 밀지 않고, 기기 종속 세션은 지속을 주장하지");
  console.log("           않으며, 작업 0에서는 줄 자체가 없다. 카드는 두 종류 다");
  console.log("           살아 있는 표면으로 확대되고, Esc 한 번은 한 층만 닫으며,");
  console.log("           덮인 형제는 탭 순서에서 빠지고, 덮이지 않은 라우트는");
  console.log("           눌리면 서랍을 닫는다 — 남는 것은 띠가 아니라 한 칸이다.");
  console.log("           D3: 재개와 인수가 다른 낱말·다른 버튼으로 갈리고,");
  console.log("           자격 대상이 없는 인수는 확정 버튼 대신 「무엇을 하면");
  console.log("           되는지」를 세우며, 복원 고지는 잃는 것을 이름으로 말한다.");
  console.log("           #1193: 세션 카드의 「대화로」가 80줄 방에서 — 앵커가");
  console.log("           가상 창 밖인 그 방에서 — 원장이 뜻한 줄에 내려놓고(seq 로");
  console.log("           잰다), 두 번째 누름도 같은 곳에 내려놓으며, 주소는 읽고");
  console.log("           나면 비워지고, 액션 칸은 모든 행에 있어 상태·경과 열이");
  console.log("           오른쪽 끝 하나를 공유하며, 앵커 없는 턴 카드에는 동사가");
  console.log("           서지 않는다.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
