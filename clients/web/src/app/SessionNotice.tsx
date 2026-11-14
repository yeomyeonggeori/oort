import { useRef, useState, useSyncExternalStore } from "react";
import { InlineBanner } from "@/features/common/States";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import { serverHost } from "@momo/core/features/auth/passwordHelp";
import {
  getBootUnreachableNotice,
  getServerSwitchSignedOutNotice,
  getSessionExpiredNotice,
  subscribeSessionNotice,
} from "@/lib/sessionNotice";

// =============================================================================
// 로그인 화면 위의 한 줄 (#5221, #5201 S-C).
//   - 로그인이 만료됐다: 「로그인이 만료됐어요. 다시 로그인해 주세요.」 단추 없음(로그인 폼이 바로 아래에 있다).
//   - 콜드 스타트에 서버가 안 닿는다: 「서버에 닿지 못했어요. 저장된 로그인은 그대로 있고, 연결되면 이어서 시도해요.」 + 「다시 시도」.
//   - 저장된 로그인이 있는 채 서버를 바꿔 앞 서버의 로그인을 끝냈다(#5816): 「다른 서버로 바꿔서 앞 서버({host})의 로그인은 끝났어요. …」 단추 없음.
// 겹치면 서버를 바꿔 끝낸 사실 > 만료 > 서버 안 닿음(앞의 둘은 저장된 로그인이 이미 없다). 로그인 폼 자체는 그대로 쓸 수 있다.
// 문장은 사전에서 오고 상태 코드·서버 원문은 없다.
// =============================================================================

export function SessionNotice({ onRetryRestore }: { onRetryRestore: () => Promise<void> | void }) {
  const formatMessage = useFormatMessage();
  const expiredNotice = useSyncExternalStore(subscribeSessionNotice, getSessionExpiredNotice, () => false);
  const unreachableNotice = useSyncExternalStore(subscribeSessionNotice, getBootUnreachableNotice, () => false);
  const switchedFrom = useSyncExternalStore(subscribeSessionNotice, getServerSwitchSignedOutNotice, () => null);
  const [retrying, setRetrying] = useState(false);
  // 한 번 누른 뒤 다시 그리기 전에 또 눌러도 한 번만 부른다(상태는 다음 그리기에야 바뀐다).
  const busy = useRef(false);

  if (switchedFrom !== null) {
    return (
      <InlineBanner
        tone="neutral"
        message={formatMessage(CONNECTION_KEYS.bootServerSwitchedSignedOut, { host: serverHost(switchedFrom) })}
        testId="server-switch-signed-out-notice"
        className="layer-content-float fixed inset-x-0 top-0 bg-surface"
      />
    );
  }
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
