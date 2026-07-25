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
  CardTitle,
} from "@/design/ui/card";
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
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
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
      const failure =
        mode === "join" ? joinFailureCopy(err) : signInFailureCopy(err);
      setError(failure.message);
      if (failure.suggestSignIn) setMode("signIn");
    } finally {
      setBusy(false);
    }
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
          <div className="flex items-center justify-between">
            <CardTitle className="text-title">momo</CardTitle>
            <RuntimeBadge />
          </div>
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

          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="connect-server"
                className="text-body text-ink-muted"
              >
                서버 주소
              </label>
              {/* Deliberately NOT type="url": the browser's own url validity
                  check rejects a bare host outright, which would block the
                  "momo.example.com" path this field accepts and would report it
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

            {error && (
              <p
                role="alert"
                className="text-body text-danger"
                data-testid="login-error"
              >
                {error}
              </p>
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
                setError(null);
                focusLater(next === "join" ? "code" : "email");
              }}
              data-testid="connect-mode-toggle"
            >
              {mode === "join" ? "로그인으로 전환" : "초대 코드로 참여"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
