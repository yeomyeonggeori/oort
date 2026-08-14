import { useEffect, useRef } from "react";
import { Button } from "@/design/ui/button";
import { CopyButton, KeyValueRows } from "@/features/settings/SettingsFields";
import { REVEAL_DONE_LABEL } from "@momo/core/features/hostedAgents/presets";

// =============================================================================
// 한 번만 보이는 값 한 장 (ADR-0162 D6, goal HAP-UX1 / #1360).
//
// 이 흐름에는 그런 값이 **둘** 있다. 연결 값(pairing)과 active 자격증명은 서로
// 다른 비밀이고 서로 다른 순간에 뜨지만, 화면에서 지켜야 하는 것은 같다. 그래서
// 카드는 하나이고 문구만 갈린다 — 두 장을 따로 만들면 다음 배치가 한 장에만
// 규율을 더한다.
//
// 웹훅 발급 카드(features/settings/WebhookSection.tsx)에서 그대로 가져온 것들과,
// 각각이 막는 것:
//
//   - `role="group"` + `aria-label`, `role="status"` 가 **아니다.** status 는
//      암묵적 live region 이라 카드가 뜨는 순간 비밀값 전체가 자동으로 낭독된다
//      (웹훅 리뷰 M2). 값이 도착했다는 사실을 알리는 데 값을 읽을 필요는 없다.
//   - `tabIndex={-1}` + 등장 시 포커스 이동. 이 카드는 폴드 아래에 렌더될 수 있고,
//      그 순간이 값을 볼 수 있는 유일한 순간이다.
//   - 나가는 길은 이름으로 하나뿐이다: 「저장했습니다」. 다이얼로그의 Esc·바깥
//      클릭은 호출부가 막는다(HostedAgentWizard: Radix 는 층 스택에 들어오지
//      않으므로 `useEscapeGuard` 가 아니라 `onEscapeKeyDown` 이 그 자리다).
//
// 비밀값은 `KeyValueRows` 의 일반 목록에 섞이지 않고 자기 이름표를 단 블록을
// 갖는다. "행을 하나 더 추가"하는 습관만으로 비밀값이 일반 목록에 들어가는 것을
// 막는 것이 그 분리의 전부다.
// =============================================================================

export interface SecretDetailRow {
  key: string;
  value: string;
  token?: boolean;
}

export function OneTimeSecretCard({
  headline,
  warning,
  notes,
  rows,
  secretLabel,
  secret,
  copyLabel,
  expiryLabel,
  onDone,
  doneLabel = REVEAL_DONE_LABEL,
  testId,
}: {
  headline: string;
  warning: string;
  /** 이 값이 무엇이고 무엇이 아닌지. 한 줄씩. */
  notes?: readonly string[];
  /** 비밀값이 아닌 참고 값들(주소, routine 이름 등). */
  rows?: readonly SecretDetailRow[];
  secretLabel: string;
  secret: string;
  copyLabel: string;
  /** 남은 시간 한 마디. 없으면 그 줄이 서지 않는다. */
  expiryLabel?: string;
  onDone: () => void;
  doneLabel?: string;
  testId?: string;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-label={headline}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-ok bg-surface-raised p-4 focus-visible:focus-ring"
      data-testid={testId}
    >
      <p className="break-keep text-body font-medium text-ink">{headline}</p>
      <p className="break-keep text-body text-ink-muted">{warning}</p>
      {notes?.map((note) => (
        <p key={note} className="break-keep text-meta text-ink-muted">
          {note}
        </p>
      ))}

      {rows && rows.length > 0 && (
        <KeyValueRows
          rows={rows.map((row) => ({
            key: row.key,
            value: row.value,
            numeric: row.token,
            prose: !row.token,
          }))}
        />
      )}

      {/* 비밀값은 자기 이름표를 단 블록에 혼자 선다. */}
      <KeyValueRows rows={[{ key: secretLabel, value: secret, numeric: true }]} />

      {expiryLabel && (
        <p className="text-meta text-ink-muted" data-numeric data-testid="hosted-secret-expiry">
          {expiryLabel}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <CopyButton
          value={secret}
          label={copyLabel}
          subject={secretLabel}
          testId="hosted-secret-copy"
        />
        <Button type="button" size="sm" onClick={onDone} data-testid="hosted-secret-done">
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
