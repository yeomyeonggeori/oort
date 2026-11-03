import { useRef } from "react";
import { ConnectionMark } from "@/features/common/ConnectionMark";
import { useConnection } from "@/features/common/connectionContext";
import { InlineBanner } from "@/features/common/States";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { CONNECTION_KEYS as K } from "@momo/core/features/connection/copyKeys";
import { presentConnection } from "@momo/core/features/connection/presentation";

// =============================================================================
// 위쪽 연결 띠 — 연결 카드가 설 자리가 없을 때만 (#5220, #5201 S-B, owner 결정 ①).
//
// 연결을 말하는 자리는 **한 곳**이다(감사 문서 §4 원칙 3). 목록 열이 보이는 넓은 창에서는 사이드바 아래
// 연결 카드(`sidebar/ConnectionCard.tsx`)가 말하고, 이 띠는 서지 않는다. 폰 폭의 서랍이거나 목록 열이
// 접혀 카드가 보이지 않을 때만 이 띠가 **같은 문장·같은 단추**로 말한다(어느 쪽인지는 코어의
// `showsConnectionBanner`가 가르고 셸이 한 번 읽는다). 라우트 위, 셸 안에 한 벌만 있다(goal B8 B2): 실시간이
// 죽었다는 사실은 채널만의 사실이 아니라서, 인박스도 활동도 갱신이 멈추고 조용한 하루와 구별되지 않는다.
//
// 기다림은 이제 이 파일의 몫이 아니다. 옛 띠는 내용을 밀어서 소켓 틈을 15초 기다렸지만(그동안 잠금은 이미
// 걸려 있었다), 같은 사실에 시계가 둘이던 것을 모델 하나(1초 침묵, 10초까지 「연결 중」, 그 뒤 「끊김」,
// 기기 오프라인은 즉시)로 모았다. 띠가 내용을 미는 비용은 띠가 서는 자리(카드가 못 서는 폭)에서만 치른다.
//
// 모습(로더가 도는가, 멈추는가, 확인 표시인가)과 단추(`지금 다시 연결`)는 카드와 같은 판정이다
// (`presentConnection`): 한쪽만 고쳐지는 순간이 없다.
// =============================================================================

export function ConnectionBanner() {
  const { view, recovered, reconnectNow } = useConnection();
  const formatMessage = useFormatMessage();
  const regionRef = useRef<HTMLDivElement>(null);
  const shown = presentConnection(view, recovered);
  if (shown === null) return null;

  return (
    <div
      ref={regionRef}
      // 누른 단추는 「연결 중」으로 바뀌며 사라진다. 초점이 <body>로 떨어지지 않도록 띠가 받는다(키보드로 눌렀을
      // 때만 링이 선다: focus-visible).
      tabIndex={-1}
      data-tone={shown.tone}
      data-phase={view.phase}
      data-cause={view.cause ?? undefined}
      className="focus-visible:focus-ring"
    >
      <InlineBanner
        tone="neutral"
        // 중립색은 띠가 경보처럼 읽히지 않게 하고, 곁의 표시(도는 로더)는 크롬처럼 읽히지 않게 한다: 내용을
        // 보던 눈이 소켓이 죽은 순간을 놓치지 않게 하는 한 가지 신호다(#3961).
        icon={<ConnectionMark mark={shown.mark} inline />}
        message={
          <>
            <span className="font-medium">{formatMessage(shown.title)}</span>
            {shown.detail === null ? null : (
              <span className="text-ink-muted"> {formatMessage(shown.detail)}</span>
            )}
          </>
        }
        testId="connection-banner"
        {...(shown.canReconnect
          ? {
              actionLabel: formatMessage(K.reconnectNow),
              onAction: () => {
                reconnectNow();
                regionRef.current?.focus({ preventScroll: true });
              },
            }
          : {})}
      />
    </div>
  );
}
