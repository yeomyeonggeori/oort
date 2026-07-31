import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { joinWithInvite, login, type LoginResponse } from "@/lib/api";
import { API_BASE_DEFAULT, DEFAULT_WORKSPACE, DEV_EMAIL, DEV_PASSWORD } from "@/lib/env";
import {
  SERVER_URL_PLACEHOLDER,
  getServerBase,
  normalizeServerUrl,
  requiresServerUrl,
  setServerBase,
} from "@/lib/serverBase";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/design/ui/card";
import { OortMark } from "@/design/brand/OortMark";
import { InlineBanner } from "@/features/common/States";
import { RuntimeBadge } from "@/app/RuntimeBadge";
import { UpdateNotice } from "@/features/updates/UpdateNotice";
import { DiscoveredServerList } from "./DiscoveredServerList";
import { useDiscoveredServers, type DiscoveredServer } from "./discovery";
import { useJoinPrefill } from "./useJoinPrefill";
import {
  joinFailureCopy,
  prefillFocus,
  signInFailureCopy,
  type ConnectFailure,
  type ConnectField,
  type ConnectMode,
} from "./connectModel";

// =============================================================================
// The connect surface (MOMO-604 / ADR-0133 P2), successor to the same-origin
// login form. Three things the old form could not do:
//
//   1. point this client at a server. Same-origin is still the default and the
//      field may be left blank for it, but the Tauri shell has no same-origin
//      API to fall back to and a remote browser session may not want one.
//   2. take a `momo://join` invite. The link fills server and code, so the
//      person types an email and a password and nothing else.
//   3. offer a server found on the LAN, quietly, when one advertises itself.
//      Browsers have no mDNS, so the card simply never appears there.
//
// Inherited from the mac chooser (MomoServerSession.swift) rather than
// reinvented: the URL validation rule, the deep-link prefill focus order, and
// the silence-when-nothing-found discovery contract.
// =============================================================================

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function readOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function ConnectPage({
  onLoggedIn,
}: {
  onLoggedIn: (session: LoginResponse) => void;
}) {
  const requiresServer = requiresServerUrl();
  const [serverUrl, setServerUrl] = useState(
    () => getServerBase() ?? API_BASE_DEFAULT
  );
  const [email, setEmail] = useState(DEV_EMAIL);
  const [password, setPassword] = useState(DEV_PASSWORD);
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);
  const [inviteCode, setInviteCode] = useState("");
  const [mode, setMode] = useState<ConnectMode>("signIn");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<ConnectField | null>(null);

  const online = useSyncExternalStore(subscribeOnline, readOnline, () => true);
  const discovered = useDiscoveredServers();
  const prefill = useJoinPrefill();

  const serverRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Read by the deep-link effect without listing every field as a dependency:
  // a link that arrives mid-typing must see what is on screen now, and must not
  // re-run because a keystroke changed it.
  const typed = useRef({ serverUrl, email, password });
  typed.current = { serverUrl, email, password };

  const focusLater = useCallback((field: ConnectField) => {
    setPendingFocus(field);
  }, []);

  useEffect(() => {
    if (!pendingFocus) return;
    const target = {
      server: serverRef,
      email: emailRef,
      password: passwordRef,
      code: codeRef,
    }[pendingFocus];
    target.current?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  // A deep link fills what it carries and lands the cursor on the first thing
  // it could not: server and code came with the link, so that is usually the
  // email field.
  useEffect(() => {
    if (!prefill) return;
    if (prefill.serverUrl !== "") {
      setServerUrl(prefill.serverUrl);
      setServerError(null);
    }
    if (prefill.inviteCode !== "") {
      setInviteCode(prefill.inviteCode);
      setMode("join");
    }
    setFailure(null);
    focusLater(
      prefillFocus({
        serverUrl: prefill.serverUrl || typed.current.serverUrl,
        email: typed.current.email,
        password: typed.current.password,
        requiresServer,
      })
    );
  }, [prefill, requiresServer, focusLater]);

  function selectDiscovered(server: DiscoveredServer) {
    setServerUrl(server.base);
    setServerError(null);
    setFailure(null); // a new address invalidates what the last one answered
    focusLater(email.trim() === "" ? "email" : "password");
  }

  /** Store the server this submit is aimed at, or report why it cannot be. */
  function commitServer(): boolean {
    const raw = serverUrl.trim();
    if (raw === "") {
      if (requiresServer) {
        setServerError("서버 주소를 입력하세요.");
        focusLater("server");
        return false;
      }
      setServerBase(null); // same-origin: the deployment's normal mode
      return true;
    }
    const checked = normalizeServerUrl(raw);
    if (!checked.ok) {
      setServerError(checked.message);
      focusLater("server");
      return false;
    }
    setServerBase(checked.base);
    setServerUrl(checked.base);
    return true;
  }

  /**
   * One attempt with what is on screen. Reachable from the form and from the
   * error banner's retry, which is the same action: a failure that could not
   * reach the server leaves the input untouched and worth sending again.
   *
   * Every request underneath carries a deadline (lib/http.ts), so this always
   * ends — in the shell, in a session or in a stated failure. It cannot sit on
   * "로그인 중…" the way it did against a `.local` address (MOMO-609 / G-1).
   */
  async function attempt() {
    setFailure(null);
    setServerError(null);
    if (!commitServer()) return;
    setBusy(true);
    try {
      const session =
        mode === "join"
          ? await joinWithInvite(inviteCode, email, password)
          : await login(email, password, workspace);
      onLoggedIn(session);
    } catch (err) {
      const next = mode === "join" ? joinFailureCopy(err) : signInFailureCopy(err);
      setFailure(next);
      if (next.suggestSignIn) setMode("signIn");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void attempt();
  }

  const serverHint = requiresServer
    ? "데스크톱 앱은 접속할 서버 주소가 필요합니다."
    : "비워 두면 이 페이지를 제공한 주소로 연결합니다.";
  const submitLabel =
    mode === "join"
      ? busy
        ? "참여하는 중…"
        : "초대 코드로 참여"
      : busy
        ? "로그인 중…"
        : "로그인";

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          {/* 이 화면의 제목은 제품 이름이고, 그래서 h1이다. 전에는 제목 칸을
              런타임 뱃지와 한 줄에서 나눠 썼는데, 그러면 처음 보는 사람의 눈에
              제품 표식과 진단용 칩이 같은 굵기로 나란히 선다. 뱃지는 카드 아래로
              내려가되 화면에는 남는다: 연결이 실패했을 때 "어느 빌드냐"를 묻는
              화면이 바로 여기고, 그 답이 설정 뒤에 숨으면 로그인하지 못한 사람은
              닿을 수 없다(MOMO-606). */}
          <h1 className="flex items-center gap-2 font-semibold leading-none tracking-tight">
            <OortMark className="size-6 shrink-0 text-accent" />
            <span className="text-title">oort</span>
          </h1>
          <CardDescription>
            {mode === "join"
              ? "초대 코드로 워크스페이스에 참여합니다."
              : "서버를 고른 뒤 로그인합니다."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <UpdateNotice />

          {!online && (
            <InlineBanner
              tone="neutral"
              message="오프라인입니다. 네트워크가 연결되면 다시 시도하세요."
              testId="connect-offline"
            />
          )}

          {discovered.length > 0 && (
            <DiscoveredServerList
              servers={discovered}
              onSelect={selectDiscovered}
            />
          )}

          {/* 폼은 세 구역이다: 어디에 붙을지(서버), 누구로 들어갈지(자격),
              그 둘로 무엇을 할지(실패와 버튼). 구역 사이 24px, 구역 안 12px로
              벌려 선 하나 긋지 않고 위계를 만든다. 전에는 여섯 칸이 모두 같은
              12px라 어디까지가 한 덩어리인지 눈으로 끊기지 않았다. */}
          <form onSubmit={onSubmit} className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="connect-server"
                className="text-body text-ink-muted"
              >
                서버 주소
              </label>
              {/* Deliberately NOT type="url": the browser's own url validity
                  check rejects a bare host outright, which would block the
                  "oort.example.com" path this field accepts and would report it
                  in an OS-language tooltip instead of the copy below. */}
              <Input
                id="connect-server"
                ref={serverRef}
                type="text"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                placeholder={SERVER_URL_PLACEHOLDER}
                value={serverUrl}
                onChange={(e) => {
                  setServerUrl(e.target.value);
                  setServerError(null);
                }}
                aria-invalid={serverError !== null || undefined}
                aria-describedby={
                  serverError ? "connect-server-error" : "connect-server-hint"
                }
                data-testid="login-server"
              />
              {serverError ? (
                <p
                  id="connect-server-error"
                  role="alert"
                  className="text-meta text-danger"
                  data-testid="login-server-error"
                >
                  {serverError}
                </p>
              ) : (
                <p
                  id="connect-server-hint"
                  className="text-meta text-ink-muted"
                  data-testid="connect-server-hint"
                >
                  {serverHint}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-3">
              {mode === "join" && (
                <label className="flex flex-col gap-1 text-body">
                  <span className="text-ink-muted">초대 코드</span>
                  <Input
                    ref={codeRef}
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                    data-testid="login-invite-code"
                  />
                </label>
              )}

              <label className="flex flex-col gap-1 text-body">
                <span className="text-ink-muted">이메일</span>
                <Input
                  ref={emailRef}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                  data-testid="login-email"
                />
              </label>

              <label className="flex flex-col gap-1 text-body">
                <span className="text-ink-muted">비밀번호</span>
                <Input
                  ref={passwordRef}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    mode === "join" ? "new-password" : "current-password"
                  }
                  required
                  data-testid="login-password"
                />
              </label>

              {mode === "signIn" && (
                <label className="flex flex-col gap-1 text-body">
                  <span className="text-ink-muted">워크스페이스</span>
                  <Input
                    value={workspace}
                    onChange={(e) => setWorkspace(e.target.value)}
                    data-testid="login-workspace"
                  />
                </label>
              )}
            </div>

            <div className="flex flex-col gap-3">
              {/* Inline, in the form it belongs to, with the retry attached to
                  the failure itself. A retry only appears when sending the SAME
                  input again could work: a wrong password is corrected in the
                  field above, not by pressing again. */}
              {failure && (
                <InlineBanner
                  tone="error"
                  message={failure.message}
                  actionLabel={failure.retryable && !busy ? "다시 시도" : undefined}
                  onAction={failure.retryable && !busy ? () => void attempt() : undefined}
                  testId="login-error"
                />
              )}

              <Button
                type="submit"
                disabled={busy || !online}
                title={online ? undefined : "오프라인 상태에서는 연결할 수 없습니다."}
                data-testid="login-submit"
              >
                {submitLabel}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => {
                  const next = mode === "join" ? "signIn" : "join";
                  setMode(next);
                  setFailure(null);
                  focusLater(next === "join" ? "code" : "email");
                }}
                data-testid="connect-mode-toggle"
              >
                {mode === "join" ? "로그인으로 전환" : "초대 코드로 참여"}
              </Button>
            </div>
          </form>

          {/* 진단은 카드의 마지막 줄이다. 위 폼과 같은 무게로 다투지 않도록
              구분선 아래 오른쪽 끝에 앉고, 그래도 로그인하지 못한 사람의
              화면에 그대로 남아 있다. */}
          <div className="flex justify-end border-t border-line pt-4">
            <RuntimeBadge />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
