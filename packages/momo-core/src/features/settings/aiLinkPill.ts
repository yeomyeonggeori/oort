import type { HarnessPill } from "../onboarding/aiConnect";
import { HARNESS_PILL_LABEL } from "../onboarding/aiConnect";
import type { ProviderLink, ProviderLinkTest } from "./api";

// =============================================================================
// AI 연결 줄의 알약 판정 (#2941 GC-0, brief §3.5).
//
// 설정 › AI 연결과 채팅의 로컬 연결 카드(#2944)와 폰 카드(GC-4)가 **같은 입력에
// 같은 알약**을 말해야 한다. 그래서 판정은 여기 한 곳에만 있다. 웹 컴포넌트
// 안에 지역 함수로 있던 `linkPill`(AiLinkSection)과 구독 줄의 색 표
// (AiMyAccountsSection `PILL_TONE`)를 옮겨 왔다. 렌더는 각 클라이언트가 하고,
// 무엇을 말할지는 이 파일이 정한다.
// =============================================================================

/**
 * 알약의 색 갈래. 색만으로 전하지 않는다: 알약 안에는 늘 낱말이 있다.
 * `run`은 도는 중(확인 중…)이다. 시안 `.pill.run`(agent 색).
 */
export type AiPillTone = "ok" | "warn" | "bad" | "mute" | "run";

export interface AiPillView {
  readonly tone: AiPillTone;
  readonly text: string;
}

/** 서버가 확인 호출을 하지 않았다는 사유(#2960 전 서버의 test 라우트). */
export const PROBE_NOT_RUN = "probe_not_run";

/** ChatGPT `auth.json`으로 만든 내부용 연결(ADR-0147). 새로 만들 수 없다. */
export const LEGACY_OAUTH_CREDENTIAL_KIND = "oauth-openai";

/** 이 연결이 내부용(읽기 전용) 연결인가. 와이어의 `credentialKind`를 읽는다. */
export function isLegacyTeamLink(link: ProviderLink): boolean {
  const kind = (link as unknown as Record<string, unknown>).credentialKind;
  return kind === LEGACY_OAUTH_CREDENTIAL_KIND;
}

/**
 * 팀 연결(provider_link) 줄의 알약.
 *
 * 순서가 판정이다: 오프라인이면 마지막 값을 확인할 수 없고, 내부용 연결은 읽기
 * 전용이고, 이 화면에서 확인이 도는 중이면 확인 중, 확인 결과가 있으면 그 결과,
 * 없으면 저장된 사실(키 있음·모의·자격증명 없음·없음)이다.
 */
export function linkPill(input: {
  link: ProviderLink;
  offline: boolean;
  probe: ProviderLinkTest | null;
  checking?: boolean;
}): AiPillView {
  const { link, offline, probe, checking = false } = input;
  if (offline) return { tone: "mute", text: "확인할 수 없음" };
  if (isLegacyTeamLink(link)) return { tone: "mute", text: "읽기 전용" };
  if (checking) return { tone: "run", text: "확인 중…" };
  // 서버가 실제로 부르지 않은 확인(`probe_not_run`, #2960 전)은 실패가 아니다: 키가
  // 거절됐다고 칠하지 않고 「확인 전」이다(#2880, brief §3.2 상태 어휘).
  if (probe && !probe.ok && probe.reason === PROBE_NOT_RUN) return { tone: "mute", text: "확인 전" };
  if (probe) return probe.ok ? { tone: "ok", text: "확인됨" } : { tone: "bad", text: "확인 실패" };
  if (link.configured && link.keyConfigured) {
    return link.availability === "mock"
      ? { tone: "mute", text: "모의 응답" }
      : { tone: "ok", text: "연결됨" };
  }
  if (link.configured) return { tone: "warn", text: "자격증명 없음" };
  return { tone: "mute", text: "연결 안 됨" };
}

const HARNESS_PILL_TONE: Record<HarnessPill, AiPillTone> = {
  ready: "ok",
  login: "warn",
  recheck: "warn",
  checking: "run",
  install: "mute",
};

/** 구독 줄(이 맥의 공식 CLI)의 알약. 판정은 `harnessPill`, 여기는 색과 낱말. */
export function harnessPillView(pill: HarnessPill): AiPillView {
  return { tone: HARNESS_PILL_TONE[pill], text: HARNESS_PILL_LABEL[pill] };
}
