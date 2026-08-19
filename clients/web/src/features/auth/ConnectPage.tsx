import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { FlaskConical } from "lucide-react";
import { joinWithInvite, login, type LoginResponse } from "@momo/core/lib/api";
import {
  API_BASE_DEFAULT,
  CONFIGURED_WORKSPACE,
  DEV_EMAIL,
  DEV_PASSWORD,
  TEST_PREFILL_ACTIVE,
} from "@/lib/env";
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
} from "@momo/core/features/auth/connectModel";

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

/**
 * The shape a workspace id has, shown as a placeholder rather than prefilled as
 * a value (goal B13 R2 High 1).
 *
 * The nil uuid on purpose: it reads as a *shape* and not as a workspace anyone
 * could be signed into, which is exactly what the demo id it replaced failed at.
 */
const WORKSPACE_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

/**
 * A field's label plus whether it is required — goal B13 R2 High 2.
 *
 * The form used to state this backwards: the two OPTIONAL fields (server
 * address, workspace) each carried a hint explaining themselves, and the two
 * REQUIRED ones stood bare. The only signal that email and password were
 * mandatory was the *absence* of a hint, and `required` alone does not speak
 * until after the person has already pressed 로그인.
 *
 * So every field now says which it is, in the same place, in one word. The
 * marker is `text-meta` against the label's `text-body` — both are `ink-muted`,
 * and the size step is what keeps a one-word annotation from reading as a second
 * label.
 */
function FieldLabel({
  children,
  optional = false,
}: {
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-ink-muted">{children}</span>
      <span className="text-meta text-ink-muted">
        {optional ? "선택" : "필수"}
      </span>
    </span>
  );
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
  const [workspace, setWorkspace] = useState(CONFIGURED_WORKSPACE);
  // Open only when this build named a workspace: a value that exists must not be
  // hidden behind a disclosure nobody knows to open.
  const [workspaceOpen, setWorkspaceOpen] = useState(CONFIGURED_WORKSPACE !== "");
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
        ? "참여 중…"
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

          {/* DESK-1: a build that pre-fills credentials says so, every time.
              The values come from build-time env and never from this repo, but
              the person in front of the screen cannot see a build flag — and a
              password they did not type, sitting filled in a field they are
              about to submit, is exactly the thing that stops being noticed
              right before it ships somewhere it should not. Naming the email
              (never the password) is what makes it checkable at a glance. */}
          {TEST_PREFILL_ACTIVE && (
            <InlineBanner
              tone="neutral"
              icon={<FlaskConical className="size-4" aria-hidden />}
              message={
                DEV_EMAIL !== ""
                  ? `테스트 프리필이 켜진 빌드입니다. ${DEV_EMAIL}로 미리 채웠습니다.`
                  : "테스트 프리필이 켜진 빌드입니다. 비밀번호를 미리 채웠습니다."
              }
              testId="connect-test-prefill"
            />
          )}

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
              <label htmlFor="connect-server" className="text-body">
                <FieldLabel optional>서버 주소</FieldLabel>
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
                  <FieldLabel>초대 코드</FieldLabel>
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

              {/* 성재가 이 화면에서 물은 것이 정확히 "이메일 비밀번호 같은건
                  뭘로 채워야해?"였다. 답은 한 줄이면 되고, 한 줄이어야 한다. */}
              <label className="flex flex-col gap-1 text-body">
                <FieldLabel>이메일</FieldLabel>
                <Input
                  ref={emailRef}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                  aria-describedby="connect-email-hint"
                  data-testid="login-email"
                />
                <span
                  id="connect-email-hint"
                  className="text-meta text-ink-muted"
                  data-testid="login-email-hint"
                >
                  워크스페이스에 초대받은 주소
                </span>
              </label>

              <label className="flex flex-col gap-1 text-body">
                <FieldLabel>비밀번호</FieldLabel>
                <Input
                  ref={passwordRef}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    mode === "join" ? "new-password" : "current-password"
                  }
                  required
                  aria-describedby="connect-password-hint"
                  data-testid="login-password"
                />
                {/* 참여는 비밀번호를 만드는 자리고 로그인은 이미 만든 것을 대는
                    자리다. 한 문장이 두 경우에 다 맞을 수는 없다. */}
                <span
                  id="connect-password-hint"
                  className="text-meta text-ink-muted"
                  data-testid="login-password-hint"
                >
                  {mode === "join"
                    ? "이 워크스페이스에서 쓸 비밀번호를 새로 정합니다"
                    : "가입할 때 정한 비밀번호"}
                </span>
              </label>

              {/* 접어 두는 이유 (goal B13 R2 High 1).
                  이 칸의 정답은 거의 모든 사람에게 "빈 칸"이다. 서버는 **UUID만**
                  받는데 워크스페이스 UUID는 제품 어디에도 표시되지 않고, 다른
                  화면은 전부 workspace를 slug와 이름으로 부른다. 그래서 첫 화면
                  최상위에 열린 채로 두면, 채울 수 없는 값을 요구하는 칸이 필수
                  칸들과 같은 무게로 서 있게 된다 — 정확히 "이메일 비밀번호 같은건
                  뭘로 채워야해?"가 나온 배치다.
                  대신 열었을 때는 형식을 보여준다: 라벨이 "워크스페이스 ID"이고
                  placeholder가 UUID 모양이다. 채우는 법을 지우지 않으면서
                  비우는 것이 기본임을 말하는 방법이다. */}
              {mode === "signIn" && (
                // gap-2: 토글과 펼쳐진 칸 사이 8px. gap-1(4px)이면 토글이
                // "워크스페이스 ID" 라벨에 붙어 라벨의 윗줄처럼 읽혔다.
                <div className="flex flex-col gap-2">
                  {/* Collapsible 프리미티브가 이 레포에 아직 없다(design/ui에
                      button·card·dialog·input·select뿐). 이 컨트롤이 필요로 하는
                      건 aria-expanded/aria-controls 두 개뿐이라, 그 둘을 위해
                      Radix 패키지를 들이는 편이 컨트롤보다 무겁다. */}
                  <button
                    type="button"
                    onClick={() => setWorkspaceOpen((open) => !open)}
                    aria-expanded={workspaceOpen}
                    aria-controls="connect-workspace-field"
                    className="self-start rounded-sm text-meta text-ink-muted underline underline-offset-4 focus-visible:focus-ring"
                    data-testid="login-workspace-toggle"
                  >
                    다른 워크스페이스로 로그인
                  </button>
                  {workspaceOpen && (
                    <div
                      id="connect-workspace-field"
                      className="flex flex-col gap-1"
                    >
                      <label htmlFor="connect-workspace" className="text-body">
                        <FieldLabel optional>워크스페이스 ID</FieldLabel>
                      </label>
                      <Input
                        id="connect-workspace"
                        value={workspace}
                        onChange={(e) => setWorkspace(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={WORKSPACE_ID_PLACEHOLDER}
                        aria-describedby="connect-workspace-hint"
                        data-testid="login-workspace"
                      />
                      <p
                        id="connect-workspace-hint"
                        className="text-meta text-ink-muted"
                        data-testid="login-workspace-hint"
                      >
                        비워 두면 기본 워크스페이스로 연결합니다.
                      </p>
                    </div>
                  )}
                </div>
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
