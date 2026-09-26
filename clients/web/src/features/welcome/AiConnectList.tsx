import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import {
  AI_CONNECT_ROW_COPY,
  API_KEY_PILL_LABEL,
  HARNESS_INSTALL_URL,
  HARNESS_LABEL,
  HARNESS_PILL_LABEL,
  isSubscriptionRow,
  subscriptionRowSelectable,
  type AiConnectRowId,
  type HarnessPill,
} from "@momo/core/features/onboarding/aiConnect";
import { LOGIN_ROW_HINT, loginActionLabel } from "@momo/core/features/onboarding/harnessLogin";
import { Button } from "@/design/ui/button";
import { openExternalUrl } from "@/lib/tauri";

// Reading this as: onboarding (AI 연결 목록) for internal team users on
// web+Tauri, density 6/10, motion 1/10 (no row motion; the kometto carries it).

/**
 * 「누구의 AI로 생각할까요?」 목록 (#2814, 시안 D4 `.opt`). 한 줄 = 라디오 ·
 * 글자 타일 · 이름과 한 줄 설명 · 상태 알약. 구독 줄은 CLI가 로그인됨을 알린
 * 때만 고를 수 있고(`준비됨`), 로그인이 필요하면 그 줄 아래 명령 한 줄이 선다.
 *
 * 알약은 한 단어 하나의 행동이다(Buzz). 설치 필요 → 공식 설치 안내, 다시 확인
 * → 다시 묻기. 로그인 필요의 행동은 알약이 아니라 아래 줄의 「Claude Code로
 * 로그인」「Codex로 로그인」이다(로그인 모달, #2816). 「Claude로 로그인」처럼
 * 제공자 이름으로 된 버튼은 없다(ADR-0193 D2 개정).
 */
export function AiConnectList({
  rows,
  selected,
  onSelect,
  pill,
  onLoginOpen,
  onRecheck,
  grokPill,
  locked,
  probed,
  describedBy,
}: {
  rows: readonly AiConnectRowId[];
  selected: AiConnectRowId | null;
  onSelect: (id: AiConnectRowId) => void;
  pill: (id: LocalHarnessId) => HarnessPill;
  /** 로그인 모달을 연다(#2816). */
  onLoginOpen: (id: LocalHarnessId) => void;
  onRecheck: (id: LocalHarnessId) => void;
  /** 그록봇 줄 알약. 데스크탑에서 감지되지 않았을 때만 「설치 안 됨」. */
  grokPill: string | null;
  /** 오프라인·목록 오류. 줄은 보이고 고를 수 없다. */
  locked: boolean;
  /**
   * 셸이 한 번이라도 답했는가. 답하기 전의 「확인 중…」은 아직 모르는 상태라
   * 로그인 줄을 세우지 않는다(design-review H1). 답한 뒤의 「확인 중…」은
   * 로그인 뒤 재확인이다.
   */
  probed: boolean;
  describedBy?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="에이전트가 쓸 AI"
      aria-disabled={locked || undefined}
      aria-describedby={describedBy}
      className="flex min-w-0 flex-col gap-3"
      data-testid="ai-connect-list"
    >
      {rows.map((id) => {
        const copy = AI_CONNECT_ROW_COPY[id];
        const harnessPill = isSubscriptionRow(id) ? pill(id) : null;
        const selectable =
          !locked && (harnessPill === null || subscriptionRowSelectable(harnessPill));
        const on = selected === id;
        const inputId = `ai-connect-${id}`;
        const detailId = `${inputId}-detail`;
        const pillId = `${inputId}-pill`;
        const needsLogin =
          isSubscriptionRow(id) &&
          probed &&
          (harnessPill === "login" || harnessPill === "checking" || harnessPill === "recheck");
        return (
          <div key={id} className="flex min-w-0 flex-col gap-2">
            <div
              className="ai-connect-opt"
              data-selected={on ? "true" : undefined}
              data-selectable={selectable ? "true" : "false"}
              data-testid="ai-connect-row"
              data-row-id={id}
            >
              <label htmlFor={inputId} className="ai-connect-opt-label press">
                <input
                  type="radio"
                  id={inputId}
                  name="ai-connect"
                  value={id}
                  checked={on}
                  disabled={!selectable}
                  aria-describedby={[detailId, harnessPill ? pillId : null]
                    .filter(Boolean)
                    .join(" ")}
                  onChange={() => onSelect(id)}
                  className="ai-connect-radio focus-visible:focus-ring"
                  data-testid={`ai-connect-radio-${id}`}
                />
                <span className="ai-connect-mark" data-mark={id} aria-hidden="true">
                  {copy.mark}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="ai-connect-title">{copy.title}</span>
                  <span id={detailId} className="ai-connect-detail">
                    {copy.detail}
                  </span>
                </span>
              </label>
              {isSubscriptionRow(id) && harnessPill !== null ? (
                <HarnessPillControl
                  id={id}
                  pill={harnessPill}
                  pillId={pillId}
                  onRecheck={onRecheck}
                />
              ) : id === "api-key" ? (
                <span className="ai-connect-pill" data-tone="mute" id={pillId}>
                  {API_KEY_PILL_LABEL}
                </span>
              ) : id === "grok" && grokPill ? (
                <span className="ai-connect-pill" data-tone="mute" id={pillId}>
                  {grokPill}
                </span>
              ) : null}
            </div>
            {needsLogin && isSubscriptionRow(id) && (
              <LoginRow id={id} onLoginOpen={onLoginOpen} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function HarnessPillControl({
  id,
  pill,
  pillId,
  onRecheck,
}: {
  id: LocalHarnessId;
  pill: HarnessPill;
  pillId: string;
  onRecheck: (id: LocalHarnessId) => void;
}) {
  const label = HARNESS_PILL_LABEL[pill];
  if (pill === "install") {
    return (
      <button
        type="button"
        id={pillId}
        className="ai-connect-pill ai-connect-pill-action press focus-visible:focus-ring"
        data-tone="mute"
        aria-label={`${HARNESS_LABEL[id]} ${label}, 설치 안내 열기`}
        onClick={() => void openExternalUrl(HARNESS_INSTALL_URL[id])}
        data-testid={`ai-connect-pill-${id}`}
        data-pill={pill}
      >
        {label}
      </button>
    );
  }
  if (pill === "recheck") {
    return (
      <button
        type="button"
        id={pillId}
        className="ai-connect-pill ai-connect-pill-action press focus-visible:focus-ring"
        data-tone="mute"
        aria-label={`${HARNESS_LABEL[id]} ${label}`}
        onClick={() => onRecheck(id)}
        data-testid={`ai-connect-pill-${id}`}
        data-pill={pill}
      >
        {label}
      </button>
    );
  }
  const tone = pill === "ready" ? "ok" : pill === "login" ? "warn" : "mute";
  return (
    <span
      id={pillId}
      className="ai-connect-pill"
      data-tone={tone}
      role={pill === "checking" ? "status" : undefined}
      data-testid={`ai-connect-pill-${id}`}
      data-pill={pill}
    >
      {label}
    </span>
  );
}

/**
 * 로그인이 필요한 줄 아래의 한 줄: 짧은 안내 + [Claude Code로 로그인]. 누르면
 * 로그인 모달(#2816)이 열리고, 앱이 숨은 PTY에서 공식 CLI 로그인을 돌린다.
 * 평문 버튼이다: 로고·브랜드 색·「Sign in with …」 모양이 없다(ADR-0193 D2 개정).
 */
function LoginRow({
  id,
  onLoginOpen,
}: {
  id: LocalHarnessId;
  onLoginOpen: (id: LocalHarnessId) => void;
}) {
  const hintId = `ai-connect-login-hint-${id}`;
  return (
    <div className="ai-connect-login" data-testid={`ai-connect-login-${id}`}>
      <p id={hintId} className="min-w-0 flex-1 break-keep text-meta text-ink-muted">
        {LOGIN_ROW_HINT}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ai-connect-term-action ai-connect-secondary"
        aria-describedby={hintId}
        onClick={() => onLoginOpen(id)}
        data-testid={`ai-connect-login-open-${id}`}
      >
        {loginActionLabel(id)}
      </Button>
    </div>
  );
}
