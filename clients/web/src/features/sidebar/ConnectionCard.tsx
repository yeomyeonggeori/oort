import { useRef } from "react";
import { Button } from "@/design/ui/button";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { ConnectionMark } from "@/features/common/ConnectionMark";
import { useConnection } from "@/features/common/connectionContext";
import { CONNECTION_KEYS as K } from "@momo/core/features/connection/copyKeys";
import { presentConnection } from "@momo/core/features/connection/presentation";

// =============================================================================
// 사이드바 아래 연결 카드 (#5220, #5201 S-B, owner 결정 ① 2026-11-03: Buzz 방식).
//
// 연결이 정상이면 **카드 자체가 없다**(건강은 침묵이다, 감사 문서 §4 원칙 1). 말할 때는 프로필 줄 바로 위에
// 한 장: 제목 한 줄, 이유 한 줄, 곁의 표시, 그리고 할 수 있는 일이 있으면 「지금 다시 연결」. 상태는 넷이다.
//
//   연결 중                 1~10초. 단추 없음. 1초 안의 흔들림은 말하지 않는다.
//   끊김                    소켓 틈이 10초를 넘음(REST는 정상). 보내기·승인은 막지 않는다(결정 ③).
//   오프라인                기기가 망이 없다고 했다. 즉시. 마크가 선다. 단추 없음.
//   서버에 닿지 못함        서로 다른 요청이 연달아 닿지 못했다. 보내기·올리기·승인을 막는다.
//
// 「끊김」이 보였다가 정상이 되면 2초 「다시 연결됐어요」를 보이고 사라진다. 한 곳에서만 말한다: 폰 폭의
// 서랍이거나 목록 열이 접히면 이 카드는 서지 않고 위쪽 띠(`ConnectionBanner`)가 같은 문장·같은 단추로
// 말한다(`connectionSurfaceFor`가 어느 쪽인지 가른다).
//
// 그릇은 프로필 줄 위의 「알림 멈춤」 줄(`PauseBanner`)과 같은 문법이다: 사이드바가 흰 면을 쓰는 방식
// (`glass band-surface` + rest 그림자), 글자는 프로필 줄과 같은 역할(제목 `text-label`, 이유 `text-meta`
// 약한 글자). 서버 응답 코드·원문은 말하지 않는다(Buzz가 하는 일을 따라 하지 않는다, 감사 문서 §3).
// =============================================================================

export function ConnectionCard() {
  const { view, recovered, reconnectNow } = useConnection();
  const formatMessage = useFormatMessage();
  const cardRef = useRef<HTMLDivElement>(null);
  const shown = presentConnection(view, recovered);
  if (shown === null) return null;

  return (
    <div
      ref={cardRef}
      // 누른 단추는 「연결 중」으로 바뀌며 사라진다. 초점이 <body>로 떨어지지 않도록 카드가 받는다(키보드로 눌렀을
      // 때만 링이 선다: focus-visible).
      tabIndex={-1}
      role="status"
      data-testid="connection-card"
      data-tone={shown.tone}
      data-phase={view.phase}
      data-cause={view.cause ?? undefined}
      className="pt-2 focus-visible:focus-ring"
    >
      <div className="glass band-surface flex flex-col gap-2 rounded-lg px-3 py-2 text-ink shadow-sm">
        <div className="flex items-start gap-2">
          {/* 사이드바 폭에서는 긴 제목이 우연한 자리에서 끊긴다. 어절에서 끊고(`break-keep`) 두 줄이면 비슷한
              길이로 접는다(`text-balance`, 알림 멈춤 줄과 같다). */}
          <span className="flex min-w-0 flex-1 flex-col break-keep text-balance">
            <span className="text-label font-medium" data-testid="connection-card-title">
              {formatMessage(shown.title)}
            </span>
            {shown.detail === null ? null : (
              <span className="text-meta text-ink-muted" data-testid="connection-card-detail">
                {formatMessage(shown.detail)}
              </span>
            )}
          </span>
          <ConnectionMark mark={shown.mark} />
        </div>
        {shown.canReconnect ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            data-testid="connection-card-action"
            onClick={() => {
              reconnectNow();
              cardRef.current?.focus({ preventScroll: true });
            }}
          >
            {formatMessage(K.reconnectNow)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
