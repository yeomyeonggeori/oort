// =============================================================================
// 도우미 답의 꼬리: 찾아본 것 · 웹 출처 · 모델 라벨 (ADR-0201 증보 v2 H4·H5·H9-I9, #3893).
//
// 서버 쪽 계약 (S2·S3·S4가 맞출 모양, 이 PR이 먼저 정한다). 도우미가 쓴 답 메시지의
// `props` 는 지금도 `{source:"team_ai", run_id}` 를 든다(#3837 `team_ai_finish`). v2 답은
// 같은 자리에 다음 세 칸을 **선택으로** 더한다:
//
//   model_label:   string                       가린 모델 이름(예: "Claude Sonnet 4.5"). 키·주소 없음.
//   tools_used:    [{name, channel?}]           부른 읽기 도구, 부른 순서. `name` 은 H4-1의 도구
//                                               이름 그대로, `web_search` 는 H5의 검색. `channel` 은
//                                               `read_channel` 의 채널 이름(`#` 없이). 회신 채널
//                                               청중 규칙(H4-3)을 통과한 출처만 싣는다.
//   web_citations: [{url, title?}]              웹 검색이 답에 쓴 출처.
//
// 화면이 지키는 것:
//   1. **닫힌 세계.** `source === "team_ai"` 인 메시지에서만 읽는다. 모르는 도구 이름은 줄에
//      싣지 않는다(원문 id를 사람에게 보이지 않는다). http(s)가 아닌 주소는 링크가 아니다.
//   2. 칸이 없으면(옛 서버, 카드만 낸 답) 아무 것도 그리지 않는다. 그것이 기능 감지다.
//   3. 이 꼬리는 서버가 적은 **사실**이고 모델이 쓴 글이 아니다. 본문과 다른 층이라는 것을
//      글자 크기와 색으로만 말하고, 본문 속 링크를 출처로 읽지 않는다.
//
// ## 「쓴 앱」 (ADR-0113 증보 2 E8·E10, #3950) — 같은 꼬리의 확장이다. 따로 만들지 않는다.
//
// 앱을 쓴 에이전트의 답에는 도구 사용 줄 옆(아래)에 한 줄이 더 붙는다:
//
//   쓴 앱: Gmail 검색 2회 · 구민수 명의 · gmailmcp.googleapis.com · Hermes에서 · 실행 장소 보고
//   이 채널 12명에게 보여요 · 개인 앱 내용은 요약만 올리는 게 원칙이에요. …
//
//   1. **자기 보고다.** 값은 실행 장소(Hermes·내 맥·호스팅 에이전트)가 스스로 알린
//      `appsUsed` 이고 서버는 검증하지 않았다. 줄 끝의 「실행 장소 보고」가 그 말이다.
//   2. **있는 조각만 그린다.** 명의(누구의 권한으로)·연결 주소·실행 장소는 알 때만 싣고,
//      짐작해서 채우지 않는다. 보고가 없으면 줄 자체가 없다(영수증을 만들지 않는다).
//   3. **채널 노출(E10).** 채널(DM 아님)이면 둘째 줄에 「이 채널 n명에게 보여요」. 개인 앱
//      (Gmail·캘린더·드라이브)이면 「요약만」이 **원칙**이라는 것과 그것을 oort 가 확인하지
//      못한다는 것을 함께 말한다. 강제처럼 쓰지 않는다.
//   4. 데이터는 run 상세의 `appsUsed`(또는 같은 모양이 `message.props` 에 실렸을 때)에서 온다.
//      `message.props` 에 아직 이 칸을 싣는 서버는 없다(#3946 은 run 에만 싣는다).
//
// 순수 모듈이다. 웹과 폰이 같은 함수를 부른다.
// =============================================================================

import { appsUsedFromWire, type AppsUsedEntry, type Message } from "../../lib/api";

type Props = Record<string, unknown> | undefined;

/** H4-1 읽기 도구 8개 + H5 웹 검색. 이름은 서버 도구 이름 그대로다. */
const TOOL_LABELS: ReadonlyMap<string, string> = new Map([
  ["search_messages", "메시지 검색"],
  ["read_channel", "채널 읽기"],
  ["read_thread", "스레드 읽기"],
  ["list_members", "멤버 목록"],
  ["list_agent_runs", "에이전트 작업 기록"],
  ["get_agent_run", "작업 단계 보기"],
  ["list_plugins", "앱 목록"],
  ["read_workspace_settings", "워크스페이스 설정"],
  ["web_search", "웹 검색"],
]);

/** 한 줄에 보이는 도구 수. 넘치면 「외 N개」. */
export const MAX_TOOL_LABELS = 4;
/** 출처 상한. 서버 `max_uses: 3` 이지만 한 번 검색에 출처가 여럿일 수 있다. */
export const MAX_WEB_CITATIONS = 5;

const MODEL_LABEL_MAX = 48;
const TITLE_MAX = 120;
const CHANNEL_MAX = 80;
// 제어 문자·양방향 덮어쓰기는 지운다(로스터 `data_line` 정리와 같은 뜻).
// eslint-disable-next-line no-control-regex -- the point is to find them.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface TeamAiWebCitation {
  url: string;
  /** 보이는 이름. 제목이 없으면 호스트. */
  title: string;
  /** `www.` 를 뗀 호스트. 제목 옆 흐린 자리. */
  host: string;
}

/** 개인 데이터를 사람 토큰으로 읽는 앱(ADR-0113 증보 2 E10). 채널에 새는 길이 가장 현실적인 앱이다. */
const PERSONAL_APP_IDS: ReadonlySet<string> = new Set([
  "gmail",
  "google-calendar",
  "google-drive",
]);

/** 앱 카탈로그에서 꼬리가 읽는 두 칸. */
export interface AppsTailPlugin {
  name: string;
  egressDomains: readonly string[];
}

/**
 * 「쓴 앱」 줄을 그리는 데 필요한 바깥 사실. 화면이 모아 넘기고, 모르는 칸은 null 이다.
 * 어느 칸도 **짐작해서 채우지 않는다**.
 */
export interface AppsTailContext {
  /** run 상세의 `appsUsed`. 없으면 `message.props` 를 본다. */
  appsUsed: readonly AppsUsedEntry[] | null;
  /** 앱 id → 이름·연결 주소(앱 목록). 목록에 없는 앱은 이름을 말하지 않는다. */
  plugins: ReadonlyMap<string, AppsTailPlugin>;
  /** 에이전트가 **누구의 권한으로** 움직였는지(위임 사용자의 표시 이름). 모르면 null. */
  onBehalfOf: string | null;
  /** 답을 만든 실행 장소(`appsRunSiteOf`). 모르면 null. */
  site: AppsRunSite | null;
  /** 채널(DM 아님)의 멤버 수. DM·알 수 없음이면 null. */
  audience: number | null;
}

/** 답을 만든 실행 장소. 알 수 있을 때만 말한다. */
export type AppsRunSite = "hermes" | "mac";

/**
 * `props.source` 로 알 수 있는 실행 장소. 지금 메시지에 표식이 있는 곳은 Hermes 게이트웨이뿐이다.
 * 내 맥 답은 그 표식이 메시지에 실리는 날 여기에 한 줄을 더한다(없는 값을 짐작하지 않는다).
 */
export function appsRunSiteOf(props: Props): AppsRunSite | null {
  return props?.["source"] === "hermes_gateway" ? "hermes" : null;
}

/** 같은 판정을 메시지째로 부르는 입구(폰은 메시지 props 를 스스로 읽지 않는다). */
export function appsRunSiteOfMessage(message: Pick<Message, "props">): AppsRunSite | null {
  return appsRunSiteOf(message.props);
}

/**
 * 「쓴 앱」을 조회할 만한 답인가: 성공한 게이트웨이 답이고 run id 가 있다. 있으면 그 run id.
 * (작성자가 에이전트인지는 화면이 멤버 목록으로 따로 본다.)
 */
export function appsRunIdOf(message: Pick<Message, "props" | "state">): string | null {
  if (message.state === "deleted") return null;
  const props = message.props;
  if (!props || appsRunSiteOf(props) === null || props["status"] === "failed") return null;
  const runId = props["run_id"];
  return typeof runId === "string" && runId !== "" ? runId : null;
}

export function appsRunSiteLabel(site: AppsRunSite): string {
  return site === "hermes" ? "Hermes" : "내 맥";
}

export interface TeamAiReplyMeta {
  /**
   * 「쓴 앱: Gmail 검색 2회 · 구민수 명의 · gmailmcp.googleapis.com · Hermes에서 · 실행 장소 보고」.
   * 실행 장소의 자기 보고다. 보고가 없으면 null(빈 꼬리를 만들지 않는다).
   */
  appsLine: string | null;
  /** 같은 사실을 스크린리더가 읽는 문장. */
  appsSpoken: string | null;
  /** 「자세히」 뒤에 접어 두는 줄들: 명의 · 연결 주소 · 자기 보고 안내 · 개인 앱 안내. 앱 보고가 없으면 빈 배열. */
  appsDetails: string[];
  /** 채널 노출(E10) 문구. 기본 꼬리 줄에 들어 있다. 채널이 아니거나 앱 보고가 없으면 null. */
  exposureLine: string | null;
  /** 개인 앱을 채널에 올렸을 때의 안내: 「요약만」은 원칙이고 oort 가 확인하지 못한다. */
  personalNote: string | null;
  /** 「찾아본 것: …」 한 줄. 아는 도구가 없으면 null. */
  toolsLine: string | null;
  /** 같은 사실을 스크린리더가 읽는 문장(줄과 같다. 「외 N개」 대신 전부 읽는다). */
  toolsSpoken: string | null;
  citations: TeamAiWebCitation[];
  /** 「팀 AI · Claude Sonnet 4.5」. 서버가 라벨을 안 보냈으면 null. */
  modelChip: string | null;
}

function toolLabel(value: unknown): string | null {
  const raw = record(value);
  if (raw === null) return null;
  const name = typeof raw["name"] === "string" ? raw["name"] : null;
  if (name === null) return null;
  const label = TOOL_LABELS.get(name);
  if (label === undefined) return null;
  if (name === "read_channel") {
    const channel = clean(raw["channel"], CHANNEL_MAX)?.replace(/^#+/, "");
    return channel ? `#${channel} 읽기` : label;
  }
  return label;
}

/** http(s) 절대 주소만. 사람·자격이 든 주소(`user:pass@`)는 버린다. */
function citation(value: unknown): TeamAiWebCitation | null {
  const raw = record(value);
  if (raw === null || typeof raw["url"] !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw["url"]);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.replace(/^www\./, "");
  if (host === "") return null;
  return {
    url: url.toString(),
    title: clean(raw["title"], TITLE_MAX) ?? host,
    host,
  };
}

const NO_APPS_CONTEXT: AppsTailContext = {
  appsUsed: null,
  plugins: new Map(),
  onBehalfOf: null,
  site: null,
  audience: null,
};

export const APPS_TAIL_PREFIX = "쓴 앱";
export const APPS_TAIL_SELF_REPORT = "앱과 횟수는 에이전트가 알려 준 대로예요. oort는 확인하지 못해요.";
export const APPS_DETAIL_TOGGLE = { open: "자세히", close: "접기" } as const;
/** 개인 앱 안내: 「요약만」은 원칙이고, 지키는지는 oort 가 확인하지 못한다(강제가 아니다). */
export const APPS_PERSONAL_NOTE =
  "개인 앱은 요약만 올리는 게 원칙이에요. oort는 지키는지 확인하지 못해요.";
const DOMAINS_SHOWN = 2;

/** 도구 이름 앞 낱말 → 사람 말. 모르는 앞 낱말은 말하지 않는다(원문 id 를 보이지 않는다). */
const TOOL_VERBS: ReadonlyMap<string, string> = new Map([
  ["search", "검색"],
  ["list", "목록"],
  ["get", "읽기"],
  ["read", "읽기"],
  ["create", "만들기"],
  ["update", "고치기"],
]);

function verbOf(tool: string): string | null {
  return TOOL_VERBS.get(tool.split(/[_.-]/, 1)[0]?.toLowerCase() ?? "") ?? null;
}

interface AppsTail {
  line: string;
  spoken: string;
  details: string[];
  exposure: string | null;
  personalNote: string | null;
}

function appsTail(ctx: AppsTailContext, entries: readonly AppsUsedEntry[]): AppsTail {
  const order: string[] = [];
  const byApp = new Map<string, AppsUsedEntry[]>();
  for (const entry of entries) {
    const list = byApp.get(entry.pluginId);
    if (list) list.push(entry);
    else {
      byApp.set(entry.pluginId, [entry]);
      order.push(entry.pluginId);
    }
  }
  const apps: string[] = [];
  const domains: string[] = [];
  let personal = false;
  for (const id of order) {
    const list = byApp.get(id) ?? [];
    const plugin = ctx.plugins.get(id);
    const calls = list.reduce((sum, item) => sum + item.calls, 0);
    const verbs = new Set(list.map((item) => verbOf(item.tool)));
    const verb = verbs.size === 1 ? [...verbs][0] : null;
    // 목록에 없는 앱은 원문 id 대신 「다른 앱」이라고만 말한다.
    const name = clean(plugin?.name, 24) ?? "다른 앱";
    apps.push(`${name}${verb ? ` ${verb}` : ""} ${calls}회`);
    for (const domain of plugin?.egressDomains ?? []) {
      const host = clean(domain, 80);
      if (host !== null && !domains.includes(host)) domains.push(host);
    }
    // 공식 앱 id 는 `com.momo.plugins.gmail` 처럼 점으로 이어진 모양일 수 있다: 끝 토큰으로 판정한다.
    if (PERSONAL_APP_IDS.has(id) || PERSONAL_APP_IDS.has(id.split(".").pop() ?? "")) personal = true;
  }
  const owner = clean(ctx.onBehalfOf, 24);
  const shown = domains.slice(0, DOMAINS_SHOWN);
  const audience =
    ctx.audience !== null && Number.isInteger(ctx.audience) && ctx.audience > 0
      ? ctx.audience
      : null;
  const exposure = audience === null ? null : `이 채널 ${audience}명에게 보여요`;
  const personalNote = audience !== null && personal ? APPS_PERSONAL_NOTE : null;
  // 기본 꼬리는 **한 줄**이고 메시지마다 달라지는 사실만 싣는다(채널·에이전트 상수를 되풀이하지
  // 않는다): 앱·횟수. 채널에 새기 쉬운 **개인 앱**일 때만 노출 수가 그 줄에 붙는다.
  const parts = [apps.join(", "), personal ? exposure : null].filter(
    (part): part is string => part !== null
  );
  // 나머지는 「자세히」 뒤에 둔다: 실행 장소, 노출(개인 앱이 아닐 때), 명의·연결 주소(oort 가 아는
  // 값), 자기 보고 안내, 개인 앱 안내.
  const details = [
    ctx.site ? `${appsRunSiteLabel(ctx.site)}에서 실행했어요.` : null,
    personal ? null : exposure,
    owner ? `${owner} 명의로 썼어요.` : null,
    shown.length > 0
      ? `연결: ${shown.join(", ")}${domains.length > shown.length ? ` 외 ${domains.length - shown.length}곳` : ""}`
      : null,
    APPS_TAIL_SELF_REPORT,
    personalNote,
  ].filter((part): part is string => part !== null);
  return {
    line: `${APPS_TAIL_PREFIX}: ${parts.join(" · ")}`,
    // 낭독은 접힌 것도 전부 읽는다.
    spoken: `${APPS_TAIL_PREFIX}, ${[...parts, ...details].join(", ")}`,
    details,
    exposure,
    personalNote,
  };
}

/**
 * 「쓴 앱」으로 읽을 보고: run 상세가 준 것이 먼저, 없으면 같은 모양이 메시지에 실렸을 때.
 * 둘 다 서버와 같은 닫힌 규칙(`appsUsedFromWire`)을 통과해야 한다.
 */
export function appsUsedOf(
  props: Props,
  ctx: Pick<AppsTailContext, "appsUsed"> | undefined
): readonly AppsUsedEntry[] | null {
  const fromRun = ctx?.appsUsed ? appsUsedFromWire(ctx.appsUsed) : null;
  if (fromRun !== null) return fromRun;
  return appsUsedFromWire(props?.["appsUsed"] ?? props?.["apps_used"]);
}

export const TEAM_AI_TOOLS_PREFIX = "찾아본 것";
export const TEAM_AI_SOURCES_LABEL = "출처";

/**
 * 도우미 답의 꼬리를 읽는다. 총 파싱, 던지지 않는다. 그릴 것이 없으면 null.
 *
 * `apps` 는 「쓴 앱」 줄의 바깥 사실이다. 도우미(`team_ai`) 가 아닌 에이전트 답에도
 * 앱 보고가 있으면 줄이 선다(도우미는 앱 도구를 부르지 않으므로 그 답에는 서지 않는다).
 */
export function parseTeamAiReplyMeta(
  props: Props,
  apps?: AppsTailContext
): TeamAiReplyMeta | null {
  const isTeamAi = !!props && props["source"] === "team_ai";
  // 넘기는 줄(`team_ai.delegate.v1`)은 자기 띠를 갖는다. 같은 메시지에 꼬리를 또 달지 않는다.
  if (isTeamAi && props?.["kind"] === "team_ai.delegate.v1") return null;

  const entries = isTeamAi ? null : appsUsedOf(props, apps);
  const tail = entries !== null ? appsTail(apps ?? NO_APPS_CONTEXT, entries) : null;
  if (!isTeamAi && tail === null) return null;

  const labels: string[] = [];
  const seen = new Set<string>();
  for (const value of isTeamAi && Array.isArray(props?.["tools_used"])
    ? (props["tools_used"] as unknown[])
    : []) {
    const label = toolLabel(value);
    if (label === null || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }

  const citations: TeamAiWebCitation[] = [];
  const urls = new Set<string>();
  for (const value of isTeamAi && Array.isArray(props?.["web_citations"])
    ? (props["web_citations"] as unknown[])
    : []) {
    const item = citation(value);
    if (item === null || urls.has(item.url)) continue;
    urls.add(item.url);
    citations.push(item);
    if (citations.length >= MAX_WEB_CITATIONS) break;
  }

  const modelLabel = isTeamAi ? clean(props?.["model_label"], MODEL_LABEL_MAX) : null;
  const shown = labels.slice(0, MAX_TOOL_LABELS);
  const rest = labels.length - shown.length;
  const toolsLine =
    labels.length === 0
      ? null
      : `${TEAM_AI_TOOLS_PREFIX}: ${shown.join(" · ")}${rest > 0 ? ` 외 ${rest}개` : ""}`;
  const meta: TeamAiReplyMeta = {
    appsLine: tail?.line ?? null,
    appsSpoken: tail?.spoken ?? null,
    appsDetails: tail?.details ?? [],
    exposureLine: tail?.exposure ?? null,
    personalNote: tail?.personalNote ?? null,
    toolsLine,
    toolsSpoken:
      labels.length === 0 ? null : `${TEAM_AI_TOOLS_PREFIX}: ${labels.join(", ")}`,
    citations,
    modelChip: modelLabel === null ? null : `팀 AI · ${modelLabel}`,
  };
  if (
    meta.appsLine === null &&
    meta.toolsLine === null &&
    citations.length === 0 &&
    meta.modelChip === null
  ) {
    return null;
  }
  return meta;
}

/** 행이 부르는 입구. 지워진 행에는 없다. */
export function teamAiReplyMetaFor(
  message: Pick<Message, "props" | "state">,
  apps?: AppsTailContext
): TeamAiReplyMeta | null {
  if (message.state === "deleted") return null;
  return parseTeamAiReplyMeta(message.props, apps);
}

/** 출처 링크의 접근 이름. 새 창으로 열린다는 것을 말한다. */
export function citationAccessibleName(item: TeamAiWebCitation): string {
  return item.title === item.host
    ? `${item.host}, 새 창에서 열기`
    : `${item.title}, ${item.host}, 새 창에서 열기`;
}
