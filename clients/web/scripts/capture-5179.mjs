#!/usr/bin/env node
// =============================================================================
// #5179 레인: 호버 툴바가 **바로 위 행의 마지막 줄**을 덮는다 (#5173 이 찾은 일반 겹침, 390 열).
//
//   npm run build && node scripts/capture-5179.mjs
//   DIST_DIR=<다른 dist> node scripts/capture-5179.mjs   # 고치기 전 번들로 RED 를 다시 볼 때
//   SHOTS=1 OUT_DIR=<dir> node scripts/capture-5179.mjs  # 캡처도 찍기(기본은 재기만)
//   SCHEMES=light node scripts/capture-5179.mjs          # 한 색 조합만(사보타주 반복용, 기본은 light,dark)
//   ENGINE=webkit node scripts/capture-5179.mjs          # 같은 레인을 WebKit(WKWebView 의 엔진)으로(기본은 chromium, `capture-5192.mjs` 와 같은 스위치)
//
// 툴바는 행 위 경계를 걸치는 플로팅 그릇이라 그 행의 위 이웃 바닥 36px 를 덮는다(README §6 행 액션 5번). 그 띠 안에는 앞 행의
// **마지막 줄**이 늘 서므로 겹침은 세로가 아니라 가로로 정해진다: 앞 행의 마지막 줄이 툴바 왼쪽 끝(오른쪽에서 12 + 223)보다 오른쪽까지
// 오면 덮인다. 글머리에서 툴바 왼쪽 끝까지는 390 열이 95px, 720 창(사이드바가 선 데스크탑 폭, 대화 열은 388)이 77px 라 한국어 6~8자가 넘는
// 줄이 그렇다. 1440 은 같은 글이 툴바에 닿지 않는다.
//
// 자리 규칙(`hoverToolbarModel.placeToolbar`): ① 위 자리가 앞 이웃 글자를 안 덮으면 위 그대로 ② 덮으면 아래 경계로 뒤집되 뒤 이웃을 새로 덮거나 스크롤러
// 밖으로 잘리지 않을 때만(1차 수리 #5236, A·B·E·G) ③ 위·아래 모두 막히면 **행 안쪽으로 밀어 앉힌다**(밀림 `--hover-toolbar-slide`, 위 자리에서 아래로 px):
// 앞 글줄 바로 밑 ~ 뒤 글줄·스크롤러 바닥 사이의 글자 없는 창(툴바 키 42 이상)에 선다. ④ 창이 없으면 위 그대로(남은 경우 R).
//
// 재는 것(390·720·1440 × 밝음·어두움, 포인터가 선 행 열 가지). 글 길이는 「짧은 글 ≤5자 / 긴 글 ≥8자」 둘뿐이고 머리 줄 이름은 2글자라 390·720 에서
// 같은 구조가 선다(3글자 이름 + 시각의 오른끝이 720 에서 툴바 왼끝 ±1px 경계라 결정적이지 않다 — README §6):
//   A  긴 앞 행 · 포인터 행 · **다음 행이 머리 행**(이름·시각 줄)      좁은 열: 아래 경계로 뒤집혀 0 / 1440: 위 그대로 0
//   B  긴 앞 행 · 포인터 행 · 다음 행이 **짧은 이어짐**                좁은 열: 아래 경계로 뒤집혀 0 / 1440: 위 그대로 0
//   C  긴 앞 행 · **짧은** 포인터 행 · 다음 행도 **긴 이어짐**(양쪽이 막힘)  뒤집으면 뒤 행 글자를 덮으므로 **행 안쪽으로 밀려** 앞 글줄 밑에 앉아 0
//   D  짧은 앞 행(대조)                                               위 그대로 0 — 덮을 것이 없으면 뒤집지도 밀지도 않는다
//   E  A 의 포인터 행이 스크롤러 맨 위에 걸림                          기존 규칙(위가 잘리면 아래로) 그대로 below
//   F  **마지막 행**(스크롤러 맨 아래, 아래로 내릴 여유 없음)           아래 자리는 스크롤러 밖이라 **행 안쪽으로 밀려** 0(막대는 스크롤러 안)
//   G  **1440 만**: 앞 행이 한 줄로 길어 끝이 툴바 왼쪽 끝(x≈1185)을 넘음   아래 경계로 뒤집혀 0 (수리 전: 1440 에서도 앞 행 끝줄을 덮는다)
//   H  **머리 행**이 포인터(긴 본문 두 줄) · 앞 행 긴 글 · 뒤 행 긴 이어짐   머리 줄(이름·시각) 높이의 빈 창으로 밀려 앉아 0
//   I  **마지막 행이 머리 행**(두 번째 대화) · 긴 본문 · 앞 행 긴 글        검수가 #5212 720 폭에서 본 장면 — 밀려 앉아 0
//   R  **남은 경우**: 이어짐 포인터 행(한 줄 긴 글) · 앞·뒤 행도 한 줄 긴 글   세 줄이 36px 간격이라 42px 빈 창이 없다 → 위 그대로, 겹침을 프로브로만 적는다
//
// 1440 의 A~D 는 앞 행 글이 툴바에 **닿지 않는 대조 칸**이다(마지막 줄 오른끝 x≤937 < 툴바 왼끝 1185). 규칙에는 폭 문턱이 없어서 넓은 열도
// 글이 툴바에 닿으면(한 줄 약 80자 이상) 뒤집는다 — 그 칸이 G 다. README §6 의 「교차 0」과 이슈의 「1440 그대로」 중 어느 쪽을 따를지는 planner 가 정한다.
//
// 단정은 레인 공용 자(`./lib/hoverToolbarOverlap.mjs`, `capture-screens.mjs`·`capture-5173.mjs` 와 한 벌)를 그대로 부른다. 그 위에:
//   - **양성 대조**: 칸마다 앞 행의 마지막 줄이 실제로 툴바 왼쪽 끝을 넘는지(좁은 열의 A·B·C·F·H·I·R), 넘지 않는지(D·1440)를 먼저 재서, 겹침 0 이
//     「애초에 닿지 않아서」 초록인 칸을 걸러낸다. R 은 세 줄이 모두 툴바 밑까지 오는지도 잰다(자리 없음이 진짜인지). 자가 이웃으로 **앞 행을 실제로 봤는지**(`looked`)도 단정한다.
//   - **자 민감도**: 툴바를 앞 행 마지막 줄 위에 일부러 얹으면 자가 그 글자를 센다(chars > 0, neighbor = prev, kind = row).
//
// 백엔드는 없다: `/v1/**`는 고정 응답이고 소켓은 구독만 받는다. 인물은 전부 가상이다(레포는 공개).
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import {
  assertHoverToolbarClearsBodyText,
  measureHoverToolbarOverlap,
} from "./lib/hoverToolbarOverlap.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/5179");
const PORT = Number(process.env.CAPTURE_PORT || 5579);
const DIST_DIR = process.env.DIST_DIR || "";
const SHOTS = process.env.SHOTS === "1";
const SCHEMES = (process.env.SCHEMES || "light,dark").split(",").filter((scheme) => scheme === "light" || scheme === "dark");
const ENGINE = process.env.ENGINE === "webkit" ? "webkit" : "chromium";
const MIN = 60_000;
const NOW = Date.UTC(2024, 5, 15, 3, 0, 0);
/** 툴바 모양을 못 박는 값: #5192 의 알약 막대 폭(223)이 이 수리로 달라지지 않았는가. */
const TOOLBAR_WIDTH = 223;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SEO = "00000000-0000-7000-8000-000000000102";
const MINSU = "00000000-0000-7000-8000-000000000103";
const HAYUN = "00000000-0000-7000-8000-000000000104";
const A1 = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const GEN = "00000000-0000-7000-8000-000000000202";
const mid = (n) => `00000000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, role: "member", channelCount: 2,
  channelIds: [CH, GEN], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(ME, "human", "이도현", "dohyun", { role: "owner" }),
  // 머리 줄(이름 + 시각)의 오른끝이 720 열의 툴바 왼쪽 끝(글머리에서 77)에 닿지 않게 이름은 2글자다. 3글자 이름은 시각 끝이 그 끝에서 ±1px 경계에 선다(README §6).
  person(SEO, "human", "서연", "seoyeon"),
  person(MINSU, "human", "민수", "minsu"),
  person(HAYUN, "human", "하윤", "hayun"),
  person(A1, "agent", "달무리봇", "dalmuri-bot", { ownerHumanId: ME }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "디자인-리뷰", muted: false },
  { id: GEN, workspaceId, kind: "public", name: "일반", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://capture-5179.invalid/connection/websocket",
};

/**
 * 대화. 앞 칸(채움)은 두 사람이 번갈아 짧게 말해 매 행이 머리 행이다. 그 뒤에 시험 칸 네 벌이 선다(각 벌 = 앞 행 · 포인터 행 · 다음 행).
 * 같은 사람이 1분 안에 이어 쓴 행은 머리 없는 **이어짐** 행이다(거터에 시각이 선다).
 *
 *   A  박서연 긴 글 → 박서연 짧은 글(포인터) → 최민수 머리 행
 *   B  정하윤 긴 글 → 정하윤 짧은 글(포인터) → 정하윤 아주 짧은 이어짐(「넵」)
 *   C  최민수 긴 글 → 최민수 짧은 글(포인터) → 최민수 긴 이어짐
 *   D  박서연 짧은 글 → 박서연 짧은 글(포인터) → 정하윤 머리 행
 *   G  최민수 긴 한 줄(1440 에서 툴바 왼쪽 끝을 넘음) → 최민수 짧은 글(포인터) → 최민수 「넵」 (1440 만)
 *   F  정하윤 긴 글 → 정하윤 짧은 글(포인터, 대화의 **마지막** 행)
 */
const TEXT = {
  // 두 폭(390: 글머리 x56 → 툴바 왼끝 x151 = 95px / 720: 글머리 x388 → 툴바 왼끝 x465 = 77px)에서 같은 구조가 서도록 글 길이를 둘로만 쓴다:
  // 「짧은 글」은 5자 이하(60px 안팎, 툴바에 안 닿는다), 「긴 글」은 8자 이상(120px 넘게, 툴바 밑까지 온다).
  // 390 에서 둘째 줄이 길고(툴바 왼쪽 끝 너머까지 온다), 1440 에서는 한 줄로 끝난다.
  longA: "표지와 목차의 여백이 서로 달라서 한눈에 읽히지 않아요. 한 번만 더 맞춰 주세요.",
  longB: "표지 문구는 세 가지로 줄였고 목차는 글자 크기를 한 단계 키워 봤어요. 확인 부탁드려요.",
  longC: "시안 열두 장을 모두 훑어봤는데 여백이 들쭉날쭉한 곳이 몇 군데 있어서 따로 정리해 올릴게요.",
  longCNext: "그리고 표지 문구는 두 번째 안이 가장 낫다고 생각해요. 그 이유도 같이 적어 둘게요.",
  longF: "내일 오전까지 표지 시안 두 개와 목차 시안 한 개를 정리해서 올려 둘게요. 편하게 봐 주세요.",
  // H: 머리 행(다른 사람이 말한 첫 행)이 포인터인 칸 — 본문이 길어 두 줄이고, 앞·뒤 행도 긴 글이다. 머리 줄(이름·시각)은 툴바 왼쪽에 서고 본문 첫 줄은 그 아래에 선다.
  longHPrev: "오늘 오후에 표지 시안 세 개를 한꺼번에 검토할 수 있을까요? 시간이 되는 분은 알려 주세요.",
  longH: "저는 두 번째 시안이 가장 균형이 좋아 보여요. 다만 목차의 글자 크기는 조금 더 키우는 편이 낫겠어요.",
  longHNext: "그럼 오후 세 시에 같이 보는 걸로 해요. 그 전에 각자 시안 메모를 채널에 남겨 두면 좋겠어요.",
  // R(남은 경우): 이어짐 행이 포인터이고 한 줄짜리 글이 길어 툴바 밑까지 오며, 앞·뒤 행도 한 줄짜리 긴 글이다. 세 줄이 36px 간격으로 늘어서
  // 위·아래·행 안쪽 어디에도 42px 높이의 빈 창이 없다 — 열이 좁으면(8자 이상) 흔한 모양이다.
  longRPrev: "회의록은 어제 공유 폴더에 올렸어요.",
  longR: "발표 자료는 목차부터 확정할게요.",
  longRNext: "질문 시간은 마지막에 잡을게요.",
  // I(두 번째 대화): 대화의 마지막 행이 머리 행이고 본문이 두 줄로 긴 칸 — 검수(#5212 720 폭)가 본 장면.
  longIPrev: "녹화랑 캡처 파일은 오전에 올려 두었고 영상은 용량이 커서 업로드가 오래 걸릴 수 있어요.",
  longI: "좋아요, 영상은 용량이 커서 업로드가 좀 걸릴 수 있어요. 끝나면 이 대화에 한 줄 남겨 둘게요.",
  // 1440 에서 한 줄(약 10.4px/자 × 91자 ≈ 946px)이고 끝이 툴바 왼쪽 끝(x≈1185)을 넘는 긴 글. 390 에서는 여러 줄이라 이 칸은 1440 만 잰다.
  longG: "이번 주 시안은 표지와 목차의 여백부터 맞추고 글자 크기와 줄 간격은 그다음에 한꺼번에 정리하는 순서로 가면 좋겠다고 생각해요. 의견 있으시면 편하게 남겨 주세요.",
};
const SEQ = {};
function buildRows() {
  const rows = [];
  let n = 1;
  const add = (author, body, minAgo, name) => {
    rows.push({ n, author, body, minAgo });
    if (name) SEQ[name] = 9 + n; // seq 는 10 부터 행마다 1 씩
    n += 1;
  };
  for (let i = 0; i < 12; i += 1) {
    add(i % 2 ? SEO : MINSU, `시안 ${i + 1}번 확인했어요.`, 240 - i * 4);
  }
  add(HAYUN, "점심 먹고 이어서 볼게요", 150);
  // A
  add(SEO, TEXT.longA, 120, "A_prev");
  add(SEO, "네, 그렇게 맞춰 둘게요", 119, "A");
  add(MINSU, "저는 시안 먼저 볼게요", 118, "A_next");
  add(HAYUN, "알겠어요. 오후 두 시에 다시 맞춰 봐요", 100);
  // B
  add(HAYUN, TEXT.longB, 99, "B_prev");
  add(HAYUN, "네, 확인할게요", 98, "B");
  add(HAYUN, "넵", 97, "B_next");
  add(SEO, "좋아요. 그럼 그렇게 가요", 80);
  // C
  add(MINSU, TEXT.longC, 79, "C_prev");
  add(MINSU, "네, 맞아요", 78, "C");
  add(MINSU, TEXT.longCNext, 77, "C_next");
  add(HAYUN, "확인했어요. 이상 없어요", 60);
  // D
  add(SEO, "확인했어요", 59, "D_prev");
  add(SEO, "네, 그렇게 할게요", 58, "D");
  add(HAYUN, "저도 같은 생각이에요", 57, "D_next");
  // G (1440 만 잰다)
  add(MINSU, TEXT.longG, 56, "G_prev");
  add(MINSU, "네, 확인했어요", 55, "G");
  add(MINSU, "넵", 54, "G_next");
  // H: 머리 행 포인터(긴 본문 두 줄) · 앞 행 긴 글 · 뒤 행 긴 이어짐
  add(SEO, TEXT.longHPrev, 53, "H_prev");
  add(MINSU, TEXT.longH, 52, "H");
  add(MINSU, TEXT.longHNext, 51, "H_next");
  // R: 이어짐 포인터 행(긴 본문) · 앞·뒤 행도 긴 글
  add(HAYUN, TEXT.longRPrev, 50, "R_prev");
  add(HAYUN, TEXT.longR, 49, "R");
  add(HAYUN, TEXT.longRNext, 48, "R_next");
  for (let i = 0; i < 8; i += 1) {
    add(i % 2 ? SEO : MINSU, `시안 ${i + 13}번도 확인했어요.`, 40 - i * 3);
  }
  add(ME, "마지막 확인은 제가 할게요", 8);
  // F: 대화의 마지막 두 행
  add(HAYUN, TEXT.longF, 6, "F_prev");
  add(HAYUN, "네, 맞아요", 5, "F");
  return rows;
}
/**
 * 두 번째 대화(일반): 마지막 행이 **머리 행**이고 본문이 길어 두 줄인 장면(I). 검수(#5212 의 720 폭 캡처)가 본 것이다 — 오도현이 새 사람으로
 * 말한 마지막 행에 포인터를 올리면 위 자리 툴바가 앞 행 글을 덮고, 아래는 스크롤러 끝이라 내려갈 수 없다.
 */
function buildGenRows() {
  const rows = [];
  let n = 1;
  const add = (author, body, minAgo, name) => {
    rows.push({ n: 500 + n, author, body, minAgo });
    if (name) SEQ[name] = 199 + n; // 이 대화의 seq 는 200 부터(다른 대화의 seq 와 겹치지 않게)
    n += 1;
  };
  for (let i = 0; i < 12; i += 1) {
    add(i % 2 ? SEO : MINSU, `일정 ${i + 1}번 확인했어요.`, 120 - i * 4);
  }
  add(SEO, TEXT.longIPrev, 30, "I_prev");
  add(MINSU, TEXT.longI, 29, "I");
  return rows;
}
const toMessages = (rows, channelId, firstSeq) => {
  let seq = firstSeq;
  return rows.map((x) => {
    const createdAtMs = NOW - x.minAgo * MIN;
    return {
      id: mid(x.n), channelId, seq: seq++, hlcTs: createdAtMs, hlcCount: 0, authorMemberId: x.author,
      type: "text", body: x.body, state: "sent", createdAtMs,
    };
  });
};
const messages = () => toMessages(buildRows(), CH, 10);
const genMessages = () => toMessages(buildGenRows(), GEN, 200);
buildRows(); // SEQ 를 채운다(레인 본문이 읽는다)
buildGenRows();

async function installMocks(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: NOW + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 999, latest_seq: 999, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs/progress")) return json(route, { runs: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messages() });
    if (path.includes(`/channels/${GEN}/messages`)) return json(route, { messages: genMessages() });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  await context.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "capture-5179", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: false, positioned: false, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}

async function open(origin, scheme, viewport) {
  const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context);
  await context.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ state: "attached", timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, `/c/${CH}`);
  await page.getByTestId("composer").waitFor({ timeout: 20_000 });
  // 로그인 단추를 누른 자리에 포인터가 남으면 그 자리의 행이 hover 로 칠해진다. 구석으로 치운다.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(1200);
  return { browser, context, page };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
}
const note = (line) => console.log(`     ${line}`);

const rowOf = (page, seq) => page.locator(`[data-testid="timeline-message"][data-seq="${seq}"]`);

/** 그 행의 위 경계를 스크롤러 맨 위에 맞춘다(툴바가 위 경계를 걸치지 못하고 아래로 뒤집히는 자리). */
async function pinRowToScrollerTop(page, seq) {
  return page.evaluate(async (target) => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const sc = document.querySelector("[data-virtuoso-scroller]");
    if (!sc) return null;
    const find = () => document.querySelector(`[data-testid="timeline-message"][data-seq="${target}"]`);
    sc.scrollTop = 0;
    for (let i = 0; i < 8; i += 1) await frame();
    for (let k = 0; k < 6; k += 1) {
      const row = find();
      if (!row) { sc.scrollTop += 400; await frame(); continue; }
      sc.scrollTop += row.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      for (let i = 0; i < 6; i += 1) await frame();
    }
    const row = find();
    return row ? Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top) : null;
  }, seq);
}

/** 그 행을 화면 가운데로(핀 없는 보통 호버). */
async function centerRow(page, seq) {
  await page.evaluate(async (target) => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const sc = document.querySelector("[data-virtuoso-scroller]");
    const find = () => document.querySelector(`[data-testid="timeline-message"][data-seq="${target}"]`);
    if (!sc) return;
    // 가상화 목록이라 행이 아직 안 그려졌을 수 있다: 맨 위에서 아래로 훑어 그려질 때까지 끌어 온다.
    if (!find()) {
      sc.scrollTop = 0;
      for (let i = 0; i < 8; i += 1) await frame();
    }
    for (let k = 0; k < 30 && !find(); k += 1) { sc.scrollTop += 240; await frame(); await frame(); }
    const row = find();
    if (!row) return;
    for (let pass = 0; pass < 3; pass += 1) {
      const rect = row.getBoundingClientRect();
      const scRect = sc.getBoundingClientRect();
      sc.scrollTop += rect.top - scRect.top - (scRect.height - rect.height) / 2;
      for (let i = 0; i < 8; i += 1) await frame();
    }
  }, seq);
}

/** 목록을 맨 아래(가장 새 행이 스크롤러 바닥에 붙는 자리)로 내린다. */
async function scrollToBottom(page) {
  await page.evaluate(async () => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const sc = document.querySelector("[data-virtuoso-scroller]");
    if (!sc) return;
    for (let k = 0; k < 4; k += 1) {
      sc.scrollTop = sc.scrollHeight;
      for (let i = 0; i < 8; i += 1) await frame();
    }
  });
}

/** 행의 글자 조각(텍스트 노드마다 줄 조각의 사각형)과 머리 행 여부. 글 노드 하나가 여러 줄이면 줄마다 한 조각이다. */
const fragmentsOf = (page, seq) =>
  page.evaluate((target) => {
    const el = document.querySelector(`[data-testid="timeline-message"][data-seq="${target}"]`);
    if (!el) return null;
    const body = el.querySelector("[data-row-body]");
    const frags = [];
    if (body) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!(node.textContent || "").trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width === 0 || r.height === 0) continue;
          frags.push({ l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), text: (node.textContent || "").trim().slice(0, 12) });
        }
      }
    }
    const rect = el.getBoundingClientRect();
    return { head: Boolean(el.querySelector('[data-testid="row-avatar-profile"]')), row: { t: Math.round(rect.top), b: Math.round(rect.bottom) }, frags };
  }, seq);

const barRect = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('[data-testid="message-hover-toolbar"]');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    // 밀림(slide)은 위 자리에서 아래로 민 px — 모델이 CSSOM 으로 거는 변수다(없으면 0). 수리 전 번들에는 변수가 없어 늘 0이다.
    const slide = Number.parseFloat(bar.style.getPropertyValue("--hover-toolbar-slide")) || 0;
    return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), straddle: bar.getAttribute("data-straddle"), slide };
  });

const scrollerRect = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector("[data-virtuoso-scroller]");
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    return { t: Math.round(r.top), b: Math.round(r.bottom) };
  });

const last = (frags) => frags.reduce((acc, f) => (!acc || f.b > acc.b || (f.b === acc.b && f.r > acc.r) ? f : acc), null);
const first = (frags) => frags.reduce((acc, f) => (!acc || f.t < acc.t || (f.t === acc.t && f.l < acc.l) ? f : acc), null);

/**
 * 포인터가 선 행들. `narrow`/`wide` = 그 폭에서 툴바가 서야 하는 쪽(`data-straddle`: 위 경계 걸침 top / 아래 경계 걸침 below).
 * `slideNarrow` = 좁은 열에서 툴바가 **위 자리에서 아래로 밀려 행 안쪽에** 앉아야 하는가(밀림 > 0, `--hover-toolbar-slide`). 넓은 열은 늘 0이다.
 * `zeroNarrow` = 좁은 열에서 겹침 0 을 단정하는가(false = 프로브만: 남은 경우 R).
 * `prevReaches` = 앞 행 마지막 줄이 툴바 왼쪽 끝을 넘는가(양성 대조의 기대값, 좁은 열 / 1440).
 * `channel` = 이 칸이 서는 대화(기본은 디자인-리뷰, "GEN" 은 일반 — 마지막 행이 머리 행인 장면 I).
 */
const CASES = [
  { id: "A 긴 앞 행 · 다음 행이 머리 행", key: "A", pin: false, narrow: "below", wide: "top", slideNarrow: false, zeroNarrow: true, prevReaches: [true, false] },
  { id: "B 긴 앞 행 · 다음 행이 짧은 이어짐", key: "B", pin: false, narrow: "below", wide: "top", slideNarrow: false, zeroNarrow: true, prevReaches: [true, false] },
  { id: "C 긴 앞 행 · 다음 행도 긴 이어짐(양쪽이 막힘)", key: "C", pin: false, narrow: "top", wide: "top", slideNarrow: true, zeroNarrow: true, prevReaches: [true, false] },
  { id: "D 짧은 앞 행(대조)", key: "D", pin: false, narrow: "top", wide: "top", slideNarrow: false, zeroNarrow: true, prevReaches: [false, false] },
  { id: "E 긴 앞 행이 스크롤러 맨 위(뒤집힘)", key: "A", pin: true, narrow: "below", wide: "below", slideNarrow: false, zeroNarrow: null, prevReaches: null },
  { id: "F 마지막 행(아래로 내릴 여유 없음)", key: "F", pin: false, bottom: true, narrow: "top", wide: "top", slideNarrow: true, zeroNarrow: true, prevReaches: [true, false] },
  { id: "G 1440 긴 한 줄 앞 행(툴바 왼쪽 끝을 넘음)", key: "G", pin: false, wideOnly: true, narrow: null, wide: "below", slideNarrow: false, zeroNarrow: null, prevReaches: [null, true] },
  { id: "H 머리 행 포인터 · 긴 본문 · 앞·뒤도 긴 글", key: "H", pin: false, narrow: "top", wide: "top", slideNarrow: true, zeroNarrow: true, prevReaches: [true, false] },
  { id: "I 마지막 행이 머리 행 · 긴 본문(두 줄)", key: "I", pin: false, bottom: true, channel: "GEN", narrow: "top", wide: "top", slideNarrow: true, zeroNarrow: true, prevReaches: [true, false] },
  // 남은 경우(자리 없음): 이어짐 행이 포인터이고 본문이 길어 툴바 x 범위까지 오며, 앞·뒤 행도 그렇다 — 위·아래·행 안쪽 어디에도 글자 없는 41px 창이 없다.
  { id: "R 이어짐 행 포인터 · 긴 본문 · 앞·뒤도 긴 글(남은 경우)", key: "R", pin: false, residual: true, narrow: "top", wide: "top", slideNarrow: false, zeroNarrow: false, prevReaches: [true, false] },
];

async function runCase(page, tag, width, c) {
  const isNarrow = width < 900; // 이 레인의 두 폭: 390 은 좁은 열, 1440 은 넓은 열(A~D 는 앞 행 글이 툴바 왼쪽 끝 x≈1185 한참 앞에서 끝나는 대조 칸, 닿는 칸은 G 뿐)
  if (c.wideOnly && isNarrow) return;
  const name = `${tag} ${c.id}`;
  const seq = SEQ[c.key];
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  if (c.pin) {
    const top = await pinRowToScrollerTop(page, seq);
    check(`${name}: 행이 스크롤러 맨 위에 붙었다`, top !== null && Math.abs(top) <= 1, `top=${top}`);
  } else if (c.bottom) {
    await scrollToBottom(page);
  } else {
    await centerRow(page, seq);
  }
  await rowOf(page, seq).hover();
  await page.locator('[data-testid="message-hover-toolbar"]').first().waitFor({ state: "visible", timeout: 2000 });
  await page.waitForTimeout(350);

  const bar = await barRect(page);
  const sc = await scrollerRect(page);
  const own = await fragmentsOf(page, seq);
  const prev = await fragmentsOf(page, SEQ[`${c.key}_prev`] ?? seq - 1);
  const next = await fragmentsOf(page, SEQ[`${c.key}_next`] ?? seq + 1);
  const prevLast = prev ? last(prev.frags) : null;
  const nextFirst = next ? first(next.frags) : null;
  const ownFirst = own ? first(own.frags) : null;
  const ownLast = own ? last(own.frags) : null;
  note(
    `툴바 x ${bar?.l}~${bar?.r} y ${bar?.t}~${bar?.b}(${bar?.straddle}, 밀림 ${bar?.slide}) · 앞 행 마지막 줄 ${prevLast ? `x ${prevLast.l}~${prevLast.r} y ${prevLast.t}~${prevLast.b}` : "-"}` +
      ` · 뒤 행 첫 줄 ${nextFirst ? `x ${nextFirst.l}~${nextFirst.r} y ${nextFirst.t}~${nextFirst.b}` : "-"}(${next?.head ? "머리 행" : "이어짐"})`
  );
  note(
    `포인터 행 y ${own?.row.t}~${own?.row.b}(${own?.head ? "머리 행" : "이어짐"}) 본문 첫 줄 ${ownFirst ? `x ${ownFirst.l}~${ownFirst.r} y ${ownFirst.t}~${ownFirst.b}` : "-"}` +
      ` 끝줄 ${ownLast ? `x ${ownLast.l}~${ownLast.r} y ${ownLast.t}~${ownLast.b}` : "-"} · 스크롤러 y ${sc?.t}~${sc?.b}`
  );

  check(`${name}: 툴바 폭이 ${TOOLBAR_WIDTH} 그대로다(모양 유지)`, bar && Math.abs(bar.w - TOOLBAR_WIDTH) <= 1, JSON.stringify(bar));
  if (sc && bar) {
    check(`${name}: 툴바 상자가 스크롤러 안에 있다(위·아래로 잘리지 않는다)`, bar.t >= sc.t - 1 && bar.b <= sc.b + 1, `bar ${bar.t}~${bar.b} / 스크롤러 ${sc.t}~${sc.b}`);
  }
  if (bar && own) {
    // 어느 자리에 서든 막대는 포인터 행에 붙어 있다(행과 세로로 6px 이상 겹친다 — 위·아래 자리는 정확히 행 안 깊이 6, 밀린 자리는 그 이상). 떨어져 나간 막대는 누구 것인지 알 수 없다.
    const attached = Math.min(bar.b, own.row.b) - Math.max(bar.t, own.row.t);
    check(`${name}: 툴바가 포인터 행에 붙어 있다(행과 세로로 6px 이상 겹친다)`, attached >= 5, `겹침 ${attached}px · 툴바 ${bar.t}~${bar.b} · 행 ${own.row.t}~${own.row.b}`);
  }
  const expectStraddle = c.pin ? c.narrow : isNarrow ? c.narrow : c.wide;
  check(`${name}: 툴바가 기대한 자리(${expectStraddle})에 섰다`, bar?.straddle === expectStraddle, JSON.stringify(bar));
  // 밀림: 위 자리에서 아래로 밀려 행 안쪽에 앉는 것은 위·아래 경계 모두 글자에 막힌 칸(C·F·H·I)뿐이다. 나머지는 밀림 0(1차 수리의 자리 그대로).
  const expectSlide = !c.pin && isNarrow && Boolean(c.slideNarrow);
  check(
    `${name}: 툴바가 ${expectSlide ? "행 안쪽으로 밀려 앉았다(밀림 > 0)" : "위·아래 경계 그대로다(밀림 0)"}`,
    bar && (expectSlide ? bar.slide > 0 : bar.slide === 0),
    JSON.stringify(bar)
  );

  if (expectSlide) {
    // 밀려 앉은 막대는 앞 글줄에 닿지 않고 띄워 앉는다(모델이 창이 넉넉하면 2px, 좁으면 위·아래를 같게 나눈다). 글자 상자와 맞닿는 자리는 글자를 덮는 것과 한 끗 차이다.
    const gap = bar && prevLast ? bar.t - prevLast.b : null;
    check(`${name}: 밀려 앉은 툴바가 앞 행 마지막 줄 밑에서 띄워 앉는다(틈 ≥ 1px)`, gap !== null && gap >= 1, `틈 ${gap} · 툴바 윗단 ${bar?.t} · 앞 행 끝줄 밑단 ${prevLast?.b}`);
  }
  if (c.prevReaches) {
    // 양성 대조: 앞 행 마지막 줄이 툴바 왼쪽 끝을 넘는 칸에서만 이 시험이 뜻이 있다. 위 자리의 툴바 왼쪽 끝은 위·아래 자리가 같다(가로는 안 바뀐다).
    const want = c.prevReaches[isNarrow ? 0 : 1];
    const reaches = Boolean(prevLast && bar && prevLast.r > bar.l);
    check(`${name}: 앞 행 마지막 줄이 툴바 왼쪽 끝을 ${want ? "넘는다(겹칠 수 있는 칸)" : "넘지 않는다(대조)"}`, reaches === want, `줄 오른끝 ${prevLast?.r} · 툴바 왼끝 ${bar?.l}`);
  }
  if (c.residual && isNarrow) {
    // 양성 대조: 남은 경우가 정말 「자리 없음」인지 — 앞 행 끝줄·포인터 행 본문·뒤 행 첫 줄이 모두 툴바 왼쪽 끝을 넘는다.
    const reach = (frag) => Boolean(frag && bar && frag.r > bar.l);
    const ownAllReach = Boolean(own && own.frags.length > 0 && own.frags.every(reach));
    check(
      `${name}: 앞 행 끝줄·포인터 행의 모든 줄·뒤 행 첫 줄이 툴바 x 범위까지 온다(자리 없음의 조건)`,
      reach(prevLast) && ownAllReach && reach(nextFirst),
      `앞 ${prevLast?.r} · 포인터 ${own?.frags.map((f) => f.r).join("/")} · 뒤 ${nextFirst?.r} · 툴바 왼끝 ${bar?.l}`
    );
  }
  const info = await measureHoverToolbarOverlap(page);
  const looked = info[0]?.looked ?? [];
  check(`${name}: 자가 이웃으로 앞 행을 봤다(양성 대조)`, looked.some((item) => item.where === "prev" && item.kind === "row"), JSON.stringify(looked));
  note(`최악 ${info[0] ? `${info[0].neighbor}/${info[0].kind} seq ${info[0].seq} ${info[0].chars}자(${info[0].area}px²)` : "-"}`);

  const zero = c.pin ? null : isNarrow ? c.zeroNarrow : true;
  let verdict = "";
  try {
    await assertHoverToolbarClearsBodyText(page, name);
  } catch (error) {
    verdict = String(error?.message ?? error);
  }
  if (zero === true) {
    check(`${name}: 툴바 ∩ 이웃(행·시스템 줄) 글자 = 0`, verdict === "", verdict);
  } else {
    // 약속하지 않는 칸(자리 없는 R, 스크롤러 맨 위 E): 있는 그대로 적는다. 막힌 곳을 초록으로 칠하지 않는다.
    note(`프로브(단정 아님): ${verdict === "" ? "겹침 없음" : verdict}`);
  }

  if (SHOTS) {
    mkdirSync(OUT_DIR, { recursive: true });
    const slug = c.id.replace(/[^0-9A-Za-z가-힣]+/g, "-").replace(/^-|-$/g, "");
    await page.screenshot({ path: resolve(OUT_DIR, `5179-${tag.replace(/\s+/g, "-")}-${slug}.png`) });
  }
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
}

/**
 * 자 민감도: 툴바를 앞 행 마지막 줄 위에 일부러 얹으면 자가 그 글자를 세는가(실패할 수 없는 가드 방지).
 * 툴바는 캡처 페이지의 DOM 일 뿐이라 이 조작은 앱 코드를 바꾸지 않는다(포인터를 치우면 툴바와 함께 사라진다).
 */
async function runSensitivity(page, tag) {
  const name = `${tag} 자 민감도`;
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  await centerRow(page, SEQ.A);
  await rowOf(page, SEQ.A).hover();
  await page.locator('[data-testid="message-hover-toolbar"]').first().waitFor({ state: "visible", timeout: 2000 });
  await page.waitForTimeout(300);
  const forced = await page.evaluate((prevSeq) => {
    const bar = document.querySelector('[data-testid="message-hover-toolbar"]');
    const body = document.querySelector(`[data-testid="timeline-message"][data-seq="${prevSeq}"] [data-row-body]`);
    if (!bar || !body) return null;
    // 앞 행 글 노드의 마지막 줄 조각을 겨눈다.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let rect = null;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node.textContent || "").trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && (!rect || r.bottom > rect.bottom)) rect = r;
    }
    if (!rect) return null;
    bar.style.position = "fixed";
    bar.style.translate = "none";
    bar.style.left = `${Math.max(0, rect.left - 4)}px`;
    bar.style.top = `${Math.max(0, rect.top - 12)}px`;
    bar.style.right = "auto";
    bar.style.bottom = "auto";
    return true;
  }, SEQ.A_prev);
  check(`${name}: 툴바를 앞 행 마지막 줄 위로 옮겼다`, forced === true, String(forced));
  const info = await measureHoverToolbarOverlap(page);
  const hit = info[0];
  check(`${name}: 자가 앞 행 글자를 센다(chars > 0, neighbor = prev, kind = row)`, hit && hit.chars > 0 && hit.neighbor === "prev" && hit.kind === "row", JSON.stringify(hit));
  let thrown = "";
  try {
    await assertHoverToolbarClearsBodyText(page, name);
  } catch (error) {
    thrown = String(error?.message ?? error);
  }
  check(`${name}: 공용 단정이 그 겹침에서 던진다`, thrown.includes("prev") && thrown.includes("덮는다"), thrown || "던지지 않았다");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
}

async function runViewport(origin, scheme, width, height) {
  const tag = `${ENGINE === "chromium" ? "" : `${ENGINE} `}${width} ${scheme}`;
  const { browser, context, page } = await open(origin, scheme, { width, height });
  try {
    console.log(`--- ${tag}`);
    for (const c of CASES.filter((x) => !x.channel)) await runCase(page, tag, width, c);
    await runSensitivity(page, tag);
    // 두 번째 대화(일반): 마지막 행이 머리 행인 장면. 대화를 바꾼 뒤 목록이 새로 서기를 기다린다.
    const second = CASES.filter((x) => x.channel === "GEN");
    if (second.length > 0) {
      await page.evaluate((h) => { location.hash = h; }, `/c/${GEN}`);
      await page.getByTestId("composer").waitFor({ timeout: 20_000 });
      await page.mouse.move(2, 2);
      await page.waitForTimeout(1200);
      for (const c of second) await runCase(page, tag, width, c);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    ...(DIST_DIR ? { extraArgs: ["--outDir", resolve(DIST_DIR)] } : {}),
  });
  try {
    for (const scheme of SCHEMES) {
      await runViewport(preview.origin, scheme, 390, 844);
      await runViewport(preview.origin, scheme, 720, 860);
      await runViewport(preview.origin, scheme, 1440, 900);
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(
    bad.length === 0
      ? `HOVER-TOOLBAR-5179 PASS (${results.length} checks)`
      : `HOVER-TOOLBAR-5179 FAIL (${bad.length}/${results.length}): ${bad.map((r) => r.name).join(" | ")}`
  );
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
