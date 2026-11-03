import { RotateCw, X } from "lucide-react";
import { Tooltip } from "@/design/ui/tooltip";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// 보내지 못한 메시지 곁의 아이콘 둘 (#5210, owner 2026-11-03): 새로고침(다시 보내기) · 빨간 X(지우기).
// 카카오톡·iMessage류의 업계 관례다. 글자 단추가 아니라 아이콘이고, 이름은 툴팁(눈)과 낭독이 읽는다.
//
// 작은 공용 부품으로 둔 이유: 「대화에도 보내기」 화면(#4888)이 밀어서 보낸 답글의 실패를 같은 두 아이콘으로
// 알린다. 시험 id(`pending-resend`·`pending-discard`)는 고정이다 — 다른 표면이 같은 id 를 겹쳐 쓰게 되면 그때
// prop 으로 연다.
//
// 지우기가 AlertDialog 확인 없이 한 번에 지워지는 것은 스킬 §6 「파괴는 확인」의 예외가 아니라 적용 밖이다:
// 지우는 것은 서버에 행이 없는 이 기기의 대기분 하나뿐이고 서버에서는 아무것도 사라지지 않는다(판정은 코어
// `discardPending`, 보내는 중인 행은 지우지 않는다). 한 번 누르기는 owner 결정(2026-11-03)이다.
//
// 위계(디자인 시스템 §3.1): 파괴인 X 만 `text-danger`, 다시 보내기는 `text-ink-muted`다. 둘이 다 붉으면
// 「나가라」와 「버려라」가 같은 무게로 읽힌다(AttachmentTray 의 다시 시도 주석, design-review H-4).
//
// 크기: 눈에 보이는 글리프는 16, 누르는 면은 24(`size-6`, WCAG 2.5.8)이고 600px 미만에서는 `tap-target`이 44로 키운다.
// 클래스는 `className` 속성 값으로만 적는다: 직접 문구 장부(`direct-copy.mjs`)가 `cn()` 인자·상수 문자열의 클래스 목록을
// 영어 문구로 센다.
// =============================================================================

export function SendFailureActions({
  onResend,
  onDiscard,
  resending = false,
}: {
  /** 없으면 새로고침 아이콘을 그리지 않는다. */
  onResend?: () => void;
  /** 없으면 X 를 그리지 않는다. */
  onDiscard?: () => void;
  /** 다시 보내는 요청이 도는 동안 두 번 누르지 못하게 한다. */
  resending?: boolean;
}) {
  const formatMessage = useFormatMessage();
  if (!onResend && !onDiscard) return null;
  const resendLabel = formatMessage("timeline.send.resend");
  const discardLabel = formatMessage("timeline.send.discard");
  return (
    <span
      className="inline-flex items-center gap-1"
      data-testid="pending-actions"
    >
      {onResend && (
        <Tooltip label={resendLabel}>
          <button
            type="button"
            disabled={resending}
            aria-label={resendLabel}
            data-testid="pending-resend"
            onClick={onResend}
            className="tap-target inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-muted press-instant-fill hover:bg-surface-pressed hover:text-ink focus-visible:focus-ring disabled:opacity-50"
          >
            <RotateCw aria-hidden="true" className="size-4" />
          </button>
        </Tooltip>
      )}
      {onDiscard && (
        <Tooltip label={discardLabel}>
          <button
            type="button"
            aria-label={discardLabel}
            data-testid="pending-discard"
            onClick={onDiscard}
            className="tap-target inline-flex size-6 shrink-0 items-center justify-center rounded-full text-danger press-instant-fill hover:bg-surface-pressed focus-visible:focus-ring"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </Tooltip>
      )}
    </span>
  );
}
