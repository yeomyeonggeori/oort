#!/usr/bin/env node
// GATE: 채널 머리의 컨트롤이 긴 이름에도 뷰포트 안에 남는다 (#4230, 검증 줄 3회차 Blocker B1) + 제목이 읽히는 몫을 지킨다 (#5206 · #5184 · #5198).
//
// 이 게이트가 지키는 것은 「머리가 그려진다」가 아니라 **지원하는 모든 폭에서 컨트롤이 보이고 닿는가**다.
// 판(`app-pane`)과 셸이 `overflow: clip`이라 머리 밖으로 밀린 단추는 스크롤로도 드러나지 않고, 키보드 초점은 보이지 않는
// 단추에 내려앉는다(루브릭 Detail SLA: 늘 Blocker). 문서에 가로 스크롤이 안 생기는지(`gate:channel-header`가 390에서 잰다)로는
// 이것을 못 잡는다: 잘린 단추는 문서 폭을 키우지 않는다.
//
// 장면 하나(폭 × 글자 크기 × 밀도)마다 재는 것:
//   1. 뷰포트        머리의 모든 컨트롤(서랍 단추 포함)과 Live 칩의 상자가 뷰포트 안이다.
//   2. 겹침          컨트롤끼리, 컨트롤과 종류 아이콘·제목·토픽·핸들이 겹치지 않는다. 판이 좁아 줄이 바뀌어도 그렇다.
//   3. 히트 테스트   각 컨트롤의 가운데와 양 끝 안쪽 점을 `elementFromPoint`로 짚으면 그 컨트롤이 나온다:
//                    조상의 `overflow: clip`에 잘렸거나 다른 상자에 덮였으면 여기서 걸린다.
//   4. 머리 안쪽     머리 자신이 가로로 넘치지 않는다(`scrollWidth ≤ clientWidth`).
//   5. 제목          한 줄이고, 말줄임이어도 글(낭독)과 `title`(툴팁)은 전문 그대로다. 1440에서는 이름이 다 들어갈 자리가 있으므로 잘리지 않는다
//                    (단추를 먼저 챙기느라 제목을 필요 이상 깎지 않는다). DM 제목의 `title`·낭독 이름에는 구분용 핸들이 들어 있다.
//   6. 오른쪽 끝     컨트롤 묶음은 줄이 바뀌어도 머리 안쪽 오른쪽 끝에 붙는다(`channel-head-tools`의 `margin-inline-start: auto`).
//   7. 줄바꿈 정책   컨트롤이 제목 아랫줄로 내려가는 것은 **옆에 제목 몫(바닥)이 모자랄 때만**이다. 바닥은 폰 폭(600 미만)이 3rem,
//                    넓은 창(600 이상)이 **제목 글자 8자 몫**(`--text-heading` × 8)이다. 뷰포트 안인지만 보면 「바닥을 지킨다」는 약속이 깨져도
//                    (필요 없이 줄이 바뀌거나, 반대로 제목이 바닥 밑으로 깎인다) 초록이다. 그래서 양방향을 잰다.
//   8. 제목 몫       컨트롤이 제목 옆에 서 있으면 제목은 전문이 다 보이거나 바닥 이상이다(#5206: 720~768에서 53~101px로 줄지 않는다).
//   9. 핸들          같은 이름 DM의 핸들은 통째로 보이거나 통째로 숨는다(「@」 조각 금지). 보이는 핸들은 제 칸 안이고 뷰포트 안이다.
//  10. ⋮ 외톨이      컨트롤이 여러 줄이면 ⋮가 혼자 한 줄을 차지하지 않는다(#5206).
//  11. 허들          Live 칩은 고정 폭이고 조각나지 않는다. 참가자 이름 글은 **제목이 다 선 뒤 남는 폭**만 받는다: 제목이 잘렸는데 이름 글이
//                    폭을 가지면 어긴 것이다(#5184 「칩이 제목보다 먼저 줄어요」). 이름 글은 보이면 조각이 아니다. 허들 장면은 720·744·768·390·900에서
//                    머리가 두 줄 이내다.
//  12. 툴팁         컨트롤마다 키보드 초점으로 툴팁을 열면 그 상자가 자기를 자르는 판(`.app-pane`, `overflow: clip`)과 창 안이고, 네 줄 안이며, 글이 상자를 넘지 않는다.
//                    툴팁은 포털이 아니라 판 안에 그려져서 가장자리를 넘으면 글자가 잘린다(B1 캡처의 「툴팁도 잘려요」).
//                    줄이 바뀐 아랫줄의 첫 단추와, 이름을 글에 담는 ⋮(「{이름} 채널 메뉴」)가 그 경우다.
//  13. 장면이 진짜다 기대한 단추 집합이 그대로 서 있고, 글자 크기·밀도 속성이 **계산된 값**에 실제로 닿았다. 글자 크기는 제목의 계산된
//                    `font-size`(px)를 숫자로 읽어 기준(기본 단계 값) × 배율과 대 본다(#5198: 예전에는 `--type-scale`의 `calc()` 문자열을 숫자로
//                    읽어 NaN이 되었고, NaN 비교는 늘 통과였다). 읽은 값이 숫자가 아니면 그 자체가 어긴 것이다.
//
// 폭은 표(320·390·600·720·744·768·900·1440)만이 아니라 **16px 간격 훑기**(320~1440)도 한다. 줄이 바뀌는 문턱과 제목 칸이 바닥에 닿는
// 폭은 표의 폭 사이에 있고, 레이아웃 결함은 그 문턱에서 나온다(표의 폭만으로는 핸들·바닥 단정이 한 번도 문턱을 못 밟는다).
//
// 장면: 이름 {한글·영문·이모지·짧은 이름} × 토픽 {없음·긴 토픽} + DM {긴 상대 이름, 같은 이름(핸들) 긴 이름·짧은 이름}
//       + 허들 {참가 가능(칩 + 참가 단추), 참가 중(칩 + 마이크 묶음 + 나가기)} × 긴 참가자 요약(참가자 5명: 이름 둘 + 「외 3명」)
//       × 폭 × 글자 크기 {작게·기본·크게} × 밀도 {촘촘·편하게·여유} × 계획 독 {있음·없음}.
//       독이 있는 장면은 작업 호스트가 온라인이고 12단계 계획의 세션이 도는 대화다(독 배지 두 자리, 터미널 단추도 선다).
//       멤버 12명(멤버 수 두 자리).
//
//   npm run gate:channel-header-fit                       # 이 체크아웃을 `huddle-gate` 모드로 빌드해(허들 접속을 가짜로 대신한다) 크로미엄에서 잰다
//   HEADER_FIT_ENGINES=chromium,webkit npm run gate:channel-header-fit   # 데스크탑 셸(WKWebView)과 같은 웨빗까지
//   HEADER_FIT_GATE_DIST=/path/to/dist node gates/gate-channel-header-fit.mjs   # 다른 빌드(고치기 전)를 재서 빨간 불을 확인한다
//   HEADER_FIT_GATE_SHOTS=/tmp/shots [HEADER_FIT_GATE_SCHEME=dark] [HEADER_FIT_GATE_SHOT_WIDTHS=720,760,600,390]   # 장면마다 머리 스크린샷(기본 글자 크기·밀도)
//   HEADER_FIT_SHOTS_ONLY=1 HEADER_FIT_GATE_SHOTS=…        # 캡처만(훑기·판정 없음): 고치기 전 빌드와 전·후를 같은 장면으로 찍을 때
//   HEADER_FIT_GATE_LOCALE=en-US                           # 기본은 ko-KR(캡처와 같다): 영어 문구도 같은 기하여야 한다
//   HEADER_FIT_ONLY=ko+joined,dm+handle-short [HEADER_FIT_WIDTHS=720,744]   # 개발용 부분 실행(장면 id·폭 거르기). 부분 실행은 PASS 줄에 그렇게 적힌다
//
// 백엔드 없음: `/v1`은 아래 모의로 채운다(`gates/gate-channel-header.mjs`와 같은 방식). 번들 크로미엄·웨빗(헤드리스)만 쓴다.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HEADER_FIT_GATE_PORT || 5242);
const origin = `http://127.0.0.1:${port}`;
const distOverride = process.env.HEADER_FIT_GATE_DIST
  ? resolve(process.env.HEADER_FIT_GATE_DIST)
  : null;
const shotsDir = process.env.HEADER_FIT_GATE_SHOTS
  ? resolve(process.env.HEADER_FIT_GATE_SHOTS)
  : null;
const scheme = process.env.HEADER_FIT_GATE_SCHEME === "dark" ? "dark" : "light";
const locale = process.env.HEADER_FIT_GATE_LOCALE || "ko-KR";
const engineNames = (process.env.HEADER_FIT_ENGINES || "chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const ENGINES = { chromium, webkit };
const csv = (value) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
/** 개발용 부분 실행. 비어 있으면 전부 잰다. */
const onlyScenes = csv(process.env.HEADER_FIT_ONLY);
const onlyWidths = csv(process.env.HEADER_FIT_WIDTHS).map(Number);
/** 캡처 전용 폭(기본은 표의 폭). 판정에는 안 쓴다: 표에 없는 760 같은 폭도 같은 장면으로 찍는다. */
const shotWidthsOverride = csv(process.env.HEADER_FIT_GATE_SHOT_WIDTHS).map(Number);
/** 개발용: 판정과 별개로 상태마다 측정값을 한 줄씩 찍는다. */
const dump = process.env.HEADER_FIT_DUMP === "1";
/** 캡처 전용: 훑기·툴팁 판정을 건너뛰고 장면마다 머리 스크린샷만 찍는다(고치기 전 빌드의 전·후 비교 캡처용, 판정 없음). */
const shotsOnly = process.env.HEADER_FIT_SHOTS_ONLY === "1";

// ---- 장면 표 -----------------------------------------------------------------------------

const WIDTHS = [320, 390, 600, 720, 744, 768, 900, 1440];
/** 16px 간격 훑기. 표의 폭은 글자 크기 3 × 밀도 3을 다 곱하고, 훑기 폭은 두 극단(기본·편하게 / 크게·여유롭게)만 곱한다. */
const SWEEP_WIDTHS = Array.from({ length: (1440 - 320) / 16 + 1 }, (_, index) => 320 + index * 16);
const HEIGHT = 800;
/**
 * 제목 칸의 바닥. `tokens.css` `channel-head-body`: 폰 폭(600 미만)은 `3rem`(루트 16px), 넓은 창(600 이상)은
 * `--text-heading` × 8(제목 글자 8자 몫, 글자 크기 설정을 따른다). 넓은 창의 바닥은 제목의 계산된 글자 크기(px) × 8로 읽는다.
 */
const TITLE_FLOOR_PHONE = 48;
const TITLE_FLOOR_EM = 8;
const titleFloor = (viewportWidth, fontPx) =>
  viewportWidth >= 600 ? TITLE_FLOOR_EM * fontPx : TITLE_FLOOR_PHONE;
/** 머리가 두 줄 이내여야 하는 허들 장면의 폭(#5184: 720·390, 댓글로 900 추가; 744·768은 #5206의 문턱 구간). */
const TWO_LINE_WIDTHS = [390, 720, 744, 768, 900];
/**
 * 두 줄 머리의 높이 상한(px). 줄 수를 컨트롤의 세로 위치로만 세면 줄 수 계산이 틀어질 때 놓치므로 머리의 실제 높이도 잰다.
 * 실측: 두 줄은 폰 폭 95(서랍 단추 44 + 틈 4 + 컨트롤 34 + 여백 12, 글자 크게 약 97), 넓은 창 72(제목 22 + 4 + 34 + 12, 크게 약 74),
 * 세 줄은 110 이상. 둘 사이의 105에서 가른다.
 */
const MAX_TWO_LINE_HEADER_PX = 105;
/**
 * 참가자 이름 글이 서는 꼬리 칸의 문턱(`channel-head-names`: 꼬리 칸이 8rem 이상일 때만 선다)에서 토픽의 왼쪽 여백(`ms-1`, 4px)을 뺀 값.
 * 이름 글과 토픽이 한 꼬리에 서면 토픽의 여백 4px이 이름 글 몫에서 빠진다. 보이는 이름 글은 이보다 좁은 조각이 아니다.
 */
const NAMES_MIN_PX = 8 * 16 - 4;
/** 참가 중의 Live 칩·이름 글이 서는 머리 안쪽 폭의 문턱(`channel-head-live-joined`: 26rem). 이 밑이면 둘이 함께 양보한다. */
const JOINED_CHIP_MIN_INNER = 26 * 16;
/** 줄바꿈한 툴팁의 줄 수 상한. 긴 영문 이름(85자)이 폰 320에서 세 줄이다: 판에 맞추려고 폭을 너무 좁혀 길쭉해지면 넘는다. */
const TOOLTIP_MAX_LINES = 4;
/** 글자 크기·밀도의 루트 속성 값. 계산된 값은 `design/appearance/{typography-scale,density}.css`가 정한다. */
const FONT_SIZES = [
  { id: "smaller", scale: 14 / 15 },
  { id: "default", scale: 1 },
  { id: "larger", scale: 16 / 15 },
];
const DENSITIES = [
  { id: "compact", row: 4 },
  { id: "comfortable", row: 6 },
  { id: "spacious", row: 8 },
];

const NAMES = {
  ko: "릴리스-2026-08-온콜-교대-배포-판단-고객-영향-롤백-조건-기록-점검-회의",
  en: "release-2026-08-oncall-handover-deploy-decision-customer-impact-rollback-criteria",
  emoji: "🚀🔥-launch-war-room-🧯-롤백-🎯-고객-영향-점검-회의-👩🏽‍💻👨🏻‍🚀",
  short: "general",
  latin: "channelnamewithoutanyhyphenorspaceatallkeepsgoingandgoingforalongtimeuntilitends",
};
const LONG_TOPIC =
  "release-2026-08 운영 토픽: 온콜 교대, 배포 판단, 고객 영향, 롤백 조건을 이 채널에서 함께 기록합니다. " +
  "긴 문장도 헤더의 다른 컨트롤을 밀어내지 않으며, 전체 내용은 키보드로 열어 읽을 수 있어야 합니다.";
const LONG_PEER = "곽성재님의 아주아주 긴 이름을 가진 에이전트 어시스턴트 (운영팀 온콜 담당)";
const SHORT_PEER = "이도현";
/** 허들 참가자 5명: 요약은 앞의 둘과 「외 3명」(`huddleParticipantSummary`)이라 긴 이름 둘이면 한 줄이 300px 가까이 된다. */
const HUDDLE_PARTICIPANTS = [
  "Nadia Rahman — 제품 디자인 운영",
  "곽성재 — 웹 클라이언트 담당",
  "이도현",
  "팀원 1",
  "팀원 2",
];

const SCENES = [
  { id: "ko", kind: "channel", name: NAMES.ko, topic: "" },
  { id: "en", kind: "channel", name: NAMES.en, topic: "" },
  { id: "emoji", kind: "channel", name: NAMES.emoji, topic: "" },
  // 하이픈도 공백도 없는 긴 이름: 줄바꿈 지점이 없어서 툴팁의 `overflow-wrap`이 없으면 글이 상자를 넘는다.
  { id: "latin", kind: "channel", name: NAMES.latin, topic: "" },
  { id: "ko+topic", kind: "channel", name: NAMES.ko, topic: LONG_TOPIC },
  { id: "short+topic", kind: "channel", name: NAMES.short, topic: LONG_TOPIC },
  { id: "dm", kind: "dm", name: LONG_PEER, topic: "" },
  // 같은 이름의 멤버가 둘이면 DM 제목 옆에 구분용 핸들(`@dohyun`)이 선다.
  { id: "dm+handle", kind: "dm", name: LONG_PEER, topic: "", ambiguous: true },
  // 짧은 이름의 같은 이름 DM: 넓은 폭에서는 핸들이 통째로 서야 한다(늘 숨기기만 하는 구현이 초록이 되지 않게).
  { id: "dm+handle-short", kind: "dm", name: SHORT_PEER, topic: "", ambiguous: true },
  // 허들(#5184): `active` = 참가 가능(칩 + 참가 단추), `joined` = 참가 중(칩 + 마이크 묶음 + 나가기).
  { id: "ko+huddle", kind: "channel", name: NAMES.ko, topic: "", huddle: "active" },
  { id: "ko+joined", kind: "channel", name: NAMES.ko, topic: "", huddle: "joined" },
  { id: "ko+topic+huddle", kind: "channel", name: NAMES.ko, topic: LONG_TOPIC, huddle: "active" },
  { id: "short+topic+joined", kind: "channel", name: NAMES.short, topic: LONG_TOPIC, huddle: "joined" },
];

// ---- 모의 서버 ----------------------------------------------------------------------------

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ownerId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channelId = "00000000-0000-7000-8000-000000000201";
const dmChannelId = "00000000-0000-7000-8000-000000000202";
const hostId = "00000000-0000-7000-8000-000000000401";
const sessionId = "00000000-0000-7000-8000-000000000501";
const rootId = "0199cccc-0000-7000-8000-0000000000b1";
const huddleId = "00000000-0000-7000-8000-000000000643";
const AT = 1_785_238_400_000;
const MEMBER_COUNT = 12;

const json = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

function rosterMember(over) {
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

function roster(scene) {
  const members = [
    rosterMember({
      id: ownerId,
      kind: "human",
      role: "owner",
      displayName: "곽성재",
      handle: "seongjae",
      channelIds: [channelId, dmChannelId],
    }),
  ];
  for (let index = 1; index < MEMBER_COUNT; index += 1) {
    const id = `00000000-0000-7000-8000-0000000003${String(index).padStart(2, "0")}`;
    members.push(
      rosterMember({
        id,
        kind: "human",
        displayName: `팀원 ${index}`,
        handle: `member-${index}`,
      })
    );
  }
  members.push(
    rosterMember({
      id: peerId,
      kind: "human",
      displayName: scene.kind === "dm" ? scene.name : "이도현",
      handle: "dohyun",
      channelIds: [dmChannelId],
    })
  );
  if (scene.ambiguous) {
    members.push(
      rosterMember({
        id: "00000000-0000-7000-8000-000000000199",
        kind: "human",
        displayName: scene.name,
        handle: "dohyun-2",
      })
    );
  }
  return members;
}

function channels(scene) {
  if (scene.kind === "dm") {
    return [
      { id: channelId, workspaceId, kind: "public", name: "general", topic: "", muted: false },
      { id: dmChannelId, workspaceId, kind: "dm", muted: false, memberIds: [ownerId, peerId] },
    ];
  }
  return [
    {
      id: channelId,
      workspaceId,
      kind: "public",
      name: scene.name,
      topic: scene.topic,
      muted: false,
    },
  ];
}

function planFrame() {
  // 12단계 중 1단계 완료: 남은 11 → 독 배지가 두 자리다(가장 넓은 독).
  const plan = Array.from({ length: 12 }, (_, index) => ({
    content: `단계 ${index + 1}`,
    status: index < 1 ? "completed" : index === 1 ? "in_progress" : "pending",
  }));
  return {
    channelId,
    hlcCount: 0,
    type: "text",
    state: "sent",
    authorMemberId: ownerId,
    body: "",
    seq: 2,
    id: "0199cccc-0000-7000-8000-0000000000b2",
    hlcTs: AT,
    createdAtMs: AT,
    rootId,
    props: {
      kind: "work_session_event",
      schema: "momo.work_session.acp_event.v1",
      event_type: "agent.status",
      event_id: "header-fit-event-1",
      event_ts: AT,
      event: { work_session_id: sessionId, plan, has_plan: true, phase: "running" },
    },
  };
}

/** 서 있는 허들(참가자 5명). 채널 장면에서만 쓴다. */
function activeHuddle() {
  return {
    id: huddleId,
    workspaceId,
    channelId,
    startedBy: ownerId,
    startedAtMs: AT,
    endedAtMs: null,
    participants: HUDDLE_PARTICIPANTS.map((displayName, index) => ({
      memberId: `00000000-0000-7000-8000-0000000007${String(index).padStart(2, "0")}`,
      displayName,
      joinedAtMs: AT + index * 1_000,
    })),
  };
}

async function installRoutes(context, scene, withPlan) {
  /** 계획 독이 서는 대화: 세션이 이 대화에서 돈다(`planSessionsOf`가 채널로 거른다). */
  const sessionChannelId = scene.kind === "dm" ? dmChannelId : channelId;
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/v1/auth/login") {
      return json(route, {
        accessToken: "gate-only-not-a-credential",
        refreshToken: "gate-only-not-a-credential",
        member: { id: ownerId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
        realtimeWebSocketUrl: "ws://header-fit-gate.invalid/connection/websocket",
      });
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId: ownerId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: "gate-only-not-a-credential",
        refreshToken: "gate-only-not-a-credential",
      });
    }
    if (path.endsWith("/roster") || (path.endsWith("/members") && method === "GET")) {
      return json(route, { members: roster(scene) });
    }
    if (path.endsWith("/channels")) return json(route, { channels: channels(scene) });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith("/huddles/active")) {
      return json(route, { huddle: scene.huddle ? activeHuddle() : null });
    }
    if (scene.huddle && path.endsWith(`/huddles/${huddleId}/join`)) {
      return json(route, {
        huddle: activeHuddle(),
        livekitUrl: "wss://livekit.gate.invalid",
        token: "gate-only-not-a-credential",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
      });
    }
    if (scene.huddle && path.endsWith(`/huddles/${huddleId}/leave`)) {
      return json(route, { huddle: activeHuddle(), ended: false });
    }
    if (path.endsWith("/work-hosts")) {
      return json(route, {
        workHosts: withPlan
          ? [
              {
                id: hostId,
                workspaceId,
                scope: "workspace",
                ownerMemberId: ownerId,
                type: "mac",
                displayName: "gate-host",
                capabilities: {},
                createdAtMs: 0,
                online: true,
                lastSeenAtMs: Date.now(),
              },
            ]
          : [],
      });
    }
    if (path.endsWith("/work-sessions")) {
      return json(route, {
        workSessions: withPlan
          ? [
              {
                id: sessionId,
                workspaceId,
                channelId: sessionChannelId,
                memberId: ownerId,
                hostId,
                rootMessageId: rootId,
                tool: "claude",
                label: "계획",
                status: "running",
                observation: "open",
                observerGrantCount: 0,
                remoteAttachAvailable: false,
                remoteDisplayAvailable: false,
                startedAtMs: Date.now() - 60_000,
              },
            ]
          : [],
      });
    }
    if (path.endsWith("/pins")) return json(route, { pins: [] });
    if (path.endsWith(`/messages/${rootId}/replies`)) {
      return json(route, { messages: withPlan ? [planFrame()] : [] });
    }
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.endsWith("/messages")) {
      if (url.searchParams.has("after")) return json(route, { messages: [] });
      return json(route, {
        messages: [
          {
            channelId,
            hlcCount: 0,
            type: "text",
            state: "sent",
            authorMemberId: peerId,
            body: "온콜 교대는 매주 화요일 10시입니다.",
            seq: 42,
            id: "0199cccc-0000-7000-8000-0000000000a1",
            hlcTs: AT + 42_000,
            createdAtMs: AT + 42_000,
          },
        ],
      });
    }
    return json(route, {});
  });
}

/** 셸이 연결을 기다리므로 최소한의 WS 스텁이 필요하다(프레임은 쓰지 않는다). */
async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = GateWebSocket.CONNECTING;
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
            replies.push({ id: command.id, connect: { client: "header-fit-gate", subs: {} } });
          } else if (command.subscribe) {
            replies.push({
              id: command.id,
              subscribe: { recoverable: true, recovered: true, epoch: "header-fit-gate", offset: 0 },
            });
          } else if (command.unsubscribe) {
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
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
  });
}

async function openScene(browser, scene, withPlan) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: HEIGHT },
    reducedMotion: "reduce",
    colorScheme: scheme,
    locale,
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, scene, withPlan);
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("header-fit@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
  if (scene.kind === "dm") {
    await page
      .locator(`[data-testid="channel-item"][data-channel-id="${dmChannelId}"]`)
      .click();
    await page.getByTestId("dm-profile-trigger").waitFor({ timeout: 15_000 });
  } else {
    await page.getByTestId("channel-item").first().click();
    await page.getByTestId("channel-title-menu").waitFor({ timeout: 15_000 });
    // 멤버 수(두 자리)가 그려진 뒤에 잰다: 명부가 늦게 오면 단추 폭이 바뀐다.
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="channel-member-count"]')
          ?.getAttribute("data-roster-status") === "ready",
      undefined,
      { timeout: 15_000 }
    );
  }
  if (scene.huddle) {
    // 서 있는 허들이면 칩 + 참가 단추가 선다. `joined`는 참가를 눌러 마이크 묶음·나가기까지 세운다
    // (접속은 `huddle-gate` 빌드가 가짜로 대신한다: `loadHuddleRuntime`).
    await page.getByTestId("huddle-join").waitFor({ timeout: 15_000 });
    await page.getByTestId("huddle-live").waitFor({ timeout: 15_000 });
    if (scene.huddle === "joined") {
      await page.getByTestId("huddle-join").click();
      await page.getByTestId("huddle-microphone").waitFor({ timeout: 15_000 });
      await page.getByTestId("huddle-leave").waitFor({ timeout: 15_000 });
    }
  }
  if (withPlan) {
    await page.getByTestId("work-plan-dock").waitFor({ timeout: 15_000 });
  }
  return { context, page };
}

// ---- 한 장면의 측정 -------------------------------------------------------------------------

/** 페이지 안에서 도는 측정. 상자·히트 테스트·계산된 값만 돌려주고, 판정은 노드 쪽에서 한다. */
function measureInPage() {
  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  };
  const visible = (element) =>
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const header = document.querySelector('[data-testid="channel-header"]');
  const group = document.querySelector('[data-testid="channel-header-controls"]');
  const drawer = document.querySelector('[data-testid="open-sidebar-drawer"]');
  const controls = [];
  const consider = (element, id) => {
    if (!element || !visible(element)) return;
    const box = element.getBoundingClientRect();
    const cy = box.top + box.height / 2;
    const points = [
      [box.left + box.width / 2, cy],
      [box.left + 3, cy],
      [box.right - 3, cy],
    ];
    const hits = points.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && element.contains(hit);
    });
    controls.push({ id, rect: rect(element), hits });
  };
  consider(drawer, "open-sidebar-drawer");
  if (group) {
    group.querySelectorAll("button").forEach((button, index) => {
      consider(button, button.getAttribute("data-testid") ?? `button#${index}`);
    });
  }
  const icon = header.querySelector("[data-head-icon]");
  const h1 = header.querySelector("h1");
  /** 제목 글이 실제로 말줄임되는 상자: 채널 제목은 h1 자신, DM 제목은 안의 이름 단추. */
  const titleEl = h1 ? (h1.querySelector("button") ?? h1) : null;
  const topic = header.querySelector('[data-testid="channel-header-topic"]');
  const handle = header.querySelector('[data-testid="channel-handle"]');
  const handleSlot = header.querySelector('[data-testid="channel-handle-slot"]');
  const names = header.querySelector('[data-testid="huddle-participants"]');
  const chip = header.querySelector('[data-testid="huddle-live"]');
  const main = header.querySelector(".channel-head-main");
  const body = header.querySelector(".channel-head-body");
  const tools = header.querySelector(".channel-head-tools");
  const h1Style = h1 ? getComputedStyle(h1) : null;
  const headerStyle = getComputedStyle(header);
  const root = document.documentElement;
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    docOverflow: root.scrollWidth > window.innerWidth,
    header: rect(header),
    headerInnerLeft: header.getBoundingClientRect().left + Number.parseFloat(headerStyle.paddingLeft),
    headerInnerRight: header.getBoundingClientRect().right - Number.parseFloat(headerStyle.paddingRight),
    columnGap: Number.parseFloat(headerStyle.columnGap),
    main: rect(main),
    body: rect(body),
    // 제목 칸 안에서 실제로 칸 틈(`gap`)을 만드는 자식 수: `display: none`이거나 절대 위치(sr-only)인 자식은 flex 항목이 아니다.
    bodyChildren: body
      ? [...body.children].filter((child) => {
          const style = getComputedStyle(child);
          return style.display !== "none" && style.position !== "absolute" && style.position !== "fixed";
        }).length
      : 0,
    tools: rect(tools),
    headerOverflow: header.scrollWidth - header.clientWidth,
    controls,
    icon: icon && visible(icon) ? rect(icon) : null,
    topic: topic && visible(topic) ? rect(topic) : null,
    // 핸들은 숨어도(둘째 줄로 가서 칸 밖에 잘림) DOM에 있다: 보이는지는 판정에서 칸 상자와 견줘 정한다.
    handle: handle
      ? {
          rect: rect(handle),
          text: handle.textContent,
          scrollWidth: handle.scrollWidth,
          clientWidth: handle.clientWidth,
        }
      : null,
    handleSlot: rect(handleSlot),
    names: names
      ? {
          rect: rect(names),
          title: names.getAttribute("title"),
          display: getComputedStyle(names).display,
          scrollWidth: names.scrollWidth,
          clientWidth: names.clientWidth,
        }
      : null,
    chip: chip && visible(chip)
      ? { rect: rect(chip), scrollWidth: chip.scrollWidth, clientWidth: chip.clientWidth }
      : null,
    h1: h1
      ? {
          rect: rect(h1),
          text: h1.textContent,
          title: h1.getAttribute("title"),
          // 말줄임되는 글 상자(채널은 h1, DM은 이름 단추)의 넘침과 그 상자 자신.
          scrollWidth: titleEl.scrollWidth,
          clientWidth: titleEl.clientWidth,
          box: rect(titleEl),
          dmLabel: h1.querySelector("button")?.getAttribute("aria-label") ?? null,
          lineHeight: Number.parseFloat(h1Style.lineHeight),
          whiteSpace: h1Style.whiteSpace,
          // 계산된 글자 크기(px): 글자 크기 설정이 배율을 곱해 낸 값이다(#5198). `--type-scale`은 calc() 문자열이라 숫자로 못 읽는다.
          fontPx: Number.parseFloat(h1Style.fontSize),
        }
      : null,
    rowSpacing: Number.parseFloat(getComputedStyle(root).getPropertyValue("--spacing-row")),
  };
}

const overlaps = (a, b) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

const fmt = (box) =>
  `[${box.left.toFixed(1)}→${box.right.toFixed(1)}, ${box.top.toFixed(1)}→${box.bottom.toFixed(1)}]`;

/** 허들 장면에서 서는 허들 단추의 id. */
function huddleControlIds(scene, width) {
  if (scene.huddle === "joined") {
    return ["huddle-microphone", ...(width >= 600 ? ["huddle-mic-devices"] : []), "huddle-leave"];
  }
  return [scene.huddle === "active" ? "huddle-join" : "huddle-start"];
}

/** 단추 집합의 기대. DM은 서는 단추가 종류마다 달라 개수 하한만 본다. */
function expectedControls(scene, withPlan, width) {
  const drawer = width < 600 ? ["open-sidebar-drawer"] : [];
  if (scene.kind === "dm") return { min: drawer.length + 2 + (withPlan ? 2 : 0) };
  const base = ["open-pin-list", "channel-member-count", ...huddleControlIds(scene, width), "channel-title-menu"];
  const dock = withPlan ? ["work-plan-dock", "open-terminal-dock"] : [];
  return { ids: [...drawer, ...dock, ...base] };
}

/** 세로 위치를 `tolerance`px 안에서 한 줄로 묶은 줄의 수. */
function countRows(tops, tolerance = 6) {
  const rows = [];
  for (const top of [...tops].sort((a, b) => a - b)) {
    if (rows.length === 0 || top - rows[rows.length - 1] > tolerance) rows.push(top);
  }
  return rows.length;
}

/** 핸들이 보이는가: 칸(한 줄 높이, `overflow: hidden`) 안에 있어야 보인다. 둘째 줄로 갔으면 칸 밖이라 잘려 안 보인다. */
function handleVisibility(m) {
  if (!m.handle) return { state: "absent" };
  const h = m.handle.rect;
  // 핸들 칸(`channel-head-handle`)이 없는 옛 빌드(고치기 전 빨간 불 확인용 `HEADER_FIT_GATE_DIST`): 칸이 없으면 핸들은 자기 상자로
  // 줄고(`truncate`) 글이 잘리면 조각이다. 보임으로 읽어 「보이는 핸들의 글이 잘렸다」 단정이 그 조각을 잡게 한다.
  if (!m.handleSlot) return h.width >= 0.5 ? { state: "shown" } : { state: "hidden" };
  const slot = m.handleSlot;
  // 상자가 없는 핸들(`display: none` 따위: 상자 크기가 0×0)은 보이지 않는다. 이 줄이 없으면 0×0 상자가 칸 안이라 「보임」으로 읽힌다.
  if (h.width < 0.5 || h.height < 0.5) return { state: "hidden" };
  const onFirstLine = h.top >= slot.top - 0.5 && h.bottom <= slot.bottom + 0.5;
  if (!onFirstLine) return { state: "hidden" };
  // 첫 줄에 있는데 칸 오른쪽을 넘으면: 칸 폭이 0이라 하나도 안 보이면 숨은 것이고, 일부가 보이면 칸이 잘라 보이는 조각이다.
  if (h.right <= slot.right + 0.5) return { state: "shown" };
  return Math.min(h.right, slot.right) - Math.max(h.left, slot.left) > 0.5
    ? { state: "fragment" }
    : { state: "hidden" };
}

/** 측정값 → 어긴 항목 문장들. */
function judge(m, ctx) {
  const problems = [];
  const add = (check, text) => problems.push({ check, text });
  const { scene, withPlan, width, fontSize, density, baseFontPx } = ctx;

  // 장면이 진짜인가: 속성이 계산된 값에 닿았고, 기대한 단추가 서 있다.
  // 글자 크기는 제목의 계산된 font-size(px)를 숫자로 읽어 기준 × 배율과 대 본다. 숫자가 아니면 그 자체가 어긴 것이다(NaN 비교는 늘 거짓이라 조용히 통과한다).
  const fontPx = m.h1?.fontPx;
  if (!Number.isFinite(fontPx)) {
    add("scene", `제목의 계산된 font-size를 숫자로 읽지 못했다(읽은 값 ${fontPx})`);
  } else if (Math.abs(fontPx - baseFontPx * fontSize.scale) > 0.05) {
    add(
      "scene",
      `글자 크기 ${fontSize.id}가 계산된 font-size에 닿지 않았다: 제목 ${fontPx.toFixed(2)}px, 기대 ${(baseFontPx * fontSize.scale).toFixed(2)}px(기본 ${baseFontPx}px × ${fontSize.scale.toFixed(4)})`
    );
  }
  if (!Number.isFinite(m.rowSpacing)) {
    add("scene", `--spacing-row를 숫자로 읽지 못했다(읽은 값 ${m.rowSpacing})`);
  } else if (Math.abs(m.rowSpacing - density.row) > 0.001) {
    add("scene", `밀도 ${density.id}가 --spacing-row ${density.row}px에 닿지 않았다(읽은 값 ${m.rowSpacing})`);
  }
  if (m.vw !== width) add("scene", `뷰포트 폭이 ${width}이어야 하는데 ${m.vw}`);
  const want = expectedControls(scene, withPlan, width);
  const got = m.controls.map((control) => control.id);
  if (want.ids) {
    const missing = want.ids.filter((id) => !got.includes(id));
    const extra = got.filter((id) => !want.ids.includes(id));
    if (missing.length > 0 || extra.length > 0) {
      add("scene", `단추 집합이 기대와 다르다: 빠짐 ${JSON.stringify(missing)} 더 있음 ${JSON.stringify(extra)}`);
    }
  } else if (got.length < want.min) {
    add("scene", `단추가 ${want.min}개 이상이어야 하는데 ${got.length}개(${got.join(", ")})`);
  }
  if (withPlan && !got.includes("work-plan-dock")) {
    add("scene", "계획 독이 선 장면인데 독이 없다");
  }
  if (scene.ambiguous && !m.handle) add("scene", "핸들 장면인데 구분용 핸들이 서지 않았다");
  // 참가 가능한 허들의 칩은 늘 선다. 참가 중의 칩은 폰 폭(600 미만, `wide-only`)과 머리 안쪽 폭이 26rem 밑일 때(`channel-head-live-joined`)
  // 마이크·나가기를 위해 먼저 양보한다(#1886 B-1, #5184). 양쪽 방향을 다 잰다: 서야 할 때 안 서도, 빠져야 할 때 서도 어긴 것이다.
  const innerWidth = m.headerInnerRight - m.headerInnerLeft;
  if (scene.huddle) {
    const chipWanted = scene.huddle === "active" || (width >= 600 && innerWidth >= JOINED_CHIP_MIN_INNER);
    if (chipWanted && !m.chip) add("scene", "허들 장면인데 Live 칩이 서지 않았다");
    if (!chipWanted && m.chip) {
      add("scene", `참가 중인데 머리 안쪽 폭 ${innerWidth.toFixed(0)}px(문턱 ${JOINED_CHIP_MIN_INNER})에서 Live 칩이 양보하지 않았다`);
    }
  }
  if (scene.huddle && !m.names) add("scene", "허들 장면인데 참가자 이름 글(huddle-participants)이 DOM에 없다");

  const handleState = handleVisibility(m);
  const shownHandle = handleState.state === "shown" ? m.handle.rect : null;

  // 1. 뷰포트
  for (const control of m.controls) {
    const r = control.rect;
    if (r.left < -0.5 || r.top < -0.5 || r.right > m.vw + 0.5 || r.bottom > m.vh + 0.5) {
      add("viewport", `${control.id} ${fmt(r)}가 뷰포트(${m.vw}×${m.vh}) 밖이다`);
    }
  }
  if (m.chip) {
    const r = m.chip.rect;
    if (r.left < -0.5 || r.top < -0.5 || r.right > m.vw + 0.5 || r.bottom > m.vh + 0.5) {
      add("viewport", `huddle-live ${fmt(r)}가 뷰포트(${m.vw}×${m.vh}) 밖이다`);
    }
  }
  if (shownHandle && (shownHandle.right > m.vw + 0.5 || shownHandle.left < -0.5)) {
    add("viewport", `handle ${fmt(shownHandle)}가 뷰포트 밖이다`);
  }

  // 2. 겹침: 컨트롤끼리, 그리고 컨트롤과 아이콘·제목·토픽·핸들·칩·이름 글.
  const namesShown = m.names !== null && m.names.display !== "none" && m.names.rect.width > 0.5;
  const boxes = [
    ...m.controls.map((control) => ({ id: control.id, rect: control.rect })),
    ...(m.chip ? [{ id: "huddle-live", rect: m.chip.rect }] : []),
    ...(m.icon ? [{ id: "head-icon", rect: m.icon }] : []),
    ...(m.h1 ? [{ id: "title", rect: m.h1.rect }] : []),
    ...(m.topic ? [{ id: "topic", rect: m.topic }] : []),
    ...(shownHandle ? [{ id: "handle", rect: shownHandle }] : []),
    ...(namesShown ? [{ id: "huddle-participants", rect: m.names.rect }] : []),
  ];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      // 칩은 허들 단추 묶음(`huddle-surface`) 안에 서서 마이크·나가기와 이웃일 뿐 겹치지 않는다.
      if (overlaps(boxes[i].rect, boxes[j].rect)) {
        add("overlap", `${boxes[i].id} ${fmt(boxes[i].rect)}와 ${boxes[j].id} ${fmt(boxes[j].rect)}가 겹친다`);
      }
    }
  }

  // 3. 히트 테스트: 눈에 보이는 단추는 실제로 그 자리에서 눌린다.
  for (const control of m.controls) {
    if (control.hits.some((ok) => !ok)) {
      add("hit", `${control.id}의 ${control.hits.map((ok) => (ok ? "o" : "x")).join("")}(가운데·왼쪽·오른쪽) 점이 단추를 짚지 못한다(잘렸거나 덮였다)`);
    }
  }

  // 4. 머리 안쪽 가로 넘침, 문서 가로 넘침.
  if (m.headerOverflow > 1) add("header-overflow", `머리가 가로로 ${m.headerOverflow}px 넘친다(자식이 머리 밖으로 나갔다)`);
  if (m.docOverflow) add("doc-overflow", "문서가 가로로 넘친다");

  // 6. 오른쪽 끝: 가장 오른쪽 컨트롤이 머리 안쪽 오른쪽 끝에 붙는다(줄이 바뀌어도).
  if (m.controls.length > 0) {
    const farRight = Math.max(...m.controls.map((control) => control.rect.right));
    if (Math.abs(farRight - m.headerInnerRight) > 1) {
      add("align", `컨트롤 묶음이 오른쪽 끝에 붙지 않았다: 가장 오른쪽 단추 ${farRight.toFixed(1)}, 머리 안쪽 끝 ${m.headerInnerRight.toFixed(1)}`);
    }
  }

  // 7. 줄바꿈 정책: 컨트롤이 아랫줄로 내려가는 것은 옆에 제목 몫(바닥)이 모자랄 때만이다.
  const floor = titleFloor(m.vw, Number.isFinite(fontPx) ? fontPx : baseFontPx);
  let separate = false;
  if (!m.main || !m.body || !m.tools) {
    add("scene", "머리 칸(channel-head-main·body·tools)이 없다");
  } else {
    separate = m.tools.top >= m.main.bottom - 0.5;
    const room =
      m.headerInnerRight - m.headerInnerLeft - m.tools.width - m.columnGap - (m.body.left - m.headerInnerLeft);
    if (separate && room >= floor + 0.5) {
      add("wrap", `컨트롤이 제목 아랫줄로 내려갔는데 옆에 제목 몫 ${room.toFixed(1)}px(바닥 ${floor.toFixed(1)} 이상)이 있었다: 필요 없이 줄을 바꿨다`);
    }
    if (!separate && m.body.width < floor - 0.5) {
      add("wrap", `컨트롤이 제목 옆에 섰는데 제목 칸이 바닥 밑이다: ${m.body.width.toFixed(1)}px < ${floor.toFixed(1)}`);
    }
  }

  // 5. 제목.
  if (!m.h1) {
    add("title", "머리에 제목(h1)이 없다");
  } else {
    const h1 = m.h1;
    if (h1.text !== scene.name && scene.kind !== "dm") {
      add("title", `제목의 글이 이름 전문이 아니다: ${JSON.stringify(h1.text)}`);
    }
    if (h1.title !== h1.text && scene.kind !== "dm") {
      add("title", `전문 툴팁(title)이 없거나 다르다: ${JSON.stringify(h1.title)}`);
    }
    if (scene.kind === "dm" && !(h1.title && h1.title.length > 0)) {
      add("title", "DM 제목에 전문 툴팁(title)이 없다");
    }
    if (h1.rect.height > h1.lineHeight * 1.5) {
      add("title", `제목이 한 줄이 아니다(높이 ${h1.rect.height.toFixed(1)} > 줄 ${h1.lineHeight})`);
    }
    if (h1.rect.width < 32) {
      add("title", `제목이 바닥(32px) 밑으로 줄었다: ${h1.rect.width.toFixed(1)}px`);
    }
    if (width === 1440 && h1.scrollWidth > h1.clientWidth + 1) {
      add("title", `1440에서 이름이 들어갈 자리가 있는데 제목이 잘렸다(${h1.scrollWidth} > ${h1.clientWidth})`);
    }

    // 8. 제목 몫(#5206): 컨트롤이 제목 옆에 서 있으면 제목은 전문이 다 보이거나 바닥 이상이다. 칸 틈(8)은 제목 몫에서 빠진다.
    if (m.body && !separate) {
      const slack = Math.max(0, m.bodyChildren - 1) * 8 + 1;
      const fullyShown = h1.scrollWidth <= h1.clientWidth + 1;
      if (!fullyShown && h1.box.width < floor - slack) {
        add(
          "title-share",
          `컨트롤 옆에서 제목이 ${h1.box.width.toFixed(1)}px(글자 ${(h1.box.width / fontPx).toFixed(1)}자 몫)만 보인다: 전문이 아니면 바닥 ${floor.toFixed(1)}px(글자 ${TITLE_FLOOR_EM}자 몫) 이상이어야 한다`
        );
      }
    }
  }

  // 9. 핸들(#5206): 통째로 보이거나 통째로 숨는다. title·낭독 이름에는 핸들이 든다.
  if (scene.ambiguous && m.handle) {
    if (handleState.state === "fragment") {
      add("handle", `핸들 ${fmt(m.handle.rect)}가 칸 ${fmt(m.handleSlot)}에서 조각으로 남았다(보이는데 칸 오른쪽을 넘는다)`);
    }
    if (handleState.state === "shown" && m.handle.scrollWidth > m.handle.clientWidth + 1) {
      add("handle", `보이는 핸들의 글이 잘렸다(${m.handle.scrollWidth} > ${m.handle.clientWidth})`);
    }
    if (m.h1 && !(m.h1.title ?? "").includes(m.handle.text)) {
      add("handle", `제목의 title ${JSON.stringify(m.h1.title)}에 핸들 ${JSON.stringify(m.handle.text)}가 없다`);
    }
    if (m.h1 && !(m.h1.dmLabel ?? "").includes(m.handle.text)) {
      add("handle", `낭독 이름(이름 단추의 aria-label) ${JSON.stringify(m.h1.dmLabel)}에 핸들 ${JSON.stringify(m.handle.text)}가 없다`);
    }
  }

  // 자리가 넉넉하면 핸들은 보인다(폭별 단정): 늘 숨기거나 늘 `display: none`인 구현은 「통째로 보이거나 숨는다」만으로는 초록이고,
  // 보임·숨음 덮개 수(`handle-coverage`)는 부분 실행(폭 거르기)에서는 안 센다. 짧은 이름은 독이 없는 600 이상에서 늘 자리가 있고,
  // 긴 이름도 독이 없는 1440에서는 자리가 있다.
  if (scene.ambiguous && !withPlan) {
    const roomy =
      (scene.id === "dm+handle-short" && width >= 600) || (scene.id === "dm+handle" && width === 1440);
    if (roomy && handleState.state !== "shown") {
      add("handle", `자리가 넉넉한 ${width}에서 핸들이 보여야 하는데 ${handleState.state}이다`);
    }
  }

  // 10. ⋮ 외톨이(#5206): 컨트롤이 여러 줄이면 ⋮가 혼자 한 줄을 차지하지 않는다.
  const groupControls = m.controls.filter((control) => control.id !== "open-sidebar-drawer");
  const controlRows = countRows(groupControls.map((control) => control.rect.top));
  const menu = groupControls.find((control) => control.id === "channel-title-menu");
  if (menu && controlRows >= 2) {
    const sameRow = groupControls.filter((control) => Math.abs(control.rect.top - menu.rect.top) <= 6);
    if (sameRow.length === 1) {
      add("orphan-menu", `⋮(channel-title-menu)가 컨트롤 ${controlRows}줄 중 혼자 한 줄을 차지한다 ${fmt(menu.rect)}`);
    }
  }

  // 11. 허들(#5184).
  if (scene.huddle) {
    // 머리 줄 수: 컨트롤이 제목 아랫줄이면 1 + 컨트롤 줄 수, 옆이면 컨트롤 줄 수(최소 1).
    const lines = separate ? 1 + controlRows : Math.max(1, controlRows);
    if (TWO_LINE_WIDTHS.includes(width) && lines > 2) {
      add("lines", `허들 장면의 머리가 ${lines}줄이다(높이 ${m.header.height.toFixed(1)}px): ${width}에서는 두 줄 이내여야 한다`);
    }
    if (TWO_LINE_WIDTHS.includes(width) && m.header.height > MAX_TWO_LINE_HEADER_PX) {
      add("lines", `허들 장면의 머리 높이가 ${m.header.height.toFixed(1)}px다(두 줄은 ${MAX_TWO_LINE_HEADER_PX} 이하): ${width}에서는 두 줄 이내여야 한다`);
    }
    if (m.chip && m.chip.scrollWidth > m.chip.clientWidth + 1) {
      add("chip", `Live 칩이 조각났다(scrollWidth ${m.chip.scrollWidth} > clientWidth ${m.chip.clientWidth})`);
    }
    // 말줄임된 이름 글 위에서도 전문이 뜬다(title): 이름이 칩 안에 있던 때는 칩의 title이 떴다.
    if (m.names && !(m.names.title ?? "").includes(HUDDLE_PARTICIPANTS[0])) {
      add("names", `참가자 이름 글의 title이 전문이 아니다: ${JSON.stringify(m.names.title)}`);
    }
    // 자리가 넉넉하면 이름 글은 선다: 제목이 짧은 장면(「general」)은 1440에서 꼬리 칸이 이름 글 전문보다 넓다. 이름 글이 영영 안 서는 변이
    // (꼬리 칸이 폭 0으로 굳음 등)는 「제목이 안 깎인다」 단정만으로는 초록이다.
    if (scene.id === "short+topic+joined" && width === 1440 && !namesShown) {
      add("names", `1440에서 제목이 짧은데 참가자 이름 글이 서지 않았다(폭 ${m.names ? m.names.rect.width.toFixed(1) : "없음"})`);
    }
    if (namesShown) {
      if (!m.chip) add("chip", "참가자 이름 글은 보이는데 Live 칩이 없다(칩 없이 이름만 남았다)");
      // 이름 글은 제목이 다 선 뒤 남는 폭만 받는다: 제목이 잘렸는데 이름 글이 폭을 가지면 칩이 제목보다 먼저 줄지 않은 것이다.
      if (m.h1 && m.h1.scrollWidth > m.h1.clientWidth + 1) {
        add("chip-first", `제목이 잘렸는데(${m.h1.scrollWidth} > ${m.h1.clientWidth}) 참가자 이름 글이 ${m.names.rect.width.toFixed(1)}px를 가졌다`);
      }
      // 보이는 이름 글은 조각(말줄임표만 남음)이 아니다: 칸의 문턱(8rem) 이상이거나 글이 다 들어간다.
      if (m.names.rect.width < Math.min(m.names.scrollWidth, NAMES_MIN_PX) - 1) {
        add("names", `참가자 이름 글이 조각으로 남았다: ${m.names.rect.width.toFixed(1)}px(글 전체 ${m.names.scrollWidth}px)`);
      }
    }
  }
  return problems;
}

async function settle(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  );
}

/**
 * 툴팁: 머리 컨트롤마다 키보드 초점으로 툴팁을 열어, 툴팁 상자가 판(과 창) 안인지 잰다. 기본 글자 크기·밀도에서 표의 폭만 잰다.
 * 키보드 초점은 지연 없이 즉시 뜬다(`Tooltip`, 마우스로 간 초점은 안 띄운다). 그래서 진짜 Tab 키를 한 번 눌러 입력 방식을 키보드로
 * 만든 뒤에 `focus()`한다: Shift 같은 수식 키로는 웨빗이 첫 프로그램 초점을 `:focus-visible`로 치지 않는다(실측).
 * 호버는 두 엔진 모두 되지만 컨트롤마다 500ms 지연이라 게이트에 느리다.
 */
async function sweepTooltips(page, scene, withPlan, engineName, report) {
  const label = `${engineName} · ${scene.id} · 독 ${withPlan ? "있음" : "없음"} · 툴팁`;
  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute("data-font-size", "default");
    root.setAttribute("data-density", "comfortable");
  });
  const blur = () =>
    page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
  let opened = 0;
  let failed = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHT });
    await settle(page);
    await page.keyboard.press("Tab");
    await blur();
    const buttons = page.locator('[data-testid="channel-header-controls"] button');
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      const id = (await button.getAttribute("data-testid")) ?? `button#${index}`;
      await blur();
      await button.focus();
      const shown = await page
        .getByTestId("tooltip")
        .first()
        .waitFor({ state: "attached", timeout: 1_500 })
        .then(
          () => true,
          () => false
        );
      if (!shown) continue;
      const m = await page.evaluate(() => {
        const tip = document.querySelector('[data-testid="tooltip"]');
        const pane = document.querySelector(".app-pane");
        const box = tip.getBoundingClientRect();
        const paneBox = pane ? pane.getBoundingClientRect() : { left: 0, right: window.innerWidth };
        const style = getComputedStyle(tip);
        const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        return {
          left: box.left,
          right: box.right,
          lines: Math.round((box.height - padding) / Number.parseFloat(style.lineHeight)),
          paneLeft: Math.max(0, paneBox.left),
          paneRight: Math.min(window.innerWidth, paneBox.right),
          overflow: tip.scrollWidth - tip.clientWidth,
          text: tip.textContent,
        };
      });
      opened += 1;
      const problems = [];
      if (m.left < m.paneLeft - 0.5 || m.right > m.paneRight + 0.5) {
        problems.push(`상자 [${m.left.toFixed(1)}→${m.right.toFixed(1)}]가 판(${m.paneLeft.toFixed(1)}→${m.paneRight.toFixed(1)}) 밖이다`);
      }
      // 판 안에만 넣으려고 폭을 너무 좁혀 길쭉해지면 안 된다.
      if (m.lines > TOOLTIP_MAX_LINES) problems.push(`${m.lines}줄(> ${TOOLTIP_MAX_LINES})로 길쭉하다`);
      // 줄바꿈할 곳이 없는 글이 상자를 넘으면(overflow-wrap) 상자는 판 안이어도 글자가 판 밖으로 나간다.
      if (m.overflow > 1) problems.push(`글이 상자를 ${m.overflow}px 넘친다`);
      if (problems.length > 0) {
        failed += 1;
        report.failures.push({
          label,
          state: `${width}px`,
          check: "tooltip",
          text: `${id}의 툴팁 「${m.text}」: ${problems.join(", ")}`,
        });
      }
    }
  }
  await blur();
  report.tooltips += opened;
  report.tooltipsFailed += failed;
  report.perScene.push(`${label}: ${opened - failed}/${opened} 통과`);
}

/** 한 장면(이름 종류 × 독 유무)이 훑을 상태 목록: 표의 폭은 글자 크기 3 × 밀도 3 전부, 훑기 폭은 두 극단만. */
function statesToMeasure() {
  const list = [];
  const widths = [...new Set([...WIDTHS, ...SWEEP_WIDTHS])]
    .filter((width) => onlyWidths.length === 0 || onlyWidths.includes(width))
    .sort((a, b) => a - b);
  for (const width of widths) {
    const inTable = WIDTHS.includes(width);
    for (const fontSize of FONT_SIZES) {
      for (const density of DENSITIES) {
        const extreme =
          (fontSize.id === "default" && density.id === "comfortable") ||
          (fontSize.id === "larger" && density.id === "spacious");
        if (inTable || extreme) list.push({ width, fontSize, density, inTable });
      }
    }
  }
  return list;
}

/**
 * 기본 글자 크기(기본 단계)에서 제목의 계산된 font-size(px). 글자 크기 장면은 이 값 × 배율을 기대한다(#5198).
 * 기준이 숫자가 아니거나 비상식이면 모든 글자 크기 단정이 허공을 재므로 여기서 터뜨린다.
 */
async function measureBaseFontPx(page) {
  await page.setViewportSize({ width: 1440, height: HEIGHT });
  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute("data-font-size", "default");
    root.setAttribute("data-density", "comfortable");
  });
  await settle(page);
  const px = await page.evaluate(() => {
    const h1 = document.querySelector('[data-testid="channel-header"] h1');
    return h1 ? Number.parseFloat(getComputedStyle(h1).fontSize) : Number.NaN;
  });
  if (!Number.isFinite(px) || px < 10 || px > 40) {
    throw new Error(`기본 글자 크기에서 제목의 계산된 font-size를 숫자로 못 읽었다(읽은 값 ${px})`);
  }
  return px;
}

async function sweepScene(page, scene, withPlan, engineName, report) {
  const label = `${engineName} · ${scene.id} · 독 ${withPlan ? "있음" : "없음"}`;
  let measuredCount = 0;
  let failedStates = 0;
  /** 항목별로 그 항목을 어긴 장면 수(한 장면은 항목마다 한 번만 센다). */
  const failedByCheck = new Map();
  const baseFontPx = await measureBaseFontPx(page);
  /** 핸들 장면이 보임/숨음을 둘 다 겪었는지(늘 숨기기만 하거나 늘 보이기만 하는 구현이 초록이 되지 않게). */
  const handleSeen = { shown: 0, hidden: 0 };
  for (const { width, fontSize, density } of statesToMeasure()) {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.evaluate(
      ({ fontSizeId, densityId }) => {
        const root = document.documentElement;
        root.setAttribute("data-font-size", fontSizeId);
        root.setAttribute("data-density", densityId);
      },
      { fontSizeId: fontSize.id, densityId: density.id }
    );
    await settle(page);
    const measured = await page.evaluate(measureInPage);
    if (dump && fontSize.id === "default" && density.id === "comfortable") {
      // 개발용: 상태마다 단추 폭과 칸 상자를 한 줄로 찍는다.
      const w = (box) => (box ? Math.round(box.width * 10) / 10 : null);
      console.log(
        `DUMP ${label} ${width}px header=${Math.round(measured.header.height)} body=${w(measured.body)} h1=${w(measured.h1?.box)} tools=${w(measured.tools)} ` +
          `names=${measured.names ? w(measured.names.rect) : "-"}(${measured.names?.display ?? "-"}) chip=${w(measured.chip?.rect)} ` +
          `controls=${measured.controls.map((c) => `${c.id}:${w(c.rect)}@${Math.round(c.rect.top)}`).join(",")}`
      );
    }
    const problems = judge(measured, { scene, withPlan, width, fontSize, density, baseFontPx });
    measuredCount += 1;
    const handleState = handleVisibility(measured).state;
    if (handleState === "shown") handleSeen.shown += 1;
    if (handleState === "hidden") handleSeen.hidden += 1;
    if (problems.length > 0) {
      failedStates += 1;
      for (const check of new Set(problems.map((problem) => problem.check))) {
        failedByCheck.set(check, (failedByCheck.get(check) ?? 0) + 1);
      }
      for (const problem of problems) {
        report.failures.push({
          label,
          state: `${width}px · 글자 ${fontSize.id} · 밀도 ${density.id}`,
          ...problem,
        });
      }
    }
  }
  report.states += measuredCount;
  report.failedStates += failedStates;
  // 핸들 장면의 폭 덮개: 판정이 보임·숨음 양쪽을 실제로 밟았는지 센다(한쪽만 밟으면 다른 쪽 단정이 비어 늘 초록이다).
  //   긴 이름(`dm+handle`): 좁은 폭에서 통째로 숨고 넓은 폭에서 통째로 보인다 → 둘 다 있어야 한다.
  //   짧은 이름(`dm+handle-short`): 거의 모든 폭에서 보인다 → 늘 숨기기만 하는 구현을 잡도록 보임이 있어야 한다.
  if (scene.ambiguous && onlyWidths.length === 0) {
    if (scene.id === "dm+handle" && handleSeen.hidden === 0) {
      report.failures.push({ label, state: "전체", check: "handle-coverage", text: "긴 이름의 핸들이 한 번도 숨지 않았다: 숨는 쪽 단정이 비어 있다" });
    }
    if (handleSeen.shown === 0) {
      report.failures.push({ label, state: "전체", check: "handle-coverage", text: "핸들이 한 번도 보이지 않았다: 늘 숨기기만 하는 구현이다" });
    }
  }
  const detail = [...failedByCheck.entries()]
    .map(([check, count]) => `${check} ${count}`)
    .join(", ");
  const handleNote = scene.ambiguous ? ` · 핸들 보임 ${handleSeen.shown}/숨음 ${handleSeen.hidden}` : "";
  report.perScene.push(
    `${label}: ${measuredCount - failedStates}/${measuredCount} 통과${detail ? ` (어긴 장면 수: ${detail})` : ""}${handleNote}`
  );
}

/** 캡처: 폭마다 머리만 찍는다(기본 글자 크기·밀도). 판정에는 안 쓴다. */
async function captureShots(page, scene, withPlan, engineName) {
  const widths = shotWidthsOverride.length > 0 ? shotWidthsOverride : WIDTHS;
  const dir = resolve(shotsDir, engineName);
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute("data-font-size", "default");
    root.setAttribute("data-density", "comfortable");
  });
  for (const width of widths) {
    await page.setViewportSize({ width, height: HEIGHT });
    await settle(page);
    const bottom = await page.evaluate(() =>
      document.querySelector('[data-testid="channel-header"]').getBoundingClientRect().bottom
    );
    await page.screenshot({
      path: resolve(dir, `${scene.id.replace(/\+/g, "-")}-${withPlan ? "dock" : "nodock"}-${width}-${scheme}.png`),
      clip: { x: 0, y: 0, width, height: Math.min(HEIGHT, Math.ceil(bottom + 24)) },
    });
  }
}

async function main() {
  const dist = distOverride ?? resolve(webRoot, "dist");
  if (!existsSync(resolve(dist, "index.html"))) {
    throw new Error(
      `${dist}/index.html is missing. Run npm run build first (or point HEADER_FIT_GATE_DIST at a build).`
    );
  }
  for (const name of engineNames) {
    if (!(name in ENGINES)) throw new Error(`unknown engine ${JSON.stringify(name)} (chromium | webkit)`);
  }
  const scenes = onlyScenes.length > 0 ? SCENES.filter((scene) => onlyScenes.includes(scene.id)) : SCENES;
  const unknown = onlyScenes.filter((id) => !SCENES.some((scene) => scene.id === id));
  if (unknown.length > 0) throw new Error(`HEADER_FIT_ONLY에 모르는 장면이 있다: ${unknown.join(", ")}`);
  const partial = onlyScenes.length > 0 || onlyWidths.length > 0;
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "HEADER_FIT_GATE_PORT",
    extraArgs: distOverride ? ["--outDir", distOverride] : [],
  });
  const report = {
    states: 0,
    failedStates: 0,
    tooltips: 0,
    tooltipsFailed: 0,
    failures: [],
    perScene: [],
  };
  try {
    for (const engineName of engineNames) {
      const browser = await ENGINES[engineName].launch();
      try {
        for (const scene of scenes) {
          for (const withPlan of [false, true]) {
            const { context, page } = await openScene(browser, scene, withPlan);
            try {
              if (!shotsOnly) {
                await sweepScene(page, scene, withPlan, engineName, report);
                await sweepTooltips(page, scene, withPlan, engineName, report);
              }
              if (shotsDir) await captureShots(page, scene, withPlan, engineName);
            } finally {
              await context.close();
            }
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
  }

  if (shotsOnly) {
    if (!shotsDir) throw new Error("HEADER_FIT_SHOTS_ONLY=1은 HEADER_FIT_GATE_SHOTS=<폴더>가 있어야 한다");
    console.log(`SHOTS DONE: 판정 없이 ${scenes.length * 2 * engineNames.length}개 장면의 캡처만 ${shotsDir}에 남겼다.`);
    return;
  }

  // 장면 수 자체를 못 박는다: 센 것이 적으면 아래 판정이 비어 늘 초록이다.
  const sceneRuns = scenes.length * 2;
  const expectedStates = engineNames.length * sceneRuns * statesToMeasure().length;
  if (report.states !== expectedStates) {
    throw new Error(`쟀어야 할 장면은 ${expectedStates}개인데 ${report.states}개를 쟀다`);
  }
  // 툴팁도 센 수를 못 박는다: 하나도 안 떴으면(초점이 :focus-visible이 아니었다) 아래 판정이 비어 늘 초록이다.
  const minTooltips = engineNames.length * sceneRuns * WIDTHS.length * 2;
  if (report.tooltips < minTooltips) {
    throw new Error(`툴팁을 ${minTooltips}개 이상 열어야 하는데 ${report.tooltips}개만 열렸다`);
  }

  if (report.failures.length > 0) {
    const byCheck = new Map();
    for (const failure of report.failures) {
      byCheck.set(failure.check, (byCheck.get(failure.check) ?? 0) + 1);
    }
    console.error(
      `GATE FAIL: 장면 ${report.states}개 중 ${report.failedStates}개, 툴팁 ${report.tooltips}개 중 ${report.tooltipsFailed}개가 어겼다 ` +
        `(항목별 ${[...byCheck.entries()].map(([check, count]) => `${check} ${count}`).join(", ")})`
    );
    for (const line of report.perScene) console.error(`  ${line}`);
    const shown = new Map();
    for (const failure of report.failures) {
      const seen = shown.get(failure.check) ?? 0;
      if (seen >= 4) continue;
      shown.set(failure.check, seen + 1);
      console.error(`  - [${failure.check}] ${failure.label} · ${failure.state}: ${failure.text}`);
    }
    process.exit(1);
  }
  for (const line of report.perScene) console.log(`  ${line}`);
  console.log(
    `GATE PASS: 장면 ${report.states}개와 툴팁 ${report.tooltips}개(엔진 ${engineNames.join("·")})에서 머리의 모든 컨트롤이 뷰포트 안이고, ` +
      "서로·아이콘·제목·토픽과 겹치지 않으며, 그 자리에서 눌린다. 컨트롤은 제목 옆에 설 수 있을 때만 아랫줄로 내려가 오른쪽 끝에 붙는다. " +
      "제목은 한 줄 말줄임이고 전문은 글과 툴팁에 남으며, 툴팁은 판 안에 머문다. " +
      `컨트롤 옆에서 제목은 전문이 다 보이거나 글자 ${TITLE_FLOOR_EM}자 몫 이상이고, 같은 이름 DM의 핸들은 통째로 보이거나 통째로 숨고, ` +
      "허들의 참가자 이름 글은 제목이 다 선 뒤 남는 폭만 받으며, ⋮는 혼자 한 줄을 차지하지 않는다." +
      (partial ? ` (부분 실행: 장면 ${scenes.map((scene) => scene.id).join("·")}, 폭 ${onlyWidths.length > 0 ? onlyWidths.join("·") : "전부"})` : "")
  );
}

main().catch((error) => {
  const message = String(error.message ?? error);
  console.error(message.startsWith("GATE FAIL:") ? message : `GATE FAIL: ${message}`);
  process.exit(1);
});
