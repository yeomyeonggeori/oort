import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  cancelLogin,
  completeLogin,
  isLoginEnded,
  loginErrorMessage,
  MODEL_LOGIN_COPY as COPY,
  pasteLooksSendable,
  pollLogin,
  safeLoginUrl,
  secondsLeft,
  type LoginFlow,
  type LoginStart,
  type LoginStatus,
} from "@momo/core/features/settings/loginRelay";
import { ApiError } from "@momo/core/lib/api";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import { openExternalUrl } from "@/lib/tauri";

// Reading this as: settings › AI 연결 › 로그인 진행 (instance operator only) for internal team users on
// web+Tauri, density 6/10, motion 1/10.

/** 진행 중 로그인 하나의 화면 (#4080 모델 인증, #4074 앱 로그인이 함께 쓴다). */
export interface SessionCopy {
  readonly pasteSteps: string;
  readonly pasteLabel: string;
  readonly pasteHelp: string;
  readonly pasteSend: string;
}

const POLL_MS = 4000;

/**
 * 시작 응답(`start`)을 받아 그리는 부분. 이 컴포넌트가 지키는 것:
 *
 * - `start`(주소·기기 코드)와 붙여넣은 값은 **react 상태/쿼리 캐시/저장소에 두지 않는다**. 주소·코드는 부모의 상태에서
 *   props 로만 오고, 로그인이 끝나거나 화면을 닫거나 만료되면 부모가 비운다(`onEnded`/`onClose`).
 * - 붙여넣기 칸은 **제어하지 않는 입력**이다. 값은 DOM 에만 있고, 보내는 순간 읽어서 칸을 비운다(다음 줄에서 비운
 *   뒤에 요청한다). 상태에는 「칸에 글자가 있는가」 불리언만 있다.
 * - 보내기·폴링은 mutation/query 로 감싸지 않는다(변수·결과가 클라이언트 캐시에 남는다).
 * - 화면이 사라지면(언마운트) 끝나지 않은 로그인은 취소한다.
 */
export function LoginRelaySession({
  workspaceId,
  agentId,
  flow,
  start,
  copy,
  onEnded,
  onClose,
}: {
  workspaceId: string;
  agentId: string;
  flow: LoginFlow;
  start: LoginStart;
  copy: SessionCopy;
  /** 끝났다(done/failed/expired/cancelled). 부모는 `start`를 비운다. */
  onEnded: (status: LoginStatus) => void;
  /** 사용자가 닫았다. 부모는 `start`를 비운다. */
  onClose: () => void;
}) {
  const [status, setStatus] = useState<LoginStatus>({ status: "pending", reason: null });
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);
  const [hasText, setHasText] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | null>(null);
  const pasteRef = useRef<HTMLInputElement>(null);
  const endedRef = useRef(false);
  const mountedRef = useRef(false);
  const loginId = start.loginId;
  const safe = safeLoginUrl(start.url);

  const finish = (next: LoginStatus) => {
    if (endedRef.current) return;
    endedRef.current = true;
    if (pasteRef.current) pasteRef.current.value = "";
    onEnded(next);
  };

  // 화면이 사라지면 끝나지 않은 로그인은 취소한다. StrictMode 의 가짜 언마운트에서 취소하지 않게 한 틱 미룬다.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!mountedRef.current && !endedRef.current) {
          endedRef.current = true;
          void cancelLogin(workspaceId, agentId, flow, loginId).catch(() => undefined);
        }
      }, 0);
    };
  }, [workspaceId, agentId, flow, loginId]);

  // 폴링: 상태 낱말만 온다(주소·코드는 오지 않는다).
  useEffect(() => {
    const timer = setInterval(() => {
      void pollLogin(workspaceId, agentId, flow, loginId)
        .then((next) => {
          if (endedRef.current) return;
          setStatus(next);
          if (isLoginEnded(next.status)) finish(next);
        })
        .catch((error: unknown) => {
          // 서버가 지운 로그인(404)은 끝난 것이다. 그 밖의 일시 오류는 다음 틱에 다시 본다.
          if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
            finish({ status: "expired", reason: null });
          }
        });
    }, POLL_MS);
    return () => clearInterval(timer);
    // finish 는 렌더마다 새 함수지만 endedRef 로 한 번만 동작한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agentId, flow, loginId]);

  // 남은 시간: 만료되면 주소·코드를 즉시 폐기한다.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = secondsLeft(start.expiresAt, now);
  useEffect(() => {
    if (left === 0 && !endedRef.current) {
      void cancelLogin(workspaceId, agentId, flow, loginId).catch(() => undefined);
      finish({ status: "expired", reason: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const send = async () => {
    const input = pasteRef.current;
    if (!input || sending) return;
    const value = input.value;
    if (!pasteLooksSendable(value)) return;
    // 읽자마자 비운다. 요청이 오래 걸리거나 실패해도 값은 화면에 남지 않는다.
    input.value = "";
    setHasText(false);
    setSending(true);
    setSendError(null);
    try {
      const next = await completeLogin(workspaceId, agentId, flow, loginId, value);
      setStatus(next);
      if (isLoginEnded(next.status)) finish(next);
    } catch (error) {
      setSendError(loginErrorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const copyCode = () => {
    const code = start.userCode;
    if (code === null || typeof navigator.clipboard?.writeText !== "function") return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied("code");
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const openUrl = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Tauri 창에서 target=_blank 는 아무것도 열지 않는다(lib/tauri.ts).
    if (!IS_TAURI || !safe) return;
    event.preventDefault();
    void openExternalUrl(safe.href);
  };

  const submitted = status.status === "submitted";
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-3 border-t border-line px-2 py-4" data-testid="login-session">
      {safe === null ? (
        <InlineBanner message="서버가 준 주소를 열 수 없어요. 처음부터 다시 시작해 주세요." testId="login-url-refused" />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <a
            href={safe.href}
            target="_blank"
            rel="noopener noreferrer"
            className="press inline-flex h-control items-center rounded-full bg-primary px-4 text-label font-semibold text-on-primary focus-visible:focus-ring focus-visible:focus-ring-on-primary"
            onClick={openUrl}
            data-testid="login-open"
          >
            {COPY.openUrl}
          </a>
          <span className="text-meta text-ink-muted">
            {COPY.hostLead} <strong className="font-semibold text-ink" data-testid="login-host">{safe.host}</strong>
          </span>
        </div>
      )}

      {start.userCode !== null && (
        <div className="flex min-w-0 flex-wrap items-center gap-3" data-testid="login-device-code">
          <span className="text-meta text-ink-muted">{COPY.deviceCodeLabel}</span>
          <code
            className="rounded-md bg-muted-soft px-3 py-1 font-mono text-title font-semibold text-ink [overflow-wrap:anywhere]"
            data-numeric
          >
            {start.userCode}
          </code>
          <Button type="button" size="sm" variant="ghost" className="tap-target bg-surface shadow-sm" onClick={copyCode}>
            {copied === "code" ? COPY.copied : COPY.copyCode}
          </Button>
        </div>
      )}

      {start.mode === "device" ? (
        <p className="break-keep text-body text-ink-muted">{COPY.deviceSteps}</p>
      ) : (
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <p className="break-keep text-body text-ink-muted">{copy.pasteSteps}</p>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-meta text-ink-muted">{copy.pasteLabel}</span>
            <Input
              ref={pasteRef}
              type="password"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={sending || submitted}
              onChange={(event) => setHasText(event.currentTarget.value !== "")}
              data-1p-ignore
              data-testid="login-paste"
            />
          </label>
          <span className="text-meta text-ink-muted">{copy.pasteHelp}</span>
          <div>
            <Button
              type="submit"
              size="sm"
              className="tap-target"
              disabled={!hasText || sending || submitted}
              aria-disabled={!hasText || sending || submitted}
              data-testid="login-paste-send"
            >
              {sending && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {sending ? COPY.pasteSending : copy.pasteSend}
            </Button>
          </div>
        </form>
      )}

      {sendError !== null && <InlineBanner message={sendError} testId="login-send-error" />}

      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span role="status" aria-live="polite" className="text-meta text-ink-muted" data-testid="login-status">
          {submitted ? COPY.submitted : COPY.waiting}
          {" "}
          <span data-numeric className="font-mono">
            {minutes}:{seconds}
          </span>
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="tap-target"
          onClick={() => {
            if (!endedRef.current) {
              void cancelLogin(workspaceId, agentId, flow, loginId).catch(() => undefined);
              endedRef.current = true;
            }
            if (pasteRef.current) pasteRef.current.value = "";
            onClose();
          }}
          data-testid="login-cancel"
        >
          {COPY.cancel}
        </Button>
      </div>
    </div>
  );
}
