import { useRef, useState, useSyncExternalStore } from "react";
import { InlineBanner } from "@/features/common/States";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import {
  getBootUnreachableNotice,
  getSessionExpiredNotice,
  subscribeSessionNotice,
} from "@/lib/sessionNotice";

// =============================================================================
// 로그인 화면 위의 한 줄 (#5221, #5201 S-C).
//   - 로그인이 만료됐다: 「로그인이 만료됐어요. 다시 로그인해 주세요.」 단추 없음(로그인 폼이 바로 아래에 있다).
//   - 콜드 스타트에 서버가 안 닿는다: 「서버에 닿지 못했어요. 저장된 로그인은 그대로 있고, 연결되면 이어서 시도해요.」 + 「다시 시도」.
// 둘이 겹치면 만료가 이긴다(세션이 이미 끝났다: 저장된 로그인이 없다). 로그인 폼 자체는 그대로 쓸 수 있다.
// 문장은 사전에서 오고 상태 코드·서버 원문은 없다.
// =============================================================================

export function SessionNotice({ onRetryRestore }: { onRetryRestore: () => Promise<void> | void }) {
  const formatMessage = useFormatMessage();
  const expiredNotice = useSyncExternalStore(subscribeSessionNotice, getSessionExpiredNotice, () => false);
  const unreachableNotice = useSyncExternalStore(subscribeSessionNotice, getBootUnreachableNotice, () => false);
  const [retrying, setRetrying] = useState(false);
  // 한 번 누른 뒤 다시 그리기 전에 또 눌러도 한 번만 부른다(상태는 다음 그리기에야 바뀐다).
  const busy = useRef(false);

  if (expiredNotice) {
    return (
      <InlineBanner
        tone="neutral"
        message={formatMessage(CONNECTION_KEYS.sessionExpired)}
        testId="session-expired-notice"
        className="layer-content-float fixed inset-x-0 top-0 bg-surface"
      />
    );
  }
  if (unreachableNotice) {
    return (
      <InlineBanner
        tone="neutral"
        message={formatMessage(CONNECTION_KEYS.bootUnreachable)}
        actionLabel={formatMessage(CONNECTION_KEYS.retry)}
        actionBusy={retrying}
        onAction={() => {
          if (busy.current) return;
          busy.current = true;
          setRetrying(true);
          void Promise.resolve(onRetryRestore()).finally(() => {
            busy.current = false;
            setRetrying(false);
          });
        }}
        testId="boot-unreachable-notice"
        className="layer-content-float fixed inset-x-0 top-0 bg-surface"
      />
    );
  }
  return null;
}
