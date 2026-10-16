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
// 순수 모듈이다. 웹과 폰이 같은 함수를 부른다.
// =============================================================================

import type { Message } from "../../lib/api";

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

export interface TeamAiReplyMeta {
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

export const TEAM_AI_TOOLS_PREFIX = "찾아본 것";
export const TEAM_AI_SOURCES_LABEL = "출처";

/** 도우미 답의 꼬리를 읽는다. 총 파싱, 던지지 않는다. 그릴 것이 없으면 null. */
export function parseTeamAiReplyMeta(props: Props): TeamAiReplyMeta | null {
  if (!props || props["source"] !== "team_ai") return null;
  // 넘기는 줄(`team_ai.delegate.v1`)은 자기 띠를 갖는다. 같은 메시지에 꼬리를 또 달지 않는다.
  if (props["kind"] === "team_ai.delegate.v1") return null;

  const labels: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(props["tools_used"])
    ? (props["tools_used"] as unknown[])
    : []) {
    const label = toolLabel(value);
    if (label === null || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }

  const citations: TeamAiWebCitation[] = [];
  const urls = new Set<string>();
  for (const value of Array.isArray(props["web_citations"])
    ? (props["web_citations"] as unknown[])
    : []) {
    const item = citation(value);
    if (item === null || urls.has(item.url)) continue;
    urls.add(item.url);
    citations.push(item);
    if (citations.length >= MAX_WEB_CITATIONS) break;
  }

  const modelLabel = clean(props["model_label"], MODEL_LABEL_MAX);
  const shown = labels.slice(0, MAX_TOOL_LABELS);
  const rest = labels.length - shown.length;
  const toolsLine =
    labels.length === 0
      ? null
      : `${TEAM_AI_TOOLS_PREFIX}: ${shown.join(" · ")}${rest > 0 ? ` 외 ${rest}개` : ""}`;
  const meta: TeamAiReplyMeta = {
    toolsLine,
    toolsSpoken:
      labels.length === 0 ? null : `${TEAM_AI_TOOLS_PREFIX}: ${labels.join(", ")}`,
    citations,
    modelChip: modelLabel === null ? null : `팀 AI · ${modelLabel}`,
  };
  if (meta.toolsLine === null && citations.length === 0 && meta.modelChip === null) {
    return null;
  }
  return meta;
}

/** 행이 부르는 입구. 지워진 행에는 없다. */
export function teamAiReplyMetaFor(
  message: Pick<Message, "props" | "state">
): TeamAiReplyMeta | null {
  if (message.state === "deleted") return null;
  return parseTeamAiReplyMeta(message.props);
}

/** 출처 링크의 접근 이름. 새 창으로 열린다는 것을 말한다. */
export function citationAccessibleName(item: TeamAiWebCitation): string {
  return item.title === item.host
    ? `${item.host}, 새 창에서 열기`
    : `${item.title}, ${item.host}, 새 창에서 열기`;
}
