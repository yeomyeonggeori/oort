// =============================================================================
// 앱을 쓰다 막혔을 때 보이는 문장 (ADR-0113 증보 2 E8 · plugins-v2-plan 2.5절, #3950 U-S2).
//
// 규칙은 하나다: **막히면 한 문장과 행동 하나만** 보인다. 원인 코드·상태 숫자·벤더 문구를
// 사람에게 옮기지 않는다. 행동이 없으면 문장만 선다(사람이 할 수 있는 일이 없는 막힘에
// 버튼을 만들지 않는다).
//
// 와이어 (이 PR 이 먼저 정한다 — 엔진이 이 칸을 아직 내지 않는다, runtime-unverified):
//
//   message.props.app_notice = {
//     kind: "site_off" | "site_silent" | "login_lost" | "grant_revoked"
//         | "rate_limited" | "egress_blocked" | "not_allowed" | "working",
//     plugin_id?: string,         // 막힌 앱. 이름은 앱 목록에서 읽는다(원문 id 를 말하지 않는다)
//     site?: "mac" | "hermes",    // 실행 장소
//     host?: string,              // egress_blocked 의 막힌 주소(앱 목록이 아는 연결 주소여야 한다)
//     since_ms?: number,          // working: 시작한 때(에포크 ms)
//   }
//
// 화면이 지키는 것:
//   1. **닫힌 세계.** 모르는 kind 는 null. 본문(기존 「답을 만들지 못했어요…」)이 그대로 남는다.
//   2. **모르는 칸은 말하지 않는다.** 앱 이름·실행 장소를 모르면 그 조각 없이 문장이 성립하는
//      낱말(「이 앱」·「이 실행 장소」)로 쓴다. 짐작하지 않는다.
//   3. 서버가 아직 이 칸을 내지 않는 날(옛 서버)에는 props 에 키가 없으므로 화면 변화 0.
//   4. 폰은 동의 창이 없다(plans 2.6): 「허용 안 함」은 「이 앱은 데스크탑이나 웹에서 허용해
//      주세요」 + 「웹에서 열기」 한 개다.
//
// 순수 모듈이다. 웹과 폰이 같은 함수를 부른다.
// =============================================================================

import { attachParticle } from "../../lib/koreanParticle";
import { AI_EXTERNAL_ROWS } from "../ai/aiHubModel";
import type { Message } from "../../lib/api";
import type { AppsTailPlugin } from "./teamAiReply";

type Props = Record<string, unknown> | undefined;

export type AppNoticeKind =
  | "site_off"
  | "site_silent"
  | "login_lost"
  | "grant_revoked"
  | "rate_limited"
  | "egress_blocked"
  | "not_allowed"
  | "working";

const KINDS: ReadonlySet<string> = new Set<AppNoticeKind>([
  "site_off",
  "site_silent",
  "login_lost",
  "grant_revoked",
  "rate_limited",
  "egress_blocked",
  "not_allowed",
  "working",
]);

export type AppNoticeSite = "mac" | "hermes";

/** 앱 화면(AI › 외부 연결 › 앱)의 경로. 다른 곳에서 문자열로 다시 쓰지 않는다. */
export const APPS_SCREEN_PATH: string =
  AI_EXTERNAL_ROWS.find((row) => row.id === "apps")?.path ?? "/ai/external/apps";

/** 행동 하나. `apps` 는 앱 화면으로, `web` 은 웹에서 같은 화면을 여는 것(폰). */
export interface AppNoticeAction {
  kind: "apps" | "web";
  label: string;
}

export interface AppNotice {
  kind: AppNoticeKind;
  /** 화면 문장 한 개. */
  sentence: string;
  /** 행동. 사람이 할 수 있는 일이 없는 막힘에는 null. */
  action: AppNoticeAction | null;
  /** 진행 중인 안내(막힘이 아니다). 경고 색을 쓰지 않는다. */
  progress: boolean;
}

export interface AppNoticeEnv {
  /** 폰은 동의 창이 없다(2.6). */
  surface: "web" | "phone";
  /** 앱 목록. 이름·연결 주소를 여기서 읽는다. */
  plugins: ReadonlyMap<string, AppsTailPlugin>;
  /** 지금(에포크 ms). `working` 의 「n분째」가 이 값에서 나온다. */
  nowMs: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // 제어 문자·양방향 덮어쓰기는 지운다(teamAiReply 의 `clean` 과 같은 뜻).
  // eslint-disable-next-line no-control-regex -- the point is to find them.
  const out = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return out === "" ? null : out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

function siteOf(value: unknown): AppNoticeSite | null {
  return value === "mac" || value === "hermes" ? value : null;
}

/** 「내 맥」「Hermes」. 모르면 null. */
function siteName(site: AppNoticeSite | null): string | null {
  return site === "mac" ? "내 맥" : site === "hermes" ? "Hermes" : null;
}

/** 1분 미만은 「1분째」. 시계가 거꾸로 가면(음수) 0이 아니라 1분으로 둔다. */
export function minutesSince(sinceMs: number, nowMs: number): number {
  return Math.max(1, Math.floor((nowMs - sinceMs) / 60_000));
}

/**
 * `props.app_notice` 를 읽는다. 총 파싱, 던지지 않는다. 모르는 모양이면 null.
 * 지워진 메시지는 호출하는 쪽이 거른다(`appNoticeFor`).
 */
export function parseAppNotice(props: Props, env: AppNoticeEnv): AppNotice | null {
  const raw = record(props?.["app_notice"]);
  if (raw === null) return null;
  const kind = raw["kind"];
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;

  const site = siteOf(raw["site"]);
  const pluginId = text(raw["plugin_id"], 64);
  const plugin = pluginId === null ? undefined : env.plugins.get(pluginId);
  const appName = text(plugin?.name, 24);
  // 이름을 모르면 「이 앱」: 원문 id 를 사람에게 보이지 않는다.
  const app = appName ?? "이 앱";
  const where = siteName(site);
  const phone = env.surface === "phone";

  switch (kind as AppNoticeKind) {
    case "site_off":
      // 꺼진 곳이 내 맥이면 사람이 할 일은 맥을 켜는 것이다. 버튼이 아니라 문장이 말한다.
      return {
        kind: "site_off",
        sentence:
          site === "mac"
            ? "내 맥이 꺼져 있어서 못 했어요. 맥을 켜면 다시 해 볼게요."
            : where === null
              ? "에이전트가 있는 곳이 꺼져 있어서 못 했어요."
              : `${attachParticle(where, "subject")} 꺼져 있어서 못 했어요.`,
        action: null,
        progress: false,
      };
    case "site_silent":
      return {
        kind: "site_silent",
        sentence:
          where === null
            ? "에이전트가 답하지 않아요."
            : `${attachParticle(where, "subject")} 답하지 않아요.`,
        action: null,
        progress: false,
      };
    case "login_lost":
      // 다시 로그인은 내 맥에서만 내가 할 수 있다. Hermes 는 운영자가 한다.
      return site === "hermes"
        ? {
            kind: "login_lost",
            sentence: `${app} 로그인이 끊겼어요. 운영자가 다시 로그인해야 해요.`,
            action: null,
            progress: false,
          }
        : {
            kind: "login_lost",
            sentence: `${app} 로그인이 끊겼어요.`,
            action: phone
              ? { kind: "web", label: "웹에서 열기" }
              : { kind: "apps", label: "다시 로그인" },
            progress: false,
          };
    case "grant_revoked":
      return {
        kind: "grant_revoked",
        sentence: "실행 중에 허용이 회수돼서 여기서 멈췄어요. 이미 한 일은 그대로예요.",
        action: null,
        progress: false,
      };
    case "rate_limited":
      return {
        kind: "rate_limited",
        sentence: `${attachParticle(app, "subject")} 잠시 요청을 막았어요. 1분 뒤 다시 해 주세요.`,
        action: null,
        progress: false,
      };
    case "egress_blocked": {
      // 막힌 주소는 앱 목록이 아는 연결 주소일 때만 말한다. 모르는 주소는 「바깥」으로 접는다.
      const host = text(raw["host"], 80);
      const known = host !== null && (plugin?.egressDomains ?? []).includes(host);
      return {
        kind: "egress_blocked",
        sentence: `에이전트가 ${known ? `${host}에` : "바깥에"} 연결할 수 없어요.`,
        action: null,
        progress: false,
      };
    }
    case "not_allowed":
      return phone
        ? {
            kind: "not_allowed",
            sentence: "이 앱은 데스크탑이나 웹에서 허용해 주세요.",
            action: { kind: "web", label: "웹에서 열기" },
            progress: false,
          }
        : {
            kind: "not_allowed",
            sentence: "먼저 내 사용을 허용해 주세요.",
            action: { kind: "apps", label: "앱 열기" },
            progress: false,
          };
    case "working": {
      const since = raw["since_ms"];
      // 시작 시각을 모르면 「n분째」를 짐작하지 않는다.
      const minutes =
        typeof since === "number" && Number.isFinite(since)
          ? minutesSince(since, env.nowMs)
          : null;
      return {
        kind: "working",
        sentence: `${where ?? "에이전트가 있는 곳"}에서 하는 중${minutes === null ? "" : ` · ${minutes}분째`}`,
        action: null,
        progress: true,
      };
    }
  }
}

/** 이 메시지가 막힘 문장 칸을 들고 있는가(앱 목록 조회 여부를 가르는 값). */
export function hasAppNotice(message: Pick<Message, "props" | "state">): boolean {
  return message.state !== "deleted" && record(message.props?.["app_notice"]) !== null;
}

/** 진행 중(`working`) 안내인가: 분 시계를 돌릴지 가른다. */
export function isWorkingAppNotice(message: Pick<Message, "props">): boolean {
  return record(message.props?.["app_notice"])?.["kind"] === "working";
}

/** 행이 부르는 입구. 지워진 행에는 없다. */
export function appNoticeFor(
  message: Pick<Message, "props" | "state">,
  env: AppNoticeEnv
): AppNotice | null {
  if (message.state === "deleted") return null;
  return parseAppNotice(message.props, env);
}
