import type { Message } from "../../lib/api";

// =============================================================================
// 서버 안내 줄의 「다음에 갈 곳」 (#2871).
//
// 호스티드 에이전트가 서버 사정으로 답하지 못하면 서버가 그 에이전트 이름으로
// 시스템 한 줄을 남긴다(`routes/agent_mentions.rs` `hosted_skip_notice`). 고칠
// 곳이 앱 안에 있는 사유(채널 미승인, 연결 끊김)는 `props.notice_action` 에
// `{label, href}` 를 싣는다. 본문 마크다운은 http(s)만 링크로 만들므로
// (`markdown.ts` `safeHref`) 앱 안 경로는 이 칸으로만 문이 된다.
//
// 판정은 닫혀 있다: 이 출처의 시스템 줄이고, href 가 `/settings?section=<id>`
// 모양이고, 그 섹션이 **이 빌드에서 도착할 수 있을 때만** 문이다. 도착할 수
// 없는 섹션으로 문을 세우면 누른 사람이 아무 말 없이 프로필에 떨어진다
// (settingsNav.ts `reachableSettingsSections` 의 R1 H1 결함). 모르면 null 이고,
// 그때도 본문 문장이 「설정 › 에이전트 자격」을 글로 말한다.
// =============================================================================

/** 이 문을 실을 수 있는 서버 안내의 출처. */
export const HOSTED_SKIP_NOTICE_SOURCE = "server.hosted_agent.notice.v1";

export interface NoticeAction {
  label: string;
  href: string;
}

const SETTINGS_HREF = /^\/settings\?section=([a-z-]+)$/;

export function noticeAction(
  message: Pick<Message, "type" | "props">,
  isReachableSettingsSection: (section: string) => boolean
): NoticeAction | null {
  if (message.type !== "system") return null;
  const props = message.props;
  if (props?.["source"] !== HOSTED_SKIP_NOTICE_SOURCE) return null;
  const action = props["notice_action"];
  if (typeof action !== "object" || action === null) return null;
  const { label, href } = action as Record<string, unknown>;
  if (typeof label !== "string" || label.trim() === "") return null;
  if (typeof href !== "string") return null;
  const section = SETTINGS_HREF.exec(href)?.[1];
  if (section === undefined || !isReachableSettingsSection(section)) return null;
  return { label, href };
}
